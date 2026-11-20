import os
import re
import sys
import json
import time
import shutil
import signal
import asyncio
import py_compile
import subprocess
from pathlib import Path
from typing import Dict, Optional

import httpx
import psutil
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="PyBot Cloud Deployer")

BASE_DIR = Path(__file__).resolve().parent
BOTS_DIR = BASE_DIR / "deployed_bots"
STATIC_DIR = BASE_DIR / "static"
BOTS_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

MAX_BOTS = int(os.getenv("MAX_BOTS", "5"))
BLOCKED_PACKAGES = {"torch", "tensorflow", "scipy", "pandas", "opencv-python", "playwright", "selenium"}

# In-memory registry of running bot processes
RUNNING_BOTS: Dict[str, dict] = {}


class DeployPayload(BaseModel):
    bot_token: str
    code: str
    requirements: str = ""
    mode: str = "polling"  # "polling" or "webhook"


def sanitize_bot_id(token: str) -> str:
    return token.split(":")[0].strip()


async def verify_telegram_token(token: str) -> dict:
    url = f"https://api.telegram.org/bot{token}/getMe"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        data = resp.json()
        if not data.get("ok"):
            raise HTTPException(status_code=400, detail="Invalid Telegram Bot Token.")
        return data["result"]


async def configure_telegram_mode(token: str, mode: str, public_url: str, bot_id: str):
    async with httpx.AsyncClient(timeout=10.0) as client:
        if mode == "webhook":
            webhook_url = f"{public_url.rstrip('/')}/webhook/{bot_id}"
            resp = await client.post(
                f"https://api.telegram.org/bot{token}/setWebhook",
                json={"url": webhook_url, "drop_pending_updates": True}
            )
            res = resp.json()
            if not res.get("ok"):
                raise HTTPException(status_code=400, detail=f"Webhook failed: {res.get('description')}")
            return webhook_url
        else:
            # Clear webhook so polling works without 409 Conflict
            await client.post(
                f"https://api.telegram.org/bot{token}/deleteWebhook",
                json={"drop_pending_updates": True}
            )
            return "Long Polling Active"


def validate_python_syntax(code: str, temp_path: Path):
    temp_path.write_text(code, encoding="utf-8")
    try:
        py_compile.compile(str(temp_path), doraise=True)
    except py_compile.PyCompileError as e:
        raise HTTPException(status_code=400, detail=f"Syntax Error in bot.py:\n{e.msg}")


def install_requirements(req_text: str, target_dir: Path) -> str:
    lines = [line.strip() for line in req_text.splitlines() if line.strip() and not line.strip().startswith("#")]
    if not lines:
        return "No extra requirements specified."

    for line in lines:
        pkg_name = re.split(r"[=<>!~\[]", line)[0].strip().lower()
        if pkg_name in BLOCKED_PACKAGES:
            raise HTTPException(
                status_code=400,
                detail=f"Package '{pkg_name}' exceeds Render Free Tier (512MB RAM) limits."
            )

    req_file = target_dir / "requirements.txt"
    req_file.write_text("\n".join(lines), encoding="utf-8")

    # Install into isolated folder to avoid polluting host environment
    libs_dir = target_dir / "libs"
    libs_dir.mkdir(exist_ok=True)

    cmd = [
        sys.executable, "-m", "pip", "install",
        "--no-cache-dir", "--upgrade",
        "--target", str(libs_dir),
        "-r", str(req_file)
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=f"Pip Install Failed:\n{proc.stderr[-800:]}")
    return proc.stdout[-500:] or "Dependencies installed successfully."


def stop_bot_process(bot_id: str):
    info = RUNNING_BOTS.get(bot_id)
    if info and info.get("process"):
        proc: subprocess.Popen = info["process"]
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    RUNNING_BOTS.pop(bot_id, None)


@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    index_file = STATIC_DIR / "Index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>Place Index.html inside /static folder</h1>", status_code=404)
    return FileResponse(index_file)


@app.get("/api/system")
async def system_stats():
    mem = psutil.virtual_memory()
    return {
        "ram_used_mb": round(mem.used / (1024 * 1024), 1),
        "ram_total_mb": round(mem.total / (1024 * 1024), 1),
        "ram_percent": mem.percent,
        "active_bots": len(RUNNING_BOTS),
        "max_bots": MAX_BOTS,
        "bots": [
            {
                "bot_id": bid,
                "username": data["username"],
                "name": data["name"],
                "mode": data["mode"],
                "status": "Running" if data["process"].poll() is None else "Crashed",
                "uptime_sec": int(time.time() - data["started_at"])
            }
            for bid, data in RUNNING_BOTS.items()
        ]
    }


@app.post("/api/deploy")
async def deploy_bot(payload: DeployPayload, request: Request):
    token = payload.bot_token.strip()
    if ":" not in token:
        raise HTTPException(status_code=400, detail="Invalid Bot Token format.")

    bot_id = sanitize_bot_id(token)

    if bot_id not in RUNNING_BOTS and len(RUNNING_BOTS) >= MAX_BOTS:
        raise HTTPException(status_code=429, detail=f"Free tier limit reached ({MAX_BOTS} concurrent bots max).")

    if not payload.code.strip():
        raise HTTPException(status_code=400, detail="Python script cannot be empty.")

    # 1. Verify Telegram Token
    bot_user = await verify_telegram_token(token)

    # 2. Prepare Workspace
    bot_dir = BOTS_DIR / bot_id
    bot_dir.mkdir(parents=True, exist_ok=True)
    script_path = bot_dir / "bot.py"
    log_path = bot_dir / "bot.log"

    # 3. Validate Python Syntax before killing old process
    validate_python_syntax(payload.code, script_path)

    # 4. Install Requirements
    pip_log = await asyncio.to_thread(install_requirements, payload.requirements, bot_dir)

    # 5. Stop existing instance if redeploying
    stop_bot_process(bot_id)

    # 6. Configure Webhook or Polling on Telegram
    public_url = os.getenv("RENDER_EXTERNAL_URL") or str(request.base_url).rstrip("/")
    mode_status = await configure_telegram_mode(token, payload.mode, public_url, bot_id)

    # 7. Launch Bot Process with isolated PYTHONPATH & injected ENV
    log_file = open(log_path, "w", encoding="utf-8")
    env = os.environ.copy()
    env["BOT_TOKEN"] = token
    env["WEBHOOK_URL"] = f"{public_url}/webhook/{bot_id}"
    env["PORT"] = str(9000 + (int(bot_id) % 900))  # Internal port if user runs Flask/FastAPI webhook
    env["PYTHONPATH"] = f"{bot_dir / 'libs'}{os.pathsep}{env.get('PYTHONPATH', '')}"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        cwd=str(bot_dir),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT
    )

    # Brief wait to catch immediate startup crashes
    await asyncio.sleep(1.5)
    if proc.poll() is not None:
        log_file.close()
        err_output = log_path.read_text(encoding="utf-8")[-1200:]
        raise HTTPException(status_code=400, detail=f"Bot crashed on startup:\n{err_output}")

    RUNNING_BOTS[bot_id] = {
        "process": proc,
        "log_file": log_file,
        "log_path": log_path,
        "username": bot_user.get("username"),
        "name": bot_user.get("first_name"),
        "mode": payload.mode,
        "internal_port": env["PORT"],
        "started_at": time.time()
    }

    return {
        "ok": True,
        "bot_id": bot_id,
        "bot_username": f"@{bot_user.get('username')}",
        "mode_status": mode_status,
        "pip_log": pip_log
    }


@app.post("/webhook/{bot_id}")
async def proxy_webhook(bot_id: str, request: Request):
    """Forwards incoming Telegram Webhook updates to the user's local bot server."""
    bot = RUNNING_BOTS.get(bot_id)
    if not bot:
        return JSONResponse({"ok": False, "error": "Bot not running"}, status_code=404)

    body = await request.body()
    target = f"http://127.0.0.1:{bot['internal_port']}/webhook/{bot_id}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(target, content=body, headers={"Content-Type": "application/json"})
            return JSONResponse(content=resp.json() if resp.content else {"ok": True}, status_code=resp.status_code)
    except Exception:
        # Fallback: also try root '/' in case user's webhook script listens on '/'
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(f"http://127.0.0.1:{bot['internal_port']}/", content=body)
                return JSONResponse(content={"ok": True}, status_code=resp.status_code)
        except Exception as e:
            return JSONResponse({"ok": False, "detail": str(e)}, status_code=502)


@app.get("/api/logs/{bot_id}")
async def get_logs(bot_id: str):
    log_path = BOTS_DIR / bot_id / "bot.log"
    if not log_path.exists():
        return {"logs": "No logs available yet."}
    content = log_path.read_text(encoding="utf-8", errors="replace")
    return {"logs": content[-6000:] or "Process running (no console output yet)..."}


@app.post("/api/stop/{bot_id}")
async def stop_bot(bot_id: str):
    stop_bot_process(bot_id)
    return {"ok": True, "message": f"Bot {bot_id} stopped."}


@app.get("/health")
async def health_check():
    return {"status": "alive", "running_bots": len(RUNNING_BOTS)}

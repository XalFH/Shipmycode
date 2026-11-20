import os
import re
import sys
import time
import shutil
import asyncio
import traceback
import py_compile
import subprocess
from pathlib import Path
from typing import Dict

import httpx
import psutil
from fastapi import FastAPI, HTTPException, Request
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
BLOCKED_PACKAGES = {
    "torch", "tensorflow", "scipy", "pandas",
    "opencv-python", "playwright", "selenium", "transformers"
}
RUNNING_BOTS: Dict[str, dict] = {}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    err_trace = traceback.format_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": f"Server Error: {str(exc)}\n{err_trace[-600:]}"}
    )


class DeployPayload(BaseModel):
    bot_token: str
    code: str
    requirements: str = ""
    mode: str = "polling"


class TokenVerifyPayload(BaseModel):
    bot_token: str


def get_container_memory():
    used_mb = round(psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024), 1)
    for bdata in RUNNING_BOTS.values():
        proc = bdata.get("process")
        if proc and proc.poll() is None:
            try:
                used_mb += round(psutil.Process(proc.pid).memory_info().rss / (1024 * 1024), 1)
            except Exception:
                pass

    limit_mb = 512.0
    for cgroup_path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        p = Path(cgroup_path)
        if p.exists():
            val = p.read_text().strip()
            if val.isdigit() and int(val) < 10**12:
                limit_mb = round(int(val) / (1024 * 1024), 1)
                break
    return round(used_mb, 1), limit_mb


def sanitize_bot_id(token: str) -> str:
    return token.split(":")[0].strip()


async def verify_telegram_token(token: str) -> dict:
    url = f"https://api.telegram.org/bot{token}/getMe"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
            data = resp.json()
            if not data.get("ok"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Telegram Rejected Token: {data.get('description', 'Invalid Token')}"
                )
            return data["result"]
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach Telegram API: {str(e)}")


async def configure_telegram_mode(token: str, mode: str, public_url: str, bot_id: str) -> str:
    async with httpx.AsyncClient(timeout=10.0) as client:
        if mode == "webhook":
            webhook_url = f"{public_url.rstrip('/')}/webhook/{bot_id}"
            resp = await client.post(
                f"https://api.telegram.org/bot{token}/setWebhook",
                json={"url": webhook_url, "drop_pending_updates": True}
            )
            res = resp.json()
            if not res.get("ok"):
                raise HTTPException(status_code=400, detail=f"Webhook Setup Failed: {res.get('description')}")
            return f"Webhook Active -> {webhook_url}"
        else:
            await client.post(
                f"https://api.telegram.org/bot{token}/deleteWebhook",
                json={"drop_pending_updates": True}
            )
            return "Long Polling Active (Webhook Cleared)"


def validate_python_syntax(code: str, script_path: Path):
    script_path.write_text(code, encoding="utf-8")
    try:
        py_compile.compile(str(script_path), doraise=True)
    except py_compile.PyCompileError as e:
        raise HTTPException(status_code=400, detail=f"Syntax Error in bot.py:\n{e.msg}")


def install_requirements(req_text: str, target_dir: Path) -> str:
    lines = [
        line.strip() for line in req_text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not lines:
        return "No extra packages requested."

    for line in lines:
        pkg_name = re.split(r"[=<>!~\[]", line)[0].strip().lower()
        if pkg_name in BLOCKED_PACKAGES:
            raise HTTPException(
                status_code=400,
                detail=f"Package '{pkg_name}' exceeds Render Free Tier (512 MB RAM) limits."
            )

    req_file = target_dir / "requirements.txt"
    req_file.write_text("\n".join(lines), encoding="utf-8")

    libs_dir = target_dir / "libs"
    libs_dir.mkdir(exist_ok=True)

    cmd = [
        sys.executable, "-m", "pip", "install",
        "--no-cache-dir", "--prefer-binary",
        "--target", str(libs_dir),
        "-r", str(req_file)
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Pip install timed out (90s limit on Render Free Tier).")

    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=f"Pip Install Error:\n{proc.stderr[-800:]}")
    return f"Installed: {', '.join(lines)}"


def stop_and_purge_bot(bot_id: str) -> bool:
    """Stops running bot process, closes log file handle, and deletes its entire storage folder."""
    info = RUNNING_BOTS.pop(bot_id, None)
    if info:
        proc: subprocess.Popen = info.get("process")
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                proc.kill()
        log_file = info.get("log_file")
        if log_file and not log_file.closed:
            try:
                log_file.close()
            except Exception:
                pass

    bot_dir = BOTS_DIR / bot_id
    existed = bot_dir.exists()
    if existed:
        shutil.rmtree(bot_dir, ignore_errors=True)
    return existed


def spawn_bot_process(token: str, bot_id: str, mode: str, public_url: str, bot_user: dict) -> dict:
    bot_dir = BOTS_DIR / bot_id
    script_path = bot_dir / "bot.py"
    log_path = bot_dir / "bot.log"

    internal_port = str(9000 + (int(bot_id) % 900))
    log_file = open(log_path, "w", encoding="utf-8")
    env = os.environ.copy()
    env["BOT_TOKEN"] = token
    env["WEBHOOK_URL"] = f"{public_url}/webhook/{bot_id}"
    env["WEBHOOK_PATH"] = f"/webhook/{bot_id}"
    env["PORT"] = internal_port
    env["PYTHONPATH"] = f"{bot_dir / 'libs'}{os.pathsep}{env.get('PYTHONPATH', '')}"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        cwd=str(bot_dir),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT
    )

    time.sleep(1.5)
    if proc.poll() is not None:
        log_file.close()
        err_output = log_path.read_text(encoding="utf-8", errors="replace")[-1200:]
        raise HTTPException(status_code=400, detail=f"Bot exited on startup:\n{err_output}")

    record = {
        "token": token,
        "process": proc,
        "log_file": log_file,
        "log_path": log_path,
        "username": bot_user.get("username"),
        "name": bot_user.get("first_name"),
        "mode": mode,
        "internal_port": internal_port,
        "started_at": time.time()
    }
    RUNNING_BOTS[bot_id] = record
    return record


@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    index_file = STATIC_DIR / "Index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>Index.html not found in /static</h1>", status_code=404)
    return FileResponse(index_file)


@app.post("/api/verify-token")
async def verify_token_endpoint(payload: TokenVerifyPayload):
    token = payload.bot_token.strip()
    if ":" not in token:
        raise HTTPException(status_code=400, detail="Token must contain ':' (e.g. 123456:ABC...)")
    user = await verify_telegram_token(token)
    return {
        "ok": True,
        "id": user.get("id"),
        "name": user.get("first_name"),
        "username": f"@{user.get('username')}"
    }


@app.get("/api/system")
async def system_stats():
    used_mb, limit_mb = get_container_memory()
    disk_used_mb = round(
        sum(f.stat().st_size for p in BOTS_DIR.iterdir() if p.is_dir() for f in p.rglob("*") if f.is_file())
        / (1024 * 1024),
        2
    ) if BOTS_DIR.exists() else 0.0

    return {
        "ram_used_mb": used_mb,
        "ram_total_mb": limit_mb,
        "disk_used_mb": disk_used_mb,
        "active_bots": len(RUNNING_BOTS),
        "max_bots": MAX_BOTS,
        "bots": [
            {
                "bot_id": bid,
                "username": data["username"],
                "name": data["name"],
                "mode": data["mode"],
                "status": "Running" if data["process"].poll() is None else "Stopped",
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
    if not bot_id.isdigit():
        raise HTTPException(status_code=400, detail="Bot ID prefix in token must be numeric.")

    if bot_id not in RUNNING_BOTS and len(RUNNING_BOTS) >= MAX_BOTS:
        raise HTTPException(status_code=429, detail=f"Instance limit reached ({MAX_BOTS} active bots max).")

    if not payload.code.strip():
        raise HTTPException(status_code=400, detail="Python script cannot be empty.")

    bot_user = await verify_telegram_token(token)

    # Clean previous files if redeploying same bot_id
    stop_and_purge_bot(bot_id)

    bot_dir = BOTS_DIR / bot_id
    bot_dir.mkdir(parents=True, exist_ok=True)
    script_path = bot_dir / "bot.py"

    validate_python_syntax(payload.code, script_path)
    pip_summary = await asyncio.to_thread(install_requirements, payload.requirements, bot_dir)

    public_url = os.getenv("RENDER_EXTERNAL_URL") or str(request.base_url).rstrip("/")
    mode_status = await configure_telegram_mode(token, payload.mode, public_url, bot_id)

    await asyncio.to_thread(spawn_bot_process, token, bot_id, payload.mode, public_url, bot_user)

    return {
        "ok": True,
        "bot_id": bot_id,
        "bot_username": f"@{bot_user.get('username')}",
        "mode_status": mode_status,
        "pip_log": pip_summary
    }


@app.post("/api/restart/{bot_id}")
async def restart_bot(bot_id: str, request: Request):
    existing = RUNNING_BOTS.get(bot_id)
    bot_dir = BOTS_DIR / bot_id
    if not existing or not (bot_dir / "bot.py").exists():
        raise HTTPException(status_code=404, detail="Bot storage or active session not found.")

    token = existing["token"]
    mode = existing["mode"]
    user_info = {"username": existing["username"], "first_name": existing["name"]}

    # Stop old process without deleting bot.py / libs
    proc: subprocess.Popen = existing.get("process")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
    if existing.get("log_file") and not existing["log_file"].closed:
        existing["log_file"].close()

    public_url = os.getenv("RENDER_EXTERNAL_URL") or str(request.base_url).rstrip("/")
    await asyncio.to_thread(spawn_bot_process, token, bot_id, mode, public_url, user_info)
    return {"ok": True, "message": f"Bot @{user_info['username']} restarted."}


@app.delete("/api/delete/{bot_id}")
@app.post("/api/stop/{bot_id}")
async def delete_bot(bot_id: str):
    """Stops bot and deletes its entire storage directory from disk."""
    existed = stop_and_purge_bot(bot_id)
    if not existed:
        shutil.rmtree(BOTS_DIR / bot_id, ignore_errors=True)
    return {"ok": True, "message": f"Bot {bot_id} stopped and storage purged."}


@app.post("/webhook/{bot_id}")
async def proxy_webhook(bot_id: str, request: Request):
    bot = RUNNING_BOTS.get(bot_id)
    if not bot:
        return JSONResponse({"ok": False, "error": "Bot not running"}, status_code=404)

    body = await request.body()
    port = bot["internal_port"]
    async with httpx.AsyncClient(timeout=10.0) as client:
        for path in (f"/webhook/{bot_id}", "/"):
            try:
                resp = await client.post(
                    f"http://127.0.0.1:{port}{path}",
                    content=body,
                    headers={"Content-Type": "application/json"}
                )
                if resp.status_code < 500:
                    return JSONResponse(content={"ok": True}, status_code=resp.status_code)
            except Exception:
                continue
    return JSONResponse({"ok": False, "detail": "Bot webhook server not listening on PORT"}, status_code=502)


@app.get("/api/logs/{bot_id}")
async def get_logs(bot_id: str):
    log_path = BOTS_DIR / bot_id / "bot.log"
    if not log_path.exists():
        return {"logs": "Storage cleared or no logs available."}
    content = log_path.read_text(encoding="utf-8", errors="replace")
    return {"logs": content[-6000:] or "Process active (no stdout printed yet)..."}


@app.get("/health")
async def health_check():
    return {"status": "alive", "running_bots": len(RUNNING_BOTS)}

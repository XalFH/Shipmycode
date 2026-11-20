let currentBotId = null;
let logInterval = null;

const editor = CodeMirror.fromTextArea(document.getElementById("codeEditor"), {
  mode: "python",
  theme: "dracula",
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  lineWrapping: true
});

// DEMO 1: Polling Bot (pyTelegramBotAPI)
const DEMO_POLLING_BOT = `import os
import time
import platform
import telebot

BOT_TOKEN = os.environ.get("BOT_TOKEN")
bot = telebot.TeleBot(BOT_TOKEN)
START_TIME = time.time()

@bot.message_handler(commands=['start', 'help'])
def handle_start(message):
    user = message.from_user.first_name
    bot.reply_to(
        message,
        f"Hello {user}!\\n"
        f"Bot is live on PyBot Cloud (Polling Mode).\\n\\n"
        f"Commands:\\n"
        f"/ping - Check response speed\\n"
        f"/id - Get your Telegram ID\\n"
        f"/info - Runtime details"
    )

@bot.message_handler(commands=['ping'])
def handle_ping(message):
    t0 = time.time()
    sent = bot.reply_to(message, "Pinging...")
    ms = round((time.time() - t0) * 1000, 1)
    bot.edit_message_text(f"Pong! {ms} ms", message.chat.id, sent.message_id)

@bot.message_handler(commands=['id'])
def handle_id(message):
    bot.reply_to(message, f"Your User ID: {message.from_user.id}\\nChat ID: {message.chat.id}")

@bot.message_handler(commands=['info'])
def handle_info(message):
    uptime = int(time.time() - START_TIME)
    bot.reply_to(message, f"Python: {platform.python_version()}\\nUptime: {uptime}s")

@bot.message_handler(func=lambda m: True)
def echo_msg(message):
    bot.reply_to(message, f"Echo: {message.text}")

print("[POLLING] Bot connected and listening for updates...")
bot.infinity_polling(skip_pending=True)
`;

// DEMO 2: Webhook Bot (aiohttp + pyTelegramBotAPI async)
const DEMO_WEBHOOK_BOT = `import os
import telebot
from telebot.async_telebot import AsyncTeleBot
from aiohttp import web

BOT_TOKEN = os.environ.get("BOT_TOKEN")
WEBHOOK_PATH = os.environ.get("WEBHOOK_PATH", "/")
PORT = int(os.environ.get("PORT", 9000))

bot = AsyncTeleBot(BOT_TOKEN)

@bot.message_handler(commands=['start', 'help'])
async def start_cmd(message):
    await bot.reply_to(
        message,
        f"Hello {message.from_user.first_name}!\\n"
        f"Running in Instant Webhook Mode on Render.\\n"
        f"Try /ping or send any text!"
    )

@bot.message_handler(commands=['ping'])
async def ping_cmd(message):
    await bot.reply_to(message, "Webhook Pong! Instant delivery active.")

@bot.message_handler(func=lambda m: True)
async def echo_cmd(message):
    await bot.reply_to(message, f"[Webhook Echo] {message.text}")

async def handle_webhook(request):
    if request.match_info.get("token") or True:
        body = await request.text()
        update = telebot.types.Update.de_json(body)
        await bot.process_new_updates([update])
        return web.Response(text="OK")

app = web.Application()
app.router.add_post(WEBHOOK_PATH, handle_webhook)
app.router.add_post("/", handle_webhook)

if __name__ == "__main__":
    print(f"[WEBHOOK] Listening internally on port {PORT} at {WEBHOOK_PATH}")
    web.run_app(app, host="127.0.0.1", port=PORT)
`;

// Load Polling Demo by default
function loadDemo(type) {
  if (type === "webhook") {
    editor.setValue(DEMO_WEBHOOK_BOT);
    document.getElementById("reqBox").value = "pyTelegramBotAPI\naiohttp";
    document.getElementById("deployMode").value = "webhook";
    logConsole("Loaded Demo: Webhook Bot (pyTelegramBotAPI + aiohttp). Mode switched to Auto Webhook.");
  } else {
    editor.setValue(DEMO_POLLING_BOT);
    document.getElementById("reqBox").value = "pyTelegramBotAPI";
    document.getElementById("deployMode").value = "polling";
    logConsole("Loaded Demo: Polling Bot (pyTelegramBotAPI). Mode switched to Auto Polling.");
  }
}

loadDemo("polling");

document.getElementById("demoPollingBtn").addEventListener("click", () => loadDemo("polling"));
document.getElementById("demoWebhookBtn").addEventListener("click", () => loadDemo("webhook"));

// Safe API Fetch Helper (Never crashes on plain-text 500 errors)
async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { detail: `HTTP ${res.status}: ${rawText.slice(0, 300)}` };
  }
  return { ok: res.ok, status: res.status, data };
}

// Theme Toggle
document.getElementById("themeToggle").addEventListener("click", () => {
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  editor.setOption("theme", isDark ? "eclipse" : "dracula");
});

// Token Show/Hide & Verify
document.getElementById("toggleTokenVis").addEventListener("click", () => {
  const inp = document.getElementById("botToken");
  inp.type = inp.type === "password" ? "text" : "password";
});

document.getElementById("verifyTokenBtn").addEventListener("click", async () => {
  const token = document.getElementById("botToken").value.trim();
  const statusEl = document.getElementById("tokenStatus");
  if (!token) {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "Enter a Bot Token first.";
    return;
  }
  statusEl.style.color = "#94a3b8";
  statusEl.textContent = "Checking with Telegram...";

  const { ok, data } = await safeFetchJson("/api/verify-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_token: token })
  });

  if (ok) {
    statusEl.style.color = "#10b981";
    statusEl.textContent = `Verified: ${data.name} (${data.username})`;
    logConsole(`Token verified -> ${data.name} (${data.username}) [ID: ${data.id}]`);
  } else {
    statusEl.style.color = "#f87171";
    statusEl.textContent = data.detail || "Invalid token";
    logConsole(`Token verification failed: ${data.detail}`, true);
  }
});

// File Uploads -> Sync into Editor & Requirements
document.getElementById("pyFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    editor.setValue(ev.target.result);
    logConsole(`Loaded ${file.name} (${file.size} bytes) into editor.`);
  };
  reader.readAsText(file);
});

document.getElementById("reqFileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    document.getElementById("reqBox").value = ev.target.result;
    logConsole(`Loaded ${file.name} into requirements.`);
  };
  reader.readAsText(file);
});

// Floating Terminal Controls
const termEl = document.getElementById("floatingTerminal");
const consoleOut = document.getElementById("consoleOut");

function logConsole(msg, isError = false) {
  termEl.classList.remove("minimized");
  consoleOut.style.color = isError ? "#f87171" : "#34d399";
  consoleOut.textContent = msg;
  consoleOut.scrollTop = consoleOut.scrollHeight;
}

document.getElementById("termMinBtn").addEventListener("click", () => {
  termEl.classList.toggle("minimized");
});
document.getElementById("toggleTermBtn").addEventListener("click", () => {
  termEl.classList.toggle("minimized");
});
document.getElementById("termExpandBtn").addEventListener("click", () => {
  termEl.classList.toggle("expanded");
});
document.getElementById("termClearBtn").addEventListener("click", () => {
  consoleOut.textContent = "";
});

// Draggable Floating Terminal (Desktop Mouse Drag)
const dragHandle = document.getElementById("termDragHandle");
let isDragging = false, offsetX = 0, offsetY = 0;
dragHandle.addEventListener("mousedown", (e) => {
  if (e.target.tagName === "BUTTON") return;
  isDragging = true;
  const rect = termEl.getBoundingClientRect();
  offsetX = e.clientX - rect.left;
  offsetY = e.clientY - rect.top;
  termEl.style.right = "auto";
  termEl.style.bottom = "auto";
  termEl.style.left = rect.left + "px";
  termEl.style.top = rect.top + "px";
});
document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  termEl.style.left = Math.max(0, Math.min(window.innerWidth - 200, e.clientX - offsetX)) + "px";
  termEl.style.top = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - offsetY)) + "px";
});
document.addEventListener("mouseup", () => { isDragging = false; });

// Deploy Bot
document.getElementById("deployBtn").addEventListener("click", async () => {
  const btn = document.getElementById("deployBtn");
  const botToken = document.getElementById("botToken").value.trim();
  const code = editor.getValue();
  const requirements = document.getElementById("reqBox").value;
  const mode = document.getElementById("deployMode").value;

  if (!botToken) {
    logConsole("Error: Please enter your Telegram Bot Token.", true);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Deploying...`;
  logConsole(
    `[1/4] Verifying Bot Token...\n` +
    `[2/4] Compiling & checking Python syntax...\n` +
    `[3/4] Installing requirements...\n` +
    `[4/4] Configuring ${mode.toUpperCase()} & launching process...`
  );

  const { ok, data } = await safeFetchJson("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_token: botToken, code, requirements, mode })
  });

  btn.disabled = false;
  btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Validate & Deploy Bot`;

  if (!ok) {
    logConsole(`DEPLOYMENT FAILED:\n${data.detail || "Unknown server error"}`, true);
    return;
  }

  currentBotId = data.bot_id;
  logConsole(
    `DEPLOYED SUCCESSFULLY!\n` +
    `Bot: ${data.bot_username} (ID: ${data.bot_id})\n` +
    `Status: ${data.mode_status}\n` +
    `${data.pip_log}\n` +
    `----------------------------------------\n` +
    `Streaming live bot logs...`
  );
  fetchSystemStats();
  startLogPolling(data.bot_id);
});

async function fetchLogs(botId) {
  if (!botId) return;
  const { ok, data } = await safeFetchJson(`/api/logs/${botId}`);
  if (ok && data.logs) {
    consoleOut.style.color = "#34d399";
    consoleOut.textContent = data.logs;
    consoleOut.scrollTop = consoleOut.scrollHeight;
  }
}

function startLogPolling(botId) {
  if (logInterval) clearInterval(logInterval);
  logInterval = setInterval(() => fetchLogs(botId), 3500);
}

async function stopBot(botId) {
  await safeFetchJson(`/api/stop/${botId}`, { method: "POST" });
  if (currentBotId === botId && logInterval) clearInterval(logInterval);
  logConsole(`Bot ${botId} stopped.`);
  fetchSystemStats();
}

async function fetchSystemStats() {
  const { ok, data } = await safeFetchJson("/api/system");
  if (!ok) return;

  document.getElementById("ramStat").textContent = `RAM: ${data.ram_used_mb} / ${data.ram_total_mb} MB`;
  document.getElementById("botCountStat").textContent = `Bots: ${data.active_bots} / ${data.max_bots}`;

  const list = document.getElementById("activeBotsList");
  if (!data.bots.length) {
    list.innerHTML = `<span style="color:var(--muted); font-size:0.84rem;">No bots active right now.</span>`;
    return;
  }

  list.innerHTML = data.bots.map(b => `
    <div class="bot-item">
      <div>
        <strong>@${b.username}</strong> <span style="color:var(--success); font-weight:600;">● ${b.status}</span>
        <div style="color:var(--muted); font-size:0.75rem;">Mode: ${b.mode.toUpperCase()} • Uptime: ${b.uptime_sec}s</div>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn btn-outline btn-sm" onclick="currentBotId='${b.bot_id}'; termEl.classList.remove('minimized'); fetchLogs('${b.bot_id}')">Logs</button>
        <button class="btn btn-danger btn-sm" onclick="stopBot('${b.bot_id}')">Stop</button>
      </div>
    </div>
  `).join("");
}

setInterval(fetchSystemStats, 5000);
fetchSystemStats();

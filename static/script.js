document.addEventListener("DOMContentLoaded", () => {
  let currentBotId = null;
  let logInterval = null;

  // Grab all DOM elements first (prevents Temporal Dead Zone ReferenceErrors)
  const codeTextArea = document.getElementById("codeEditor");
  const reqBox = document.getElementById("reqBox");
  const deployMode = document.getElementById("deployMode");
  const botTokenInput = document.getElementById("botToken");
  const tokenStatusEl = document.getElementById("tokenStatus");
  const termEl = document.getElementById("floatingTerminal");
  const consoleOut = document.getElementById("consoleOut");
  const dragHandle = document.getElementById("termDragHandle");

  // Initialize CodeMirror with safe fallback to plain textarea
  let cmEditor = null;
  if (typeof window.CodeMirror !== "undefined" && codeTextArea) {
    cmEditor = CodeMirror.fromTextArea(codeTextArea, {
      mode: "python",
      theme: "dracula",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      lineWrapping: true
    });
  }

  function getEditorCode() {
    return cmEditor ? cmEditor.getValue() : (codeTextArea ? codeTextArea.value : "");
  }

  function setEditorCode(val) {
    if (cmEditor) {
      cmEditor.setValue(val);
    } else if (codeTextArea) {
      codeTextArea.value = val;
    }
  }

  function logConsole(msg, isError = false) {
    if (!consoleOut) return;
    if (termEl) termEl.classList.remove("minimized");
    consoleOut.style.color = isError ? "#f87171" : "#34d399";
    consoleOut.textContent = msg;
    consoleOut.scrollTop = consoleOut.scrollHeight;
  }

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

  function loadDemo(type) {
    if (type === "webhook") {
      setEditorCode(DEMO_WEBHOOK_BOT);
      if (reqBox) reqBox.value = "pyTelegramBotAPI\naiohttp";
      if (deployMode) deployMode.value = "webhook";
      logConsole("Loaded Demo: Webhook Bot (pyTelegramBotAPI + aiohttp). Mode switched to Auto Webhook.");
    } else {
      setEditorCode(DEMO_POLLING_BOT);
      if (reqBox) reqBox.value = "pyTelegramBotAPI";
      if (deployMode) deployMode.value = "polling";
      logConsole("Loaded Demo: Polling Bot (pyTelegramBotAPI). Mode switched to Auto Polling.");
    }
  }

  // Load default demo safely now that all DOM refs exist
  loadDemo("polling");

  document.getElementById("demoPollingBtn")?.addEventListener("click", () => loadDemo("polling"));
  document.getElementById("demoWebhookBtn")?.addEventListener("click", () => loadDemo("webhook"));

  // Safe API Fetch Helper (Never crashes on plain-text 500 errors)
  async function safeFetchJson(url, options = {}) {
    try {
      const res = await fetch(url, options);
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { detail: `HTTP ${res.status}: ${rawText.slice(0, 300)}` };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { detail: `Network Error: ${err.message}` } };
    }
  }

  // Theme Toggle
  document.getElementById("themeToggle")?.addEventListener("click", () => {
    const html = document.documentElement;
    const isDark = html.getAttribute("data-theme") === "dark";
    html.setAttribute("data-theme", isDark ? "light" : "dark");
    if (cmEditor) cmEditor.setOption("theme", isDark ? "eclipse" : "dracula");
  });

  // Token Show/Hide
  document.getElementById("toggleTokenVis")?.addEventListener("click", () => {
    if (!botTokenInput) return;
    botTokenInput.type = botTokenInput.type === "password" ? "text" : "password";
  });

  // Token Verify
  document.getElementById("verifyTokenBtn")?.addEventListener("click", async () => {
    const token = botTokenInput ? botTokenInput.value.trim() : "";
    if (!token) {
      if (tokenStatusEl) {
        tokenStatusEl.style.color = "#f87171";
        tokenStatusEl.textContent = "Enter a Bot Token first.";
      }
      return;
    }
    if (tokenStatusEl) {
      tokenStatusEl.style.color = "#94a3b8";
      tokenStatusEl.textContent = "Checking with Telegram...";
    }

    const { ok, data } = await safeFetchJson("/api/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token: token })
    });

    if (ok) {
      if (tokenStatusEl) {
        tokenStatusEl.style.color = "#10b981";
        tokenStatusEl.textContent = `Verified: ${data.name} (${data.username})`;
      }
      logConsole(`Token verified -> ${data.name} (${data.username}) [ID: ${data.id}]`);
    } else {
      if (tokenStatusEl) {
        tokenStatusEl.style.color = "#f87171";
        tokenStatusEl.textContent = data.detail || "Invalid token";
      }
      logConsole(`Token verification failed: ${data.detail}`, true);
    }
  });

  // File Uploads -> Sync into Editor & Requirements
  document.getElementById("pyFileInput")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setEditorCode(ev.target.result);
      logConsole(`Loaded ${file.name} (${file.size} bytes) into editor.`);
    };
    reader.readAsText(file);
  });

  document.getElementById("reqFileInput")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (reqBox) reqBox.value = ev.target.result;
      logConsole(`Loaded ${file.name} into requirements.`);
    };
    reader.readAsText(file);
  });

  // Floating Terminal Controls
  document.getElementById("termMinBtn")?.addEventListener("click", () => {
    termEl?.classList.toggle("minimized");
  });
  document.getElementById("toggleTermBtn")?.addEventListener("click", () => {
    termEl?.classList.toggle("minimized");
  });
  document.getElementById("termExpandBtn")?.addEventListener("click", () => {
    termEl?.classList.toggle("expanded");
  });
  document.getElementById("termClearBtn")?.addEventListener("click", () => {
    if (consoleOut) consoleOut.textContent = "";
  });

  // Draggable Floating Terminal (Supports both Mouse & Mobile Touch)
  if (dragHandle && termEl) {
    let isDragging = false, offsetX = 0, offsetY = 0;

    const startDrag = (clientX, clientY, target) => {
      if (target && target.closest("button")) return;
      isDragging = true;
      const rect = termEl.getBoundingClientRect();
      offsetX = clientX - rect.left;
      offsetY = clientY - rect.top;
      termEl.style.right = "auto";
      termEl.style.bottom = "auto";
      termEl.style.left = rect.left + "px";
      termEl.style.top = rect.top + "px";
    };

    const moveDrag = (clientX, clientY) => {
      if (!isDragging) return;
      const maxX = Math.max(0, window.innerWidth - termEl.offsetWidth);
      const maxY = Math.max(0, window.innerHeight - 48);
      termEl.style.left = Math.max(0, Math.min(maxX, clientX - offsetX)) + "px";
      termEl.style.top = Math.max(0, Math.min(maxY, clientY - offsetY)) + "px";
    };

    dragHandle.addEventListener("mousedown", (e) => startDrag(e.clientX, e.clientY, e.target));
    document.addEventListener("mousemove", (e) => moveDrag(e.clientX, e.clientY));
    document.addEventListener("mouseup", () => { isDragging = false; });

    dragHandle.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      startDrag(t.clientX, t.clientY, e.target);
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!isDragging) return;
      const t = e.touches[0];
      moveDrag(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener("touchend", () => { isDragging = false; });
  }

  // Deploy Bot
  document.getElementById("deployBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("deployBtn");
    const botToken = botTokenInput ? botTokenInput.value.trim() : "";
    const code = getEditorCode();
    const requirements = reqBox ? reqBox.value : "";
    const mode = deployMode ? deployMode.value : "polling";

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
    if (ok && data.logs && consoleOut) {
      consoleOut.style.color = "#34d399";
      consoleOut.textContent = data.logs;
      consoleOut.scrollTop = consoleOut.scrollHeight;
    }
  }

  function startLogPolling(botId) {
    if (logInterval) clearInterval(logInterval);
    logInterval = setInterval(() => fetchLogs(botId), 3500);
  }

  // Expose functions globally for inline onclick handlers in Active Bots list
  window.viewBotLogs = (botId) => {
    currentBotId = botId;
    termEl?.classList.remove("minimized");
    fetchLogs(botId);
  };

  window.stopBot = async (botId) => {
    await safeFetchJson(`/api/stop/${botId}`, { method: "POST" });
    if (currentBotId === botId && logInterval) clearInterval(logInterval);
    logConsole(`Bot ${botId} stopped.`);
    fetchSystemStats();
  };

  async function fetchSystemStats() {
    const { ok, data } = await safeFetchJson("/api/system");
    if (!ok) return;

    const ramEl = document.getElementById("ramStat");
    const countEl = document.getElementById("botCountStat");
    if (ramEl) ramEl.textContent = `RAM: ${data.ram_used_mb} / ${data.ram_total_mb} MB`;
    if (countEl) countEl.textContent = `Bots: ${data.active_bots} / ${data.max_bots}`;

    const list = document.getElementById("activeBotsList");
    if (!list) return;

    if (!data.bots || !data.bots.length) {
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
          <button class="btn btn-outline btn-sm" onclick="window.viewBotLogs('${b.bot_id}')">Logs</button>
          <button class="btn btn-danger btn-sm" onclick="window.stopBot('${b.bot_id}')">Stop</button>
        </div>
      </div>
    `).join("");
  }

  setInterval(fetchSystemStats, 5000);
  fetchSystemStats();
});

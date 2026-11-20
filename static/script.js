let currentBotId = null;
let logInterval = null;

// Initialize CodeMirror Python Editor
const editor = CodeMirror.fromTextArea(document.getElementById("codeEditor"), {
  mode: "python",
  theme: "dracula",
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  lineWrapping: true
});

const SAMPLE_BOT = `import os
import telebot

BOT_TOKEN = os.environ.get("BOT_TOKEN")
bot = telebot.TeleBot(BOT_TOKEN)

@bot.message_handler(commands=['start', 'help'])
def send_welcome(message):
    bot.reply_to(message, "Hello! Deployed live via PyBot Cloud on Render.")

@bot.message_handler(func=lambda m: True)
def echo_all(message):
    bot.reply_to(message, f"Echo: {message.text}")

print("Bot polling started successfully...")
bot.infinity_polling(skip_pending=True)
`;

editor.setValue(SAMPLE_BOT);
document.getElementById("reqBox").value = "pyTelegramBotAPI";

// Theme Switcher
document.getElementById("themeToggle").addEventListener("click", () => {
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", isDark ? "light" : "dark");
  editor.setOption("theme", isDark ? "eclipse" : "dracula");
});

// Load Sample Bot
document.getElementById("loadSampleBtn").addEventListener("click", () => {
  editor.setValue(SAMPLE_BOT);
  document.getElementById("reqBox").value = "pyTelegramBotAPI";
  logConsole("Loaded sample pyTelegramBotAPI bot.");
});

// Handle .py File Upload -> Load into Editor
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

// Handle requirements.txt Upload -> Load into Requirements Box
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

function logConsole(msg, isError = false) {
  const el = document.getElementById("consoleOut");
  el.style.color = isError ? "#f87171" : "#34d399";
  el.textContent = msg;
  el.scrollTop = el.scrollHeight;
}

// Deploy Action
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
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Installing & Deploying...`;
  logConsole("1/4 Verifying Bot Token with Telegram...\n2/4 Checking Python syntax...\n3/4 Installing requirements...\n4/4 Setting webhook/polling & starting bot...");

  try {
    const res = await fetch("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token: botToken, code, requirements, mode })
    });
    const data = await res.json();

    if (!res.ok) {
      logConsole(`Deployment Failed:\n${data.detail || "Unknown error"}`, true);
    } else {
      currentBotId = data.bot_id;
      logConsole(
        `DEPLOYED SUCCESSFULLY!\n` +
        `Bot: ${data.bot_username} (ID: ${data.bot_id})\n` +
        `Mode: ${data.mode_status}\n` +
        `----------------------------------------\n` +
        `${data.pip_log}`
      );
      fetchSystemStats();
      startLogPolling(data.bot_id);
    }
  } catch (err) {
    logConsole(`Network Error: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Validate & Deploy Bot`;
  }
});

async function fetchLogs(botId) {
  if (!botId) return;
  try {
    const res = await fetch(`/api/logs/${botId}`);
    const data = await res.json();
    logConsole(data.logs);
  } catch (_) {}
}

function startLogPolling(botId) {
  if (logInterval) clearInterval(logInterval);
  logInterval = setInterval(() => fetchLogs(botId), 4000);
}

document.getElementById("refreshLogsBtn").addEventListener("click", () => {
  if (currentBotId) fetchLogs(currentBotId);
});

async function stopBot(botId) {
  await fetch(`/api/stop/${botId}`, { method: "POST" });
  if (currentBotId === botId && logInterval) clearInterval(logInterval);
  logConsole(`Bot ${botId} stopped.`);
  fetchSystemStats();
}

async function fetchSystemStats() {
  try {
    const res = await fetch("/api/system");
    const data = await res.json();
    document.getElementById("ramStat").textContent = `RAM: ${data.ram_used_mb} / ${data.ram_total_mb} MB`;
    document.getElementById("botCountStat").textContent = `Bots: ${data.active_bots} / ${data.max_bots}`;

    const list = document.getElementById("activeBotsList");
    if (!data.bots.length) {
      list.innerHTML = `<span style="color:var(--muted); font-size:0.85rem;">No bots running yet.</span>`;
      return;
    }

    list.innerHTML = data.bots.map(b => `
      <div class="bot-item">
        <div>
          <strong>@${b.username}</strong> <span class="badge-ok">● ${b.status}</span>
          <div style="color:var(--muted); font-size:0.75rem;">Mode: ${b.mode} • Uptime: ${b.uptime_sec}s</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-outline" style="padding:5px 9px; font-size:0.75rem;" onclick="currentBotId='${b.bot_id}'; fetchLogs('${b.bot_id}')">Logs</button>
          <button class="btn btn-danger" style="padding:5px 9px; font-size:0.75rem;" onclick="stopBot('${b.bot_id}')">Stop</button>
        </div>
      </div>
    `).join("");
  } catch (_) {}
}

setInterval(fetchSystemStats, 5000);
fetchSystemStats();

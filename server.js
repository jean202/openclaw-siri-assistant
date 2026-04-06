const http = require("node:http");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// --- Load .env (no external deps) ---
const envPath = path.join(__dirname, ".env");
try {
  const envContent = fs.readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

// --- Config ---
const PORT = process.env.PORT || 3456;
const API_SECRET = process.env.API_SECRET || crypto.randomBytes(24).toString("hex");
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const TIMEOUT_SEC = Number(process.env.TIMEOUT_SEC) || 120;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful personal AI assistant called via Siri. " +
    "Respond in the same language the user speaks. Be concise and practical. " +
    "Keep responses short enough to be read aloud (under 3-4 sentences unless asked for detail).";

// --- Logging ---
const LOG_DIR = path.join(__dirname, "logs");
const REQ_LOG = path.join(LOG_DIR, "requests.log");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function log(entry) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
  fs.appendFile(REQ_LOG, line, () => {});
}

// --- Usage Tracking ---
const USAGE_FILE = path.join(__dirname, "logs", "usage.json");

function loadUsageData() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return { requests: [], daily: {}, totalTokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  }
}

function saveUsageData(data) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

function recordUsage(entry) {
  const data = loadUsageData();
  const day = new Date().toISOString().slice(0, 10);

  // Append to recent requests (keep last 500)
  data.requests.push(entry);
  if (data.requests.length > 500) data.requests = data.requests.slice(-500);

  // Aggregate daily
  if (!data.daily[day]) data.daily[day] = { requests: 0, input: 0, output: 0, cacheRead: 0, total: 0, elapsed_ms: 0 };
  const d = data.daily[day];
  d.requests++;
  d.input += entry.tokens?.input || 0;
  d.output += entry.tokens?.output || 0;
  d.cacheRead += entry.tokens?.cacheRead || 0;
  d.total += entry.tokens?.total || 0;
  d.elapsed_ms += entry.elapsed_ms || 0;

  // Aggregate totals
  data.totalTokens.input += entry.tokens?.input || 0;
  data.totalTokens.output += entry.tokens?.output || 0;
  data.totalTokens.cacheRead += entry.tokens?.cacheRead || 0;
  data.totalTokens.total += entry.tokens?.total || 0;

  // Prune daily older than 90 days
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(data.daily)) {
    if (key < cutoff) delete data.daily[key];
  }

  saveUsageData(data);
}

function getCodexQuota() {
  return new Promise((resolve) => {
    execFile(OPENCLAW_BIN, ["models", "status"], { timeout: 10000, env: { ...process.env, NODE_NO_WARNINGS: "1" } }, (err, stdout, stderr) => {
      const output = stdout || stderr || "";
      const match = output.match(/openai-codex usage:\s*(.+)/);
      resolve(match ? match[1].trim() : "unavailable");
    });
  });
}

// --- Session Management ---
const SESSION_TIMEOUT_MIN = Number(process.env.SESSION_TIMEOUT_MIN) || 30;
const sessions = new Map(); // sessionId -> { lastActive, messageCount }

function getOrCreateSession(sessionId) {
  const now = Date.now();
  let session = sessions.get(sessionId);
  if (!session || (now - session.lastActive) > SESSION_TIMEOUT_MIN * 60 * 1000) {
    // New session or expired — generate a fresh session ID with timestamp
    const freshId = `${sessionId}-${Date.now().toString(36)}`;
    session = { id: freshId, lastActive: now, messageCount: 0 };
    sessions.set(sessionId, session);
  }
  session.lastActive = now;
  session.messageCount++;
  return session;
}

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if ((now - s.lastActive) > SESSION_TIMEOUT_MIN * 60 * 1000) {
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000);

// --- Helpers ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function askOpenClaw(message, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      `[System: ${SYSTEM_PROMPT}]\n\nUser: ${message}`,
      "--json",
    ];

    const opts = {
      timeout: TIMEOUT_SEC * 1000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    };

    execFile(OPENCLAW_BIN, args, opts, (err, stdout, stderr) => {
      const output = stderr || stdout || "";
      if (err && !output) return reject(new Error(err.message));
      const idx = output.indexOf('\n{\n');
      if (idx === -1) return resolve({ text: output.trim() || "No response", tokens: null, model: null });
      const jsonStr = output.slice(idx).trim();
      try {
        const result = JSON.parse(jsonStr);
        const text = result.payloads?.map((p) => p.text).join("\n") || "No response";
        const meta = result.meta?.agentMeta;
        const tokens = meta?.usage || null;
        const model = meta?.model || null;
        resolve({ text, tokens, model });
      } catch {
        resolve({ text: output.trim() || "No response", tokens: null, model: null });
      }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  // Usage API
  if (req.method === "GET" && req.url === "/usage") {
    const data = loadUsageData();
    const quota = await getCodexQuota();
    return json(res, 200, { ...data, codexQuota: quota });
  }

  // Usage dashboard
  if (req.method === "GET" && req.url === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(getDashboardHTML());
  }

  // Main endpoint: POST /ask
  if (req.method === "POST" && req.url === "/ask") {
    const startTime = Date.now();
    let sessionId = "siri-default";
    try {
      const body = JSON.parse(await readBody(req));

      // Auth check
      if (body.secret !== API_SECRET) {
        log({ event: "auth_fail", session_id: sessionId });
        return json(res, 401, { error: "Invalid secret", reply: "Authentication failed." });
      }

      const message = body.message?.trim();
      if (!message) {
        log({ event: "bad_request", reason: "empty message", session_id: sessionId });
        return json(res, 400, { error: "message is required", reply: "No message received." });
      }

      const deviceId = body.session_id || body.device_id || "siri-default";
      const session = getOrCreateSession(deviceId);
      sessionId = session.id;
      log({ event: "ask", device_id: deviceId, session_id: sessionId, message_count: session.messageCount, message_length: message.length });

      const result = await askOpenClaw(message, sessionId);
      const elapsed = Date.now() - startTime;
      log({ event: "reply", device_id: deviceId, session_id: sessionId, elapsed_ms: elapsed, reply_length: result.text.length, tokens: result.tokens, model: result.model });
      recordUsage({ ts: new Date().toISOString(), device_id: deviceId, session_id: sessionId, message_length: message.length, reply_length: result.text.length, elapsed_ms: elapsed, tokens: result.tokens, model: result.model });
      return json(res, 200, { reply: result.text, session_id: sessionId });
    } catch (e) {
      const elapsed = Date.now() - startTime;
      log({ event: "error", session_id: sessionId, elapsed_ms: elapsed, error: e.message });
      return json(res, 500, { error: e.message, reply: "An error occurred. Please try again." });
    }
  }

  json(res, 404, { error: "Not found" });
});

// --- Dashboard HTML ---
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Siri Bridge — Usage Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; }
  h1 { font-size: 1.4em; margin-bottom: 20px; color: #ff6b35; }
  h2 { font-size: 1.1em; margin: 20px 0 10px; color: #ccc; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; padding: 16px; }
  .card .label { font-size: 0.75em; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 1.8em; font-weight: 700; margin-top: 4px; color: #fff; }
  .card .sub { font-size: 0.8em; color: #666; margin-top: 4px; }
  .quota-card { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .quota-card .value { font-size: 1.1em; color: #4ecdc4; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #222; }
  th { color: #888; font-weight: 500; font-size: 0.75em; text-transform: uppercase; }
  tr:hover td { background: #1a1a1a; }
  .bar-container { width: 100%; height: 20px; background: #222; border-radius: 4px; overflow: hidden; margin-top: 6px; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .bar-input { background: #4ecdc4; }
  .bar-output { background: #ff6b35; }
  .bar-cache { background: #666; }
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 120px; margin: 10px 0; }
  .chart-bar { flex: 1; background: #4ecdc4; border-radius: 3px 3px 0 0; min-width: 8px; position: relative; }
  .chart-bar:hover::after { content: attr(data-tip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 4px 8px; border-radius: 4px; font-size: 0.7em; white-space: nowrap; }
  .legend { display: flex; gap: 16px; font-size: 0.75em; color: #888; margin-top: 8px; }
  .legend span::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .legend .l-input::before { background: #4ecdc4; }
  .legend .l-output::before { background: #ff6b35; }
  .legend .l-cache::before { background: #666; }
  .refresh { color: #888; font-size: 0.8em; cursor: pointer; }
  .refresh:hover { color: #4ecdc4; }
  #loading { color: #666; padding: 40px; text-align: center; }
</style>
</head>
<body>
<h1>OpenClaw Siri Bridge <span class="refresh" onclick="load()">Refresh</span></h1>
<div id="loading">Loading...</div>
<div id="app" style="display:none">

<div class="quota-card">
  <div class="label">Codex Quota (ChatGPT Pro)</div>
  <div class="value" id="quota"></div>
</div>

<div class="grid">
  <div class="card"><div class="label">Total Requests</div><div class="value" id="totalReqs"></div></div>
  <div class="card"><div class="label">Total Tokens</div><div class="value" id="totalTokens"></div><div class="sub" id="tokenBreakdown"></div></div>
  <div class="card"><div class="label">Today Requests</div><div class="value" id="todayReqs"></div></div>
  <div class="card"><div class="label">Today Tokens</div><div class="value" id="todayTokens"></div></div>
  <div class="card"><div class="label">Avg Response</div><div class="value" id="avgTime"></div><div class="sub">ms</div></div>
  <div class="card"><div class="label">Model</div><div class="value" id="model" style="font-size:1em"></div></div>
</div>

<h2>Daily Token Usage (last 14 days)</h2>
<div class="chart" id="dailyChart"></div>
<div class="legend">
  <span class="l-input">Input</span>
  <span class="l-output">Output</span>
  <span class="l-cache">Cache Read</span>
</div>

<h2>Recent Requests</h2>
<table>
  <thead><tr><th>Time</th><th>Device</th><th>In Tokens</th><th>Out Tokens</th><th>Cache</th><th>Response</th></tr></thead>
  <tbody id="recentTable"></tbody>
</table>
</div>

<script>
function fmt(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n); }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleString('ko-KR', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '-'; }

async function load() {
  try {
    const r = await fetch('/usage');
    const d = await r.json();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = '';

    // Quota
    document.getElementById('quota').textContent = d.codexQuota || 'N/A';

    // Totals
    const t = d.totalTokens || {};
    const totalReqs = Object.values(d.daily||{}).reduce((s,v)=>s+v.requests,0);
    document.getElementById('totalReqs').textContent = fmt(totalReqs);
    document.getElementById('totalTokens').textContent = fmt(t.total||0);
    document.getElementById('tokenBreakdown').textContent = 'In: '+fmt(t.input||0)+' / Out: '+fmt(t.output||0)+' / Cache: '+fmt(t.cacheRead||0);

    // Today
    const today = new Date().toISOString().slice(0,10);
    const td = (d.daily||{})[today] || {requests:0,total:0};
    document.getElementById('todayReqs').textContent = td.requests;
    document.getElementById('todayTokens').textContent = fmt(td.total);

    // Avg time
    const reqs = d.requests || [];
    const recent = reqs.slice(-50);
    const avgMs = recent.length ? Math.round(recent.reduce((s,r)=>s+(r.elapsed_ms||0),0)/recent.length) : 0;
    document.getElementById('avgTime').textContent = avgMs.toLocaleString();

    // Model
    const lastModel = reqs.length ? reqs[reqs.length-1].model : '-';
    document.getElementById('model').textContent = lastModel || '-';

    // Daily chart - last 14 days
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
      days.push({ date: dt, ...(d.daily||{})[dt] || {input:0,output:0,cacheRead:0,total:0} });
    }
    const maxTok = Math.max(...days.map(x=>(x.input||0)+(x.output||0)+(x.cacheRead||0)),1);
    const chart = document.getElementById('dailyChart');
    chart.innerHTML = '';
    days.forEach(day => {
      const inp = day.input||0, out = day.output||0, cache = day.cacheRead||0;
      const total = inp+out+cache;
      const h = Math.max((total/maxTok)*100, total?3:0);
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      bar.style.height = h+'%';
      const inPct = total ? (inp/total*100) : 0;
      const outPct = total ? (out/total*100) : 0;
      bar.style.background = 'linear-gradient(to top, #4ecdc4 '+inPct+'%, #ff6b35 '+(inPct)+'%, #ff6b35 '+(inPct+outPct)+'%, #666 '+(inPct+outPct)+'%)';
      bar.setAttribute('data-tip', day.date.slice(5)+': '+fmt(total)+' tokens');
      chart.appendChild(bar);
    });

    // Recent table
    const tbody = document.getElementById('recentTable');
    tbody.innerHTML = '';
    reqs.slice(-20).reverse().forEach(r => {
      const tr = document.createElement('tr');
      const tok = r.tokens||{};
      tr.innerHTML = '<td>'+fmtDate(r.ts)+'</td><td>'+(r.device_id||'-')+'</td><td>'+fmt(tok.input||0)+'</td><td>'+fmt(tok.output||0)+'</td><td>'+fmt(tok.cacheRead||0)+'</td><td>'+(r.elapsed_ms||0)+'ms</td>';
      tbody.appendChild(tr);
    });
  } catch(e) {
    document.getElementById('loading').textContent = 'Error: '+e.message;
  }
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🦞 OpenClaw Siri Bridge running on http://127.0.0.1:${PORT}`);
  console.log(`   POST /ask    — Send a message`);
  console.log(`   GET /health  — Health check`);
  console.log(`   GET /usage   — Usage data (JSON)`);
  console.log(`   GET /dashboard — Usage dashboard`);
  console.log(`\n🔑 API_SECRET: ${API_SECRET}`);
  console.log(`   (set API_SECRET env var to use a fixed secret)\n`);
});

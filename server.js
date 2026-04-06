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
      // OpenClaw outputs JSON to stderr, not stdout
      const output = stderr || stdout || "";
      if (err && !output) return reject(new Error(err.message));
      // Find the first top-level { that starts a "payloads" JSON object
      const idx = output.indexOf('\n{\n');
      if (idx === -1) return resolve(output.trim() || "No response");
      const jsonStr = output.slice(idx).trim();
      try {
        const result = JSON.parse(jsonStr);
        const text = result.payloads?.map((p) => p.text).join("\n") || "No response";
        resolve(text);
      } catch {
        resolve(output.trim() || "No response");
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

  // Main endpoint: POST /ask
  if (req.method === "POST" && req.url === "/ask") {
    const startTime = Date.now();
    let sessionId = "siri-default";
    try {
      const body = JSON.parse(await readBody(req));

      // Auth check
      if (body.secret !== API_SECRET) {
        log({ event: "auth_fail", session_id: sessionId });
        return json(res, 401, { error: "Invalid secret" });
      }

      const message = body.message?.trim();
      if (!message) {
        log({ event: "bad_request", reason: "empty message", session_id: sessionId });
        return json(res, 400, { error: "message is required" });
      }

      const deviceId = body.session_id || body.device_id || "siri-default";
      const session = getOrCreateSession(deviceId);
      sessionId = session.id;
      log({ event: "ask", device_id: deviceId, session_id: sessionId, message_count: session.messageCount, message_length: message.length });

      const reply = await askOpenClaw(message, sessionId);
      const elapsed = Date.now() - startTime;
      log({ event: "reply", device_id: deviceId, session_id: sessionId, elapsed_ms: elapsed, reply_length: reply.length });
      return json(res, 200, { reply, session_id: sessionId });
    } catch (e) {
      const elapsed = Date.now() - startTime;
      log({ event: "error", session_id: sessionId, elapsed_ms: elapsed, error: e.message });
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🦞 OpenClaw Siri Bridge running on http://127.0.0.1:${PORT}`);
  console.log(`   POST /ask  — Send a message`);
  console.log(`   GET /health — Health check`);
  console.log(`\n🔑 API_SECRET: ${API_SECRET}`);
  console.log(`   (set API_SECRET env var to use a fixed secret)\n`);
});

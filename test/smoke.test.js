const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { execFileSync, spawn } = require("node:child_process");

const repoDir = path.resolve(__dirname, "..");

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function spawnWithOutput(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.getOutput = () => stdout + stderr;
  return child;
}

async function stopProcess(child, signal = "SIGTERM") {
  if (child.exitCode !== null) return;
  child.kill(signal);
  await once(child, "exit");
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null) return;
  process.kill(-child.pid, "SIGKILL");
  await once(child, "exit");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }

  throw lastError || new Error("Timed out waiting for condition");
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function request({ port, method = "GET", pathname = "/", headers = {}, body }) {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      }
    );

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFiles(destinationDir, files) {
  for (const file of files) {
    const source = path.join(repoDir, file);
    const target = path.join(destinationDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

async function startServerFixture(t, extraEnv = {}) {
  const fixtureDir = makeTempDir("openclaw-server-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const stubOpenClaw = path.join(stubDir, "openclaw");

  fs.mkdirSync(stubDir, { recursive: true });
  copyFiles(fixtureDir, ["server.js"]);

  writeExecutable(
    stubOpenClaw,
    `#!/bin/bash
set -e
if [ "$1" = "models" ] && [ "$2" = "status" ]; then
  echo "openai-codex usage: stub quota"
  exit 0
fi
if [ "$1" = "agent" ]; then
  if [[ "$*" == *"playable Apple Music query"* ]]; then
    printf '\\n{\\n  "payloads": [{"text": "{\\\\"intent\\\\":\\\\"play\\\\",\\\\"query\\\\":\\\\"ETA\\\\",\\\\"reply\\\\":\\\\"ETA 재생할게요.\\\\"}"}],\\n  "meta": {"agentMeta": {"usage": {"input": 4, "output": 5, "cacheRead": 0, "total": 9}, "model": "stub-model"}}\\n}\\n'
    exit 0
  fi
  echo "[plugins] stub warning" >&2
  printf '\\n{\\n  "payloads": [{"text": "Stub reply"}],\\n  "meta": {"agentMeta": {"usage": {"input": 1, "output": 2, "cacheRead": 0, "total": 3}, "model": "stub-model"}}\\n}\\n'
  exit 0
fi
echo "unexpected args: $*" >&2
exit 1
`
  );

  const port = await getFreePort();
  const child = spawnWithOutput(process.execPath, ["server.js"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PORT: String(port),
      API_SECRET: "test-secret",
      OPENCLAW_BIN: stubOpenClaw,
      MAX_BODY_BYTES: "128",
      ...extraEnv,
    },
  });

  t.after(async () => {
    await stopProcess(child);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  await waitFor(async () => {
    const res = await request({ port, pathname: "/health" });
    return res.statusCode === 200;
  });

  return { child, port };
}

test("server smoke: auth, validation, and happy path", async (t) => {
  const { port, child } = await startServerFixture(t);

  const unauthorizedUsage = await request({ port, pathname: "/usage" });
  assert.equal(unauthorizedUsage.statusCode, 401, child.getOutput());

  const authorizedUsage = await request({
    port,
    pathname: "/usage?secret=test-secret",
    headers: { "X-API-Secret": "test-secret" },
  });
  assert.equal(authorizedUsage.statusCode, 200, child.getOutput());
  assert.match(authorizedUsage.body, /stub quota/);

  const unauthorizedDashboard = await request({ port, pathname: "/dashboard" });
  assert.equal(unauthorizedDashboard.statusCode, 401, child.getOutput());

  const authorizedDashboard = await request({
    port,
    pathname: "/dashboard?secret=test-secret",
  });
  assert.equal(authorizedDashboard.statusCode, 200, child.getOutput());
  assert.match(authorizedDashboard.body, /Usage Dashboard/);

  const invalidJson = await request({
    port,
    method: "POST",
    pathname: "/ask",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength("not-json")),
    },
    body: "not-json",
  });
  assert.equal(invalidJson.statusCode, 400, child.getOutput());

  const arrayPayload = await request({
    port,
    method: "POST",
    pathname: "/ask",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength("[]")),
    },
    body: "[]",
  });
  assert.equal(arrayPayload.statusCode, 400, child.getOutput());

  const invalidMessage = JSON.stringify({ secret: "test-secret", message: 123 });
  const invalidMessageRes = await request({
    port,
    method: "POST",
    pathname: "/ask",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(invalidMessage)),
    },
    body: invalidMessage,
  });
  assert.equal(invalidMessageRes.statusCode, 400, child.getOutput());

  const oversized = JSON.stringify({ secret: "test-secret", message: "x".repeat(200) });
  const oversizedRes = await request({
    port,
    method: "POST",
    pathname: "/ask",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(oversized)),
    },
    body: oversized,
  });
  assert.equal(oversizedRes.statusCode, 413, child.getOutput());

  const validAsk = JSON.stringify({
    secret: "test-secret",
    message: "hello",
    session_id: "test-device",
  });
  const validAskRes = await request({
    port,
    method: "POST",
    pathname: "/ask",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(validAsk)),
    },
    body: validAsk,
  });
  assert.equal(validAskRes.statusCode, 200, child.getOutput());
  assert.match(validAskRes.body, /Stub reply/);
  assert.match(validAskRes.body, /test-device-/);

  const validMusic = JSON.stringify({
    secret: "test-secret",
    message: "play ETA",
    session_id: "music-device",
  });
  const validMusicRes = await request({
    port,
    method: "POST",
    pathname: "/music",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(validMusic)),
    },
    body: validMusic,
  });
  assert.equal(validMusicRes.statusCode, 200, child.getOutput());
  const musicBody = JSON.parse(validMusicRes.body);
  assert.equal(musicBody.service, "apple_music");
  assert.equal(musicBody.action, "play_top_hit");
  assert.equal(musicBody.can_autoplay, true);
  assert.equal(musicBody.query, "ETA");
  assert.equal(musicBody.source, "openclaw");
  assert.match(musicBody.session_id, /music-device-/);
});

test("server music service preference can switch to Melon search", async (t) => {
  const { port, child } = await startServerFixture(t, { MUSIC_SERVICE: "melon" });

  const body = JSON.stringify({
    secret: "test-secret",
    message: "play ETA",
    session_id: "music-device",
  });
  const res = await request({
    port,
    method: "POST",
    pathname: "/music",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });

  assert.equal(res.statusCode, 200, child.getOutput());
  const musicBody = JSON.parse(res.body);
  assert.equal(musicBody.service, "melon");
  assert.equal(musicBody.action, "search_music");
  assert.equal(musicBody.can_autoplay, false);
  assert.match(musicBody.reason, /Melon/);
});

test("start.sh smoke: named tunnel uses config-specific file", async (t) => {
  const fixtureDir = makeTempDir("openclaw-start-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const homeDir = path.join(fixtureDir, "home");
  const cloudflareDir = path.join(homeDir, ".cloudflared");
  const argsFile = path.join(fixtureDir, "cloudflared.args");

  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(cloudflareDir, { recursive: true });
  copyFiles(fixtureDir, ["start.sh"]);

  fs.writeFileSync(path.join(fixtureDir, ".tunnel-url"), "https://siri.example\n");
  fs.writeFileSync(path.join(cloudflareDir, "config-siri-assistant.yml"), "tunnel: test\n");

  writeExecutable(
    path.join(stubDir, "node"),
    `#!/bin/bash
exec sleep 30
`
  );
  writeExecutable(
    path.join(stubDir, "cloudflared"),
    `#!/bin/bash
printf '%s\\n' "$@" > "${argsFile}"
exec sleep 30
`
  );
  writeExecutable(
    path.join(stubDir, "openclaw"),
    `#!/bin/bash
exit 0
`
  );
  writeExecutable(
    path.join(stubDir, "osascript"),
    `#!/bin/bash
exit 0
`
  );

  const child = spawnWithOutput("/bin/bash", [path.join(fixtureDir, "start.sh")], {
    cwd: fixtureDir,
    detached: true,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: homeDir,
      PORT: "4569",
      API_SECRET: "test-secret",
      TUNNEL_NAME: "siri-assistant",
      TUNNEL_HOSTNAME: "siri.example",
    },
  });

  t.after(async () => {
    await stopProcessGroup(child);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  await waitFor(() => fs.existsSync(argsFile));
  const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(args, [
    "tunnel",
    "--config",
    path.join(cloudflareDir, "config-siri-assistant.yml"),
    "run",
    "siri-assistant",
  ]);
});

test("generate-music-shortcut creates a shortcut wired to /music and Play Music", async (t) => {
  const fixtureDir = makeTempDir("openclaw-music-shortcut-smoke-");
  const stubDir = path.join(fixtureDir, "bin");

  fs.mkdirSync(stubDir, { recursive: true });
  copyFiles(fixtureDir, ["generate-music-shortcut.js"]);
  fs.writeFileSync(path.join(fixtureDir, ".tunnel-url"), "https://siri.example\n");
  fs.writeFileSync(path.join(fixtureDir, ".secret"), "test-secret\n");

  writeExecutable(
    path.join(stubDir, "shortcuts"),
    `#!/bin/bash
input=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) input="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$input" "$output"
`
  );

  const child = spawnWithOutput(process.execPath, ["generate-music-shortcut.js"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
    },
  });

  const [exitCode] = await once(child, "exit");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  assert.equal(exitCode, 0, child.getOutput());
  assert.equal(fs.existsSync(path.join(fixtureDir, "PlayOpenClawMusic.shortcut")), true);

  const xml = execFileSync("plutil", [
    "-convert",
    "xml1",
    "-o",
    "-",
    path.join(fixtureDir, "PlayOpenClawMusic-unsigned.shortcut"),
  ], { encoding: "utf8" });

  assert.match(xml, /https:\/\/siri\.example\/music/);
  assert.match(xml, /<string>query<\/string>/);
  assert.match(xml, /is\.workflow\.actions\.playmusic/);
  assert.match(xml, /<key>WFInput<\/key>/);
});

// ---------------------------------------------------------------------------
// Helper: start server with a fully custom openclaw stub script
// ---------------------------------------------------------------------------
async function startServerWithCustomStub(t, stubScript, extraEnv = {}) {
  const fixtureDir = makeTempDir("openclaw-custom-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const stubBin = path.join(stubDir, "openclaw");

  fs.mkdirSync(stubDir, { recursive: true });
  copyFiles(fixtureDir, ["server.js"]);
  writeExecutable(stubBin, stubScript);

  const port = await getFreePort();
  const child = spawnWithOutput(process.execPath, ["server.js"], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PORT: String(port),
      API_SECRET: "test-secret",
      OPENCLAW_BIN: stubBin,
      ...extraEnv,
    },
  });

  t.after(async () => {
    await stopProcess(child);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  await waitFor(async () => {
    const res = await request({ port, pathname: "/health" });
    return res.statusCode === 200;
  });

  return { port, child };
}

// Convenience: POST a JSON body and get the response
async function postJson(port, pathname, body) {
  const raw = JSON.stringify(body);
  return request({
    port,
    method: "POST",
    pathname,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(raw)),
    },
    body: raw,
  });
}

// ---------------------------------------------------------------------------
// GET /health — explicit
// ---------------------------------------------------------------------------

test("GET /health returns {ok: true}", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await request({ port, pathname: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

// ---------------------------------------------------------------------------
// Routing — 404 for unknown paths and wrong methods
// ---------------------------------------------------------------------------

test("unknown routes return 404", async (t) => {
  const { port } = await startServerFixture(t);

  const unknownGet = await request({ port, pathname: "/unknown" });
  assert.equal(unknownGet.statusCode, 404);

  const unknownPost = await postJson(port, "/foo", {});
  assert.equal(unknownPost.statusCode, 404);

  // GET /ask is not a supported method — should 404
  const getAsk = await request({ port, pathname: "/ask" });
  assert.equal(getAsk.statusCode, 404);
});

// ---------------------------------------------------------------------------
// POST /ask — auth and validation edge cases
// ---------------------------------------------------------------------------

test("POST /ask rejects wrong secret with 401 and voice reply", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/ask", { secret: "bad", message: "hello" });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).reply, "Authentication failed.");
});

test("POST /ask rejects missing message field with 400", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/ask", { secret: "test-secret" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /No message received/);
});

test("POST /ask rejects whitespace-only message with 400", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/ask", { secret: "test-secret", message: "   " });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /No message received/);
});

// ---------------------------------------------------------------------------
// POST /ask — session management
// ---------------------------------------------------------------------------

test("POST /ask same device reuses session_id within timeout", async (t) => {
  const { port } = await startServerFixture(t, { SESSION_TIMEOUT_MIN: "60" });
  const body = { secret: "test-secret", message: "hi", session_id: "my-iphone" };
  const r1 = await postJson(port, "/ask", body);
  const r2 = await postJson(port, "/ask", body);
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(JSON.parse(r1.body).session_id, JSON.parse(r2.body).session_id);
});

test("POST /ask creates a new session_id after timeout expires", async (t) => {
  // SESSION_TIMEOUT_MIN=0 → 0 ms timeout, so any elapsed time resets the session.
  const { port } = await startServerFixture(t, { SESSION_TIMEOUT_MIN: "0" });
  const body = { secret: "test-secret", message: "hi", session_id: "my-iphone" };
  const r1 = await postJson(port, "/ask", body);
  await wait(10);
  const r2 = await postJson(port, "/ask", body);
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.notEqual(JSON.parse(r1.body).session_id, JSON.parse(r2.body).session_id);
});

test("POST /ask uses device_id field when session_id is absent", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/ask", { secret: "test-secret", message: "hi", device_id: "my-mac" });
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(res.body).session_id, /^my-mac-/);
});

test("POST /ask returns 500 with voice reply when OpenClaw crashes", async (t) => {
  const { port } = await startServerWithCustomStub(
    t,
    `#!/bin/bash\nif [ "$1" = "models" ]; then exit 0; fi\nexit 1`
  );
  const res = await postJson(port, "/ask", { secret: "test-secret", message: "hi" });
  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.reply === "string" && body.reply.length > 0);
});

// ---------------------------------------------------------------------------
// GET /usage and /dashboard — Authorization: Bearer header
// ---------------------------------------------------------------------------

test("GET /usage accepts Authorization Bearer token", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await request({
    port,
    pathname: "/usage",
    headers: { Authorization: "Bearer test-secret" },
  });
  assert.equal(res.statusCode, 200);
});

test("GET /dashboard accepts Authorization Bearer token", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await request({
    port,
    pathname: "/dashboard",
    headers: { Authorization: "Bearer test-secret" },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Usage Dashboard/);
});

// ---------------------------------------------------------------------------
// POST /music — auth and validation edge cases
// ---------------------------------------------------------------------------

test("POST /music rejects wrong secret with 401 and voice reply", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/music", { secret: "bad", message: "play something" });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).reply, "Authentication failed.");
});

test("POST /music rejects missing message with 400", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/music", { secret: "test-secret" });
  assert.equal(res.statusCode, 400);
});

test("POST /music rejects empty message with 400", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/music", { secret: "test-secret", message: "" });
  assert.equal(res.statusCode, 400);
});

test("POST /music rejects oversized body with 413", async (t) => {
  const { port } = await startServerFixture(t);
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "x".repeat(200),
  });
  assert.equal(res.statusCode, 413);
});

// ---------------------------------------------------------------------------
// POST /music — OpenClaw failure falls back to local query parser
// ---------------------------------------------------------------------------

test("POST /music falls back with stripped Korean filler when agent crashes", async (t) => {
  const { port } = await startServerWithCustomStub(
    t,
    `#!/bin/bash\nif [ "$1" = "models" ]; then exit 0; fi\nexit 1`
  );
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "뉴진스 ETA 틀어줘",
    session_id: "dev",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, "fallback");
  assert.equal(body.service, "apple_music");
  assert.doesNotMatch(body.query, /틀어줘/);
  assert.match(body.query, /ETA/);
});

test("POST /music falls back when agent returns plain text instead of JSON", async (t) => {
  const stub = `#!/bin/bash
if [ "$1" = "models" ]; then echo "openai-codex usage: stub quota"; exit 0; fi
if [ "$1" = "agent" ]; then
  printf '\\n{\\n  "payloads": [{"text": "Sure thing, I will play that music for you!"}],\\n  "meta": {"agentMeta": {"usage": {"input": 1, "output": 2, "cacheRead": 0, "total": 3}, "model": "stub-model"}}\\n}\\n'
  exit 0
fi
exit 1`;
  const { port } = await startServerWithCustomStub(t, stub);
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "play something relaxing",
    session_id: "dev",
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.source, "fallback");
  assert.ok(body.query.length > 0);
});

// ---------------------------------------------------------------------------
// POST /music — MUSIC_SERVICE normalization
// ---------------------------------------------------------------------------

test("POST /music normalizes 애플뮤직 → apple_music", async (t) => {
  const { port } = await startServerFixture(t, { MUSIC_SERVICE: "애플뮤직" });
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "play BTS",
    session_id: "dev",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).service, "apple_music");
});

test("POST /music normalizes 멜론 → melon", async (t) => {
  const { port } = await startServerFixture(t, { MUSIC_SERVICE: "멜론" });
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "play BTS",
    session_id: "dev",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).service, "melon");
});

test("POST /music defaults to apple_music for unknown MUSIC_SERVICE value", async (t) => {
  const { port } = await startServerFixture(t, { MUSIC_SERVICE: "spotify" });
  const res = await postJson(port, "/music", {
    secret: "test-secret",
    message: "play BTS",
    session_id: "dev",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).service, "apple_music");
});

// ---------------------------------------------------------------------------
// generate-shortcut.js — content and error handling
// ---------------------------------------------------------------------------

test("generate-shortcut creates AskOpenClaw.shortcut with /ask URL and secret embedded", async (t) => {
  const fixtureDir = makeTempDir("openclaw-ask-shortcut-smoke-");
  const stubDir = path.join(fixtureDir, "bin");

  fs.mkdirSync(stubDir, { recursive: true });
  copyFiles(fixtureDir, ["generate-shortcut.js"]);
  fs.writeFileSync(path.join(fixtureDir, ".tunnel-url"), "https://siri.example\n");
  fs.writeFileSync(path.join(fixtureDir, ".secret"), "my-test-secret\n");

  writeExecutable(
    path.join(stubDir, "shortcuts"),
    `#!/bin/bash
input=""; output=""
while [ "$#" -gt 0 ]; do
  case "$1" in --input) input="$2"; shift 2;; --output) output="$2"; shift 2;; *) shift;; esac
done
cp "$input" "$output"`
  );

  const child = spawnWithOutput(process.execPath, ["generate-shortcut.js"], {
    cwd: fixtureDir,
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 0, child.getOutput());
  assert.ok(fs.existsSync(path.join(fixtureDir, "AskOpenClaw.shortcut")));

  const xml = execFileSync(
    "plutil",
    ["-convert", "xml1", "-o", "-", path.join(fixtureDir, "AskOpenClaw-unsigned.shortcut")],
    { encoding: "utf8" }
  );

  assert.match(xml, /https:\/\/siri\.example\/ask/);
  assert.match(xml, /my-test-secret/);
  assert.match(xml, /<string>session_id<\/string>/);
  assert.match(xml, /is\.workflow\.actions\.ask/);
  assert.match(xml, /is\.workflow\.actions\.speaktext/);
});

test("generate-shortcut exits 1 with error when .tunnel-url is missing", async (t) => {
  const fixtureDir = makeTempDir("openclaw-shortcut-nourl-smoke-");
  fs.mkdirSync(fixtureDir, { recursive: true });
  copyFiles(fixtureDir, ["generate-shortcut.js"]);
  fs.writeFileSync(path.join(fixtureDir, ".secret"), "test-secret\n");

  const child = spawnWithOutput(process.execPath, ["generate-shortcut.js"], { cwd: fixtureDir });
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 1);
  assert.match(child.getOutput(), /\.tunnel-url/);
});

test("generate-shortcut exits 1 with error when .secret is missing", async (t) => {
  const fixtureDir = makeTempDir("openclaw-shortcut-nosecret-smoke-");
  fs.mkdirSync(fixtureDir, { recursive: true });
  copyFiles(fixtureDir, ["generate-shortcut.js"]);
  fs.writeFileSync(path.join(fixtureDir, ".tunnel-url"), "https://siri.example\n");

  const child = spawnWithOutput(process.execPath, ["generate-shortcut.js"], { cwd: fixtureDir });
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 1);
  assert.match(child.getOutput(), /\.secret/);
});

// ---------------------------------------------------------------------------
// generate-music-shortcut.js — skips when MUSIC_SERVICE=melon
// ---------------------------------------------------------------------------

test("generate-music-shortcut skips file creation when MUSIC_SERVICE=melon", async (t) => {
  const fixtureDir = makeTempDir("openclaw-music-melon-skip-smoke-");

  fs.mkdirSync(fixtureDir, { recursive: true });
  copyFiles(fixtureDir, ["generate-music-shortcut.js"]);
  fs.writeFileSync(path.join(fixtureDir, ".tunnel-url"), "https://siri.example\n");
  fs.writeFileSync(path.join(fixtureDir, ".secret"), "test-secret\n");
  fs.writeFileSync(path.join(fixtureDir, ".env"), "MUSIC_SERVICE=melon\n");

  const child = spawnWithOutput(process.execPath, ["generate-music-shortcut.js"], {
    cwd: fixtureDir,
  });
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 0, child.getOutput());
  assert.equal(fs.existsSync(path.join(fixtureDir, "PlayOpenClawMusic.shortcut")), false);
  assert.match(child.getOutput(), /melon/i);
});

// ---------------------------------------------------------------------------
// install-launchagent.sh — plist creation and uninstall
// ---------------------------------------------------------------------------

test("install-launchagent.sh writes plist with correct label and bridge script path", async (t) => {
  const fixtureDir = makeTempDir("openclaw-launchagent-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const launchAgentsDir = path.join(fixtureDir, "Library", "LaunchAgents");
  const launchctlLog = path.join(fixtureDir, "launchctl.log");

  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  copyFiles(fixtureDir, ["install-launchagent.sh", "siri-bridge.sh"]);
  fs.writeFileSync(path.join(fixtureDir, ".secret"), "test-secret\n");

  for (const cmd of ["node", "cloudflared", "openclaw"]) {
    writeExecutable(path.join(stubDir, cmd), `#!/bin/bash\nexit 0`);
  }
  // sleep stub: exit immediately so install doesn't take 3 seconds
  writeExecutable(path.join(stubDir, "sleep"), `#!/bin/bash\nexit 0`);
  // launchctl stub: log calls; exit 0 for all so install sees RUNNING
  writeExecutable(
    path.join(stubDir, "launchctl"),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> "${launchctlLog}"\nexit 0`
  );

  const child = spawnWithOutput("/bin/bash", [path.join(fixtureDir, "install-launchagent.sh")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: fixtureDir,
    },
  });
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 0, child.getOutput());

  const plistPath = path.join(launchAgentsDir, "com.openclaw.siri-bridge.plist");
  assert.ok(fs.existsSync(plistPath), "plist should be written");

  const plistContent = fs.readFileSync(plistPath, "utf8");
  assert.match(plistContent, /com\.openclaw\.siri-bridge/);
  assert.match(plistContent, /siri-bridge\.sh/);
  assert.match(plistContent, /<true\/>/); // RunAtLoad
});

test("install-launchagent.sh uninstall removes the plist", async (t) => {
  const fixtureDir = makeTempDir("openclaw-launchagent-uninstall-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const launchAgentsDir = path.join(fixtureDir, "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, "com.openclaw.siri-bridge.plist");

  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  copyFiles(fixtureDir, ["install-launchagent.sh"]);
  fs.writeFileSync(plistPath, "<plist>placeholder</plist>\n");

  writeExecutable(path.join(stubDir, "launchctl"), `#!/bin/bash\nexit 0`);

  const child = spawnWithOutput(
    "/bin/bash",
    [path.join(fixtureDir, "install-launchagent.sh"), "uninstall"],
    {
      cwd: fixtureDir,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        HOME: fixtureDir,
      },
    }
  );
  const [exitCode] = await once(child, "exit");
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

  assert.equal(exitCode, 0, child.getOutput());
  assert.equal(fs.existsSync(plistPath), false, "plist should be removed after uninstall");
  assert.match(child.getOutput(), /removed/i);
});

// ---------------------------------------------------------------------------
// siri-bridge.sh smoke: server startup failure stops before tunnel
// ---------------------------------------------------------------------------

test("siri-bridge.sh smoke: server startup failure stops before tunnel", async (t) => {
  const fixtureDir = makeTempDir("openclaw-bridge-smoke-");
  const stubDir = path.join(fixtureDir, "bin");
  const tunnelArgsFile = path.join(fixtureDir, "cloudflared.args");
  const bridgeLog = path.join(fixtureDir, "logs", "bridge.log");

  fs.mkdirSync(stubDir, { recursive: true });
  copyFiles(fixtureDir, ["siri-bridge.sh"]);

  writeExecutable(
    path.join(stubDir, "node"),
    `#!/bin/bash
exit 1
`
  );
  writeExecutable(
    path.join(stubDir, "cloudflared"),
    `#!/bin/bash
printf '%s\\n' "$@" > "${tunnelArgsFile}"
exit 0
`
  );
  writeExecutable(
    path.join(stubDir, "openclaw"),
    `#!/bin/bash
exit 0
`
  );
  writeExecutable(
    path.join(stubDir, "osascript"),
    `#!/bin/bash
exit 0
`
  );

  const child = spawnWithOutput("/bin/bash", [path.join(fixtureDir, "siri-bridge.sh")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      API_SECRET: "test-secret",
      PORT: "4570",
    },
  });

  const [exitCode] = await once(child, "exit");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  assert.equal(exitCode, 1, child.getOutput());
  assert.equal(fs.existsSync(tunnelArgsFile), false, child.getOutput());
  assert.match(fs.readFileSync(bridgeLog, "utf8"), /ERROR: Server failed to start; not starting tunnel\./);
});

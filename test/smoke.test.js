const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

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

async function startServerFixture(t) {
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

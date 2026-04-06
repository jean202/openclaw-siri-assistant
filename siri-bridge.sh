#!/bin/bash
# OpenClaw Siri Bridge — Background Daemon
# Manages HTTP server + cloudflared tunnel, writes tunnel URL to file

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Dependency check
LOG_EARLY="$DIR/logs/bridge.log"
mkdir -p "$DIR/logs"
missing=0
for cmd in node cloudflared openclaw; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[$(date)] ERROR: '$cmd' not found in PATH" >> "$LOG_EARLY"
    missing=1
  fi
done
[ $missing -eq 1 ] && exit 1

export PORT="${PORT:-3456}"
export API_SECRET="$(cat .secret)"
export TIMEOUT_SEC="${TIMEOUT_SEC:-120}"

TUNNEL_URL_FILE="$DIR/.tunnel-url"
LOG_FILE="$DIR/logs/bridge.log"
TUNNEL_LOG="$DIR/logs/tunnel.log"
TUNNEL_CHECK_INTERVAL=30
mkdir -p "$DIR/logs"

SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null
  [ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

start_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null
  > "$TUNNEL_LOG"
  cloudflared tunnel --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "[$(date)] Tunnel process started (PID: $TUNNEL_PID)" >> "$LOG_FILE"

  for i in $(seq 1 30); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$URL" ]; then
      echo "$URL" > "$TUNNEL_URL_FILE"
      echo "[$(date)] Tunnel URL: $URL" >> "$LOG_FILE"
      return 0
    fi
    sleep 1
  done
  echo "[$(date)] WARNING: Tunnel URL not detected within 30s" >> "$LOG_FILE"
  return 1
}

# Start HTTP server
node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
sleep 2

# Start cloudflared tunnel
start_tunnel

# Monitor loop: restart tunnel or server if they die
while true; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[$(date)] Server process died, restarting..." >> "$LOG_FILE"
    node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    sleep 2
  fi

  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "[$(date)] Tunnel process died, restarting..." >> "$LOG_FILE"
    sleep 3
    start_tunnel
  fi

  sleep $TUNNEL_CHECK_INTERVAL
done

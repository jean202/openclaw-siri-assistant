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

# Load .env if present
[ -f "$DIR/.env" ] && set -a && . "$DIR/.env" && set +a

export PORT="${PORT:-3456}"
export API_SECRET="${API_SECRET:-$(cat .secret 2>/dev/null)}"
export TIMEOUT_SEC="${TIMEOUT_SEC:-120}"

if [ -z "$API_SECRET" ]; then
  echo "[$(date)] ERROR: No API_SECRET set and .secret file not found" >> "$LOG_EARLY"
  exit 1
fi

TUNNEL_URL_FILE="$DIR/.tunnel-url"
LOG_FILE="$DIR/logs/bridge.log"
TUNNEL_LOG="$DIR/logs/tunnel.log"
TUNNEL_CHECK_INTERVAL=30
mkdir -p "$DIR/logs"

OLD_TUNNEL_URL=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo "")
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

  if [ -n "$TUNNEL_NAME" ]; then
    cloudflared tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    echo "[$(date)] Named tunnel '$TUNNEL_NAME' started (PID: $TUNNEL_PID)" >> "$LOG_FILE"

    if [ -n "$TUNNEL_HOSTNAME" ]; then
      echo "https://$TUNNEL_HOSTNAME" > "$TUNNEL_URL_FILE"
      echo "[$(date)] Tunnel URL: https://$TUNNEL_HOSTNAME (fixed)" >> "$LOG_FILE"
      return 0
    fi
    for i in $(seq 1 30); do
      if grep -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null; then
        echo "[$(date)] Named tunnel connected" >> "$LOG_FILE"
        return 0
      fi
      sleep 1
    done
  else
    cloudflared tunnel --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    echo "[$(date)] Ephemeral tunnel started (PID: $TUNNEL_PID)" >> "$LOG_FILE"

    for i in $(seq 1 30); do
      URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
      if [ -n "$URL" ]; then
        echo "$URL" > "$TUNNEL_URL_FILE"
        echo "[$(date)] Tunnel URL: $URL" >> "$LOG_FILE"
        return 0
      fi
      sleep 1
    done
  fi
  echo "[$(date)] WARNING: Tunnel URL not detected within 30s" >> "$LOG_FILE"
  return 1
}

regenerate_shortcut() {
  NEW_URL=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo "")
  if [ -n "$NEW_URL" ] && [ "$NEW_URL" != "$OLD_TUNNEL_URL" ]; then
    echo "[$(date)] Tunnel URL changed — regenerating shortcut..." >> "$LOG_FILE"
    node "$DIR/generate-shortcut.js" >> "$LOG_FILE" 2>&1
    OLD_TUNNEL_URL="$NEW_URL"
  fi
}

# Start HTTP server
node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
sleep 2

# Start cloudflared tunnel
start_tunnel
regenerate_shortcut

notify() {
  local title="$1" msg="$2"
  osascript -e "display notification \"$msg\" with title \"$title\"" 2>/dev/null || true
}

# Monitor loop: restart processes if they die, notify on failure
while true; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[$(date)] Server process died, restarting..." >> "$LOG_FILE"
    notify "OpenClaw Siri Bridge" "Server crashed — restarting..."
    node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    sleep 2
    if kill -0 $SERVER_PID 2>/dev/null; then
      notify "OpenClaw Siri Bridge" "Server restarted successfully."
    else
      notify "OpenClaw Siri Bridge" "Server failed to restart! Check logs."
    fi
  fi

  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "[$(date)] Tunnel process died, restarting..." >> "$LOG_FILE"
    notify "OpenClaw Siri Bridge" "Tunnel crashed — restarting..."
    sleep 3
    start_tunnel
    regenerate_shortcut
    if kill -0 $TUNNEL_PID 2>/dev/null; then
      notify "OpenClaw Siri Bridge" "Tunnel restarted. New URL: $(cat "$TUNNEL_URL_FILE" 2>/dev/null)"
    else
      notify "OpenClaw Siri Bridge" "Tunnel failed to restart! Check logs."
    fi
  fi

  sleep $TUNNEL_CHECK_INTERVAL
done

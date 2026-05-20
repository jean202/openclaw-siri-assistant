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
export CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

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

stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}

stop_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  TUNNEL_PID=""
}

cleanup() {
  stop_server
  stop_tunnel
  exit 0
}
trap cleanup INT TERM

start_server() {
  node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  sleep 2

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    SERVER_PID=""
    echo "[$(date)] ERROR: Server failed to start; not starting tunnel." >> "$LOG_FILE"
    return 1
  fi

  echo "[$(date)] HTTP server started on port $PORT (PID: $SERVER_PID)" >> "$LOG_FILE"
  return 0
}

resolve_tunnel_config() {
  local named_config="$HOME/.cloudflared/config-${TUNNEL_NAME}.yml"
  local default_config="$HOME/.cloudflared/config.yml"

  if [ -f "$named_config" ]; then
    echo "$named_config"
  elif [ -f "$default_config" ]; then
    echo "$default_config"
  fi
}

start_tunnel() {
  stop_tunnel
  > "$TUNNEL_LOG"

  if [ -n "$TUNNEL_NAME" ]; then
    local tunnel_config
    tunnel_config="$(resolve_tunnel_config)"

    if [ -n "$tunnel_config" ]; then
      echo "[$(date)] Using named tunnel config: $tunnel_config" >> "$LOG_FILE"
      cloudflared tunnel --config "$tunnel_config" run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    else
      if [ -n "$TUNNEL_HOSTNAME" ]; then
        echo "[$(date)] ERROR: No cloudflared config file found for named tunnel '$TUNNEL_NAME'" >> "$LOG_FILE"
        echo "[$(date)] Expected config: $HOME/.cloudflared/config-${TUNNEL_NAME}.yml" >> "$LOG_FILE"
        return 1
      fi
      echo "[$(date)] Using cloudflared default config discovery for named tunnel '$TUNNEL_NAME'" >> "$LOG_FILE"
      cloudflared tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    fi
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
    cloudflared tunnel --protocol "$CLOUDFLARED_PROTOCOL" --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    echo "[$(date)] Ephemeral tunnel started with protocol $CLOUDFLARED_PROTOCOL (PID: $TUNNEL_PID)" >> "$LOG_FILE"

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
    echo "[$(date)] Tunnel URL changed — regenerating shortcuts..." >> "$LOG_FILE"
    node "$DIR/generate-shortcut.js" >> "$LOG_FILE" 2>&1
    node "$DIR/generate-music-shortcut.js" >> "$LOG_FILE" 2>&1
    OLD_TUNNEL_URL="$NEW_URL"
  fi
}

# Start HTTP server
start_server || exit 1

# Start cloudflared tunnel
start_tunnel
regenerate_shortcut

notify() {
  local title="$1" msg="$2"
  osascript -e "display notification \"$msg\" with title \"$title\"" 2>/dev/null || true
}

# Monitor loop: restart processes if they die, notify on failure
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[$(date)] Server process died, restarting..." >> "$LOG_FILE"
    notify "OpenClaw Siri Bridge" "Server crashed — restarting..."
    if start_server; then
      notify "OpenClaw Siri Bridge" "Server restarted successfully."
    else
      notify "OpenClaw Siri Bridge" "Server failed to restart. Bridge is stopping."
      stop_tunnel
      exit 1
    fi
  fi

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
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

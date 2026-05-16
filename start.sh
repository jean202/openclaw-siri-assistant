#!/bin/bash
# OpenClaw Siri Assistant — Start Script
# Starts the HTTP bridge server + cloudflared tunnel

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Dependency check
missing=0
for cmd in node cloudflared openclaw; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH"
    missing=1
  fi
done
[ $missing -eq 1 ] && exit 1

# Load .env if present
[ -f "$DIR/.env" ] && set -a && . "$DIR/.env" && set +a

# Config (env vars from .env take precedence, then .secret, then generate)
export PORT="${PORT:-3456}"
export API_SECRET="${API_SECRET:-$(cat .secret 2>/dev/null || openssl rand -hex 24)}"
export TIMEOUT_SEC="${TIMEOUT_SEC:-120}"
export CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

# Save secret for reuse
echo "$API_SECRET" > .secret
chmod 600 .secret

echo "====================================="
echo " OpenClaw Siri Assistant"
echo "====================================="
echo ""

SERVER_PID=""
TUNNEL_PID=""
TUNNEL_LOG="$DIR/logs/tunnel.log"
TUNNEL_URL_FILE="$DIR/.tunnel-url"
mkdir -p "$DIR/logs"

stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}

stop_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  TUNNEL_PID=""
}

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  stop_server
  stop_tunnel
  exit 0
}
trap cleanup INT TERM

start_server() {
  echo "[1/2] Starting HTTP bridge server on port $PORT..."
  node server.js &
  SERVER_PID=$!
  sleep 2

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    SERVER_PID=""
    echo "ERROR: Server failed to start; tunnel will not be started."
    return 1
  fi

  return 0
}

# Save previous tunnel URL for change detection
OLD_TUNNEL_URL=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo "")

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

    # Named tunnel — fixed URL via cloudflared config
    echo "  Mode: Named tunnel ($TUNNEL_NAME)"
    if [ -n "$tunnel_config" ]; then
      echo "  Config: $tunnel_config"
      cloudflared tunnel --config "$tunnel_config" run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    else
      if [ -n "$TUNNEL_HOSTNAME" ]; then
        echo "  ERROR: No cloudflared config file found for named tunnel."
        echo "         Expected: $HOME/.cloudflared/config-${TUNNEL_NAME}.yml"
        return 1
      fi
      echo "  Config: cloudflared default discovery"
      cloudflared tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
    fi
    TUNNEL_PID=$!

    if [ -n "$TUNNEL_HOSTNAME" ]; then
      URL="https://$TUNNEL_HOSTNAME"
      echo "$URL" > "$TUNNEL_URL_FILE"
      echo "  Tunnel URL: $URL (fixed)"
      return 0
    fi
    # Wait for connection log if no hostname set
    for i in $(seq 1 30); do
      if grep -q 'Registered tunnel connection' "$TUNNEL_LOG" 2>/dev/null; then
        echo "  Named tunnel connected"
        return 0
      fi
      sleep 1
    done
    echo "  WARNING: Named tunnel connection not confirmed within 30s"
    return 1
  else
    # Ephemeral tunnel — random URL
    echo "  Mode: Ephemeral tunnel (URL changes on restart)"
    echo "  Protocol: $CLOUDFLARED_PROTOCOL"
    cloudflared tunnel --protocol "$CLOUDFLARED_PROTOCOL" --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    for i in $(seq 1 30); do
      URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
      if [ -n "$URL" ]; then
        echo "$URL" > "$TUNNEL_URL_FILE"
        echo "  Tunnel URL: $URL"
        return 0
      fi
      sleep 1
    done
    echo "  WARNING: Tunnel URL not detected within 30s"
    return 1
  fi
}

regenerate_shortcut() {
  NEW_URL=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo "")
  if [ -n "$NEW_URL" ] && [ "$NEW_URL" != "$OLD_TUNNEL_URL" ]; then
    echo ""
    echo "[*] Tunnel URL changed — regenerating Siri Shortcut..."
    node "$DIR/generate-shortcut.js" 2>/dev/null
    OLD_TUNNEL_URL="$NEW_URL"
    echo "    Done. Transfer AskOpenClaw.shortcut to iPhone."
  fi
}

# Start cloudflared tunnel
start_server || exit 1
echo "[2/2] Starting cloudflared tunnel..."
start_tunnel
regenerate_shortcut

echo ""
echo "====================================="
echo " Setup Complete!"
echo "====================================="
echo ""
echo "API_SECRET: $API_SECRET"
if [ -n "$TUNNEL_NAME" ]; then
  echo "Tunnel: Named ($TUNNEL_NAME) — URL is fixed across restarts"
else
  echo "Tunnel: Ephemeral — URL changes on restart"
  echo "Tip: Set TUNNEL_NAME in .env for a fixed URL"
fi
echo "Endpoint: $(cat "$TUNNEL_URL_FILE" 2>/dev/null)/ask"
echo ""
echo "Press Ctrl+C to stop everything."

notify() {
  osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null || true
}

# Monitor loop: restart processes if they die, notify on failure
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[$(date)] Server died, restarting..."
    notify "OpenClaw Siri Bridge" "Server crashed — restarting..."
    if ! start_server; then
      notify "OpenClaw Siri Bridge" "Server failed to restart. Stopping tunnel."
      cleanup
    fi
  fi

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "[$(date)] Tunnel died, restarting..."
    notify "OpenClaw Siri Bridge" "Tunnel crashed — restarting..."
    sleep 3
    start_tunnel
    regenerate_shortcut
  fi

  sleep 30
done

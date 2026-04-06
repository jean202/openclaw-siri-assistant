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

# Save secret for reuse
echo "$API_SECRET" > .secret
chmod 600 .secret

echo "====================================="
echo " OpenClaw Siri Assistant"
echo "====================================="
echo ""

# Start the HTTP bridge server
echo "[1/2] Starting HTTP bridge server on port $PORT..."
node server.js &
SERVER_PID=$!
sleep 2

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "ERROR: Server failed to start"
  exit 1
fi

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID $TUNNEL_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

TUNNEL_PID=""
TUNNEL_LOG="$DIR/logs/tunnel.log"
TUNNEL_URL_FILE="$DIR/.tunnel-url"
mkdir -p "$DIR/logs"

# Save previous tunnel URL for change detection
OLD_TUNNEL_URL=$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo "")

start_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null
  > "$TUNNEL_LOG"

  if [ -n "$TUNNEL_NAME" ]; then
    # Named tunnel — fixed URL via cloudflared config
    echo "  Mode: Named tunnel ($TUNNEL_NAME)"
    cloudflared tunnel run "$TUNNEL_NAME" > "$TUNNEL_LOG" 2>&1 &
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
    cloudflared tunnel --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
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

# Monitor loop: restart tunnel if it dies
while true; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[$(date)] Server died, restarting..."
    node server.js &
    SERVER_PID=$!
    sleep 2
  fi

  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "[$(date)] Tunnel died, restarting..."
    sleep 3
    start_tunnel
    regenerate_shortcut
  fi

  sleep 30
done

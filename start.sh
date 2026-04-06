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

# Config
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
mkdir -p "$DIR/logs"

start_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill $TUNNEL_PID 2>/dev/null
  > "$TUNNEL_LOG"
  cloudflared tunnel --url http://127.0.0.1:$PORT > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for i in $(seq 1 30); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$URL" ]; then
      echo ""
      echo "  Tunnel URL: $URL"
      return 0
    fi
    sleep 1
  done
  echo "  WARNING: Tunnel URL not detected within 30s"
  return 1
}

# Start cloudflared tunnel
echo "[2/2] Starting cloudflared tunnel..."
start_tunnel

echo ""
echo "====================================="
echo " Setup Complete!"
echo "====================================="
echo ""
echo "API_SECRET: $API_SECRET"
echo "Use the Tunnel URL + /ask in your Siri shortcut."
echo ""
echo "Press Ctrl+C to stop everything."
echo "(Tunnel auto-restarts if it drops)"

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
  fi

  sleep 30
done

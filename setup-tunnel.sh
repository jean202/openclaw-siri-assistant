#!/bin/bash
# Setup a named cloudflared tunnel for a fixed URL
# Usage: ./setup-tunnel.sh [tunnel-name] [hostname]
# Example: ./setup-tunnel.sh siri-assistant siri.yourdomain.com

set -e

TUNNEL_NAME="${1:-siri-assistant}"
HOSTNAME="${2:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3456}"

echo "=== Cloudflared Named Tunnel Setup ==="
echo ""

# Check cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared not found."
  echo "Install: brew install cloudflared"
  exit 1
fi

# Step 1: Login
echo "[1/3] Checking cloudflared authentication..."
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "  Opening browser for Cloudflare login..."
  cloudflared tunnel login
else
  echo "  Already authenticated."
fi

# Step 2: Create tunnel
echo ""
echo "[2/3] Creating tunnel '$TUNNEL_NAME'..."
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "  Tunnel '$TUNNEL_NAME' already exists."
else
  cloudflared tunnel create "$TUNNEL_NAME"
  echo "  Tunnel created."
fi

# Step 3: Configure
echo ""
echo "[3/3] Writing configuration..."

TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')

if [ -n "$HOSTNAME" ]; then
  # Create DNS route
  echo "  Setting up DNS route: $HOSTNAME -> tunnel"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>/dev/null || true

  # Write config
  mkdir -p "$HOME/.cloudflared"
  CONFIG_FILE="$HOME/.cloudflared/config-${TUNNEL_NAME}.yml"
  cat > "$CONFIG_FILE" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$PORT
  - service: http_status:404
YAML
  echo "  Wrote config: $CONFIG_FILE"

  # Update .env
  echo ""
  echo "  Add to your .env:"
  echo "    TUNNEL_NAME=$TUNNEL_NAME"
  echo "    TUNNEL_HOSTNAME=$HOSTNAME"
else
  echo "  No hostname specified. You can add DNS routing later:"
  echo "    cloudflared tunnel route dns $TUNNEL_NAME your.domain.com"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Tunnel ID: $TUNNEL_ID"
echo "Tunnel Name: $TUNNEL_NAME"
[ -n "$HOSTNAME" ] && echo "Hostname: https://$HOSTNAME"
[ -n "$HOSTNAME" ] && echo "Config File: $HOME/.cloudflared/config-${TUNNEL_NAME}.yml"
echo ""
echo "To use: Add these to your .env file:"
echo "  TUNNEL_NAME=$TUNNEL_NAME"
[ -n "$HOSTNAME" ] && echo "  TUNNEL_HOSTNAME=$HOSTNAME"
echo ""
echo "Then run: ./start.sh"

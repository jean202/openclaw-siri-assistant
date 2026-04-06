#!/bin/bash
# Install/uninstall macOS LaunchAgent for OpenClaw Siri Bridge
# Usage:
#   ./install-launchagent.sh          — install & start
#   ./install-launchagent.sh uninstall — stop & remove

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.openclaw.siri-bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
BRIDGE_SCRIPT="$DIR/siri-bridge.sh"

# --- Uninstall ---
if [ "${1:-}" = "uninstall" ]; then
  echo "Stopping and removing LaunchAgent..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Done. LaunchAgent removed."
  exit 0
fi

# --- Pre-flight checks ---
if [ ! -f "$DIR/.secret" ]; then
  echo "ERROR: .secret not found. Run ./start.sh once first to generate it."
  exit 1
fi

for cmd in node cloudflared openclaw; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH"
    exit 1
  fi
done

# --- Resolve binary paths (LaunchAgent needs absolute paths) ---
NODE_PATH=$(which node)
CLOUDFLARED_PATH=$(which cloudflared)
OPENCLAW_PATH=$(which openclaw)
BIN_DIR=$(dirname "$NODE_PATH")

# --- Stop existing if running ---
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# --- Write plist ---
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${BRIDGE_SCRIPT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${BIN_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${DIR}/logs/launchagent-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${DIR}/logs/launchagent-stderr.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

echo "=== OpenClaw Siri Bridge — LaunchAgent ==="
echo ""
echo "Plist written: $PLIST"
echo ""

# --- Load & start ---
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 2

# --- Verify ---
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Status: RUNNING"
else
  echo "Status: FAILED (check logs/launchagent-stderr.log)"
  exit 1
fi

echo ""
echo "The bridge will now start automatically on login."
echo ""
echo "Commands:"
echo "  Check status:  launchctl print gui/$(id -u)/$LABEL"
echo "  View logs:     tail -f $DIR/logs/bridge.log"
echo "  Stop:          launchctl bootout gui/$(id -u)/$LABEL"
echo "  Restart:       launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  Uninstall:     ./install-launchagent.sh uninstall"

#!/bin/bash
# Quick helper to show the current tunnel URL and secret
DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "=== OpenClaw Siri Bridge Status ==="
echo ""

URL=$(cat "$DIR/.tunnel-url" 2>/dev/null)
SECRET=$(cat "$DIR/.secret" 2>/dev/null)

if [ -z "$URL" ]; then
  echo "Tunnel URL: NOT FOUND (bridge may not be running)"
else
  echo "Tunnel URL: $URL"
  echo "Ask endpoint: $URL/ask"
fi
echo ""
echo "API Secret: $SECRET"
echo ""

# Health check
if [ -n "$URL" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Health: OK"
  else
    echo "Health: UNREACHABLE (HTTP $STATUS)"
  fi
fi
echo ""

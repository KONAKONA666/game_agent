#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# Install server deps if needed
if [ ! -d server/node_modules ]; then
  echo "[start] Installing server dependencies..."
  cd server && npm init -y 2>/dev/null && npm install express ws 2>/dev/null && cd ..
fi

echo ""
echo "  Starting top_down_arena_shooter_players_shoot_eac..."
echo "  Server: http://localhost:2567"
echo "  Open in browser to play!"
echo ""

node server/index.js

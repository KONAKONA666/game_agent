#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Island Coins ==="
echo ""

# Install server dependencies
echo "[1/2] Installing server dependencies..."
cd server && npm install --silent 2>/dev/null && cd ..
echo "      Done."

# Start game server
echo "[2/2] Starting game server..."
node server/index.js &
SERVER_PID=$!

sleep 1
echo ""
echo "  Ready! Open in two browser tabs:"
echo "  http://localhost:2567"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM

wait $SERVER_PID

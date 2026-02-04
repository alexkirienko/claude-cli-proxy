#!/bin/bash
# Start Claude CLI Proxy Server
# Run with: ./start.sh or add to systemd/crontab

cd "$(dirname "$0")"

# Kill any existing instance
pkill -f "node.*server.js.*8787" 2>/dev/null || true

# Start in background with nohup
nohup node server.js > proxy.log 2>&1 &
PID=$!

echo "Claude CLI Proxy started (PID: $PID)"
echo "Log: $(pwd)/proxy.log"
echo "URL: http://127.0.0.1:8787"

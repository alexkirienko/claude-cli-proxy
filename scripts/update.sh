#!/bin/bash
# Self-update claude-cli-proxy from GitHub
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "Checking for updates..."

# Fetch latest
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date ($(node -p 'require("./package.json").version'))"
  exit 0
fi

echo "Updating from $(git log --oneline -1 HEAD) to $(git log --oneline -1 origin/main)..."
git pull --ff-only origin main

NEW_VERSION=$(node -p 'require("./package.json").version')
echo "Updated to v${NEW_VERSION}"

# Restart service if running under systemd
if systemctl --user is-active claude-cli-proxy &>/dev/null; then
  echo "Restarting service..."
  systemctl --user restart claude-cli-proxy
  echo "Service restarted"
else
  echo "Note: Service not running under systemd. Restart manually."
fi

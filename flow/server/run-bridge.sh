#!/bin/bash
# Starts the bridge in the background. Called by the macOS helper (see install-mac.sh) after it has brought
# this folder up to date, so changes to how the bridge is started arrive with the update — no reinstall.
#   run-bridge.sh <path to node> <allowed page origins> <state folder>
cd "$(dirname "$0")" || exit 1
NODE="${1:-$(command -v node)}"
ORIGINS="${2:-}"
DIR="${3:-$HOME/.flow-bridge}"
mkdir -p "$DIR"
# Programs started from an app get a bare PATH; add the usual places so node, npm and the claude command are found.
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Install packages when they are missing or the list of them changed in an update.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund >> "$DIR/bridge.log" 2>&1 || true
fi
FLOW_ALLOWED_ORIGINS="$ORIGINS" nohup "$NODE" server.mjs >> "$DIR/bridge.log" 2>&1 &

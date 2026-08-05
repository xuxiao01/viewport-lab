#!/usr/bin/env bash

set -u

COMPONENT="${1:?缺少组件名称}"
REMOTE_ROOT="${VIEWPORT_LAB_REMOTE_ROOT:-/mnt/ai57/database/xuxiao/viewport-lab}"
NODE_DIR="$REMOTE_ROOT/runtime/node-v22.14.0-linux-x64"
CURRENT="$REMOTE_ROOT/current"
LOG_DIR="$REMOTE_ROOT/logs"

export PATH="$NODE_DIR/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$REMOTE_ROOT/playwright-browsers"
export FONTCONFIG_FILE="$REMOTE_ROOT/fontconfig/fonts.conf"
export XDG_CACHE_HOME="$REMOTE_ROOT/font-cache"
mkdir -p "$LOG_DIR"

while true; do
  cd "$CURRENT" || exit 1
  if [[ "$COMPONENT" == "server" ]]; then
    export SERVER_HOST="127.0.0.1"
    export SERVER_PORT="3002"
    node --env-file="$REMOTE_ROOT/config/.env" apps/server/dist/index.js \
      >>"$LOG_DIR/server.log" 2>&1
    EXIT_CODE=$?
    printf '%s server exited with code %s; restarting in 2 seconds\n' \
      "$(date -Is)" "$EXIT_CODE" >>"$LOG_DIR/server.log"
  elif [[ "$COMPONENT" == "web" ]]; then
    export VITE_SERVER_TARGET="http://127.0.0.1:3002"
    corepack pnpm --filter @viewport-lab/web exec vite preview \
      --host 0.0.0.0 \
      --port 5190 \
      --strictPort >>"$LOG_DIR/web.log" 2>&1
    EXIT_CODE=$?
    printf '%s web exited with code %s; restarting in 2 seconds\n' \
      "$(date -Is)" "$EXIT_CODE" >>"$LOG_DIR/web.log"
  else
    echo "未知组件：$COMPONENT" >&2
    exit 2
  fi
  sleep 2
done

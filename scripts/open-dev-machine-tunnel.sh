#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_HOST="${VIEWPORT_LAB_REMOTE_HOST:-xuxiao@10.2.41.57}"
REMOTE_PORT="${VIEWPORT_LAB_REMOTE_WEB_PORT:-5190}"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
LOCAL_PORT="${1:-${VIEWPORT_LAB_LOCAL_WEB_PORT:-5190}}"

if ! [[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || (( LOCAL_PORT < 1 || LOCAL_PORT > 65535 )); then
  echo "无效的本地端口：$LOCAL_PORT" >&2
  exit 2
fi

echo "正在建立 Viewport Lab SSH 隧道……"
echo "连接成功后访问：http://localhost:$LOCAL_PORT"
echo "按 Ctrl+C 关闭隧道。"

exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -N \
  -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
  "$REMOTE_HOST"

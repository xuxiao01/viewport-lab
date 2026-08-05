#!/usr/bin/env bash

set -Eeuo pipefail

ACTION="${1:-status}"
REMOTE_ROOT="${VIEWPORT_LAB_REMOTE_ROOT:-/mnt/ai57/database/xuxiao/viewport-lab}"
CURRENT="$REMOTE_ROOT/current"
SESSION_NAME="viewport-lab-xuxiao"

is_running() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

start_service() {
  if is_running; then
    echo "Viewport Lab 已在运行"
    return
  fi
  if [[ ! -x "$CURRENT/scripts/dev-machine-component.sh" ]]; then
    echo "当前 release 不完整：缺少组件启动脚本" >&2
    exit 1
  fi
  tmux new-session -d -s "$SESSION_NAME" -n server \
    "exec bash '$CURRENT/scripts/dev-machine-component.sh' server"
  tmux new-window -d -t "$SESSION_NAME" -n web \
    "exec bash '$CURRENT/scripts/dev-machine-component.sh' web"
  echo "Viewport Lab 已启动"
}

stop_service() {
  if is_running; then
    tmux kill-session -t "$SESSION_NAME"
    echo "Viewport Lab 已停止"
  else
    echo "Viewport Lab 未运行"
  fi
}

case "$ACTION" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    if is_running; then
      tmux list-windows -t "$SESSION_NAME"
      exit 0
    fi
    echo "Viewport Lab 未运行"
    exit 1
    ;;
  *)
    echo "用法：$0 {start|stop|restart|status}" >&2
    exit 2
    ;;
esac

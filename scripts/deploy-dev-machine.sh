#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

read_local_env_value() {
  local variable_name="$1"
  local value
  value="$(sed -n "s/^${variable_name}=//p" "$PROJECT_ROOT/.env" | tail -n 1)"
  printf '%s' "$value"
}

REMOTE_USER="${VIEWPORT_LAB_REMOTE_USER:-$(read_local_env_value VIEWPORT_LAB_REMOTE_USER)}"
REMOTE_HOST="${VIEWPORT_LAB_REMOTE_HOST:-${REMOTE_USER:+$REMOTE_USER@}10.2.41.57}"
REMOTE_PASSWORD="${VIEWPORT_LAB_REMOTE_PASSWORD:-$(read_local_env_value VIEWPORT_LAB_REMOTE_PASSWORD)}"
REMOTE_ROOT="${VIEWPORT_LAB_REMOTE_ROOT:-/mnt/ai57/database/xuxiao/viewport-lab}"
REMOTE_WEB_PORT="${VIEWPORT_LAB_REMOTE_WEB_PORT:-5190}"
REMOTE_SERVER_PORT="${VIEWPORT_LAB_REMOTE_SERVER_PORT:-3002}"
KEEP_RELEASES="${VIEWPORT_LAB_KEEP_RELEASES:-5}"
PROJECT_FONT_CACHE_DIR="$PROJECT_ROOT/.deploy-cache/fonts"
PROJECT_CJK_FONT_FILE="$PROJECT_FONT_CACHE_DIR/NotoSansCJKsc-Regular.otf"
PROJECT_CJK_FONT_URL="${VIEWPORT_LAB_CJK_FONT_URL:-https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf}"
PROJECT_EMOJI_FONT_FILE="$PROJECT_FONT_CACHE_DIR/NotoColorEmoji.ttf"
PROJECT_EMOJI_FONT_URL="${VIEWPORT_LAB_EMOJI_FONT_URL:-https://raw.githubusercontent.com/googlefonts/noto-emoji/main/fonts/NotoColorEmoji.ttf}"

SYNC_DATA=0
FORCE=0
SKIP_CHECKS=0
SERVICE_STOPPED=0
DEPLOY_SUCCEEDED=0
PREVIOUS_RELEASE=""
SSH_TEMP_DIR=""
SSH_CONTROL_PATH=""
SSH_ASKPASS_FILE=""

usage() {
  cat <<'EOF'
用法：pnpm deploy:dev-machine -- [选项]

选项：
  --sync-data   使用本地 data 精确镜像远端 data，并备份被替换或删除的文件
  --force       即使存在等待或运行中的任务，也终止任务并继续部署
  --skip-checks 跳过本地 typecheck、lint、server test 和 build
  -h, --help    显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      ;;
    --sync-data)
      SYNC_DATA=1
      ;;
    --force)
      FORCE=1
      ;;
    --skip-checks)
      SKIP_CHECKS=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

for command_name in ssh rsync git node pnpm curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少本地命令：$command_name" >&2
    exit 1
  fi
done

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
  echo "缺少 $PROJECT_ROOT/.env，无法配置远端 AI 网关。" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

ensure_local_font() {
  local output_file="$1"
  local source_url="$2"
  local display_name="$3"
  if [[ -s "$output_file" ]]; then
    return
  fi

  mkdir -p "$PROJECT_FONT_CACHE_DIR"
  local download_file
  download_file="$(mktemp "$PROJECT_FONT_CACHE_DIR/.font-download.XXXXXX")"

  echo "==> 下载项目字体到本机缓存：$display_name"
  if ! curl --fail --location --retry 3 --retry-delay 2 \
    --connect-timeout 15 --max-time 120 \
    "$source_url" \
    --output "$download_file"; then
    rm -f "$download_file"
    return 1
  fi
  if [[ ! -s "$download_file" ]]; then
    echo "字体下载结果为空：$source_url" >&2
    rm -f "$download_file"
    return 1
  fi
  mv "$download_file" "$output_file"
}

ensure_local_font "$PROJECT_CJK_FONT_FILE" "$PROJECT_CJK_FONT_URL" "Noto Sans CJK SC"
ensure_local_font "$PROJECT_EMOJI_FONT_FILE" "$PROJECT_EMOJI_FONT_URL" "Noto Color Emoji"

if [[ "$SKIP_CHECKS" -eq 0 ]]; then
  echo "==> 运行本地发布前检查"
  pnpm typecheck
  pnpm lint
  pnpm --filter @viewport-lab/server test
  pnpm build
  git diff --check
fi

GIT_SHA="$(git rev-parse --short HEAD)"
DIRTY_SUFFIX=""
if [[ -n "$(git status --porcelain)" ]]; then
  DIRTY_SUFFIX="-dirty"
fi
RELEASE_ID="$(date -u '+%Y%m%dT%H%M%SZ')-${GIT_SHA}${DIRTY_SUFFIX}"
REMOTE_RELEASE="$REMOTE_ROOT/releases/$RELEASE_ID"

SSH_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/viewport-lab-ssh.XXXXXX")"
SSH_CONTROL_PATH="$SSH_TEMP_DIR/control"
SSH_OPTIONS=(
  -o ControlMaster=auto
  -o "ControlPath=$SSH_CONTROL_PATH"
  -o ControlPersist=600
  -o StrictHostKeyChecking=accept-new
)

remote() {
  ssh "${SSH_OPTIONS[@]}" "$REMOTE_HOST" "$@"
}

restart_previous_service_on_failure() {
  if [[ "$DEPLOY_SUCCEEDED" -eq 0 && "$SERVICE_STOPPED" -eq 1 ]]; then
    echo "==> 部署未完成，尝试恢复原版本服务" >&2
    remote "if [ -x '$REMOTE_ROOT/current/scripts/dev-machine-service.sh' ]; then '$REMOTE_ROOT/current/scripts/dev-machine-service.sh' start; fi" || true
  fi
}

cleanup() {
  restart_previous_service_on_failure
  if [[ -n "$SSH_CONTROL_PATH" ]]; then
    ssh "${SSH_OPTIONS[@]}" -O exit "$REMOTE_HOST" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SSH_TEMP_DIR" && -d "$SSH_TEMP_DIR" ]]; then
    rm -rf "$SSH_TEMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -n "$REMOTE_PASSWORD" ]]; then
  SSH_ASKPASS_FILE="$(mktemp "$SSH_TEMP_DIR/askpass.XXXXXX")"
  chmod 700 "$SSH_ASKPASS_FILE"
  printf '%s\n' '#!/bin/sh' 'printf %s "$VIEWPORT_LAB_REMOTE_PASSWORD"' > "$SSH_ASKPASS_FILE"
  export VIEWPORT_LAB_REMOTE_PASSWORD="$REMOTE_PASSWORD"
  export SSH_ASKPASS="$SSH_ASKPASS_FILE"
  export SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-viewport-lab-deploy}"
fi

echo "==> 建立 SSH 复用连接"
ssh "${SSH_OPTIONS[@]}" -MNf "$REMOTE_HOST"

echo "==> 准备远端 release：$RELEASE_ID"
remote "mkdir -p '$REMOTE_RELEASE' '$REMOTE_ROOT/config' '$REMOTE_ROOT/data' '$REMOTE_ROOT/fonts' '$REMOTE_ROOT/logs' '$REMOTE_ROOT/backups' '$REMOTE_ROOT/releases'"

RSYNC_SSH="ssh -o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o StrictHostKeyChecking=accept-new"

echo "==> 同步项目私有字体到开发机"
rsync -a --partial -e "$RSYNC_SSH" \
  "$PROJECT_CJK_FONT_FILE" \
  "$REMOTE_HOST:$REMOTE_ROOT/fonts/NotoSansCJKsc-Regular.otf"
rsync -a --partial -e "$RSYNC_SSH" \
  "$PROJECT_EMOJI_FONT_FILE" \
  "$REMOTE_HOST:$REMOTE_ROOT/fonts/NotoColorEmoji.ttf"

rsync \
  -a \
  --delete \
  --partial \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='.cursor/' \
  --exclude='.playwright-cli/' \
  --exclude='node_modules/' \
  --exclude='.vite/' \
  --exclude='.env' \
  --exclude='data/' \
  --exclude='apps/data/' \
  --exclude='local-doc/' \
  --exclude='screenshots/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='*.tsbuildinfo' \
  -e "$RSYNC_SSH" \
  "$PROJECT_ROOT/" \
  "$REMOTE_HOST:$REMOTE_RELEASE/"

echo "==> 安全同步远端环境变量"
rsync -a -e "$RSYNC_SSH" "$PROJECT_ROOT/.env" "$REMOTE_HOST:$REMOTE_ROOT/config/.env.upload"
remote "umask 077; awk '!/^(SERVER_HOST|SERVER_PORT|VITE_SERVER_TARGET|VIEWPORT_LAB_REMOTE_USER|VIEWPORT_LAB_REMOTE_PASSWORD)=/' '$REMOTE_ROOT/config/.env.upload' > '$REMOTE_ROOT/config/.env.tmp'; printf '%s\n' 'SERVER_HOST=127.0.0.1' 'SERVER_PORT=$REMOTE_SERVER_PORT' 'VITE_SERVER_TARGET=http://127.0.0.1:$REMOTE_SERVER_PORT' >> '$REMOTE_ROOT/config/.env.tmp'; mv '$REMOTE_ROOT/config/.env.tmp' '$REMOTE_ROOT/config/.env'; rm -f '$REMOTE_ROOT/config/.env.upload'; chmod 600 '$REMOTE_ROOT/config/.env'"

echo "==> 安装运行时、依赖并构建候选 release"
remote "bash '$REMOTE_RELEASE/scripts/dev-machine-bootstrap.sh' '$REMOTE_ROOT' '$REMOTE_RELEASE'"
PREVIOUS_RELEASE="$(
  remote "target=\$(readlink -f '$REMOTE_ROOT/current' 2>/dev/null || true); case \"\$target\" in '$REMOTE_ROOT'/releases/*) printf '%s' \"\$target\" ;; esac"
)"

if ! remote "test -f '$REMOTE_ROOT/.data-initialized'"; then
  echo "==> 远端尚未初始化 data，本次执行首次全量同步"
  SYNC_DATA=1
fi

has_active_tasks() {
  remote "batches=\$(curl -fsS --max-time 3 'http://127.0.0.1:$REMOTE_SERVER_PORT/api/batches' 2>/dev/null || true); agents=\$(curl -fsS --max-time 3 'http://127.0.0.1:$REMOTE_SERVER_PORT/api/agent/runs' 2>/dev/null || true); printf '%s\n%s\n' \"\$batches\" \"\$agents\" | grep -Eq '\"status\":\"(queued|running|launching|awaiting_gateway|executing|capturing)\"'"
}

stop_current_service() {
  if remote "test -x '$REMOTE_ROOT/current/scripts/dev-machine-service.sh'"; then
    remote "'$REMOTE_ROOT/current/scripts/dev-machine-service.sh' stop"
    SERVICE_STOPPED=1
  fi
}

if has_active_tasks; then
  if [[ "$FORCE" -eq 0 ]]; then
    echo "开发机存在等待或运行中的检测任务，已中止发布。" >&2
    echo "确认可以终止后，请使用：pnpm deploy:dev-machine -- --force" >&2
    exit 1
  fi
  echo "==> --force 已启用，将终止当前活动任务"
fi

if [[ "$SYNC_DATA" -eq 1 ]]; then
  stop_current_service
  BACKUP_DIR="$REMOTE_ROOT/backups/data-$RELEASE_ID"
  remote "mkdir -p '$BACKUP_DIR'"
  echo "==> 精确同步 data（约 4.7GB，支持重新执行后继续传输）"
  rsync \
    -a \
    --delete \
    --partial \
    --progress \
    --backup \
    --backup-dir="$BACKUP_DIR" \
    --exclude='.DS_Store' \
    -e "$RSYNC_SSH" \
    "$PROJECT_ROOT/data/" \
    "$REMOTE_HOST:$REMOTE_ROOT/data/"
  remote "touch '$REMOTE_ROOT/.data-initialized'"
fi

echo "==> 核对 data 文件数量和总字节数"
LOCAL_DATA_STATS="$(
  node --input-type=commonjs - "$PROJECT_ROOT/data" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
let count = 0
let bytes = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(target)
    else if (entry.isFile()) {
      count += 1
      bytes += fs.statSync(target).size
    }
  }
}
walk(root)
process.stdout.write(`${count} ${bytes}`)
NODE
)"
REMOTE_DATA_STATS="$(remote "'$REMOTE_ROOT/runtime/node-v22.14.0-linux-x64/bin/node' --input-type=commonjs - '$REMOTE_ROOT/data'" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
let count = 0
let bytes = 0
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(target)
    else if (entry.isFile()) {
      count += 1
      bytes += fs.statSync(target).size
    }
  }
}
walk(root)
process.stdout.write(`${count} ${bytes}`)
NODE
)"
if [[ "$SYNC_DATA" -eq 1 && "$LOCAL_DATA_STATS" != "$REMOTE_DATA_STATS" ]]; then
  echo "data 校验失败：本地=${LOCAL_DATA_STATS}，远端=${REMOTE_DATA_STATS}" >&2
  exit 1
fi
echo "data：本地=${LOCAL_DATA_STATS}，远端=${REMOTE_DATA_STATS}"

if [[ "$SERVICE_STOPPED" -eq 0 ]]; then
  stop_current_service
fi

echo "==> 原子切换到新 release 并启动服务"
remote "bash '$REMOTE_RELEASE/scripts/dev-machine-activate.sh' '$REMOTE_ROOT' '$REMOTE_RELEASE' '$KEEP_RELEASES'"
SERVICE_STOPPED=0

echo "==> 等待健康检查"
HEALTHY=0
for _attempt in $(seq 1 30); do
  if remote "curl -fsS --max-time 2 'http://127.0.0.1:$REMOTE_SERVER_PORT/api/health' >/dev/null && curl -fsS --max-time 2 'http://127.0.0.1:$REMOTE_WEB_PORT/' >/dev/null"; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [[ "$HEALTHY" -ne 1 ]]; then
  echo "新版本健康检查失败，服务日志：" >&2
  remote "tail -n 80 '$REMOTE_ROOT/logs/server.log' '$REMOTE_ROOT/logs/web.log' 2>/dev/null" >&2 || true
  if [[ -n "$PREVIOUS_RELEASE" ]]; then
    echo "==> 自动恢复上一版本：$PREVIOUS_RELEASE" >&2
    remote "'$REMOTE_ROOT/current/scripts/dev-machine-service.sh' stop || true; ln -sfn '$PREVIOUS_RELEASE' '$REMOTE_ROOT/current'; '$REMOTE_ROOT/current/scripts/dev-machine-service.sh' start" || true
  else
    remote "'$REMOTE_ROOT/current/scripts/dev-machine-service.sh' stop || true" || true
  fi
  exit 1
fi

DEPLOY_SUCCEEDED=1
echo
echo "部署成功：$RELEASE_ID"
echo "服务端健康检查：http://127.0.0.1:$REMOTE_SERVER_PORT/api/health（开发机内部）"
echo "公司内网访问：http://10.2.41.57:$REMOTE_WEB_PORT"
echo "如内网策略尚未开放该端口，可临时执行 pnpm tunnel:dev-machine 访问。"

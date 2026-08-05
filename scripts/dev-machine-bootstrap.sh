#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_ROOT="${1:?缺少远端根目录}"
RELEASE_DIR="${2:?缺少 release 目录}"
NODE_VERSION="22.14.0"
PNPM_VERSION="10.13.1"
NODE_DIR="$REMOTE_ROOT/runtime/node-v$NODE_VERSION-linux-x64"
NODE_ARCHIVE="node-v$NODE_VERSION-linux-x64.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v$NODE_VERSION"
PROJECT_FONT_DIR="$REMOTE_ROOT/fonts"
PROJECT_FONT_CACHE_DIR="$REMOTE_ROOT/font-cache"
PROJECT_FONTCONFIG_DIR="$REMOTE_ROOT/fontconfig"
PROJECT_FONTCONFIG_FILE="$PROJECT_FONTCONFIG_DIR/fonts.conf"
PROJECT_CJK_FONT_FILE="$PROJECT_FONT_DIR/NotoSansCJKsc-Regular.otf"
PROJECT_EMOJI_FONT_FILE="$PROJECT_FONT_DIR/NotoColorEmoji.ttf"

mkdir -p \
  "$REMOTE_ROOT/runtime" \
  "$REMOTE_ROOT/data" \
  "$REMOTE_ROOT/playwright-browsers" \
  "$PROJECT_FONT_DIR" \
  "$PROJECT_FONT_CACHE_DIR" \
  "$PROJECT_FONTCONFIG_DIR" \
  "$REMOTE_ROOT/logs"

if ! command -v fc-cache >/dev/null 2>&1 || ! command -v fc-match >/dev/null 2>&1; then
  echo "开发机缺少 fontconfig（fc-cache / fc-match），无法为 Viewport Lab 配置项目私有中文字体。" >&2
  echo "请让管理员安装 fontconfig；字体文件本身不需要 sudo。" >&2
  exit 1
fi

if [[ ! -s "$PROJECT_CJK_FONT_FILE" ]]; then
  echo "缺少项目私有中文字体：$PROJECT_CJK_FONT_FILE" >&2
  echo "请使用 deploy-dev-machine.sh 发布；它会先在本机下载字体，再通过 rsync 上传开发机。" >&2
  exit 1
fi

if [[ ! -s "$PROJECT_EMOJI_FONT_FILE" ]]; then
  echo "缺少项目私有 Emoji 字体：$PROJECT_EMOJI_FONT_FILE" >&2
  echo "请使用 deploy-dev-machine.sh 发布；它会先在本机下载字体，再通过 rsync 上传开发机。" >&2
  exit 1
fi

cat > "$PROJECT_FONTCONFIG_FILE" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${PROJECT_FONT_DIR}</dir>
  <cachedir>${PROJECT_FONT_CACHE_DIR}</cachedir>
</fontconfig>
EOF

export FONTCONFIG_FILE="$PROJECT_FONTCONFIG_FILE"
export XDG_CACHE_HOME="$PROJECT_FONT_CACHE_DIR"
fc-cache -f "$PROJECT_FONT_DIR" >/dev/null
MATCHED_CJK_FONT="$(fc-match -f '%{family}' 'Noto Sans CJK SC' 2>/dev/null || true)"
if [[ "$MATCHED_CJK_FONT" != *"Noto Sans CJK"* ]]; then
  echo "项目私有中文字体未被 fontconfig 识别，当前匹配结果：${MATCHED_CJK_FONT:-无}" >&2
  exit 1
fi
MATCHED_EMOJI_FONT="$(fc-match -f '%{family}' 'Noto Color Emoji' 2>/dev/null || true)"
if [[ "$MATCHED_EMOJI_FONT" != *"Noto Color Emoji"* ]]; then
  echo "项目私有 Emoji 字体未被 fontconfig 识别，当前匹配结果：${MATCHED_EMOJI_FONT:-无}" >&2
  exit 1
fi
echo "==> 已启用项目私有字体：$MATCHED_CJK_FONT；$MATCHED_EMOJI_FONT"

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  DOWNLOAD_DIR="$(mktemp -d "$REMOTE_ROOT/runtime/node-download.XXXXXX")"
  trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
  curl -fsSL "$NODE_BASE_URL/$NODE_ARCHIVE" -o "$DOWNLOAD_DIR/$NODE_ARCHIVE"
  EXPECTED_SHA="$(curl -fsSL "$NODE_BASE_URL/SHASUMS256.txt" | awk -v archive="$NODE_ARCHIVE" '$2 == archive { print $1 }')"
  if [[ -z "$EXPECTED_SHA" ]]; then
    echo "无法取得 Node.js 校验值" >&2
    exit 1
  fi
  printf '%s  %s\n' "$EXPECTED_SHA" "$DOWNLOAD_DIR/$NODE_ARCHIVE" | sha256sum --check -
  tar -xJf "$DOWNLOAD_DIR/$NODE_ARCHIVE" -C "$REMOTE_ROOT/runtime"
  rm -rf "$DOWNLOAD_DIR"
  trap - EXIT
fi

export PATH="$NODE_DIR/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$REMOTE_ROOT/playwright-browsers"

corepack enable
corepack prepare "pnpm@$PNPM_VERSION" --activate

rm -rf "$RELEASE_DIR/data" "$RELEASE_DIR/.env"
ln -s "$REMOTE_ROOT/data" "$RELEASE_DIR/data"
ln -s "$REMOTE_ROOT/config/.env" "$RELEASE_DIR/.env"

cd "$RELEASE_DIR"
pnpm install --frozen-lockfile
pnpm build
node --input-type=module -e 'await import("./apps/server/dist/agent/prompts.js")'
pnpm --filter @viewport-lab/server exec playwright-cli install-browser chromium

CLI_SMOKE_SESSION="viewport-lab-cli-smoke-$$"
CLI_SMOKE_CONFIG="$(mktemp "$RELEASE_DIR/.playwright-cli-smoke-config.XXXXXX")"
cat > "$CLI_SMOKE_CONFIG" <<'EOF'
{
  "browser": {
    "browserName": "chromium",
    "isolated": true
  }
}
EOF
cleanup_cli_smoke() {
  pnpm --filter @viewport-lab/server exec playwright-cli -s="$CLI_SMOKE_SESSION" --json close \
    >/dev/null 2>&1 || true
  rm -f "$CLI_SMOKE_CONFIG"
}
trap cleanup_cli_smoke EXIT
pnpm --filter @viewport-lab/server exec playwright-cli -s="$CLI_SMOKE_SESSION" --json open \
  "--config=$CLI_SMOKE_CONFIG" about:blank \
  >/dev/null
pnpm --filter @viewport-lab/server exec playwright-cli -s="$CLI_SMOKE_SESSION" --json close \
  >/dev/null
rm -f "$CLI_SMOKE_CONFIG"
trap - EXIT

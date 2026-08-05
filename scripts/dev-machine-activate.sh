#!/usr/bin/env bash

set -Eeuo pipefail

REMOTE_ROOT="${1:?缺少远端根目录}"
RELEASE_DIR="${2:?缺少 release 目录}"
KEEP_RELEASES="${3:-5}"
CURRENT="$REMOTE_ROOT/current"
CRON_START="# viewport-lab-xuxiao start"
CRON_END="# viewport-lab-xuxiao end"

chmod +x "$RELEASE_DIR"/scripts/*.sh
ln -sfn "$RELEASE_DIR" "$CURRENT"

CRON_TEMP="$(mktemp)"
{
  (crontab -l 2>/dev/null || true) | awk -v start="$CRON_START" -v end="$CRON_END" '
    $0 == start { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  '
  echo "$CRON_START"
  echo "@reboot sleep 20 && '$CURRENT/scripts/dev-machine-service.sh' start >> '$REMOTE_ROOT/logs/cron.log' 2>&1"
  echo "$CRON_END"
} >"$CRON_TEMP"
crontab "$CRON_TEMP"
rm -f "$CRON_TEMP"

"$CURRENT/scripts/dev-machine-service.sh" start

CURRENT_REAL="$(readlink -f "$CURRENT")"
find "$REMOTE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk -v keep="$KEEP_RELEASES" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" ]] || continue
      [[ "$(readlink -f "$old_release")" != "$CURRENT_REAL" ]] || continue
      case "$old_release" in
        "$REMOTE_ROOT"/releases/*)
          rm -rf -- "$old_release"
          ;;
        *)
          echo "拒绝清理异常 release 路径：$old_release" >&2
          exit 1
          ;;
      esac
    done

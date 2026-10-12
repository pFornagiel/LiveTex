#!/usr/bin/env bash
# Opens an isolated Cursor IDE window (classic layout, not the Agents window)
# with a CDP port that Argent (scripts/argent.sh) and the cdp-*.mjs helpers drive.
# Defaults to opening the repository root; pass another folder to open that instead.
set -euo pipefail
PROFILE="${CURSOR_CDP_PROFILE:-$HOME/.config/Cursor-extdev}"
PORT="${CURSOR_CDP_PORT:-9222}"
TARGET="${1:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
exec cursor --classic --new-window \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  "$TARGET"

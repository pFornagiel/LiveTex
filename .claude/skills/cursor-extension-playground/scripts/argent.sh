#!/usr/bin/env bash
# Runs the pinned Argent CLI with telemetry off:  argent.sh run <tool> [flags]
# Uses npx so nothing is installed globally; the first call downloads the package.
set -euo pipefail
export DO_NOT_TRACK=1
# The tool-server reads this when it starts; 9222 is always probed anyway.
export ARGENT_CHROMIUM_PORTS="${CURSOR_CDP_PORT:-9222}"
exec npx -y --loglevel=error @swmansion/argent@0.28.0 "$@"

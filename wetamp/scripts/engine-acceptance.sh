#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/heavy-slot.sh"
cd "$SCRIPT_DIR/.."

if [[ "${1:-}" == --scenarios ]]; then
  for f in tests/scenarios/*.test.ts tests/engine-*.test.ts; do
    bun test --timeout 900000 "$f"
  done
  exit
fi

bun run type-check
heavy_exec bash "$0" --scenarios

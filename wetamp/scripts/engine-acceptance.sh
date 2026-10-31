#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/heavy-slot.sh"
cd "$SCRIPT_DIR/.."

if [[ "${1:-}" == --scenarios ]]; then
  shift
  files=(tests/scenarios/scenario-core.test.ts)
  if [[ "${1:-}" == --full ]]; then
    files=(tests/scenarios/*.test.ts tests/engine-*.test.ts)
  fi
  for f in "${files[@]}"; do
    bun test --timeout 900000 "$f"
  done
  exit
fi

bun run type-check
if [[ "${1:-}" == --full ]]; then
  heavy_exec bash "$0" --scenarios --full
else
  heavy_exec bash "$0" --scenarios
fi

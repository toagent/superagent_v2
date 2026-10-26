#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run type-check
for f in tests/scenarios/*.test.ts tests/engine-*.test.ts; do
  bun test --timeout 900000 "$f"
done

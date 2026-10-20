#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun run type-check
bun test --timeout 900000 tests/scenarios tests/engine-*.test.ts

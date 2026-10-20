#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test --timeout 120000 tests/cli.test.ts tests/land.test.ts tests/integration.test.ts tests/delivery-e2e.test.ts
bun run type-check

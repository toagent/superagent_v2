#!/bin/sh
set -eu

runner='../scripts/package-tests.ts'

if [ "$#" -gt 0 ]; then
  exec bun run "$runner" "$@"
fi

case "$(uname -s)" in
  Darwin) cpus=$(sysctl -n hw.ncpu) ;;
  Linux) cpus=$(getconf _NPROCESSORS_ONLN) ;;
  *) echo "wetamp test: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac
workers=$((cpus > 2 ? cpus - 2 : 1))
lock_file=${SA_HEAVY_LOCK_FILE:-/tmp/superagent-heavy-test.lock}

if [ "${SA_HEAVY_LOCK_HELD:-}" = 1 ]; then
  exec bun run "$runner" "--parallel=$workers" tests/ scripts/
fi

case "$(uname -s)" in
  Darwin)
    exec /usr/bin/lockf -k "$lock_file" env SA_HEAVY_LOCK_HELD=1 \
      bun run "$runner" "--parallel=$workers" tests/ scripts/
    ;;
  Linux)
    command -v flock >/dev/null 2>&1 || {
      echo 'wetamp test: flock is required on Linux' >&2
      exit 1
    }
    exec flock "$lock_file" env SA_HEAVY_LOCK_HELD=1 \
      bun run "$runner" "--parallel=$workers" tests/ scripts/
    ;;
esac

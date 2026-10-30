#!/bin/sh
set -eu

runner='../scripts/package-tests.ts'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/heavy-slot.sh"

if [ "$#" -gt 0 ]; then
  exec bun run "$runner" "$@"
fi

# This guards the supported entrypoint only; direct bun test remains observable by stall detection.
case "$PWD/" in
  */worktrees/sa/*)
    if [ "${SA_ACCEPTANCE:-}" != '1' ]; then
      echo '完整套件由验收运行；请用 bun run test <文件…> 聚焦' >&2
      exit 2
    fi
    ;;
esac

case "$(uname -s)" in
  Darwin) cpus=$(sysctl -n hw.ncpu) ;;
  Linux) cpus=$(getconf _NPROCESSORS_ONLN) ;;
  *) echo "wetamp test: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac
workers=$((cpus > 1 ? cpus / 2 : 1))
heavy_exec bun run "$runner" "--parallel=$workers" tests/ scripts/

#!/bin/sh
set -eu

runner='../scripts/package-tests.ts'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/heavy-slot.sh"

if [ "$#" -gt 0 ]; then
  exec bun run "$runner" "$@"
fi

# This guards the supported entrypoint only; direct bun test remains observable by stall detection.
has_engine_check_ancestor() {
  pid=$$
  while :; do
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || return 1
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    [ "$pid" -gt 1 ] || return 1
    ancestor_command=$(ps -ww -o command= -p "$pid" 2>/dev/null || true)
    case "$ancestor_command" in
      *'.archon/scripts/sa-check.ts'*) return 0 ;;
    esac
  done
}

case "$PWD/" in
  */worktrees/sa/*)
    if ! has_engine_check_ancestor; then
      echo '完整套件由引擎验收运行；请用 bun run test <文件…> 聚焦' >&2
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
# bun 1.4 ignores bunfig [test] timeout; only the CLI flag lifts the 5 s per-test default.
heavy_exec bun run "$runner" --timeout 30000 "--parallel=$workers" tests/ scripts/

#!/bin/sh
set -eu

runner='../scripts/package-tests.ts'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/heavy-slot.sh"

if [ "$#" -gt 0 ]; then
  exec bun run "$runner" "$@"
fi

case "$(uname -s)" in
  Darwin) cpus=$(sysctl -n hw.ncpu) ;;
  Linux) cpus=$(getconf _NPROCESSORS_ONLN) ;;
  *) echo "wetamp test: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac
workers=$((cpus > 2 ? cpus - 2 : 1))
heavy_exec bun run "$runner" "--parallel=$workers" tests/ scripts/

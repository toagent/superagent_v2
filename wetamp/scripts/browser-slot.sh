#!/bin/sh
set -eu

browser_locks='/tmp/superagent-browser-0.lock /tmp/superagent-browser-1.lock'

[ "$#" -gt 0 ] || { echo 'browser slot: command is required' >&2; exit 2; }
status_file=$(mktemp "${TMPDIR:-/tmp}/superagent-browser-slot.XXXXXX")
trap 'rm -f "$status_file"' EXIT HUP INT TERM
run_held='status_file=$1; shift; set +e; "$@"; status=$?; printf "%s\n" "$status" > "$status_file"'

while :; do
  for lock in $browser_locks; do
    : > "$status_file"
    case "$(uname -s)" in
      Darwin) /usr/bin/lockf -t 0 "$lock" sh -c "$run_held" sh "$status_file" "$@" && acquired=1 || acquired= ;;
      Linux) flock -E 75 -n "$lock" sh -c "$run_held" sh "$status_file" "$@" && acquired=1 || acquired= ;;
      *) echo "browser slot: unsupported platform $(uname -s)" >&2; exit 1 ;;
    esac
    if [ -n "$acquired" ]; then
      status=$(cat "$status_file")
      exit "${status:-1}"
    fi
  done
  sleep 1
done

#!/bin/sh
set -eu

browser_locks='/tmp/superagent-browser-0.lock /tmp/superagent-browser-1.lock'

[ "$#" -gt 0 ] || { echo 'browser slot: command is required' >&2; exit 2; }
status_file=$(mktemp "${TMPDIR:-/tmp}/superagent-browser-slot.XXXXXX")
runner_pid=
cleanup() { rm -f "$status_file"; }
signal_tree() (
  root=$1 signal=$2
  for child in $(ps -ax -o pid= -o ppid= | awk -v parent="$root" '$2 == parent { print $1 }'); do
    signal_tree "$child" "$signal"
  done
  kill -"$signal" "$root" 2>/dev/null || true
)
forward() {
  signal=$1 status=$2
  trap - HUP INT TERM
  [ -z "$runner_pid" ] || signal_tree "$runner_pid" "$signal"
  [ -z "$runner_pid" ] || wait "$runner_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'forward HUP 129' HUP
trap 'forward INT 130' INT
trap 'forward TERM 143' TERM
run_held='status_file=$1; shift
printf "acquired\n" > "$status_file"
set +e; "$@"; status=$?; set -e
printf "%s\n" "$status" >> "$status_file"
exit "$status"'

case "$(uname -s)" in
  Darwin) locker=/usr/bin/lockf ;;
  Linux) command -v flock >/dev/null 2>&1 || { echo 'browser slot: flock is required on Linux' >&2; exit 1; }; locker=flock ;;
  *) echo "browser slot: unsupported platform $(uname -s)" >&2; exit 1 ;;
esac

while :; do
  for lock in $browser_locks; do
    : > "$status_file"
    case "$locker" in
      /usr/bin/lockf) "$locker" -t 0 "$lock" sh -c "$run_held" sh "$status_file" "$@" & ;;
      flock) "$locker" -E 75 -n "$lock" sh -c "$run_held" sh "$status_file" "$@" & ;;
    esac
    runner_pid=$!
    set +e; wait "$runner_pid"; status=$?; set -e
    runner_pid=
    if [ "$(sed -n '1p' "$status_file")" = acquired ]; then
      command_status=$(sed -n '2p' "$status_file")
      exit "${command_status:-$status}"
    fi
    [ "$status" -eq 75 ] && continue
    echo "browser slot: lock failed for $lock (exit $status)" >&2
    exit "$status"
  done
  sleep 1
done

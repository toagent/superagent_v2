#!/bin/sh

heavy_lock_file=${SA_HEAVY_LOCK_FILE:-/tmp/superagent-heavy-test.lock}

heavy_holder() {
  holder=$heavy_lock_file.holder
  [ -f "$holder" ] || return 1
  IFS= read -r holder_pid_line < "$holder" || return 1
  holder_pid=${holder_pid_line#pid=}
  case "$holder_pid" in *[!0-9]*|'') return 1 ;; esac
  kill -0 "$holder_pid" 2>/dev/null || return 1
  tr '\n' ' ' < "$holder"
}

heavy_run_held='
  lock=$1
  shift
  holder=$lock.holder
  temporary=$holder.$$
  cleanup() {
    if [ -f "$holder" ] && IFS= read -r first < "$holder" && [ "$first" = "pid=$$" ]; then
      rm -f "$holder"
    fi
    rm -f "$temporary"
  }
  trap cleanup EXIT HUP INT TERM
  {
    printf "pid=%s\n" "$$"
    printf "command=%s\n" "$*"
    printf "cwd=%s\n" "$PWD"
    printf "started_at=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$temporary"
  mv "$temporary" "$holder"
  [ -z "${SA_HEAVY_READY_FILE:-}" ] || : > "$SA_HEAVY_READY_FILE"
  "$@"
  status=$?
  cleanup
  trap - EXIT HUP INT TERM
  exit "$status"
'

heavy_exec() {
  if [ "${SA_HEAVY_LOCK_HELD:-}" = 1 ]; then
    exec "$@"
  fi

  if [ -z "${SA_HEAVY_WAIT_TIMEOUT_SECONDS:-}" ] && [ -z "${SA_HEAVY_WAIT_LOG_SECONDS:-}" ] && [ -z "${SA_HEAVY_READY_FILE:-}" ]; then
    case "$(uname -s)" in
      Darwin) exec /usr/bin/lockf -k "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@" ;;
      Linux)
        command -v flock >/dev/null 2>&1 || {
          echo 'heavy slot: flock is required on Linux' >&2
          return 1
        }
        exec flock "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@"
        ;;
      *)
        echo "heavy slot: unsupported platform $(uname -s)" >&2
        return 1
        ;;
    esac
  fi

  reporter=
  if [ -n "${SA_HEAVY_WAIT_LOG_SECONDS:-}" ]; then
    reporter_cancel=${SA_HEAVY_READY_FILE:-$heavy_lock_file.reporter.$$}.cancel
    rm -f "$reporter_cancel"
    (
      elapsed=0
      limit=$((SA_HEAVY_WAIT_LOG_SECONDS * 10))
      while [ "$elapsed" -lt "$limit" ]; do
        [ ! -e "$reporter_cancel" ] || exit 0
        if [ -n "${SA_HEAVY_READY_FILE:-}" ] && [ -e "$SA_HEAVY_READY_FILE" ]; then
          exit 0
        fi
        sleep 0.1
        elapsed=$((elapsed + 1))
      done
      if [ -z "${SA_HEAVY_READY_FILE:-}" ] || [ ! -e "$SA_HEAVY_READY_FILE" ]; then
        current=$(heavy_holder 2>/dev/null || true)
        [ -z "$current" ] || printf 'heavy slot wait: holder %s\n' "$current" >&2
      fi
    ) &
    reporter=$!
  fi

  timeout=${SA_HEAVY_WAIT_TIMEOUT_SECONDS:-}
  case "$(uname -s)" in
    Darwin)
      if [ -n "$timeout" ]; then
        /usr/bin/lockf -k -t "$timeout" "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@"
      else
        /usr/bin/lockf -k "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@"
      fi
      status=$?
      ;;
    Linux)
      command -v flock >/dev/null 2>&1 || {
        echo 'heavy slot: flock is required on Linux' >&2
        return 1
      }
      if [ -n "$timeout" ]; then
        flock -E 75 -w "$timeout" "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@"
      else
        flock "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$@"
      fi
      status=$?
      ;;
    *)
      echo "heavy slot: unsupported platform $(uname -s)" >&2
      return 1
      ;;
  esac

  if [ -n "$reporter" ]; then
    : > "$reporter_cancel"
    wait "$reporter" 2>/dev/null || true
    rm -f "$reporter_cancel"
  fi
  if [ "$status" -eq 75 ] && [ -n "$timeout" ] && { [ -z "${SA_HEAVY_READY_FILE:-}" ] || [ ! -e "$SA_HEAVY_READY_FILE" ]; }; then
    current=$(heavy_holder 2>/dev/null || true)
    printf 'heavy_slot_wait_exhausted%s\n' "${current:+: holder $current}" >&2
    [ -z "${SA_HEAVY_WAIT_EXHAUSTED_FILE:-}" ] || : > "$SA_HEAVY_WAIT_EXHAUSTED_FILE"
  fi
  return "$status"
}

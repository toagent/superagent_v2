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

heavy_queue_register() {
  heavy_queue_dir=$heavy_lock_file.queue
  heavy_queue_file=$heavy_queue_dir/$$.json
  mkdir -p "$heavy_queue_dir"
  command=$(printf '%s' "$*" | sed 's/\\/\\\\/g; s/"/\\"/g')
  cwd=$(printf '%s' "$PWD" | sed 's/\\/\\\\/g; s/"/\\"/g')
  run=$(printf '%s' "${INPUTS_RUN:-${SA_RUN_ID:-}}" | sed 's/\\/\\\\/g; s/"/\\"/g')
  class=
  if [ "${SA_HEAVY_CLASS:-}" = background ]; then
    class=',"class":"background"'
  else
    : > "$heavy_queue_file.foreground"
  fi
  printf '{"pid":%s,"command":"%s","cwd":"%s","queued_at":"%s"%s%s}\n' \
    "$$" "$command" "$cwd" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${run:+,\"run\":\"$run\"}" "$class" > "$heavy_queue_file.tmp"
  mv "$heavy_queue_file.tmp" "$heavy_queue_file"
}

heavy_foreground_waiting() {
  for marker in "$heavy_lock_file.queue"/*.foreground; do
    [ -e "$marker" ] || continue
    pid=${marker##*/}
    pid=${pid%.json.foreground}
    case "$pid" in *[!0-9]*|'') rm -f "$marker"; continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then return 0; fi
    rm -f "$marker"
  done
  return 1
}

heavy_run_held='
  lock=$1
  queue=$2
  shift 2
  if [ "${SA_HEAVY_CLASS:-}" = background ]; then
    for marker in "$lock.queue"/*.foreground; do
      [ -e "$marker" ] || continue
      pid=${marker##*/}; pid=${pid%.json.foreground}
      case "$pid" in *[!0-9]*|"") rm -f "$marker"; continue ;; esac
      if kill -0 "$pid" 2>/dev/null; then exit 76; fi
      rm -f "$marker"
    done
  fi
  rm -f "$queue" "$queue.foreground"
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
  unset SA_HEAVY_CLASS SA_HEAVY_READY_FILE SA_ENGINE_TIMED_READY_FILE
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

  heavy_queue_register "$@"
  if [ "${SA_HEAVY_CLASS:-}" != background ] && [ -z "${SA_HEAVY_WAIT_TIMEOUT_SECONDS:-}" ] && [ -z "${SA_HEAVY_WAIT_LOG_SECONDS:-}" ] && [ -z "${SA_HEAVY_READY_FILE:-}" ]; then
    case "$(uname -s)" in
      Darwin) exec /usr/bin/lockf -k "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@" ;;
      Linux)
        command -v flock >/dev/null 2>&1 || {
          echo 'heavy slot: flock is required on Linux' >&2
          rm -f "$heavy_queue_file" "$heavy_queue_file.foreground"
          return 1
        }
        exec flock "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@"
        ;;
      *)
        echo "heavy slot: unsupported platform $(uname -s)" >&2
        rm -f "$heavy_queue_file" "$heavy_queue_file.foreground"
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
  while :; do
    if [ "${SA_HEAVY_CLASS:-}" = background ]; then
      while heavy_foreground_waiting; do sleep 0.1; done
    fi
    case "$(uname -s)" in
    Darwin)
      if [ -n "$timeout" ]; then
        if /usr/bin/lockf -k -t "$timeout" "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@"; then status=0; else status=$?; fi
      else
        if /usr/bin/lockf -k "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@"; then status=0; else status=$?; fi
      fi
      ;;
    Linux)
      command -v flock >/dev/null 2>&1 || {
        echo 'heavy slot: flock is required on Linux' >&2
        rm -f "$heavy_queue_file" "$heavy_queue_file.foreground"
        return 1
      }
      if [ -n "$timeout" ]; then
        if flock -E 75 -w "$timeout" "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@"; then status=0; else status=$?; fi
      else
        if flock "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 sh -c "$heavy_run_held" sh "$heavy_lock_file" "$heavy_queue_file" "$@"; then status=0; else status=$?; fi
      fi
      ;;
    *)
      echo "heavy slot: unsupported platform $(uname -s)" >&2
      rm -f "$heavy_queue_file" "$heavy_queue_file.foreground"
      return 1
      ;;
    esac
    [ "$status" -eq 76 ] || break
  done
  rm -f "$heavy_queue_file" "$heavy_queue_file.foreground"

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

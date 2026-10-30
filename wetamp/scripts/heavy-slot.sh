#!/bin/sh

heavy_lock_file=${SA_HEAVY_LOCK_FILE:-/tmp/superagent-heavy-test.lock}

heavy_exec() {
  if [ "${SA_HEAVY_LOCK_HELD:-}" = 1 ]; then
    exec "$@"
  fi

  case "$(uname -s)" in
    Darwin) exec /usr/bin/lockf -k "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 "$@" ;;
    Linux)
      command -v flock >/dev/null 2>&1 || {
        echo 'heavy slot: flock is required on Linux' >&2
        return 1
      }
      exec flock "$heavy_lock_file" env SA_HEAVY_LOCK_HELD=1 "$@"
      ;;
    *)
      echo "heavy slot: unsupported platform $(uname -s)" >&2
      return 1
      ;;
  esac
}

#!/bin/sh
set -eu
printf '%s\n' "$@" > "$HOME/args"
pwd -P > "$HOME/cwd"
printf '%s' "$FIXTURE_RUN" > "$HOME/env"
if [ "${FIXTURE_HANG:-}" = 1 ]; then
  /bin/sleep 60 &
  printf '%s\n' "$!" > "$HOME/child"
  printf '%s\n' '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"agent_response","text_delta":"ready"}}'
  wait
else
  cat "$FIXTURE_STREAM"
  if [ -n "${FIXTURE_STDERR:-}" ]; then cat "$FIXTURE_STDERR" >&2; fi
  if [ "${FIXTURE_TERMINATE:-}" = 1 ]; then kill -TERM "$$"; fi
  exit "$FIXTURE_EXIT"
fi

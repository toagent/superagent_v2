# Sourced by selftest.sh. Stop acknowledgements and diagnostics belong to the
# scratch home; failure/unknown/warnings preserve every tree, including --repo.
stop_selftest_run() {
  local id="$1" rc=0 out="$TMPH/cleanup-$1.json" err="$TMPH/cleanup-$1.err"
  "$A" workflow abandon "$id" --json >"$out" 2>"$err" || rc=$?
  if [ "$rc" != 0 ] || ! bun "$WETAMP/scripts/selftest-stop.ts" "$out"; then
    keep=1
    echo "selftest: stop unconfirmed for $id; diagnostics $out $err" >&2
  fi
}
cleanup() {
  if [ "${LAUNCH_INFLIGHT:-0}" = 1 ]; then
    keep=1; echo "selftest: launch outcome unknown; preserving $TMPH" >&2
  fi
  if [ -n "${ID:-}" ]; then stop_selftest_run "$ID"; fi
  if [ "$keep" != 1 ]; then drop "${BR:-}" "${WT:-}"; drop "${BR2:-}" "${WT2:-}"; fi
  if [ "$keep" = 1 ]; then echo "selftest: kept $TMPH" >&2; else rm -rf "$TMPH"; fi
}

#!/usr/bin/env bash
# 契约自检：sa-smoke detach → think 节点运行中 kill -9 → wait=owner_lost → superagent recover → 暂停在事件门 → signal → completed。
# 在临时 SUPERAGENT_HOME 里跑；通过后写调用方的 $SUPERAGENT_HOME/selftest.json。用法：selftest.sh [--repo <path>] [--timeout <s>] [--fake]
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
REAL_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
REPO="" TIMEOUT=300 FAKE=0 OWN_REPO=0
while [ $# -gt 0 ]; do
  case "$1" in --repo) REPO="$2"; shift 2;; --timeout) TIMEOUT="$2"; shift 2;; --fake) FAKE=1; shift;; *) echo "unknown arg $1" >&2; exit 64;; esac
done
TMPH="$(mktemp -d "${TMPDIR:-/tmp}/sa-selftest.XXXXXX")"
export SUPERAGENT_HOME="$TMPH" ARCHON_HOME="$TMPH/archon"
A="$WETAMP/bin/archon"
cleanup() {
  if [ -n "${ID:-}" ]; then "$A" workflow abandon "$ID" --json >/dev/null 2>&1 || true; fi
  if [ -n "${BR:-}" ] && [ "$OWN_REPO" = 0 ]; then
    [ -n "${WT:-}" ] && git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
    git -C "$REPO" branch -D "$BR" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPH"
}
trap cleanup EXIT
fail() { echo "selftest FAIL: $*" >&2; exit 1; }
field() { bun -e "import { lastJson } from '$WETAMP/src/archon.ts'; const d = lastJson(await Bun.stdin.text()); const v = ($1); console.log(v ?? '')"; }
ms() { bun -e 'console.log(Date.now())'; }

SA_SKIP_DOCTOR=1 "$WETAMP/scripts/install.sh" >/dev/null
if [ -z "$REPO" ]; then
  OWN_REPO=1; REPO="$TMPH/repo"
  git init -q -b main "$REPO"; echo selftest > "$REPO/README.md"
  git -C "$REPO" add README.md; git -C "$REPO" -c user.name=sa -c user.email=sa@localhost commit -qm init
  git clone -q --bare "$REPO" "$TMPH/origin.git"; git -C "$REPO" remote add origin "$TMPH/origin.git"; git -C "$REPO" fetch -q origin
fi
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
GEN="$TMPH/gen/selftest"; mkdir -p "$GEN"; cp -R "$WETAMP/templates/.archon" "$GEN/.archon"
if [ "$FAKE" = 1 ]; then
  sed -i.orig -e "s|^    prompt: .*|    bash: sleep 20; echo '{\"answer\":\"pong\"}'|" -e "/^    model: '@sa-coder'/d" "$GEN/.archon/workflows/sa-smoke/sa-smoke.yaml"
  rm "$GEN/.archon/workflows/sa-smoke/sa-smoke.yaml.orig"
fi
git -C "$GEN" init -q; git -C "$GEN" add -A; git -C "$GEN" -c user.name=sa -c user.email=sa@localhost commit -qm gen
"$A" validate workflows --cwd "$GEN" >/dev/null 2>&1 || fail "validate workflows"

BR="sa/selftest-$(date +%s)"
ACK="$("$A" workflow run sa-smoke --workflow-source "$GEN" --cwd "$REPO" --branch "$BR" --from "$BASE" --detach --json 2>/dev/null)"
ID="$(echo "$ACK" | field 'd?.runId')"; [ -n "$ID" ] || fail "run ack: $ACK"
get() { "$A" workflow get "$ID" --json --verbose 2>/dev/null; }

PID="" deadline=$((SECONDS + TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
  st="$(get | field "[d?.nodes?.find((n) => n.nodeId === 'think')?.state, d?.metadata?.execution_owner?.pid].join(' ')")"
  if [ "${st%% *}" = running ]; then PID="${st##* }"; break; fi
  sleep 1
done
[ -n "$PID" ] || fail "think node never ran"
WT="$(get | field 'd?.working_path')"
RSS_KB="$(ps -o rss= -p "$PID" | tr -d ' ')"
kill -9 "$PID"; T0="$(ms)"
R="$("$A" workflow wait "$ID" --json --timeout 30 2>/dev/null || true)"
[ "$(echo "$R" | field 'd?.result')" = owner_lost ] || fail "wait after kill: $R"
"$WETAMP/bin/superagent" recover "$ID" >/dev/null || fail "recover"
RECOVER_MS=$(( $(ms) - T0 ))

EVENT="" deadline=$((SECONDS + TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
  EVENT="$(get | field "d?.status === 'paused' ? d.metadata?.wait?.event + ' ' + d.metadata.wait.resumeAt : (d?.status === 'running' ? '' : 'BAD:' + d?.status)")"
  case "$EVENT" in sa.human.smoke*) break;; BAD:*) fail "run left running: $EVENT";; esac
  sleep 1
done
[ "${EVENT%% *}" = sa.human.smoke ] || fail "never paused at gate"
T1="$(ms)"
"$A" workflow signal "$ID" --event sa.human.smoke --resume-at "${EVENT##* }" --data '{"decision":"yes"}' --json >/dev/null 2>&1 || fail "signal"
R="$("$A" workflow wait "$ID" --json --timeout 120 2>/dev/null || true)"
[ "$(echo "$R" | field 'd?.attention?.status')" = completed ] || fail "after signal: $R"
SIGNAL_MS=$(( $(ms) - T1 ))
TRACE="$(get | field 'd?.output_root')/artifacts/runs/$ID/trace.txt"
[ "$(grep -c '^start' "$TRACE")" = 1 ] || fail "start node re-ran after recover"
grep -q 'event=sa.human.smoke' "$TRACE" || fail "finish node missing"
ID=""

mkdir -p "$REAL_HOME"
printf '{"ok":true,"at":"%s","fake":%s,"rss_kb":%s,"recover_ms":%s,"signal_ms":%s,"upstream":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([ "$FAKE" = 1 ] && echo true || echo false)" "$RSS_KB" "$RECOVER_MS" "$SIGNAL_MS" \
  "$(cat "$WETAMP/UPSTREAM")" | tee "$REAL_HOME/selftest.json"

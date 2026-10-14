#!/usr/bin/env bash
# 契约自检：真实 provider 正常完成（不注入故障）；确定性 sa-smoke detach → think 运行中 kill -9 → recover → 事件门 → completed；
# sa-abandon 暂停在事件门 → 原生 abandon 完整回执 → cancelled；清理不明则保留树。
# 另对 hooks/guard.cjs 喂两个 payload（元帅 31 行写入只提示、worker Read 凭据路径被拦截），结果记入 selftest.json 的 hooks 段。
# 在临时 SUPERAGENT_HOME 里跑；通过后写调用方的 $SUPERAGENT_HOME/selftest.json（--fake 写 selftest-fake.json），绑定运行边界、配置哈希与有效期。用法：selftest.sh [--repo <path>] [--timeout <s>] [--fake]
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
REAL_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
REPO="" TIMEOUT=300 FAKE=0 OWN_REPO=0
while [ $# -gt 0 ]; do
  case "$1" in --repo) REPO="$2"; shift 2;; --timeout) TIMEOUT="$2"; shift 2;; --fake) FAKE=1; shift;; *) echo "unknown arg $1" >&2; exit 64;; esac
done
# 回执绑定调用方的运行边界与配置：换到临时 home 之前算，拒绝脏运行代码
RECEIPT_KEY="$(SUPERAGENT_HOME="$REAL_HOME" ARCHON_HOME="${ARCHON_HOME:-$REAL_HOME/archon}" bun -e "import { configHash, gitHead, runtimeFingerprint } from '$WETAMP/src/config.ts'; console.log(JSON.stringify({ head: gitHead(), fingerprint: runtimeFingerprint(), config_hash: configHash() }))")"
TMPH="$(mktemp -d "${TMPDIR:-/tmp}/sa-selftest.XXXXXX")"
export SUPERAGENT_HOME="$TMPH" ARCHON_HOME="$TMPH/archon" XDG_STATE_HOME="$TMPH/state"
A="${SA_ARCHON_BIN:-$WETAMP/bin/archon}"
# 清理不加 --force、不用 branch -D：删不掉说明里面有东西，保留并报路径，整个临时目录也一起留下（worktree 在 $TMPH/archon 下）。
keep=0
drop() { # <branch> <worktree>
  if [ -n "$1" ] && [ "$OWN_REPO" = 0 ]; then
    if [ -n "$2" ] && [ -d "$2" ] && ! git -C "$REPO" worktree remove "$2" >&2; then keep=1; echo "selftest: kept worktree $2" >&2; fi
    if git -C "$REPO" show-ref -q --verify "refs/heads/$1" && ! git -C "$REPO" branch -d "$1" >/dev/null; then keep=1; echo "selftest: kept branch $1 in $REPO" >&2; fi
  fi
}
source "$WETAMP/scripts/selftest-cleanup.sh"
trap cleanup EXIT
get() { "$A" workflow get "$ID" --json --verbose 2>/dev/null; }
fail() { echo "selftest FAIL: $*" >&2; exit 1; }
field() { bun -e "import { lastJson } from '$WETAMP/src/archon.ts'; const d = lastJson(await Bun.stdin.text()); const v = ($1); console.log(v ?? '')"; }
ms() { bun -e 'console.log(Date.now())'; }

SA_LAUNCHD_DIR="$TMPH/LaunchAgents" SA_SKIP_DOCTOR=1 "$WETAMP/scripts/install.sh" >/dev/null
if [ -z "$REPO" ]; then
  OWN_REPO=1; REPO="$TMPH/repo"
  git init -q -b main "$REPO"; echo selftest > "$REPO/README.md"
  git -C "$REPO" add README.md; git -C "$REPO" -c user.name=sa -c user.email=sa@localhost commit -qm init
  git clone -q --bare "$REPO" "$TMPH/origin.git"; git -C "$REPO" remote add origin "$TMPH/origin.git"; git -C "$REPO" fetch -q origin
fi
BASE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
# hooks：元帅会话 31 行写入（*.md 豁免，故用 .txt）只得 G-1 advisory、不拦；worker Read 凭据路径被隐私底线拦截（只判定、不落盘到 repo）
hook() { # <SUPERAGENT_ROLE> <tool_name> <tool_input JSON> → 拒绝原因，无拒绝时为 systemMessage
  node -e 'process.stdout.write(JSON.stringify({hook_event_name: "PreToolUse", session_id: "selftest", cwd: process.argv[1], tool_name: process.argv[2], tool_input: JSON.parse(process.argv[3])}))' "$REPO" "$2" "$3" \
    | env -u AI_DISPATCH_ROLE -u TWIN_AGENT_REMOTE -u SUPERAGENT_ALLOW_COMMANDER_WRITE SUPERAGENT_ROLE="$1" node "$WETAMP/hooks/guard.cjs" claude \
    | node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => { const d = s ? JSON.parse(s) : {}; console.log(d.hookSpecificOutput?.permissionDecisionReason ?? d.systemMessage ?? "") })'
}
G1="$(hook '' Edit "$(node -e 'console.log(JSON.stringify({file_path: process.argv[1], old_string: "selftest", new_string: "x\n".repeat(31)}))' "$REPO/selftest.txt")")"
case "$G1" in "SUPERAGENT advisory G-1:"*) ;; *) fail "hooks: commander 31-line edit not advised (or denied): $G1";; esac
PRIVACY="$(hook worker Read '{"file_path":"~/.ssh/id_rsa"}')"
case "$PRIVACY" in 已拦截：*) ;; *) fail "hooks: worker credential Read not denied: $PRIVACY";; esac
# 工作流内联在此（不进 templates/：生成器只复制 commands/ 与 scripts/）。先以真实 think 节点 validate：
# 复测 install.sh 写入的 config.yaml aliases 键（§2.4）；--fake 再换成 bash 桩。
GEN="$TMPH/gen/selftest" WF="$TMPH/gen/selftest/.archon/workflows/sa-smoke"; mkdir -p "$WF"
smoke() {
  cat > "$WF/sa-smoke.yaml" <<YAML
name: sa-smoke
description: superagent selftest - detach, kill -9, recover, durable event gate, signal
nodes:
  - id: start
    bash: |
      echo "start \$(date +%s)" >> "\$ARTIFACTS_DIR/trace.txt"
      printf '{"ts":"%s"}\n' "\$(date +%s)"
    output_format: { type: object, properties: { ts: { type: string } }, required: [ts] }
  - id: think
$1
    output_format: { type: object, properties: { answer: { type: string } }, required: [answer] }
    depends_on: [start]
  - id: gate
    wait: { event: sa.human.smoke, deadline_ms: 900000 }
    depends_on: [think]
  - id: finish
    bash: |
      ts=\$start.output.ts
      ev=\$gate.output.event
      echo "finish prev_ts=\$ts event=\$ev" >> "\$ARTIFACTS_DIR/trace.txt"
      echo done
    when: "\$gate.output.status == 'satisfied'"
    depends_on: [gate]
YAML
  git -C "$GEN" add -A; git -C "$GEN" -c user.name=sa -c user.email=sa@localhost commit -qm "${2}"
  "$A" validate workflows sa-smoke --cwd "$GEN" >/dev/null 2>&1 || fail "validate workflows (${2})"
}
# 等 run 停在事件门 $1，EVENT=<event> <resumeAt>
await_gate() {
  EVENT="" deadline=$((SECONDS + TIMEOUT))
  while [ $SECONDS -lt $deadline ]; do
    EVENT="$(get | field "d?.status === 'paused' ? d.metadata?.wait?.event + ' ' + d.metadata.wait.resumeAt : (d?.status === 'running' || d?.status === 'pending' ? '' : 'BAD:' + d?.status)")"
    case "$EVENT" in "$1 "*) return;; BAD:*) fail "run left running: $EVENT";; esac
    sleep 1
  done
  fail "never paused at $1"
}
git -C "$GEN" init -q
cat > "$WF/sa-abandon.yaml" <<'YAML'
name: sa-abandon
description: superagent selftest - a paused run is abandoned with a complete cleanup receipt
nodes:
  - id: gate
    wait: { event: sa.human.abandon, deadline_ms: 900000 }
YAML
smoke "    prompt: 'Reply only with the JSON object {\"answer\": \"pong\"}. Do not run tools or modify files.'
    model: '@sa-coder'" real
# A live provider must finish normally. Interrupt only the deterministic body
# below: a model instruction cannot reconcile unknown external effects.
if [ "$FAKE" = 0 ]; then
  PROVIDER_WF="$WF/sa-provider.yaml"
  cat > "$PROVIDER_WF" <<'YAML'
name: sa-provider
description: uninterrupted real provider contract
nodes:
  - id: think
    prompt: 'Reply only with the JSON object {"answer": "pong"}. Do not run tools or modify files.'
    model: '@sa-coder'
    output_format: { type: object, properties: { answer: { type: string } }, required: [answer] }
  - id: verify
    depends_on: [think]
    bash: |
      answer=$think.output.answer
      test "$answer" = pong
YAML
  git -C "$GEN" add "$PROVIDER_WF"; git -C "$GEN" -c user.name=sa -c user.email=sa@localhost commit -qm provider
  "$A" validate workflows sa-provider --cwd "$GEN" >/dev/null 2>&1 || fail "validate provider"
  BR="sa/selftest-provider-$(date +%s)" LAUNCH_INFLIGHT=1
  "$A" workflow run sa-provider --workflow-source "$GEN" --cwd "$REPO" --branch "$BR" --from "$BASE" --detach --json >"$TMPH/launch-provider.json" 2>"$TMPH/launch-provider.err"
  ID="$(cat "$TMPH/launch-provider.json" | field 'd?.runId')"; [ -n "$ID" ] || fail "provider launch ack"
  LAUNCH_INFLIGHT=0
  WT="$(get | field 'd?.working_path')"
  R="$("$A" workflow wait "$ID" --json --timeout "$TIMEOUT" 2>"$TMPH/provider.err" || true)"
  printf '%s\n' "$R" >"$TMPH/provider.json"
  [ "$(echo "$R" | field 'd?.attention?.status')" = completed ] || { keep=1; fail "provider did not complete: $TMPH/provider.json"; }
  ID=""; drop "$BR" "$WT"; BR="" WT=""
fi
smoke "    bash: sleep 20; echo '{\"answer\":\"pong\"}'" deterministic

BR="sa/selftest-$(date +%s)"
LAUNCH_INFLIGHT=1
"$A" workflow run sa-smoke --workflow-source "$GEN" --cwd "$REPO" --branch "$BR" --from "$BASE" --detach --json >"$TMPH/launch-smoke.json" 2>"$TMPH/launch-smoke.err"
ACK="$(cat "$TMPH/launch-smoke.json")"
ID="$(echo "$ACK" | field 'd?.runId')"; [ -n "$ID" ] || fail "run ack: $ACK"
LAUNCH_INFLIGHT=0

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
# This body only sleeps and emits JSON; no unknown provider effects are waived.
SNAPSHOT="$(get | bun -e "import { lastJson } from '$WETAMP/src/archon.ts'; import { recoverySnapshot } from '$WETAMP/src/recovery.ts'; console.log(recoverySnapshot(lastJson(await Bun.stdin.text())))")"
"$WETAMP/bin/superagent" recover "$ID" --reconciled "$SNAPSHOT" >"$TMPH/recover.json" || fail "recover: $TMPH/recover.json"
RECOVER_MS=$(( $(ms) - T0 ))

await_gate sa.human.smoke
T1="$(ms)"
"$A" workflow signal "$ID" --event sa.human.smoke --resume-at "${EVENT##* }" --data '{"decision":"yes"}' --json >/dev/null 2>&1 || fail "signal"
R="$("$A" workflow wait "$ID" --json --timeout 120 2>/dev/null || true)"
[ "$(echo "$R" | field 'd?.attention?.status')" = completed ] || fail "after signal: $R"
SIGNAL_MS=$(( $(ms) - T1 ))
TRACE="$(get | field 'd?.output_root')/artifacts/runs/$ID/trace.txt"
[ "$(grep -c '^start' "$TRACE")" = 1 ] || fail "start node re-ran after recover"
grep -q 'event=sa.human.smoke' "$TRACE" || fail "finish node missing"
# board：smoke run 由 archon 直接拉起、没有 ledger，补一个最小 ledger 后 board --json 必须列出它且判为 completed
printf '{"run_id":"selftest-smoke","archon_run_id":"%s","plan":"plan.json","gen_dir":"%s","repo":"%s","branch":"%s","workflow":"sa-smoke","console":"claude","started_at":"%s","transcript":"","log":"","recoveries":[]}\n' \
  "$ID" "$GEN" "$REPO" "$BR" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$TMPH/runs/selftest-smoke.json"
B="$("$WETAMP/bin/superagent" board --once --json 2>&1)" || fail "board --once --json: $B"
BOARD_ROWS="$(echo "$B" | field 'd?.rows?.length')"
[ "${BOARD_ROWS:-0}" -ge 1 ] || fail "board: no rows: $B"
[ "$(echo "$B" | field "d?.rows?.find((r) => r.run_id === 'selftest-smoke')?.state")" = completed ] || fail "board: smoke run missing: $B"
ID=""

BR2="sa/selftest-abandon-$(date +%s)"
"$A" validate workflows sa-abandon --cwd "$GEN" >/dev/null 2>&1 || fail "validate workflows (abandon)"
LAUNCH_INFLIGHT=1
"$A" workflow run sa-abandon --workflow-source "$GEN" --cwd "$REPO" --branch "$BR2" --from "$BASE" --detach --json >"$TMPH/launch-abandon.json" 2>"$TMPH/launch-abandon.err"
ACK="$(cat "$TMPH/launch-abandon.json")"
ID="$(echo "$ACK" | field 'd?.runId')"; [ -n "$ID" ] || fail "abandon run ack: $ACK"
LAUNCH_INFLIGHT=0
await_gate sa.human.abandon
WT2="$(get | field 'd?.working_path')"
T2="$(ms)"
"$A" workflow abandon "$ID" --json >"$TMPH/cancel.json" 2>"$TMPH/cancel.err" || { keep=1; fail "abandon of a paused run: $TMPH/cancel.json $TMPH/cancel.err"; }
bun "$WETAMP/scripts/selftest-stop.ts" "$TMPH/cancel.json" || { keep=1; fail "cancel has incomplete cleanup: $TMPH/cancel.json"; }
ABANDON_MS=$(( $(ms) - T2 ))
[ "$(get | field 'd?.status')" = cancelled ] || fail "paused run not cancelled: $(get | field 'd?.status')"
ID=""

# 正式回执 selftest.json 只由非 fake 写；fake 写 selftest-fake.json（preflight 不认）。同目录临时文件 + rename。
if [ "$FAKE" = 1 ]; then
  # Prove latest-engine retry adoption after completed coding, using scratch templates only.
  HF3_TOOLKIT="$TMPH/hf3-toolkit"
  bun -e 'import { cpSync, mkdirSync, symlinkSync } from "node:fs";
    import { join, basename } from "node:path";
    const [src, dst] = process.argv.slice(1);
    mkdirSync(dst);
    cpSync(src, join(dst, "wetamp"), { recursive: true, filter: p => basename(p) !== "node_modules" });
    symlinkSync(join(src, "..", "packages"), join(dst, "packages"));
    symlinkSync(join(src, "..", "node_modules"), join(dst, "node_modules"));
    symlinkSync(join(src, "node_modules"), join(dst, "wetamp/node_modules"));' "$WETAMP" "$HF3_TOOLKIT"
  HF3_REPO="$REPO"
  if [ "$OWN_REPO" = 0 ]; then
    # The adoption fixture makes commits; never put them in a supplied operator repo.
    HF3_REPO="$TMPH/hf3-repo"
    git clone -q --no-hardlinks --single-branch --branch "$BASE" "$REPO" "$HF3_REPO"
    git -C "$HF3_REPO" branch -m main
  fi
  # A failed/unknown helper return cannot prove run cleanup.
  # Preserve the entire scratch home until it confirms success.
  LAUNCH_INFLIGHT=1
  bun "$HF3_TOOLKIT/wetamp/scripts/hf3-adoption-selftest.ts" "$HF3_REPO" "$TIMEOUT" || fail "HF3 latest-engine retry adoption"
  LAUNCH_INFLIGHT=0
fi

OUT="$REAL_HOME/selftest.json"; [ "$FAKE" = 1 ] && OUT="$REAL_HOME/selftest-fake.json"
mkdir -p "$REAL_HOME"
SA_OUT="$OUT" SA_KEY="$RECEIPT_KEY" SA_FAKE="$FAKE" SA_METRICS="{\"rss_kb\":$RSS_KB,\"recover_ms\":$RECOVER_MS,\"signal_ms\":$SIGNAL_MS,\"abandon_ms\":$ABANDON_MS,\"board\":{\"rows\":$BOARD_ROWS,\"run_id\":\"selftest-smoke\"}}" \
SA_UPSTREAM="$(head -1 "$WETAMP/UPSTREAM")" bun -e "
import { SELFTEST_TTL_MS, writeAtomic, runtimeFingerprint } from '$WETAMP/src/config.ts';
const e = process.env, at = new Date();
const r = { ok: true, at: at.toISOString(), expires_at: new Date(at.getTime() + SELFTEST_TTL_MS).toISOString(), fake: e.SA_FAKE === '1',
  ...JSON.parse(e.SA_KEY), ...JSON.parse(e.SA_METRICS), hooks: { g1_commander_31_lines: 'advise' }, upstream: e.SA_UPSTREAM };
if (runtimeFingerprint() !== r.fingerprint) throw new Error('runtime fingerprint drift during selftest');
writeAtomic(e.SA_OUT, JSON.stringify(r) + '\\n');
console.log(JSON.stringify(r));"

#!/usr/bin/env bash
# 幂等安装：$ARCHON_HOME/.env 两行、config.yaml 只写 aliases/workflows/concurrency.providers（先备份）、建 gen/runs；
# 断言 @sa-coder ≠ @sa-reviewer；末尾 doctor 摘要。可重复跑。
set -euo pipefail
WETAMP="$(cd -P "$(dirname "$0")/.." && pwd)"
export SUPERAGENT_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"
export ARCHON_HOME="${ARCHON_HOME:-$SUPERAGENT_HOME/archon}"
bun -e "import { install } from '$WETAMP/src/config.ts'; for (const f of install()) console.log('updated ' + f.replace(process.env.HOME, '~'))"
[ "${SA_SKIP_DOCTOR:-}" = 1 ] && exit 0
if out="$("$WETAMP/bin/archon" doctor 2>&1)"; then echo "doctor: ok"; else echo "$out" | grep -v "^[○✓]" | tail -20; echo "doctor: FAILED" >&2; exit 1; fi

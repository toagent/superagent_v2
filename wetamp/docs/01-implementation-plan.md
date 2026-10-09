# 实施计划（将军：Claude Opus 5.5；元帅：验收与集成）

设计见 `00-architecture.md`，所有术语以它为准。四个里程碑，每个独立提交到分支 `wetamp`，提交前 `check-upstream-clean` 必须为空。

## 硬规则（任务卡原文，违反即返工）

1. 只改 `wetamp/**`。本仓库其他任何路径（含 `.archon/`、`packages/`、`package.json`、`bun.lock`）一个字节都不动。
2. 不新增 npm 依赖；YAML 读写用仓库已有的 `yaml` 包（`packages/*` 已依赖）或 bun 内置；不要 `bun add`。
3. 不切分支、不碰 `main`/`dev`、不 push、不改历史、不 stash；`git add <明确文件>`，禁止 `-A/--all/.` 与 `--no-verify`。
4. 不派生/委派 AI、不调用评审子命令、不用 superagent 跑自己。自检只靠 `cd wetamp && bun test`、`wetamp/scripts/selftest.sh`、`wetamp/bin/archon validate workflows --cwd <gen>`。
5. 不触碰 `_private`、iCloud、钥匙串、凭据；日志与错误文本一律脱敏；不打印任何 secret。
6. 根 `AGENTS.md` 对 `wetamp/` 同样生效：never `bun test` from root；artifacts 不进仓库；配置文件幂等修改不覆盖。
7. 预算：TypeScript ≤ 1800 行（不含测试）、shell ≤ 400 行、文件 ≤ 28 个（修复轮 R1 由 1500/300/25 上调）。超预算先删功能不加抽象。
8. 每条规则、每个节点生成分支、每个 CLI 动词至少一个命名测试；黄金文件（golden YAML）放 `wetamp/tests/golden/`。
9. 每阶段提交后在 `wetamp/docs/PROGRESS.md` 追加一行 `<ISO时间> | <阶段> | <commit> | <pass/total> | <备注>`；被中断先写状态再停。
10. 设计与现实冲突：以 Archon 实际行为（`packages/docs-web/src/content/docs/`、`archon --help`）为准，最小偏离，并写进 `00-architecture.md` 末尾「实现记录」。

## M0 引导（目标：Archon 能被 wetamp 以可复现方式驱动）

交付：

- `wetamp/bin/archon`：源码运行 shim：解析自身真实路径 → `export SUPERAGENT_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"`、`export ARCHON_HOME="${ARCHON_HOME:-$SUPERAGENT_HOME/archon}"` → `exec bun --cwd "$REPO/packages/cli" src/cli.ts "$@"`。`bin/superagent` 同样先导出这两个变量。全部状态只在 `~/.superagent/`（§2.2 不变量 6），代码里不得出现 `~/.archon` 或 `~/.local/state/superagent` 字面量。
- `wetamp/UPSTREAM`：`commit=7009a90a version=0.11.1 branch=dev date=2026-10-09`。
- `wetamp/scripts/check-upstream-clean.sh`：§2.2 不变量 1；无 `upstream` remote 时退化为与 `dev` 分支比较并警告。
- `wetamp/scripts/install.sh`（幂等，可重复跑；所有路径以 `$SUPERAGENT_HOME` 为根）：
  - `$ARCHON_HOME/.env`：确保 `ARCHON_TELEMETRY_DISABLED=1`、`DO_NOT_TRACK=1` 两行存在（已存在不重复、不改其他行）。
  - `$ARCHON_HOME/config.yaml`：用 YAML 解析后**只写** `aliases['@sa-coder'|'@sa-reviewer'|'@sa-reviewer-alt']`、`workflows.autoResumeOnQuotaReset=true`、`workflows.quotaMaxAttempts`、`concurrency.providers`（来自 `tiers.json health.vendor_concurrency`），其余键原样保留；写前备份到 `$ARCHON_HOME/config.yaml.bak-<ts>`。
  - 创建 `$SUPERAGENT_HOME/{gen,runs}`。
  - 断言 `@sa-coder` 与 `@sa-reviewer` 的 `provider/model` 不同，否则退出非 0。
  - 末尾跑 `bin/archon doctor` 并打印摘要。
- `wetamp/tiers.json`：从 `/Users/yong/work/github/superagent/tiers.json` 原样复制（只读引用，不改字段）。
- `wetamp/templates/.archon/commands/{sa-code,sa-review,sa-review-delta,sa-fix}.md`：角色前缀（非主控、不派生、不 push）、输入变量约定、输出 JSON 结构说明。
- `wetamp/templates/.archon/workflows/sa-smoke/sa-smoke.yaml`：4 节点（bash → prompt(@sa-coder, 一句话任务, `output_format` 小 JSON) → `wait: {event: sa.human.smoke, deadline_ms}` → bash，`when: $gate.output.status == 'satisfied'`），用于 selftest。**不要用 `approval:`**：`--detach` 拒绝 interactive-class 工作流（PoC #5）。bash 节点引用上游输出必须先 `var=$node.output.field` 再使用（PoC #7）。
- `wetamp/scripts/selftest.sh`：对一个临时 git 仓库跑 sa-smoke（临时 `SUPERAGENT_HOME`）：`run --workflow-source --detach --json` → 在 prompt 节点运行期间 `kill -9` detach 子进程 → `workflow wait --json` 必须返回 `owner_lost` → `superagent recover`（状态回拨 + `resume --detach`）→ `wait` 到暂停在事件门 → `signal --event sa.human.smoke --resume-at <metadata.wait.resumeAt> --json` → `wait` 到 completed；断言第一个 bash 节点未重跑（看 `get --json --verbose` 的节点时间戳或 artifacts 轨迹文件）。PoC 参考实现见 `02-poc-checklist.md`（表 #8–#13）。
- `wetamp/tests/install.test.ts`：对临时 `SUPERAGENT_HOME` 跑两次 install，第二次无 diff；已有无关键被保留。

验收（元帅实测）：`wetamp/scripts/install.sh && wetamp/scripts/selftest.sh` 退出 0；`check-upstream-clean.sh` 为空；`cd wetamp && bun test` 绿。

## M1 生成器 + 兼容 CLI 核心

交付：

- `wetamp/schemas/plan.schema.json`：v2 复制 + `milestone`、`console` 两个可选字段。
- `wetamp/src/plan.ts`：加载、JSON Schema 校验（仓库已有 ajv/zod 之一，查 `packages/*/package.json` 后复用）、`repo` 白名单根校验、deps 拓扑排序与环检测。
- `wetamp/src/generate.ts`：plan → `$SUPERAGENT_HOME/gen/<run>/.archon/{workflows/sa-<slug>/sa-<slug>.yaml, commands/, scripts/}`（gen 目录 `git init` 并提交一次，否则 `validate`/`run` 拒绝；PoC #3），节点结构严格按 `00-architecture.md §4.2`（本阶段先不生成 `fix/review r2/r3`、`human`、`vote`，留占位）；生成后调用 `bin/archon validate workflows`。
- `wetamp/src/cli.ts` + `wetamp/bin/superagent`：`run`、`wait`、`status`、`get`、`resume`、`cancel`、`recover`、`health`。`run` 回 JSON `{run_id, archon_run_id, gen_dir, transcript, log}` 并写 `$SUPERAGENT_HOME/runs/<run>.json`；`wait` 包装 `archon workflow wait --json --timeout`（输出可能多段 JSON，取最后一个对象），`owner_lost` 时自动 `recover` 再等一次；`recover` 只在 `execution_owner.host` 为本机且 pid 不存在时把 `remote_agent_workflow_runs.status` 由 `running` 改 `failed`（`bun:sqlite`，单列单行，带 `where status='running'`）再 `resume --detach`。
- 测试：两包有依赖的 plan → 黄金 YAML 比对；非法 plan（环、repo 越界、未知字段）各一条；`wait` 的结果映射表测试（completed/paused-at-human/failed/cancelled/timeout/owner_lost → 退出码 0/3/1/2/3/自动恢复）。

验收：`bin/superagent run wetamp/tests/fixtures/plan-two-pkgs.json --json` 在临时 git 仓库上端到端跑完（用 `@sa-coder`），`wait` 到 completed，`land` 输出可执行的本地合入命令且执行后分支合入。

## M2 里程碑评审 + 门禁 + supervisor 桥

交付：

- 生成器补全：`diff-<M>`、`review-<M>-r1/r2/r3`、`fix-<M>-r2/r3`（`when:` 链）、`gate-<M>`（script，输出 `{verdict, rounds, escalate}`）、`human-<M>`（`wait: {event: sa.human.<M>, deadline_ms}`，仅 `signoff: "human"`；下游 `when: $human-<M>.output.status == 'satisfied'`）、`land` 依赖全部 gate。
- `wetamp/schemas/reviewer-result.schema.json`、`coder-result.schema.json`：从 v2 复制，字段只加不减；`output_format` 引用它们（内联进 YAML）。
- `wetamp/src/supervisor-bridge.ts` + `bin/superagent supervise-tick`：先 `archon workflow wake --json`；对 `wait` 报 `owner_lost` 的 run 执行 `recover`；列出暂停在 `human-*` 事件门的 run（`get --json --verbose` 的 `metadata.wait`）→ 对未问过的 run+node 调 `~/.ai-agent-shared/skills/agent-supervisor/scripts/supervisor.py ask`（问题 ≤120 字：仓库、里程碑、评审结论摘要、证据路径）→ 账本 `$SUPERAGENT_HOME/asks.json`；对已问的查结果：是 → `signal --event sa.human.<M> --resume-at <metadata.wait.resumeAt> --json`；否 → `cancel --json`；过期 → 账本标 expired，`brief` 标红。本阶段只提供命令，不改 `~/.ai-agent-shared`（接线由元帅做）。
- `decide`（approve → signal；reject → cancel）、`brief`、`land`（读 `land` 节点输出）。
- 测试：评审链三种路径（r1 pass / r2 pass / 三轮失败 escalate）黄金 YAML；`gate` script 单测；supervisor 桥对 fake `archon`/fake `supervisor.py` 的状态机测试（用 PATH 注入的桩脚本）。

验收：fixture plan（两个里程碑、第二个 `signoff: human`）端到端：m1 自动过审并落 `land`，m2 暂停在 `human-m2`；`supervise-tick` 用桩 `supervisor.py` 返回“是”后 run 完成。真实提醒事项由元帅人工复测一次。

## M3 运维与收尾

交付：

- `report`（`runs --json --verbose` 汇总：run 数、各节点耗时、失败分类；token 后置）、`selftest` 并入 §2.4 契约复测。
- `wetamp/scripts/upgrade-upstream.sh`（默认 dry-run，`--apply` 才动分支；永不 push）。
- `wetamp/README.md`：安装（`install.sh`）、PATH 接法（`~/.local/bin/superagent → wetamp/bin/superagent`，由用户/元帅手动做）、日常命令、升级、故障排查。
- 可选（时间允许）：红线等待期间让 worker 退出、靠 `wake` 续跑（省 ~200 MB/run）；包级并行 `isolation: worktree` + 合并节点。`approval:` 子运行方案已被 PoC #5 否定，不要再试。

验收：`selftest.sh` 全绿；`upgrade-upstream.sh` dry-run 输出正确计划；文档能让一个新会话仅凭 README 完成一次 `run → wait → land`。

## 完成时

`PROGRESS.md` 末尾写「最终摘要」：各阶段 commit、`bun test` 计数、selftest 实测值（detach 子进程 RSS、kill -9 → resume 耗时、approve 往返耗时）、与设计的偏差、未做项、剩余风险；最后一条输出 ≤40 行 + `git log --oneline dev..HEAD`。

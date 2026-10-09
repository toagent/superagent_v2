# superagent on Archon：架构与自定义方案

状态：设计定稿（2026-10-09）。实施计划见 `01-implementation-plan.md`，PoC 记录见 `02-poc-checklist.md`。

## 0. 决策记录（用户拍板，不再重议）

| 日期       | 决策                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-09 | 放弃两版自研方案（改造 superagent v2 守护进程 / v4 从零重写）：都是重复造轮子。                                                                                                                                           |
| 2026-10-09 | 基于本仓库（`coleam00/Archon` 的 fork，v0.11.1，upstream `dev` 7009a90a）改造；**必须能无缝升级 upstream**；实现与自定义方案全部放 `wetamp/`。                                                                            |
| 2026-10-09 | **不做沙箱**。Codex 直接用 Archon 原生 provider（线程以 `danger-full-access` 启动，`packages/providers/src/codex/provider.ts:1072`），Claude 用原生 provider。v2 的 `adapters/*`、`sandbox-policy`、bash 包装层全部不要。 |
| 2026-10-08 | 评审模型 ≠ 作者模型（硬约束）；G2 合格独立评审通过即放行集成；红线问题投 iPhone 提醒事项（勾选=是、删除=否），其余决策 AI 投票过半。                                                                                      |
| 2026-10-09 | 效率主因是拆包过细、评审过频：评审按**里程碑**一次，不按包。                                                                                                                                                              |
| 2026-10-09 | owner-lost 恢复（状态回拨 + resume）作为 wetamp **永久 overlay** 实现，不向 upstream 提 PR；引擎事实登记进 `UPSTREAM` 由 selftest/升级脚本复测。                                                                          |

## 1. 一句话

Archon 是引擎（DAG、断点续跑、detach、approval、quota 自动恢复、worktree、runs 账本），一行不改；
`wetamp/` 是薄胶水：把三端协议里的 `plan.json` 变成 Archon 工作流，把 `superagent run/wait/decide/...` 映射成 `archon workflow ...`，
把 iPhone 提醒事项桥接到 `archon workflow signal/cancel`。

```
三端协议（元帅写 plan.json，调 superagent run/wait/decide/brief/report/land）
        │
        ▼
wetamp/bin/superagent  ──生成──▶  ~/.superagent/gen/<run>/.archon/{workflows,commands,scripts}
        │                                   │
        │  archon workflow run <wf> --workflow-source <gen> --cwd <repo> --detach --json
        ▼                                   ▼
Archon CLI（bun 源码运行，packages/cli）  ──▶ ~/.superagent/archon/archon.db（唯一账本）+ workspaces/<repo>/{worktrees,artifacts,workflow-source}
        │
        ├─ prompt 节点 → 原生 codex / claude provider（无沙箱）
        ├─ bash/script 节点 → 验收命令、diff 汇总、投票计数、合入命令
        └─ wait(event) 节点 → agent-supervisor 每 5 分钟 tick：提醒事项 ⇄ signal（是）/ cancel（否）
```

## 2. 分层与 upstream 安全

### 2.1 目录

```
wetamp/
  docs/                 本目录
  UPSTREAM              钉住的 upstream 提交与版本（升级脚本维护）
  bin/archon            源码运行 shim：exec bun --cwd "$REPO/packages/cli" src/cli.ts "$@"
  bin/superagent        兼容 CLI（bun + TypeScript，无构建步骤）
  src/                  plan 校验、工作流生成器、兼容命令、supervisor 桥
  templates/            生成器拷贝进 gen 目录的 .archon/commands/*.md、.archon/scripts/*.ts、YAML 片段
  schemas/              plan.schema.json（v2，仅做加法）、coder-result、reviewer-result
  config/               ~/.superagent/archon/config.yaml 与 .env 的覆盖片段（install.sh 幂等写入）
  tiers.json            模型池真源（从 superagent v2 迁入，字段不变）
  scripts/              install.sh、check-upstream-clean.sh、upgrade-upstream.sh、selftest.sh
  tests/                bun test（只在 wetamp/ 内运行，遵守根 AGENTS.md "never bun test from root"）
```

### 2.2 不变量（selftest 与提交前强制）

1. **仓库内 `wetamp/` 之外零改动**：`scripts/check-upstream-clean.sh` 执行
   `git diff --stat $(git merge-base HEAD upstream/dev) HEAD -- . ':!wetamp'`，输出必须为空。
2. **不动本仓库自己的 `.archon/`**：那是 upstream 的 dogfood 配置，升级时会变。我们的运行目标是业务仓库，不是本仓库。
3. **目标仓库零足迹**：工作流、命令、脚本全部来自 `--workflow-source <gen>`；运行配置来自 `~/.superagent/archon/config.yaml` + 每次运行的 `--config`/`--model`。
   不往任何业务仓库写 `.archon/`。
4. **状态目录统一在 `~/.superagent/`**（用户 2026-10-09 决定，避免与独立安装的 Archon、旧 superagent v2 冲突）：
   `wetamp/bin/archon` 与 `wetamp/bin/superagent` 都先 `export SUPERAGENT_HOME="${SUPERAGENT_HOME:-$HOME/.superagent}"`、
   `export ARCHON_HOME="${ARCHON_HOME:-$SUPERAGENT_HOME/archon}"`，再调引擎（PoC 已验证 detach worker 继承 `ARCHON_HOME`）。
   wetamp 代码不得出现 `~/.archon`、`~/.local/state/superagent` 字面量；测试用临时 `SUPERAGENT_HOME`。
5. **引擎改动只走 upstream PR**（按根 `AGENTS.md`：从 `dev` 开分支、`bun run validate`、additive schema）。
   不保留本地 patch。靠引擎内部事实（sqlite 表/列、CLI JSON 字段）实现的 overlay（目前只有 `recover`）必须：
   只读引擎源码、只写明确的一列一行、把依赖的事实登记进 `UPSTREAM`，并由 selftest 与 `upgrade-upstream.sh` dry-run 复测。
6. **不新增依赖**：只用仓库现有 `bun.lock` 里的包与 bun 内置能力；需要新包先在 upstream 看是否已有等价物。

### 2.3 分支策略

| 分支     | 含义                              | 规则                                                |
| -------- | --------------------------------- | --------------------------------------------------- |
| `dev`    | upstream `dev` 的纯镜像           | 只 `--ff-only` 合并 upstream，不提交                |
| `main`   | upstream `main`（发布）的纯镜像   | 同上                                                |
| `wetamp` | 工作分支 = `dev` + `wetamp/` 提交 | 所有自定义只提交到这里；`origin` 推送由用户人工执行 |

跟 upstream **`dev`**（不是 `main`）：`dev` 是活跃线，`workflow wait`、`signal`、owner-lost 检测等我们依赖的动词都先进 `dev`。
注意 PoC 发现 `--detach` 拒绝含 `approval:` 的工作流，所以 7009a90a 的「子运行自带 approval」对无人值守无用，红线门用 `wait: {event}`（§5）。

### 2.4 升级 runbook（`scripts/upgrade-upstream.sh` 把它脚本化，默认 dry-run）

```bash
git remote add upstream https://github.com/coleam00/Archon.git   # 一次性
git fetch upstream
git checkout dev && git merge --ff-only upstream/dev
git checkout wetamp && git merge dev            # wetamp/ 与 upstream 文件集不相交，不应有冲突
bun install --frozen-lockfile
wetamp/scripts/check-upstream-clean.sh         # 必须为空
wetamp/scripts/selftest.sh                     # 见 §6
# 更新 wetamp/UPSTREAM（提交号、Archon 版本、日期），提交到 wetamp 分支
```

升级后要复测的 upstream 契约（selftest 覆盖）：`workflow run --workflow-source/--detach/--json` 的 JSON 字段、
`workflow get --json` 状态字段、`approve/reject --json` 不自动 resume 的语义、`output_format` 字段路径严格校验、config 的 `tiers/aliases` 键。

## 3. 运行模型：无守护进程

- `superagent run plan.json` → 生成 → `archon workflow run ... --detach --json` → 立即返回 `runId`（实测 1s）。
  detach 子进程做全部工作，跨 `wait:` 存活（暂停等待期间常驻，RSS ≈200 MB）；完成即退出。
- `superagent wait <run> --timeout N` = `archon workflow wait <id> --json --timeout N`（`--detach` 的官方配对动词，阻塞直到终态/需要关注/owner 丢失，不轮询 `get`）。
  输出可能是多段 JSON，取最后一个对象。
- **崩溃恢复**（PoC #8–#11）：worker 被 `kill -9` 后 run 行停在 `running`，`wait` 返回 `owner_lost`。upstream 只给 `abandon` + `run --adopt`（新 run，节点缓存全丢）。
  wetamp 的 `recover`：校验 `execution_owner.host` 是本机且 pid 不存在 → 只把 `remote_agent_workflow_runs.status` 从 `running` 改为 `failed` → `resume --detach`；已完成节点走缓存不重跑（实测 step1 未重跑、被打断的 step2 重跑）。
  这是 wetamp 的**永久 overlay**（用户 2026-10-09 决定：不向 upstream 提 PR）：实现只落在 `wetamp/src/archon.ts` 的 `recover()`，不改引擎；
  它依赖的引擎事实（表 `remote_agent_workflow_runs` 的 `status` 列、`metadata` JSON 里的 `execution_owner`、`wait` 的 `owner_lost` 语义）：
  `selftest.sh` 每次实测，`upgrade-upstream.sh` dry-run 按 `UPSTREAM` 登记的事实行在 `upstream/dev` 的具体文件中核对三者仍在、并只读核对本机 archon.db 的列，漂移即报错而不是静默失效。
- 唯一周期任务：`install.sh` 渲染的 launchd 作业 `com.wetamp.superagent.supervise-tick`（60 秒，加载由人执行）。tick 内做三件事：`archon workflow wake --json`（唤醒到期等待与 quota 恢复）、对 `owner_lost` 的 run 执行 `recover`、桥接红线事件（§5）。
- 状态只有一份：`~/.superagent/archon/archon.db`。`~/.superagent/` 其余只放生成的源目录、plan 副本、supervisor 的 ask 账本（小 JSON）。v2 的 `~/.local/state/superagent/v3.db` 只读保留做历史。
- 资源：每个活跃/等待中的 run 一个 bun 子进程；无运行时为 0。红线等待可长达数小时，M3 评估「等待时让 worker 退出、靠 `wake` 续跑」。

### 3.1 `~/.superagent/` 布局

```
~/.superagent/
  archon/            ARCHON_HOME：config.yaml、.env、archon.db、workspaces/<repo>/{worktrees,artifacts,logs}、logs/
  gen/<run>/         生成的工作流源（git init 过，否则 validate/run 拒绝）：.archon/{workflows,commands,scripts}、plan.json 副本
  runs/<run>.json    superagent 侧账本：plan 路径、archon_run_id、gen_dir、transcript/log 路径、启动时间
  asks.json          supervisor 提问账本（run+node → 提醒 id、时间、结果）
```

## 4. plan.json → 工作流（生成器）

### 4.1 输入

plan schema v2 原样（`repo, base_ref, concurrency, deadline, budget, mode, environment, packages[]`），**只加字段**：

| 字段        | 位置    | 含义                                                                                       |
| ----------- | ------- | ------------------------------------------------------------------------------------------ |
| `milestone` | package | 评审批次名；缺省所有包同属 `m1`。同一 milestone 的包一起评审一次。                         |
| `console`   | 顶层    | `claude`\|`codex`，决定评审池（`tiers.json routing.reviewer.by_console`）；缺省 `claude`。 |

### 4.2 生成的 DAG（静态、确定、`archon validate workflows` 先过）

```
code-<pkg>      prompt(command: sa-code)   model: @sa-coder   output_format: coder-result   depends_on: 依赖包的 verify-*
verify-<pkg>    bash: 执行 pkg.accept         output_format: {ok, log}                      depends_on: code-<pkg>
diff-<M>        bash: 汇总本里程碑所有包的 diff → $ARTIFACTS_DIR/diff-<M>.patch              depends_on: 本里程碑全部 verify-*
review-<M>-r1   prompt(command: sa-review) model: @sa-reviewer output_format: reviewer-result  （R1 全量）
fix-<M>-r2      prompt(command: sa-fix)    when: $review-<M>-r1.output.verdict == 'fail'
review-<M>-r2   prompt(command: sa-review-delta)  when: 同上                                 （只核验遗留 + 本轮 diff，新发现仅 blocker 阻塞）
fix-<M>-r3 / review-<M>-r3                 同上，第三轮
gate-<M>        script(bun): 三轮内 pass → ok；否则输出 escalate=true，run 以失败结束（≤3 轮超限升级给用户）
human-<M>       wait: {event: sa.human.<M>, deadline_ms: TTL}  仅当该里程碑任一包 signoff == "human"（红线）；其余里程碑没有这个节点
                下游节点 when: $human-<M>.output.status == 'satisfied'（wait 的 output_format 固定，payload 嵌套字段不可引用）
land            bash: 打印合入命令（本地 merge/ff，不 push）  output_format: {branch, commands}
```

- 包与包之间按 `deps` 拓扑串联；**同一 run 内不并行写同一 worktree**（M1 决定，合包后包少，损失可忽略）。
  跨 run 天然并行（每个 run 独立 Archon worktree）。需要包级并行时再用 `workflow:` 子运行 + `isolation: worktree`（M3 可选）。
- 评审模型 ≠ 作者模型由**结构**保证：`@sa-coder` 与 `@sa-reviewer` 是两个别名，`install.sh` 断言二者 `provider/model` 不相等；
  生成器不信任 prompt 文案。`@sa-reviewer-alt`（另一厂商）用于 AI 投票与 `@sa-reviewer` 熔断时的手工切换。
- 模型故障：Archon 原生 `retry`、`workflows.autoResumeOnQuotaReset/quotaMaxAttempts` 处理限流/配额；
  跨厂商切换 = `superagent resume <run> --model @sa-reviewer=claude/opus`（经每次运行的 `--config` 层，不改持久配置）。
- 验收命令（`accept`）由 bash 节点执行，退出码即结果，不交给模型复述。

### 4.3 别名（`install.sh` 从 `tiers.json` 渲染进 `~/.superagent/archon/config.yaml`，幂等、只改自己的键）

| 别名               | 来源                                      | 当前                                         |
| ------------------ | ----------------------------------------- | -------------------------------------------- |
| `@sa-coder`        | `routing.coder.models[0]`                 | codex / gpt-6.1-sol / high                   |
| `@sa-reviewer`     | `routing.reviewer.by_console[console][0]` | codex / gpt-6-astra / high（console=claude） |
| `@sa-reviewer-alt` | 同上第一个异厂商                          | claude / claude-opus-5 / high                |
| `@sa-local`        | 亲兵                                      | 不进 Archon（隐私数据不经引擎）              |

模型 ID 只在 `tiers.json` 改；`install.sh` 重跑即生效。

## 5. 门禁与无人值守

| 情形                          | 机制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0/G1                         | `review-*` pass → `land` 自动执行；没有人工节点                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| G2 非红线                     | 同上（用户 2026-10-08：合格评审通过即放行）；分歧用 `vote-<M>`：`@sa-reviewer` + `@sa-reviewer-alt` 各出 JSON 结论，script 节点计票过半                                                                                                                                                                                                                                                                                                                                                         |
| 红线（包 `signoff: "human"`） | `human-<M>` = `wait: {event: sa.human.<M>}` → run 暂停（`metadata.wait.resumeAt` 记截止）；agent-supervisor tick 调 `superagent supervise-tick`：发现暂停在 `human-*` 的 run，经 `supervisor.py ask` 投提醒事项（按 run+node 去重，账本 `~/.superagent/asks.json`）；勾选 → `archon workflow signal <id> --event sa.human.<M> --resume-at <resumeAt> --json`；删除 → `archon workflow cancel <id> --json`；到期未答 → wait 节点 `status=expired`，下游 `when` 不满足，run 失败并由 `brief` 标红 |
| 超 3 轮                       | `gate-<M>` 失败，run 失败；`superagent brief` 把升级原因打给用户                                                                                                                                                                                                                                                                                                                                                                                                                                |

Archon 约束要记住（PoC 实测）：`--detach` 拒绝含 `approval:` 的工作流（interactive-class），所以无人值守只能用 `wait: {event}`；
`wait` 节点的 `output_format` 固定，下游只能看 `status/event/waited_ms`，"否"只能用 cancel 表达，不能把决定塞进 payload。

## 6. 兼容 CLI（`wetamp/bin/superagent`）

| 旧命令                                     | 映射                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run <plan> --json`                        | 校验 plan → 生成 → `archon workflow run sa-<slug> --workflow-source <gen> --cwd <repo> --branch sa/<run> --from <base_ref> --detach --json`；回 `{run_id, archon_run_id, gen_dir}`    |
| `wait <run> --timeout N`                   | `workflow wait <id> --json --timeout N`；`owner_lost` → 自动 `recover` 后再 wait 一次；输出 ≤20 行摘要 + 证据路径；退出码：completed 0 / 暂停等人 3 / failed 1 / cancelled 2 / 超时 3 |
| `status` / `brief <run>`                   | `workflow status --json` / `workflow get --json --verbose` 压缩成 ≤20 行                                                                                                              |
| `decide <run> approve\|reject [--comment]` | approve → `workflow signal --event sa.human.<M> --resume-at <metadata.wait.resumeAt>`；reject → `workflow cancel`；comment 进 `--data`                                                |
| `resume <run>` / `cancel <run>`            | 直通；`resume` 对 owner-lost 的 run 先 `recover`                                                                                                                                      |
| `recover <run>`                            | §3 崩溃恢复（校验本机 + 死 pid → 状态回拨 → `resume --detach`）                                                                                                                       |
| `supervise-tick`                           | 供 launchd 作业（60 秒）调用：`wake` + `recover` 全部 owner-lost + 红线提问/桥接（§5）；持锁，被占即跳过                                                                              |
| `land <run>`                               | 打印 `land` 节点输出的合入命令（永不 push）                                                                                                                                           |
| `report`                                   | 逐个 ledger `workflow get --verbose` 汇总状态/轮次/耗时（token 计量后置）                                                                                                             |
| `health`                                   | `archon doctor` + 别名解析 + `check-upstream-clean`                                                                                                                                   |
| `selftest`                                 | §2.4 契约复测 + 一条真实小工作流 detach → `kill -9` → resume                                                                                                                          |

## 7. 安全姿态（用户决定：无沙箱）

- Codex 线程 `danger-full-access`、Claude 原生权限；代理进程看到完整 shell 环境。用户评估沙箱价值不大，接受。
- 保留的廉价护栏（都不是沙箱）：plan 校验拒绝 `repo` 落在白名单根（`~/work`）之外；`land` 只打印本地命令；
  命令模板明确禁止 `git push`/历史改写；`~/.superagent/archon/.env` 写 `ARCHON_TELEMETRY_DISABLED=1`、`DO_NOT_TRACK=1`；
  钥匙串、凭据、`_private`、iCloud 不进 plan，也不进任何 prompt。

## 8. 非目标

token 计量与计费；v2 内部状态机/账本兼容；Archon container 模式；多仓 plan（一个 plan 一个 `repo`，多仓拆多 plan）。

## 实现记录

与上文设计的偏差（以 Archon 实际行为为准，最小偏离）：

- 外部提交：e2476bb1、ca963d06、4829563b 由操作者在本会话之外提交并 push（通用说明，无 `wetamp(Mx):` 前缀）；内容即本会话工作树，未改写历史。
- archon 的 `workflow get/wait/resume/cancel/signal` 须在目标 git 仓库 cwd 下执行；CLI 一律以 ledger.repo 为 cwd。
- `plan.budget` 仅做 schema 兼容，不参与调度（Archon 无 token 预算）。
- `SUPERAGENT_WRITE_ROOTS`（冒号分隔）覆盖 repo 白名单根，测试/selftest 用临时目录。
- 退出码：0 completed、1 failed、2 cancelled、3 held（human/paused/environment/gate）、4 running；用法错误 64。
- `--fake`：编码/评审/修复节点换成 bash 桩，用于测试与 selftest，零模型调用。
- 每个里程碑以 `start-<M>` bash 节点记录基线 HEAD，评审轮次展开为固定的 `fix/diff/review/gate-<M>-rN`（N≤3，第 2、3 轮的 fix 带 `when: verdict == 'fix'`）；未走到的轮次被条件跳过，下一步以 `none_failed_min_one_success` 汇合三个 gate（fake e2e 实测：跳过沿依赖链级联后汇合仍放行）。escalate = gate 节点 exit 1，run 停在 failed，`decide retry` 对它无效（须在分支上修或新开 run）。
- 人工签收：`human-<M>` 是 `wait: {event: sa.human.<M>}` 事件门，其后 `signoff-<M>` bash 节点检查 `status = satisfied`（而不是用 `when`：wait 到期也算节点完成，`when` 跳过会让 land 照常执行）。
- `workflow signal` 与 `workflow wake` 会在调用进程内执行剩余 DAG：CLI 以 detached 子进程执行并把输出写到 `gen/<run>/signal-<node>.log`、`$SUPERAGENT_HOME/wake.log`；signal 以“run 离开 paused 或 resumeAt 改变”为受理确认（30 s）。
- 状态映射：paused 且等待 `sa.human.*` → held:human；其余 paused → held:paused；environment 节点失败 → held:environment；gate 节点失败 → held:gate。
- 节点输出 schema 外置到 `schemas/output.schema.json` 的 `$defs`，brief 正文外置到 `templates/brief.md`（单趟 `{{key}}` 替换，计划文本中的 `{{x}}`/`$` 原样保留）。
- Codex 控制台的评审别名重绑：见修复轮 R1 的 H2（run-config 层），不改生成的 YAML。
- `supervise-tick` 由 `$SUPERAGENT_HOME/supervise.lock` 串行化，owner-lost 恢复与 `wait` 共用 stall 上限（见修复轮 R1 的 M1、M4）。
- gc 不使用 `archon complete` / `isolation cleanup --merged`：二者会删除远端分支，属于对外动作。
- M3 实现记录：
  - `sa-smoke` 不再是模板（生成器只复制 `commands/`、`scripts/`，留着即死文件），内联在 `selftest.sh`：先以真实 think 节点 `validate`，复测 `install.sh` 写入的 `config.yaml` 别名（§2.4 契约复测），`--fake` 再换成 bash 桩执行。
  - `report` 对每个 ledger 调 `workflow get --verbose`（`workflow runs --all` 在 repo 外返回空），输出扁平计数：`runs`、`state:*`、`rounds:N`（各里程碑末轮）、`first_pass`、`failed:<节点前缀>`、`escalate:<reason>`、`node_s:<节点前缀>`（累计秒）、`debt`、`recoveries`；读不到的 run 列入 `unreadable` 且退出码 1。token 统计后置。
  - `recover` 成功即写入 ledger 的 `recoveries`（`wait`、`resume`、`supervise-tick` 共用），`brief`/`report` 读它。
  - 去掉 `get` 动词（`status`/`brief` 已覆盖）；参数解析改用 `node:util` `parseArgs` 严格模式，未知参数报错而不是静默忽略。
  - 消除手工同步的类型：`sa-check.ts` 以 `import type` 引用 `src/plan.ts`（Bun 擦除类型导入，复制到 gen 目录后仍可运行），CLI 的 gate 结论类型取自 `sa-check` 的 `decide` 返回类型。
  - `gc.sh`（shell，TS 预算已满）：只处理 `superagent status` 为 completed/cancelled 且分支是本地目标分支祖先的 run；worktree 须在 `$ARCHON_HOME` 下，`git worktree remove` 不加 `--force`、`branch -d`；Archon 的 run 记录与环境行留给 `archon workflow cleanup` / `archon isolation cleanup`（后者对已不存在的路径做对账）。
  - `upgrade-upstream.sh`：dry-run 也 `git fetch upstream dev`（只更新远端跟踪引用，不动分支与工作区）；列核对用 `pragma_table_info` 而非 `.schema` 文本（`ALTER TABLE ADD COLUMN` 会把列写在同一行）；`execution_owner` 是 `metadata` JSON 的键而非列，故核对 `status`、`metadata` 两列。`--apply` 让 merge 自动提交（不触发 pre-commit，避免 lint-staged 改写上游文件），`UPSTREAM` 只改写不提交，由人验证后提交。
  - 文件预算按 `wetamp/` 下除 `tests/`、`docs/`、`README.md` 外的文件计（25 个）。
- 修复轮 R1 实现记录：
  - H1：`recover` 先取 `runs/<id>.lock`（O_EXCL 写 `{pid,host,at}`；同机 pid 已死或超过 10 min 才接管，`release` 只删自己的锁），锁内重读 run 与 ledger；置 failed 的 UPDATE 以 `status='running'` 与 `metadata.execution_owner.pid/host` 等于刚判定丢失的 owner 为条件，影响行数≠1 即 `owner_changed`、不 resume。
  - M1：`wait`、`resume`、`supervise-tick` 共用 `recoverRun`：ledger 持久化 `progress_fp`（已完成节点集合的 sha256 前 16 位）与 `stalled`；同一指纹连续恢复 3 次后拒绝并呈现 `held:recover_no_progress`（退出码 3），`decide retry` 是操作者显式重置。
  - H3：R2/R3 的阻塞集合以上一轮遗留的 ID 集合为基线：基线 ID 只有在本轮以同一 ID、`carry_over:true`、`status:closed` 且带非空 `evidence` 出现时才关闭，漏报、改名、无证据关闭都按仍未关闭；新发现只有 blocker 阻塞。
  - H4：gate 先判 `plan.deadline` 过期再判 PASS（`escalate deadline`）；`signoff-<M>` bash 节点与 `land` 也检查绝对截止时间；`decide approve` 过期拒绝，`supervise-tick` 不再替过期的“是”发 signal。
  - M2：`diff-<M>-rN`（N>1）以上一轮 `diff_hash` 为 `prev` 输出 `same`；`review-<M>-rN` 带 `when: same != 'true'`；gate 依赖 diff 与 review 并以 `none_failed_min_one_success` 汇合，`same` 时直接 `escalate no_change`，不再为未变化的 diff 付评审费。
  - M7（R2 定稿）：G1 债务 = 末轮评审 `debt[]` ∪ 各轮未关闭的非阻塞发现（`<id> <severity> <file>:<line>`，按 ID 去重；前轮发现在后轮漏报仍算债，带证据 carry-over 关闭才清）；`land` 输出与 `land.json` 带各里程碑末轮 gate 的 `debt`。
  - H2：run 启动时把 `@sa-coder`、`@sa-reviewer`、`@sa-reviewer-alt` 的具体 provider/model/effort（按控制台选评审池）写进 `gen/<run>/run-config.yaml`，经 `workflow run --config` 成为 Archon 的 run 层（优先级最高，detach 子进程与 resume 继承密封快照）；不用 `--model`，因为字面 `provider/model` spec 丢 effort。启动前断言全局与目标 repo `config.yaml` 中已定义的 `@sa-*` 别名等于 tiers 渲染值，否则退出码 5（`health --cwd` 同检查）。
  - M6：所有动词接受 `--json`（no-op）；未知参数退出 64 并打印用法。
  - M3：`sa-check` probe 与 `selftest.sh` 清理不再 `--force`、不用 `branch -D`：`worktree remove` / `branch -d` 失败即保留并把路径打到 stderr（selftest 此时连整个临时目录一起保留，Archon worktree 在其下 `archon/`）；selftest 的临时 repo 在 `mktemp -d` 目录里整体 `rm -rf`。
  - M4：签收提问以 `run:里程碑:已过 gate 文件数` 为键幂等；先写无 id 的 `pending` 账目再调 `ask`，成功回写 id。R2 定稿（M4b）：调用前账目记 `unknown`，ask 非零退出或 tick 崩溃都保留；下一 tick 在 supervisor 的 `asks/*.json` 里按问题前缀 `superagent <键> ` 找回 id → `ask-status` 跟踪，找不到才重问，多于一条报错交人。锁文件 `{pid,host,at}`，超龄也只在同机 pid 已死（或锁不可读）时接管（M4a）。`supervise-tick` 取 `$SUPERAGENT_HOME/supervise.lock`（与 recover 同一把 O_EXCL 锁实现），被占则打印 `{"skipped":"locked"}` 退出 0。
  - M5：引擎事实以机器可读行登记在 `UPSTREAM` 第 2 行起（`table <file> <table> <col>...`、`fact <file> <text>`）；dry-run 逐行 `git show upstream/dev:<file>`，列须在该表 `CREATE TABLE` 块内以列名开头，没有事实行即失败；`--apply` 只改写第 1 行。
  - launchd：`launchd/com.wetamp.superagent.supervise-tick.plist.tmpl`（`__HOME__`、`__REPO__`、`__PATH__`，XML 转义后代入；PATH = bun 目录 + 安装时 PATH，tick 触发的 resume 要找到各家 CLI）；`install.sh` 渲染到 `SA_LAUNCHD_DIR`（默认 `~/Library/LaunchAgents`），相同不动、不同先备份再覆盖，只打印 `launchctl bootstrap/bootout`；selftest 与测试把目录指到临时目录。
  - 预算（硬规则 7）由 1500/300/25 调为 TS 1800 行、shell 400 行、文件 28 个（R2 TS 调为 2000）。
  - N1（R2）：同一份评审出现重复 finding ID 即 `escalate invalid_review`；关闭判定中同 ID 的 open 优先于 closed。

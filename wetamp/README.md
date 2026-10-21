# superagent（wetamp/）

Archon 之上的 superagent 胶水层：把 `plan.json` 编译成 Archon 工作流，用 `archon workflow run --detach` 执行，
外加崩溃恢复、评审轮次门禁、人工签收与合入命令。`wetamp/FORK` 精确登记仓库其余部分相对 upstream 的有意修改。
设计见 [`docs/00-architecture.md`](docs/00-architecture.md)，与旧版命令的对照见 [`docs/03-parity-matrix.md`](docs/03-parity-matrix.md)。
设计原则以 [`templates/.archon/principles.md`](templates/.archon/principles.md) 为单一来源，生成时统一前置到所有 AI 节点的命令提示。

## 安装

前提：`bun`、`git`、`jq`、`sqlite3`，以及在仓库根执行过 `bun install`。`install.sh` 在 root workspace 的唯一 `bun.lock` 下装 board 用的 ink/react（失败只警告，其余动词不依赖它们）。

```bash
wetamp/scripts/install.sh          # 幂等：写 $ARCHON_HOME/.env 与 config.yaml 的别名段（先备份），渲染 launchd plist，末尾跑 archon doctor
ln -s "$PWD/wetamp/bin/superagent" ~/.local/bin/superagent   # PATH 接法，手动做一次
wetamp/scripts/selftest.sh         # 显式运行真实模型契约诊断；run/quick/land 不要求 selftest 回执
```

`install.sh` 把 `launchd/com.wetamp.superagent.supervise-tick.plist.tmpl` 渲染到 `~/Library/LaunchAgents`（每 60 秒跑 `supervise-tick`，日志 `$SUPERAGENT_HOME/supervise-tick.log`；内容变了先备份再覆盖），只打印 `launchctl bootstrap/bootout` 命令，加载由人执行。

状态目录 `SUPERAGENT_HOME`（默认 `~/.superagent`），Archon 状态在 `ARCHON_HOME=$SUPERAGENT_HOME/archon`。
默认安装记录 `controller`，`install.sh --remote-hooks` 记录 `worker`；CLI `health` 与 run preflight 明确报告模式，worker 不启动 run。hook 安装保留用户其他 hooks 与未管理字段；shell hook 只是辅助检查，不是沙箱。
模型池真源是 `wetamp/tiers.json`；改完重跑 `install.sh`。正式 selftest 先让真实 provider 正常完成，再对确定性 bash 节点注入故障验证恢复；不会杀掉真实 provider 后自动豁免未知效果。`selftest.sh --fake` 不调用模型，只用于测试本层。需要诊断升级或配置漂移时显式执行不带 `--fake` 的 selftest；验收脚本的安装状态使用独立临时 `XDG_STATE_HOME`。

## 日常：run → wait → land

plan 的目标 repo 必须位于 `SUPERAGENT_WRITE_ROOTS`（冒号分隔，默认 `~/work`）下，格式见 `schemas/plan.schema.json`
（示例 `tests/fixtures/plan-two-pkgs.json`：`repo`、`base_ref`、`packages[]`，可选 `deadline`、`budget`，包可带 `milestone`、
`signoff: "human"`；可选 `console: "codex"`）。
包可设 `review: true` 请求里程碑评审；G2、strict 或验收有效风险升到 G2 必须评审，其余默认主控实测，gate 标记 `TESTED`。

小活用 `superagent quick --goal "修复启动错误" --accept "bun test tests/start.test.ts" --scope "src/**" --scope "tests/**"`，
`run` 和 `quick` 默认拒绝同仓库写范围重叠（包括已执行完但 `delivery_result` 非 integrated 的 run），状态或历史 plan 不可读也按无法判定拒绝；可用 `--allow-overlap "具体原因"` 显式放行，原因保存到 ledger 的 `allow_overlap`。历史 plan 优先读取 gen_dir/plan.json，否则相对 ledger.repo 解析。此参数不绕过 SQLite-only 等其他启动检查，不自动排队或重试。
`--accept`、`--environment` 与 `--scope` 可重复；`--environment <cmd>` 将环境准备写入 plan 顶层并复用于 run 与 land，超时沿用 `--accept-timeout`。默认单包、单里程碑、size S、risk G1，预算默认 observe、无 token 上限，不附加 deadline，单条验收超时 900 秒。
repo 默认 cwd 所在 git 根，base 默认当前分支，可用 `--repo <path>`、`--base <ref>` 覆盖；默认写范围 `**/*`，建议显式收窄 scope。
验收默认 `cache:true`，依赖时间、随机性或外部写入的命令须加 `--no-cache`；`--risk G0|G1|G2` 声明风险，`--review` 请求评审，`--json` 输出与 run 同形。
生成的 plan 先校验，保存在 `$SUPERAGENT_HOME/plans/quick-<ts>.json`，再走 run 的同一启动路径；p50 预算与 deadline 预测不足只警告，仅显式 hard 预算执行 budget floor 合计校验。
默认单包；多包只在可独立验收且可并行或风险不同时拆；不按文件或步骤拆；小活用 quick。

元帅推荐用 `superagent quick --card /path/card.md --accept "bun run test" --accept-timeout 900 --review --console codex --repo /path/repo --base feature-branch --scope "src/**" --json`，再 `superagent wait <run_id> --timeout 1500` 等终态；卡片须含问题、价值、时机、目标、不变量与验收。卡片完整内容冻结进 plan，`--card` 与 `--goal` 互斥；`--accept-timeout` 为每条验收命令的正整数秒数，默认 900。编码、评审、修复复用现有至多 6 轮 workflow，`--review` 使用现有 strict 门禁，实际评审模型必须不同于所有实际作者，不能降级为 `DEGRADED_PASS`；G2 原有自动独立评审不变，模型池只在 `tiers.json` 配置。`--console` 可选，未传保留原来的 Claude 路由；`--repo`/`--base` 可承接已有提交，但引擎仍新建隔离 worktree，不直接复用脏工作区。仅调研等辅助工作用 `job exec`，不要逐轮手工派修复与评审。

```bash
superagent run plan.json                 # 立即返回 {run_id, archon_run_id, branch, gen_dir}
superagent wait <run> --timeout 3000     # 阻塞到终态或需要处理；owner 丢失会自动 recover 后续等
superagent brief <run>                   # ≤20 行接手摘要：状态、各轮 gate 结论、评审债、恢复次数
superagent land <run>                    # 打印本地合入命令（switch + merge）；由人执行，从不 push
superagent board                         # 终端看板（Ink）：全部 run 的状态/进度/held 原因，Enter 看详情；--once 打一帧，--json 出数据
superagent job exec --title t -- cmd...  # 登记直接派出的后台作业，board 活动区可见；退出码透传、信号转发
superagent jobs [--all]                  # 列出登记作业（默认 running 与 1h 内结束的）；查询只读、保留历史；lost 仅为显示投影
```

本地 delivery 允许目标分支沿启动 HEAD 正常前进：同 base 工作包在目标锁下按实时 tip 组合验收并串行集成，receipt 的 `target_tip` 记录实际验收基准，原启动目标身份保留；目标历史重写仍拒绝，push 始终由人执行。

将军默认最大权限，只有执行层红线是硬边界；`caps` 用于收紧（plan 级，`packages[].caps` 覆盖），未写的项保持全开：

```json
{
  "caps": { "network": false, "install": false, "git": "commit" },
  "packages": [
    { "id": "docs", "scope": { "write": ["docs/**"] }, "caps": { "read": "scope", "web": false } }
  ]
}
```

Claude 节点上 `network`/`web`/`install`/`services`/`git` 的收紧落成禁用工具，其余（含 Codex 节点）只写进任务书「你的权限」。
环境与编码/修复/评审节点通过 Archon 原生 `retry` 使用 `tiers.json` `policy.auto_retry`；原生重试结束后只接受明确决定。
将军在输出里写 `needs[]` 时保持 held 交人。`superagent decide --all-held retry` 一次重试所有 held（签收门除外）。

所有命令输出 JSON（`--json` 可加可不加）。退出码：0 completed、1 failed、2 cancelled、3 held（待决策）、4 running、
5 别名漂移（`$ARCHON_HOME/config.yaml` 或目标 repo `.archon/config.yaml` 的 `@sa-*` 别名与 `tiers.json` 不一致，run 拒绝启动，
`health --cwd <repo>` 同一检查；重跑 `install.sh` 或删掉 repo 里的 `@sa-*` 覆盖）、64 用法错误（含未知参数）。
run 启动时把具体模型（含 effort）写进 `gen/<run>/run-config.yaml` 并经 `workflow run --config` 钉进 run，之后改配置不影响已启动的 run。

`wait`/`status` 返回 held 时按 `state` 处理：

| state              | 含义                                                                      | 动作                                                                                      |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `held:human`       | 里程碑等待人工签收                                                        | `superagent decide <run> approve` 或 `reject`（reject = 终止 run）                        |
| `held:environment` | plan 的 environment 检查失败                                              | 修好环境后 `superagent decide <run> retry`                                                |
| `held:gate`        | MAX_ROUNDS（默认 6）轮内评审未通过（escalate，见 `gate` 字段的 `reason`） | 看 `needs`，`superagent decide <run> retry [--pkg <id> --hint "提示"]` 再来一轮，或手工修 |
| `held:paused`      | 其它暂停                                                                  | `superagent resume <run>`                                                                 |
| `failed`           | 节点失败（`node`、`error`）                                               | `superagent decide <run> retry [--pkg <id> --hint "提示"]`（hint 写入下次编码的 brief）   |

其它动词：`status <run>`、`cancel <run>`、`recover <run>`（显式恢复已确认 owner 离线的 run；未知副作用须先对账）、`accept <run> [--pkg id]`
（在 run 的 worktree 里重跑验收命令）、`report`（默认摘要：总体指标、unknown/unreadable 计数与下一步；`--json` 同样默认摘要，`--full` 获取全部明细）、
`health`（doctor + 别名 + upstream 差异符合 `wetamp/FORK`）、`supervise-tick`（由单个 launchd/cron 作业调用：观察、到期终止、原生审批与历史签收提问桥接）。

## 跨元帅交接

```bash
superagent owner [<path>|<run>] --json
superagent claim [<path>|<run>] [--takeover --reason "用户原话"]
superagent release [<path>|<run>]
superagent handoff --to <path|run> --kind bug --title "短标题" --body-file details.md [--evidence proof.json] [--severity urgent]
superagent inbox [--all]
superagent inbox --ack <id> accepted|rejected|done --note "短文"
```

发现其他负责人仓库的问题，先 handoff；owner online/unknown 时普通 claim 会被拒，显式接管需要用户授权原话。
wait 收到交接会返回 `inbox`（退出码 3），先 `inbox --ack` 答复。缺 controller/launcher 的旧 run 不自动处置，先 claim，再显式 resume/decide。
terminal adopt/retry 只接受已提交且干净的引擎，ledger 记录 engine_commit。模型、路由和边界见 [COORD 设计](docs/2026-10-11-cross-controller-coordination.md)。

## 清理

```bash
wetamp/scripts/gc.sh [run...]            # dry-run：列出可清理的 run 与跳过原因
wetamp/scripts/gc.sh --apply [run...]    # 删除 completed/cancelled 且分支已合入目标分支的 run 的 worktree、本地分支、gen/、ledger
"$PWD/wetamp/bin/archon" workflow cleanup 30     # Archon 自己的终态 run 记录（可选）
```

gc 不删远端分支、不 `--force`；未合入的分支原样保留并提示。

## 升级 upstream

```bash
wetamp/scripts/upgrade-upstream.sh           # dry-run：fetch upstream dev，核对引擎事实与本机 archon.db 列，打印计划
wetamp/scripts/upgrade-upstream.sh --apply   # 在当前分支 merge --no-ff upstream/dev，校验差异符合 wetamp/FORK，改写 wetamp/UPSTREAM
```

`--apply` 不提交 UPSTREAM、不 push。新增有意 fork 补丁须在同一提交登记到 `wetamp/FORK`。之后按提示执行 `bun install --frozen-lockfile`、`cd wetamp && bun test`、
`wetamp/scripts/selftest.sh`，通过后提交 `wetamp/UPSTREAM`。dry-run 报 “no longer mentions …” 说明 `recover`
依赖的引擎事实变了，先读 `src/archon.ts` 的 `recover()` 再升级。

## 故障排查

- `preflight: no valid selftest receipt: <原因>`（无回执 / fake / 过期 / HEAD 漂移 / 配置漂移）：跑 `wetamp/scripts/selftest.sh`（不带 `--fake`；这是显式诊断错误，不阻断普通 run）。`--fake` 只写 `selftest-fake.json`，不算回执。
- `plan invalid: repo … outside allowed roots`：把 repo 放到 `~/work` 下，或设置 `SUPERAGENT_WRITE_ROOTS`。
- `generated workflow invalid`：`install.sh` 未跑或 `config.yaml` 缺 `@sa-coder`/`@sa-reviewer` 别名；重跑 `install.sh`。
- run 停在 running 但进程在别的机器：`recover` 拒绝（`owner alive or on another host`），到那台机器处理。
- `superagent health` 报 `reason:"upstream_dirty"`：仓库差异不符合 `wetamp/FORK`（未登记路径或 `stale: <path>`），默认 `upstream_file_count` 给出条目数；用 `superagent health --verbose` 查看 `upstream_files`，确认改动归属后再处理。检查脚本失败另报 `reason:"upstream_check_failed"`，不冒充干净。
- `superagent health` 报 `capability_drift`：能力映射引用的外部技能缺失；安装对应技能或更新 `capabilities.json` 后复查。缺失能力不会注入节点上下文，也不改变 run 准入。
- 节点日志：`brief` 输出的 `evidence:` 目录；对话转录：ledger 的 `transcript`。

# Native conversation intake

`install-hooks` merges managed `intake.cjs` handlers into Claude Code and Codex
`UserPromptSubmit` / `SessionStart`; unrelated native settings and hooks remain intact.
Installation is an operator action from a clean committed checkout.

Opt in explicitly with `superagent intake apply <payload.json>` (or `apply -` for
a stdin envelope `{ "input": { ... }, "actions": [ ... ] }`). Create a Task using
the canonical realpath git main directory as `input.repo`, native client name
(`codex` or `claude`) as `input.source`, and native `session_id` as `input.session`.
The registered Task input binds actor/owner to that native session. Capture in an
unbound or ambiguous session gets an advisory rather than borrowing another owner's identity;
a new session must explicitly register its Task association. Cross-owner changes
use the existing handoff protocol. Worktrees, derived/worker/reviewer/twin sessions,
and projects without registered Tasks do not capture or inject intake context.

Capture only persists input; it does not dispatch or cancel Runs. Hook output includes
input keys, bounded current briefs/owners and pending pointers, never the raw prompt.
`SessionStart` restores context without receiving a new input. The commander interprets
with typed `apply`; status-only replies use `actions: []` to consume input without
creating a Task. Answer/amend the associated Task and continue original work unless
explicitly cancelled. Use `intake show` / `input` for full local bodies.

After a native compact, commander sessions also receive a bounded resume card built from
the validated native transcript path. Derived sessions and other `SessionStart` sources
produce no resume-card output.

Codex deduplicates by native `turn_id`; identical text in a new turn remains distinct.
Claude uses a random ID per hook invocation: retransmissions across invocations cannot
be precisely deduplicated. Missing fields or persistence failure produce a bounded
advisory and allow the original prompt. Orca automatic events remain `unknown`;
use the explicit `intake receive|apply -` stdin envelope, not private chat/transcripts.

### Plan 类型

`schemas/plan.schema.json` 是 wire 结构的唯一来源；运行时仍使用 Ajv 与既有后校验。
修改 schema 后运行 `bun run --cwd wetamp generate:plan-types`，提交生成的
`src/plan-types.generated.ts`；`bun run --cwd wetamp check:plan-types` 只读检查漂移。
从仓库根目录执行 `bun install --frozen-lockfile --ignore-scripts`，依赖与锁文件由 root workspace 管理。

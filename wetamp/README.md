# superagent（wetamp/）

Archon 之上的 superagent 胶水层：把 `plan.json` 编译成 Archon 工作流，用 `archon workflow run --detach` 执行，
外加崩溃恢复、评审轮次门禁、人工签收与合入命令。只改 `wetamp/`；仓库其余部分与 upstream 保持零差异。
设计见 [`docs/00-architecture.md`](docs/00-architecture.md)，与旧版命令的对照见 [`docs/03-parity-matrix.md`](docs/03-parity-matrix.md)。

## 安装

前提：`bun`、`git`、`jq`、`sqlite3`，以及在仓库根执行过 `bun install`。`install.sh` 另在 `wetamp/` 里按 `wetamp/bun.lock` 装 board 用的 ink/react（失败只警告，其余动词不依赖它们）。

```bash
wetamp/scripts/install.sh          # 幂等：写 $ARCHON_HOME/.env 与 config.yaml 的别名段（先备份），渲染 launchd plist，末尾跑 archon doctor
ln -s "$PWD/wetamp/bin/superagent" ~/.local/bin/superagent   # PATH 接法，手动做一次
wetamp/scripts/selftest.sh         # 真实模型跑一次契约自检；run 要求 7 天内有通过记录
```

`install.sh` 把 `launchd/com.wetamp.superagent.supervise-tick.plist.tmpl` 渲染到 `~/Library/LaunchAgents`（每 60 秒跑 `supervise-tick`，日志 `$SUPERAGENT_HOME/supervise-tick.log`；内容变了先备份再覆盖），只打印 `launchctl bootstrap/bootout` 命令，加载由人执行。

状态目录 `SUPERAGENT_HOME`（默认 `~/.superagent`），Archon 状态在 `ARCHON_HOME=$SUPERAGENT_HOME/archon`。
模型池真源是 `wetamp/tiers.json`；改完重跑 `install.sh`。`selftest.sh --fake` 不调用模型，只用于测试本层。

## 日常：run → wait → land

plan 的目标 repo 必须位于 `SUPERAGENT_WRITE_ROOTS`（冒号分隔，默认 `~/work`）下，格式见 `schemas/plan.schema.json`
（示例 `tests/fixtures/plan-two-pkgs.json`：`repo`、`base_ref`、`deadline`、`budget`、`packages[]`，包可带 `milestone`、
`signoff: "human"`；可选 `console: "codex"`）。

```bash
superagent run plan.json                 # 立即返回 {run_id, archon_run_id, branch, gen_dir}
superagent wait <run> --timeout 3000     # 阻塞到终态或需要处理；owner 丢失会自动 recover 后续等
superagent brief <run>                   # ≤20 行接手摘要：状态、各轮 gate 结论、评审债、恢复次数
superagent land <run>                    # 打印本地合入命令（switch + merge）；由人执行，从不 push
superagent board                         # 终端看板（Ink）：全部 run 的状态/进度/held 原因，Enter 看详情；--once 打一帧，--json 出数据
```

将军默认最大权限，只有执行层红线是硬边界；`caps` 用于收紧（plan 级，`packages[].caps` 覆盖），未写的项保持全开：

```json
{ "caps": { "network": false, "install": false, "git": "commit" },
  "packages": [{ "id": "docs", "scope": { "write": ["docs/**"] }, "caps": { "read": "scope", "web": false } }] }
```

Claude 节点上 `network`/`web`/`install`/`services`/`git` 的收紧落成禁用工具，其余（含 Codex 节点）只写进任务书「你的权限」。
held:gate、held:environment 与编码节点失败由 `supervise-tick` 按 `tiers.json` `policy.auto_retry` 自动重试；将军在输出里写
`needs[]` 时保持 held 交人。`superagent decide --all-held retry` 一次重试所有 held（签收门除外）。

所有命令输出 JSON（`--json` 可加可不加）。退出码：0 completed、1 failed、2 cancelled、3 held（待决策）、4 running、
5 别名漂移（`$ARCHON_HOME/config.yaml` 或目标 repo `.archon/config.yaml` 的 `@sa-*` 别名与 `tiers.json` 不一致，run 拒绝启动，
`health --cwd <repo>` 同一检查；重跑 `install.sh` 或删掉 repo 里的 `@sa-*` 覆盖）、64 用法错误（含未知参数）。
run 启动时把具体模型（含 effort）写进 `gen/<run>/run-config.yaml` 并经 `workflow run --config` 钉进 run，之后改配置不影响已启动的 run。

`wait`/`status` 返回 held 时按 `state` 处理：

| state                      | 含义                                                    | 动作                                                                                    |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `held:human`               | 里程碑等待人工签收                                      | `superagent decide <run> approve` 或 `reject`（reject = 终止 run）                      |
| `held:environment`         | plan 的 environment 检查失败                            | 修好环境后 `superagent decide <run> retry`                                              |
| `held:gate`                | 3 轮内评审未通过（escalate，见 `gate` 字段的 `reason`） | `supervise-tick` 已自动重试过（带提示）；仍 held 时看 `needs`，`superagent decide <run> retry [--pkg <id> --hint "提示"]` 再来一轮，或手工修 |
| `held:paused`              | 其它暂停                                                | `superagent resume <run>`                                                               |
| `held:recover_no_progress` | owner 丢失后连续 3 次恢复都没有新完成的节点             | 查 `brief` 的证据后 `superagent decide <run> retry`（显式重置计数）或 `cancel`          |
| `failed`                   | 节点失败（`node`、`error`）                             | `superagent decide <run> retry [--pkg <id> --hint "提示"]`（hint 写入下次编码的 brief） |

其它动词：`status <run>`、`cancel <run>`、`recover <run>`（只恢复本机 pid 已死的 run）、`accept <run> [--pkg id]`
（在 run 的 worktree 里重跑验收命令）、`report`（全部 run 的状态、评审轮次、一次通过率、失败分类、节点耗时、评审债、恢复次数）、
`health`（doctor + 别名 + upstream 零差异）、`supervise-tick`（由单个 launchd/cron 作业调用：wake、owner-lost 恢复、签收提问桥接）。

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
wetamp/scripts/upgrade-upstream.sh --apply   # 在当前分支 merge --no-ff upstream/dev，校验零差异，改写 wetamp/UPSTREAM
```

`--apply` 不提交 UPSTREAM、不 push。之后按提示执行 `bun install --frozen-lockfile`、`cd wetamp && bun test`、
`wetamp/scripts/selftest.sh`，通过后提交 `wetamp/UPSTREAM`。dry-run 报 “no longer mentions …” 说明 `recover`
依赖的引擎事实变了，先读 `src/archon.ts` 的 `recover()` 再升级。

## 故障排查

- `preflight: no passing selftest within 7 days`：跑 `wetamp/scripts/selftest.sh`（或临时 `run --skip-selftest`）。
- `plan invalid: repo … outside allowed roots`：把 repo 放到 `~/work` 下，或设置 `SUPERAGENT_WRITE_ROOTS`。
- `generated workflow invalid`：`install.sh` 未跑或 `config.yaml` 缺 `@sa-coder`/`@sa-reviewer` 别名；重跑 `install.sh`。
- `held:recover_no_progress`：worker 反复被杀且节点无进展；看 `$SUPERAGENT_HOME/runs/<run>.json` 的 `log` 指向的 detach 日志，排除原因后 `superagent decide <run> retry`（`recover`/`resume` 不重置计数）。
- run 停在 running 但进程在别的机器：`recover` 拒绝（`owner alive or on another host`），到那台机器处理。
- `superagent health` 的 `upstream_clean` 不是 `true`：仓库 `wetamp/` 之外有改动，用 `git checkout -- <file>` 还原。
- 节点日志：`brief` 输出的 `evidence:` 目录；对话转录：ledger 的 `transcript`。

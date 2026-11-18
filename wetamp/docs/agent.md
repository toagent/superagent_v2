# superagent Agent 参考

本文只说明调用路径与处置动作。所有输出均为 JSON；字段和参数以 CLI 帮助为准。

## 选择入口

- 单包、小范围交付：`superagent quick --card <card.md> --accept "<cmd>" --scope "<glob>"`。
- 多包、依赖或不同门禁：先写 plan，再运行 `superagent run <plan.json>`。
- plan 外的一次性调研或评审：`superagent job exec --role general --title <title> -- <cmd>`。

`quick` 仍会生成并冻结 plan，后续生命周期与 `run` 相同。不要用 `job exec` 代替有
交付验收的工作包。

## 全局工作入口

当前 AI 可用结构化检索词定位跨项目事实，或读取全局待决队列：

```bash
superagent work find --terms-json '["功能词","错误码"]' --json
superagent work queue --json
```

`find` 只检索 `export --all-repos` 的当前投影；`queue` 只投影 `cockpit.needs`。返回的
action descriptor 供 AI 选择现有 `ask answer` 或 `inbox --ack` 控制入口，不直接执行动作，
也不代表 commit、合入、push 或部署能力。

## 主流程

```bash
superagent plan check <plan.json>
superagent run <plan.json>
superagent wait <run> --timeout <seconds>
superagent brief <run>
superagent land <run> --apply
superagent retro <run> --effect "<本次效果>" --improve "<下次改进>"
```

`run` 创建隔离 worktree 后立即返回。`wait` 阻塞到终态、挂起或超时；超时返回运行中，
再次等待即可。接手时先用 `brief` 读取有界摘要，需要完整投影再用
`superagent status <run>`。`land --apply` 在目标锁内以目标分支实时 tip 组合验收并本地集成，
不 push；目标历史重写、脏检出或无法安全组合时拒绝。

run 终态并完成 land/验收后提交复盘。`--effect` 与 `--improve` 各 1–3 条，可重复传入；
全部条目去除首尾空白后合计不超过 200 个 Unicode 字符。重复提交会修订并保留最近 5 版历史。

已有 run 因范围批准需要后续包时，修订 plan 后使用
`superagent run <plan.json> --adopt <run>`，保留可验证的交付链。

## plan.json

最小结构：

```json
{
  "repo": "/absolute/repo",
  "base_ref": "feature-branch",
  "packages": [
    {
      "id": "api",
      "title": "完成 API 行为",
      "goal": "可验收的结果",
      "scope": { "write": ["src/**"], "read_hint": ["tests/**"] },
      "accept": [{ "cmd": "bun test tests/api.test.ts" }],
      "risk": "G1",
      "size": "S"
    }
  ]
}
```

必填顶层字段是 `repo`、`base_ref`、`packages[]`。每个包必须有 `id`、`title`、
`goal`、`scope.write`、`accept`、`risk`、`size`。常用可选字段：

- `deps` 声明包依赖；`milestone` 把包归入同一交付批次；
- `max_net_lines` 限制非测试、非生成代码的净增行数；
- `budget_min` 可为包内将军节点声明正整数分钟预算；缺省按 `size` 使用 S=30、M=45、L=60；
- `signoff:"human"` 声明人工签收；`review_reason` 保存用户要求独立评审的原话；
- `environment` 在派发前运行环境检查，可位于顶层或包内；
- `console` 选择评审路由池；`mode` 选择已支持的路由模式；
- `request_ref` 关联外部请求；`caps` 收紧执行能力；
- `scope.read_hint` 给出优先读取路径，不扩大写范围。

完整结构以 `schemas/plan.schema.json` 为准。将军节点到达时间预算后由 `supervise-tick`
按近期工作树进展续租一次；超限只写交回报告并唤醒一次 `wait`，不会取消或暂停 run。

## 评审

只有实际 diff 命中 `tiers.json` 的 `policy.risk_paths`，或用户本轮明确要求时才触发独立
评审。`quick` 用 `--review-reason` 保存用户原话：

```bash
superagent quick --card <card.md> --accept "<cmd>" --scope "<glob>" --review-reason "<用户原话>"
```

plan 包使用非空 `review_reason`。`risk:"G2"`、`mode:"strict"` 和 `review:true` 本身不触发评审。

## 退出码

|  码 | 含义     | 动作                                     |
| --: | -------- | ---------------------------------------- |
|   0 | 完成     | 检查交付回执                             |
|   1 | 失败     | 看 `brief` 的失败节点与证据，修复或重试  |
|   2 | 取消     | 核对取消来源                             |
|   3 | 待决策   | 按 `state`、`reason`、`next_action` 处置 |
|   4 | 运行中   | 继续 `wait`                              |
|   5 | 别名漂移 | 运行 `health`，重跑安装或移除 repo 覆盖  |
|  64 | 用法错误 | 按紧凑帮助修正参数                       |
|  75 | 暂拒启动 | 未创建 run，稍后重试同一启动命令         |

## 状态处置

`brief` 和 `status` 返回的 `next_action` 是当前状态的处置入口；动作前先核对 owner 与证据。

| 状态                                                       | 含义                       | 常用动作                                        |
| ---------------------------------------------------------- | -------------------------- | ----------------------------------------------- |
| `held:human`                                               | plan 声明人工签收          | `superagent decide <run> approve` 或 reject     |
| `held:environment`                                         | 环境检查失败               | 修好环境后 `superagent decide <run> retry`      |
| `held:gate` / `held:scope` / `held:rework`                 | 验收、范围或返工需要决定   | 按证据 approve，或带包与提示 retry              |
| `held:paused`                                              | 显式暂停                   | `superagent resume <run>`                       |
| `held:target_dirty` / `target_dirty`                       | 目标检出有操作者改动       | 清理归属后重新 land                             |
| `held:owner_unknown` / `owner_lost`                        | 执行 owner 不明确或已丢失  | 先对账，再 recover                              |
| `held:recovery_admission_unknown` / `held:reclaim_pending` | 恢复接纳或回收续授权未确认 | 对账后 `recover --reconciled`；不确定就停下报告 |
| `held:engine_suspect`                                      | 引擎判定与验收矛盾         | 看 `brief` 证据，按引擎缺陷处理，不重跑规避     |
| `sync_conflict` / `target_advanced` / `review_stale`       | 实时目标 tip 无法直接组合  | 按 `next_action` 重同步或重验                   |

重试可缩小到包并附修复提示：

```bash
superagent decide <run> retry --pkg <id> --hint "<evidence-backed hint>"
superagent recover <run> --reconciled
superagent cancel <run> --reason superseded
superagent abandon <run> --reason "<reason>"
```

`cancel --reason` 只接受标签：unstated、superseded、replaced、deadline、operator、test、duplicate、obsolete、rejected。
`abandon --reason` 接受自由文本，用于终止 paused/failed 的 run。
`recover` 只接纳已确认失去 owner 且副作用完成对账的 run；live 或 unknown owner 会拒绝。
租约交回后可再次 `superagent wait <run>`，或显式执行 `superagent cancel <run> --reason operator`。

## 常见拒绝

- 写范围与未集成 run 重叠：先协调；确认可并行时用
  `superagent run <plan.json> --allow-overlap "<具体原因>"`。
- repo 不在允许根目录：调整 `SUPERAGENT_WRITE_ROOTS` 或使用允许路径。
- 别名漂移：运行 `superagent health --cwd <repo>`，再重跑 `install.sh` 或移除目标 repo 的别名覆盖。
- `scope_violation`：批准准确 diff，或把必要路径写进后续 plan 并 adopt；不要靠放宽验收掩盖。
- worker 角色：只能读取状态，回到 controller 启动和处置 run。

## 协作与用户决策

```bash
superagent owner <path>
superagent claim <path>
superagent claim <path> --takeover --reason "<用户授权原话>"
superagent release <path>
superagent handoff --to <path> --kind task --title "<title>" --body-file <file>
superagent inbox --wait --timeout <seconds>
superagent inbox --ack <id> accepted --note "<note>"
```

owner 离线时用普通 `claim`；在线或未知时不得自行接管。`wait` 因未答复的交接返回 3 时，先逐条 ack 再重新等待。需要用户选择时创建签名问询，
随后等待 inbox；通知通道不可用时保持挂起，在本地取得明确选择后回填：

```bash
superagent ask --source <source> --title "<title>" --body "<body>" --callback <ref> --expires-at <ISO8601> --option "yes=继续" --option "no=停止" --recommend yes --why "<理由>"
superagent ask status <id>
superagent ask answer <id> <option>
superagent notify --id <id> --title "<title>" --body "<body>"
```

问询也可用 `--spec <file>` 一次传入（不能与上面的字段参数混用）。标题与正文写清项目、事件、选项后果。`notify` 只发只读告警，不代替决策。

## 辅助入口

- `superagent jobs --all` 查看登记作业；
- `superagent models --mode auto` 查看路由模型；
- `superagent report --since <YYYYMMDD|ISO>` 查看运行质量与效率口径；
- 夜报在本机时间 02:00 后认领当天首轮，`superagent nightly-evolve` 可提前认领；`superagent report` 的 `latest_night_report` 指向最新文件。
- 夜报复用 `report` 的终态首次通过判定、验收通过包的加权 token 和逻辑 run 耗时。首次通过率单列操作者取消和被取代的 run。每包耗时是已集成 run 的总耗时除以包数。
- `attribution` 只使用派单时的特征。验收命令数和写范围 glob 数分为 0、1–3、4+ 三档。`failure_reasons` 按首次未通过 run 的包数统计原因占比，同一个包可计入多个原因。
- 夜报的 `models` 记录本地与远程提炼状态，`sources` 记录各来源试验结果。本地提炼通过 Archon 的 Pi provider，需要在 Pi 的 `models.json` 注册 `splash/qwen3.8-27b`，使用 `openai-completions` 和 `http://127.0.0.1:18081/v1`。本地注册缺失时，远程提炼仍可运行。
- 每个提炼来源记录 `no_output`、`schema_invalid`、`all_filtered`、`produced` 或执行状态，以及候选数量、过滤原因、模型、token 回执和工作流证据路径。缺失的用量回执保留为 `null`。
- `superagent memory import <file>` 接收候选数组（`id`、`merged_ids`、`content`）。可用 `applicability: "all"` 或非空标签数组覆盖原作用域。省略时保留现有范围，仅更新作用域会保留既有试验数据。实际写入前备份经验账本，合并成员保留历史并退出注入。超过 30 条可注入经验时拒绝整批。
- 注入按任务标题、目标、写范围与经验适用条件及正文的词面重合度排序，再按 Wilson 上界排序。临时仓库、fake run 和私有项目不纳入经验试验或夜报指标。
- `superagent debt list [--repo <path>] [--open] [--json]` 列出稳定债 ID；`superagent debt close <id>... --reason <text>` 显式关闭。计划包可用 `closes_debt: [<id>]` 在成功集成后关闭；
- `superagent quota` 查看当前配额投影；
- `superagent rollover start --reason "<reason>"` 创建会话换手令牌。

完整参数看 `superagent --help`；运维命令看 `superagent --help --all`。

## 1Password 凭据同步

每台机器先在普通 TTY 终端运行 `superagent secret init-op`，按返回命令把只读
`AI-Agents` 服务账号 token 存入本机钥匙串。导入或修改凭据后运行
`superagent secret sync --vault AI-Agents`；删除保管库条目后加 `--prune`，只清理由同步
创建的名字。AI jail 内禁止直接运行 `op`，也禁止 `secret set/rm/sync` 访问钥匙串。

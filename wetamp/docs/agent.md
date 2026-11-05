# superagent Agent 参考

本文只说明调用路径与处置动作。所有输出均为 JSON；字段和参数以 CLI 帮助为准。

## 选择入口

- 单包、小范围交付：`superagent quick --card <card.md> --accept "<cmd>" --scope "<glob>"`。
- 多包、依赖或不同门禁：先写 plan，再运行 `superagent run <plan.json>`。
- plan 外的一次性调研或评审：`superagent job exec --role general --title <title> -- <cmd>`。

`quick` 仍会生成并冻结 plan，后续生命周期与 `run` 相同。不要用 `job exec` 代替有
交付验收的工作包。

## 主流程

```bash
superagent plan check <plan.json>
superagent run <plan.json>
superagent wait <run> --timeout <seconds>
superagent brief <run>
superagent land <run> --apply
```

`run` 创建隔离 worktree 后立即返回。`wait` 阻塞到终态、挂起或超时；超时返回运行中，
再次等待即可。接手时先用 `brief` 读取有界摘要，需要完整投影再用
`superagent status <run>`。`land --apply` 在目标锁内以目标分支实时 tip 组合验收并本地集成，
不 push；目标历史重写、脏检出或无法安全组合时拒绝。

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
- `signoff:"human"` 声明人工签收；`review_reason` 保存用户要求独立评审的原话；
- `environment` 在派发前运行环境检查，可位于顶层或包内；
- `console` 选择评审路由池；`mode` 选择已支持的路由模式；
- `request_ref` 关联外部请求；`caps` 收紧执行能力；
- `scope.read_hint` 给出优先读取路径，不扩大写范围。

完整结构以 `schemas/plan.schema.json` 为准。预算阈值用于观测和报告，不作为准入或停机条件。

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

| 状态                                                 | 含义                      | 常用动作                                    |
| ---------------------------------------------------- | ------------------------- | ------------------------------------------- |
| `held:human`                                         | plan 声明人工签收         | `superagent decide <run> approve` 或 reject |
| `held:environment`                                   | 环境检查失败              | 修好环境后 `superagent decide <run> retry`  |
| `held:gate` / `held:scope` / `held:rework`           | 验收、范围或返工需要决定  | 按证据 approve，或带包与提示 retry          |
| `held:paused`                                        | 显式暂停                  | `superagent resume <run>`                   |
| `held:target_dirty` / `target_dirty`                 | 目标检出有操作者改动      | 清理归属后重新 land                         |
| `held:owner_unknown` / `owner_lost`                  | 执行 owner 不明确或已丢失 | 先对账，再 recover                          |
| `sync_conflict` / `target_advanced` / `review_stale` | 实时目标 tip 无法直接组合 | 按 `next_action` 重同步或重验               |

重试可缩小到包并附修复提示：

```bash
superagent decide <run> retry --pkg <id> --hint "<evidence-backed hint>"
superagent recover <run> --reconciled
superagent cancel <run> --reason "<reason>"
superagent abandon <run> --reason "<reason>"
```

`recover` 只接纳已确认失去 owner 且副作用完成对账的 run；live 或 unknown owner 会拒绝。

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
superagent claim <path> --takeover --reason "<用户授权原话>"
superagent release <path>
superagent handoff --to <path> --kind task --title "<title>" --body-file <file>
superagent inbox --wait --timeout <seconds>
superagent inbox --ack <id> accepted --note "<note>"
```

owner 在线或未知时不得自行接管。收到交接后明确 ack。需要用户选择时创建签名问询，
随后等待 inbox；通知通道不可用时保持挂起，在本地取得明确选择后回填：

```bash
superagent ask --source <source> --title "<title>" --body "<body>" --option "yes=继续" --option "no=停止"
superagent ask answer <id> <option>
superagent notify --id <id> --title "<title>" --body "<body>"
```

`notify` 只发只读告警，不代替决策。

## 辅助入口

- `superagent jobs --all` 查看登记作业；
- `superagent models --mode auto` 查看路由模型；
- `superagent report --since <RFC3339>` 查看运行质量与效率口径；
- `superagent quota` 查看当前配额投影；
- `superagent rollover start --reason "<reason>"` 创建会话换手令牌。

完整参数看 `superagent --help`；运维命令看 `superagent --help --all`。

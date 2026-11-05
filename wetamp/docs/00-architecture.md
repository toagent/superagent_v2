# superagent on Archon 架构

## 定位

Archon 拥有 DAG、run、attempt、retry、resume、approval、worktree 和终态。
`wetamp/` 是治理与交付层：验证 `plan.json`，生成工作流，把控制面动作映射到 Archon，
保存可审计回执，并在目标分支实时状态上完成本地集成。它不复制 provider 能力或运行状态机。

核心边界：

- `schemas/plan.schema.json` 是 plan wire 结构真源；生成类型由脚本维护；
- `tiers.json` 是模型、路由、effort、重试和风险路径真源；
- `src/reasons.ts` 是原因与处置类别真源；
- Archon 数据库是执行生命周期真源，superagent ledger 只保存控制面事实和证据指针；
- 目标仓库不接收生成工作流；运行源位于 `$SUPERAGENT_HOME/gen/<run>`。

## 分层

```text
plan / quick card
      |
      v
superagent CLI ---- plan 校验、准入、COORD、账本、状态投影
      |
      +---- 生成冻结工作流、命令、脚本、run-config
      |
      v
Archon workflow ---- worktree、节点执行、retry、approval、终态
      |
      +---- provider 原生 agent 配置与项目指导
      +---- 确定性 environment / accept / diff / integrate 节点
      |
      v
delivery receipt ---- 主控验收 ---- 目标锁内本地集成
```

provider SDK 与执行生命周期留在 Archon。wetamp 通过 CLI 和注入契约调用这些能力，
不直接操作核心数据库来制造状态。conversation、ntfy、console 只翻译输入和展示投影，
不能自行判定 run 完成。

## 状态与持久化

`SUPERAGENT_HOME` 默认为 `~/.superagent`，`ARCHON_HOME` 默认为
`$SUPERAGENT_HOME/archon`。

```text
$SUPERAGENT_HOME/
  archon/               Archon 配置、数据库、workspaces 与 artifacts
  gen/<run>/            冻结 plan、run-config、工作流和节点代码
  runs/<run>.json       控制面 ledger
  jobs/                 job exec 回执
  intake/               原生会话输入与 Task 绑定
  memory/               publication、候选与反思证据
```

ledger 记录 plan 身份、引擎身份、目标分支采样、允许的 overlap、intervention、delivery
和证据位置。状态投影同时读取 ledger 与 Archon run；字段缺失或无法确认时保留 unknown，
不得从日志文本猜成功、owner 或副作用。

原子写使用临时文件加 rename。run 启动时冻结 plan、具体模型与 engine identity；之后修改
配置不会重写在途 run。恢复只接受已确认失去 owner、通过 admission fence 且副作用完成对账的
执行；live 或 unknown owner 保持可见并拒绝接管。

## Plan 与生成

plan 顶层给出 repo、base、环境、路由和默认能力；package 给出目标、依赖、范围、验收、
风险、规模与门禁。生成器先做 schema、路径、依赖、重叠、环境和路由检查，再创建 run。

每个包的主路径是：

```text
environment -> code -> verify -> diff -> optional review/fix -> settle -> publish
```

包按 `deps` 拓扑执行，同一 run 共享一个隔离 worktree，因此写入串行。不同 run 使用不同
worktree。验收命令由确定性节点执行，退出码和产物进入回执；agent 自报不代替验收。
`requirements[].verified_by` 把需求映射到验收索引，交付决定必须覆盖声明的义务。

`environment` 在派发前运行。失败投影为 `held:environment`，修复环境后可重试，不修改产品
代码来掩盖环境问题。验收可使用缓存；时间、随机性或外部写入相关的检查应关闭缓存。

## 控制面等待与执行回执

`run` 只在启动锁、准入和冻结成功后返回 run identity。暂时无法启动时返回 75，表示没有
创建 run。`wait` 使用 Archon 的阻塞等待契约，返回终态、需要关注的状态或调用方超时，
不通过高频轮询伪造心跳。

节点回执包含命令、退出状态、持续时间、证据路径和身份信息。缺退出码时 pass 保持 null；
超时、信号和未知 provider 结果不能折算成普通失败或成功。控制面只依据结构化回执推进。

唯一周期控制任务是 `supervise-tick`。它观察到期等待、owner 状态和签名决策，应用已验证的
durable intent；它不把非终态工作标成失败，也不自动接管所有权不明确的 run。

## 评审与交付

独立评审由运行时事实触发：实际 diff 命中 `tiers.json policy.risk_paths`，或包有非空
`review_reason`。声明 risk、mode 或布尔 review 不单独触发。触发后评审模型必须不同于全部
实际作者；评审读取完整首轮证据，后续只核验遗留 finding 和本轮 diff。

冒烟或行为验收通过且核心目标完成即可形成交付决定。非阻断 finding 作为 debt 写入回执，
不要求为零。`signoff:"human"` 才生成显式人工签收节点。

delivery 先记录候选提交与启动目标身份。集成在目标锁内重新读取目标分支 tip，把候选与当前
tip 组合到临时检出并重跑要求的验收。目标分支沿原启动历史正常前进可以集成；历史重写、
目标检出变化、冲突、评审证据失效或操作者脏改动会明确停止。成功 receipt 记录实际
`target_tip`。`land` 只做本地合入，不 push。

## Caps 与动作护栏

将军默认拥有任务书允许的能力；`caps` 只能收紧。顶层 caps 作用于全部包，包级 caps 完整
覆盖顶层值。可收紧 network、web、install、services、long_tests、read、git 与 mcp。
scope 是预期写入合同：越界必须在结构化 deviations 中说明；命中风险路径的越界需要明确批准。

provider 保留用户原生配置、项目指导、skills、plugins 和 MCP。护栏在动作入口拒绝凭据与
隐私路径，以及不可逆破坏；未知命令只产生 advisory。git 危险判定集中在
`hooks/redline.cjs` 与 Archon checkout 所有权检查：force push、非授权 hard reset、删除宽泛
目录被拒绝；明确针对 Archon 自有 worktree 的恢复操作按专用模式执行。

护栏不是通用沙箱。shell 内部的间接效果仍由 provider 沙箱、任务 scope、diff 检查和交付
门禁共同约束。评审节点可写自己的临时证据，但不能修改被审检出。

## 挂起处置

`classifyRun` 把 Archon 状态与结构化证据投影为 CLI state。主要类别：

- `held:human`：等待声明的人工签收，使用 decide approve 或 reject；
- `held:environment`：环境检查失败，修复后 decide retry；
- `held:scope`、`held:rework`、`held:gate`：需要范围批准、返工或门禁决定；
- `held:paused`：显式暂停，使用 resume；
- `held:target_dirty`：目标检出含操作者改动，保持现场后处理；
- `held:owner_unknown`、`held:recovery_admission_unknown`：所有权或恢复接纳不明确，不接管；
- `held:reclaim_pending`：回收续授权仍在处理；
- `held:engine_suspect`：引擎状态与交付证据矛盾，保留证据并升级。

失败节点还可能投影 `sync_conflict`、`target_checkout_changed`、`target_advanced`、
`review_stale`。CLI 的 `next_action` 与 `src/reasons.ts` 的 hold action 是处置真源；文档不根据
错误文本重新分类。reject 终止 run，retry 可以指定 package 和 evidence-backed hint。

## 预算与报告

预算是观测合同。`weighted_tokens`、cost、launches、deadline 预测和 p50 用于预警、排序与
报告，不因达到阈值自动停止正常执行。明确的 package `max_net_lines` 是交付规模门禁，超限
需要签收或缩小实现。

`report` 从 ledger、Archon 事件、provider usage 和交付回执折叠 episode，展示完成率、耗时、
token、重试、人工决定、评审产出和 slow nodes。未知 usage、缺事件和不可读数据单独计数，
不填零。报告不回写生命周期，也不把本地成功表述为部署或外部确认。

## Hooks 安装

`scripts/install.sh --remote-hooks` 合并受管 handler 到 Claude Code 与 Codex 的原生 hook
配置，保留未管理字段；同时安装 worker 入口。安装使用锁、备份与原子发布，重复执行保持
相同结果。provider home 不被替换，项目 `AGENTS.md` 仍由 provider 原生机制加载。

默认 `scripts/install.sh` 只登记 controller、配置别名和 launchd 模板，不写原生 hooks。
安装台账决定 controller/worker；坏台账明确失败。详细动作与验证见
[`04-hooks-and-nesting.md`](04-hooks-and-nesting.md)。

## Upstream 维护

`wetamp/FORK` 精确登记相对 upstream 的有意差异，`wetamp/UPSTREAM` 钉住来源身份。
升级脚本默认 dry-run，应用模式合并 `upstream/dev` 并检查登记路径；它不提交、不 push。
新增差异必须同时登记，已无差异的登记会报告 stale。升级后重新安装依赖，运行 upstream
差异检查、wetamp 测试与真实 selftest，再提交来源身份。

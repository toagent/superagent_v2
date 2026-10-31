# 持续输入：显式 typed CLI 首片

元帅解释自然语言，再提交结构化动作；本模块不调用模型、不分类关键词、
不启动或取消 run。新增 Task 不会删除或抢占旧 Task。原生终端 hook 捕获已登记主检出的输入并恢复有界指针，不解释自然语言。

## 最短用法

在明确的项目内生成 `payload.json`（数据文件放 scratch/run 目录，不提交）：

```json
{
  "input": {
    "source": "codex",
    "session": "session-id",
    "message": "stable-message-id",
    "text": "本条项目需求",
    "repo": "/absolute/project/path",
    "actor": "operator",
    "owner": "commander"
  },
  "actions": [
    {
      "kind": "create",
      "ref": "a",
      "brief": "问题、价值、为什么现在、结果、不变量",
      "acceptance": "验收",
      "group": "g"
    },
    {
      "kind": "amend",
      "task": "$a",
      "expected_revision": 1,
      "brief": "更新后的完整合同",
      "acceptance": "新验收",
      "group": "g"
    },
    { "kind": "clarify", "fragment": "另一个片段需要确定目标" }
  ]
}
```

```sh
superagent intake receive /scratch/payload.json
superagent intake apply /scratch/payload.json
superagent intake list --repo /absolute/project/path
superagent intake show task-… --repo /absolute/project/path
superagent intake input codex session-id stable-message-id --repo /absolute/project/path
superagent intake context 8192 --repo /absolute/project/path
superagent intake resume 8192 --repo /absolute/project/path
```

`receive` 可单独持久接收待解释输入，`apply` 也会接收输入。相同 source/session/message
与相同 payload 返回原回执；改变输入或已解释 actions 会报冲突。不同 message 的相同
文字是新输入。`apply` 有 pending/rejected 动作时退出 3，已受理的独立动作仍保留。
`input` 只按精确身份读取一条输入及其 actions/结果；`show` 读取单个完整 Task。
数据唯一事实源位于 `$SUPERAGENT_HOME/intake/<repo-sha256>/state.json`。
state 损坏或版本不支持会报错，不重建为空。锁忙可用同一输入重试。

## 动作合同

- `create`：`ref/brief/acceptance`，可选 `parent/dependencies`；引用须存在且同 repo/actor/owner。
- `amend`：`task/expected_revision/brief/acceptance`，可选 `dependencies`；CAS 失败保留 rejected 动作。
- `clarify`：`fragment`，保留待澄清片段，不阻断独立动作。后续解释用新 message 提交，旧回执保持原样。
- `launch`：`task/expected_revision/launch_id/plan/digest`，只记意图，立即视为 `dispatch_unknown`。
- `bind`：`task/launch_id/run_id/plan/digest`，记录原 owner 确认的引擎受理回执；不允许一个 run 绑定多个 Task/revision。
- `question`：`task/expected_revision/id/run_id/gate/prompt`，run 必须已绑定该 revision。
- `answer`：`task/question/value`，只保存回答；旧问题仍关联原 revision/run/gate，一问不能被不同消息重复回答。
- `cancel`：`task/expected_revision`，只记显式取消意图，绝不宣称 run 已取消。

同句最多 64 动作。共享 `group` 的动作一起提交或一起回滚/等待澄清；`$ref` 只在
同组内引用先创建的 Task。replace 使用同组 create + 显式 cancel，不删除旧历史。
任务依赖不能跨 scope、引用未知 Task 或形成环。amend 保留旧合同与 run 绑定。

## 引擎边界与恢复

输入、预分配的确定性 TaskID、actions、Task 与结果在同一个短锁下原子替换。
进程在 rename 前退出不产生 Task，rename 后退出则重试返回已存结果，不重新 create。
恢复无需重新解释；`resume` 是有界视图，不是引擎 resume，也不会重发未知 launch。
context 默认 8192 字节（原生 hook 为 4096），允许 128..65536；元数据或最小指针装不下时报错。

派发/取消/回答 gate 由元帅通过既有 `run/cancel/decide` 和 COORD owner/handoff 执行。
intake 的 repo/actor/owner 是需求关联标签，不是另一个授权层。
保存回答不等于批准 gate，保存 cancel 不等于取消；context 保留问题及回答记录指针。
未知派发须先由原 owner 对账，再 bind；本片不自动对账、取消回执或清除待澄清历史。
`plan/digest` 使用真实冻结 plan 路径与 SHA-256，不回写冻结 plan。
`request_ref` 以测量 owner 兼容字段接入为后续工作，本片只显式绑定 Task/revision/run。

`show` 只读取既有引擎 ledger 与 deliveryDecision：同 repo、同 plan/digest、当前 revision、
run completed 且所有有效 decision 有证据与 verified requirement，并按当前 revision 的明确映射
覆盖全部义务、所有直接及间接 children 均 verified 才投影 `verified`。
旧版成功、证据缺失/不明、取消意图未对账均为 `unknown`。Task 不复制 Run 状态机。
未承诺全终端自动捕获、线上效果或端到端 exactly-once 派发；不新增模型调用或依赖。

聚焦验证：`rtk proxy bun test --cwd wetamp ./tests/intake.test.ts`；
静态检查：`rtk proxy bun x --no-install tsc --noEmit -p wetamp/tsconfig.json`。

## 追加义务与真实覆盖

`create/amend` 可带 `requirements: [{"id":"A","text":"用户义务原文"}]`。
数组非空且 ID 唯一；amend 不传则继承，传入须保留旧 ID 及其原文，只能追加。
澄清可更新 brief/acceptance；范围缩减须显式新建任务并记录原任务取消意图，
不允许静默改写义务。旧数据继续可读、可执行，无明确义务/映射时完成度为 unknown。

`launch` 可带非空子集映射：

```json
{ "requirement_map": [{ "task_requirement_id": "A", "package": "pkg", "requirement_id": "req" }] }
```

每个 binding 内源 ID 和目标 package/id 唯一；源必须属于当前 revision。
`bind` 不接受改映射。当前 revision 多个完成 run 的有效 DeliveryDecision 可按义务 ID
并集，但只接受真实冻结 plan 中存在且证据匹配的目标。部分覆盖、旧 revision、
不明证据不能证明完整交付；children 的取消意图不解除父子阻断。

## 完整有界遍历与进度

保留 `tasks/inputs/truncated`，新增 `coverage/next`。coverage.tasks/inputs 分别给出
固定读取上界内的 eligible `total`、本页 `shown`、尚未遍历 `remaining`、上界后的 `later`；
`coverage.obligations` 是当前 revision 未撤销 Task 的义务数，`coverage.total_obligations`
包含已撤销 Task 的义务。过大条目降为 id/key 短指针，
使用 show/input 查询正文。每页 JSON 严格受字节预算限制。

```sh
superagent intake context 4096 --repo /absolute/project/path
superagent intake context 4096 '<next>' --repo /absolute/project/path
superagent intake backlog --repo /absolute/project/path
superagent intake backlog task-parent --repo /absolute/project/path
```

重复消费 `next` 直到 null，再处理 `later`：重新开始一次遍历。游标绑定 repo、现有
append-only 数组上界与绝对位置；持续追加不重启遍历，条目正文仍是当前 revision。
历史缩短/重排或无效游标会明确报错；页末不能冒称最新全体任务已完成。

`backlog` 是同一 Intake 的只读进度投影，不额外持久化或调用模型；包含全部 Task、
父子关系、当前义务/覆盖 ID、completion 与 unknown 原因、questions、取消历史、show 指针。
摘要的 `obligations` 只统计当前 revision 未撤销 Task，`total_obligations` 包含已撤销 Task；
任务自身的当前撤销意图优先显示为 `cancelled_intent`，不被子任务的 unknown 状态覆盖。
可按父任务查看其整个子树。原生 hook 要求读完 continuation 后判断范围/生成进度，
进度以 backlog 为准；status-only 继续提交 `actions: []`，不缩小旧需求集合。

## ntfy 人工决策

`supervise-tick` 从当前引擎 gate 和 COORD/故障切换状态生成具名决策，持久化后发布到
ntfy。回答先校验签名、期限与一次性 nonce，再保存 durable intent；下一次持有
`supervise.lock` 的 tick 复核当前 owner generation 并应用。决定已变化时回执为
`rejected`，且不修改 asks。ntfy 或网络不可用时保持挂起，CLI 仍可处理。

普通决策提供具名选项；红线批准必须经过两段式确认。令牌与签名密钥只从 0600 文件
读取，不进入状态文件、命令行或错误。`report.human_decisions`、board 与 ntfy 发布从
同一当前引擎 gate 描述派生，历史 asks 仍保留。决策投递和回答统一由 ntfy 通道承担。

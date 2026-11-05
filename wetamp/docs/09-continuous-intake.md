# 持续输入与原生会话接入

intake 持久化原生会话输入、Task 合同与 run 绑定。元帅解释自然语言并提交 typed actions；
模块本身不调用模型、不匹配关键词、不启动或取消 run。捕获输入与执行动作分离，因此重试不会
把未确认派发冒充为已受理。

## 原生 hooks

`install-hooks` 把受管 intake handlers 合并到 Claude Code 和 Codex 的
`UserPromptSubmit`、`SessionStart`，保留其他原生设置与 hooks。安装由操作者从干净且已提交的
checkout 执行。

只捕获满足以下条件的会话：

- repo 是 canonical realpath 的 git 主检出；
- source 是原生客户端名，session 是原生 session id；
- 当前 session 已显式关联该 repo 的 Task owner；
- 不是 worktree、派生编码、评审、worker 或 twin 会话。

`UserPromptSubmit` 保存输入；`SessionStart` 只恢复有界 context。hook 输出包含 input key、
当前 brief、owner 和 pending 指针，不包含原始 prompt。绑定缺失或含糊时返回 advisory，不借用
其他 owner。捕获不派发、不取消、不审批。

Codex 用原生 turn id 去重；Claude 每次 hook invocation 生成独立 id。持久化失败会提示并允许
原 prompt 继续。compact 后，commander session 可从已验证的原生 transcript 路径取得有界
resume card；派生 session 不生成。

## 输入与动作

`receive` 只持久化输入，`apply` 接收输入并原子应用 actions：

```json
{
  "input": {
    "source": "codex",
    "session": "session-id",
    "message": "turn-id",
    "text": "项目需求",
    "repo": "/absolute/project/path",
    "actor": "operator",
    "owner": "commander"
  },
  "actions": [
    {
      "kind": "create",
      "ref": "task",
      "brief": "问题、价值、时机、结果与不变量",
      "acceptance": "验收",
      "group": "delivery"
    }
  ]
}
```

```bash
superagent intake receive /scratch/payload.json
superagent intake apply /scratch/payload.json
superagent intake list --repo /absolute/project/path
superagent intake show task-id --repo /absolute/project/path
superagent intake input codex session-id turn-id --repo /absolute/project/path
```

相同 source、session、message 与 payload 返回原回执；身份相同但内容不同会报冲突。不同 turn
中的相同文字是不同输入。`apply` 有 pending 或 rejected 动作时退出 3，已受理的独立 group
仍保留。state 位于 `$SUPERAGENT_HOME/intake/<repo-sha256>/state.json`；损坏或 schema 不支持
时明确失败，不重建为空。短锁忙可用同一 payload 重试。

动作合同：

- `create`：创建 Task；可声明 parent、dependencies 和 requirements；
- `amend`：以 expected_revision 做 CAS，保存完整修订；
- `clarify`：保留待澄清片段，不阻断独立 group；
- `launch`：保存 plan、digest 和 launch_id，初始状态是 `dispatch_unknown`；
- `bind`：由原 owner 把引擎受理的 run 绑定到 launch；
- `question` / `answer`：保存与 Task revision、run、gate 绑定的问题和回答；
- `cancel`：只保存显式取消意图，不宣称 run 已取消。

共享 group 的动作一起提交或一起回滚。`$ref` 只能引用同组先创建的 Task。依赖不得跨
repo、actor、owner，也不能形成环。amend 保留以前的 revision 和 run binding。

## 义务与完成投影

Task 可声明 `requirements: [{id,text}]`。amend 未传 requirements 时继承；传入时必须保留
既有 id 与原文，只能追加。范围缩减需要创建准确合同并为原 Task 保存取消意图。

launch 可以保存 requirement map，把 Task requirement id 映射到冻结 plan 的 package 与
requirement id。每个 binding 中源和目标唯一，bind 不能更改映射。

`show` 只在以下事实同时成立时投影 verified：repo、plan、digest 与当前 revision 一致；run
completed；DeliveryDecision 有真实 evidence；映射覆盖全部义务；全部直接和间接 child 均
verified。部分覆盖、取消意图、缺映射或证据 unknown 都不能证明完成。Task 不复制 Run 状态机。

## 有界恢复与 backlog

```bash
superagent intake context 4096 --repo /absolute/project/path
superagent intake context 4096 '<next>' --repo /absolute/project/path
superagent intake resume 4096 --repo /absolute/project/path
superagent intake backlog --repo /absolute/project/path
```

context 返回 tasks、inputs、coverage、next 与 truncated。游标绑定 repo、读取上界和绝对位置；
持续追加不会重启当前遍历。条目过大时降为 id/key 指针，用 show 或 input 读取正文。游标失效、
历史缩短或元数据无法放入最小预算时明确报错。

backlog 是同一 state 的只读进度投影，包含 Task 树、当前义务、覆盖 id、completion、unknown
原因、questions、取消记录和 show 指针。它不额外持久化，也不调用模型。status-only 输入用
`actions: []` 消费，不缩小既有需求。

## 引擎与决策边界

派发、取消和 gate 决定由 commander 使用 run、cancel、decide 与 COORD owner/handoff 完成。
intake 中的 repo、actor、owner 是关联标签，不是授权层。保存 answer 不等于批准 gate，保存
cancel 不等于取消 run；`dispatch_unknown` 必须由原 owner 对账后 bind。

`supervise-tick` 从当前 gate 和 COORD 状态生成签名决策，持久化 intent 后再由持锁 tick 复核
owner generation 并应用。决定已变化时拒绝 intent。ntfy 或网络不可用时保持挂起，CLI 仍可
处理；凭据只从权限受限文件读取，不进入状态、参数或错误。

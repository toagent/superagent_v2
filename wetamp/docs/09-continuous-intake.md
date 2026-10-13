# 持续输入：显式 typed CLI 首片

元帅解释自然语言，再提交结构化动作；本模块不调用模型、不分类关键词、
不启动或取消 run。新增 Task 不会删除或抢占旧 Task。自动终端输入 hook 尚未接入。

## 最短用法

在明确的项目内生成 `payload.json`（数据文件放 scratch/run 目录，不提交）：

```json
{
  "input": {
    "source": "codex", "session": "session-id", "message": "stable-message-id",
    "text": "本条项目需求", "repo": "/absolute/project/path",
    "actor": "operator", "owner": "commander"
  },
  "actions": [
    {"kind": "create", "ref": "a", "brief": "问题、价值、为什么现在、结果、不变量", "acceptance": "验收", "group": "g"},
    {"kind": "amend", "task": "$a", "expected_revision": 1, "brief": "更新后的完整合同", "acceptance": "新验收", "group": "g"},
    {"kind": "clarify", "fragment": "另一个片段需要确定目标"}
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
context 返回指针，默认 8192 字节，允许 128..65536，超限标记 `truncated`；正文按需读取。

派发/取消/回答 gate 由元帅通过既有 `run/cancel/decide` 和 COORD owner/handoff 执行。
intake 的 repo/actor/owner 是需求关联标签，不是另一个授权层。
保存回答不等于批准 gate，保存 cancel 不等于取消；context 保留问题及回答记录指针。
未知派发须先由原 owner 对账，再 bind；本片不自动对账、取消回执或清除待澄清历史。
`plan/digest` 使用真实冻结 plan 路径与 SHA-256，不回写冻结 plan。
`request_ref` 以测量 owner 兼容字段接入为后续工作，本片只显式绑定 Task/revision/run。

`show` 只读取既有引擎 ledger 与 deliveryDecision：同 repo、同 plan/digest、当前 revision、
run completed 且所有 decision 有证据与 verified requirement 才投影 `verified`。
旧版成功、证据缺失/不明、取消意图未对账均为 `unknown`。Task 不复制 Run 状态机。
未承诺全终端自动捕获、线上效果或端到端 exactly-once 派发；不新增模型调用或依赖。

聚焦验证：`rtk proxy bun test --cwd wetamp ./tests/intake.test.ts`；
静态检查：`rtk proxy bun x --no-install tsc --noEmit -p wetamp/tsconfig.json`。

# COORD：跨元帅归属与交接

## 问题与范围

多个交互式控制台曾共享同一工作树，却只有 launcher 记录，没有可执行的控制归属。另一个元帅可以 decide，直接改引擎后换版，supervisor 又能形成第二个无归属的变更入口。本包在 wetamp 文件台账中建立归属与交接，不改 Archon 数据库，也不把 git worktree 当成安全沙箱。

## 模型与归属

仓库 scope 是 `git-common-dir` 的 realpath，同一仓库所有 linked worktree 共享身份。run scope 保存 run ID 和仓库身份，默认继承仓库负责人；也允许明确认领 run。引擎仓库没有特殊规则。

身份是 `{client, session_id?, host, pid, pid_start}`。交互式 launcher 和 heartbeat 共享进程解析，GUI pane 没有 tty 仍可拥有身份。普通终端命令使用父 shell 的进程寿命。`general/strategist/reviewer/worker` 不认领、不控制。

归属顺序是 run/仓库显式 claim → 非终态 run 的 controller（缺失回退 launcher）→ 无主。释放写 tombstone，避免旧 run 将已释放的归属复活。多个不同 controller 是歧义状态：owner 列出 evidence/conflicts，普通 claim/handoff 拒绝；只有带原话 reason 的显式 takeover 可以消歧，并通知所有旧 owner。CJS resolver 同时供 CLI 与 hook 使用，hook 只读 ledger 和数据库状态，数据库无法读取时保留 unknown 证据。

claims 在 `$SUPERAGENT_HOME/coord/claims/<sha(scope)>.json`；包含 owner、generation、since、reason、history。registry flock 只包读改写短事务，同目录临时文件 rename；执行、claim、release、ack 另持仓库 scope flock，同仓库 run 串行，无关仓库互不阻塞。lease 保存身份获授的 generation。run、decide、cancel、resume、recover、land、accept 与自动恢复均校验当前 owner/lease；拒绝包含动作、原因、可选下一步三段。supervise-tick 以 ledger 的 controller/launcher 及 generation 执行，并在动作输出中携带身份；旧 owner 被接管后不得继续驱动。没有身份的旧 run 不自动处置，需先 claim，再由元帅显式 resume/decide 建立 controller。

ledger run_id 与 archon_run_id 先映射到同一 run scope，再走共享 `admission()`；adopt 按 `--adopt` 的 ID 沿用原 run scope，未指明目标的 `run --resume` 拒绝。wetamp Archon shim 与 hook 也使用该函数；查询保持开放。内部调用使用原子消费的一次性随机准入 token，同步调用与等待回执的 signal 还验证父 PID/start 与持锁事实，普通异步调用重新取得 scope 锁并验证 generation；不接受布尔旁路。tick 只逐 run 启动 scoped wake，复用原生 continuation 的 cursor/CAS 与 provider 配置，只缩窄到期 run 来源；禁止全局 wake/watch/schedule。

未登记的 Archon run 通过真实 `working_path` 定位仓库，同样经过认领和 fencing；不能定位时明确拒绝。只读 status/brief/owner/board/wait 不要求是 owner；wait 中的自动恢复仍是变更，必须校验。

## 在线三态

| state | 事实 | 动作 |
| --- | --- | --- |
| online | 本机 PID 存活且启动时间相同；beat 在 FRESH_MS 内是 active，否则 idle | 普通认领被拒，交接到 inbox |
| offline | 本机 PID 已不存在或启动时间不符 | 可认领；旧身份被 fencing |
| unknown | 其他 host、缺启动时间或无法验证 | 不自动接管，只允许用户显式授权 |

`identity.cjs` 是唯一判定函数，board 复用它。心跳过期只能影响 active/idle，不能把 owner 判死。hook 通知投影不派生进程；已有 live 的 PID/启动时间采集仍使用原本的本机进程查询。

## 交接状态机与路由

agent 判断目标 scope；CLI 的 `--to/--kind/--severity` 执行确定性路由。正文不参与解析。消息 ID 是 scope、kind、title、排序 evidence 的哈希，重复投递不覆盖正文或状态。

`queued → surfaced → accepted → done`，queued/surfaced/escalated 可 rejected；超时变 escalated，用户回答 no/expired 后 queued 并延迟一个 ACK_TIMEOUT_MS。下次提问使用递增 round，避免旧 no 被反复消费。只有当前收件人可以 ack，发件人收到持久回执；重复相同 ack 可补齐回执。跨文件中断后的重试仍幂等。

| 收件人 | 路由与唤醒 |
| --- | --- |
| 自己 | 返回“自己处理”，不创建 inbox |
| online | 落盘；wait 最多一秒分片后返回 `state: inbox, exit: 3`；下次 UserPromptSubmit/PostToolUse 通过 additionalContext 提示一次；15 分钟未 ack 经 supervisor 提问 |
| offline | 普通消息保留积压，下一次 claim/brief/hook 可见；urgent 或该仓库有 held run 时立即提问 |
| unknown | 按 online 排队与超时升级；不根据计时自动接管 |
| 无主 | 发现者自动 claim，保存自己的待办，返回“已认领，由你处理” |

升级仍走已有 supervisor ask/ask-status，回答 yes 才 takeover；回答应用前再次验证提问所指 owner/generation。标题只包含 ID 摘要、kind 枚举、三态事实和是/否动作，title/body/evidence/path 不进入提醒。`inbox --all` 可查历史；接管后的未完成任务跟随 scope，回执与被接管通知保留固定收件人。

## Orca 与展示

core 不调用 Orca orchestration，不用 pane/mailbox 当事实源。live 仅记录 `ORCA_PANE_KEY`，本包没有启用可选 pane 提示投递：现有 Orca 模块是看板投影，未发现适用于外部启动会话的可靠投递契约。`SA_ORCA=0` 或 Orca 不可用不影响认领、wait、hook、inbox、supervisor。现有 board/console 项目行加 owner、presence、待办数量，没有重组布局。

看板 run 引用从统一 owner resolver 取得 controller；已有明确 owner 或明确无主结果时不再用 watcher/cwd 推断替代。跨机 unknown 或本机 offline 保留原归属证据，不把只读 watcher 绑定为负责人。

## 五个事件成因与边界

1. 控制台切换：claim/takeover/history 和 ledger.controller 明确记录新归属；旧会话控制被拒。
2. 修改未提交引擎后 retry：元帅写其他 owner 的仓库被 hook 拦截并提示 handoff；terminal adopt 必须工作树干净且 HEAD 是提交。生成前后均核对 cleanEngine，adoptions.engine_commit 记录来源。
3. 提醒驱动第二入口：supervise-tick 同样控制校验，动作带 controller/generation；无身份旧 run 明确报错。用户回执展示由 RCPT 包负责。
4. run 结束后私自开 codex：本包对元帅直接越权写入拦截，派生写入继续由原护栏负责。completed run 不再提供非终态 fallback，但显式仓库 claim 不会因 run 结束消失。本包不声称拦住独立、不加载 hook 的任意 OS 进程。
5. Orca 无法识别外部会话：事实源是本地 claim/ledger，Orca 仅可选展示，缺失不影响主链。

## 验证与兼容

全部新字段 additive，旧二进制可忽略 controller/engine_commit/coord_seen，旧 ledger 可回退 launcher；旧二进制不会执行新的 fencing，需由主控集成后统一运行新版。未修改数据库 schema 或 `packages/`。注册文件不是跨机器共享的租约服务；其他 host 的身份维持 unknown。

`tests/coord.test.ts` 覆盖卡片 1–9、真实 flock 竞争、PID 复用、generation、歧义消解、释放、hook 与 CLI 一致性、积压、幂等回执、拒绝后延迟、旧答案 fencing。supervisor 只使用临时 AGENT_SUPERVISOR_STATE 与 Python 桩。fake selftest 的 scratch toolkit 先初始化并提交，再提交模板变化，实际 adopt 后断言 engine_commit 与 HEAD 一致。完整测试、tsc、eslint、fake 与提交后 verify-local 的结果见 PROGRESS；G2 批次评审和主控集成另行执行。

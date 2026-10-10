# superagent 系统性根因与正确性契约（2026-10-10）

> 用户原话：“我要求你系统性的解决问题，不是打补丁”。
> 本文把今天的事故归成 7 类根因，每类对应一条可执行的不变量。每条不变量都要有三样东西：实现机制、测试（含事故回放）、运行时监测。修复只能挂在不变量下面，不收“按投诉打的补丁”。
> 落库位置：S4 包把本文原样提交到 `wetamp/docs/2026-10-10-systemic-rca.md`，后续改动只在库内版本上进行。

## 1. 事故清单（今日 18 个 run，本机台账）

| # | run | 现象 | 直接原因 | 谁发现 |
|---|---|---|---|---|
| E1 | 062040-aa74、063513-6a28（sinan） | 编码端已完成、验收全绿，却在 settle 判失败，评审与合入都没跑 | `disposition` 把编码端自报的 `error_class: task` 排在验收证据前面；partial + 绿验收也判 repair，修复轮次用尽后失败 | 用户 |
| E2 | 同上 | 自动重试整轮重跑编码，结果仍是同一个确定性误判；`auto_retry_exhausted` 先后问了两次（07:01、07:07/07:08） | 自动重试不区分“确定性判定”和“偶发故障”；提问去重键随 attempt 变化 | 元帅巡检 |
| E3 | 070806-57e6（xiaopan） | HF1 写好之后起跑的 run 仍然中招 | HF1 和 BT6 功能包捆在一起集成，没有走快车道上线 | 元帅事后 |
| E4 | 两个 sinan run | 重试/恢复用的仍是起跑时的旧引擎 | Archon 在起跑时冻结源码并封印摘要；superagent 没有“引擎版本”概念；元帅先后热修 gen 目录和快照，均无效或被摘要拒绝 | 用户 |
| E5 | 004139-c439 | 起跑即失败：`No base branch could be detected` | preflight 没有覆盖 Archon 起跑时会拒绝的条件 | 元帅事后 |
| E6 | 看板 | 用户连续 6 次反馈“看不到/没用/不是核心数据” | 看板、Web、report 各自采集，没有统一的引擎状态模型 | 用户 |
| E7 | 063513-6a28（adopt 后） | 换新引擎后又在 verify 挂起：自报 `partial`+`env`，验收全绿 | `disposition` 把 SUSPEND_CLASSES 检查排在 ok 之前；HF1/HF3 都是逐例修，没有穷举测试——R1 第三次复发 | 元帅 |
| E8 | 两个 sinan run 完成后 | “需要你”和 Mac 提醒仍挂着它们的旧提问（“是=再跑”）；驾驶舱进度条在真实数据上恒为 `?%` | 提问没有生命周期（run 离开挂起也不关闭）；驾驶舱单测只用理想夹具（R4） | 元帅上线实测 |

今日结果：完成 11、取消 5、失败 2（E1）；另有 1 个仍在跑且已重演 E1（E3）。完成的 run 中，无人干预直达合入的比例尚无统计口径（见 I7）。

## 2. 根因类

- **R1 判定信任自报胜过证据**：LLM 自报字段（`status`、`error_class`）能把绿色验收推翻成失败。证据（验收命令、diff、测试）应当是唯一能判“好”的依据，自报只应用来升级到人工（红线、需要授权）。
- **R2 在途 run 没有引擎升级语义**：新 run 用新模板，但 retry、resume、自动恢复都回到起跑时的快照。元帅在动手前没有核实 Archon 的源码生命周期，所以先做了两次无效热修（违反“先核实再动手”）。
- **R3 判定逻辑是开放世界**：原因串在事故发生时的 `sa-check.ts` 里生成，在 `cli.ts` 的 `reasonHold` 里按前缀/后缀解析，再经 `HOLD_POLICY`、`holdOf`、`classifyRun` 三处分派。没有注册表，也没有穷举检查：新原因会静默落进 `unknown_reason` 或错误分类（`coder_error:task` → repair → `repair_exhausted` → `coder` → 盲目自动重试）。
- **R4 测试夹具理想化**：事故发生时 fake 编码端固定输出 `{"status":"done","error_class":null}`（`src/generate.ts` 的 `fakeEdit`）。真实模型的输出分布，比如 done + error_class、partial + 绿、非法 JSON，从没进过 golden 测试；真实事故也没有回放进测试。
- **R5 可观测性走旁路**：看板、Web、report 各自拼数据，没有单一的引擎状态模型，所以“达成率、卡在哪、为什么、下一步谁动”这些核心数据缺席。
- **R6 引擎没有自检**：“失败但验收全绿”这种自相矛盾的状态不报警；确定性误判会被自动重试放大成成本；重复提问不报警。最终都是用户发现的。
- **R7 流程**：按投诉逐个打补丁；引擎正确性 bug 和功能包捆绑集成（E3）；对外部系统先假设后核实（E4）；preflight 没有和下游的拒绝条件对齐（E5）。

## 3. 不变量（正确性契约）

| 不变量 | 内容 | 机制 | 测试 | 运行时监测 | 包 |
|---|---|---|---|---|---|
| **I1 证据优先** | 验收绿 ⇒ 推进，除非是红线或 needs；自报只能升级到人工，不能把绿判成败。partial + 绿 ⇒ 推进并带 `coder_partial`，交评审判完整性 | `disposition` 规则次序 | 穷举表测试：status × error_class（全集 + 未知值）× ok × needs，逐格断言 | sa-check 产物写 `self_report_conflict: true`，驾驶舱计数 | HF4 已上线，包含 partial 与 176 格穷举；S4 保持回归 |
| **I2 原因闭集** | 每个原因码只在一个注册表里定义，带 `{hold, action, determinism: deterministic\|transient, owner}`；生产方和消费方都从这里取 | 新增 `src/reasons.ts`（sa-check 通过生成的模板常量引用同一份），删除前后缀解析 | 测试：所有产出点的原因 ∈ 注册表；注册表每项恰好映射一行 `HOLD_POLICY`；`HOLD_POLICY` 无孤儿行 | 运行时出现未注册原因 ⇒ `engine_suspect` + 事故样本，不再静默 `unknown_reason` | S4 |
| **I3 每个 attempt 边界都用最新引擎** | 新 run、retry、resume、自动重试都跑当前模板；运行中途不换源 | 引擎指纹 + Archon 原生 `--adopt` 续接（不篡改封印） | 指纹敏感性；同指纹走 resume、异指纹走 adopt；真实 Archon fake e2e | `status`/驾驶舱显示 `engine: current\|stale` | HF3 已上线；S4 限制 completed 不得 adopt |
| **I4 不静默停摆、不重复提问** | 每个 (run, hold) 最多一个未决提问；挂起超过阈值必须有提问或处置 | 提问去重键改为 (run, hold 类别)，attempt 不参与；巡检检测孤儿挂起和重复提问 | 去重键单测；回放 E2 的两次提问，只允许一次 | supervise-tick 输出 `orphan_hold`/`dup_ask` 计数，驾驶舱显示 | S4 |
| **I5 矛盾即引擎嫌疑** | “失败/挂起但验收证据全绿”或“未注册原因” ⇒ 判 `engine_suspect`，不再按编码失败处理；确定性原因不盲目自动重试；同一指纹下最多 0 次重试，换指纹后 1 次 | `classifyRun` 增加矛盾检测；自动重试读 I2 的 `determinism` | E1 回放必须判 `engine_suspect` 而不是 `coder`；确定性原因不触发自动重试 | 自动落事故样本到 `~/.superagent/incidents/<run>/`（只含 sa-check 输入输出 JSON、verify 产物、plan 片段、引擎指纹；不含 prompt/转录），驾驶舱红标；投一次 Mac 提醒 | S4 |
| **I6 夹具真实化 + 事故回放** | fake 编码端按场景输出真实分布；每个事故样本都进 `tests/incidents/` 回放 | `generate` 的 fake 输出可按 `FAKE_CODER_SCENARIO` 选：done+error_class、partial+绿、blocked+needs、非法 JSON | golden 增加以上 4 个场景；E1/E2/E5 三个事故样本回放 | 无（测试期） | S4 |
| **I7 单一状态模型** | 看板、Web、report 都只读同一个 `cockpit()` 模型；核心指标是达成率、卡点、原因、下一步、成本 | BT7 | cockpit 单测 + 快照 | 驾驶舱本身 | BT7（在跑） |
| **I8 起跑前拒绝下游必拒的条件** | Archon 起跑会拒绝的条件，preflight 先拒绝，并给出修复提示 | preflight 复用 Archon 的 `inspectProjectBaseBranch`（`packages/core/src/handlers/clone.ts:245`），不重写 | E5 回放：preflight 拒绝且提示 `worktree.baseBranch` | `run` 失败时区分 `preflight` 与 `engine` | S4 |

## 4. 流程不变量

- **P1 修复必须挂在不变量下**：每个包的卡片和 PROGRESS 都写明它强化的是哪条 I，并附三样东西：测试、事故回放、运行时监测点。评审把“无不变量归属的补丁”记为 finding。
- **P2 引擎正确性快车道**：判定/恢复类 bug 单独成包，验收后立即上线，不和功能包捆绑。上线后用 I3 把可恢复的 failed/cancelled run 迁到新引擎；运行中不换源，completed 不得重跑。功能包仍然粗粒度合并，按里程碑评审。
- **P3 先核实再动手**：涉及外部系统（Archon、ccusage、cmux）的行为，先读源码或实测拿到生命周期证据，再选方案；禁止在封印产物上热修。
- **P4 不重复造轮子**：每个新机制都要说明为什么不复用现成实现。本契约的复用点：Archon `--adopt`/`when`、`inspectProjectBaseBranch`、ccusage、现有 supervise-tick 与 `HOLD_POLICY` 表（只扩展，不另起一套），穷举测试用纯 bun test，不引入新框架。

## 5. 包与验收

1. **HF3**（已上线）：I3 + I1 的 partial 部分。上线后对 062040-aa74、063513-6a28 执行 `decide retry`，验证它们走 adopt 跑到评审和合入。
2. **BT7**（在跑）：I7。
3. **S4 引擎正确性契约**（HF4 合入后派发，基线 `1feb4909`）：保持 HF4 的 I1 穷举回归，交付 I2、I4、I5、I6、I8 与 I3 completed 守卫，并把本文落库。
4. **里程碑评审**：astra 一次 G2 评审，范围覆盖 wpE、BT..BT7、S1–S3、HF1–HF4、S4。修复不超过 3 轮。

## 6. 衡量“系统性修好了”的口径（驾驶舱展示）

- 事故回放：E1/E2/E5 全部按契约判定（0 误判）。
- `engine_suspect`、`orphan_hold`、`dup_ask` 三个计数：S4 上线后新 run 保持为 0；一旦非 0，自动留样本、投一次提醒，并按 P2 走快车道修复。
- 达成率 = 无人工干预直达合入的 run ÷ 已结束 run，按天统计（BT7/S4 口径一致）。
- 自动重试浪费 = 确定性原因触发的编码调用次数，应为 0。

# U5 验收提速：同一棵树在引擎内只验一次

日期：2026-10-14。基线：分支 `1.0.0`。R3 双审 Codex 100、Claude 100；已实施合入 `f3c8db19`。

修订记录：R2 按 R1 双审（Codex 65、Claude 66）收缩范围——删除抖动重跑放行、base probe 缓存、验收准入槽、定点重跑与提示模板改写；修正 §1 事实；缓存修法改为「先定命令环境，再对同一份环境取指纹」。R3 按 R2 双审（Codex 97、Claude 94）：land 的缓存行为改为如实沿用 accel-land 既有契约（R2 写的「land 必然实跑」与 `land.test.ts:440` 冲突）；`PYTHONDONTWRITEBYTECODE` 改由 `projectEnvironment` 统一写入，不再依赖调用方恰好对齐（R2 声称的「调用方全在节点内」不成立，`acceptRun()` 在节点外）；land 入口定为可测；§1 注明 diff-r2 已换树。

## 1. 问题

U1–U3 三个 quick run 同时派出，排队合计 < 0.2 s，但 U2 用了 55 分钟、U3 用了 68 分钟（第 3 轮被主控取消）。证据：各 run artifacts 的文件时间与 `# exit= ms=` 行（`~/.superagent/archon/workspaces/toagent/superagent_v2/artifacts/runs/` 下 U2 `b887bbc0…`，U3 `babefc1c…`，U4 前保留不清理）。

| 包  | 总耗时 | 将军编码 | 验收执行                                                                                    | 修复轮                     |
| --- | -----: | -------: | ------------------------------------------------------------------------------------------- | -------------------------- |
| U2  |  55 分 |    27 分 | 每条命令 3 遍（verify-quick、diff-m1-r1、diff-m1-r2），共 6 次约 18.9 分；base probe 未执行 | 1 轮约 8 分                |
| U3  |  68 分 |    25 分 | 约 7.3 分                                                                                   | r2 约 30 分，r3 被主控取消 |

**事实链（已由代码与 artifacts 证实）：**

1. U2、U3 的 `verify-quick` 两条验收命令都通过（`# exit=0` ×2）；紧接着 `diff-m1-r1` 在**同一棵树**上把同样两条命令再跑一遍，各有一条失败（U2 第二条、U3 第一条），于是进入修复轮。若同树结果被复用，`diff-m1-r1` 不会执行命令，这两轮修复不会发生。U2 的 `diff-m1-r2` 已在修复后的新树上执行，属于合理重验，所以表中 18.9 分并非全部可省。
2. 结果没被复用，是因为缓存按构造永不跨节点命中：`sa-check.ts` 的缓存键含 `environmentIdentity(commandEnv)`，它只剔除 `INPUTS_*`、`WORKFLOW_ID`、`ARTIFACTS_DIR`、`SA_COORD_ADMISSION`、`SUPERAGENT_ROLE`；而引擎给每个 exec 节点注入的 `ARCHON_NODE_EXECUTION` 含 attempt id 与开始时间（`packages/workflows/src/schemas/node-execution.ts`），`TYPED_ARTIFACTS_FILE` 也按节点不同。U2 的 `accept-cache` 有 6 个条目、日志 0 条 `# reused`。R1 评审的隔离探针复现：仅改变 `ARCHON_NODE_EXECUTION` 或 `TYPED_ARTIFACTS_FILE` 即重新执行。
3. 同一根因的第二个症状：`contract_hash` 含 `environmentIdentity(process.env)`（`sa-check.ts:594`），同树上 verify 与 diff 的 contract_hash 不等（U2：`ee64499b…` vs `47332abf…`）。`deliveryDecision` 的 approved 债务复用与 `same` 复用都要求二者相等，所以这两条路径今天也永不成立。
4. 节点变量本不该进入验收命令：命令环境与指纹今天由同一个 `commandEnvironmentKey` 过滤，但它漏掉了引擎拥有的节点契约变量（`STATE_DIR`、`LOG_DIR`、`BASE_BRANCH`、`USER_MESSAGE`、`CONTEXT`、`TYPED_ARTIFACTS_FILE`、`ARCHON_NODE_EXECUTION` 等，权威清单是 `EXEC_NODE_ENVIRONMENT_NAMES`）。sdlc 包的 `.shared/node-env.ts` 已按「项目命令不属于 run」剥除同一份清单，并有一致性测试钉住；wetamp 的 sa-check 没有跟上，这是同一规则两处不一致的漂移。

**未证实、不作为根因：** diff-r1 那次失败的原因。U2、U3 的失败分别是 `tests/cli.test.ts` 同组参数化测试中的不同用例，都撞上 bun 20 s 单用例超时；「三个 run 同时验收争 CPU」只是推测。U2/U3 的 base probe 因 quick 计划未声明 environment 命令，只记了 `baseline unknown`，没有执行。

## 2. 为什么、为什么现在

- 第一宪法是效率为本。同树重验本身花时间（U2 的 diff-r1 两条命令约 7 分钟），更糟的是给已通过的树又一次失败机会，U2、U3 观察到的修复轮都由此引出（U2 多花约 20 分钟，U3 约 30 分钟以上）。
- U4 效率实证要量改版后的真实速度；不先修掉这条，U4 量到的是老毛病。
- 修法是删除漂移、对齐既有规则，几乎不增加机器。

## 3. 期望结果

- 同一棵已提交且干净的树、同一命令、同一超时、同一项目环境：引擎节点内（verify、各轮 diff）该命令只真正执行一次，后续节点复用结果，并在本节点日志中回放原输出。
- 同树且其余契约字段（plan、ids、scope、base、risk、policy）相同的节点之间，`contract_hash` 相等，approved / same 复用路径按原设计生效。
- `land --apply` 经 `acceptRun()` 沿用同一缓存规则，本包不改：完整身份（tree、命令、超时、envKey、过滤后的项目环境）相同即复用，否则实跑。这是 accel-land（`393a737c`）的既有契约，由 `land.test.ts:440`「apply checks the accepted tree, reuses cache …」钉住。本包修好环境契约后，操作者终端与节点的项目环境一致时，land 也会命中——这是预期收益，不是回归。需要每次实跑的检查照旧声明 `cache:false`（quick 用 `--no-cache`）。「合入前主控亲自实测」是主控在引擎之外执行的独立步骤，不依赖 land 内部是否实跑。

## 4. 不变量

- 缓存只能在被验证的东西完全相同时命中：
  - 命令实际收到的环境与参与指纹的环境是**同一个对象**，不存在「命令看得见、指纹看不见」的变量；
  - 有 tracked 或 untracked 改动（dirty）一律不缓存；
  - `cache:false` 的检查每次实跑；
  - tree、命令、超时、项目环境契约（envKey）任一变化都使键失效；
  - 缓存键版本升级，旧条目不被新键读到。
- 不改失败路径：不新增重跑、不新增 failure_class、不改 `deliveryDecision`、不改节点 timeout 与 `MAX_ROUNDS`（末轮仍 fail/block、退出 1）。
- base probe 不变：`probe()` 继续不传 envKey、不读写缓存。
- environment 节点（`KIND=env`）沿用现有完整继承环境，不受本包影响。
- 不改评审白名单、护栏、人工 push 规则。

## 5. 方案

### 5.1 命令环境单源

在 `sa-check.ts` 定义唯一的 `projectEnvironment(values)`：剥除节点契约变量（`NODE_CONTRACT_ENV`，与 `EXEC_NODE_ENVIRONMENT_NAMES` 相同）、`INPUTS_*` 前缀，以及 wetamp 自有的 `SA_COORD_ADMISSION`、`SUPERAGENT_ROLE`。写法照搬 sdlc `.shared/node-env.ts`。

- `run()` 中 `commandEnv = projectEnvironment(process.env)`（`KIND=env` 时仍为 `process.env`），子进程收到的就是这份对象，`environmentIdentity(commandEnv)` 也只对这份对象取 HMAC。
- `environmentIdentity` 内部不再自行过滤，只对传入环境取 HMAC；`contract_hash`（`sa-check.ts:594`）与 sa-context 的调用都改为 `environmentIdentity(projectEnvironment(process.env))`。
- 删除 `commandEnvironmentKey` 与 `contextEnvironmentIdentity`。`PYTHONDONTWRITEBYTECODE` 有真实运行语义（避免验收命令写出 `__pycache__` 把工作树弄 dirty），因此既保留在命令环境、也保留入键，但取值由 sa-check 统一规定而不是依赖调用方：`projectEnvironment` 在剥除契约变量后显式写入 `PYTHONDONTWRITEBYTECODE: '1'`（`KIND=env` 仍原样继承 `process.env`，不受影响）。这样引擎节点（`dag-executor.ts:3817` 注入同值）与节点外的生产调用方 `acceptRun()`（`wetamp/src/cli.ts:1462`，经 `cli.ts:1592` 供 `land --apply` 使用，终端环境不带该变量）落在同一身份上，不再有「恰好对齐才命中」的隐式约定。直接 import 旧导出的测试（`generate.test.ts:778`、`role-context.test.ts:150/166/336`）同步改为新调用；`role-context.test.ts:166` 原断言两份不同节点环境（`diff-m2-r2` 与 `attempt-review-m2-r2`）身份不同（`not.toBe`），新规则下跨节点身份不再不同，改为相等（`toBe`）。
- 缓存键版本 `hmac-v1` → `hmac-v2`。

pack 脚本不能 import 引擎代码，因此 `NODE_CONTRACT_ENV` 是一份副本；用 `wetamp/tests/` 中的一致性测试 import `EXEC_NODE_ENVIRONMENT_NAMES` 断言两者相等（与 sdlc 的做法相同；`role-context.test.ts` 已证明该 import 可用）。

### 5.2 命中保留证据

缓存条目本就存了 stdout/stderr。命中时，把它们与 `# reused <pass|failure> from <tag>` 一并写入本节点日志，使评审与修复读到的 `$<node>.output.log` 不因复用而变空。

### 5.3 预期的可见行为变化

验收命令不再看到 `STATE_DIR`、`LOG_DIR`、`BASE_BRANCH`、`USER_MESSAGE`、`CONTEXT` 等节点契约变量。这与 sdlc 的规则一致：项目命令不属于 run，不应知道 run。实施说明中写明；若有现有测试或 golden 依赖这些变量，按测试过时更新。

## 6. 复杂度预算

- 产品代码净增 ≤ 21 行（新增 `projectEnvironment` 与清单约 25 行，含统一写入 `PYTHONDONTWRITEBYTECODE` 1 行；删除 `commandEnvironmentKey`、`contextEnvironmentIdentity` 及其注释约 −15 行；回放与版本号约 +5 行）。实测核算约 +16；优先压缩注释，不砍一致性测试。测试与生成产物另计。
- 不新增依赖、配置项、YAML 字段、failure_class 或缓存格式。
- 实施前按实际文件复核；超预算停止并回报。

## 7. 验收

在 `wetamp/` 目录下执行。

1. **真实节点环境命中**：用 `buildExecNodeEnvironment` 生成 attempt / invocation 不同的两份节点环境，对同一干净树依次运行 sa-check 验收（子进程环境显式给出节点契约键；要抑制的继承键按 AGENTS.md 传 `''`，不用 delete），以命令的**实际执行次数**断言（例如命令向计数文件追加一行）：第二次执行次数为 0，日志含 `# reused` 与回放的原输出。
2. **失效矩阵**：以下任一变化必须重新执行——tracked 改动、untracked 文件、`cache:false`、项目环境变量值变化、envKey 变化、tree 变化、timeout 变化。用例环境同 7.1 的构造方式。在已有的 `delivery-truth: cache binds filtered command environment` 用例中补上 `ARCHON_NODE_EXECUTION`、`TYPED_ARTIFACTS_FILE` 等节点契约键，断言它们不进指纹，也不进命令环境。
3. **contract_hash**：同一树、其余契约字段相同、仅节点环境不同的两次调用，`contract_hash` 相等。
4. **一致性**：`NODE_CONTRACT_ENV` 与 `EXEC_NODE_ENVIRONMENT_NAMES` 相等。
5. **land 契约不变**：`land.test.ts` 的 reuses-cache 用例照常通过；补一条用例：先用真实节点环境预热缓存，再以相同 tree、命令、timeout、envKey 调用 land 的实际入口（在 `cli.test.ts` 的 archon 桩 fixture 上调 `main(['accept', '<run>'])`——它走的就是 `acceptRun` 的生产路径，无需导出新符号；land 自身的复用契约由 `land.test.ts` 的 reuses-cache 用例继续钉住），**两侧都不显式设置 `PYTHONDONTWRITEBYTECODE`**，断言执行计数不增加；同一检查声明 `cache:false` 时执行计数加一。用例若需要人为对齐任何环境变量才通过，说明身份规则仍依赖调用方，按 blocker 处理。
6. `bun test tests/sa-check.test.ts tests/role-context.test.ts tests/generate.test.ts tests/cli.test.ts` 0 fail；`bun run type-check` 无错。
7. **真实运行**：合入后第一个改动干净的 quick run，`diff-m1-r1` 中每条命令都是 sa-check 自己写的 `# reused pass from verify-quick` 记录，而不是 sa-check 的执行记录（回放的原输出可能含相同文字，以执行计数为准）。由主控在 U4 中记录。

## 8. 不纳入（含理由）

- **失败后同树重跑、抖动放行**：fail→pass 不能区分负载抖动与竞态、状态污染这类真实缺陷，放行违反「不放过真实失败」。另外，已观测到的两次失败都发生在本包消除的同树重验中。若 U4 数据显示修复轮仍由抖动引起，再单独设计「诊断重跑只作证据」的方案。
- **base probe 缓存**：`run()` 的 tree 取自进程 cwd，probe 在 base 临时 worktree 执行；加缓存会把 base 结果写进候选树的键下。quick 也从未执行过 probe，收益为零。
- **验收并发槽**：COORD 的 `admissionEnv` 是一次性授权令牌、`scoped` 是互斥锁，都无法表达计数槽；做了就是新造信号量。若实测仍有争抢，在派单层限制并发 run 数，另包处理。
- **定点重跑**：需要新增 plan 字段，且没有已观测收益。
- **将军自检提示改写**：`sa-code`、`sa-repair`、`sa-fix` 是共用模板，现有要求跑完整 accept，并有生成器断言保护。改它会把失败推迟到 diff 门禁，可能增加修复轮；在 U4 测出自检耗时占比之前不动。
- **拆分将军编码时间、改测试框架**：属于 U4 测量之后的决策。

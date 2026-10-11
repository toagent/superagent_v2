# PROGRESS

## BT9 /sa 与归属（2026-10-10，wetamp-bt9）

- **未归属根因**：只读核对生产 usage 缓存与 Archon 会话元数据，发现 `ccusage@20.0.28 session --json` 默认汇总所有客户端，原采集器将它标成 Claude，再单独采 Codex，今日 201 个会话 id 跨客户端重叠，其中 200 对 total 完全相同，Claude 侧重复部分 235,672,830 tokens；这比单纯漏角色更直接地解释大量“未归属”。改为显式 `claude` / `codex` 子命令，并支持 Claude 专用接口实际返回的 `sessions`（旧 `session` 仍兼容）。生产缓存/数据库未写；显式刷新既有采集器会替换历史用量与今日分量，夹具证明历史重新计算的角色。
- **归属修复与 P4**：复用 `usageEvidence`、生成工作流的 `workflowRoles`（`@sa-coder` → 将军、`@sa-reviewer` → 军师）、Archon `session_id` / provider / resolved model、已有 `jobSession` 的首行元数据读取和唯一匹配、`etaInput` 的引擎事件折叠。补读 ledger 的 `adoptions[].from` 保留旧 run 会话，单个旧 run 缺失不丢当前证据；无模型绑定的旧事件可复用原有 provider/model。在途节点尚无 session id 时，只对当前运行 run 的最新活跃启动，匹配精确 worktree 与启动后 60 秒内的唯一会话；终态及歧义不猜。不能用 `SUPERAGENT_ROLE=worker` 区分同一引擎进程里的编码和评审，也不按模型名称猜角色；不新增 hook、旁路采集或正文解析。无派发证据的交互会话/证据不足的会话明确保留未归属。
- **界面复用与 I7**：Ink 原生 `alternateScreen: true` 只作用交互渲染；`--once`/管道沿用原路径。`/sa` 全部投影 `cockpit()` 和现有 usage，CSS 取 `packages/web/src/experiments/console/theme.css` 的深色变量（3 行内联样式，无 packages 修改），本地 HH:MM、15 秒重载、共享跑/等你/今日口径、未决 asks（superseded 隐藏）、四角色 × 模型用量表。今日 run 按本地日期过滤、排除未来开始、最新在前，中文状态、token 未知为 `—`、用时及 `/console/r/:runId` 链接；已结束展示编码主模型。已结束统计包含取消，与“达成/已结束”的文案一致。强化 I7 的成本不重复、未知不冒充零、需人处理的单一事实源和共用控制面口径。
- **install 偶发失败**：fake e2e 的两处 install 调用未设 `SA_SKIP_DOCTOR=1`，但安装末尾默认执行真实 `archon doctor` 并在任一探测失败时 exit 1；doctor 依赖供应商 CLI、认证、gh 与外部连通性/超时，超出了 fake 验收契约。复用 selftest/install 测试已有的跳过开关隔离这些非确定依赖，生产安装仍严格执行 doctor。改前目标用例单次 36.7s 通过，未复现 BT8 那次失败，无法唯一确认当次具体 doctor 子项；不声称已证明历史失败的精确触发项。
- **测试与验收**：归属、显式采集命令、历史刷新、在途唯一/歧义、已结束主模型、今日边界、中文状态及 2 run + 1 job + pending/superseded + 四角色的 HTML 快照均有回归断言。32 项定向检查全绿；临时控制台 HTTP 200/结构、stop 后两 PID 消失与双端口可重绑；PTY 连续两次原生进入/恢复 alternate screen，`q` exit 0，once/pipe exit 0 且不进入全屏。完整验收证据在 `/tmp/bt9-accept.fpkks_82/`，全量、CLI 三连、selftest 和提交绑定 verify-local 的最终结果见本包交付。
- **角色边界**：只做本包编码与自检，无派生 AI、push、合并、cmux 操作或真实提醒投递；astra 独立里程碑评审、真实像素和主控集成实测仍由主控完成。可复用经验候选：固定 vendor 版本仍需验证子命令默认客户端范围和 JSON 形状；fake 测试不得隐含依赖在线 doctor。候选未晋升为共享经验。
- **最终自检**：`cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（604 pass / 0 fail，175.66s）；`bunx eslint src` exit 0；`bun test tests/cli.test.ts` 连续三次 exit 0（各 154 pass / 0 fail，127.73s / 130.03s / 132.87s）；`SUPERAGENT_HOME=/tmp/bt9-accept.fpkks_82 ARCHON_HOME=/tmp/bt9-accept.fpkks_82/archon bash scripts/selftest.sh --fake` exit 0。src TS 净增 35 行（≤150），packages/hooks 零改动，`git diff --check` exit 0；11 个明确文件提交后，以同一调用方 SUPERAGENT_HOME 运行 `bash scripts/verify-local.sh --commit HEAD`，提交绑定结果保存在该目录 `verify.json`，不写生产台账。旧面板用例的快照时间绑定 run 夹具，避免今日过滤依赖运行测试的真实日期。

格式：`<ISO时间> | <阶段> | <commit> | <pass/total> | <备注>`

2026-10-09T13:39:01Z | M0 | e2476bb1 | 4/4 | selftest --fake: rss=194960KB recover=1104ms signal=636ms；提交与 push 非本会话所为（疑为操作者经 IDE，说明无 wetamp(M0) 前缀），内容与本会话工作树一致，未改写历史
2026-10-09T14:05:00Z | M1 | (见下行) | 65/65 | 代码已被外部提交 ca963d06、4829563b（通用说明、已 push，非本会话所为，未改写历史）；本提交只补 PROGRESS/实现记录。真实端到端 run 20261009-135619-f93a（@sa-coder 写 greet.sh）5/5 completed，land 命令 switch main + merge --ff-only 实际执行成功
2026-10-09T14:05:00Z | M1 | a16046fc | 65/65 | 补注上一行的 commit
2026-10-09T14:29:50Z | M2 | 9eee8d9e | 90/90 | 真实端到端 run 20261009-141909-ed10（G1 calc.sh，signoff:human）：gate-m1-r1 首轮 PASS（1 条评审债：整数溢出边界），held:human → decide approve → completed，land 命令在临时仓库执行、验收复跑通过；首次提交因嵌套 lint-staged 在 wetamp/ 下解析 eslint 路径失败，改动从其自动备份提交恢复后重提（备份 stash@{0} 未删除）
2026-10-09T14:52:00Z | M3 | be6ae34c | 99/99 | report、gc.sh、upgrade-upstream.sh（默认 dry-run）、README；selftest --fake 全绿（rss=197008KB recover=1076ms signal=550ms）；真实 upgrade dry-run：upstream/dev 7009a90a、behind 0、本机 archon.db 列核对 ok；gc --apply 在 M2 临时 home 实测清掉 worktree/分支/gen/ledger

## 最终摘要

- 提交（`git log --oneline dev..HEAD`）：e2476bb1 M0 4/4 · ca963d06、4829563b（外部提交 M1 代码）· a16046fc M1 65/65 · 9eee8d9e M2 90/90 · be6ae34c M3 99/99 · 本摘要提交（仅文档）。
- selftest（--fake，契约链 detach→kill -9→owner_lost→recover→事件门→signal→completed）：detach RSS 194960→197008 KB；kill -9→recover 1104→1076 ms；signal 往返 636→550 ms（M0→M3）。
- 真实模型仅两次（M1、M2 端到端各一次，均 completed，land 命令实际执行通过）；其余全部桩/--fake。
- 对照表 A：run ✅ · selftest ✅（sa-smoke 内联）· wait ✅ · status/brief ✅ · decide approve ✅ · decide retry+hint ✅（hint 在 `gen/<run>/hints/`）· decide cancel ✅、`--force/--cascade` ⏭ · cancel ✅ · report ✅（token ⏭）· accept ✅、`--quick` ⏭ · playbook ✅（并入 brief）· lessons ⏭ · capability/health ✅ · land ✅、`--each` ⏭ · resume ✅ · gc ✅。
- 对照表 B：review_missing ✅（Archon retry + autoResumeOnQuotaReset；模型由 run-config 层钉死、`resume` 不换模型；换评审厂商 = 改 `tiers.json` 后新开 run；brief 专门标签 ⏭）· awaiting_signoff ✅ · needs_decision ✅ gate escalate、vote ⏭ · needs_diagnosis ✅（probe 并入 accept 脚本的 base_pass）· disk/environment ✅（磁盘 preflight + environment 节点 held:environment）· lost/lost_repeated ✅（停滞 3 次停止自动恢复）· external_write_unconfirmed ✅ worktree 隔离、base 前进时打印 rebase 命令 ⏭（只打印 --no-ff merge）· review_limit ✅ · review_debt ✅ · review_no_change ✅ · no_progress ✅（评审节点 idle_timeout，其余用 Archon 默认）· deadline ✅（gate 判 expired、签收等待以 deadline 为限；逐节点 timeout ⏭）· verification 指纹 ✅（diff 哈希）· sandbox_denied ✅ 不适用 · worktree_claim/git_operation ✅ · selftest_required ✅ · cancelled/upstream_cancelled ✅。
- 对照表 C：E1 ✅ · E2 ✅ · E3 ✅ · E4 ✅ · E5/E9 ✅ · E6 ✅ · E7 ✅ run 间并行、纯依赖链 lint 告警 ⏭ · E8 ✅ G2 评审过即放行、红线投提醒事项，AI 投票 ⏭。
- 对照表 D（Archon 原生）：✅ 由 selftest 与 fake/真实端到端覆盖。
- 偏差（详见 00-architecture「实现记录」）：escalate 后 `decide retry` 无效（须改分支或新 run）；签收用 wait 事件门 + signoff bash 节点；`get` 动词删除；`report` 逐 ledger 查询；upgrade 的列核对用 pragma_table_info、核 `status`/`metadata` 两列（execution_owner 在 metadata JSON）；`--apply` 不提交 UPSTREAM。
- 未做（可选或后置）：lessons、vote-<M>、land `--each`/rebase 命令、accept `--quick`、decide cancel `--force/--cascade`、report token 统计、等待期间 worker 退出靠 wake 续跑、包级并行。
- 预算：shell 239/300 行（含 bin/）；文件 25/25（不计 tests/、docs/、README.md）。
- 风险：TS 与文件预算已满，再加功能须先删；`supervise-tick` 无并发锁，须单一 launchd 作业调用；recover 直接回拨 Archon 表的 status，依赖 upgrade 脚本与 selftest 复测；M2 提交时 lint-staged 留下 `stash@{0}`（lint-staged automatic backup），内容已提交，可由用户确认后 `git stash drop`；upgrade `--apply` 未在真实仓库执行（当前 behind 0），仅临时仓库测试覆盖。
  2026-10-09T15:45:00Z | fix-r1 | 3e134056 f05303f9 d06f2a4d + 本行提交 | 124/124 | 修复轮 R1：H1–H4、M1–M7、launchd 接线；selftest --fake 全绿（rss=194592KB recover=1004ms signal=542ms）；check-upstream-clean 空；零真实模型调用

## 修复轮 R1 摘要

- H1 owner 绑定 recover + run 锁：`src/archon.ts` `lock`/`recover`；测试 `owner taken over between get and flip → owner_changed…`、`a live recover lock serializes…`、`a lock left by a dead local process…`。
- H2 模型钉进 run：`src/config.ts` `runAliases`/`aliasDrift`、`src/generate.ts` 写 `run-config.yaml`、`src/cli.ts` `startRun`/`health`（退出码 5，README 已列）；测试 `console=codex pins @sa-reviewer…`、`console=claude pins…`、`a target repo @sa-* alias that differs…exit 5`、`a drifted global alias also refuses; health --cwd…`。
- H3 R2/R3 ID 集合基线：`templates/.archon/scripts/sa-check.ts` `decide`；测试 `R2: renamed id, carry_over:false or closed without evidence all stay open`、`R3 baseline is what R2 left open…`。
- H4 deadline 先判 + signoff/land/approve 查截止：`sa-check.ts`、`src/generate.ts` signoff 节点、`src/cli.ts` decide；测试 `past the plan deadline even a PASS escalates…`、`signoff and land check the absolute plan deadline…`、`approve past the plan deadline is refused…`、`land: … refuses past the plan deadline`。
- M1 停滞指纹：`src/cli.ts` `recoverRun`（ledger `progress_fp`/`stalled`，README 行 `held:recover_no_progress`）；测试 `3 recoveries without new completed nodes → held:recover_no_progress…`、`progress between recoveries resets the stall count`。
- M2 未变 diff：`src/generate.ts`（`prev`/`same`、review `when`）、`sa-check.ts` 直接 `escalate no_change`，goldens 已更新；测试 `unchanged fix diff: diff-rN compares…`、`a fix round whose diff is unchanged…escalates as no_change`。
- M3 不 `--force` 清理：`sa-check.ts` `probe`、`scripts/selftest.sh` `cleanup`（`branch -d`，失败保留并报路径，临时 repo 在 mktemp 目录整体删）；测试 `probe never force-removes: a worktree the check dirtied is kept…`，并以外部 repo 跑 selftest --fake 确认 worktree/分支被清掉。
- M4 签收幂等 + tick 锁：`src/cli.ts` `human`/`superviseTick`；测试 `ask key is run:milestone:round…`、`the ledger holds a pending entry before supervisor ask runs…`、`a failed ask drops its pending entry…`、`a live supervise.lock makes a concurrent tick skip…`。
- M5 upstream 事实按文件核对：`scripts/upgrade-upstream.sh` + `UPSTREAM` 第 2 行起 `table`/`fact` 行（真实 upstream/dev 4/4 通过）；测试 `upstream dropping a column from the run table fails…`、`upstream dropping a registered fact, or an UPSTREAM without facts…`、`--apply … rewrites UPSTREAM`（保留事实行）。
- M6 `--json` no-op、未知参数 64：`src/cli.ts` `main`；测试 `main: unknown flag exits 64 with usage; --json is an accepted no-op on any verb`。
- M7 派生评审债、land 带债：`sa-check.ts`；测试 `G1: open non-blocking findings become debt…`、`land: carries the last gate debt per milestone…`。
- launchd：`launchd/com.wetamp.superagent.supervise-tick.plist.tmpl` + `scripts/install.sh`（`SA_LAUNCHD_DIR`，相同不动、不同备份，只打印 bootstrap/bootout，未执行 launchctl）；测试 `launchd plist: rendered with escaped paths, left alone when identical, backed up when different`；README「安装」已加。
- 预算：shell 274/400 行（含 bin/）；文件 26/28（不计 tests/、docs/、README.md）；硬规则 7 已改为 1800/400/28。
- 验证：`cd wetamp && bun test` 124/124；`tsc --noEmit` 干净；`check-upstream-clean.sh` 输出空；`selftest.sh --fake` ok。
- 未修/遗留：根 `bun run lint` 被既有的 `tests/install.test.ts:15` 递归 rmSync 清理漂移检查拦下（HEAD 已存在，wetamp 无 `@archon/paths` 依赖，本轮未改）；`resume --model` 在 00/02/03 设计段的旧描述未改（设计层说明，实现记录已注明以 run-config 层为准）；`stash@{0}` 按要求未动。

## 修复轮 R2 摘要

- N1 + M7 dd1e9c1e：`N1: a duplicate id (closed + open high) in one review escalates as invalid_review`、`G1: a reviewer listing one of two open mediums still yields both as debt`、`G1: an R1 medium omitted in R2 stays debt; closing it with evidence clears it`。
- H4 55b93ebf：`human wait deadline is the time left to the plan deadline, no floor; a passed deadline fails generation`；M1 1d8d48eb：`interleaved recovers at stalled=2: the count is on disk before the lock is released, so only one resumes`。
- M4a + M4b 4d2a516b：`an aged lock whose holder is alive is never taken; an aged unreadable lock is`、`an ask that saved its record then exited non-zero stays unknown; the next tick reconciles via ask-status instead of asking again`。
- N2 d69fa26b：`launchd plist: ARCHON_HOME is rendered only when set explicitly at install`。
- 验证：`bun test` 130/130；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；`selftest.sh --fake` ok（rss=192256KB recover=998ms signal=541ms）；零真实模型调用。预算 shell 277/400、文件 26/28。

## 修复轮 R3 摘要

- M4a 0a52c660：`an aged lock whose holder is alive is never taken`、`an aged unreadable lock is NOT taken: tick reports lock_unreadable with exit 1`、`an unreadable recover lock refuses recover without touching the run`、`the lock file appears with its full content and leaves no temp file behind`。
- H4 70ae7dfa：`held:human past the plan deadline: tick cancels (reason deadline), ask expired, supervisor untouched, brief says so`、`held:human before the plan deadline still asks; nothing is cancelled`。
- N3 7a095e70：`a null or malformed supervisor ask record is skipped and counted; the valid one is still reconciled`。
- 验证：`bun test` 136/136（新增 7 个测试在 f88040e6 源码上 5 败 2 过，过的两个为行为不变断言）；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；`selftest.sh --fake` ok（rss=193744KB recover=999ms signal=538ms）；零真实模型调用。预算 shell 277/400、文件 26/28。

## 修复轮 R3b 摘要

- 锁夺取原子化 d8008140：`a dead lock is seized by A; B, a separate process, then gets locked and leaves A's lock in place`、`a dead lock seized by someone else between the check and the rename: locked, no throw, no .stale left`（旧源码上 1 败 1 过，过的为行为不变断言）。
- 验证：`bun test` 138/138；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；零真实模型调用。预算 shell 277/400、文件 26/28。

## 修复轮 R3c 摘要

- 锁夺取 ABA 窗口 b3281ea4：`a dead lock replaced by a live one between the check and the rename: live lock put back, locked, no .stale left`（去掉比对即失败）；测试临时目录清理改用 `trackTempRoots`/`removeTempTree` db3999cc。
- 验证：`bun test` 139/139；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；仓库根 `bun run lint` exit 0（test-cleanup drift 不再报 wetamp）；零真实模型调用。预算 shell 277/400、文件 26/28。

## R4 修复摘要

- H4 1656a9c1：`src/cli.ts` 的 `cancelRun` 按状态分流（running → `workflow cancel`，paused/failed → `workflow abandon`）；cancel 被拒时不解析拒绝文本，而是重读状态，若已离开 running 则改走 abandon。`cancel`、`decide reject`、tick 的截止与“否”共用这一入口；`cancel <run>` 也接受未登记的 archon run id（供 selftest 用）。
- H4 测试：archon 桩按引擎契约执行（cancel 只接受 running，abandon 拒绝 completed/cancelled）。测试名：`cancel: a running run goes through archon workflow cancel…`、`cancel: a paused or failed run is abandoned…`、`cancel: a run that paused between get and cancel is re-read and abandoned`、`cancel: a completed run is refused by abandon and exits 1`、`reject ends the paused run through abandon`、`pending keeps waiting; no abandons the paused run`、`held:human past the plan deadline: tick cancels…`。
- H4 先红后绿：只换桩、不改代码时 cli 测试 6 个失败（reject/deadline 两例在 exit code 上得到 1）；修复后 65/65 通过。
- H4 selftest 新段：`sa-abandon` 停在 `wait:{event: sa.human.abandon}`，执行 `superagent cancel` 后 `workflow get` 为 cancelled。实测 `abandon_ms=451`（同次 rss=194128KB、recover=1121ms、signal=589ms）。另外，detach 后的 run 起初是 pending，`await_gate` 已容许这一状态。
- M4a 58e5dd59：`src/archon.ts` 的 `lock()` 改为 `bun:ffi` 调 libc 的 `flock(LOCK_EX|LOCK_NB)`，EWOULDBLOCK 判为 locked，其他 errno 抛错；`Lock` 收敛为 `{ok:true,release}|{ok:false,reason:'locked'}`。release 只关 fd、不删锁文件。已删除 holder、.tmp/.stale、link/rename、ABA 比对、lock_unreadable，以及 superviseTick/main 的 exit-1 分支。recover 与 supervise.lock 共用 `lock()`。
- M4a 测试：`lock (flock, real processes)` 四条——子进程持锁时父进程得 locked；子进程 SIGKILL 后父进程立即获锁；三个并发子进程（屏障放行）各持锁 300ms，恰好一个 ok；子进程 release 后（仍存活）他人可获锁。行为测试保留：`a held recover lock serializes…`（recover_locked）、`a held supervise.lock makes a concurrent tick skip with exit 0…`。新增 `a leftover lock file nobody holds (empty, junk, or a dead pid) does not block recover`：在旧实现上失败（1 fail），新实现上通过。旧的 10 条夺锁/不可读测试已删除。
- N4 0a747ed4：`human()` 把截止处理提成 `expire()`；yes 分支在 signal 前再调一次 `pastDeadline`。测试 `a yes that arrives after the plan deadline passed is not signalled…`：supervisor 桩在 ask-status 期间把截止改到过去，旧代码发出 signal 且 tick exit 1（红），新代码不发 signal、走 abandon、ask 标 expired（绿）。
- 文档 38c36c41：`00-architecture.md`（“否”/reject 改为 abandon/cancelRun，删去 R1–R3 锁接管的旧说明，新增「修复轮 R4 实现记录」）、`02-poc-checklist.md` #6 与 §结论、`README.md`（reject = 终止 run）。
- 验收：`check-upstream-clean.sh` 输出为空；`bun test` 140/140；`tsc --noEmit` 无错误；仓库根 `bun run lint` rc=0（该脚本不覆盖 wetamp/）；`selftest.sh --fake` ok；零真实模型调用。
- 预算：shell 304/400（+27，selftest.sh）、文件 26/28。src+scripts 合计 +112/−118；含测试与文档共 +314/−295。
- 未做项：01/03 规划与对照矩阵文档未改；flock 只在 darwin 实测，linux 路径（libc.so.6、`__errno_location`、EWOULDBLOCK=11）未实测；hook 的“请军师评审”提示按卡片要求忽略。

## WP-B 摘要

- 提交（分支 `wetamp`，未 push）：hooks 44394798；exec_profiles 449d57b5；install 5d05d4dd；docs 为本摘要所在提交（`wetamp(cutover): docs`）。
- §1 hooks：`wetamp/hooks/{guard,context-budget,dispatch-context,micro-edit,shell}.cjs`，策略读 `tiers.json` 的 `policy`；派生判定 4 条（`SUPERAGENT_ROLE`、`AI_DISPATCH_ROLE/TWIN_AGENT_REMOTE`、`archon/workspaces` 下的 cwd、Codex 将军池模型）。
- §2 exec_profiles：`bin/codex-worker`（`-c features.multi_agent=false` + 关闭沙箱清单外 MCP，只读 config.toml 表头）；`tiers.json` 的 `policy.exec_profiles`；`src/generate.ts` 给 claude 别名的 prompt 节点写 `denied_tools`；`src/archon.ts` 给 detached run/resume 注入 `SUPERAGENT_ROLE=worker`；`src/config.ts`、`src/cli.ts` 随之调整。
- §3 install：`src/install-hooks.ts`；`scripts/install.sh` 增 `--hooks`/`--purge-v1`（带 `--dry-run`）/`--remote-hooks`，写 `assistants.codex.codexBinaryPath`；`scripts/selftest.sh` 增 hooks 段。
- §4 agent-supervisor（非 git 仓库，只改文件）：删 `scripts/sv_superagent.py`、`tests/test_superagent_signoff.py`；改 `supervisor.py`、`sv_ask.py`、`sv_notify.py`、`SKILL.md`、`tests/test_wal_breaker.py`、`tests/test_decisions.py`（新增 `test_legacy_v1_signoff_state_is_ignored`）。备份：`~/.superagent/backups/agent-supervisor-20261010T010741Z`。
- §5 twin-toolkit（非 git）：superagent 维度改指 `superagent_v2`，安装命令改为 `install.sh --remote-hooks`，回执 schema 2 校验 `install.json`（`installer:"superagent_v2"`、wetamp realpath、commit、guard/context-budget 存在、tiers 含 policy）。备份：`~/.lan-dev-machine/backups/twin-toolkit.20261010T011559Z`。
- §6 文档：`00-architecture.md` 实现记录、`03-parity-matrix.md` A 表 4 行、新建 `04-hooks-and-nesting.md`（61 行）。
- 测试（新增）：`tests/hooks.test.ts` 10 条（G-1 31/29 行与 ALLOW、会话累计、N-1 三种派生、Codex 模型判定、元帅 Agent 放行与 G-2、git push/reset --hard、删除拦截与 reviewer 只读、stop_gate=off、三档阈值、第 16 次调用提醒）；`tests/exec-profiles.test.ts` 2 条（codex-worker 参数、detached 进程带 worker 角色）；`generate.test.ts`「claude nodes deny nested agents…」；`install.test.ts` 的 `--hooks`、`--purge-v1 --dry-run`、`--remote-hooks` 三条。
- 验收：`check-upstream-clean.sh` 输出为空；`tsc --noEmit` rc=0；`bun test` 156/156；仓库根 `bun run lint` rc=0；临时 home 下 install ok，含 codexBinaryPath；`selftest.sh --fake` ok，含 `hooks:{g1_commander_31_lines:deny,n1_worker_agent:deny}`；codex-worker trace 含 `-c features.multi_agent=false` 和 6 个 `mcp_servers.*.enabled=false`。
- dry-run（只读）：`--hooks --dry-run` diff 112 行；`--purge-v1 --dry-run` 输出 348 行，将移走 5 个 managed 子代理以及 V1 的 releases/state/checkout 三个目录。
- agent-supervisor 测试：失败集合与改动前基线一致（28 failure / 2 error，均为既有问题：test_wp5 中 ai-toolkit/twin-toolkit 相关、TasksSh 的 hook_fn/patch_idempotent、wal_breaker 中 ordinary breaker 被其他测试污染，单独跑能通过）。
- twin-dev：已 align（原记录「未 align」有误）。align-on-change 看门狗已于 2026-10-10 09:30:53 自动把 `25ac8df4` 投送到 dev/mini 并执行 `--remote-hooks`（证据 `~/.lan-dev-machine/logs/twin-align-watch.out.log:1771`）；之后的版本也会被自动投送。注意 `--remote-hooks` 只校验远端 hooks 文件并写台账，不改远端 `settings.json`，所以 dev/mini 实际生效的 hooks 仍是 V1 路径。align 看门狗按「本机验证通过即投送」运行（用户 2026-10-10 决定；投送门的实现另卡处理，M-06）。
- 预算：shell 397/700、hooks cjs 499/1400、文件 33/40。
- 未做项与风险：
  - 真实 `--hooks`/`--purge-v1` 写入、launchd 都留给元帅执行。
  - 第一段验收时默认 install 没设 `SA_LAUNCHD_DIR`，改写了真实的 `~/Library/LaunchAgents/com.wetamp.superagent.supervise-tick.plist`。已用 install 生成的 `.bak-20261010090540` 还原，未执行 launchctl。
  - codex 从 0.160.0 漂移到 0.162.1，`features.multi_agent` 键若改名不会报错。
  - 删除拦截只认字面路径。
  - G-1 不计 shell 写文件和 `*.md`。
  - Archon 评审节点也用 240K 阈值。
  - `exclude_user_instructions` 在 Archon 中没有对应字段。
  - `install.json` 与 V1 台账同位置。
  - 额外试跑 `selftest.sh --repo <只有空提交的临时仓库> --fake` 失败：archon detached 子进程启动时退出 1；selftest 被 `set -e` 截断，没打印 fail 信息。未深究，卡片要求的 `--fake` 默认用法已通过。

## WP-B R1 修复摘要（评审 `wpB-astra-r1`，2026-10-10）

- H-01 N-1 绕过：`hooks/shell.cjs` 的 `lift/unwrap/parse` 按参数语义剥离 env/sudo/xargs/timeout/nice/time/command/exec/rtk proxy 等包装器，递归 `$(…)`、反引号、`bash -c`、`eval`、`find -exec`、`env -S`；单引号内是字面量。
- H-02 reviewer 只读：`src/archon.ts` 保留继承的 reviewer/general；`tiers.json` reviewer `denied_tools` 加 Edit/Write/MultiEdit/NotebookEdit；`codex-worker` reviewer 下加 `sandbox_mode="read-only"`；`guard.cjs` `reviewerShell` 白名单 + 写重定向检查。
- H-03 去重丢 matcher：`src/install-hooks.ts` 去重键为（事件 × 组级条件 × 规范 command），补齐只认"全部" matcher 分组。
- H-04 MCP 名：`codex-worker` 用 `python3 -I` + `tomllib` 取 `mcp_servers` 键，不安全名字跳过并记 stderr；不可用时退回表头正则。
- M-01 Stop 门：新建 `hooks/stop-gate.cjs`，恢复 advisory/cycle/change、评审指纹、unknown；`change` 真阻断，同令牌第二次放行防死循环。
- M-02 递归：`codex-worker` 对选定路径 realpath，指向自身、不存在或不可执行时 exit 2。
- M-03 TRACE：只打 `{policy, argv}`，敏感值换成 `***`，超过 200 字符截断。
- M-04 context-budget：尾部 `claude` 参数归一去掉，只留一条。
- M-05 缺失配置：settings.json/hooks.json 不存在时按空文件补齐并创建；dry-run 打印与空文件的 diff，不写。
- 顺手：micro-edit 累计放进 `stopGate.withState` 锁内（`wx` 锁文件），拿不到锁拒绝；删除拒绝信息只回显 basename。
- 文档：`04-hooks-and-nesting.md` 补包装器剥离规则、reviewer 只读边界，并修正 Stop 门/计量/包装器的过时描述；本文 twin-dev 一行改为事实（已 align）。
- 测试（新增 12 条，均在 HEAD 25ac8df4 旧代码上失败）：hooks 6、exec-profiles 4、generate 断言 1 处、install 2。
- 验收：upstream-clean 空；`tsc --noEmit` rc=0；`bun test` 168/168；根 `bun run lint` rc=0；临时 home + `SA_LAUNCHD_DIR` install ok、`selftest.sh --fake` ok；真实 `--hooks --dry-run` 只改 12 条路径、无重复；smoke-guard 13/14（第 2 条按规则拒绝）。
- 预算：shell 436/700、cjs 783/1400、文件 34/40。
- 剩余风险：
  - Codex reviewer 节点的 `-c sandbox_mode` 被 Archon `thread/start` 的 `danger-full-access` 覆盖，实际边界是 `mutates_checkout:false`。
  - reviewer 白名单只对设了 `SUPERAGENT_ROLE=reviewer` 的会话生效。
  - Stop 门不跟踪 shell 写到其他仓库的改动；`claude -p` 方式的评审不算证据。
  - M-06（自动投送未评审版本）由元帅处理。

## WP-B R2 修复摘要（评审 `wpB-astra-r2`，2026-10-10）

- H-02a Codex reviewer：Archon 在 `thread/start` 固定传 `danger-full-access`，且不支持逐节点 env。改为 `generate` 给 Codex 评审节点写 `mcp: reviewer-readonly.mcp.json`，内含哨兵 server `codex_readonly_marker`（`required:true`，命令 `false`）。`codex-worker` 以 `app-server` 被调用时改经新文件 `bin/codex-readonly-proxy.cjs`：见到哨兵就删掉它，本连接 thread 改 `read-only`、turn 注入只读 `sandboxPolicy`。绕过代理时哨兵起不来，线程创建失败（已用 codex 0.162.1 实测）；不能解析的 reviewer 输入或哨兵出现在线程参数之外时，代理退出 1。
- H-02b Claude reviewer：评审节点带 `sandbox:`（`tiers.json` `exec_profiles.reviewer.claude.sandbox`：`denyWrite:["/"]`、`failIfUnavailable`、`allowUnsandboxedCommands:false`）。
- H-02c `hooks/shell.cjs`：`time -o/--output`、`env -C/--chdir`、`sudo -D`、`nohup`（`nohup.out`）、`script` 的记录文件与日志选项、`tee` 的文件参数都按写入计入；新增 `script -c` 剥离。
- M-06：上文 twin-dev 一行补全 `--remote-hooks` 的实际作用和投送口径。`src/archon.ts` 注释与 `04-hooks-and-nesting.md` 改为以执行层沙箱为主边界，hooks 只是纵深防御。
- 测试：generate 2 处（两种控制台的生成物、golden）、exec-profiles 3 条（代理改写与透传字节一致、`SUPERAGENT_ROLE=reviewer`、失败关闭）、hooks 1 条（7 例包装器副作用）。7 条在 HEAD b9a4ad3a 的实现上都失败。
- 真实探针：
  - Codex：经 Archon `CodexProvider` + `codex-worker` 各跑一次。reviewer 节点执行 `printf x > /tmp/sa-h02-probe-codex` 返回 `operation not permitted`，exit 1，文件不存在；无哨兵的节点写 `/tmp/sa-h02-probe-codex-coder` 成功，exit 0。
  - Claude（haiku）：带上述 sandbox 设置执行 `printf x > /tmp/sa-h02-probe-claude` 返回 `operation not permitted`，文件不存在。
- 预算：shell 438/700、cjs 905/1400、文件 35/46。
- 剩余风险：
  - 代理依赖 Archon 的 JSON-RPC 方法名与 `config.mcp_servers` 透传；上游改协议时，哨兵会让线程起不来，暴露为失败而不是可写。
  - 未调用的 `@sa-reviewer-alt` 没有生成只读设置。
  - Claude sandbox 依赖 macOS Seatbelt，不可用时 `failIfUnavailable` 直接失败。

## WP-D board

- 为何 Ink：React 组件 + Yoga 布局，彩色表格、反色选中、滚动、按键与 SIGWINCH 重排都是现成能力；`renderToString` 让 `--once` 与交互模式出同一个 `Frame`。ink@8 + react@19 在 bun 1.4.2 下渲染正常，未退回 ink@6，未加 @inkjs/ui。
- 依赖隔离：ink/react 只在 `wetamp/package.json`（`wetamp/bun.lock` 冻结）声明，根 `package.json`/`bun.lock` 不变；`cli.ts` 在 `import.meta.main` 处对 `board` 动态 `import('./board/index')`，其余动词与 hooks 启动时不加载 React；只有 `--json` 不渲染、不需要 ink；`--once`（renderToString）与交互模式都需要 ink，缺失时在首轮加载**之前**提示 `cd <wetamp> && bun install` 并退出 64。`install.sh` 默认模式 `bun install --frozen-lockfile`，失败只警告「board 不可用」，`--remote-hooks` 不装。
- 数据：复用 `cli.ts` 的 ledger/classifyRun/artifactsOf/gatesOf/asksOf；`report()` 拆出纯函数 `summarize(pairs)`，report JSON 不变，board 汇总与 report 同口径（测试断言相等）。
- 缓存：每个 board 进程一个加载器，按 ledger mtime 取最新 `--limit`（默认 50）个；只缓存不可逆终态（completed/cancelled）且 ledger mtime 未变的 run；failed 与 held:\* 每轮重查，因为 cancel/reject/decide 只改 Archon、不写 ledger（R1 D04 选方案②，不改 cli.ts）；其余 run 每轮 `workflow get` 一次（`Bun.spawn`，并行 ≤3，上一轮未回不叠加）。单次查询默认 10s 超时（`SA_BOARD_QUERY_TIMEOUT_MS` 覆盖，非正数拒绝），超时或按 q/卸载取消时对子进程所在进程组发 SIGKILL（孙进程也握着 stdout 管道）；失败沿用上次结果并标 `~`（stale），从未查到过则为 unreadable 行；坏 JSON、非对象（null/数组/标量）、缺字段的 ledger 都是 unreadable 行，不中断其余行。
- 路径边界：plan、gen_dir、transcript、evidence 与各 gate 文件先取 realpath，只读落在 `ledger.repo` 或 `$SUPERAGENT_HOME` 内的；越界（`../`、绝对路径、软链指出）显示 `（路径越界，已跳过）`，不读取。
- 详情：plan 包与里程碑、各轮 gate 结论（verdict/reason/debt 数）、transcript 末 8 条事件（滤掉 provider_event/watchdog_reset 噪声；exec_output 先脱敏再取末 120 字符；Authorization 遮蔽整个值到行尾或收尾引号，token/key/secret/password 遮蔽整个值，带引号与转义的值整体遮蔽，裸 Bearer 凭据遮蔽）；表格各列固定 1 个空格分隔，表头同一套宽度，宽屏放不下全部列（<121 列）时 nodes 只显示 `n/m`、去掉 console 与 repo 列、asks、held 时的 decide/accept/recover 提示。
- 验收：`bun test` 180/180（新增 `tests/board.test.ts` 12 条）；`tsc --noEmit` rc=0；wetamp eslint（嵌套配置）与根 `bun run lint` rc=0；临时 home install ok、`selftest.sh --fake` ok（`board:{rows:1}`）；真实 `~/.superagent` 只读 `board --once` 渲染 3 个 run、`--json | jq .summary` 可解析；`script` pty 交互 j/Enter/q 正常退出 0。
- 预算：shell 445/700、cjs 783/1400、文件 40/46。
- R1 修复（astra R1 D01–D06）：脱敏整值、查询超时与取消、非对象 ledger、缓存方案②、路径边界、列分隔与 80 列布局；ink 检查前移。`tests/board.test.ts` 22 条（新增 10 条）。预算 shell 445/700、cjs 783/1400、文件 40/46。
- 已知限制：currentRole 取自生成目录里的工作流 YAML，gen 目录被清理后显示 `?`；节点总数在 YAML 不可读时退回 run 已调度的节点数；`--once` 在管道里按 160 列渲染；交互模式每 5s 对每个非终态 run 起一个 archon 子进程（约 0.3s/次）。

## WP-BT board 时间

- 开始时刻取 ledger `started_at`（提交时刻，resume 不变；不可解析才退回 Archon 的，后者每次 resume 重置），排序同口径；终态止于 `completed_at`，缺则 `last_activity_at`，都缺显示 `-`；running/held 止于 now。行带 `span{started_ms,ended_ms}`，界面用 1s 时钟经 `elapsedAt` 重算，`--json` 的 `elapsed_s` 为取数时刻值。
- 所有界面时刻经 `fmtClock` 按进程本地时区（尊重 `TZ`）显示：当天 `HH:MM:SS`，否则 `MM-DD HH:MM`；header `last` 去掉 `Z`，detail 首行加 `开始 · 耗时`；`--json` 原始 ISO 不变。
- 验收：`bun test` 200/200（board 27 条，新增 5 条）；真实 `~/.superagent` 只读 d01a 显示 23m26s（原 2m40s）。预算 文件数不变。

## wpE caps：最大权限 + 红线 + 自动重试（2026-10-10）

- caps：plan 级与包级 `caps{network,web,install,services,long_tests,read,git,mcp}` 默认全开，只做收紧；Claude 节点落成 `denied_tools`，其余是任务书提示级（`docs/00` §5.1）。
- 将军输出 `deviations[]`（越出 scope 的登记）与 `needs[]`（`{cap,why,minimal_ask}`）；`blocked` 只在红线或 needs 非空时合法。
- 自动重试：`supervise-tick` 对 held:gate（≤2，先追加 `hints/<包>.md`）、held:environment（≤1）、编码节点失败（≤1）自动 retry；needs、红线、截止、次数用尽、连续 no_change、无可重试节点时保持 held。`decide <run> retry [--pkg --hint]`、`decide --all-held retry`。
- 执行层红线：`hooks/redline.cjs`（凭据与隐私路径、发布合并、改写共享分支、按名杀进程、连非本机库、派生会话写出 worktree），每条有 allow/deny 测试；provider × 红线矩阵见 `04-hooks-and-nesting.md`。
- hooks 实测：Claude 节点用户级与项目级 PreToolUse 都触发；Codex 节点只加载用户级 `hooks.json`，git-guardrail 触发，guard 因 trusted_hash 过期被跳过。`codex-worker` 现在失败关闭（exit 3），运维需在交互式 Codex 里 `/hooks` 重新信任 guard。
- M-06（自动投送未验证版本）：`scripts/verify-local.sh` 是本机投送闸；twin-toolkit 的 superagent 维度只把 `verify.json` 中 ok 且等于 HEAD 的提交投送到 twin 机，未通过时打印「本机未通过 …，暂不投送；远端保持 …」，验证期间 HEAD 前移也不投送。
- 预算：shell 591/850、cjs 1119/1700、文件 43（+3：codex-readonly-proxy.cjs、redline.cjs、verify-local.sh；理由见 `docs/00` wpE 实现记录）。
- 已知限制：主工作区合入 `verify-local.sh` 之前，twin-toolkit align 的 superagent 维度报「无法验证」rc=1；OpenCode 与 Codex 侧 caps 只是提示级；远端 dry-run 未在本包执行。

## WP-BT2 看板实时作业+窄屏

- 活动区（run 表上方）：`job exec` 登记作业（`$SUPERAGENT_HOME/jobs/<id>.json` 原子写，不记 argv/prompt；退出码透传、信号转发得 128+n；结束超 24h 回收，死进程记 lost）、未登记无头 AI 进程（一次 ps + ≤8 个 lsof 取 cwd，排除 archon 与已登记 wrapper 的后代）、twin-agent 远端非终态队列；三源并发各 ≤3s，失败降级为一行灰字；chips 增 `[jobs N]` `[remote N]`、空闲行；`--json` 增 jobs/procs/remote/notes。
- 响应式：<80 紧凑（短 id、短 state、`n/m`；running 与选中行第二行 `cur:`；footer `q r j/k ⏎ a ?`，`?` 开完整按键说明）、80–120 中等、≥121 宽屏；chips 整项换行不截断；`--once` 在管道里认 `COLUMNS`。
- 验收：`bun test` 210/210（新增 jobs 7 条、board 3 条）；真实 home `COLUMNS=59 board --once` 每行 ≤59 列（按 Bun.stringWidth 计）且列出无头 claude 将军进程；59 列 pty 交互 j/k/Enter/?/q 退出 0。
- 预算：shell/cjs 不变，文件 43/46。

## WP-BT3 看板交互会话

- 心跳：`hooks/live.cjs` 的 `beat()` 由 guard.cjs / context-budget.cjs 在 try/catch 内调用（不新增 hooks.json 条目），原子写 `$SUPERAGENT_HOME/live/<client>-<sha256(session_id)[:16]>.json`，字段白名单 `{client,session_id,pid,tty,cwd,transcript_path,event,tool,turn_at,at,derived}`；pid 逐级 `ps -p` 只解析一次，连续工具事件节流 2s，任何失败静默；看板读取时回收 pid 已死且 24h 未更新的文件。
- 终端行：ps 里有 tty 的交互 claude/codex/opencode（同 tty 同类子进程并入最外层），状态按 心跳 → transcript/rollout 尾部 64KB（只看事件类型与 stop_reason）→ %CPU 粗判（标 `?`）；只显示 client/状态/tool/cwd 末段/tty/时长，绝不显示 prompt、argv、transcript 文本；派生会话（心跳 derived）不进终端行；chip `[active 执行中/总数]`。
- 一次 lsof：无头进程与终端会话共用一次 `lsof -p … -Fn`（≤24 pid），同时取 cwd 与 codex 握着的 rollout。
- 验收：tsc 0；`bun test` 251/251；wetamp eslint 仅余基线 cli.ts:781；guard claude/codex、context-budget × `ls /tmp`/`pkill -f node` × 可写/只读 HOME 共 12 组 rc/stdout/stderr 逐字节一致；20 次中位数增量 ≤+1.5ms（UserPromptSubmit 必写路径 ≤+3.5ms）；实机 `COLUMNS=59/140 board --once` 每行 ≤59/140 列，无 prompt。
- 预算：cjs 1194/1700（+75，live.cjs）、文件 45（+2：live.cjs、terminals.ts）。
- 已知限制：hook 部署前没有心跳，claude 会话多显示 `未知?`；空闲 codex 不握 rollout；Claude 被中断后 transcript 末尾是 user 条目，会误判执行中直到下一事件；节流可能丢 PostToolUse，tool 名短暂过期。

## S2 流程与成本（WP-3 + WP-4，2026-10-10）

- F-18 disposition：`sa-check settle` 消费 coder `status/blocked/partial/error_class` 与验收 `ok`，只有 done 且验收绿才推进；其余走 repair（当包 `repair` 节点）或挂起（verify/settle/diff 退出 1，reason 写进 gate/settle 产物）。
- F-19 累计台账：`ledgerOf` 由全部历史 review 派生 blocking/debt/来源轮次/关闭证据；关闭须原 ID + 证据；未知 ID 自报 `carry_over:true` 不扩大阻塞集合。三例（R2 漏 R1 高危、新增伪装 carry-over、新 high 债与真 blocker 共存）在 `tests/sa-check.test.ts`。
- F-20 增量：R2/R3 用 `sa-review-delta`（上轮候选→本轮候选的 delta + 台账，完整历史只给路径）；fix 只把台账 blocking 当阻塞，新发现非 blocker 记债。修掉基线即有的 `$INPUTS.round-1`（被解析成名为 `round-1` 的输入，dry-run 在 review-\*-r2 失败）；新增测试：每个命令模板读到的 `$INPUTS.<name>` 必须由节点绑定。
- F-17 effort：生成时按 `tiers.json policy.effort` 写每个 AI 节点（code high、repair/fix medium、review R1 high/R2+ medium、G2 review R1 xhigh/R2+ high）；Archon 事件 `binding.effort` 记录生效值，report 按它统计。不被引擎兑现的 plan 字段在校验时点名拒绝（F-15 清理部分 + A-05）：`mode: single:*`、`concurrency > 1`、包级 `accept_quick`/`fixture_exemptions`、`scope.artifact_paths`。
- F-13 交付范围：`scopeRisk` 用 `git diff --raw -z -M` 的实际 candidate tree（新增/删除/重命名/mode/gitlink/symlink）对照 `scope.write`；越界、gitlink/symlink、命中 risk_paths 推断 G2，有效风险 = max(声明, 推断)。交付门禁，不是沙箱。
- F-14 模型身份：gate 读执行层 `binding.model` 的实际作者/评审身份；同模型、身份未知、评审不完整不算合格独立评审；非 strict 且非 G2 显式 `DEGRADED_PASS`，strict/G2 escalate。
- F-22 + F-16：`src/report.ts`，`superagent report` 增 `usage{total,by_run,by_milestone,by_role,by_attempt,unreadable}`；字段 calls/coverage/input/output/cacheRead/cacheWrite/models/efforts/failures/infra_retries/repair_rounds/queue_ms/exec_ms；未回执记 `unknown` 不当 0，不折算金额。预算门：gate 在 fix 或进下一里程碑前按 `plan.budget` 检查启动数与加权 token（未知单次按 `budget_floor` 预留）。
- F-21 验收缓存：只缓存 plan 标 `cache: true` 的验收命令的通过结果（含外部写/时间/随机的命令不标），键 = HEAD 树 + 命令 + 超时 + plan 声明的环境检查，存本 run 的 ARTIFACTS_DIR；工作区脏不复用；land 前集成验收保留。环境键不再含 PATH（validator 对未声明 env 读告警）。
- 稳定 reason（S1 的"挂起 → 处置"表对齐用）：
  - 挂起：`coder_output_invalid`、`coder_redline`、`coder_needs`、`coder_error:<env|sandbox_denied|permission_denied|vendor_unavailable_all|budget_exhausted|plan_invalid|scope_violation>`、`repair_exhausted:<acceptance_failed|coder_partial|coder_error:*>`、`budget_launches_exceeded`、`budget_tokens_exceeded`。
  - gate escalate：`deadline`、`no_change`、`invalid_review`、`*+review_limit`、`review_incomplete`、`review_not_independent:<reviewer_unknown|author_unknown|same_model>`、`budget_*`。
  - 进 repair：`acceptance_failed`、`coder_partial`、`coder_error:<其余>`。
- 验收：`bunx tsc --noEmit` 干净、`bun test` 258/258、根 `bun run lint` rc=0；`selftest.sh --fake` ok、`verify-local.sh --commit HEAD` ok（均用临时 `SUPERAGENT_HOME`）；two-pkgs dry-run 首轮全过 AI 调用 4 次 = N+M；真实 `~/.superagent` 只读 report rc=0（26 次调用，覆盖 25/26）。
- 预算：shell 452、cjs 1119 未动；文件 +1（`src/report.ts`）。
- 债务：A-04（same-diff 复用条件）、A-12（`policy.json` 是部分快照、无 hash，worker/proxy 未消费）、F-15 剩余（模型池回退）、A-07/08/09、BestIFA 遗留（validate 联动 lint + 宽 glob 告警、`land --each`、accept 显式 `TMPDIR`）、A-06；effort 在生成时按声明风险定，运行时推断升 G2 不回调 effort；Codex 不回执实际模型，身份只到 `<请求名>(pinned)`；report 每个 run 查两次 Archon（`--events` 不带 nodes）；queue_ms 只是 invocation→attempt 间隔；`tests/board.test.ts` 因 report 输出增 usage 做了一行最小改动。

## S1 稳定性 + 无人值守（2026-10-10，分支 `wetamp-s1`，基线 `2bdb0de1`）

- 每个非终态都有主：`HOLD_POLICY`（`src/cli.ts`）一张表决定 supervise-tick 的处置——environment 指数退避（≤5 次、间隔 ≤30min）、非 approval 暂停自动 resume（≤2）、auto_retry_exhausted / no_change / no_attempt_node / recover_no_progress / needs / redline / Archon approval 投一条是/否提醒（键 `<run>:<原因>:<轮次>`，与签收共用"先落盘再投递、按问题前缀找回"）、deadline 按 `expire()` 终止；每次处置写 ledger `dispositions[]`，看板 detail 可见。表的每一行有单测。
- F-02：逐条 ledger 校验，坏 ledger / 读不出的 asks.json 只让受影响的 run 报 `action:error`，从不替换成空表；ledger、asks、attempts、config、selftest/verify 回执同目录唯一临时文件 + rename。
- F-11：fake 自检写 `selftest-fake.json`，正式回执绑定 HEAD、配置哈希、有效期，preflight 拒绝 fake/过期/漂移并给修复命令。F-01：detached 启动前落启动意图，tick 对账"有意图无 run / 有 run 无 ledger"，结论写 ledger，不重复启动。
- worker 桩：`install.sh --remote-hooks` 记 `role=worker`，`bin/superagent` 在 worker 上只答 `--version`/`--help`，其余动词"仅本机运行"退出 69，不依赖 bun/node_modules；twin-toolkit 的 superagent 维度 +10/−2（备份 `twin-toolkit.bak-s1-20261010133209`），未投送。
- Codex 信任：`scripts/codex-trust.cjs` 按 Codex NormalizedHookIdentity 为本 wetamp 的 hooks 条目写 `trusted_hash`（幂等、只动自己的键、保留注释、写前备份、原子替换）；`codex-worker` 改用 Bun.TOML 核验（不再依赖 tomllib），无法判定仍失败关闭。本机真实 config 只读核对 13/13 相符。
- F-07：`wait --timeout` 拒绝 NaN/Infinity/非正数（exit 64）；查询子进程各有期限；recover 锁忙不算业务失败——CLI 动词重读状态按其退出码返回，tick 记 `busy:true`、不记 disposition、退出 0，下一轮再处置。A-03：无失败节点的 failed 输出脱敏 `error`（terminal_record → metadata.error）、枚举形 `stop_reason[:signal]` 与存在的 `evidence_paths`。
- 选做：F-09（wake FD 关闭）、F-12 的 config 原子发布、F-10（gc.sh 不再写 asks.json，tick 回写时丢掉没有 ledger 的 run 的条目）、A-02（gc 只认 `$SUPERAGENT_HOME/gen/<run>` 且非软链，动手前拒绝）。
- 记债：F-06、F-12 的 context-budget 计数加锁（BT3 在改该文件）、A-01、A-10、A-11；按卡不做 F-03、F-05、F-08、A-13、WP-5 压测。S3 已合并脱敏副本、锁内 attempt 计数与本地 git 期限。根目录 `bun run lint` 默认不覆盖 wetamp，wetamp 检查需指定其嵌套 ESLint 配置。
- 预算：shell 608/850、cjs 1234/1700（+115 codex-trust.cjs）、文件 45/46（+2：`src/redact.ts`、`scripts/codex-trust.cjs`）。

## WP-BT4 看板角色

- 角色：英文键 `commander|general|strategist` 不变，中文（元帅/将军/军师/亲兵）只在展示层。作业角色顺序：`job exec --role` → `SUPERAGENT_ROLE`（general→将军、reviewer→军师）→ 心跳 role → 模型只落在将军/军师之一的池（`tiers.json`）时推断，标 `?`；run 节点 coder→将军、reviewer→军师、确定性→引擎。交互顶层终端默认元帅。
- 心跳：`live.cjs` 白名单 `derived` 换成 `role`（commander|general|strategist|null，由 guard/context-budget 传入的 sessionRole 判定）；节流只合并同一事件的连续重复。旧心跳的 `derived:true` 读取时映射为 general。
- 显示：状态符号后加角色标签，`Bun.stringWidth` 按显示宽度截断/补齐；作业/无头进程沿 ppid 链挂到所属终端会话下（` └`），找不到的归 `无主`；chip 只计运行中（执行中终端 + running 作业 + 无头进程）；run 表 current 带节点角色，cur 行中文。
- BT3 遗留：会话不再消失（心跳先绑最近锚点）；Claude 中断显示 `等待输入`；codex 无 lsof 时按 session_meta cwd + 启动时刻匹配 rollout（自造 fixture）。
- 顺带小改：`cli.ts` OPTIONS 加 `role`、`config.ts` Tiers 加 `tiers` 字段（与 S1 可能有文本冲突，均为一行）。
- 验收：tsc 0；`bun test` 255/255；wetamp eslint 仅余基线 cli.ts:782；12 组 hook 输出逐字节一致，中位数增量最差 +1.2ms；live 键集合等于白名单、role 取值合法、无 prompt；实机 `COLUMNS=59/140 board --once` 有元帅终端行，`job exec --role general -- sleep 60` 与本作业作为将军嵌套其下。
- 预算：cjs 1198/1700（+4）、文件数不变。
- 已知限制：已结束且 wrapper 已退出的作业（如 S1/S2）找不到祖先会话，归 `无主`；无 role、无心跳的旧作业按模型池推断，opus-5-5 只在军师池，故 claude 将军旧作业（如 WP-BT3）显示 `军师?`；已安装的 hooks 需重装后才写 role；App.tsx、cli.ts 沿基线未跑 prettier。

## WP-BT5 看板归属（2026-10-10，wetamp-board5，基线 e57bacab）

- run 启动意图/ledger 与 job 新增可选 `launcher {client,pid,tty,cwd,session_id?}`；祖先解析复用 `hooks/live.cjs` 的 owner，交互 CLI 判定由心跳模块导出、board 复用。心跳 pid/client 唯一匹配时才填 session_id；查不到发起者就不写。hook 原判定、退出码和 stdout 不变。
- 同一份 ps 快照挂接：仍在终端会话中的 launcher pid → wait/status/board 的 run id 与祖先链（job 兼容现有 wrapper/child 链）→ 无 launcher 的唯一 cwd 等于/子目录匹配（标 `~`）→ 按完整 cwd 分组、组头显示 basename。多会话或父目录重叠匹配不猜；每条只出现一次，run 表保留。
- 会话下增加 `└ ▶ run HHMMSS-xxxx 状态 n/m 当前节点(将军|军师|引擎)`，节点名按中文显示宽度缩短并保留角色；挂接的 running run 当前角色加入将军/军师 chip。terminal 的已结束 run/job 只显示结束后 30 分钟；未知结束时刻不伪造，仍留原 run 表/jobs 查询。
- board 的 readJobs/readLive 启用只读参数，避免真实记录回写/GC。传统 `superagent jobs` 保留原整理行为；无结束时间的旧 dead running job 在只读视图报告 lost、活动区省略，不每次刷新重新发明结束时刻。持久化或显示均不增加 prompt/argv/transcript 正文。
- 新 fixture 覆盖 launcher 祖先解析、merged codex pid、四级挂接、launcher/watcher 优先级、watcher flags、cwd 唯一性/目录边界、30 分钟边界、read-only 无写入、job exec 发起者持久化、窄屏中文后缀与角色计数；更新旧“无主”布局断言。
- 验证与原始证据：`/var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/wpBT5-3phrabdh/evidence/`（临时、未入库）。`cd wetamp && bunx tsc --noEmit && bun test` 首轮 316/316；最终结果见 tests-final.log。`bun run lint --config wetamp/eslint.config.mjs wetamp/src` 与 e57bacab 对照均只报 5 条原有错误：archon.ts:83/84、cli.ts 基线 1027/1101/1223（本包 +3 行）；本包不新增错误，任务卡所述仅 cli.ts:782 已不对应实测基线。
- hook 验证：guard claude/codex、context-budget × `ls /tmp`/`pkill -f node` × HOME 可写/只读，共 12 组，每组每版本 20 次，stdout/stderr/rc 与 e57bacab 逐字节一致；最差中位耗时增量 +1.41ms <15ms，见 hooks.json。payload 全用文件，危险命令只是输入数据。
- 实机：worktree 入口 `COLUMNS=59 wetamp/bin/superagent board --once` 与 `COLUMNS=140 …` 均 rc=0，无“无主”，终端行不含 prompt。两段原始节选如下；初轮 sinan 旧 run 已 failed，cwd 同时命中 sinan 与多个父目录会话，按卡不猜、放 sinan 目录组。随后新 run 经 watcher 正确挂接。

```text
COLUMNS=59
○ 元帅 claude 等待输入 11m52s · xiaopan-translator · s005
  └ ▶ run 053353-9e81 ▶run 11/27 code-apple-translat…(将军)
○ 元帅 claude 等待输入 37s · sinan · s006
  └ ▶ run 063513-6a28 ▶run 3/19 code-iiqe-question-l…(将军)
```

```text
COLUMNS=140
○ 元帅 claude 等待输入 11m53s · xiaopan-translator · s005
  └ ▶ run 053353-9e81 ▶run 11/27 code-apple-translation-engine(将军)
○ 元帅 claude 等待输入 39s · sinan · s006
  └ ▶ run 063513-6a28 ▶run 3/19 code-iiqe-question-list-polish(将军)
```

- TS 预算：src 下 .ts/.tsx 基线 5032，当前 5115，增量 +83 ≤150（包括新增 launcher.ts 13 行）。不触碰 S3 的 hold/retry、detail 脱敏、git 期限位置。
- 独立评审/主控验收/合并：pending，由元帅安排；本将军未委派、未 push、未合并、未改真实 run/ledger/客户端配置或现有进程。学习收尾按派生角色跳过，交还主控。

## S3 挂起对齐（2026-10-10，分支 `wetamp-s3`，基线 `e57bacab`）

- 合并后实测 5032（e57bacab，wc -l src 下 .ts/.tsx）；本包上限 5200。
- `holdOf` 消费 `verify-*` / `settle-*` 的产物与 gate 稳定 reason，由 `HOLD_POLICY` 唯一分派；未知/缺失产物记 `unknown_reason`，不会静默无人处置。
- 包级自动重试和“是”均在 recover 锁内增加本里程碑 attempt 后 resume；Archon 原已完成 code 缓存因 attempt 输出变化失效。独立性问题的“是”仅增加本轮 `attempt-review-*`，保留已完成编码缓存。
- 预算“是”：按实际 run 事件计算已用启动数与加权 token；增加启动数 `2N+5`（本里程碑 N 包编码/包内修复 + 3 次评审/2 次修复），token 增量 `max(plan.budget.weighted_tokens, (2N+5) × 单次预留)`。单次预留=已知单次最大 token，无已知则取 policy budget_floor.S；未知回执依旧预留。额度只对当前 milestone/attempt 生效；同一问题恢复失败重试复用授权，不叠加；文件 `gen/<run>/budget-extra` 与 ledger `budget_grants` 留证，不折算金额。
- 遗留合并：board 导入共用 `redact`（测试核对函数身份与语料）；attempt 在持 recover 锁且状态可恢复后变化；config/generate 本地 git 与查询子进程统一 120s 期限；hooks 未修改。

| 节点/稳定 reason                                                                                           | 处置                         | 是/否或上限                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| verify/settle `coder_redline`                                                                              | ask `redline`                | 是=已处理，重跑里程碑；否=终止                                                                  |
| verify/settle `coder_needs`                                                                                | ask `needs`                  | 是=能力已补齐，重跑里程碑；否=终止                                                              |
| verify/settle `coder_error:env`、`coder_error:vendor_unavailable_all`                                      | environment 退避             | 本里程碑编码重跑；120s×2^(n−1)，≤30min，次数取 tiers auto_retry.environment                     |
| verify/settle `coder_output_invalid`、`repair_exhausted:*`                                                 | coder 自动重试               | reason + 脱敏验收日志尾追加 hints；次数取 tiers auto_retry.coder，用尽→ask auto_retry_exhausted |
| verify/settle `coder_error:sandbox_denied/permission_denied/plan_invalid/scope_violation/budget_exhausted` | ask `coder_blocked`          | 是=约束已处理，重跑里程碑；否=终止                                                              |
| verify/settle 或 gate `budget_launches_exceeded`、`budget_tokens_exceeded`                                 | ask `budget`                 | 是=增加上述一次 attempt 额度，再跑里程碑；否=终止；禁止自动重试                                 |
| verify/settle 未知 reason、产物缺失/损坏；gate 缺失 reason                                                 | ask `unknown_reason`         | 是=重跑里程碑；否=终止；disposition 明记 unknown_reason                                         |
| gate `*+review_limit`                                                                                      | ask `review_limit`           | 是=再给一轮里程碑修复；否=终止                                                                  |
| gate `review_not_independent:*`                                                                            | ask `review_not_independent` | 是=身份已处理，仅重跑本轮评审；否=终止                                                          |
| gate `invalid_review`、`review_incomplete`、其他既有 gate 原因                                             | gate 自动重试                | 次数取 tiers auto_retry.gate，用尽→ask auto_retry_exhausted                                     |
| gate `no_change`                                                                                           | 保留既有策略                 | 连续两次→ask no_change；是=再给一轮；否=终止                                                    |
| gate `deadline` / plan deadline 已过                                                                       | expire                       | 终止，不投提醒                                                                                  |
| 自动重试用尽 / 旧工作流无 attempt / 恢复无进展                                                             | ask 原行                     | 原 fresh retry / resume 策略不变；否=终止                                                       |
| environment / 非审批 paused / approval / human                                                             | 原行                         | 原退避、≤2次 resume、是/否审批、签收流程不变                                                    |

- 验证进度：新增 reason 矩阵、各 ask 行去重/是/否、锁忙零计数、预算“是”后 sa-check 实际放行且下一 attempt/里程碑拒绝；真实 Archon fake run 从 settle-core 挂起恢复后 `fake core` 提交由 1 次增到 2 次。
- 验收：`cd wetamp && bunx tsc --noEmit && bun test` 通过（352/352，0 fail，14 文件）；根 `bun run lint --config wetamp/eslint.config.mjs 'wetamp/src/**/*.ts' 'wetamp/src/**/*.tsx' 'wetamp/templates/.archon/scripts/*.ts'` rc=0；隔离临时 `SUPERAGENT_HOME` 的 `bash scripts/selftest.sh --fake` 返回 `ok:true`；源码实测 5183/5200 行，hooks diff 为空。日志 `/tmp/s3-all-final.log`、`/tmp/s3-lint-final.log`、`/tmp/s3-selftest.log`。
- 提交绑定复验：`SUPERAGENT_HOME=<同一临时目录> bash scripts/verify-local.sh --commit HEAD` 在 detached scratch worktree 执行；最终 HEAD、逐步退出码和日志路径由该临时目录的 `verify.json` 与交付回执记录。
- 记债：旧工作流没有 `attempt-review-*` 时拒绝独立性评审重跑，需新 run；独立 G2 评审与主控验收由元帅安排，本派生会话不代签。

## WP-BT6：模型标签、全量本机用量与 Web 大看板

- 范围：`wetamp-board6`，基线 `e57bacab`；将军编码端，不委派、不 push、不合并。短模型命名由 `src/models.ts` 统一，显式绑定/作业记录优先，其次 live、最多 64KB 的会话尾部模型元数据；紧凑布局仅显示族名。角色类型从 `src/roles.ts` 导出，避免 usage/jobs/CLI 循环导入造成命令卡死。
- 用量：固定 `ccusage@20.0.28`，Claude/Codex session+daily，nice、每子进程 120s、flock、5 分钟缓存和原子持久索引。run > job > interactive > inferred(?) > unknown；Codex thread UUID 后缀去重。作业只在 cwd/启动时间 ±60s 唯一匹配时登记 session_id；未知索引也持久保存。多模型分项、kind、Top、每日数值通过 usage --json/Web 提供；daily 无会话数则显示未知。采集失败 total=null，保留旧缓存并给出各来源成功时间；CLI/report 不输出金额，Web 的金额仅为公开价目估算，缺值显示未知。
- 安全：服务只绑 127.0.0.1，端口 39890 起顺延；单实例锁，web.json 0600，随机 token 与 HttpOnly/SameSite=Strict cookie；Host 白名单、只允许 GET/HEAD；CSP default-src self + 内联 hash、nosniff、no-referrer、no-store。API 使用显式字段投影，不传 prompt、argv、transcript/rollout 正文；stop 校验记录 PID 的精确 argv 后仅停本服务。
- 完成：模型四类行/头部 chip、今日 token/宽屏逐行 token、usage CLI、report.full_usage、本机 Web 命令、OSC8 链接；Web 复用 board loader，不另建采集器。

### 验收 1–5

1. `cd wetamp && bunx tsc --noEmit && bun test`：317 pass / 0 fail（15 文件）；最后两处纯命名/lint与轮次显示调整另跑 `bunx tsc --noEmit && bun test tests/usage-web.test.ts`：11 pass / 0 fail。证据 `/tmp/wpbt6-tests-final3.log`、`/tmp/wpbt6-usage-test-final2.log`。
   `bun run lint --config wetamp/eslint.config.mjs wetamp/src`：没有新增错误，仍有 5 条基线（archon.ts 84/85，cli.ts 1031/1105/1227）。以 e57bacab 原文件在同配置下复测也有这 5 条，卡片所谓仅 cli:782 已过时；证据 `/tmp/wpbt6-lint-final4.log`、`/tmp/wpbt6-lint-baseline.log`。
2. 新增 11 个 fixture/安全/布局测试：已覆盖模型映射和未知/紧凑、两家 JSON 与 UUID 去重、归属五级和持久优先级、多模型、失败未知/缓存、Host/token/method/cookie/CSP、API 无敏感键、100/120/140 列 run 模型与 token 不截断。测试没有调用真实 AI。
3. 实机 `wetamp/bin/superagent usage --refresh` rc=0；`report --json` rc=0。run 35,357,847 / 35 会话，job 79,699,246 / 7，interactive 492,036,949 / 21，unknown 40,127,889,106 / 4636，未归属占 98.510%。只覆盖本机日志，开发机/mini 不含。
   对账：9 个状态稳定、有完整 Archon spend 的 run 全部精确一致；示例 20261010-005251-7ce7 两端均 781,219。两条采集时仍运行的 run（20261010-062040-aa74、20261010-063513-6a28）分别出现 1,397,158 vs 1,304,202、1,094,375 vs 724,986；ccusage 日志快照与 Archon 完成事件/归属采集窗口不同，不能宣称当前全量实时一致。Archon input 已含 cacheRead/cacheWrite，归一化应 input+output，与 ccusage total 比较，不能再叠加缓存。证据 `/tmp/wpbt6-report-final.json`、`/tmp/wpbt6-usage-final.txt`。
   `web start` → curl：带 token 200，缺/错 token 401，Host evil.test 403，POST 405；安全头均存在，web.json 0600，API forbidden_keys 为空。实测 PID25279 绑定39890，`web stop` rc=0、ps 确认退出。仅回收本会话启动的服务；证据 `/tmp/wpbt6-overview-final.json`。
   `COLUMNS=59/140 wetamp/bin/superagent board --once` 均 rc=0、stderr 空，OSC8 链接、59列族名、140列版本名/逐行 token/今日总计已见。下方摘录中的 URL token 已脱敏。
4. `git diff -- hooks wetamp/hooks` 无改动；本包不改变 hook 判定/退出码/stdout，无需运行 BT4 12组差分。`git diff --check` 通过。
5. TS/TSX 总计 5381，基线5032，净增349 ≤450；index.html 36 ≤350。没有增加前端框架/CDN。

### 实机摘录

```text
全量（ccusage） · 仅本机日志；开发机 / mini 不含
ok · 缓存 2026-10-10T06:59:02.214Z
kind input output reasoning cacheRead cacheWrite 合计 会话数
unknown 2177336535 189363390 28150626 37592893836 167570180 40127889106 4636
interactive 1671102 4693547 54503 469445413 16226887 492036949 21
job 899605 675690 29215 75965392 2158559 79699246 7
run 4268341 440234 88682 30483230 166042 35357847 35
角色×模型
?·sol5.6 1310974775 84711064 17198421 17492130792 0 18887816631 1209
?·astra 323219211 30972559 4967371 4645724032 0 4999915802 1131
?·glm-5.2 17654688 130925 0 8671168 0 26456781 4
?·opus5.5 39576 17816502 0 5436041235 64715796 5518613109 161
?·sonnet5.5 2988 1917946 0 280304015 9163329 291388278 20
?·opus5 1776511 16408754 0 4186341226 57304036 4261830527 189
commander·opus5.5 9078 3633406 0 406423161 13211485 423277130 3
commander·fable5.1 13856 880475 0 41605420 2990356 45490107 2
?·opus4.8 700 380771 0 35187272 1139302 36708045 18
?·opus4.6 30614043 235550 0 1394946 21204 32265743 13
?·sonnet4.6 15355590 119071 0 4396600 6742251 26613512 6
?·opus4.7 17653381 235938 0 5819785 12962347 36671451 15
```

```text
COLUMNS=59
superagent board 15:00:47 · /Users/yong/.superagent
]8;;http://127.0.0.1:39890/?t=<token>\大看板]8;;\
[running 3] [held 0] [failed 1] [completed 10]
[cancelled 3] [元帅 2·opus] [将军 2·sol] [军师 0]
[remote 0] debt 22 · first_pass 10 · every 5s
· last 15:00:45 tok 今日 614.6M
● 元帅·opus claude 执行中 30s · xiaopan-translator · s005
● 元帅·opus claude 执行中 Bash 4s · _mcp_workspace · s009
  └ ▶ 将军·sol job 56s codex · HF1 error_class 误判热修
  └ ▶ 将军·sol job 27m09s codex · BT6 模型名+全量用量+Web …

COLUMNS=140
superagent board 15:01:27 · /Users/yong/.superagent
]8;;http://127.0.0.1:39890/?t=<token>\大看板]8;;\ http://127.0.0.1:39890/?t=<token>
[running 1] [held 0] [failed 3] [completed 10] [cancelled 3] [元帅 2·opus] [将军 2·sol] [军师 0] [remote 0] debt 22 · first_pass 10
· every 5s · last 15:01:25 tok 今日 614.6M
● 元帅·opus5.5 claude 执行中 1m10s · xiaopan-translator · s005 tok 44.5M
● 元帅·opus5.5 claude 执行中 44s · _mcp_workspace · s009 tok 364.8M
  └ ▶ 将军·sol6.1 job 1m36s codex · HF1 error_class 误判热修
  └ ▶ 将军·sol6.1 job 27m49s codex · BT6 模型名+全量用量+Web 看板 tok 5.8M
○ 元帅 claude 未知? · _mcp_workspace · s002
○ 元帅 codex 未知? · _mcp_workspace · s003
```

### 遗留与交还

- 历史 98.51% 未归属：过去没有持久 session_id/角色证据，不猜历史归属；新会话结束后已知/未知索引均继续保存。活动 run 的会话归属依赖 Archon 事件，实时刷新存在窗口差异。
- BT5 的 launcher/run→发起终端挂接尚未合入本 worktree；Web 当前可挂作业，run 表独立显示。元帅合并 BT5 后需验证终端下 run 挂接与共享文件冲突。
- OpenCode 可选来源未接；默认浏览器 --open 已接入但没有打开操作者浏览器做视觉验收。HTML/CSP/cookie 和 HTTP 行为已实测。
- G1 合格独立评审及元帅最终实测 pending；没有宣称上线/合并。派生会话按 agent-evolution 跳过自动学习晋升，交还主控；可复用证据是两家日期字段 period/date 与缓存 token 对账口径。

## HF1 error_class

- 根因：`done` 且验收全绿仍因 `error_class:task` 进入 repair，settle 再以 `repair_exhausted:coder_error:task` 挂起。
- 改动：红线与 blocked needs 优先挂起；done 以验收证据判定，绿时忽略其他类别、保留原值并在 coder 存档标记 `error_class_ignored:true`；schema 与修复提示明确成功填 null，两份 golden 同步。
- 测试：HF1 回归旧实现 3/3 失败、修复后 3/3 通过；`bunx tsc --noEmit && bun test` 通过（366/366，0 fail），隔离 `selftest.sh --fake` 与 lint 通过；提交绑定 `verify-local.sh --commit HEAD` 结果见同一临时目录 `/tmp/hf1-error-class.AmFqfG/verify.json`。

## HF2 核心理念

- 单一来源：`templates/.archon/principles.md`；README 只链接，不复制内容。
- Archon 命令加载器直接读 Markdown，`include:` 只组合工作流；`src/generate.ts` 按实际 AI 节点引用的命令去重，统一原样前置理念文本，缺失即明确失败。
- 每个 AI 节点增加约 350–500 token（按模型分词而异）；稳定前缀可随提示参与缓存，实际命中取决于供应商阈值和请求上下文。script/bash 与 fake 桩不注入。
- 回归覆盖所有 AI 命令的首部/单次出现、确定性节点不变、缺失来源失败；工作流拓扑未变，golden 无需更新。独立评审与主控验收由元帅安排。

## HF3 重试用最新引擎

- 指纹：按排序后的相对路径与文件内容计算 SHA-256，覆盖 `templates/.archon`（scripts、commands、principles）、`src/generate.ts` 与 `src/config.ts` 的生成逻辑、output schema、brief、tiers；写入 `gen/<run>/engine.json`（同时记录 fake 模式）与 ledger `engine_hash`。旧 ledger 缺指纹即 stale；status/brief 显示 `engine: current|stale(<hash前8>)` 和最新 adoption。
- 恢复：统一入口在 recover 锁内重新读取 ledger 和 Archon run，使用 Archon 的 `TERMINAL_WORKFLOW_STATUSES` 判终态。终态且 stale 时把旧 `.archon` 备份为 `.archon.<旧hash前8>`（未知为 unknown；重复备份加时间后缀），同一 gen 重新生成并 validate；`plan.json`、`attempts/`、`budget-extra`、hints 保留。锁使用首次 Archon ID，续接后不换锁；adoptions 与新 ID、指纹、恢复计数经同一次原子 ledger 写入发布，锁忙不消耗计数。相同指纹仍 resume；运行中 owner-lost 和 paused 保持原快照。
- 原生参数：`archon workflow run <wf> --adopt <old-id> --workflow-source <gen> --cwd <repo> --detach`，不传 branch/from/base/no-worktree/resume。真实实测发现含 aliases 的 `--config` 也被 `run-preflight.ts` 拒绝，因此 adoption 继承原生 AI 配置，仅重新捕获工作流源；新任务照常使用当前 run-config。没有修改 Archon 快照、manifest、run 摘要或 `packages/`。
- partial：红线、blocked 与环境/权限挂起规则优先保持；`partial` + 绿验收返回 `advance,coder_partial:true` 并存入 verify/settle 产物，R1/R2/R3 提示军师核对完整性、缺失记 blocker；`partial` + 红验收仍 repair。债：未实现跨 run 跳过 code 节点，续接时允许重跑编码；复用 Archon 原生 adoption，没有自造跨 run 缓存。G2 独立评审、主控最终实测待元帅。
- 验证：单测覆盖指纹稳定/模板与生成逻辑敏感、resume/adopt 参数、缺字段旧 ledger、终态/paused 分流、运行时文件保留、原子 ledger、锁忙、失败 adoption 后可重试、partial 绿/红。`selftest.sh --fake` 复用现有临时 home/Archon/repo，并复制临时安装后只改那份模板；真实 run 在 settle-core 失败，经 decide retry adopt 完成。全量测试、lint 和提交绑定 verify-local 的结果记录在本任务隔离验收目录（见交付）。`hooks/*` 无改动。

关键五行（隔离 fake 自检原始输出，非生产 run）：

```text
HF3 1/5 old=cb489a0f29d9be267d27d73394f8b222 status=failed node=settle-core head=4fb2afb80dc89b854161aab95a854cd6102c98a0
HF3 2/5 new=9183555754011750adb265ea32bdb344 adoption=engine_stale
HF3 3/5 snapshot=/var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/sa-selftest.VFMSRA/archon/workspaces/sa-selftest.VFMSRA/origin/workflow-source/runs/9183555754011750adb265ea32bdb344/project/.archon/scripts/sa-check.ts marker=true
HF3 4/5 worktree=same old_commit=preserved
HF3 5/5 status=completed engine=current
```

## WP-BT7 引擎驾驶舱

- 单一模型：`src/board/cockpit.ts::cockpit()` 纯投影，Ink 默认页和 Web `/api/overview.cockpit` 共用；Web 首屏只渲染这个字段，不另推导指标。默认四段为今日指标/用量、需要你、进行中（含派发作业一行）、今日结果；底部保留终端汇总。需要你为空时隐藏，结果最多五条，`a` 展开，`t` 保留 BT3–BT6 的终端/归属/进程明细，`⏎` 仍进详情，`w` 打开 BT6 大看板链接。
- 指标口径：以进程本地时区午夜为当天开始；达成 = 当天开始且 completed 的 run / 当天开始且 completed 或 failed 的 run；cancelled/held 不进分母。一次通过按 run 计：completed、全部里程碑 R1 gate pass、没有执行 repair/fix 节点且没有自动重试。人工介入计当前保留 ledger 中当天 `dispositions.action=ask` 的次数（ledger 原机制只保留最近二十条，不能重建已退休记录）；评审债直接用与 report 共源的 `summarize().debt`。默认加载全部登记 run，避免旧默认五十条截断日指标；显式 `--limit` 是操作者选择的采样范围。
- 需要你复用 S3 `HOLD_POLICY` 的确定性后果、asks 状态和处置时间；阶段条按实际节点状态/当前里程碑计算，R2 不受 R1 失败或 skipped R3 污染，成功 repair/settle 覆盖同包旧失败，里程碑排序复用 `plan.ts::milestones`；今日结果按终态结束时刻筛选（包含昨日开始、今日结束的 run）。标题从 repo 相对 plan 路径读取，缺失时尝试受同一 confined 边界保护的生成 plan，无法确认显示未知。失败原因只取结构化 reason，不分类错误 prose。
- reason 中文唯一映射位置：`src/board/cockpit.ts::REASONS`，`satisfies Record<keyof typeof HOLD_POLICY,string>` 与单测共同覆盖 S3 全表；未知值原样保留。心跳只读现有 `supervise-tick.log` mtime，超过三分钟或缺失标 ✗；日志 mtime 是运行近似信号，不是成功处置证明。
- 用量复用 BT6 collector/index/cache：保留全量 session/daily，不改变原报表；同一刷新任务额外用原 collector 的 `--since <当天>` session 结果写入 `today`，沿用归属索引计算角色·模型族。当天 scoped session 总量不同于历史会话累计；跨午夜、老缓存或当天采集失败显示角色今日用量未知，ccusage 全量采集失败显示 tok 未知。run token 仍取已归属 run 的累计会话用量，缺归属显示未知。五秒刷新沿用 loader，ccusage 在原异步用量刷新中运行，渲染路径无子进程。
- 入口兼容：`bin/superagent` 的 board 分支直达 `src/board/index.ts`，本模块处理 `--view cockpit|terminals`，避免修改 HF3 同时工作的 `src/cli.ts`。其他动词入口不变。中文宽度按 `Bun.stringWidth`，题目按剩余宽度留省略号；≥100 列追加短 id/轮次。
- 验证证据（仓库外）：`/tmp/wpbt7-tests-final.log`、`/tmp/wpbt7-lint.log`、`/tmp/wpbt7-eslint.log`、`/tmp/wpbt7-board62.txt`、`/tmp/wpbt7-board120.txt`、`/tmp/wpbt7-terminals.txt`。实机命令分别为 `COLUMNS=62/120 NODE_ENV=test wetamp/bin/superagent board --once`、`COLUMNS=120 NODE_ENV=test wetamp/bin/superagent board --view terminals --once`；只屏蔽 Web 启动和用量后台刷新副作用，读取真实本机 ledger/Archon/缓存，未重启 pane。当前真实缓存尚无 `today` 字段，显示未知是预期，待后续正常刷新才有当天角色量。
- `cd wetamp && bunx tsc --noEmit` exit 0；`bun run lint` exit 0。仓库默认 lint 清单未含 wetamp，另经同一 `bun run lint` wrapper 加临时 TS recommended 配置明确检查本包十个 src 文件，exit 0（不冒充全套 typed ESLint 覆盖）。TS/TSX 基线 `20d7b9cd` 为 5631 行，本包 5497 行，净减 134；`cockpit.ts` 90 行；未改 hooks、HF3 三个文件或 node_modules 软链。
- G1 独立评审与元帅验收 pending；本将军不派生评审，不合入或发布。派生会话按 agent-evolution 跳过学习晋升；无独立评审的候选不作为已验证经验。

62 列真实输出片段（2026-10-10 15:30）：

```text
superagent 15:30:22 · 心跳 54s ✓ · 大看板
今日 达成 10/13 · 一次通过 10 · 人工介入 4 · 评审债 22
tok 今日 614.6M  角色今日用量未知
━ 需要你 2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
? sinan IIQE 题目清单报告… 重试已用尽：是=再跑 否=终止 22m01s
? sinan IIQE 本次新增与修… 重试已用尽：是=再跑 否=终止 23m12s
━ 进行中 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ xiaopan-translator 移植 P1–P5 到 e890971 并合并… 22m16s 未知
  M1/1 编✓ 验◐ 评· 门· 合·  引擎
▸ 作业 2 · 将军·sol6.1 BT7 引擎驾驶舱 14m21s · 将军·sol6.1 HF…
```

120 列真实输出片段：

```text
▶ xiaopan-translator 移植 P1–P5 到 e890971 并合并冲突 +1 22m16s R- 未知 070806-57e6
  M1/1 编✓ 验◐ 评· 门· 合·  引擎
✗ sinan IIQE 题目清单报告：5 道改答案题补「修订前」版本，节分布按章… 31m58s R- 725.0K repair_exhausted:coder_error:task
✗ sinan IIQE 本次新增与修改题目清单：给人看的 Excel + Markdown 报告 46m16s R- 1.3M repair_exhausted:coder_partial
```

终端视图真实输出片段：

```text
● 元帅·opus5.5 claude 执行中 2m12s · _mcp_workspace · s009 tok 364.8M
  └ ▶ 将军·sol6.1 job 10m23s codex · BT7 引擎驾驶舱
  └ ▶ 将军·sol6.1 job 10m28s codex · HF3 重试用最新引擎
  └ ✓ 将军·sol6.1 job 10m44s exit 0 codex · HF2 核心理念注入
  └ ✓ 将军·sol6.1 job 13m18s exit 0 codex · HF1 error_class 误判热修
○ 元帅 claude 未知? · _mcp_workspace · s002
○ 元帅 codex 未知? · _mcp_workspace · s003
```

### WP-BT7 追加：叠加进度与 ETA

- 复用来源：`usage.ts::claimsOf()` 已有的 `workflow get --verbose --events --json` 同一次结果，按 `node_completed.data.timing.durationMs`（兼容 `duration_ms`）取各类别历史成功耗时中位数，无额外采集查询或守护。完整待执行集合复用 `workflowRoles()`；已 skipped 节点权重为零，尚未决定的条件分支仍计入预期，后续跳过后再去除。
- `board/eta.ts` 只在原用量后台刷新任务中计算，沿用原 refresh.lock 与五分钟缓存节奏，原子写 `$SUPERAGENT_HOME/usage/eta.json`。board loader 只读缓存，render 不查事件/启动进程。超过十分钟、数据不合法、缺工作流/当前开始时间时显示 `?% 剩?`；可用历史少于三例时，用当前 run 已完成节点的实际耗时中位数作为稀疏类别权重，再按 run 已用时 / 已完成权重线性外推，标 `剩~?Nm`。没有已完成耗时证据就保持未知，不按节点个数伪造比例。
- 当前节点贡献 `min(已用时,预期)`，剩余取当前差额加后续预期；超时以 `超~Nm` 显示。总进度按各 run 预期时长加权，总剩余取并行 run 最大值（头部始终显示剩余；单 run 超时另显示超）；有无法估计的 active run 时总量也未知。作业仍仅显示已用时。`cockpit.active[].progress`、`total` 与相应显示文字统一供 Ink/Web 使用，Web 仅设置宽度/渲染，不另算 ETA。
- 复用调查：现有依赖只有 Ink/React；查过 `@inkjs/ui` ProgressBar 源码（仅 value、completed/remaining 区）及 npm `ink-progress-bar` 的 props（character/percent/left/right），均没有按填充边界分色的文字叠加 slot，后者还使用旧 Ink Color API。故自写 `board/ProgressBar.tsx` 18 行，无新依赖；字符分段用 backgroundColor 与前景色，宽屏条宽三十列、紧凑条按剩余列数，不够十四列/完整标签则退化纯文本。Web CSS 在同一条上叠加共享标签。
- 新增七项 ETA 测试与原驾驶舱快照合计十六项通过：长 code/短 verify 不等于节点比例、skip 零权重、超时、linear/unknown、总权重与最大剩余、叠加文字宽度、原子缓存/坏缓存/过期、同一次已有查询同时生成 ETA。证据 `/tmp/wpbt7-progress-tests.log`；62/120 快照保持完整 `47% 剩~12m`，默认无终端 id。
- 追加 TS/TSX 净增 105 行（≤120）；最终 src 合计 5602，基线 5631，整体净减 29（主体净减 134）。`cockpit.ts` 96 行（≤200）。未动 hooks、HF3 的 cli/generate/sa-check、现有 ledger/run 或 pane。
- 当前真实用量缓存还没有 ETA/today 数据，实机正确显示 `?% 剩?` 与角色今日量未知；待入口正常后台刷新后取得真实估计。另用隔离临时 home + Archon stub +历史 fixture 通过 worktree 的 `bin/superagent board --once` 取加权条证据，临时树已删除，明确不冒充真实 run 的进度：`/tmp/wpbt7-progress-fixture.ts`、`/tmp/wpbt7-progress62.txt`、`/tmp/wpbt7-progress120.txt`。两种宽度与真实三种视图都 exit 0、逐行无超宽。

62 列实际入口 + 隔离历史 fixture：

```text
superagent 15:45:33 · 心跳 0s ✓ · 大看板
今日 达成 0/0 · 一次通过 0 · 人工介入 0 · 评审债 0
总 ▕████████████████████1 run · 78% 剩~4m███████░░░░░░░░░░░░░▏
tok 今日 未知  角色今日用量未知
━ 进行中 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ wpbt7-proof-cZs1SP 加权 ETA 展示夹具：长编码与… 10m30s 未知
  M1/1 编✓ 验◐ 评· 门· 合· ▕█████████78% 剩~4m████░░░░░░▏ 引擎
```

120 列实际入口 + 同一 fixture：

```text
superagent 15:45:34 · 心跳 0s ✓ · 大看板
今日 达成 0/0 · 一次通过 0 · 人工介入 0 · 评审债 0
总 ▕█████1 run · 78% 剩~4m░░░░░░▏
tok 今日 未知  角色今日用量未知
━ 进行中 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ wpbt7-proof-cZs1SP 加权 ETA 展示夹具：长编码与短验收 10m31s R- 未知 fixture-progress
  M1/1 编✓ 验◐ 评· 门· 合· ▕█████████78% 剩~4m████░░░░░░▏ 引擎
```

- 追加进度条的首轮全量回归暴露五项 job exec 初始化超时：`cli -> usage -> eta -> board/data -> activity -> jobs` 提前加载 jobs，与 cli 的顶层 await 动态分流构成初始化循环。将既有 confined/workflowRoles 原样移到无运行时 cli 依赖的 `board/workflow.ts`，data 原路径保留重导出，eta 直接复用其 owner；没有修改 job 行为或提高测试超时。相同失败测试修复后 `26 pass / 0 fail`（jobs、ownership、ETA），完整失败/定位/修复证据分别 `/tmp/wpbt7-tests-before-cycle-fix.log`、`/tmp/wpbt7-jobs-diagnosis.log`、`/tmp/wpbt7-jobs-fixed.log`。

- 最终验收：`cd wetamp && bunx tsc --noEmit` exit 0；`cd wetamp && bun test` exit 0（390 pass / 0 fail / 2 snapshots，163.97s）；总进度与单 run 超时分开展示的新增断言定向复跑十六项 exit 0；仓库 `bun run lint` 与十文件临时配置 scoped lint 都 exit 0；Web script syntax 与五份输出逐行宽度检查 exit 0；`git diff --check` exit 0。所有证据均在上述 /tmp 文件中，仍待元帅独立评审与最终验收。
- 修改文件（19）：`wetamp/bin/superagent`、`wetamp/docs/PROGRESS.md`、`wetamp/src/archon.ts`、`wetamp/src/board/App.tsx`、`wetamp/src/board/cockpit.ts`、`wetamp/src/board/data.ts`、`wetamp/src/board/index.ts`、`wetamp/src/board/eta.ts`、`wetamp/src/board/ProgressBar.tsx`、`wetamp/src/board/workflow.ts`、`wetamp/src/usage.ts`、`wetamp/src/web/index.html`、`wetamp/src/web/server.ts`、`wetamp/tests/board.test.ts`、`wetamp/tests/cockpit.test.ts`、`wetamp/tests/eta.test.ts`、`wetamp/tests/ownership.test.ts`、`wetamp/tests/usage-web.test.ts`、`wetamp/tests/__snapshots__/cockpit.test.ts.snap`。

## HF4 证据优先补完

- I1 / E7：任务卡记录 `20261010-063513-6a28` 经 HF3 adopt 后，`partial + error_class:env + ok:true,failed:[]` 仍被判 `suspend,coder_error:env`。原因是 SUSPEND_CLASSES 在绿验收之前；此前 HF1/HF3 分别只覆盖 done、无 error_class 的 partial。旧基线 E7 断言 exit 1（`suspend` ≠ `advance`）；当前实现返回 advance，并写入 `self_report_conflict`、`coder_partial`、`error_class_ignored`。
- 唯一次序：非法 JSON → `coder_output_invalid`；redline → `coder_redline`；blocked 且 needs 非空 → `coder_needs`；其余绿验收 → advance（status 非 done 或 error_class 非空标记自报冲突，partial/忽略错误另留标记）；红验收的 SUSPEND_CLASSES → `coder_error:<class>`，其他 done → repair `acceptance_failed`、其他 status → repair `coder_partial`。缺省 coder 的确定性 diff 节点保留按验收判定。verify/settle 的 JSON 经共享 accept schema 保留标记；两份 review brief 均要求读取 coder 归档，给出“编码端自报 <class>，请核实”。
- 纯 bun test 矩阵：4 个 status × 11 个 error_class（7 个 SUSPEND_CLASSES 从实现导入，加 redline/task/null/unknown）× 2 个 ok × 2 个 needs = **176 格**，逐格比较完整结果，包含三个标记是否缺省；另测非法 JSON 的绿/红验收及 E7 的 verify/coder 存档。E7 原样夹具：线上同名 coder 归档虽已被续跑覆盖为 `partial + task`，但通过生产 `archon.db` 的 `mode=ro` 连接找回事件 `6ca6eb2b-963d-4da6-b5fa-851ff3f34af4`（event_order=4442，run=`e5b271829c7d325bd2b8a681a9ae0644`，node=`code-iiqe-question-list-polish`）的原始 `node_completed.structured_output`；`tests/incidents/e7-coder.json` 与该对象逐字段相同，仅 notes 置空，来源与 SHA-256 记录于隔离证据 `e7-source.json`，未读取转录正文或改生产数据库。夹具内 quick_checks 只作输入，测试不执行原业务命令。
- adopt 空增量结论：旧 `start-*` 用当前 HEAD 导致 BASE 也随 adopt 前移，确会漏审已有提交；现改为 `git merge-base base_ref HEAD`（`src/generate.ts:154`），所有 verify/diff 的全量 patch、范围和 hash 都来自该共同祖先…HEAD（`templates/.archon/scripts/sa-check.ts:253`），不再来自本次 coder 增量。scope_pkgs 与 brief 由生成器按实际里程碑拓扑累计，前序已交付范围不会误报越界。R1 用全量 patch，且没有 same 守卫（`src/generate.ts:312,336`）；R2/R3 仍用上次实际评审候选以来的 delta 并保留 full_diff，same 只比较全量 patch hash（`sa-check.ts:284`），避免无修复重复评审。基线 ref 前移到包含交付后共同祖先会前移，这是 git 的真实集成状态；本包不改 ref。
- 回归：已提交代码 + 本次零增量仍生成含既有交付的全量 patch，首轮 same=false；生成器验证全量接线、累计 brief/scope、乱序 plan 的拓扑以及带单引号 ref 的 shell 引用。隔离真实 Archon fake selftest 在 HF3 adopt 后额外断言全量 diff 包含旧失败 attempt 的 `core`/`repair core` 交付；不用单元 fixture 冒充生产恢复。src/模板 TS 净增 18 行（≤60），hooks 与 packages 无改动，无新增依赖。
- 验收证据：`/tmp/hf4-evidence.jv8Qy0/`。`cd wetamp && bunx tsc --noEmit && bun test` 最终 exit 0（563 pass / 0 fail，`acceptance-final.log`）；定向 generate/sa-check exit 0（253 pass / 0 fail，`targeted-final.log`）。初轮 `acceptance-1.log` 的单个失败是测试将带引号基线分支创建在交付 HEAD，却期望交付前祖先，已固定该分支起点。`bun run lint --config wetamp/eslint.config.mjs wetamp/src/generate.ts wetamp/templates/.archon/scripts/sa-check.ts wetamp/scripts/hf3-adoption-selftest.ts` exit 0（`lint.log`）；`SUPERAGENT_HOME=/tmp/hf4-evidence.jv8Qy0 bash scripts/selftest.sh --fake` exit 0（`selftest.log`、`selftest-fake.json`）。提交后用同一 home 执行 `bash scripts/verify-local.sh --commit HEAD`，提交绑定结果写入 `verify.json`；旧基线反例见 `e7-before.log`。G2 astra 里程碑独立评审及元帅最终实测由主控安排，派生会话不发起评审、不晋升共享经验。

### WP-BT7 R2：真实形状回放

- 先只读复现：2026-10-10 16:06 的真实 ETA 缓存中运行中 run 为 `basis=unknown, weight=0`；实际 `archon workflow get --verbose --events --json` 返回 events，**以 events 替代 nodes**。上一轮把该响应直接当带 nodes 的 RunView，理想化夹具没有覆盖这一差异。真实事件耗时在 `data.timing.startedAt/durationMs` 或 `data.duration_ms`，工作流节点 id 可以对齐。现在复用上游 `buildRunNodeStates` 折叠生命周期，`readNodeRecordEvent` 读取耗时，保持 reset/cache-success 语义；没有重写引擎状态机、增加查询或渲染采集。
- 历史来源覆盖全部登记 ledger：实测 19 个，其中 18 个 completed/failed/cancelled，成功节点耗时组成历史样本，运行中 run 的观测只用于稀疏类别线性外推。真实副本重算结果 `pct=84, eta_s=453, overrun_s=483, basis=linear, weight=2743.776`，不再为零权重未知。
- 角色三路：run claims 按工作流定义区分 coder/reviewer；旧 live 只有 `derived`，沿用既有终端规则 true→将军、false→元帅；高优先级 job 的 null role 允许同客户端同 session 的 live 补全，同时保留 job/run 身份。已知角色不被空角色覆盖。真实今日会话归属前/后：将军 53→60、军师 13→13、元帅 5→14、未归属 324→308。剩余会话无可核对 claims/jobs/live 身份，旧源字段缺失；存在 Claude/Codex 同 UUID，归属键始终含客户端，不能凭模型或另一客户端身份猜测。展示名称改为“未归属”，已归属组优先显示。
- 旧 pending asks 的两个真实 run 已 classified completed；展示口径改为 held:\*，或 S3 接管策略内 failed（code/fix/verify/settle）且有未决 ask。completed/cancelled 旧 asks 不进“需要你”，running/owner_lost 也不被旧 asks 隐藏；没有关闭或改写源提问，S4 仍负责源头收尾。
- 回放夹具 `tests/fixtures/cockpit-r2.json` 保留五个真实 CLI envelope 的事件结构、时间关系、缺 nodes、claims/jobs/legacy live、同 UUID 不同客户端和 completed 旧 asks；替换 repo/run/session/attempt/package 标识，删除 checkout/sessionPreview/正文。新增四项回放测试同时检查数字 ETA、一次查询、采集无缓存写入、归属补全与不误归属、62/120 不溢出、reset 与缓存成功耗时。
- 真实验收只读真源；`usageEvidence()` 不写缓存，真实元数据和重算缓存仅落 `/tmp/wpbt7-r2-real-home`。worktree 入口使用该真实副本与真实只读 ARCHON_HOME，`NODE_ENV=test` 禁止 Web 启动/后台刷新，两种宽度均 exit 0；真实 `~/.superagent` 未写入、pane 未重启。副本未复制心跳日志，故心跳未知仅是隔离副本缺该文件。真实缓存待主控上线后的正常后台刷新更新。
- 自检：`cd wetamp && bunx tsc --noEmit` exit 0；全量 `bun test` 400 pass/0 fail/2 snapshots（167.66s）；最后源编辑后定向 20 pass/0 fail。`bunx eslint src` 全部 24 文件 0 errors/0 warnings，指定五文件清零；真实 lint wrapper scoped 检查 exit 0。隔离 home 的 `selftest.sh --fake` exit 0、ok=true，G1/N1 deny、HF3 5/5 completed；属于 fake 契约自检，不冒充真实 AI 执行。证据 `/tmp/wpbt7-r2-tests.log`、`/tmp/wpbt7-r2-eslint-final.json`、`/tmp/wpbt7-r2-selftest.log`；提交绑定 verify 回执将写 `/tmp/wpbt7-r2-verify-home/verify.json`，由主控按最终 commit 核对。src TS/TSX 基线 c88f2e71 为 5749 行，修复后 5776，净增 27；hooks 及 HF3 三文件无改动。独立复审、集成与上线验收交还元帅。

62 列真实副本入口摘录（2026-10-10 16:17，省略需要你与结果段；完整 `/tmp/wpbt7-r2-real-62.txt`）：

```text
今日 达成 12/14 · 一次通过 10 · 人工介入 6 · 评审债 25
总 ▕████████████████████1 run · 84% 超~9m███████████░░░░░░░░░▏
tok 今日 742.9M  将军·sol 115.4M  军师·astra 6.1M  元帅·astra…
━ 进行中 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ xiaopan-translator 移植 P1–P5 到 e890971（快进… 38m56s 5.6M
  M1/1 编✓ 验✓ 评R2◐ 门· 合· ▕█████84% 超~9m██░░░▏ 将军·sol6.1
```

120 列同一真实副本入口摘录（完整 `/tmp/wpbt7-r2-real-120.txt`）：

```text
今日 达成 12/14 · 一次通过 10 · 人工介入 6 · 评审债 25
总 ▕█████1 run · 84% 超~9m██░░░░▏
tok 今日 742.9M  将军·sol 115.4M  军师·astra 6.1M  元帅·astra 2.1M  将军·astra 441.7K  元帅·opus 448.6M  元帅·fable 45.…
━ 进行中 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▶ xiaopan-translator 移植 P1–P5 到 e890971（快进到已验收的 d28b532） +1 38m57s R2 5.6M 073817-06da
  M1/1 编✓ 验✓ 评R2◐ 门· 合· ▕█████████84% 超~9m██████░░░░▏ 将军·sol6.1
```

## BT8 控制台与小看板

- **复用与只读边界**：新增 `console start|stop|status|url [--open]`，`web` 为同义兼容别名。复用 Archon 的 `getSourceWebDistDir/getSourceServerEntry`、原生 `startServer({skipPlatformAdapters:true})`、控制台路由/API/SSE、根 `build:web`；源码定位直接从本 worktree 的 paths owner 导入，避免预置 node_modules 软链定位到主仓。dist 缺失或 `.superagent-engine` 不匹配 HF3 `engineHash()` 时重建，dist 不提交。原生 `ServerOptions` 没有只读开关（`packages/server/src/index.ts:272`），所以沿用本机 39890–39989 端口段和 Host/token/HttpOnly cookie 校验，以最小 Bun 代理放行 GET/HEAD/SSE，其余方法统一 403：“写操作请用 superagent decide 或 Mac 提醒”；没有只读 POST 例外。SSE 原样流式转发，token、cookie、Authorization 不传给内部 server。
- **环境与进程**：代理和 server 的白名单只有 `HOME/PATH/TMPDIR/TZ`，再显式设置 `SUPERAGENT_HOME/ARCHON_HOME/HOST=127.0.0.1/NODE_ENV=production/ARCHON_TELEMETRY_DISABLED/DO_NOT_TRACK` 与两个保留期；不继承 DSN、adapter、provider 或运行时注入变量。server 用 `--no-env-file`；Archon 仍会自行 dotenv 加载仓库及用户 `.env`（`packages/server/src/index.ts:19-42`、`packages/paths/src/env-loader.ts:94`），因此只在观察者子进程用 Bun `onLoad` 禁用 dotenv 的 config/parse，不改原生文件、CLI 或 provider 配置。实测证明运行时裸包解析不经过原先尝试的 `onResolve`；新增子进程回归覆盖 `ARCHON_HOME/.env` 的 override:true 合成 DSN/HOST/adapter，原生启动证明 SQLite 和 `platform_adapters_skipped`（分支依据 `packages/server/src/index.ts:460,725,1001`）。全部服务仅监听 loopback。仅停止 state 记录且完整命令行匹配的 PID；兼容旧 `web serve` 单 PID state，归属未知一律拒绝。
- **清理事实与影响**：server 启动及每 6 小时仍会执行原生 cleanup，不能宣称 server 无任何写入。设置现有 `STALE_THRESHOLD_DAYS=365000`、`SESSION_RETENTION_DAYS=365000`，避免当前未合并的闲置 workspace 与历史 sessions 因年龄回收；选择千年而非整数最大值，使 SQLite 的日期截点仍有效，隔离冒烟已验证。该设置**不能阻止已合并分支的清理**：`cleanup-service.ts:695-725` 在年龄判断前处理 reclaimable，live owner 或未提交改动会阻止回收；生产生命周期行为未改、未连接生产库。核对命令 `rg -n 'working_path|workingPath|output_root|artifacts|worktree|gen_dir' wetamp/src/board/{data,detail}.ts wetamp/src/cli.ts`：board/detail/report/land 读取 ledger、gen 与 `output_root/artifacts`（data:114,121,147，cli:233,1461,1550），无需已结束工作树；recover/adopt 经 Archon 恢复，completed 明确不可恢复（cli:394），failed/cancelled 仍可能需要原 worktree，未合并保留期规避年龄回收；`accept` 在 `run.working_path` 跑验收（cli:847-860），已合并终态的 worktree 被清理后不能再对它 accept。既有引擎续跑调度器仍会运行，本包工作流不新增 durable wait；代理只读不等同于禁用原生后台维护。
- **I7 / P4 与删除项**：Ink 和唯一 `/sa` 页面都由现有 loader、usage cache 和 `cockpit()` 投影，不另建采集器；`/sa` 只展示今日达成、角色·模型 token、每个 run 一行。删除 `src/web/index.html`、`/api/overview`、旧 cockpit 快照，以及小看板心跳/token/今日结果/终端统计/总进度/按键提示和对应死展示代码。小看板仅保留时间统计、每条三行进行中、asks 未决行；superseded 隐藏，终态仍未决的 ask 由源状态决定，不用 run 状态猜关闭。保留 q/w，进度填充青色、问号行黄色；作业复用既有 `readJobs` 历史，按同角色已结束作业时长中位数估算，无历史为 ?%。固定 2 run + 1 job + 1 pending + 1 superseded 夹具在 62/46 列的两份 Ink 快照覆盖结构与显示宽度；复用真实形状回放并按本卡的 asks 单一事实源更新旧断言。I7 的共享状态与成本口径不另起旁路；P4 的唯一新机制是原生缺少只读开关时的代理与子进程 dotenv 隔离。
- **常驻升级与证据**：复用 HF3 `engineHash()` 并纳入 board/web 源码，board 启动记录指纹、每次刷新不一致以 75 退出；只读确认 `~/.config/zellij/superagent-board.sh` 无条件 3 秒重开，未改脚本或操作 pane。`console status` 和 `supervise-tick` 发现漂移走原有 start/stop 生命周期重启代理与 server；单测覆盖漂移/稳定/旧 state/未知归属，临时 home 实际验证两个 PID 被替换且旧 PID 消失。验收证据都在 `/tmp/bt8-accept.M54PHn/`：初轮全量 597 pass/0 fail/2 snapshots；dotenv 修复后的定向 11 pass/0 fail/2 snapshots；`tsc.log`、`lint.log`、最终 `tests-final.log`、`selftest-final.log`、`smoke-final.txt`。初次 curl 证明 `/console` 200 HTML、run API JSON、POST 403、`/sa` 200（`smoke.txt`）；最终合成 dotenv 下重复 HTTP 检查、lsof loopback、旧 state 迁移、stop 后 PID 消失且端口可重绑。`selftest.sh --fake` 和提交后 `verify-local.sh --commit HEAD` 使用同一调用方临时 SUPERAGENT_HOME，提交绑定回执为该目录 `verify.json`。最终 `cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（598 pass/0 fail/2 snapshots，175.78s）；`bunx eslint src` exit 0；`SUPERAGENT_HOME=/tmp/bt8-accept.M54PHn bash scripts/selftest.sh --fake` exit 0；最后删除总进度死代码后定向 ETA/usage 14 pass/0 fail。hooks 与 packages 受跟踪文件零改动，src TS/TSX 净减 158 行（预算净增 ≤200），`git diff --check` exit 0。这些属于本包编码自检；astra 独立里程碑评审、真实像素、主控集成与实测均未由派生会话执行。

## S4 引擎正确性契约

- 范围：派生将军在 `wetamp-s4`、HF4 基线 `1feb4909` 实现 I2/I4/I5/I6/I8，并保持 I1、补强 I3；不委派、不发布，不修改 packages、hooks、board/web/report 生产代码。独立 G2 评审与主控实测仍由元帅安排。RCA 原文落库为 `2026-10-10-systemic-rca.md`，仅修正旧代码行号、HF3/HF4 已上线状态、I1 穷举归属及 completed 不得迁移的事实。

| 不变量 | 机制                                                                                                                                                                                                | 测试                                                                                                                      | 监测                                                                                                                                           | 记债                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| I1     | 保留 HF4 的证据优先次序与三个冲突标记，不修改 disposition 规则                                                                                                                                      | HF4 176 格矩阵、E7 partial+env+绿、四场景 golden                                                                          | verify/settle 保留 self_report_conflict、coder_partial、error_class_ignored                                                                    | 主控生产验收不能由 fake 代替                                   |
| I2     | `src/reasons.ts` 为唯一注册表，带 hold/determinism/owner/description；消费方精确查表，未注册即嫌疑                                                                                                  | producer 闭集覆盖、唯一 reason code、逐项 policy 映射、policy 无孤儿、镜像与生成快照一致                                  | sa-check emit 校验原因，未知原因经 I5 报警                                                                                                     | BT7 的旧文案表仍含 unknown_reason，须改为 engine_suspect       |
| I4     | 去重键为 run:hold；迁移一个旧 attempt 键并保留 alias，其余作废；终态或 hold 变化将未决项标 superseded，迟到回答不执行动作                                                                           | E2 原时间序列、id-less unknown 对账、terminal yes/no、id-less superseded 回答、纯计数函数                                 | tick 输出 `{actions, orphan_hold, dup_ask, engine_suspect, stale_answer}`，`cockpit-signals.ts` 导出同口径；孤儿阈值 10 分钟、处置记录参与判断 | BT7 尚未接入纯函数；不删除或改写真实 Mac 提醒                  |
| I5     | failed/paused 包级绿证据或未注册原因 => engine_suspect；settle 使用修复后的复验，code/repair 不使用早于节点开始的旧 verify；确定性同指纹不自动重试，换指纹仅一次 terminal adopt，尝试在恢复锁内记账 | E1 两份真实 settle、当前红复验不受首次绿覆盖、unknown reason、同指纹零调用、换指纹一次 adopt、样本白名单/原子写/去重      | tick 自动写 incidents/run/sample.json 并按 run 去重，投一次嫌疑提问                                                                            | 判定和恢复的独立评审仍待元帅                                   |
| I6     | fake 支持 done_with_error_class/partial_green/blocked_needs/invalid_json；默认 golden 字节保持；事故夹具只含结构与判定字段                                                                          | 四场景执行实际生成的 fake body 后检查 disposition；E1/E2/E5/E7 回放                                                       | 测试期证据，不替代线上指标                                                                                                                     | E5 是重建仓库；E1/E2 为真实脱敏判定与处置，E7 原始样本沿用 HF4 |
| I8     | 导入 Archon inspectProjectBaseBranch 与 loadRepoConfig；显式 worktree.baseBranch 由原生配置提供；同步 CLI 通过独立 bun 预检进程复用 async API，不复制分支检测                                       | E5 无 remote/default branch 被拒且提示 worktree.baseBranch；run 未启动 engine；preflight/engine 两类启动失败台账与 stdout | `launch-failures/run.json` 记录 phase；没有 Archon id 的失败不伪装 active run                                                                  | 尚未覆盖 Archon 所有其他启动拒绝条件                           |

- E2 根因证据（只读生产 JSON）：`062040-aa74` 的 asks 键 `auto_retry_exhausted:2`、`:3` 均 pending，对应 dispositions ask 时间 `07:01:23.035Z`、`07:07:10.244Z`；`063513-6a28` 的 `:1`、`:2` 均 pending，对应 `07:01:25.032Z`、`07:08:21.395Z`。旧键使用 `recoveries.length + auto_retries.length`，恢复改变 key 后再次投问。本包复用现有 pollAsk、askRecords、supervise 单实例锁与 ledger 恢复锁；unknown 投递先持久化、legacy id-less 对账保留原 reminder，不再投新提醒。
- 注册表选择生成 JSON：sa-check 在冻结快照内独立执行，不能依赖安装目录的 src；`generate` 直接序列化 REASONS，`generate:reasons` 维护模板镜像，单测证明镜像相等。engineHash 也包含注册表真源，避免只改原因策略却不更新引擎指纹。
- 事故留样只取闭集 status/error_class/disposition/reason 和 boolean 判定标记，未知原因只留 unregistered_reason，坏 JSON 只留 invalid_json；verify/coder/settle/gate 输入输出按白名单投影，plan 只留 package id/milestone/risk 与新旧指纹。临时目录内 atomic JSON + rename 发布，按 run 去重，不复制 prompt、转录、argv、日志、命令或任意文本。
- I3 补强：recoverRun 在锁内拒绝 completed，adopt 仅 failed/cancelled；decide 的 retry/reject/approve 先校验当前挂起。HF3「adopt 跳过已完成编码」继续记债，本包不实现。S3 真实 resume 测试改用显式 decide retry，确定性红验收不再由 tick 无条件重跑。
- 当前边界阻塞：`src/board/cockpit.ts:13` 的独立 REASONS 文案表含 unknown_reason、缺 engine_suspect，导致 tsc TS2353 及 cockpit 的 policy 覆盖断言失败。本包按任务卡禁止改该路径，保留失败断言，交元帅与 BT7 对齐；不宽化类型或删测试掩盖契约缺口。
- 验证证据：`/tmp/s4-contract-last.log`（16 pass/0 fail，含 E1/E2/E5）、`/tmp/s4-board-contract-final.log`（33 pass/0 fail）、`/tmp/s4-tsc-final.log`（exit 2，仅上述 board 映射）、`/tmp/s4-all-final.log`（exit 1，588 pass/1 fail/2 snapshots；唯一失败为上述 cockpit policy 文案表契约）；`bun run lint`、通过 wrapper 的 scoped lint 与 `git diff --check` 均通过。src TS 净增 338 行（≤350），hooks/packages/board/web/report 生产路径 diff 为零。
- 临时 HOME 验收：`SUPERAGENT_HOME=/tmp/s4-acceptance.RetOuw bash scripts/selftest.sh --fake` exit 0；`SUPERAGENT_HOME=/tmp/s4-scenario.0QUv9r FAKE_CODER_SCENARIO=done_with_error_class bash scripts/selftest.sh --fake` exit 0，HF3 adopt 后 status=completed（经过评审、门禁与合入）；两份回执是候选源码的 fake 验证，不是生产恢复或部署证据。提交后同一 `/tmp/s4-acceptance.RetOuw` 执行 `bash scripts/verify-local.sh --commit HEAD`，绑定结果以其 verify.json 为准；上述 tsc 接线阻塞未解除前不宣称投送闸通过。

- 本包改动文件（20）：`package.json`；`src/{cli,generate,reasons,cockpit-signals,incidents,preflight}.ts`；`scripts/generate-reasons.ts`；`templates/.archon/scripts/{sa-check.ts,reasons.json}`；`tests/{cli.test.ts,board.test.ts,s4-contract.test.ts}`；`tests/golden/fake-coder-scenarios.json`；`tests/incidents/{e1-settle,e2-asks,e5-base,e7-adopt}.json`；`docs/{PROGRESS.md,2026-10-10-systemic-rca.md}`。

## HF5 M2 修复

本节取代 BT8 关于 cleanup 仍运行、内部 TCP 监听和 PID state 归属的旧结论，以及 S4 永久 `(run, hold)` 去重的旧机制。派生将军仅在 `wetamp-hf5` 编码与自检，不派生、不 push、不合并、不运行生产服务；G2 astra R2 与元帅最终实测待主控安排。

| Finding / 不变量 | 修法与 P4 复用依据                                                                                                                                                                                                                                                                                                                           | 回归与运行时监测                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------- |
| M2-01 / I5、I7   | 保留原生 server、路由与启动契约，Bun preload 的 onLoad 只替换 cleanup-service.ts 中唯一 startCleanupScheduler 为日志 no-op；目标缺失或歧义即抛错。上游无禁用开关，保留期不能阻止启动回收，故在 wetamp 装配边界适配，不改 packages。board（含 once）只读 resident state，不再拉起控制台。                                                     | 原始源码、改名/双目标以及真实 preload 子进程坏文本回放；日志 cleanup_scheduler_disabled_by_superagent，无 scheduler_starting；启动错误持久化到 console/error，由 console status 显示。 |
| M2-02 / I7       | 包装原生 Bun.serve，将内部服务改为 Unix socket，目录0700/socket0600；同 UID 仍属既定可信边界。外层沿用 Host/token、GET/HEAD 和 SSE 代理，经 fetch unix 转发。SQLite 的原生认证不可用，故复用 OS 权限边界，不新增认证服务。                                                                                                                   | Unix/SSE 转发与 POST 不转发回归；临时真实服务 lsof 只有外层127.0.0.1:39986，console/sa 200、POST403、权限600/700。                                                                     |
| M2-03 / I4       | askKey 绑定 run、hold 与进入挂起的节点/时间 episode；新 episode 归档旧未决问，旧答复不能迁入新问。沿用 pollAsk、supersedeAsks、处置锁和提醒生命周期，不另建调度器。                                                                                                                                                                          | 连续两个 human signoff、新 waitingSince 再挂起均新问；同 episode 只问一次，迟到旧 yes 不推进下一 milestone；tick 的 dup_ask/orphan_hold/stale_answer 沿用原监测。                      |
| M2-04 / I2、I6   | 复用 shell.cjs 和现有路径/红线判定，按命令顺序逐个绑定 cwd，条件 cd 保守保留可达目录，子 shell 不传播 cwd；不确定写目标失败关闭。原 parser 只有扁平 argv，局部补顺序扫描，不引入完整 shell 执行器。                                                                                                                                          | 两个原始分号绕过、&&、                                                                                                                                                                 |     | 、子 shell 与安全重定向共6个冒烟；动态路径拒绝、原 hooks 回归保持；guard 原拒绝原因即监测证据。 |
| M2-05 / I2、I6   | repair 与 code/fix 共用失败归属，verify/settle 沿用原原因注册表和 HOLD_POLICY；不增加新 hold/恢复机制。                                                                                                                                                                                                                                      | 真实节点形状 repair-p 失败、无绿色证据且重试额度耗尽进入 auto_retry_exhausted；decide retry 成功恢复；tick 返回既有处置/原因。                                                         |
| M2-06 / I7       | Ink、sa、report 均使用 cockpit.metrics；终态 completed/failed/cancelled 按结束日期分桶。达成要求 completed、land.json.head 是本地 base ref 祖先、且无人工介入；land 节点仅打印命令不算合入。复用 git merge-base 而非自造合入台账，Ledger.intervened 持久标记避免20条处置窗口遗忘；新自动恢复不会误计人工，旧 recoveries 无法判别时保守排除。 | 昨日起跑今日结束、未合入/真正合入、持久人工、human节点、cancel、自动恢复回放；report/board 摘要与 metrics 同源断言；各界面直接显示统一计数。                                           |
| M2-07 / I4、I5   | 单个 launchd job/process 承载两监听；KeepAlive/RunAtLoad、固定地址、幂等plist，start bootstrap、stop bootout、status print，指纹漂移 kickstart-k。复用 launchd 归属而非 PID 守护；旧 state 只在 UID/argv/有效启动时间都匹配且二次复核时迁移，否则拒停。                                                                                      | 临时 label 幂等 start 同PID；改旧state指纹后真实 kickstart 替换PID且旧PID退出；stop后 job/PID/socket消失、端口可重绑；未知旧归属回归明确拒绝，未终止外部实例。                         |
| M2-08 / I2、I6   | 沿用 Codex hook identity/hash 与现有安装器，check 另要求本安装规范 node guard.cjs codex、同步、matcher覆盖全部工具、enabled且hash一致；不把路径子串当执行证明。                                                                                                                                                                              | 实际脚本在临时 CODEX_HOME 下 write/check：Read-only matcher、echo路径、async拒绝，规范调用通过；codex-worker fail-closed 原回归同步更新有效安装路径。                                  |
| M2-09 / I1、I7   | evidenceJson/evidenceGates 复用 detail 的 confined owner；summary、gate枚举、brief、land、分类与报表读取同一受限入口，越界软链不读、不计绿色证据。保留原 unreadable 错误通道，不创建另一套路径校验。                                                                                                                                         | 外部gate软链、外部目录软链拒绝；summarize记录unreadable且不计first_pass；snapshot/report保留单run错误而不拖垮其它run。                                                                 |

- **工作树回收结论/债**：由主控在实际合入并完成验收后显式回收对应单环境，保留 failed/cancelled 的恢复及 accept 所需工作树。`superagent land` 当前只输出命令，不能把 exit0 当真实合入信号。原生单环境 `archon complete` 的 CLI 在 `packages/cli/src/cli.ts:1283` 固定传 `deleteRemote:true`，没有不删远端的命令开关；内部 `isolationCompleteCommand` 虽接受 deleteRemote:false，却需要数据库初始化/执行上下文，不能在本包权限下用不足20行安全接线。故未自动回收、未运行 complete、未删除远端；待主控安排显式无远端副作用的能力后清债。
- **初始化链回归**：report复用board数据后形成 cli→report→data→activity→jobs→cli，CLI顶层await动态导入jobs等待自身结束，导致5个既有job测试超时。改为静态导入jobCli后保留原异步调用；未改job语义或提高超时。另两项是旧摘要未剥离新增metrics、旧信任夹具使用非本安装路径；只更新夹具，安全校验保持严格。失败 `tests.log`，修复定向 `failures-fixed.log`（56 pass/0 fail）。
- **隔离证据**：统一调用方 `SUPERAGENT_HOME=/tmp/hf5-accept.4KtD0v`；真实launchd只使用后缀临时label与临时ARCHON_HOME，最终bootout。`console-smoke.{ts,json,log}` 保存权限、HTTP、lsof、幂等、漂移重启与停止；`failclosed-smoke.{ts,json,log}` 在独立子进程把server entry替换为导入损坏cleanup夹具，实际原preload拒绝，并证明console status报告持久化原因，不改packages。日志和回执均在该临时目录，token/凭据/转录正文未输出。
- **验收**：`cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit0（622 pass/0 fail/3 snapshots，177.30s，`tests-final.log`）；`bunx eslint src` exit0（无新增告警，`lint-final.log`）。`SUPERAGENT_HOME=/tmp/hf5-accept.4KtD0v ARCHON_HOME=/tmp/hf5-accept.4KtD0v/selftest-archon bash scripts/selftest.sh --fake` exit0，selftest-fake.json ok:true、原hooks与HF3检查通过。提交后同一调用方home执行 `bash scripts/verify-local.sh --commit HEAD`，以该目录verify.json的commit绑定结果为准，不修改回执或用fake成功冒充独立评审/生产验收。src净增65行（≤250）；hooks仅redline.cjs与codex-trust相关脚本，packages受跟踪文件零改动，node_modules软链不暂存。
- **HF5b / M2-04 / I8、P1**：复用 shell.cjs 的 tokens 证明当前简单命令是字面顶层 cd，只有它更新父 cwd；sh/bash/zsh/dash/ksh -c 递归校验但不传播 cwd，括号子 shell 仍隔离；命令替换、反引号或包装器中的 cd 无法证明作用域时派生会话 fail-closed。仅调用 reason() 回放子作用域污染的 touch/重定向，保持原6个冒烟；拒绝原因沿用 guard 监测通道。
- **HF5b / R2-D01 / I7、P4**：createLoader 与 snapshotOf 复用 safeRowOf 的逐行 catch/unreadableRow 处置，错误写入 summary.unreadable 且去重；目录外 land.json 软链夹具验证坏行隔离、其它行刷新和终态缓存重读均正常，不放宽 confined 读取边界。
- **HF5c 旧记录迁移**：生产记录推翻“旧记录必带 uid”和“启动时间与 started_at 相差 <1s”两个假设；proxy 在记录写入前约5.9s启动，server 早约0.9s。
  无 label 的记录改按当前 UID（记录有 uid 时一并核对）、精确 argv、lstart ≤ started_at+1s、存活父子 PPID 判定；拒绝错误明确字段，SIGTERM 后最多等15s，不升级 SIGKILL，退出后按 cleanup 归属清除旧记录。
  可注入 ps 回放真实形状与六类拒绝反例；launchd 未加载但旧 PID 存活时 status 显示 legacy 和两个 PID 的存活标记。独立评审并入 HF6 astra R1，生产迁移实测留待元帅。

## HF7 内存准入

- **被推翻的假设 / P2**：固定本机并发 ≤3 不代表安全或资源利用合理。本包仅改变 `superagent job exec` 的本机准入，不设作业数上限，不影响引擎内的查询并行度；独立 G1 评审并入 HF6 astra R1，最终验收由元帅执行。
- **信号与复用 / P4**：直接读取 macOS `kern.memorystatus_vm_pressure_level`（1 normal、2 warn、4 critical）和 `kern.memorystatus_level`（内核空闲百分比）。仅压力 1 且空闲 ≥ `SA_ADMIT_MIN_FREE`（默认 25）放行。sysctl 不可用、读取失败或值无效时退回 `os.freemem()/os.totalmem()` 的百分比，stderr 显式标注 fallback，同阈值判定；不自造内存估算公式或并发预算。
- **等待与可见性 / I4、I8**：spawn 前登记 `queued`、`reason: memory` 与最近 `{pressure, free, source}`；每 15 秒重测，最终一次等待截到 `SA_ADMIT_MAX_WAIT`（默认 1800 秒）截止。等待与读数持续写 stderr，jobs 保留 queued，小看板和 cockpit 计入活动并显示“等内存”。放行记 running 并重置执行开始时间；超时记 failed/75/pid=0，等待中的 SIGINT/SIGTERM/SIGHUP 记 failed/130、143、129 并取消计时器，均不启动子进程。只有 wrapper 和已登记 child 都不在时才视为 lost；未启动记录不参与 provider 会话归属或执行时长估算。
- **阈值与应急开关**：`SA_ADMIT=off` 完全跳过探针与阈值判定，并在 stderr 提示一行；否则阈值或最长等待为非有限值或负数时直接拒绝，不留下永远 queued 的记录。MIN_FREE 允许 101 以复现不可满足的准入。探针与等待可注入，测试覆盖 normal、warn/critical 后恢复、低空闲、超时、截止时恢复仍拒绝、sysctl 失败/无效与 fallback、off、无效配置、三个信号、jobs 列表、真实活动加载、Ink/cockpit 等内存呈现及 orphan 判定。
- **真机证据**：`/tmp/hf7-accept.h825BW/smoke.json` 保存候选 worktree 的两次真实 CLI 冒烟。默认 `job exec --title smoke -- true` exit 0（0.33 秒，stderr 空，压力 1/空闲 90%）；`SA_ADMIT_MIN_FREE=101 SA_ADMIT_MAX_WAIT=20` exit 75（20.32 秒，最后压力 1/空闲 89%，failed/pid=0，true 未启动）。两次等待 stderr 为 `job: queued 等内存; pressure=1 free=89% source=sysctl; min=101%; retry in 15s`，终态为 `job: memory admission timed out; pressure=1 free=89% source=sysctl`。所有运行状态与日志使用临时 SUPERAGENT_HOME，不写生产台账、不发起 AI、不修改 hooks 或 packages。
- **本包自检**：`cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（669 pass、0 fail、3 snapshots，222.98 秒，`tsc.log`/`tests.log`）；`bunx eslint src` exit 0（`lint.log`）；`SUPERAGENT_HOME=/tmp/hf7-accept.h825BW ARCHON_HOME=/tmp/hf7-accept.h825BW/archon bash scripts/selftest.sh --fake` exit 0，`selftest-fake.json` 的 ok 为 true。src 净增 38 行（≤60），hooks/packages 受跟踪文件零改动，`git diff --check` exit 0。提交后在同一临时 SUPERAGENT_HOME 执行 `bash scripts/verify-local.sh --commit HEAD`，最终结论以该目录 `verify.json` 的提交绑定回执为准；自检不代替 HF6 独立评审、主控验收或集成。派生会话不执行经验晋升，由主控收尾。

## EV1 经验记忆

- **数据流**：`supervise-tick` 从已有 ledger、Archon `--events`、asks、验收/门禁 JSON 的表格 finding、incident 链接与 BT9 usage 投影摘要，按 run/job id 原子存一次 `memory/episodes/*.json`（≤8KB）。五类规则分诊：engine 直接写 `memory/mechanize/`；transient 仅计数（只读出口返回各分类episode数）；plan/project/role 进入反思队列。摘要不保存 prompt、转录正文或凭据；私有项目只分诊。终态计分另读当前验收原因，不用早期挂起摘要替代最终证据。
- **复用与 P4**：复用 `archonJson`、原生 `etaInput` 事件折叠、`classifyRun` 的证据优先判定、`reasons.ts` 的 owner/determinism、`cockpitSignals`、BT9 `workflowRoles/nodeRole`、`callsOf/readUsage`、`job exec --role general`、现有 flock 和原子写入。复用 workflows 已安装的 Zod，不添加依赖。只取 ACE 增量 helpful/harmful、ExpeL ADD/EDIT/UPVOTE 和带条件的条目；不安装 ACE Python 运行器、向量库或轨迹采集器：当前需求是精确 scope/tag 匹配，现有 JSONL 与来源足够。
- **反思与预算**：单个后台工作进程持有 flock；输入摘要与最多30条适用经验，≤8000 bytes，输出≤1024 bytes，采用 bytes 作为保守 token 上界。`memory/config.json` 的 `daily_tokens` 默认 5,000,000；每次先预留9216 tokens，按 Codex `turn.completed.usage` 的 input+output结算（cached 已含在 input）。无有效 usage 保留预留，余额不足则不启动、排到次日、只读出口标黄。实际 provider usage 如超过预留仍如实记账并停止后续启动；原生模型上下文开销尚未由本包真实调用校准。模型来自 tiers general/chatgpt，推理 low；`SUPERAGENT_REFLECT_CMD` 接受 JSON argv 数组，追加结果文件路径，用于 fake 或受控替代命令。
- **中环**：项目/type经验进入包 brief，角色经验进入专属命令；多包节点使用 brief 副本，共享≤600 bytes（保守≤600 tokens）、≤5条、≤2试用条目，写入 `engine.json.lessons`。经验数据不进入 `engineHash()`；检索失败记一行日志后继续生成。`SUPERAGENT_MEMORY=off` 关闭整条经验链路（注入、反思、计划lint及tick采集），只读出口仍可读取既存数据。计划lint按项目/tag/规模/风险/编码模型取p50/p90与plan经验；有效样本≥5才拒绝明显不足的预算或截止，并提供修正值，`--lint-override "理由"`连同警告写入run输出和ledger；拒绝也写launch-failures。
- **先验与生命周期**：先验只用 completed/failed 的已知耗时，token缺回执保留null，不作零样本；单包统计run耗时和可归属总token，多包只采各包code/repair实测，不猜分摊共享节点/会话；并行包截止建议取最大p50。长耗时基准排除本run。注入命中更新last_hit；终态每run计一次，同原因码再失败harmful+1，否则helpful+1；helpful≥2且harmful=0稳定，harmful≥2退役并提出机制化，30天未命中退役，scope活跃最多30条。EV3负责机制应用后标记mechanized；本包不执行引擎自修。
- **I1/I6**：E1绿验收与自报错误、E2重复提问/同指纹确定性重复重试、M2-01、xiaopan 57e6均走engine机制通道，不由反思改写判定；E5继续复用原生base preflight。project端口夹具经过fake反思、同项目同类型brief注入、跨项目隔离、两次复发退役并写机制需求。另覆盖日预算/次日恢复、单调用锁、注入上限、总开关/指纹、隐私、schema和输出上限、未知用量、挂起归档后终态计分及真实CLI lint台账。
- **交付边界**：仅本包编码与隔离fake自检；没有真实反思、独立评审、生产写入、发布或主控验收。EV1+EV2 astra里程碑评审与集成后实测交元帅。
- **验证证据**：`cd wetamp && bunx tsc --noEmit && timeout 600 bun test` 在隔离 home、`NODE_ENV=test SUPERAGENT_MEMORY=on` 下 exit 0（628 pass/0 fail/3 snapshots，185.10s，`/tmp/ev1-all-on-final.log`）；off 全套同样628 pass/0 fail（`/tmp/ev1-all-final.log`）。最终定向24 pass/0 fail（`/tmp/ev1-memory-final.log`），`bunx tsc --noEmit`、`bunx eslint src`及根 lint wrapper均exit 0（`/tmp/ev1-{tsc,eslint,wrapper}-final.log`）。`scripts/selftest.sh --fake` exit 0、ok=true（`/tmp/ev1-selftest-final.log`）；提交绑定 `scripts/verify-local.sh --commit HEAD` 使用同一调用方临时 home（路径保存在 `/tmp/ev1-accept-home-path`），回执以该 home 的 `verify.json` 为准。src净增246行（≤350）；hooks/packages受跟踪文件零改动；预建node_modules软链不暂存；`git diff --check`通过。

### EV1b 返修

被真机证据推翻的假设是「没有原因码就属于 project」：终态与正向原因证据必须一起分诊，不能以缺证据生成项目经验。`memory --dry-run --json` 读 ledger、Archon 和 asks，只计算摘要与分类；不创建 memory、不计分、不排反思，逐项错误只在返回值中报告。

| 证据（按优先级）                                                                          | 分类 / 签名                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 起跑失败闭集映射、incident/engine_suspect、同 episode 重复提问、auto_retry 处置           | engine / base_branch_missing、engine_suspect、dup_ask、auto_retry   |
| 结构化 operator/approval_rejected/conversation_reset/fan_out 取消来源，且没有上述引擎证据 | transient / cancelled_source；历史 coder 自报不覆盖已记录的取消来源 |
| failed/cancelled/lost 无任何原因；未注册失败文本或原因                                    | engine / evidence_missing；engine / unregistered_reason             |
| 验收全绿但非成功终态、coder 自报 error、self_report_conflict                              | engine / evidence_conflict                                          |
| 注册码 review_failed/coder_output_invalid；全为 transient 码                              | role / 对应原因；transient / 原因集合                               |
| 注册码 owner=human 或实测长耗时；注册码 owner=coder                                       | plan / 对应原因或 duration_overrun；project / 对应原因集合          |

- **I1/I2/I5**：原因合并 artifacts、ledger dispositions/hold 和 Archon 错误；失败文本只做闭集诊断映射，未知文本只存 unregistered_reason，不保存错误正文、不参与 retry 决策。tag 由作业 role 与 card 文件名构成，done 作业只因超时长触发时归 plan。HF5 hash 区分挂起 episode；旧 attempt 键作为历史 episode，并按提醒身份去重，保留已关闭提问的事故证据。机制需求改为 `mechanize/<signature>.json`，同签名追加去重 episode 证据数组。
- **I6/隔离**：从生产只读取样的 8 个 run 与 4 个 strategist 作业形状存 `tests/incidents/ev1b-real-data.json`，只保留状态、原因、JSON 判定字段及时间；所有运行路径由临时根提供。四个取消 run 的 workflow_cancelled 事件实测均有 operator 来源，另回放删除来源的变体，四条变体只生成一条 evidence_missing 需求。artifacts 越界逐 run 记 `{id,reason}` 到 errors.jsonl，不含错误正文，其余 run 继续折叠。
- **增量**：fold-index 保存终态 ledger/native-id 标记与统计样本，已折叠或不触发的终态都不再查 Archon；ledger 改动使其失效。priors 仅按日或新增/变化终态样本重算。在途 run 用 readonly SQLite 的状态/metadata/活动时间/event-count 哈希识别变化，未变化时复用纯 episode 投影，仍按当前时钟重算 orphan_hold、耗时与触发；变化后仍由原生 CLI 生成 run/event 投影。没有 SQLite 注册表或使用 PostgreSQL 时保留 CLI 路径，不创建数据库。
- **生产 dry-run**：`SUPERAGENT_HOME=$HOME/.superagent ARCHON_HOME=$HOME/.superagent/archon wetamp/bin/superagent memory --dry-run --json`，前后 `test ! -e ~/.superagent/memory` 均成立；24 episodes，engine=14、plan=5、project=0、role=1、transient=4，errors=[]（`/tmp/ev1b-dryrun.json`）。aa74/6a28=engine/dup_ask，57e6=engine/engine_suspect，c439=engine/base_branch_missing；87e4/3bc3/6eb5/9e81=transient/cancelled_source；ab51/8133/cc67 done 作业=plan/duration_overrun，8715 failed strategist=role/strategist_job_failed。
- **性能证据**：恢复后重新复制 24 个 ledger 到临时 home，保留真实 Archon readonly 查询，关闭反思；连续两轮 10822.58ms、2.58ms，分别 24 次和 0 次 CLI 查询，errors=[]，稳态第二轮达到 ≤300ms（`/tmp/ev1b-perf.json`）。此前在途 run 变化时测得第二轮 530.6ms（1 次查询），不作为稳态成功；发生变化的轮次仍受原生 CLI 启动与投影耗时影响。
- **自检与交接**：恢复后最终代码执行 `cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（684 pass/0 fail/3 snapshots，199.88s，`/tmp/ev1b-all.log`），`bunx eslint src`、根 `bun run lint` 和 fake selftest 均 exit 0（`/tmp/ev1b-root-lint.log`、`/tmp/ev1b-selftest.log`，selftest ok=true）；30 项 memory 定向测试此前通过。src 净增 75 行，hooks/packages 受跟踪文件零改动。提交绑定 verify-local 的回执以同一临时 home 的 verify.json 为准（home 路径在 `/tmp/ev1b-accept-home-path`）。只做编码端交付，没有真实反思、生产写入、独立评审、合并或发布；EV1+EV2 里程碑评审及主控真机验收仍交元帅。

## EV2 看板

- **树形数据与活性 / I7**：Ink 只消费 `cockpit().tree`；主项为 Archon run 或完整 cwd 聚合的交互作业组，子项来自原生 running DAG 节点或已绑定子作业。run 必须原生 running 且最近事件距今在 `[0,10分钟)`；作业必须 running、观察到 child PID 存活且已绑定心跳在同一时间窗。未来时间不算活性；不满足的 running/owner_lost run 与 running job 只计“僵死”，不做处置。queued 尚无活子进程时不显示，HF7 准入行为不变。需要你仍只由 pending/unknown asks 决定，superseded 不显示；今日达成/已结束继续用 HF5 的 landed、无人工干预统一口径。`/sa` 的跑数也取同一 tree。
- **复用 / P4**：复用 `ProgressBar`、`eta` 的历史/线性估计与节点时长、现有 loader/活动绑定、`memoryData()` 的 EV1 摘要和 JSONL、HF5 confined 读入口，以及 BT9 深色页面 shell、认证、只读代理和 `/console/r/<native-id>` 路由。无历史显示 `— 剩—`，线性估计保留不确定标记；56 列省模型，每行截断，不折行；预算达上限标黄，保留 q/w 与 fullscreen。既有 `console url --open` 已调用 macOS `open`，无需另建入口或常驻机制。
- **历史与指标口径**：`/sa/memory` 默认失败/失联/挂起/等待或 p50 比值 >2，`?filter=all` 展示全部既存 episode，并链接 Archon 全量 run 列表与 confined JSON 视图；按 scope 展示经验，退役默认折叠，每15秒刷新。复发按完整项目×原因码（缺码用既存 signature），最近7天对比前7天；每周重复次数除以该周失败样本数，近周包含前周已发生的键。一次通过率取 cockpit 全部 completed/failed/cancelled run 的 firstPass 比例；人工干预取显式 ask/approve/reject/retry 次数与持久 intervened 证据的较大值，不把自动 recover 逐次计为人工操作。每包 token 仅已知终态 run episode 回执总量除以其包数；未知不当零。命中率为命中过经验的已计分 run/全部已计分 run，命中次数按 last_hit 变化折叠，旧计分记录用 helpful/harmful 增量恢复命中；有效率为 helpful/(helpful+harmful)。无样本为 `—`；自修复固定0，反思预算和队列直接复用 EV1。
- **确定性证据**：`tests/ev2-boards.test.ts` 固定 Asia/Taipei 时区，120/56列夹具覆盖两活run（含挂起）、两运行节点、一个僵死run、同cwd两作业、pending/superseded、预算颜色和不折行；memory夹具覆盖默认3行/全部4行、四种经验状态、手算指标、Archon链接、周复发、缺样本、HTML escaping、认证/POST拒绝与越界只读。定向7 pass/0 fail/3 snapshots（`/tmp/ev2-accept.aEOrZz/focused-final.log`）。控制台临时 home/Archon/launchd label 冒烟记录在同目录 `console-smoke-final.log`，原生 open 用替身核对命令而未打开真实浏览器；实际像素由主控验收。
- **读取边界回归**：memory/JSONL和新Web JSON视图只接受 SUPERAGENT_HOME 内的 confined 文件；已有 episode 采集的 artifacts/gen 文件保留对应 Ledger 的仓库范围，不把合法仓库证据误限到 memory home。`memory.test.ts` 回放仓库内但 home 外的验收/自报错误证据，仍得到 evidence_conflict；home 与仓库之外的路径仍拒绝。追加后定向38 pass/0 fail/3 snapshots（同目录 `focused-final.log`）。
- **交付边界**：本包只做派生将军编码和隔离自检；不触及生产台账/Archon库、hooks、packages受跟踪文件，不操作 cmux、真实提醒，不委派、合并或发布。最终全量、lint、fake selftest 与提交绑定 verify-local 结果见下方；独立 astra 里程碑评审与主控集成实测仍待元帅执行。
- **最终自检**：在隔离 home 下执行 `cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（719 pass/0 fail/6 snapshots，210.74s，`/tmp/ev2-accept.aEOrZz/{tsc-final,tests-final}.log`）；`bunx eslint src` exit 0（`lint-final.log`），根 lint wrapper此前exit 0。同一临时 `SUPERAGENT_HOME=/tmp/ev2-accept.aEOrZz`、临时ARCHON_HOME执行 `bash scripts/selftest.sh --fake` exit 0、ok=true（`selftest-final.log`）。最终控制台冒烟exit 0：GET200/POST403、原生open命令、stop后PID/socket/label消失、端口可复用均通过（`console-smoke-final.log`）。src净增96行（≤300），hooks/packages受跟踪文件零改动，`git diff --check`通过；预置node_modules软链保留且不暂存。提交后在同一调用方临时home执行 `bash scripts/verify-local.sh --commit HEAD`，提交绑定结果以该目录的 `verify.json` 为准，不将fake或本包自检当作独立评审、实际像素或主控集成验收。

## HF8 巡检解耦与作业中断

- **I4、I8 / P2**：推翻“控制台刷新失败与巡检同生共死可接受”；refreshConsole 抛错仍执行 tick，stderr 单行 `supervise-tick: console refresh failed:` 与 JSON `console_error` 保留错误，退出码仍由巡检本体决定；注入失败与真实旧 PID 迁移拒绝回放覆盖该边界。
- **I6 / P4**：推翻“子进程 exit 0 = 作业完成”；wrapper 首次收到 SIGINT/SIGTERM/SIGHUP 后，即使子进程 trap 并 exit 0，也登记 failed/原信号并返回 130/143/129，沿用 HF7 字段和等待期语义。TERM/HUP/INT 回归及 child-only 信号回归验证；负载用例改为有截止的回收轮询和 running 等待，不放宽断言。
- **HF7-R1-01 / I4、I8**：真实 OS SIGINT/SIGTERM/SIGHUP 回放证实同步 probe 期间的待交付信号会越过 queued→spawn 边界；准入后用现有 timers/promises 让出事件循环，再复查取消状态。已取消保持 pid=0、failed/原信号/128+n，真实信号回归同时断言子进程未创建、命令标记未写，不新增状态或配置。
- **HF8b / HF8-R1-01 / I6、I8**：推翻“spawn 前交付一次挂起信号就够了”；短 child 退出与同步记账结束后、终态裁决前再次交付挂起 OS 信号，监听器保持至落盘完成，wrapper 首次中断优先登记 failed/原信号/128+n；落盘后的信号不改写记录。真实 TERM/HUP/INT 覆盖 spawn 返回与 child 退出两个窗口。
- **HF8b / P2**：board 首次查询超时的 unreadable 行同样为 stale=false，不能证明缓存就绪；用有截止的轮询确认 running 且非 stale 后再触发挂起，并按桩记录的 child PID 等待回收，避免全局 pgrep 误认并发测试的 sleep。单次冷查询延迟回归保留原状态、超时与无 orphan 断言。
- **HF8c / HF8-R1-01 / I6、I8**：推翻“监听器挂到落盘完成就能计入落盘前信号”；本轮替换 HF8b 的落盘边界承诺：正常及异常终态统一按“暂定终态 rename → 下一事件循环交付点 → 中断时改写 failed/原信号/128+n → 同步移除监听器”提交。暂定终态最多可见一个事件循环周期，board 仅展示，不可据此触发不可逆动作。
- **HF8c 剩余窗口**：交付点之后的信号不改写记录；交付后的必要改写同步完成，随后同步移除监听器（移除步骤无 I/O），不承诺任何时刻的信号都会计入。隔离子进程的真实 TERM/INT/HUP 覆盖 write 前、rename 前、rename 后及边界后默认终止对照。

### HF6 redline 可建模子集（历史策略，已由 REDLINE 默认放行替代）

- **被推翻的假设 / I8、P1**：静态扫描 shell 文本并逐个补 cwd 变体不能证明完整 shell 语义。HF6 在现有顺序与子作用域判断前，先限定派生会话可建模子集；不支持的命令拒绝并提示绝对路径或独立命令。commander 不调用此检查，保持原判定。
- **子集**：shell.cjs 保留包装器和保留字的命令头索引；动态命令头、函数定义、pushd/popd/eval/source/./exec/builtin/command/alias/function/coproc 拒绝。cd 必须是顶层简单命令头，拒绝 cd -、~user、CDPATH 下的相对 cd；复合命令中出现 cd 或未建模执行词则拒绝。普通复合命令、数据 heredoc 和字面 shell -c 递归校验；stdin/here-string/heredoc/管道执行代码拒绝，解释器文件模式排除 `/dev/`、`/proc/` 伪文件。仓库脚本文件（包括 bash -n/-ex script）沿用原策略。
- **威胁模型与残留**：防派生会话意外写出 worktree，不是安全沙箱。python3 -c、node -e 等内联代码和 bash some.sh 等脚本文件的副作用不在模型内，不能据此宣称强隔离；OS 沙箱另议。复合结构中的执行词采取保守拒绝，可能把目录操作数 `.` 当作未建模词；解释器脚本选项只建模不带值的短选项及 `--`。
- **真实语料 / I6**：hf6-replay.cjs 只提取 cards/logs/\*-sol.log 的 Codex exec 命令头记录，不输出转录正文或工具输出；两版分别加载 25c107b0 的原 redline/shell 和本包版本，使用实际记录的 cwd、现存 git 根（已删除 checkout 保守用记录 cwd），env={}。冻结命令串语料共 **2321** 条；基线拒绝 **7**、本包拒绝 **9**、新增拒绝 **2**，两条均为只读探查，新增误拒率 **2/2321=0.0862%**（<3%）；commander 判定变化 **0**。不把原有拒绝认定为本包新增误拒。证据：`/tmp/hf6-accept.DefNrO/{command-corpus.json,replay.json}`；回放参数支持复用冻结命令语料，新增命令每条仅输出脱敏命令头、sha256 和拒绝理由。
  - `e2e4d1fe…`：`sh | command | command | rg | rg | head | sed`（参数与正文省略）——只读 command 查询头不在子集内；改为独立的直接查询命令。
  - `b316c3b5…`：`sh | for | test | echo | rg`（参数与正文省略）——复合结构中的目录操作数 `.` 触发保守执行词拒绝；可拆成独立命令。
- **编码端证据**：hf6.test.ts 覆盖 R3 三个复现及本卡拒绝/放行集、CDPATH、解释器输入边界、冻结基线 commander 比对和真实命令抽取；只调用 reason()，从未执行越界写入。测试、selftest 和提交后的 verify-local 结果以该临时 home 的原始日志与回执为准，独立 R1 与主控验收仍由主控完成。
- **本地验收**：在 wetamp/ 执行 `bunx tsc --noEmit && timeout 600 bun test` exit0（729 pass/0 fail/3 snapshots，198.85s，`tsc-final.log`、`tests-final.log`）；`bunx eslint src` exit0（`lint.log`）。同一临时 `SUPERAGENT_HOME=/tmp/hf6-accept.DefNrO`、`ARCHON_HOME=/tmp/hf6-accept.DefNrO/archon` 执行 `bash scripts/selftest.sh --fake` exit0（`selftest-final.log`、`selftest-fake.json` ok:true）。hooks 仅 redline.cjs、shell.cjs，净增42行（≤60）；src 与 packages 受跟踪文件零改动。提交后同一 home 执行 `bash scripts/verify-local.sh --commit HEAD`，最终结果以绑定该 commit 的 verify.json 为准。

#### HF6 R2

- **被推翻的假设 / HF6-R1-01/02/03**：手写 tokenizer 能复现 shell 词法、model 与 parse 两套遍历能保持一致。派生模式现在只走 shell-ast.cjs：一次 parse、同一 AST 遍历解码词并检查命令头、wrapper/find/shell -c 执行位置、重定向和 cwd；guard 的 N-1/git/删除判定消费该规范 argv，不再重解析。commander 保留原 redline 路径，不加载解析器。bash grammar 会把未引用续行误分为词边界，因此此边界保守拒绝；双引号续行按引用语义解码，单引号保持原字节。
- **准入与拒绝**：沿 spike (b) 的显式节点/标点白名单保留普通赋值、参数引用、file_redirect、for/if/while、测试、compound/subshell、注释及数据 heredoc。hasError/missing、不支持节点、替换/函数/here-string/复杂展开、NULLCMD 重定向、非字面头、未引用前导 = 与非 ~/ 命名目录展开都拒绝。builtin/resword 联集从 shell 自身生成，只有卡片的小白名单可执行；always 块以 grammar 错误夹具拒绝。嵌套 shell 执行体走同一遍历；stdin 执行拒绝，显式脚本文件沿原卡豁免。复合结构 cd、cd -、CDPATH 相对 cd、任何赋值与 cd 共存拒绝；wrapper chdir/find-execdir 的未知 cwd 保守拒绝。heredoc 引用 delimiter 为纯数据；未引用正文含 $、反引号或反斜杠拒绝。显式 subshell 隔离 cwd。
- **依赖 / 加载**：dependencies 精确固定 web-tree-sitter@0.27.1、tree-sitter-bash@0.25.1；只 require.resolve grammar 包定位随包 WASM，不加载 native binding、不加 trustedDependencies、不引入 npm 锁。Bun 阻止 grammar install 生命周期；新副本 frozen install 与派生 guard 已通过。加载器参数注入测试 dependency/WASM 缺失、WASM 损坏、Parser.init/Language.load 异常；初始化前 reason 及异常均 deny，含 shell parser unavailable。入口 await init，内部 parse 同步。
- **安装链**：主安装依赖失败明确提示“派生会话 Bash 将全部被 redline 拒绝”。只读核对 ~/.lan-dev-machine/bin/twin-toolkit 的 align_superagent：投送 git bundle 后在登录环境运行 --remote-hooks，bundle 不携带 node_modules。因此最小变更在 install.sh 内：远端有 bun 时按 wetamp/bun.lock 冻结安装；无 bun 需预装依赖，实际 init + parse echo ok 失败就 exit 1。未运行远端安装、未修改 twin-toolkit 或三端配置。
- **语料 / I6**：冻结 command-only corpus SHA256 ffc03a2f0bdcbd6048a710177e7b3cde0a332fcf842a72fcc3d6dfd3cbaf5e68，2321 条，env={}；25c107b0 / e09353df / R2 拒绝数为 7 / 9 / 35。相对 25c107b0 新增 28（1.2064%，<3%）；新增原因：command_substitution 22、declaration_command 5、builtin_or_reserved_head 1。commander 语料逐条变化 0，定向 R2 fixtures 也逐条与 e09353df 一致。此比例为未标注语料的新增拒绝率代理，不是逐条人工确认的 false-positive rate；只输出类别/hash，无正文。
- **延迟**：Node v24.21.0，同 spike bench.py 的交错 fresh-process 墙钟口径、两版各 20 次、OS 缓存未清、p95 nearest rank。e09353df p50/p95=36.153/38.153 ms；R2=47.966/50.148 ms，p50 +11.813 ms（≤25 ms）。WASM 体积 210415+1358224 bytes；spike 的发布包逻辑安装体积 24.227 MiB（包括 native prebuild/debug，不等同于运行时 WASM）。正式安装用本 worktree 自有 node_modules，未修改生产软链目标。
- **威胁模型 / 已知残留**：防派生会话意外写出 worktree，非 OS 沙箱。zsh native alias/function、zsh_directory_name 之外的模块与选项配置不能由 bash AST 全面保证；~[name] 已拒绝。AUTO_CD 需 SHIN_STDIN，本轮未证实生产目标开启。脚本文件与解释器内联代码（python -c/node -e）仍是原卡豁免；允许的 shell -c 是递归分析的例外。独立 R2 评审与主控最终验收仍待主控完成。
- **编码端验证**：原卡与 R1/spike 全部拒绝/放行夹具、加载失败、生成物一致性、commander 对照均以纯判定验证，不执行样例。tsc/eslint exit 0，最终全量测试全绿；selftest --fake exit 0，fresh frozen install + 派生 guard exit 0。hooks 净增 132 行、install.sh 净增 5 行、生成脚本 33 行，packages 零改动。最终测试、selftest、fresh install、延迟、回放及提交后 verify-local 证据在 `/var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/hf6-r2-fix-o9y4nzpx`。本节的局部/自检成功不代表独立评审、主控集成或部署。

#### HF6 R3

- **HF6-R2-01 / 被推翻的假设与修法**：“列表整体成功 ⇒ 最后一个命令执行且成功”对 `||` 不成立。单次 AST 遍历改为分别传递成功/失败 cwd 集合：`&&` 的右侧只接成功集合，`||` 只接失败集合，列表结果合并短路与执行分支，`;` 继续接全部可能 cwd；未知命令状态保守覆盖两条边。原 touch/重定向反例和 R2 额外拒绝项均拒绝，真实 guard 两版反例也 deny。旧 hf5 的 `cd X || touch f` 拒绝断言改为放行：写入仅在 cd 失败、仍处于原 worktree 时发生。HF6-R2-02 的解释器集合统一由无副作用 shell.cjs 导出，两模式共享所有者，commander 定向与冻结语料变化均为 0。
- **差分证据**：hf6-r3.test.ts 独立穷举 cd 成败、true/false 与短路真值，逐个写入位置比较 analyzer 检查过的 cwd 超集；6 种原子、3 种运算符、长度 ≤4 的 37050 条列表，另有 !/管道/subshell/compound/if/while 252 条，共 37302 条，违例 0，拒绝 7694（20.6262%，枚举拒绝比例，并非误拒率）。只调用纯判定，不执行样例；R2 对照 witness 漏检外部 cwd，R3 同例覆盖全部 cwd。
- **回放、延迟与范围**：冻结语料 2321 条，25c107b0 / R3 拒绝 7 / 35，新增 28（1.2064%，<3%；命令替换 22、声明命令 5、builtin/reserved head 1），仅作未标注语料的新增拒绝率代理。Node v24.21.0，两版交错 fresh-process 各 20 次，p95 nearest rank、未清 OS 缓存；e09353df p50/p95=34.770/43.880 ms，R3=46.144/55.986 ms，p50 +11.375 ms（≤25 ms）。hooks 相对 e09353df 净增 148 行（生成 JSON 不计），packages 零改动；编码端证据根 `/var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/hf6-r3-fix-ps5ipun9`，独立 R3 评审与主控验收另行完成，威胁模型与 R2 已知残留继续有效。

## HF9 决策提醒内容

- 推翻“原因模板 + run key 足以让人拍板”：标题展示项目、里程碑/包标题、节点、已完成进度与引擎结构化事实；缺失如实标注，200字内按名称段截短并保留原因、事实与是/否动作。
- 红线“是”表示重派一次、规则不变；签收只批准等待门并续跑、不自动合入。“否”终止整个run并保留证据；128位key摘要移到标题末尾，unknown对账仍兼容旧格式pending，逐原因与yes/no回归仅使用临时证据和supervisor桩。
- R2 推翻“写出动作名就等于写出后果”：retryGate 提醒列出里程碑全部包数与其中已完成包，resume 写明续跑节点；与恢复共用 adopt 判定，终态且引擎变化时明确新开run从首个节点重跑。标题仅在新提醒投递时生成，已有 pending/yes/no 不再读取标题证据或额外查询预算事件。
- R3（HF9-R1-01–04 / I2、I4 / P4）：推翻“清洗后的自由文本可以安全展示”；标题只取注册原因、标识、闭集枚举与数字，详情用 `superagent brief <run>`；预算标题与执行层共用同里程碑同 attempt 的生效额度函数，长名称按段缩短。合成泄露样例、grant 三场景、长名称与 BestIFA 重跑回放覆盖；运行时监测沿用 supervise-tick 的 `orphan_hold`（漏投）/`dup_ask`（重复），不新增状态或配置。
- R4（HF9-R2-01–02 / I2、I4 / P4）：元帅裁决 `pkg.title` 是 plan 作者的计划元数据，与 plan 同一信任级别，允许进标题；派生会话产出的自由文本一律不进标题。新增不变量“标题在任何合法输入下都可投递”：依次缩名称、完成包名单转数量、压缩数字事实、压缩固定文案，始终保留原因、完整是/否后果及 marker；16 位预算四包三完成加 adopt 的最终投递与全部提问策略最大输入回归覆盖，监测继续归属 `orphan_hold`/`dup_ask`。

- **ORCA1**：supervise-tick 处置后将 cockpit 的“跑 / 等你”汇总投影到 Orca superagent 看板；只是视图，不参与决策，拍板仍走 SUPERAGENT 提醒/decide。新待办标未读、全部解除标已读，其余变化保留用户读状态；同步失败不影响心跳退出码，SA_ORCA=0、orca-board 不存在、CLI 缺失或 Orca 未运行/不可达时跳过，绝不启动 Orca。
- **ORCA1 R2 配置与缓存**：CLI 按 `SA_ORCA_BIN` → `/usr/local/bin/orca` → `/Applications/Orca.app/Contents/Resources/bin/orca` 顺序查找；探活、加载、比较与写入共用 `home().sa/orca-board.lock` 非阻塞锁，忙时跳过，退出时释放。坏 JSON 或结构不合法的缓存按无历史重建，有 needs 时标未读；读取和写入失败仍返回 error。
- **ORCA1-R1-01（中，已知限制）**：快照加载含同步 git 调用，超时只在异步边界生效；git 卡住时单次 tick 可能超过 60 秒，launchd 只会漏周期不会并发。
- **ORCA1-R1-02（中，已知限制）**：set 结果不确定（响应超时或本地状态保存失败）时，下轮可能重发一次 `--unread`，覆盖用户手动已读状态。

## HF10：恢复身份与重试范围

- **被推翻的假设**：一是“引擎哈希变了 ⇒ 生成的工作流变了”；BT8 把 board/web 合入工作流哈希，纯界面更新也触发终态 adopt，而 Archon adopt 不继承节点输出。二是“包级挂起的重试 = 里程碑级重试”；共享 attempt-m1 会让已交付包失去编码缓存。
- **身份所有权**：`generate.ts` 的 `engineHash` 按“生成时冻结 / 执行时现读”划分，散列生成器、复制的模板/脚本、原因注册表、配置、plan 解析、输出 schema、brief 和 tiers；`residentHash` 以它为 seed 再散列 src，由 board 刷新与 web 重启共同消费。文件遍历只有一个 owner，常驻身份没有复制工作流清单。web state 的既有 engine_hash wire 字段保存 resident 指纹，避免更改界面状态契约。
- **恢复与兼容**：新 ledger/engine.json 写 workflow_hash，保留 engine_hash。恢复与提醒继续共用 adoptsRun，优先 workflow_hash；旧 ledger 只有 engine_hash 时，仅相等才确认可 resume，不相等或缺失则保守 adopt，标题明确“旧run身份未确认，将新开run从首个节点重跑”。failed/cancelled 以外不新增 adopt，completed 仍禁止恢复。
- **逐处身份用途**：新 run/adopt 的 engine_hash 与 workflow_hash 均记录生成身份；summary.engine 判断生成物是否过期；recoverRun 的确定性防重、autoRetry 的同身份零次/换身份最多一次、engine_suspect 自动处置和 incident 指纹均使用 workflowIdentity。auto_retries/adoptions 的既有 engine_hash/engine_from/engine_to 字段继续保存工作流身份，不改 wire 字段。纯 UI 漂移不再烧确定性重试或新开嫌疑 run；原一次重试限制不变。board/web 才使用 residentHash。
- **包与里程碑**：每包 package-attempt-<id> always_run 节点读取 attempts/.packages/<id>（前导点不符合里程碑 schema，旧 attempts/<m> 不变），code/verify/repair/settle 同时依赖包与里程碑计数。显式包重试只 bump 包计数；held:gate 仍 bump 里程碑。读取实际 YAML 节点判断能力，旧生成工作流没有包计数时 verify/settle 仍重跑整个里程碑，标题标“旧工作流”；旧 code/repair 保持直接 resume。缺少所需里程碑计数则明确拒绝，不猜能力、不加 YAML 字段。
- **预算归属**：预算授权仍绑定里程碑 attempt，不改计费语义。任何计数文件缺失时读取为 0，不为包重试创建或改写里程碑文件；CLI、budget() 与生成的里程碑、包及评审 attempt 节点共用模板 readAttempt，生成器通过 attemptCommand(attemptPath(...)) 构造全部计数读取，拒绝负数、非法值与无法精确表示的计数，bump 也拒绝溢出。budget() 在里程碑文件缺失时以 0 匹配 grant；下一次里程碑重试仍使旧额度失效。
- **HF10b / HF10-R2-01**：评审轮次计数也使用同一读取与路径 owner；正常及 fake 模式全部评审 attempt 节点覆盖缺失、合法值、NaN、负数和目录，两个 golden 同步。
- **HF9-R3-01**：所有提问策略的两个数值极值都经 supervise-tick，断言 supervisor 桩最终 question 参数、非空完整是/否后果、marker 与 ≤200 字；旧“已完成3/2节点”夹具改为真实3/5。包/里程碑/adopt/旧工作流四种范围也经过最终投递路径。仅为编码自检，独立评审是否关闭债务仍由主控确认。
- **实际投递标题**（每条 ≤200 字，原文）：
  - 包级：BestIFA/W4验收/verify-W4：将军命中红线；编码端命中红线；已完成13/63节点；是=重派W4编码→验收一次（红线不变）；否=终止整个run（保留证据）；详情superagent brief <run>；[sa:1ee9998357b47b971a63ccd2588cb69e]
  - 里程碑：BestIFA/m1/gate-m1-r3：三轮评审已用尽；轮次3，未决1；评审未通过；已完成13/63节点；是=重跑m1全部11包（含已完成W1、W2、W3）一次；否=终止整个run（保留证据）；详情superagent brief <run>；[sa:89f25f3850653cff37ae65847fd2d73a]
  - adopt：BestIFA/W4验收/verify-W4：将军命中红线；编码端命中红线；已完成13/63节点；是=重派W4编码→验收一次（红线不变）（引擎已升级，将新开run从首个节点重跑）；否=终止整个run（保留证据）；详情superagent brief <run>；[sa:1ee9998357b47b971a63ccd2588cb69e]
- **身份复算**（历史源码快照，不切分支；算法统一用 HF10）：f7f9c2b1 的 workflow=`a6a253162013eb1aa39725ef7e3b6f44fe1207ff6ca6dd3dc3345f160807706c`、resident=`ff657bd5172f954fc4be026ca4ffc53bf0bb66b1f15902aba9cc0d54243b930c`；纯 UI 终点 b5923378 的 workflow 相同、resident=`46e8ae348ac85ec8cadd38cdcbfa8f9c6d18a5ab1ffac51857678d357cd6facf`。本包 workflow=`9ad5884b039b6d1102d8a2ead3176a106253eb7cf4c1273a0ed4f6ec74d67d54`、resident=`e915bb8d2ef624986b327411fcddb9785687a2a00dff183d260a97dff949846e`；差异包含生成器和计数语义的实际改动，不是纯 UI 漂移。
- **验证**：tsc、eslint src、diff --check 均 exit 0；HF9/HF10 定向78 pass/0 fail（`/tmp/hf10-focused-final.log`），界面回归76 pass/0 fail/3 snapshots（`/tmp/hf10-ui-final.log`）。全部 CLI/生成器与真实 Archon fake E2E 三文件最终262 pass/0 fail、exit 0（173.44s，`/tmp/hf10-behavior-final.log`）；包重试 code-W1/W2/W3/W4 次数为1/1/2/1，gate重试为2/2/2/2。`scripts/selftest.sh --fake` exit 0（`/tmp/hf10-selftest-final.log`），调用方临时 home 为本 worktree 的 `wetamp/.context/hf10-test-tmp/accept.1h7x4N`；首次将 TMPDIR 放在 wetamp 内造成 cpSync 自包含错误，移到根级 .context 后通过，未改自检脚本。src 净增19行，hooks/packages 受跟踪文件零改动。
- **R1 验收边界（R2 卡已裁决允许脚本/测试清理自建临时资源）**：原卡同时要求完整 bun test/verify-local，又绝对禁止 git worktree remove/prune 与删除 worktree 外目录；verify-local 及其测试确实会执行这些清理。R1 未取得例外授权，未执行该项；R2 卡已明确允许脚本/测试内部清理自建临时目录与 worktree，派生会话仍不得手工执行 worktree remove/prune。R1 的可执行回归与 fake 自检临时资源放在本 worktree 内，selftest 不传 --repo，OWN_REPO=1 跳过 worktree remove。证据在 /tmp，scratch 状态不提交。
- **执行偏差**：扩大为排除 verify-local.test.ts 的28文件测试批次时，漏查 scripts.test.ts 对 gc.sh --apply 的间接调用，已对本 worktree 内自建临时仓库执行 git worktree remove，违反卡片绝对禁令。发现后停止批次（exit 130，`/tmp/hf10-safe-suite.log`），不把该批次计为通过；无既有/HF10 worktree 删除。后续只复跑已核对的 CLI/生成器/HF10 三文件。早先合并测试261 pass/1 fail为 S3 旧计数断言仍读 attempts/m1，已改成 attempts/pkg/core=1 并断言无里程碑 bump。
- **遗留**：执行时现读类运行依赖修复后，同身份确定性自动重试不会再给一次机会；这是本包合入前已有的语义，未改自动重试身份清单或次数限制。消费提醒回答后的用户回执另立工作包，需共享 agent-supervisor 技能改动；本包不改。独立 astra 评审、元帅验收、生产恢复与合入发布均不由本派生会话宣称完成。

### HF10 R2：计数、身份与路径修复

- **HF10-R1-01**：真实 Archon fake 预算回归先复现 grant.attempt=null（`/tmp/hf10-r2-repro.log`），修复后 grant.attempt=0 且无需 attempts/m1。首次包级恢复的 code-W1/W2/W3/W4=1/1/2/1，证明其他包保留缓存，且 verify-W3 经真实事件查询的 budget() 已允许追加额度。独立 CLI 两次回答“是”回归各执行 sa-check accept/budget() 并验证 advance，grant 都绑定 milestone=m1、attempt=0、launches=27、weighted_tokens=5400000、limits={launches:28,weighted_tokens:5400100}；包计数依次为1、2，里程碑文件均缺失，生成的 attempt-m1 输出均为 {"attempt":"0"}。非法计数与安全整数上界回归确认失败时原文件未改、没有 resume。
- **HF10-R1-02 裁决与证据**：生成时冻结的输入才决定 run 是否过期：`src/generate.ts:551-554` cpSync 复制 templates/.archon，`src/generate.ts:585-593` 写出 YAML，因此模板与生成源码已在清单中；没有删除清单既有项。四项均为执行时现读，不新增到 engineHash：`bin/codex-worker` 经 `src/config.ts:24,233` 的绝对 codexBinaryPath 调用；`bin/codex-readonly-proxy.cjs` 经 `bin/codex-worker:96` 现读 exec；`scripts/codex-trust.cjs` 经 `bin/codex-worker:34` 现读 bun check；`src/archon.ts` 经 `bin/superagent:34` 加载 cli.ts 的 `src/cli.ts:26-40` import，并在 `src/archon.ts:83-88,311-317` 为每次 run/resume/approve 启动构造 workerEnv。`src/generate.ts:576-577` 仅 symlinkSync bin/archon，未复制其实现。逐项变更测试证明四项 workflow hash 不变；templates/.archon 与 generate/config/plan/reasons 逐项变更均改变 hash。engineHash 旁注释写明该划分不变量。
- **HF10-R1-03**：包计数路径由模板内共享 attemptPath 统一构造，生成器与 CLI 均导入该 owner；物理路径 attempts/.packages/<id>，逻辑 scope 仍为 pkg/<id>；里程碑 schema（`schemas/plan.schema.json:235`）只接受字母开头，构造上排除 .packages。里程碑 pkg 的“先包后 gate / 先 gate 后包”均两次 resume 成功，两份计数各为1，旧 attempts/<m> 路径保持兼容。
- **原卡样例**：普通包回归执行次数仍1/1/2/1；gate仍2/2/2/2；三种实际投递标题原文未变化，沿用上方样例。R2 用同一 hash owner 重算 f7f9c2b1 与纯 UI 终点 b5923378，与上方历史值一致；R2 candidate workflow=`933dd4efe4671773e8a99057262de8cba2ba834bfa18734c934fe25d41cd9c17`、resident=`b484937640d1f5e6343156721a4800c05bce6f859307665524e3ce0e623a3018`（`/tmp/hf10-r2-identities.log`）。
- **R2 自检过程证据**：最终定向24 pass/0 fail（`/tmp/hf10-r2-focused-final.log`），tsc/eslint src exit 0。首次完整套件960 pass/1 fail（259.60s，`/tmp/hf10-r2-full.log`），唯一失败为 S3 仍断言旧 attempts/pkg/core 路径，已改为 attempts/.packages/core。并行重跑 fake 自检的行为 receipt 为 ok=true，但 EXIT 清理临时目录报 Directory not empty，脚本整体 exit 1（`/tmp/hf10-r2-selftest-final.log`）；不将该次视为通过、不手工删除资源，最终验收采用串行重跑结果。
- **R2 最终完整验证**：`cd wetamp && bunx tsc --noEmit`、`bunx eslint src` exit 0；`timeout 600 bun test` exit 0，961 pass/0 fail/3 snapshots，29 文件，338.08s（`/tmp/hf10-r2-full-final.log`）。包/预算 E2E code 次数均1/1/2/1，gate2/2/2/2；两次 grant 完整内容在 `/tmp/hf10-r2-grants.json`，均 attempt=0，包计数1→2，里程碑缺失=0。src 相对 b67e0385 净增25行，hooks/packages 受跟踪文件零改动，diff --check exit 0。提交后 verify-local 绑定 HEAD 的结果在同一调用方临时 home `/tmp/hf10-r2-accept.cepGSi/verify.json`，不写入仓库或生产 home。
- **R2 fake 自检最终结果**：同一临时 SUPERAGENT_HOME 下串行 `bash scripts/selftest.sh --fake` exit 0（`/tmp/hf10-r2-selftest-serial.log`），receipt ok=true。未亲手执行 git worktree remove/prune，未清理脚本之外创建的 worktree/目录；生产 home、supervisor 与 launchd 均未操作。本交付仅编码与自检，astra R2 核验、主控实测及合入发布仍由主控执行。

### ACCT：验收节点超时按实际命令预算推导（G1）

- **问题与来源**：Archon script/exec 节点未显式声明 `timeout` 时按 `SUBPROCESS_DEFAULT_TIMEOUT = 120_000` 毫秒执行，而 plan 验收命令的 `timeout_s` 可以超过 120 秒。06:26 在生产主 checkout 发现未经评审的未提交生成器改动；用户决定转为正式工作包，原样导入为 `8b66157b`。本包仅在 `wetamp-acctimeout` 修正，不操作生产 checkout。
- **执行模型依据**：`templates/.archon/scripts/sa-check.ts` 的 `run()` 串行执行每条命令，单条预算为 `timeout_s * 1000`，不中途跳过后续失败项；`acceptOnce()` 只选择 `INPUTS_PKGS` 的验收命令，失败时 `probe()` 在基线临时工作树串行重跑失败命令。因此 verify、里程碑 diff 与修复后 settle 的最坏命令预算是两遍总和；`cache:true` 不保证命中且失败不缓存，不减预算。settle 未修复时透传首次证据，但静态节点预算必须容纳修复分支，不能把 verify 本身的执行时间再次累计。里程碑 diff 的命令只覆盖当前 `m.packages`，累计 `scope_pkgs` 仅用于检查授权写入范围，不纳入求和。环境检查串行执行 plan 级与所有包级 environment 命令一次，不 probe；有命令才设置预算。gate/land 等不运行验收命令的节点不添加 timeout。
- **R1 余量与下限（已被 R2 取代）**：验收/修复后结算 `max(120_000, 2 * sum(timeout_s) * 1000 + 60_000)`；environment 为 `max(120_000, sum(timeout_s) * 1000 + 60_000)`。保留起点的 60 秒运维余量，显式命名 `CHECK_OVERHEAD_MS`，用于 Bun 启动、git status/diff、hash 与文件写入、基线工作树创建/清理及预算台账查询；这是非命令操作的余量选择，并非无超时 git/查询操作的严格耗时上界。下限独立命名 `ARCHON_SUBPROCESS_DEFAULT_TIMEOUT_MS`，不借用 CLI `QUERY_TIMEOUT_MS`；生成测试读取 Archon 源码常量并核对生成节点下限，防止两边漂移。schema 不变、配置默认值不变。
- **R1 旧 run 与 golden（R2 更新如下）**：`generate.ts` 属于 HF10 的生成时冻结输入，本包改变 workflow identity；合入后旧终态 run 恢复走 adopt，是工作流行为真实变化，符合 HF10 语义。两个 golden 相对 `f9394a60` 仅多出原导入的 10 个验收/settle/diff 节点的 `timeout: 120000`，30 秒 fixture 在两遍加余量后仍恰好为 120 秒，无其他 golden 变化。
- **R1 范围与提交钩子（R2 上限 70 行）**：源代码净增上限 40 行；仓库 pre-commit 强制 prettier，未经收敛会重排既有 engineHash、fakeEdit 和 engine.json 写入表达式，使净增达到 72 行。仅给这三个不改语义的既有紧凑表达式加 `prettier-ignore`，其余本包修改按钩子格式化；不禁用或绕过钩子。格式化后 src 相对 `f9394a60` 净增 39 行，hooks 与 packages 受跟踪文件零改动。
- **回归证据**：新增低时长下限、远超 120 秒的串行多命令（含 cache）、多包里程碑及环境执行次数/空环境预算断言。真实 Archon fake 用例将节点预算缩小 100 倍：2 秒验收命令代表 200 秒，旧预算 1.2 秒使节点 timeout/skip，推导预算 6.6 秒让实际 sa-check 完成。避免每轮等待超过 120 秒；使用真实执行器、真实 sa-check、scratch 仓库与临时 home，无模型调用。定向 5 pass/0 fail；完整验收结果另列于本节末尾。本派生会话只编码与自检，独立 astra 评审、元帅实测、合入发布由主控完成；自动经验晋升收尾不执行。
- **最终本地自检**：`cd wetamp && bunx tsc --noEmit` 与 `bunx eslint src` 均 exit 0（`/tmp/acct-tsc-final.log`、`/tmp/acct-eslint-final.log`）；`timeout 600 bun test` exit 0，982 pass/0 fail/3 snapshots，30 文件，254.47 秒（`/tmp/acct-full.log`）。串行 `SUPERAGENT_HOME=/tmp/acct-accept.IHjRUB ARCHON_HOME=/tmp/acct-accept.IHjRUB/archon bash scripts/selftest.sh --fake` exit 0（`/tmp/acct-selftest.log`），回执 `/tmp/acct-accept.IHjRUB/selftest-fake.json` 的 ok=true。提交后的 `bash scripts/verify-local.sh --commit HEAD` 使用同一临时 home，结果绑定新提交并写入其 `verify.json`，不写生产状态。不亲手执行 git worktree remove/prune；脚本自行清理其 scratch 资源。src 净增 39 行；hooks/packages 零改动，diff --check exit 0。

- **R2 / ACCT-R1-1**：被推翻的假设是“固定 60s 余量足以覆盖无界辅助子进程”。验收/修复后 settle 改为 `max(120_000, 2 * sum(timeout_s) * 1000 + 9 * 10_000 + 5_000)`；environment 为 `max(120_000, sum(timeout_s) * 1000 + 1 * 10_000 + 5_000)`。辅助清单：git status、缓存 tree rev-parse、全量 binary diff、增量 binary diff、scope raw diff、probe worktree add/remove、HEAD rev-parse、Archon workflow get 台账查询；各自显式 10s 超时，env 只跑 HEAD。常量与次数由 sa-check 导出并由生成器 import；实际最坏路径调用跟踪校验次数与每次超时，settle 失败挂起跳过查询，9 次是覆盖上界。辅助超时沿用该步骤的失败出口（exit 1），保留 stderr、终止信号及 probe 路径；工作树创建失败也尝试非 force 清理，清理超时不放行。gate/land 不施加辅助超时。golden 仅将原 10 个 timeout 从 120000 更新为 155000；下限与旧 run adopt 语义保持。挂起桩缩小辅助超时为 100ms，覆盖 status、probe 创建/清理、台账及 env HEAD；真实 Archon 节点预算缩小 100 倍，失败验收与非空 BASE 的 probe 均执行并存档，台账 stub 返回真实结构，辅助实际使用生产常量以避免 100ms git 偶发调度超时（逐调用上界另由跟踪及挂起回归证明）。

- **R2 本包自检**：定向 ACCT/golden 13 pass/0 fail；`cd wetamp && bunx tsc --noEmit && timeout 600 bun test` exit 0（988 pass/0 fail/3 snapshots，292.08s），`bunx eslint src` exit 0。`SUPERAGENT_HOME=/tmp/acct-r2-accept.nL6ENQ ARCHON_HOME=/tmp/acct-r2-accept.nL6ENQ/archon bash scripts/selftest.sh --fake` exit 0，回执 `ok:true/fake:true`；提交后同一调用方 home 执行 `bash scripts/verify-local.sh --commit HEAD`，以 `verify.json` 的 HEAD 绑定和各步退出码为准。src 相对 f9394a60 净增 46 行（≤70），hooks/packages 受跟踪文件零改动，diff --check 通过。仓库提交钩子强制 prettier，既有模板/进度部分仅发生格式重排；未增加状态、配置或依赖。本会话只编码自检，不发起独立评审、不作主控验收或集成。

## HF10b：统一评审轮次计数读取

- **问题与不变量归属**：HF10-R2-01 指向评审 attempt 节点的手写 `cat … 2>/dev/null || echo 0`。它允许 NaN、负数和目录读取错误通过；输出 schema 仅要求 string，不能证明计数有效。本包强化 I3 的 attempt 边界证据与 I6 的夹具真实化：不把坏计数或读取错误伪装为 0。
- **被推翻的假设与新语义**：HF10 的“所有生成 attempt 节点已统一读取”假设不成立。现在里程碑、包及评审轮次节点全部复用 `attemptCommand(attemptPath(...))`，运行时由模板 `readAttempt` 读取；仅 ENOENT 缺省为 0，合法非负安全整数照常，非法值及目录读取错误明确失败，不写回计数、不新增状态或配置。
- **测试、事故回放与监测**：`generate.test.ts` 在正常及 fake 模式逐节点执行全部 6 个评审 attempt 节点（共 12 例），覆盖缺失、0、7、NaN、-1、目录。复现时旧实现的两组回归均因 NaN 时退出 0 而失败；修复后要求非法值退出非 0 且无成功输出。两个 golden 同步；运行时监测点是现有 `attempt-review-*` 节点失败及 stderr 原始错误，不另造监测机制（P4）。
- **旧 run 与生产影响、遗留**：`attempts/review-<m>-r<n>` 路径与输出契约不变；旧 run 冻结的 YAML 保留旧读取，生成器纳入 workflow hash，按已有恢复语义采用新引擎后才应用修复，运行中不换源。此包仅编码与自检，批次统一评审、主控集成验收及生产投送由主控执行；原 HF10 的回执及同身份现读依赖自动重试限制继续保留。
- **编码自检**：定向测试 256 pass/0 fail（`/tmp/hf10b-focused.log`），`bunx tsc --noEmit`、`bunx eslint src` exit 0；`timeout 900 bun test` 979 pass/0 fail/3 snapshots、30 文件、329.61s（`/tmp/hf10b-full.log`）。独立临时 home `/tmp/hf10b-accept.0pduwg` 下 `bash scripts/selftest.sh --fake` exit 0，receipt ok=true（`/tmp/hf10b-selftest.log`）；提交后同目录运行 verify-local 绑定最终 HEAD。相对 f9394a60 源码净增 0 行，hooks/packages 零改动。
- **提交产物验证中的测试修正**：首提交 `135f7376` 的 verify-local 在并行负载下发现回归单例集中执行 36 次子进程触及 Bun 默认 5 秒上限（日志 `/tmp/hf10b-accept.0pduwg/verify/135f73769720.log`）。保留完整验证结果，将回归拆成每个评审节点独立一例，仍执行实际生成的命令，不提高 timeout；最终生成器定向测试 34 pass/0 fail（`/tmp/hf10b-focused-final.log`）。产品源码与 golden 不再改动，最终提交重新跑 verify-local，不复用首提交结果。

## B1-ADM：run 受理背压与本机容量/故障矩阵（F-08 / WP-5）

- **问题与被推翻的假设 / I8、P1、P3**：provider 槽位限制不能限制先启动的 worker/worktree；HF7 的 job 内存准入也不覆盖 run。源码确认 Archon detached launcher 在 fork 前持久化 pending，因此在共享受理锁内读取引擎 run 状态并保持到启动回执即可封住跨 CLI 检查/启动窗口，无需第二套排队状态或租约回收器。
- **新语义 / P4**：复用现有内核 flock，在 `$ARCHON_HOME/run-admission.lock` 串行受理；容量直接取 `tiers.health.vendor_concurrency` 正整数之和（当前 6），不新增配置。生成工作流、preflight 子进程、worker/worktree 之前检查 `archon.db` 的非终态数量；pending/running/paused 及未知状态均保留容量，completed/failed/cancelled 释放。锁忙/满额分别输出 `reason=admission_busy/run_capacity`、`status=rejected`、`phase=admission` 与 exit 75；请求未生成 run，可由调用方重试。数据库读坏、schema 缺失或非法容量明确失败，不能按空库放行。启动成功、失败、异常均释放锁，进程被杀由内核释放；不删除锁文件，不凭计时器猜 owner。
- **矩阵实测**：`bun scripts/run-capacity-matrix.ts` 使用临时 home/repo、真实 Archon 与 fake bash provider，153916ms 完成 N=20 提交风暴：1 受理、19 拒绝；随后填满 6 个 worker，满额拒绝不增加生成目录。4 次同组进程 FD 均 86，总 RSS 为 1366400/1369744/1369536/1369488KB；控制进程独立采样从 FD 8、RSS 68352KB 到完成后 FD 8、RSS 72752KB。真实 detached spawn 的 ENOENT 注入产生 1 条 failed run、CLI exit 1；下一提交 completed。35 秒长 continuation 实耗 37447ms 后 completed；所有受理 run 的 cancelled 数为 0。JSON 原始证据 `/tmp/adm-matrix.json`，脚本可独立重放，`--quick` 保留缩短模式。
- **有界回归与运行时观测**：新增 5 项测试覆盖 8 并发 CLI、跨 SUPERAGENT_HOME 共用 ARCHON_HOME、拒绝前无生成目录、终态释放/暂停保留、数据库失败、持锁进程 SIGKILL 与启动失败后的再受理；定向 5 pass/0 fail。退出码与受理 JSON 是运行时监测点，不新增 supervisor/hook。tsc 与 eslint src 已为 0；fake selftest 在 `/tmp/adm-verify-nac4mhcw` 写回 ok=true，日志 `/tmp/adm-selftest.log`。完整套件及提交后 verify-local 的结果见本节末尾验收记录。
- **旧 run/生产影响与遗留**：已有 run 不被取消、迁移或改写；旧非终态 run 也占容量，历史积压超额时新提交被拒，须显式处置既有 run。此入口只约束 `superagent run`，保留既有 run 的 resume/adopt，不拦截直接 Archon 调用；终态 worktree/日志回收仍归原 GC，不能把活跃容量上限当磁盘总量上限。本矩阵证明本机 fake provider 下的边界与趋势，不证明真实 provider、长时间无泄漏或外部机器压力；未操作生产 home、launchd、supervisor，未改 packages，统一独立评审/主控验收由主控执行。
- **完整自检过程证据**：首轮 `timeout 900 bun test` 为 981 pass/1 fail（489.80s），唯一失败是既有 `hooks.test.ts` reviewer Bash 白名单用例的 5 秒超时；该文件原样单跑 22 pass/0 fail（29.06s），未修改测试或放宽超时。按公共卡要求重跑完整套件；原始日志 `/tmp/adm-tests.log`、`/tmp/adm-hooks.log`。
- **最终整套验收**：第二轮 `timeout 900 bun test` exit 0，982 pass/0 fail/3 snapshots，31 文件、4794 assertions，399.70s（`/tmp/adm-tests-final.log`）；`bunx tsc --noEmit` 与 `bunx eslint src` 均 exit 0。最终脚本快速重放 exit 0，47975ms（`/tmp/adm-matrix-quick-final.json`），fake selftest exit 0、receipt ok=true；提交后以同一临时 home 执行 verify-local，JSON 回执位于 `/tmp/adm-verify-nac4mhcw/verify.json`，不写入仓库或生产 home。

## B1-RCPT：消费决策答复后的回执

- **问题与被推翻的假设**：提醒勾选/删除后的动作只有引擎台账可见，用户不知道实际是包重试、里程碑重试、续跑还是 adopt；“有普通通知后端 ⇒ 有可用的通知 CLI”也不成立，现有 `notify-test` 标题固定且投递失败仍 exit 0。
- **新语义 / P1、P2、P4**：复用 supervisor 普通通知后端，不建 ask。动作成功后立即持久化原 ask 的 approved/rejected 与 pending 回执，再投递；内容仅为 run/节点标识、闭集答复/动作、确认的引擎 run 去向。恢复与 retryGate 的成功回调提供实际 adopt/resume 分支、实际 scope 与引擎 run 去向，不用预判 hash 或并发产生的身份变化替代本次动作。不展示将军/评审自由文本或宣称后续验收通过。格式化留在执行时现读的 cli.ts，reasons.ts 是冻结工作流输入，不为纯回执改变 workflow hash。
- **幂等与失败**：答复 occurrence 的 ask id（旧无 id 时用 ask key）加 yes/no 生成 SHA256 投递 key；asks.json 只增可选 receipt，旧记录不补发。pending 回执即使 run 已终态也会继续对账；sent/failed 不重发、不再查询答复、不重放动作。投递失败在 tick JSON 写 action=receipt/ok=false，tick exit 1，同时保存 receipt.delivery=failed 和 error；动作成功记录保留。动作本身失败则保留答复等待重试，不发成功回执。
- **共享技能交接 / I7**：共享目录只读，最小补丁在 `/Users/yong/.superagent/cards/batch1/rcpt-shared-skill.patch`（supervisor.py、SKILL.md、通知单测），增加 `notify --key --title --body`：同 key/内容只尝试一次、结果原子落盘、冲突明确拒绝，只把 reminders 投递确认视为成功；默认进入普通 Agent 监督列表，不参与 decisions-tick。补丁通过 git apply --check；在临时副本通过成功、失败、异常、不确定结果、重复调用、内容冲突与非法 key 单测，未调用真实通知。
- **旧 run / 生产影响与遗留**：不改变恢复、审批、取消、预算和 retry 的执行语义；只在新消费的答复上增回执。主控须先应用共享补丁、同步并三端验证再集成启用，旧 supervisor 未升级时动作仍执行，回执会明确失败。为防重复，supervisor 在传输前占位；占位后中断会返回 delivery_unknown，可能漏发但不会二次投递。动作确认与 asks 持久化之间的既有跨系统崩溃窗口、signalHuman 的既有状态确认口径没有扩改。真实 iPhone/TCC、独立评审、主控验收、生产合入与发布未由本派生会话验证。
- **编码自检证据**：RCPT 定向12 pass/0 fail（`/tmp/b1-rcpt-focused.log`），覆盖勾选、删除、重复 tick、投递失败、动作拒绝、终态 pending 对账、包/里程碑/adopt/审批/评审/续跑、并发身份变化及自由文本排除；RCPT/HOLD_POLICY/HF10 行为验证27 pass/0 fail（`/tmp/b1-rcpt-behavior.log`）。首轮完整测试971 pass/18 fail不计通过，修正旧 supervisor 桩与 ask-status 末条断言后，源码稳定的完整重跑989 pass/0 fail/3 snapshots，418.93s（`/tmp/b1-rcpt-full-final.log`）。tsc、eslint src、diff --check均exit 0，fake 自检exit 0（`/tmp/b1-rcpt-selftest.log`）；同一调用方临时 home为`/tmp/b1-rcpt-accept-bejjxfen`，提交后verify-local绑定HEAD的结果在该目录verify.json，最终回复报告结果。共享补丁临时副本2 pass/0 fail（`/tmp/b1-rcpt-shared-tests.log`），git apply --check通过。
- **回执原文**：`run=sa1；节点=human-m2；答复=是；已批准等待门并提交续跑；去向=r；结果=动作已受理（不代表后续验收通过）`；`run=sa1；节点=human-m2；答复=否；已终止整个run（保留证据）；去向=r；结果=动作已受理（不代表后续验收通过）`。

## B1-GUARD：身份、计量事务与安装模式

- **问题与被推翻的假设 / A-07、A-08**：reviewer 子会话结束不证明当前 candidate 已审，child 也不能同时被 rootCall 当作子会话、被 derivedBy 当作主控。`isChild` 是两处唯一身份来源，child 禁止再派生；commander 原模型判定保持。Stop 的 off 静默，advisory/cycle/change 均只提示引擎正式 gate；删除 hook 指纹、reviewEvidence 与自建评审状态，不从完成事件推断通过。`hooks.test.ts` 的 A-07 反例在评审启动后改树并模拟完成，A-08 同时覆盖 Codex/Claude child、root commander 与空 metadata。
- **历史方案 / A-09（已由 REDLINE 与 B1-INT2a 裁决覆盖）**：编辑目标/补丁不可解析、缺 shell 文本、缺累计会话身份、坏 JSON/微改状态及主入口异常都拒绝；内部异常 exit 2 且 stderr 不打印输入内容。已知 shell 代码写入不能执行前可靠计量，直接 deny 并要求 Edit/Write/apply_patch 或 superagent run；动态落点、带 cd 的写入和内联解释器代码同样拒绝，已确认豁免文档输出与只读命令保持可用。复用 HF6 的 shellWrites/redline，未替换派生 shell AST 子集；每种反例与文档/只读对照均在 `hooks.test.ts`，不把静态识别宣称为完整 shell 语义。
- **事务与幂等 / A-11、F-12**：`hook-state.cjs` 统一排他锁、完整 RMW、随机临时文件 rename 与原生事件 ID 去重；G-1 重复事件返回原决定，context 重复事件不再次计数或提示。安装折叠自有 matcher/all 重叠，保留用户其他 handlers、组字段及未管理配置；替换固定 `.sa-tmp`。24 个并发 context 调用含20个不同 ID，最终计数20；4个并发安装均成功、仅一份自有 handler、用户字段保留；坏状态不重置、callback 失败释放锁、旧 live-owner 锁不抢，见 `hooks.test.ts`、`guard-install.test.ts`。
- **模式事实 / WP-1**：默认安装与 --remote-hooks 共用锁内台账发布，分别写 controller/worker，保留用户字段，内容不变不更新 installed_at。preflight 在直接 TypeScript worker run 启动引擎前拒绝，失败回执报告 mode；health 与启动回执也报告模式。无台账或台账属于其他 checkout 的开发源码沿用 controller；本 checkout 未知 role 或坏台账明确失败。模式矩阵、worker run 无引擎副作用、remote 重装字段与时间幂等见 `guard-install.test.ts`、`install.test.ts`。
- **对旧 run/生产的影响**：不修改 packages、工作流结构、持久 run 状态或引擎评审契约。旧 Stop hook 的 cycle/change 降为 advisory，不再阻塞退出或把旧评审状态当通过；旧 micro 累计继续保留，旧 hook review 字段不再消费。重复事件无法可靠识别时仍按不同事件计量；旧 controller 安装无台账保持兼容，新安装台账归属当前 checkout。全部安装/CLI 自检使用临时 HOME/SUPERAGENT_HOME/XDG_STATE_HOME，未操作生产 home、launchd、真实 supervisor、提醒事项或远端部署。
- **遗留与边界**：无原生事件 ID 无法保证重复计量幂等，绝不按正文 hash 猜事件；脚本文件内部与任意间接进程写入不在 shell hook 模型内，hook 不是执行/安全沙箱。锁忙最多等5秒，崩溃遗留或 owner 不明的锁明确失败，由操作者确认 owner 退出后处理，不能按年龄自动删除。独立 astra G2 评审、主控验收、集成和生产安装由主控统一执行，编码端不宣称已完成。
- **编码端验证**：证据目录 `/tmp/b1-guard-validation`；临时 SUPERAGENT_HOME `/tmp/b1-guard-tl8e98w2`（XDG_STATE_HOME 为其 xdg 子目录）。定向回归46 pass/0 fail，tsc/eslint src exit 0；fake 自检 exit 0，selftest-fake.json 的 ok=true。完整套件与提交后 verify-local 的最终结果以下方补充及该临时 home 的 commit 绑定 verify.json 为准。
- **完整套件首轮**：`bunx tsc --noEmit && timeout 900 bun test` exit 1，986 pass/1 fail/3 snapshots（432.97s）；唯一失败为 S4 registry 工作流生成超过 Bun 默认5秒（`full-test.log`）。未改断言或超时；单跑 `tests/s4-contract.test.ts` exit 0，7 pass/0 fail（4.05s，`s4-rerun.log`），随后按卡重新执行完整套件。
- **完整复跑最终结果**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，987 pass/0 fail/3 snapshots（31文件，417.72s，`full-final.log`）；S4 原超时用例在全套中2.30s通过。`bunx eslint src`、`bash -n scripts/install.sh`、工作区及暂存 diff --check 均 exit 0。提交后同一临时 home 执行 `scripts/verify-local.sh --commit HEAD`；最终是否通过以 commit 绑定的 verify.json 与脚本退出码为准，不回填未经运行的成功。

### B1-REC：恢复接纳 fencing、未知归属与效果对账

- **问题与被推翻的假设**：recover 的 flock 只覆盖调用进程，detach 回执不等于新 owner 已落盘；旧死 PID 在接纳窗口仍可被第二个恢复者重用。pending、无 owner、远端 owner 和已复用 PID 不能推出生命周期终态；停止命令 exit 0 不等于停止及资源清理成功；15 秒 mtime 不证明锁 owner 已死。
- **接纳身份**：running 回拨的 CAS 同时写入随机 token、原 owner 与 started_at，比较 host/pid/uid、执行阶段时间和旧 token；时间比较兼容 SQLite 时间串与 CLI ISO。复用原生 exact-run live-owner endpoint，探测失败保守 held。resume 和 engine adoption 启动前发布 sidecar，DB marker 与 sidecar 分别核验；旧 owner 未被新 owner 替换、启动/回执不明或 sidecar 损坏一律 held，保留恢复诊断。仅结构化 pre-admission refusal 才可清除 failed/paused 的 sidecar。节点完成和更换执行 owner 仍归原生引擎所有。
- **未知归属与旧 run**：pending/无 owner/远端 owner/PID 复用返回 held:owner_unknown；未确认接纳返回 held:recovery_admission_unknown，wait exit 3，tick 不自动判终态或投提醒，给出 inspect/显式 abandon 动作。ps 启动时间只用于证实 PID 复用，不凭年龄回收进程。旧 run 没有接纳 marker 时按事实检查；已有 running 节点的自动恢复更保守，需操作员对账，不迁移数据库 schema，不写生产 home。
- **外部效果**：核对实际 land() 后推翻“land 会执行合入”的前提；它只写 land.json 与两条人工合入命令，未执行 merge。运行中 land 的 receipt 必须匹配 checkout branch/head；缺失/不匹配则 held。prompt code/repair/fix、任意 bash/script 验收命令、计数与输出文件写入均可能有外部效果，因此保守挂起所有其他 running 节点；引擎已记录 failed 的节点保留原 retry 契约。显式 --reconciled <snapshot> 绑定当前 run/owner/阶段/节点，提示先核对实际效果并停止幸存节点进程；不把该确认当作自动业务对账证明。
- **selftest 与锁**：abandon 完整 receipt 必须 ok=true、cancelled、action 正确且没有 cleanupWarnings/cascadeFailures；未知启动、非零退出、结构化失败或 warning 保留全部临时树及 stdout/stderr，首次失败不会被退出清理重试覆盖。仅无副作用 fake think 自动确认 snapshot；真实模型的禁工具提示不证明效果已结清，未对账即 held/保留 scratch，不写成功 receipt。stop-gate 由 Bun FFI helper 在 Node 继承的 open-file-description 上 flock；保持同一 inode，finally 只 close，慢 owner 不因 mtime 被夺锁，SIGKILL 由内核释放。
- **测试证据与修正**：真实 Archon 双完整 recover 进程在 CAS 后、新 owner 更新前以屏障交错；第二进程 held，释放屏障后引擎写新 owner。初版 fixture 没有已完成节点，原生 resume 明确拒绝；补无副作用 start 节点后验证实际接纳路径。另测 16 秒慢 Node owner、旧 mtime、双进程锁忙与 SIGKILL释放、land receipt 对账、丢回执的 resume/adoption、旧 DB marker 与新 sidecar、损坏 sidecar，以及七类 selftest 清理结果。首次完整套件 977 pass/14 fail：旧 running fixture 的远端/缺失 owner、pending 启动窗口及恢复桩复用旧 owner 不再符合新契约；补本机活动 owner、由 native wait 到已知结果、桩沿用新执行身份后重跑整套。另修 adoption 切换原始执行回执时遗漏 --json；该次 fake 自检暴露嵌套失败的外层清理风险，现以 LAUNCH_INFLIGHT 保留完整 scratch。验收日志在 /tmp/rec-\*-final.log 与 /tmp/rec-full-rerun-final.log；提交后 verify.json 位于隔离 caller home。
- **遗留与交付边界**：--reconciled 证明操作员确认的观察版本一致，实际第三方效果与幸存子进程仍需操作员核实；未知归属只能显式检查/终止，不能自动安全接管。本包 fence 约束 overlay recover/adoption；并发直接调用原生 Archon resume 未覆盖，原生引擎不消费 overlay marker。真实模型/外部 provider、生产旧 run、独立 G2 评审、主控集成与发布未执行；本包不改 packages、supervisor、launchd 或提醒事项。

- **本包最终本地验收**：wetamp/ 下 bunx tsc --noEmit、bunx eslint src exit 0；timeout 900 bun test exit 0，991 pass/0 fail/3 snapshots，32 文件，446.78s（/tmp/rec-full-rerun-final.log）。最新 scripts/selftest.sh --fake exit 0，receipt ok=true（/tmp/rec-selftest-final.log）；caller SUPERAGENT_HOME=/var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/rec-accept-m5t89_e5/sa，ARCHON_HOME 为其 archon 子目录。bash -n、node --check、diff --check exit 0；提交后在同一 caller home 执行 verify-local --commit HEAD，其绑定提交的结果以 verify.json 为准。

## B1-INT1：GUARD 与 REC 集成

- **问题与被推翻的假设**：两个基于生产基线的包分别维护 hook 状态锁；直接保留两份会让计量与锁身份语义分裂。CLI 第五个恢复参数也分别承载 RCPT 回调与 REC 对账 snapshot，不能按单边签名合并。
- **新语义与冲突处理**：按 GUARD→REC 顺序合入，保留 ADM 准入、controller/worker preflight、RCPT 实际动作回调和 REC fencing；恢复回调与 snapshot 使用不同参数。Stop 保持 advisory，兼容 withState 导出直接引用唯一 hook-state 事务。hook-state 复用 REC 的内核 flock 与稳定 inode，保留 GUARD 严格状态读取、随机原子发布、事件幂等；无 mtime 抢锁或 finally unlink。
- **测试与章节**：未删除双方测试；GUARD 的文件占位锁反例改为真实 Node 持锁 owner，保留旧 mtime、竞争者拒绝、owner 内容及 inode 不变，增加 SIGKILL 后释放验证。安装测试明确稳定锁文件保留。PROGRESS 保留 ACCT、HF10b、ADM、RCPT、GUARD、REC 各完整连续章节，未用 union 交错段落。
- **旧 run/生产影响与遗留**：不新增功能、schema、权限或依赖，不修改 packages。Stop 不恢复旧评审事实源；旧状态继续严格读取，旧锁路径作为稳定 inode 使用，是否持有以内核事实为准。hook 事务沿 REC helper 需要可用 Bun，缺失明确失败；真实 provider、生产运行与外部效果不在本次 fake 验证范围，G2 评审及主控最终验收另行执行。仅本 worktree/分支写入，不 push、不操作其他 worktree 或生产状态。
- **编码端验收**：结果以本次临时 SUPERAGENT_HOME 中的 tsc/full-test/eslint/selftest 日志与提交绑定 verify.json 为准；通过后另列实际退出码与套件统计，不将单包历史记录当本次集成证明。
- **本次完整自检结果**：冻结安装补齐本 worktree 原先缺失的根目录及 wetamp/node_modules，未改 lockfile。`bunx tsc --noEmit && timeout 900 bun test` exit 0，1041 pass/0 fail/3 snapshots，34 文件、297.84s；`bunx eslint src` exit 0，定向 GUARD/REC/hooks 39 pass/0 fail。临时 `SUPERAGENT_HOME=/tmp/b1-int1-accept.AcIS2J` 下 fake selftest exit 0、receipt ok=true/fake=true；完整日志 full-test.log、tsc.log、selftest.log 在同目录，eslint 原始日志 /tmp/int1-eslint.log。提交后同一 home 跑 verify-local --commit HEAD，以 verify.json 的最终 HEAD、ok 与各步退出码独立确认；不把编码端自检冒充独立评审或生产验收。

## REDLINE

- 问题与被推翻的假设：把未知命令、复杂 shell 与范围外新建一概视为危险，导致只读检查、临时构建与测试停摆。废弃“看不懂就拒绝”的白名单路径。
- 新语义：默认放行，集中效果数据表加目标归属判断，只拦确认的销毁/覆盖范围外数据、共享历史、外部写入发布、隐私凭据、越权和再委派。未知普通写入、解析失败和内部异常 advisory；明确删除/覆盖未知目标拒绝。reviewer 可写临时文件和运行测试，不可改被审仓库或提交。
- 记录与契约：advisory 在 guard stdout 的 `systemMessage`（provider 会话 hook 输出）查看，不挂起、不发提醒；拒绝用三段人话，现有 `error_class=redline` 契约不变，不新增状态或配置开关。
- 旧 run/生产：hooks 使用配置当前指向的代码，旧 run 也受其策略影响；三个命令模板增加 AGENTS.md 命令规则提醒并改变 engine identity。仅本包 worktree 交付，未部署生产；B1 集成的 GUARD A-09 冲突以本包默认放行为准。
- 遗留：解释器和脚本内部间接效果仍是尽力识别；真实 provider、现有更严格 reviewer sandbox 的临时写入权限及 G2 独立评审由主控集成验收。本包只做编码与自检。
- 本包自检：tsc exit 0；eslint src exit 0；完整 bun test 886 pass / 0 fail、3 snapshots（410.93s）。卡片放行 9 项、拦截 12 项及陌生命令归属断言均通过；补测缺失解析器仍拒绝明确危险、内部异常 advisory、按端口经 xargs 发信号拒绝。隔离 home 的 selftest --fake 回执 ok:true；提交后 verify-local 以绑定新 HEAD 的 verify.json 为准。workflow golden 语义无变化，三个 command 模板均已纳入 engine identity 回归。src 净增 0，packages 受跟踪文件零改动。

## B1-EV：EV1 / EV1b / EV2 与 HF10 生产基线重新集成

- **问题与被推翻的假设 / I3、I7、P3**：EV 分支停在 HF5c/HF7 基线；无文本冲突不代表生成身份、作业生命周期与投影仍相容。尤其 engine.json 的两次写入会让后写的经验元数据覆盖 HF10 workflow_hash；300ms 查询能稳定预热缓存、无心跳 running 夹具仍是活动行、记忆单测可在默认 5 秒内重复启动完整 Archon 校验，均不是可靠前提。
- **合并裁决 / P4**：在 wetamp-ev 合并 f9394a60，4 个冲突文件逐项处理：PROGRESS 保留 EV 和生产两侧历史；App 保留 EV 活任务树、预算显示和 fmtTokens，但常驻退出使用生产 residentHash；CLI Ledger 同时保留 plan_lint 与 workflow_hash，HF8 作业中断/巡检解耦、HF9 标题白名单、HF10 包/里程碑计数和恢复、ORCA1 同步均沿用生产实现；generate 同时导入 injectMemory 与 attemptPath，并在注入后一次写入 engine_hash/workflow_hash/fake/lessons，避免覆盖身份。未修改 Archon packages。
- **冻结 / 现读边界 / I3**：memory.ts 的检索、预算内注入与 board/workflow.ts 的 nodeRole 会改变生成的 briefs、commands 和 YAML，故纳入 engineHash；residentHash 仍复用同一 owner，以 engineHash 为 seed 并遍历 src。memory-reflect.ts 与 web/memory.ts 在执行时现读，只改变 resident 身份；templates/memory-reflect.md 是反思时读取的提示，不改变两类身份。SUPERAGENT_HOME 下的经验数据不进入源码身份；生成物的 lessons 显式记录命中。文件敏感性回归逐项证明该分类。memory.ts 同时拥有采集/统计代码，当前按文件保守冻结，纯采集代码改动也会改变 workflow 身份，不拆新模块扩大本包范围。
- **确定性测试 / I6、P4**：board 挂起查询测试只控制 300ms 查询计时器，先等待成功缓存，再等记录的挂起 child PID 就绪，显式触发原超时回调，核验 stale=true、旧 running 状态和整组子进程回收；失败清理使用 AbortController，不增加期限或 sleep 延迟。ORCA 夹具补原生状态/心跳，时间与 token 无关变化保持新鲜，另覆盖活性满 10 分钟后更新状态且不改已读标记。记忆注入单测使用只接受 validate workflows 的桩，真实 Archon 校验仍由 generate.test.ts 与 fake selftest 验证。
- **旧 run / 生产影响与边界**：没有迁移或修改任何生产台账、提醒、launchd 或控制台。将来集成后常驻读取新投影，新增生成期依赖使工作流身份变化；旧 run 恢复仍按 HF10 原规则判断 resume/adopt，运行中不换封印、completed 不重跑。记忆写入仍仅 SUPERAGENT_HOME/memory，私有项目不反思，Web/Ink 对引擎状态只读；不写共享记忆、不发真实云端反思、不执行经验晋升。
- **遗留**：真实反思 provider 用量校准、真机像素、独立评审、主控集成验收与发布仍由主控负责；本包只交编码与隔离自检。
- **完整验收**：同一隔离 home `/tmp/b1-ev-accept.bDAu0q` 下，`bunx tsc --noEmit && timeout 900 bun test` 最终 exit 0，1017 pass / 0 fail / 6 snapshots，32 文件、424.49s（`full-final.log`）；`bunx eslint src` exit 0（`lint-final.log`），暂存 diff --check exit 0。首次完整测试 1015 pass / 2 fail，两项仅默认 5000ms 超时：S4 registry mirror 与 CLI budget yes；原代码单跑 2 pass / 0 fail（`timeout-recheck.log`），再整套重跑全绿，未增加单测超时。记忆与 ORCA 定向 47 pass / 0 fail（`focused-final.log`）。
- **fake 自检与提交后闸门**：串行 `bash scripts/selftest.sh --fake` exit 0，`selftest-fake.json` 的 ok=true / fake=true（`selftest.log`），回执绑定提交前 HEAD；fake 回执不冒充真实 provider 校准。提交后在同一调用方临时 home 执行 `bash scripts/verify-local.sh --commit HEAD --timeout 900`，其最终结果以绑定提交的 `verify.json` 与 `verify-local.log` 为准；脚本只操作自建隔离副本，未亲手清理 worktree。独立评审与主控验收留给批次集成。
- **提交后负载修正**：首个合并提交 `98c1c61d` 的 verify-local 为 1016 pass / 1 fail（472.71s），唯一失败仍是预算/评审组合测试的 5000ms 超时，发生在第三次 sa-check 子进程，exitCode=null。该测试原来四次初始化并 clone 独立 git 仓库，再校验无关评审恢复；单跑和一次整套通过未证明负载下稳定。预算校验复用同一干净仓库，评审计数另列独立测试，所有行为断言和默认超时不变。修正后定向 2 pass / 0 fail，预算 1506.69ms、评审 393.87ms（`budget-focused.log`）；新 HEAD 的 verify-local 从冻结安装起完整重跑，保留首轮失败日志，不改失败缓存。

## B1-INT2a：REDLINE 与 EV 集成

- **问题与被推翻的假设 / I3、I7、I8、P3**：GUARD 的“解析/计量失败即拒绝”与用户已定 REDLINE 放宽策略冲突；把 REDLINE 的旧 Stop 调用、旧状态事务带回会恢复第二套评审事实源。EV 的无文本冲突也不能证明 ADM 准入、REC fencing 与 workflow/resident 身份仍相容。
- **新语义与冲突处理 / P4**：依次合入 wetamp-redline@e97cdeaf、wetamp-ev@4112518d，各有四个冲突。REDLINE 的 guard/redline/护栏文档/PROGRESS 统一为效果与归属判定、三段式拒绝与 advisory 放行；明确危险且目标未知仍拒绝。只保留一份效果表，G-1 的 shell 目标识别直接派生自 redline.effects，不保留旧 shellWrites 名单或 writeRoots/Stop 指纹路径。GUARD 的 isChild、Stop advisory、withState/once、REC 内核锁、随机原子发布与安装模式报告均保留。EV 的 archon/cli/generate/PROGRESS 保留 REC 导入及恢复参数、ADM admission/finally release、mode、plan_lint，engine.json 在 injectMemory 后只写一次，保留 engine_hash/workflow_hash/fake/lessons。
- **A-09 用例逐项裁决**：hooks.test.ts 的 shell 代码输出/未知落点/畸形编辑用例改为放行，并核验 advisory：echo/tee/touch/cp/sed/内联 node、动态 TARGET、未闭引号；invalid apply_patch、缺 old/new 的 Edit、缺 session/transcript 身份、缺 shell 文本均 advisory。坏 JSON 与 NaN micro 状态放行并保留原始状态不变；null payload 的主入口异常从 exit 2/deny 改为 exit 0/advisory。另将本任务 build 子目录删除的 G-1 fail-closed 断言改为 advisory，任务根/home 删除继续拒绝。A-08 改为直接验证 isChild/derivedBy 的 child metadata 与两端实际拒绝，避免把机器身份码要求塞入三段人话，其他身份/幂等/事务测试不削弱。
- **EV 与生产契约**：保留 EV1/EV1b/EV2 全部功能与 board 挂起查询的受控计时器回归；新生成依赖 memory.ts/board/workflow.ts 冻结进 engineHash，反思与 Web 投影执行时现读，常驻仍用 residentHash。ACCT 验收预算、HF10b attempt 计数、RCPT 答复回执、HF8 作业中断/巡检解耦、HF9 提醒标题白名单、ORCA1 投影保持。未引入新状态、配置、依赖或 schema；packages 零改动。
- **旧 run/生产与遗留**：现指向代码的 hooks 将采用新策略，模板/记忆注入改变生成身份；旧 run 仍按 HF10 resume/adopt 判断，运行中不改封印、completed 不重跑。经验只落 SUPERAGENT_HOME，不写共享记忆。本包未 push、部署、操作生产台账/监督者/提醒/其他 worktree；POLICY、COORD 留后卡。真实 provider、reviewer 原生沙箱临时写权限、G2 独立评审与主控实测未覆盖。提交 hook 自动运行其既有 prettier/eslint，只作用于本次明确暂存文件。
- **编码端验证**：以 /tmp/b1-int2a-accept.UVuI84 的 selftest/verify.json、/tmp/int2a-full-test.log、/tmp/int2a-tsc.log 及定向日志为本次证据；提交绑定闸门必须独立核验 ok、commit 与每步 exit，不把历史单包绿冒充本次集成或独立评审。
- **本次完整自检**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，992 pass/0 fail/6 snapshots，36 文件、420.70s；`bunx eslint src` exit 0。EV/board/生成器定向104 pass/0 fail，强化后的 A-09 定向2 pass/0 fail。fake selftest exit 0，selftest-fake.json 独立核验 ok=true/fake=true，G-1 31行与派生 Agent 均 deny。最终提交后在同一隔离 home 跑 verify-local --commit HEAD --timeout 900，最终结果只认绑定该提交的 verify.json 与脚本退出码。
- **提交后负载修正**：`4c4933dd` 的首轮 verify-local exit 1（990 pass/2 fail/6 snapshots，645.47s），HF10b 两个真实模式评审计数用例在 5000ms 后被 Bun 杀掉子进程，错误输出为空；原代码单跑 12 pass/0 fail（35.54s）。被推翻的假设是一次测试中的六次 Bash→Bun 启动可稳定共用默认 5 秒预算。现将 12 个节点各自的 missing/0/7/NaN/-1/directory 六种状态拆为 72 个独立执行用例，保留全部成功值、非零退出、invalid attempt counter/EISDIR 和空 stdout 断言，不增加超时、不改生成器或运行语义。拆分后定向 72 pass/0 fail（34.85s），tsc 与 eslint src exit 0；首轮失败日志及 verify-first-failure.json 保留在同一隔离 home，完整复跑及新提交闸门另列结果。
- **负载修正后完整自检**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，1052 pass/0 fail/6 snapshots，36 文件、446.26s（/tmp/int2a-full-final.log、/tmp/int2a-tsc-final.log）；`bunx eslint src` exit 0（/tmp/int2a-eslint-final.log）。测试数量增加 60 是上述状态拆分，不新增产品行为。提交后同一隔离 home 的 verify-local 将从冻结安装起完整验证新 HEAD，结果以新提交绑定回执为准。

## B1-FIXA：辅助进程终止、启动准入与答复崩溃对账

- **问题与被推翻的假设**：ACCT-R1-1 的单进程 TERM timeout 不能约束忽略信号或持管道的后代；ADM-R1-01 的父 CLI 锁释放不能证明 Archon 子进程停止创建 pending；RCPT-R1-01 的动作后持久化不能覆盖取消成功后立即退出。早期屏障桩误停在 workflow validate，已改为只阻塞真实启动的 workflow run；该旧桩不能证明子进程锁继承行为。
- **新语义 / ACCT**：共享辅助预算与调用次数不变，复用控制面已有 Python3 stdlib watchdog，启动独立进程组并拥有输出管道；TERM、宽限、KILL 与管道回收都在预算内，超时 exit 124 保留原 stderr 与终止错误。外层仍有共享预算的 SIGKILL 上界；真实 post-checkout hook 后代与忽略 TERM 桩均验证实际耗时、失败证据及 PID 已退出。
- **新语义 / ADM**：共享锁内先原子发布 run-admission.json 启动意图；启动 shell 在 exec Archon 前登记自身 pid/pid_start，exec 保持 PID。父 CLI 死亡后未知/活动身份仍占位；下一受理仅在本机子进程已确认死亡时删除占位，再读取引擎非终态计数。PID 复用不自动回收，缺失或未知身份明确 admission_busy，需操作者核对后处理；不按计时器释放容量，不新增配置或数据库 schema。
- **新语义 / RCPT**：引擎动作前持久化原 ask occurrence、答复、节点和引擎 run；确认回调先记录实际效果再消费答复。重启时先对账再分类终态：取消事实补 reject 回执，已持久化确认补原动作回执；未确认效果明确 decision_effect_unknown 并停止自动重放。仅 busy 或结构化 executed:false 的恢复拒绝可清除未执行意图并重试。
- **测试与验收证据**：新增 killed CLI/pre-pending child 双进程屏障、未知/活动占位保留与确认死亡清理；取消崩溃桩在第一次效果落盘前退出，再次 tick 只依据 cancelled 引擎事实补回执。ACCT 定向 10 pass/0 fail，CLI 定向 18 pass/0 fail；最终完整容量矩阵 exit 0、ok=true（141101ms，capacity=6，20 并发 1 受理/19 拒绝、满额拒绝、失败启动后再受理、continuation 36062ms completed、受理 run 无 cancelled），原始证据 /tmp/b1-fixa-accept.DT9drJ/matrix-final.json。完整 tsc/test、eslint 与 fake 自检日志在 /tmp/b1-fixa-accept.DT9drJ；提交后同一调用方 home 跑 verify-local，最终以绑定 HEAD 的 verify.json 为准。
- **旧 run/生产影响与遗留**：旧 asks 无 decision 继续原回执语义，历史遗漏无法凭空补成功；既有 run 不迁移、不取消，旧生成脚本保持冻结，重新生成后才使用新 watchdog。直接 Archon 入口、脱离进程组的后代及操作者未知效果对账仍在既有边界外；本包不改 packages/hooks、生产 home、supervisor 或提醒事项。不新增安装依赖，运行该辅助路径需要已有 python3。真实通知投递、provider、独立 G2 复审、主控集成验收及生产发布未执行。

- **本包完整编码自检**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，1049 pass/0 fail/3 snapshots、34 文件、469.09s（full-test.log）；`bunx eslint src` exit 0。最新 fake 自检 exit 0，selftest-fake.json 独立确认 ok=true/fake=true；加强后的取消崩溃回归在首次动作效果落盘前退出，1 pass/0 fail（crash-before-effect.log）。提交后同一 home 的 verify-local 会再次检查最终提交产物，不以未提交 selftest 的旧 HEAD 字段冒充提交验收。

- **提交后验收发现与修正**：首提交 53826635 的 verify-local 在 tsc 阶段 exit 2；加强崩溃测试新增的 decision.effect 直接访问超出了既有夹具返回类型。改为 not.toHaveProperty 属性断言，仍验证效果尚未持久化；产品源码不变。首失败回执与日志保留在同一 home，修正提交重新执行最终 HEAD 的完整 verify-local，不复用首提交结果。

## B1-FIXB：RV-B 的 REC-R1-01、GUARD-R1-01、GUARD-R1-02

- **问题与被推翻的假设**：真实 provider 被杀后，禁止工具的提示不能证明外部效果已结清，recover 必须 held；让正式 selftest 必经该路径会卡住默认 run 和升级后的重新自检。SUPERAGENT_HOME、ARCHON_HOME 和 launchd 目录隔离也不等于安装台账隔离，新增 install.json 位于 XDG_STATE_HOME。Stop 有输出不等于拒绝，advisory/cycle/change 的 systemMessage 都是合法提示。
- **新语义**：正式 selftest 先运行独立 sa-provider，让 provider 正常完成并由下游 bash 检查结构化 pong；故障恢复始终只打断已知无外部写入的确定性 bash，按当前 snapshot 显式对账。--fake 仍只写 selftest-fake.json，正式 selftest 才写 selftest.json，HEAD/config/TTL 绑定与未知效果 held 保持。升级 HEAD 或调用方配置后，重新运行 scripts/selftest.sh（不带 --fake）；preflight 继续给出该重检入口。不增加配置开关或 schema。
- **状态隔离**：selftest.sh 与 verify-local.sh 各自在自己创建的 scratch 中导出 XDG_STATE_HOME，所有安装、测试及子进程继承该目录。补齐 recovery、CLI 及 HF10 安装 fixture 的 XDG 隔离；已有 install fixture 的临时 HOME/default state 或显式 XDG 路径保持。调用方 install.json 通过内部字节比较和存在性断言保证未写入；verify-local 的桩在 install/tsc/test/selftest 每步模拟台账写入，断言都落在 scratch。
- **Stop 探针**：使用 subprocess exit 与结构化 JSON 的拒绝字段判断失败，空输出及 advisory systemMessage 可通过；非零退出、坏 JSON、ok=false、block/continue=false/permissionDecision=deny 明确失败，台账不发布。安装与重复安装覆盖 advisory/cycle/change，保持台账字节幂等和用户字段。
- **回归与旧 run/生产影响**：REC-R1-01 端到端用真实 Archon + 测试 provider 边界桩执行正式 selftest，生成 fake=false 回执，然后 run --fake 不带 --skip-selftest，继续完成修复/签收/land 契约；未把桩当真实模型验证。生产 run、旧回执、未知效果及 owner fencing 无迁移或权限扩大，不改 packages、全局用户状态、supervisor、launchd、提醒事项。src 净增 0。独立 G2 复审、主控实测和真实 provider 尚由主控执行。
- **已验证与剩余验收**：首批定向 4 pass/0 fail（/tmp/fixb-focused.log），tsc、eslint src、bash -n exit 0；指定五文件测试、完整套件、fake selftest 和提交后 verify-local 的最终结果按后续实际日志/回执补齐，不复用历史包的结果。
- **首轮指定测试**：292 pass/2 fail，391.17s（/tmp/fixb-required.log）；两个既有 CLI 用例 held:environment backoff 与 budget/review allowance 均触发默认5秒超时，单独原样重跑2 pass/0 fail、7.46s（/tmp/fixb-timeouts.log），未放宽超时。新增正式回执端到端通过（98.53s）。独立 fake selftest exit 0，HF3 adoption completed，回执 ok=true/fake=true（/tmp/fixb-selftest.log；/tmp/b1-fixb-accept.YM8Tfv/selftest-fake.json）；最终 tsc 复跑 exit 0。
- **指定测试最终结果**：按卡原命令重跑五文件，exit 0，294 pass/0 fail、2174 assertions、298.41s（/tmp/fixb-required-final.log）；正式回执端到端89.03s通过，两项原超时用例在整组复跑中通过。完整套件随后执行，提交后 verify-local 的 HEAD 绑定以实际 verify.json 为准。
- **完整自检最终结果**：wetamp/ 下 bunx tsc --noEmit && timeout 900 bun test exit 0，1042 pass/0 fail/3 snapshots、5552 assertions、34文件、478.60s（/tmp/fixb-full.log）；eslint src、bash -n、diff --check exit 0，src 净增0、packages 零 diff。提交后在同一调用方 /tmp/b1-fixb-accept.YM8Tfv 执行 verify-local --commit HEAD --timeout 900（全套实耗478.60s，加安装/tsc/selftest后不应挤入默认600s）；最终 commit/ok/steps 以该目录 verify.json 独立核验，未将编码端绿冒充独立评审、真实 provider 或生产验收。

### B1-POLICY：冻结策略、单厂商路由与 same-diff 收口（编码与自检）

- **问题与被推翻的假设**：候选池和 reviewer-alt 别名不等于执行回退；`policy.json` 的风险子集也不等于完整执行策略。相同 diff 不能单独证明评审可复用，必须同时证明 candidate、验收契约和评审资格。
- **策略与路由**：`resolveRoute` 统一角色、风险、轮次、mode 与作者排除；`single:claude`/`single:chatgpt` 的 code/repair/fix/review 节点均落在指定厂商，G0 使用对应风险池。无候选或未知 mode 明确拒绝；实际模型独立性继续由 Archon binding 与 gate 核验，strict/G2 与既有 DEGRADED_PASS 语义保留。生成的 repo config 与 run-config 由同一字符串产出，使校验与执行解析同一组别名。
- **A-12**：生成主体只解析一次 tiers，完整 `policy` 加 routing/health 脱离原对象后计算 canonical SHA-256；`engine.json.policy_hash` 留证且 hash 纳入 workflow identity，HF10 原冻结清单保留。生成的 Codex 包装器钉住 `SA_POLICY_PATH`；worker/proxy 只读并校验该快照，缺失/被篡改即拒绝启动，不回读 live tiers。原生 provider settings、hook trust 与执行代码仍按既有契约动态读取。
- **A-04**：仅在同 HEAD、diff hash、验收契约 hash、有效风险，当前验收 advance，旧 review PASS、身份已证实且 ledger/review 无 open/debt 时复用。契约绑定 plan（含验收与环境声明）、包/范围、base、风险声明与 policy 内容；缺失旧证据、身份不明、同模型、风险升级、债务均保持 no_change。真实 sa-check subprocess 回归覆盖验收由红转绿以及契约/身份漂移拒绝。
- **A-13**：启动、loadPlan 与 generate 拒绝有效 `DATABASE_URL`，按 Archon 的 shell→home `.env`→repo `.archon/.env` 优先级解析，不输出 DSN；SQLite-only 拒绝信息明确。测试只使用 scratch/dummy DSN。
- **旧 run/生产影响**：生成身份已变，旧 run 须通过既有 adopt 流程重新生成；旧 gen 缺少完整 policy 与包装器时新 worker 明确失败，不隐式套用新 tiers。未改生产 checkout、生产 home、supervisor、launchd 或模型名单；本包自检只使用临时 home 与 fake 节点。
- **遗留/范围冲突**：F-15 typed-failure 跨模型/跨厂商执行回退、cooldown、reviewer-alt 消费及回退总预算未实现；真实唯一执行边界在 `packages/`，卡片禁止改。A-06 advisory 键与提示消费者在 `hooks/context-budget.cjs`，同样不在批准路径，故保留实际 `autocompact_tokens` 键且类型明确其仅为 advisory，避免单改 tiers 令 hook 静默回落。`schemas/plan.schema.json` 的 single-mode description 仍旧，待主控协调同步；不把候选路由测试冒充回退/cooldown 验收。
- **验证**：`cd wetamp && bunx tsc --noEmit`、`bunx eslint src`、`git diff --check` 均 exit 0；`timeout 900 bun test` exit 0，985 pass/0 fail/3 snapshots，31 文件，428.46s（`/tmp/b1-policy-full-final.log`）。随后补齐 same-diff 复用的 PASS 归档，真实 subprocess 定向回归 1 pass/0 fail、8 assertions、exit 0（`/tmp/b1-policy-same-final.log`）。串行 `scripts/selftest.sh --fake` exit 0（`/tmp/b1-policy-selftest.log`），临时 home `/tmp/b1-policy-home.Hz1NjJ/selftest-fake.json` 的 ok=true、fake=true。提交后同一 home 的 `verify.json` 绑定最终 HEAD，在隔离 worktree 重跑安装、tsc、完整测试与 fake 自检；本记录写入时该提交后验收尚未运行，以回执和最终交付结论为准。独立评审、主控验收与上线均未进行。

### B1-POLICY2：类型化执行回退与 context advisory（编码与自检）

- **问题与被推翻的假设**：冻结候选池不等于执行回退；不能因 Archon 的执行边界在 packages/ 就断言 wetamp 无法兑现策略。wetamp 的 Archon 入口在保留原生 provider registration/config/credential parser 的前提下包装公开 factory；生成配置显式传入冻结 `SA_POLICY_PATH`，唯一 provider 调用边界消费策略。
- **F-15**：只根据结构化 `misconfigured`、`overloaded`、`quota_exhausted` 回退，不解析厂商文案；按冻结池顺序尝试，分别以命名常量冷却 24h/120s/1h，同 run 的 artifacts 持久化并跨节点跳过。现有 `misconfigured` 同时涵盖未知模型与其他配置失败，契约未提供更细分类，本包不伪造模型不存在子类。非类型化错误、auth/transient/unknown 与 throw 不触发回退。
- **独立性与边界**：review 排除本 run 的已记录作者请求/回执模型，请求评审模型与作者相同则优先 reviewer-alt 的跨厂商候选；无合格候选明确失败。跨模型不复用前一个 session，跨厂商移除原 provider 的 protected env 并使用目标厂商冻结 native assistant config；重新落实 Claude denied_tools/sandbox 与 Codex readonly MCP。runtime 仅只读查询与 cwd、running、当前 owner PID 唯一匹配的 SQLite run，不凭最新记录或时间猜所有权。
- **预算与证据**：每次 dispatch 前先持久化 started reservation；下一次调用前检查总 launch 和 weighted token 预算。所有结果及回退尝试累加用量，缺用量按既有 floor/已知最大单次预留；预算耗尽返回 typed budget_exceeded，evidence 包含 node/usage/limits。sa-check gate、budget 和 CLI 预算问题共用 attempts，不重复计 engine 的同节点事件；损坏记录拒绝读取。engine binding 仍是原请求，实际回退身份留在 policy-attempts；provider resolved 回执优先，Codex 无回执为 pinned，Claude 无回执为 unknown，后者不冒充合格独立评审。
- **A-06**：当前 tiers/type/handler/install/docs 统一 `advisory_tokens`、`context-advisory.cjs` 与 advisory 文案，只提示、不阻塞、不自动 compact。已安装的旧 context-budget 路径保留转发兼容，install-hooks 归一迁移到 advisory；历史 PROGRESS 与发现快照保留原文。
- **旧 run/生产影响与遗留**：生成配置、模板与策略快照变更进入既有 workflow identity，旧 run 仍需既有 adopt 重新生成；旧 policy 的原键不隐式适配。cooldown 限同一 run，不新增全局模型健康机制或配置。`packages/` schema 文案按卡未改，留给主控协调；上轮 wetamp plan schema 的 single-mode description 债务仍保留。本包不触碰生产 home/checkout、supervisor、launchd；未调用真实模型，不把 fake/fixture 成功当生产能力确认。独立评审、主控验收和上线均待主控处理。
- **验证**：最终定向 policy-executor 回归 11 pass/0 fail/60 assertions，含三类 typed failure、cooldown/到期、reviewer-alt、跨厂商编码回退、预算拒绝、非类型化失败与损坏记录；tsc/eslint src exit 0（`/tmp/b1-policy2-focused-extra.log`）。完整套件、fake selftest 与提交绑定 verify-local 在下方补记，日志及回执放临时 home，不入仓库。
- **最终完整验证**：`cd wetamp && bunx tsc --noEmit && bunx eslint src && timeout 900 bun test` exit 0；996 pass/0 fail/3 snapshots、4954 assertions、32 文件、333.23s（`/tmp/b1-policy2-full-final.log`）。第一次完整批次为 993 pass/1 fail（I5 settle 证据用例），期间源文件仍在修改，不把该批次计为通过；源码稳定后单跑该用例 1 pass/0 fail（`/tmp/b1-policy2-i5-recheck.log`），并重跑完整套件全绿，未改该用例或其生产逻辑。提交前 fake 与提交后隔离验证共用 `/tmp/b1-policy2-home.uzzbmj58`，最终以其 selftest-fake.json 与绑定 HEAD 的 verify.json 为准。
- **fake 自检**：`SUPERAGENT_HOME=/tmp/b1-policy2-home.uzzbmj58 bash scripts/selftest.sh --fake` exit 0；回执 ok=true/fake=true，owner-loss recover、signal、abandon、HF3 adopt 与 hooks G1/N1 全部通过。此提交前回执 head=50a6c191；提交后 verify-local 会在同一调用方 home 生成隔离验证回执，绑定本包提交且再次重跑 install/tsc/full test/fake selftest。

### B1-FIXE：POLICY R1 五项修复（编码与自检）

- **裁决 / F-15 / 被推翻的假设**：节点包装器承担跨厂商切换会越过凭据、准入和 session 的所有权边界。同一节点现在仅消费原厂商的冻结模型池、cooldown 和总预算；跨厂商切换交给引擎已有熔断、改派、held 路径，不新增状态或配置。池耗尽返回原类型化失败；原厂商无合格模型则返回明确 misconfigured，不能暗换厂商。此裁决替代上方 POLICY2 的跨厂商回退描述。
- **POLICY-R1-01/02（blocker/high）**：删除跨厂商凭据剥离、assistant config/只读配置重构和原始 factory 回退调用；所有尝试复用同一个 native sendQuery 与外层原厂商准入槽位。env、protectedEnvKeys、原生配置与权限原样保留，包含 GH_TOKEN 的空值覆盖。真实 scratch 子进程验证每次尝试环境值一致；槽位回归覆盖整个流只准入/释放一次，跨厂商候选不执行。
- **POLICY-R1-04（high）**：跨模型尝试不传入旧 session；返回模型与引擎请求模型不同（含 resolved 回执不同）时不外传 sessionId/resumed，因此引擎不会将回退会话绑定到原请求模型。cooldown 到期后的下一节点回归证明新开会话。reviewer-alt 排除真实作者，只能在原厂商内选合格候选；需要换厂商时明确失败，交回引擎。
- **POLICY-R1-03（high）**：每次 provider stream 结算后立即按累计实际用量检查预算，包含成功末次调用；超限返回 typed budget_exceeded，保留 tokens 与预算 evidence，并将该尝试记录为 failed。gate 末里程碑 PASS 前同样核验预算；末次已结算 launch 数等于上限可放行，超过 token 上限不得 PASS/进入 land。启动前预留是估算，不能保证单次调用绝对零超额。原 same-diff 测试补齐真实 plan 必需的 budget 和 gate 的 policy 输入，避免旧测试依靠末次 gate 不检查预算。
- **POLICY-R1-05（medium）**：sa-check 的 effectiveRisk 是有效风险唯一计算拥有者；gate 与 runtime 路由共用声明及本轮全部结构化 diff 验收证据。模型池与 effort 同取该值；G0 修改风险路径的 G2 评审及后续轮次不能降级均有回归，不在 runtime 再解析文件路径。
- **旧 run/生产影响与遗留**：模板变更进入既有 workflow identity，旧 run 按已有 adopt 重新生成；执行包装器现读代码。未改 packages/、模型名单或生产 checkout/home，也未操作 supervisor/launchd。既有 schema 文案债务保留；真实厂商、引擎跨厂商改派与生产验收未在本派生会话验证，交由主控。无独立评审或集成上线结论。
- **自检证据**：新增六项故障回归在旧实现全部失败；修复后按卡运行定向四文件、tsc/eslint src、完整 wetamp 测试、临时 home fake selftest，以及提交绑定 verify-local。定向四文件 268 pass/0 fail/617 assertions（21.77s），tsc/eslint src 与 diff --check exit 0；src 相对 d686c66d 净减 4 行，相对批次基线 f9394a60 净增由 295 降到 291。最终结果以 /tmp/b1-fixe-focused.log、/tmp/b1-fixe-full.log 和临时 home /tmp/b1-fixe-home.c1OvLoWT 的 selftest-fake.json/verify.json 为准。
- **完整套件**：`cd wetamp && bunx tsc --noEmit && bunx eslint src && timeout 900 bun test` exit 0；1002 pass/0 fail、32 文件、3 snapshots、4978 assertions，347.49s（/tmp/b1-fixe-full.log）。早期定向批次发现 same-diff 夹具缺少 budget/policy、拒绝换厂商夹具仍有合格 Claude 模型，已补齐夹具；最终定向和完整套件全绿，未改无关生产代码。
- **fake 自检**：`SUPERAGENT_HOME=/tmp/b1-fixe-home.c1OvLoWT ARCHON_HOME=/tmp/b1-fixe-home.c1OvLoWT/archon bash scripts/selftest.sh --fake` exit 0，回执 ok=true/fake=true，恢复、signal、abandon、HF3 adopt 与 G1/N1 hooks 通过（/tmp/b1-fixe-selftest.log）。提交后在同一调用方临时 home 运行 verify-local 绑定新 HEAD；此处不预报结果，以 verify.json 与最终交付为准。

## B1-FIXD：EV R1 返修（2026-10-11）

问题与被推翻的假设：有限正则脱敏不能证明云端输入不含隐私；活性列表为空不代表引擎完成；首次摘要幂等不代表终态永久不变；合法 gate 空评审产物也不能当判定对象读取。强化 I1/I5/I6/I7，按实际生产者与消费边界分别修复。

- EV-R1-01：折叠 finding 只保留 id/severity/status；云端反思只收到显式元数据白名单和已有经验，不发送命令、finding 原文、路径/行号证据、timeline 或 dispositions 正文。旧 episode 即使含原文，边界同样丢弃；新增嵌套 finding evidence、客户资料、日志、命令及旧 evidence 的 fake 输入回归。模板同步说明元数据契约。
- EV-R1-02：cockpit 分开提供 `unfinished` 与小看板活性树；Orca 只有真实终态且无待答问题时才 completed。无事件的 running、queued、owner unknown、治理层挂起均保留 unfinished；小树的十分钟活性过滤不变。回归包含活性到期、queued 和 unknown。
- EV-R1-03：读取判定对象时验证消费字段形状；只有 `*.review.json` 允许 null，其余 null/array 拒绝并按 run 隔离。测试实际运行 gate 生成 null review、decision 和 ledger，随后走完整 tick→archive→memoryData；另测 null/array decision 被拒。
- EV-R1-04：`episodes/<id>.json` 保留首次摘要；`projections/<id>.json` 独立更新最新状态与证据，CLI、反思队列、Web 历史及单 episode JSON 共用投影读取。mechanize 在首次摘要存在时仍独立执行，按签名/episode 去重。回放 paused→failed + engine_suspect，断言旧摘要未改、当前状态已更新、机制化需求存在、反思出队。
- EV-R1-05/06：总 token 展示为 input+output，cacheRead 不再重复相加；预算先验从 `budgetUsage()` 所有者计算，完全无回执保持未知。fold-index v2 一次重建旧总量先验并回填全部终态 run 的交付包数/总 token（包括正常无 episode 的 run），大看板指标只取此完整终态投影，回填前保持未知，不能回退到异常 episode 子样本。缓存高占比五样本回归为 input=100/cacheRead=90/output=10，总量110、weighted p50=20，预算50不误拒；正常 completed 零 episode 仍纳入指标。

旧 run/生产影响：首次摘要文件和旧 lessons 保留，第一次 tick 会只读重查历史终态以重建上述本地派生缓存；未修改 Archon、hooks 或运行中 workflow。全部写入限 Superagent 自有 memory 目录，本包自检只用 scratch home、fake 模型和临时仓库，未操作生产。

遗留债 EV-R1-07（medium，未闭合）：原生 Codex exec 未提供本包可依赖的整次上下文/工具回合 token 硬边界，`model_max_output_tokens=1024` 不能证明总用量≤9216；禁改 packages、禁新增配置且不能伪称事后记账为硬上限。新增 fake usage 超预留回归，明确证实实际11024被全额记账且下一次调用被拦，但当前调用仍可越过日上限9216。需要主控裁决采用提供硬上界的单次 provider 调用契约或禁用无上界的反思通道；本包不宣称 G2 已通过。

编码自检：`bunx tsc --noEmit`、`bunx eslint src` 均 exit 0；四文件定向88 pass/0 fail/3 snapshots（`/tmp/fixd-focused-final.log`），`timeout 900 bun test` 全套1026 pass/0 fail/6 snapshots、32文件、501.13s（`/tmp/fixd-full.log`）。同一隔离 home `/tmp/fixd-home.y8xY4U` 的 `selftest.sh --fake` exit 0、receipt ok=true；提交后 `verify-local.sh --commit HEAD --timeout 900` 的结果以该 home 中绑定提交的 `verify.json` 为准。src净增20行，未修改packages/hooks，不做独立评审或主控集成验收。

## B1-FIXD2：EV-R1-03 生产者可空字段一致性（2026-10-11）

- **问题与被推翻的假设 / I1、I6、P3**：消费字段形状检查不能仅由省略字段的成功夹具证明。sa-check 成功 accept/settle 和 PASS gate 实际写出 `reason:null`，原采集 schema 将其拒绝为 `fold_failed`，跳过摘要折叠和终态缓存登记。
- **新语义 / P4**：reason 接受生产者定义的 string/null/省略，null 不产生失败原因；保留对象形状验证，只有独立 review 文件允许整体 null，decision 的整体 null/array 仍拒绝。不新增配置、状态或生产者定义的手抄副本；以真实生产产物的一致性测试约束消费者 schema。
- **回归与监测**：直接执行 sa-check 产生成功与失败 accept、settle、gate 及 review/ledger 产物，再走 foldEpisode→memoryTick→memoryData，核验验收结果、原因、终态缓存与交付投影；正常成功无异常 episode，失败正常归档，均无 errors.jsonl。原 null/array decision 拒绝回归保留；运行时沿用 memory/errors.jsonl 的 fold_failed 监测点。
- **旧 run / 生产影响**：此前因 schema 拒绝而未登记终态缓存的 run，可在新采集器下一次 tick 正常折叠；不改旧产物、生产目录或运行中 workflow。memory.ts 属 engineHash 的既有冻结输入，本改动会改变后续生成身份；旧封印不热修，恢复沿用现有 adopt 机制。
- **遗留**：本包只关闭 EV-R1-03 的编码与自检；EV-R1-07 原有债保持交主控裁决，不做独立评审或主控集成验收。

编码自检：真实生产者回归先红（成功 reason:null 的 ZodError）后绿；四文件 `90 pass / 0 fail / 3 snapshots`（`/tmp/fixd2-focused.log`），`bunx tsc --noEmit && timeout 900 bun test` 全套 `1028 pass / 0 fail / 6 snapshots`、32 文件、336.21s（`/tmp/fixd2-full.log`），`bunx eslint src` exit 0。隔离 home `/tmp/fixd2-home.QhWT3w` 的 `selftest.sh --fake` exit 0、receipt ok=true（`/tmp/fixd2-selftest.log`）；提交后在同一 home 执行 `verify-local.sh --commit HEAD --timeout 900`，结果以该 home 中绑定提交的 `verify.json` 为准。

## B1-FIXC：RV-C REDLINE R1 修复

- 问题与被推翻的假设：覆盖重定向不是普通写入；eval 不创建子 shell；否定命令不保留原成功/失败状态；未引用 heredoc 不是纯数据；find 的未知 cwd 不意味着命令体没有危险效果；已有 PID 不消除管道追加的按名称选择对象；参数拼法不改变效果，完整 argv 不适合提醒。
- 新语义（REDLINE-R1-01–09）：保留 overwrite 效果，未知危险目标拒绝而普通新建/追加未知目标 advisory；传播父作用域 cwd 并交换否定状态；检查 heredoc 的命令替换与反引号，引用或转义的数据保持放行；分析 find 的全部执行形式，execdir/okdir 相对目标按未知处理；统一长选项取值，按 -C/--git-dir/--work-tree/GIT_DIR 定位 Git 对象，配置写入进入保护类别；在相关管道、命令替换与变量上保留进程选择来源；外发提醒仅含动作和 URL host，不含认证、正文、userinfo 或 query。
- 不变量与复用：强化 I1 的红线边界及 I6 的真实事故回放，复用现有 AST、效果表、三段式提醒和 guard advisory 通道，没有新依赖、配置开关或运行状态。10 个报告探针及每个机制的等价变体纳入 hooks 测试，保留原放行清单、归属通用性及父/子 shell 差分；数字循环变量只在循环体内按数字处理，合流后的不确定赋值保留未知。
- 旧 run/生产影响：hook 判定取当前安装代码，更新后旧会话也受修正影响；error_class=redline 及挂起/告警读者契约不变，advisory 仍在 guard stdout 的 systemMessage 查看。本包只提交 wetamp-redline，没有更新生产配置、触发 supervisor、合并或发布。
- 遗留与验收边界：解释器/外部脚本的间接效果及无法建模的语法仍按原策略 advisory；此包只做编码自检，独立 G2 复审及主控集成实测另行完成。验收回执以本次完整测试、隔离 selftest-fake.json 与提交后同一临时 HOME 的 verify.json 为准。
- 自检：提交前 tsc exit 0、eslint src exit 0；完整 bun test 907 pass / 0 fail（467.37s、3 snapshots），随后新增缺失解析器进程来源回归并单测 1 pass / 0 fail；提交后隔离完整套件 908 pass / 0 fail（385.62s、3 snapshots），最终提交仍由 verify-local 验证。报告 10 个探针全部拒绝，末条提醒不含 FAKE_SECRET；原放行 9 项、拦截 12 项和归属通用性仍绿。隔离 selftest --fake exit 0、ok:true。hooks 净增 184 行，packages/ 与 wetamp/src 零改动。

## B1-FIXC2：RV-C2 REDLINE 遗留收尾

- 问题与被推翻的假设：括号计数无法确定 case 模式中的替换边界；Git 未指定与未知定位不是同一状态；fork 不能丢弃进程选择来源；路径识别成功不代表完整参数可出现在提醒里；mktemp 的可证明临时产出不是任意未知路径。
- 新语义（REDLINE-R1-03/05/07/09/10）：替换边界由既有 shell AST 的 delimiter 节点决定，删除手写括号扫描；未引用 heredoc 的命令替换直接遍历 AST，反引号通过字符串上下文 AST 定位并恢复原正文分析，保留内部引号。Git 的每个定位对象保留未指定/已解析/未知，危险修改拒绝任一未知或非任务对象。管道来源跨 xargs、shell 位置参数、赋值与 fork 传播。所有红线提醒统一出口，仅使用动作、固定路径类别或 URL host，不回显请求参数、正文或动态分支名。
- 临时路径与兼容：直接 mktemp 产出按临时父目录中的生成路径建模，支持 -d、-t、/tmp、TMPDIR 模板与无参数，子路径可写入/覆盖；尊重作用域和命令前缀的 TMPDIR，外部或未知模板、任意其他命令替换及越界子路径仍拒绝。保留原放行九项、command -v、which、明确 PID 信号、xiaopan baseline 原文及 reviewer 临时测试权限。
- 旧 run/生产影响：仅更新当前 worktree 的 hooks、测试与本节；error_class=redline、advisory systemMessage、挂起/告警契约不变，没有新依赖或配置开关，没有修改 packages/ 或 wetamp/src。安装更新后旧会话采用新判定；本包没有部署生产、调用真实 supervisor、合并或发布。
- 验收证据：新增五组探针与等价变体回归；R2 报告探针 5/5 ok，R1 前九条拒绝、末条拒绝且无 FAKE_SECRET；新增回归 5 pass/0 fail，tsc 与 eslint src exit 0，完整套件 913 pass/0 fail（263.45s、3 snapshots），最终 hooks/HF5/HF6 定向回归 157 pass/0 fail（31.17s），隔离 selftest --fake ok:true。hooks 净增 40 行；提交后 verify-local 的结果见交付回执，临时 home 为 /tmp/fixc2-accept.ZkMCSR。
- 遗留：无法建模的解释器/外部脚本间接效果仍按既有策略 advisory；本包只做编码自检，R3 独立评审、主控集成验收与生产更新仍由主控处理。

## B1-FIXC3：RV-C3 三条遗留修复

- 问题与被推翻的假设：xargs 输入不是永远追加的参数，替换模式必须在占位符出现处传播来源；识别到受保护分支不意味着原始 ref 可以进入提醒；mktemp 的组合短选项及临时父目录参数不能按普通位置模板处理。
- 新语义（REDLINE-R1-07/09/10）：复用 wrapper 参数解析，区分 -I、-i、--replace 的替换与默认追加，把生成参数交给 shell 的 $0、$1、$@；没有用到替换输入的明确 PID 命令仍放行。Git 只向现有三段式提醒出口传递“受保护分支”等类别，update-ref、分支操作与 push refspec 不回显 ref。mktemp 先规范化 -dt/-td 等选项束，保留 --tmpdir 可选值的拼法，再按临时父目录和位置模板推导产物归属；外部/未知父目录及越界子路径仍拒绝。
- 不变量与证据：强化 I1 的真实红线边界与 I6 事故回放；三个报告样例及等价变体扩展既有 hooks 回归，FAKE_SECRET 遍历 Git ref 与其他拒绝类别。R1 报告 10/10 拒绝且无秘密、R2 5/5 ok、R3 三变体 3/3 ok，判定器只分析命令字符串。advisory 继续在 guard stdout 的 systemMessage 查看，未新增日志/状态/配置机制。
- 旧 run/生产影响：安装更新后旧会话采用修正后的 hooks；error_class=redline、挂起与告警消费者契约不变。只修改 wetamp-redline 的 hooks、测试和本节，packages/ 与 wetamp/src 零改动；未触发生产 supervisor、提醒、部署、push 或合并。
- 遗留与验收边界：外部脚本及无法建模的语法仍沿用 advisory；本包只做编码与自检，已超过三轮的主控实测与用户裁决由主控完成。本次完整验收与隔离回执在 /tmp/fixc3-accept-2ky9ks32，最终结果见交付回执。
- 提交前自检：tsc 与 eslint src exit 0；完整 bun test 913 pass/0 fail、3 snapshots（318.75s）；隔离 selftest --fake exit 0、ok:true。hooks 净增 25 行，git diff --check 通过；提交后在同一临时 home 运行 verify-local 绑定最终 HEAD。

## B1-FIXC4：临时目录 Git 归属一致性

- 问题与被推翻的假设：mktemp 的临时产物只用于文件写入归属，Git 的位置、检出与 metadata 检查仍只认原 worktree；新建 Git 仓库也被当成未知对象上的危险操作。主控报告三个误拦样例；本次新增回归及 `/tmp/rv-c3-variants.cjs` 中 xiaopan 样例在修改前复现拒绝。
- 新语义：文件写入与 Git 定位共用 `taskOwnership`，AST 拥有并导出临时产物标识判定，生成路径及其子路径、cd 后 cwd、-C、--git-dir、--work-tree、GIT_DIR、GIT_WORK_TREE 均视为任务仓库。普通临时目录仍只是产物范围，既有外部临时仓库的危险操作不因此放行。git init 不因未知或外部定位拒绝；reviewer 修改被审仓库的约束继续生效。
- 不变量与验收：强化 I1、I6 与 P4，复用既有 AST、mktemp 归属、Git 定位三态及三段式提醒，没有新依赖、配置或状态。新增误拦回放、临时 repo add/commit/硬重置与全部定位形式、越界及既有外部 repo 反例；R1/R2/R3 探针保持原期望。运行时仍通过 guard 的 deny / advisory 通道观察。
- 旧 run/生产影响：安装更新后旧会话也采用新 hooks，error_class=redline 与消费者契约不变；仅本 worktree 的 hooks、测试与本节改动，不操作生产、supervisor、提醒、合并或发布。
- 遗留与证据边界：解释器/外部脚本间接效果继续按既有策略处理；本卡按主控裁决只编码与自检，不再派生或评审，主控实测及带债合入由主控执行。验收日志及隔离 selftest / 提交后 verify-local 回执在 `/tmp/fixc4-accept-4t5jr02l`。
- 提交前自检：tsc、eslint src 与 hooks 语法检查 exit 0；hooks 73 pass/0 fail，最终 FIXC4 定向回归 25 个断言通过；完整 bun test 914 pass/0 fail、3 snapshots（266.91s）。R1 10/10 拒绝且无秘密、R2 5/5、R3 11/11 符合期望；隔离 selftest --fake exit 0、ok:true。hooks 净增 10 行、diff --check 通过，提交后 verify-local 在同一临时 home 绑定 HEAD。

## B1-FIXC5：嵌套检出的 Git 归属回归

- 问题与被推翻的假设：FIXC4 把文件的路径包含关系当作 Git 检出身份，主检出内的另一个 worktree、clone 或子模块因此获得 Git 写入权限；在旧实现上新增回归首先复现嵌套 clone 的硬重置被放行。
- 新语义：仍由单一 `taskOwnership` 判定归属；文件写入保持原语义，Git 只认任务检出本身及其精确 `.git`/gitdir 元数据身份。检出内普通子目录仍属于该检出，嵌套检出及主仓 `.git` 下其他 worktree/子模块的元数据不属于任务；AST 已证明的 mktemp 临时产物继续放行，既有临时仓库不继承权限。
- 不变量与复用：强化 I1 的红线边界、I6 事故回放与 P4 单一来源；复用 `checkoutOf`、真实路径解析、`.git` 原生 gitdir 和 AST 临时产物标识，没有新增依赖、配置或状态。测试以 scratch clone、嵌套 worktree 和 gitdir 文件复现 -C/cd 两种定位及 metadata/env 等价变体；监测仍使用 guard deny/advisory 通道。
- 旧 run/生产影响：安装更新后旧会话采用修正后的 Git 判定，error_class=redline 与消费者契约保持不变；本包只修改指定 worktree 的 hooks、测试与本节，未修改 packages/、生产 checkout、生产台账、supervisor 或提醒事项，未合并、push 或部署。
- 自检证据：新增回归在修复前失败、修复后通过；FIXC4/FIXC5 与 Git 定位定向回归 5 pass/0 fail、128 断言，主控提供的 `/tmp/rv-c3-variants.cjs` 11/11 符合预期且 exit 0；hooks 净增 7 行。完整套件与隔离 selftest、提交后同一临时 home 的 verify-local 回执保存在 `/tmp/fixc5-accept.sZ4JnM`，最终结果见本次交付回执。
- 提交前验收：tsc、eslint src、hooks 语法检查与 diff --check exit 0；hooks 74 pass/0 fail，完整 bun test 915 pass/0 fail、3 snapshots（266.90s），隔离 selftest --fake exit 0、ok:true。提交后 verify-local 在同一临时 home 绑定最终 HEAD。
- 遗留与验收边界：解释器/外部脚本间接效果仍按既有策略处理；卡片要求只做编码与自检，不再委派或评审，后续主控实测由主控执行。

## COORD：跨元帅归属与交接（B1 编码包）

- **问题与被推翻的假设**：launcher 只是启动证据，不会自动限制其他控制台；心跳过期也不能证明 owner 死亡。引擎工作树哈希不是可复用、可审计的已提交换版来源。新增仓库/run scope、显式 claim/history/generation、lease fencing、handoff/inbox 和 supervisor 答案 fencing。PID/start/host 的三态验证由 identity.cjs 同时供 board 与控制面消费；CJS owner resolver 同时供 CLI 与只读 hook 使用。
- **新语义**：run 自动认领，变更入口包括未登记 Archon run 都校验归属。显式释放防止旧 run 复活，旧 ledger 回退 launcher；歧义归属要求用户原话 takeover，并通知全部旧 owner。supervise-tick 不再处置缺 controller/launcher 的 run；旧身份和旧 generation 被拒，动作携带实际 controller/generation。在线 wait 每秒检查 inbox，hook 只提示一次；离线积压跟随 scope，urgent/held 升级，unknown 只升级、不自动接管。no/expired 延迟一轮并使用新提问 key，避免旧 no 重复消费。提醒不含自由标题、正文或路径。
- **边界与生产影响**：引擎没有仓库特例，元帅直接越权 Edit/Write/明确 shell 写入被提示 handoff；读取来源仓库和不确定的脚本不新增拦截。派生写入继续由已有护栏负责。terminal adopt/retry 前后验证引擎干净且已提交，adoptions.engine_commit 保存 SHA；scratch HF3 自检同样先提交模板变化再实际 adopt，不能用脏树绕过。字段均 additive，数据库与 packages/ 零改动；旧二进制可以读取新字段，但不执行新版 fencing，需要集成后统一运行新版。无身份旧 run 需 claim 加显式 resume/decide 建立 controller。
- **设计与规则**：[设计文档](2026-10-11-cross-controller-coordination.md)、README 与 CLI usage 登记五个新命令。Orca pane 元数据已记录，未实现可选主动 pane 投递：现有 Orca CLI 看板适配不能保证外部会话 mailbox 投递，核心 wait/hook/supervisor 不依赖 Orca。共享真文件未修改；指定 `~/.superagent/cards/batch1/coord-shared-rule.patch` 写入被执行层红线拒绝，改以 [仓库内补丁](coord-shared-rule.patch) 交主控复制，对真实共享协议 `git apply --check` exit 0。
- **自检过程**：定向 COORD/HF10/hooks 43 pass、0 fail（`/tmp/coord-focused-final.log`）。首个全套暴露 controller 的 additive generation 使整对象 lease key 失配，以及一项 hook 在并发负载下超时；失配改为 identity.cjs 的规范身份 key，HF10 夹具先明确 claim，补充含 generation 的 controller 使用同一 lease 回归。该旧进程已停止（exit 130），不计为全套通过。随后补齐三处 supervisor 输出的 controller/generation 断言；两轮整套各有两项默认 5 秒超时，全部单跑通过（`/tmp/coord-timeout-isolated.log`、`/tmp/coord-timeout-isolated2.log`），未增加超时或改动无关实现。
- **最终本地验收**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，995 pass、0 fail、3 snapshots、4847 assertions，31 文件、416.66s（`/tmp/coord-full-final4.log`）；最新 `bunx eslint src` 与三处输出契约定向回归 exit 0（`/tmp/coord-static-latest.log`）。同一调用方临时 home `/tmp/coord-accept.9pohoG` 下串行 fake 自检脚本 exit 0、`selftest-fake.json` 的 ok=true（`/tmp/coord-selftest-final.log`）；实际 adopt 验证 engine_commit 等于 scratch HEAD。提交后 verify-local 使用同一临时 home，回执必须核对 HEAD、ok、步骤退出码与脚本退出码；验收日志和回执保留在仓库外。
- **遗留与验收边界**：可选 Orca pane 投递、跨机共享注册表、RCPT 用户回执、B1 G2 评审和主控集成实测不由本包宣称完成。无独立 OS 沙箱，未加载 hook 的任意进程不受本包拦截。本会话只编码和自检，没有委派、push、合入、生产 supervisor/提醒或 launchd 操作。

## FIXF：COORD R1 七项修复

- **问题与被推翻的假设**：CLI fencing 不会自动覆盖 Archon shim、hook 与全局 wake；ledger 文件名不是唯一 run 标识；长执行不能占用全局 registry 锁；显式 owner 不在线也不能由 watcher 替代。R1-01/06 复用 redline 路径展开并规范化 git basename，保留内部异常默认放行。
- **新语义**：双 ID 先归一为同一 run scope，CLI/shim/hook 共用 owner/generation/lease 准入。内部 shim 使用一次性随机 token，同步验证父进程身份和实际持锁；异步重新锁定 scope 并校验 generation。tick 删除全局 wake，仅在逐 run 准入后唤醒目标 run；scoped wake 复用原生 continuation cursor/CAS、provider 配置和输出。原生 workflow wait 是只读查询，未添加轮询或恢复行为。
- **锁与展示**：registry 只包短读改写；同仓库 scope 锁串行执行与归属转移，不占用无关仓库。真实 loader 传统一 owner，activity 保留 controller，明确 owner/无主时删除 watcher/cwd 替代判定。
- **真实链路修正**：原先全局 wake 断言改为目标 run wake，并断言无全局调用；adopt 根据 `--adopt` 的双 ID 沿用原 run scope，未指明目标的 `run --resume` 明确拒绝。HF3 scratch 夹具先 claim 并经 mutate 启动，ledger 保存 controller。父进程等待 signal 回执时，子进程验证父 PID/start 与实际持锁，避免父子相互等待；普通后台 wake 重新加锁准入。已登记 ledger ID 直接读取目标文件，避免坏的无关 ledger 扫描使正常 run 一并失败，Archon ID 扫描仍明确暴露损坏。真实 fake E2E 1 pass、0 fail（`/tmp/fixf-e2e-fixed.log`），坏 ledger 隔离 1 pass、0 fail（`/tmp/fixf-corrupt-isolated.log`）。
- **旧 run 与生产影响**：不改数据库 schema 或 packages，不迁移生产状态；旧 launcher fallback 保留。已登记 Archon ID 现在同样被 run claim fencing，直接 global wake/watch/schedule 不再受支持；需逐 run 经新版入口。旧二进制与无 hook 的任意 OS 进程仍不受新准入约束。
- **自检证据**：真实 durable-wait scratch 数据库经接管后仍 paused，旧 tick/shim 被拒，current owner scoped wake 后 completed；跨仓库进程持锁 11 秒时另一个仓库 claim/handoff 即时成功。双 ID 夹具明确让实际调用者拥有仓库、另一身份接管 run，并向 shim 提供有效仓库 token，保证不是靠错误调用者误拒。完整 `bun test` exit 0：1002 pass、0 fail、3 snapshots、4902 assertions、31 文件、414.29s（`/tmp/fixf-full-current.log`）；报告指定动态复跑 exit 0：281 pass、0 fail、1946 assertions、3 文件、241.12s（`/tmp/fixf-dynamic-current.log`）。`bunx tsc --noEmit`、`bunx eslint src`、`git diff --check` 均 exit 0；fake selftest exit 0 且 ok=true（`/tmp/fixf-selftest-current.log`，回执 `/tmp/fixf-accept.4WKkhW/sa/selftest-fake.json`）。src 净增 119 行，packages 零改动；提交后 verify-local 使用同一临时 home，其 HEAD/ok/各步骤退出码以 `/tmp/fixf-accept.4WKkhW/sa/verify.json` 为准，不提交运行产物。
- **遗留**：REC 执行身份与 COORD 元帅身份的统一留给 INT3；本包不声称独立评审、主控验收、集成或上线完成。只编码、自检、指定分支提交，没有委派、push、生产 supervisor/提醒事项/launchd 操作。

## FIXF2：COORD R2 三项遗留收尾

- **问题与被推翻的假设（P1/P3/P4）**：合法 `cd --` 不是不确定 shell；Archon 短 ID 的 `getRun()` 成功不代表该 run 未登记；已解析 ledger 的 run_id 不能再次按路径解释。新增真实入口回归在修复前分别复现 hook 放行、短 ID recover 执行恢复、同名目录 shim 绕过 run claim，三项均失败。
- **COORD-R1-01**：共享 shell AST 支持字面 `cd --`、`-P`/`-L`（含组合）、`pushd <path>` 和引号路径；原有子 shell 保留 cwd 隔离。`-P` 使用物理路径解析，避免软链后 `..` 被词法归一到错误仓库。不确定选项、目录栈或动态路径仍不可建模，coord hook 内部异常默认放行不变。真实 guard 回归覆盖报告探针、额外变体、带空格路径和物理软链；redline 经同一解析器拦截合成敏感路径，不读取真实私密数据。
- **COORD-R1-02/04**：CLI 变更参数统一解析为 ledger 或未登记 RunView，短 ID 的 `getRun()` 后按完整 `run.id` 回查 ledger；recover/resume/cancel/decide/land/accept 均在副作用前进入原有 owner+generation fencing。新增 `runScope()` 由已解析记录直接构造 scope，control、shim 和 brief 共用；shim 删除路径优先的二次解析。真实 CLI 回归让实际调用者拥有仓库、B 接管 run、执行进程死亡，三种 ID × 五个变更动词均须拒绝，scratch SQL status、ledger 原文和变更调用日志保持不变。shim 覆盖同名目录、两个不同仓库的 run、双 ID approve；真实 durable-wait 数据库覆盖三种 ID wake 拒绝以及当前 owner 正常 wake。
- **旧 run 与生产影响**：不改数据库 schema、packages、依赖或持久化形状，保留旧 ledger launcher fallback 与只读命令行为。已登记短 ID 现在沿用 ledger run scope，不再进入未登记恢复分支；目录与 ledger 同名不再影响内部 run 准入。生产状态、真实 supervisor、提醒事项与 launchd 均未操作。
- **最终自检证据**：`bunx tsc --noEmit && timeout 900 bun test` exit 0，1005 pass、0 fail、3 snapshots、4998 assertions、31 文件、297.45s（`/tmp/fixf2-full.log`）；R2 报告指定的临时 HOME/状态/supervisor 桩四文件动态复跑 exit 0，311 pass、0 fail、2167 assertions、191.42s（`/tmp/fixf2-dynamic.log`）。`bunx eslint src`、`git diff --check` exit 0。fake selftest exit 0 且 ok=true，recover=2458ms、signal=1020ms、abandon=1204ms，实际 HF3 adopt 后 completed（`/tmp/fixf2-selftest.log`）。同一调用方临时 home 为 `/tmp/fixf2-accept.mbjkD7/sa`，提交绑定 verify-local 的最终 HEAD/ok/步骤退出码以其中 `verify.json` 为准；不提交运行产物。
- **遗留与验收边界**：src 净增 13 行，packages 零改动；REC 执行身份统一仍留 INT3。本包仅编码与自检，不宣称 RV-F3 独立评审、主控集成验收或上线完成。未委派、push、合并、手工删除 worktree 或修改生产状态。

## B1-INT3：COORD 集成、REC 执行身份统一与 COORD-R1-01

- **问题与被推翻的假设**：COORD 的旧 AST 和元帅解析分支不能覆盖 b1 REDLINE；目录切换只认裸 cd 目标，会漏掉 `cd -LP --`、`pushd --` 的相对私钥读取。COORD、hook 各自构造 run scope、REC 各自调用 ps 的实现会产生身份漂移；执行进程死亡不等于元帅离线。
- **合并裁决**：合入 wetamp-coord@90103e06，15 个冲突保留 REDLINE 的默认放行、确认危险拒绝、三段式脱敏提醒与效果 AST；保留 POLICY context-budget→context-advisory 薄委派、执行 provider 包装和 EV 的树/预算/投影。COORD 的 owner/generation fencing 与交接提示叠加其上；双方测试保留，RCPT 通知和带 run 的 wake 同时保留。Archon shim 的原生执行仍通过 POLICY 入口，wake 同样安装其执行边界。
- **统一链 / I1、I3、I6、P2、P4**：COORD owner/generation 授权先于 REC 的执行归属与恢复 fencing，死亡只影响执行者恢复，不转移 controller。run scope 唯一由 hooks/coord.cjs 构造，CLI、shim、board 与 hook 复用；ledger 的精确/唯一短 Archon ID 优先于同名目录。REC 启动登记、执行存活/复用检查与 COORD 都复用 identity.cjs 的 ps 探针；未知、远端与复用执行 PID 保持 held，COORD 的 owner presence 独立决定元帅在线三态。Git 查询语义直接从 REDLINE 效果表推导，删除接线中的旧只读解析依赖。
- **目录机制与事故回归**：shell-ast.cjs 一处处理 cd 的 -L/-P/组合/--、pushd/popd 的目录栈、cd - 的旧目录与子 shell 隔离；-P 按物理路径遍历软链。无法确定目录产生 advisory，危险动作目标未知仍拒绝。合成 HOME 的真实 hook 验证元帅/派生两种身份各 7 个读取变体，含报告外 cd -P、子 shell、popd；修改前组合选项回归实际放行，修改后拒绝。既有 REDLINE 11 项 /tmp/rv-c3-variants.cjs 探针保持 exit 0。
- **旧 run / 生产影响与遗留**：不改 packages、schema、依赖、生产状态或共享协议；旧 ledger 的 launcher fallback、REC 对账及恢复 token 不变。hooks 是现读代码，投送后旧 run 也消费新目录分析；本派生会话仅编码与隔离自检，不代表独立 G2 评审、主控验收或上线。验收证据写临时目录，完整套件、自检及提交绑定 verify-local 结果由交付回复报告。
- **集成初始化修正**：完整测试暴露 coord/config/archon 导入循环中顶层启动脚本插值提前访问 WETAMP，真实 CLI 报 `ReferenceError: Cannot access 'WETAMP' before initialization.`；启动登记脚本改为调用时生成，保持进程身份登记不变。两项真实数据库回归保留原断言并增加夹具启动失败诊断；修正后 actual durable-wait 与 real Archon CAS 两项 2 pass、0 fail、18 assertions。修改期间启动的旧完整测试不计最终验收，最终 HEAD 重新运行全部指定检查。
- **隔离环境夹具**：REDLINE 拒绝清单原先继承调用方 HOME；临时 HOME 使 `~/work/other-repo/src` 变成允许删除的临时产物，单跑复现 0 pass、1 fail。该清单显式使用 `/Users/test` 合成 HOME，不访问真实私密资料、不改变拒绝断言或运行策略。隔离验收同时显式设置临时 Git 作者/提交者身份，避免 scratch merge 依赖用户全局配置。

## B1-FIXC6：外部仓库的非破坏 Git 写入默认放行

- 问题与被推翻的假设：Git 写入不等于销毁既有内容；FIXC5 的检出身份检查覆盖全部写入，误拦了外部仓库的 fetch、add、commit 和新建分支。新增回归在修复前复现主控身份的 `cd R && git fetch -q origin` 被拒。仓库协作归属由 COORD 管理，REDLINE 不据此拒绝普通新增操作。
- 新语义与复用：`shell-effects.json` 统一定义破坏性子命令、条件标志和强制标志，删除笼统的 Git write 清单；代码将这些效果组合后，只对破坏操作调用既有 Git 定位三态与 `taskOwnership`，不列举放行样例。外部/未知定位的 fetch、新提交、新分支/标签、add、init、clone、stash push 放行；丢弃工作区/索引、删除或移动既有引用、改写历史、强制操作和 push 仍拒绝。新增引用与强制覆盖引用分别验证；嵌套 checkout 的破坏操作继续拒绝，reviewer 只读、配置保护、受保护引用与 mktemp 归属保持原约束。
- 不变量与证据：遵循 P1–P4，复用 AST、Git 调用解析与 deny/advisory 通道，无新增依赖、运行状态或配置开关。五条生产误拦命令经真实 guard 在主控/worker 两种身份回放；纯判定矩阵覆盖外部及未知定位的普通新增和破坏标志，不执行破坏样例。旧测试中外部 add/嵌套 commit 的拒绝断言更新为本卡要求的放行，R1/R2/R3 的破坏操作探针保留。
- 旧 run/生产影响：安装更新后既有会话采用本次更窄的 REDLINE 规则，`error_class=redline` 和消费者契约不变。本包仅改指定 worktree 的两份 hooks、hooks 测试与本节；未修改生产 checkout/台账、packages、supervisor 或提醒事项，未合并、push 或部署。
- 遗留与验收边界：解释器和外部脚本的间接效果继续遵循既有策略；本卡只编码与自检，不再委派或评审，生产实测由主控完成。验收证据与隔离 selftest、提交后同一临时 home 的 verify-local 回执在 `/tmp/fixc6-accept.SQctam`；最终结果以本次交付及提交绑定回执为准。
- 提交前验收：tsc、eslint src、hooks 语法检查及 diff --check exit 0；hooks 77 pass/0 fail，完整 bun test 918 pass/0 fail、3 snapshots（345.89s），FIXC6 三项定向回归 456 个断言通过，R3 变体 11/11、exit 0。隔离 selftest --fake exit 0、ok:true；首次把两种身份的全部 guard 回放放入一个用例触发 5 秒超时，按身份拆分后保持全部断言通过。hooks（含 JSON）净减少 1 行，提交后同一隔离 home 以 verify.json 校验最终 HEAD。

## B1-FIXINT：集成总审 Git 归属与启动失败出口修复

- 问题与被推翻的假设：REDLINE 放行非破坏性 Git 写入后，COORD 只看首个 `-C` 不能代表实际 Git 目标；其单独解析也遗漏 metadata、worktree 与命令环境。新增真实 hook 回归在修复前复现异主仓库的第二个 `-C` 被放行。CLI 外层读取 plan 和执行 COORD 准入绕过启动失败捕获，使缺失/非法计划及归属拒绝失去 JSON 输出和 `launch-failures` 证据。
- 新语义与复用：REDLINE 导出既有 `gitInvocation`，COORD 直接消费其 locations、checkout、metadata，并合并 AST 的命令环境，对每个解析目标执行既有 owner 校验；不新增第二套 Git 解析。无主外仓库的普通 add 继续放行，Git 查询继续放行。CLI 只读一次 plan，把 scope 锁、claim 和 mutate 放入原有结构化启动失败出口，保留全程 owner/generation fencing；worker preflight 仍先于 plan 读取。
- 不变量与回归：无新依赖、配置或状态；强化 I1、I6 与 P4。真实 hook 覆盖连续 `-C`、等号/分离 Git 路径选项、metadata 与 worktree 分属不同仓库、命令赋值/env 包装及继承的 Git 环境。真实 CLI 验证缺失计划、非法 JSON/schema、异主 claim 的 `--json` 失败回执与落盘记录一致，且不产生 run/intent；原 WP-1 worker 用例恢复通过。
- 旧 run/生产影响：仅本 worktree 六个文件，不改 packages、schema、生产 checkout/台账、supervisor、launchd 或提醒事项。新版 hooks 生效后旧会话沿用新的目标检查；旧 ledger 与 launcher fallback 不变，启动失败沿用原有输出和记录形状。未 push、合并或部署。
- 聚焦自检与遗留：隔离 HOME 下 `bun test --timeout 60000 tests/coord.test.ts tests/hooks.test.ts` exit 0，109 pass/0 fail、1915 assertions；`bun test --timeout 60000 tests/guard-install.test.ts -t WP-1` exit 0，3 pass/0 fail、28 assertions；`bunx tsc --noEmit` exit 0。证据 `/tmp/fixint-accept.A0jWXZ/{coord-hooks,wp1,tsc}.log`。未运行完整套件、selftest 或 verify-local；本卡仅编码与自检，主控聚焦实测及合入待主控执行，不再开启评审轮。动态/间接 shell 效果沿用既有解析边界。

## B1-HF11：无冻结快照的 Codex 启动策略回退

- **问题与被推翻的假设**：POLICY 的 worker/proxy 共用 `loadPolicy`，无路径即抛 `SA_POLICY_PATH missing`；所有调用都经新 run 包装器的假设不成立，全局 worker 还服务 selftest 和旧 run 的凭据预检/执行。修改前直接调用 `loadPolicy('')` 已复现退出 1。
- **新语义 / P1–P4**：策略构造、脱离原对象与 canonical SHA-256 现在由 proxy 公共模块唯一拥有，`config.snapshotPolicy`（generate 的原入口）直接委托它。只有路径未指定/空串时读取同一检出的当前 tiers.json，以新 run 将冻结的完整策略启动，在 stderr 留可观测提示；限制仍完整执行，未增加配置或状态。显式文件缺失、JSON 损坏或 hash 不符仍失败关闭，已有冻结策略继续优先；回退不为旧 run 补写快照，也不承诺旧 run 的策略冻结。
- **deviations / 预检调查**：当前 `cli.ts` 启动传 `--config gen.config`；原生 workflow CLI 加载该层，`prepareRunAiConfiguration` 应用 envVars/assistants，`assertRunCredentials` 把二者传给 `CodexProvider.checkCredential`，后者用相同 `codexLaunch` 启动 app-server。未发现当前代码独立丢配置的缺陷，因此未改 packages 或预检。selftest 的三个 run 调用没有 `--config`；只读核验旧 xiaopan 的 run-config 确认无 env/codexBinaryPath。报告中的 BestIFA 生成目录已不存在，无法确定其历史生成内容/调用版本，不将该部分宣称已复现；正常新 run 仍使用原有冻结 env 和包装器。
- **聚焦验收**：`cd wetamp && bun test tests/policy.test.ts tests/exec-profiles.test.ts tests/policy-executor.test.ts tests/generate.test.ts` exit 0，135 pass/0 fail、879 assertions（43.28s）；`bun x tsc --noEmit -p wetamp` exit 0；证据 `/tmp/hf11-accept.vA5909/{tests,tsc}.log`。覆盖 worker 与直接 proxy 无路径回退、marker/网络只读策略、显式文件缺失/坏 JSON/坏 hash 拒绝与快照优先。直接 proxy 空路径 + `true` 在 EOF 下 exit 0；真实 `wetamp/bin/codex-worker app-server </dev/null` 被现有 guard hook 信任闸拒绝（exit 3），未绕过、未改变 hook；真实 provider 实测待主控。
- **旧 run/生产与遗留**：无快照旧 run 可在更新代码后采用当前策略；有快照的 run 保持原约束。未改 hooks、asks、run 台账、轮次、截止时间、生产 checkout 或 supervisor；未委派、push、合并或运行完整套件。首次测试/tsc 因 worktree 缺依赖失败，分类为环境问题，仅在本 worktree 建立已有 node_modules 的软链后集中重验；不提交软链、不安装或升级依赖。本派生包仅编码与自检，生产 P0 是否解除由主控实测确认。

## B1-G1：生产护栏误拦小修

- **问题与被推翻的假设**：`git branch -d/--delete` 不等于强制销毁未合并内容，Git 自己执行合并检查；字面 `~` 不属于 cwd；同 PID 的历史心跳不代表当前身份歧义；`--hooks` 写信任后不能 `exec` 掉安装台账；API 工具的稳定 controller 可以是 `codex app-server`，不必是终端 CLI。
- **新语义与复用**：REDLINE 放行安全删除，保留 forceFlags、`-D/-m/-M/-C` 的原有破坏性归属保护及 reviewer 只读；COORD 在路径解析前复用 `expand`；launcher 只用 `identity.FRESH_MS` 内心跳判定 session，多值仍不猜测。`--hooks` 成功写信任后发布 controller 模式，dry-run 不写台账。controller 解析接受 app-server 的稳定祖先 PID，继续跳过 exec/MCP，默认 `cliOf` 和看板服务分类不变；第 5 项 hooks 修复小于 20 行，无新增环境配置。
- **不变量与事故回放**：强化 I1、I6 与 P1–P4，复用效果表、路径展开、共享身份探针及 `publish_mode`，不另建状态或依赖。回归覆盖安全/强制分支删除矩阵、临时 HOME 的 tilde 与真实异主拒绝、过期 smoke/当前 session/新鲜歧义、API app-server 的 shell 祖先及真实 caller、安装台账 dry-run/更新/幂等；只判定危险命令，不执行删除样例。已有 launcher 测试心跳改为当前时间，修正固定历史时间的夹具假设。运行时观测沿用 hook 拒绝、launcher 元数据与 install.json。
- **旧 run 与生产影响**：不改 schema、owner key、已存 claim/run 或 fencing；既有缺失 session/短命 shell claim 不自动重写，需要主控显式处理。更新 hooks 后新的 claim 使用正确身份，已有仍新鲜的多个 session 保持省略。仅改本 worktree，未操作生产 checkout/台账、supervisor、提醒事项、launchd 或 packages，未 push/合并/部署。
- **自检与遗留**：四文件窄测 95 pass、5 fail（其中 2 项导入错误），`bun x tsc --noEmit -p wetamp` exit 2；未改动的 packages/CLI/policy-executor 路径缺少 `@hono/zod-openapi`、`@archon/workflows`、`@clack/prompts` 等依赖与类型，分类为测试环境问题，不修改产品核心。证据 `/tmp/b1-g1-tests.log`、`/tmp/b1-g1-tsc.log`。本包 5 项新增回归全部通过：原文件的分支删除与安装台账各 1 项；从 coord/ownership 原回归抽取到 `/tmp/b1-g1-runtime.test.ts`、仅移除无关的 CLI/board 顶层导入并修正 import.meta.dir 的绝对定位，在现有依赖 `NODE_PATH` 下 3 pass/0 fail（tilde、API 祖先、真实 caller 新鲜/歧义），证据 `/tmp/b1-g1-runtime.log`。恢复缺失根依赖仅增加未跟踪 node_modules 软链；JS/bash 语法与 diff 检查通过，hooks 净增 2 行。xiaopan 的历史短命 PID 已退出，API app-server 根因由源码调用链和隔离 caller 回放验证，生产控制台与交接稳定性留主控实测；本包不走独立评审轮。

## B1-MK：reviewer 临时写入按目标路径判定

- **问题与被推翻的假设**：卡片所述命令白名单在当前源码中已不存在，原有 `mktemp` 赋值和校验命令的 env 前缀已经放行；实际回放发现 `$TMPDIR` 重定向未展开，被误当未知覆盖目标拒绝。另一个边界缺口是独立 `mktemp -d ./src/x.XXXXXX` 没有呈报创建效果，reviewer 可直接在被审仓库创建文件。新增 MK 回归在修改前于 `$TMPDIR/a` 失败。
- **新语义 / P1–P4**：强化 I1 权限边界和 I6 事故回放；复用 AST 的 `temporaryPath` 与 REDLINE 的 `targetReason`，把 mktemp 的实际创建目标交给通用路径归属判定，保留 `-u/--dry-run` 无写入语义。`$TMPDIR` 优先取本命令内已解析变量，否则取传入环境；临时目录、同命令 mktemp 产物及校验 env 前缀放行，仓库、生产 `~/.superagent` 与已有 Git 写入保护继续拒绝。提醒显示仓库实际目标路径或 `~/.superagent`，不回显命令内容；观测沿用 guard deny/advisory，无新增配置、状态、依赖或命令白名单。
- **旧 run / 生产影响**：仅本 worktree 两份 hooks、hooks 测试与本节；更新安装后旧会话可使用新判定，不迁移或修改既有 run/生产状态。本包未改 `sa-check.ts`、packages、生产 checkout/台账、supervisor 或提醒事项，未委派、合并、push 或部署。
- **自检与遗留**：`cd wetamp && bun test ./tests/hooks.test.ts` exit 0，83 pass/0 fail、1703 assertions（42.95s），原 reviewer 用例全通过；随后补齐 mktemp dry-run 边界并定向运行 `-t 'MK：'`，1 pass/0 fail、54 assertions（3.42s），未重复整文件测试。两份 hooks 的 `node --check` 与 `git diff --check` 通过，hooks 净增 2 行。`bun x tsc --noEmit -p wetamp` exit 2：未改动依赖缺 `@archon/*`、`@clack/prompts`、`@hono/zod-openapi`，并有跨检出类型冲突与既有 `ProcessEnv` 断言错误（HEAD 原测试第 1266 行）；不修改这些包外代码，不宣称类型检查通过。依赖仅链接现有 node_modules，不提交软链、不安装或升级。自检摘要 `/tmp/b1-mk-checks.md`；动态/间接 shell 效果保留既有解析边界，本包不走评审轮，后续主控实测。

## B1-FC：引擎侧失败分类机制化

- **问题与被推翻的假设**：命令退出非零不等于改产品代码能修好；coder 自报也不能证明夹具或环境问题。原 accept 会先派包级修复，红验收又跳过 reviewer，gate 仅按 severity 阻塞，提示里“不修夹具”的约定没有进入确定性路由。
- **新语义 / 单一真源**：`output.schema.json` 的 `$defs.failure_class` 拥有 `product | test_env | fixture | baseline | test_data`；`bun run generate:failure-class` 派生 runtime 类型与嵌入 schema，回归校验它们和 golden 的一致性。reviewer 给每条发现分类，`command` 为原验收命令或 null，非产品分类须附 evidence。验证命令在失败时可将整个 stdout 输出为 JSON `{failure_class, evidence}`（evidence 非空）；引擎保存原命令和实际日志路径。未分类、非法分类、无证据或信号终止均按 product，coder 字段不参与降级；基线 probe 的单个布尔结果也不自动分类。
- **路由与上限**：product 沿用 blocking 规则；非产品失败进入 debt/已知问题，原 `ok:false` 和失败命令仍留存，但干净工作区可 advance，repair 节点不会启动。混合失败只修 blocking，sa-fix 不再要求修 debt 中的失败命令。稳定 finding id / 命令派生键记录 `repair_rounds`；复用 `MAX_ROUNDS=3` 表达首验加两轮修复。非 strict/G2 同一阻塞失败到第三轮转 `repair_limit` debt，带类别、证据与轮次；第三次同命令验证也转 advance 让 reviewer 继续，不新增开关。G2/strict 仍阻塞并以原 review_limit 原因 held，独立评审、预算、截止时间与工作区干净要求继续生效；缺评审不会因到上限而放行。
- **旧 run / 生产影响**：新增输出字段兼容旧评审（缺分类按 product），不迁移生产状态、不改 packages。既有冻结生成目录不自动更新；新 run 或主控显式 adopt 后才加载新脚本/schema。fake reviewer 与两份 golden 同步新必填字段。CLI 重试提示没有完整模式/验证输入，保守保留阻塞，最终判定仍由完整 gate 台账拥有。
- **自检与遗留**：`bun test tests/sa-check.test.ts` 251 pass/0 fail（`/tmp/b1-fc-tests-final.log`）；最终 FC 聚焦 7 pass/0 fail、含 golden schema/fake 输出一致性（`/tmp/b1-fc-focused-final.log`）。`bun x tsc --noEmit -p wetamp` exit 2（`/tmp/b1-fc-tsc-final.log`），现存缺 `@hono/zod-openapi`、workspace 模块、相对 zod 依赖及未改动路径类型报错；本包改动路径未报错，但不宣称 tsc 通过。额外 generate golden 窄测因同一缺失依赖在导入阶段失败（`/tmp/b1-fc-golden.log`），记录为 test_env，不派产品修复。仅建立未跟踪 node_modules 软链，无安装/升级依赖；未全测、未委派/评审、未 push/合并/部署。主控集成实测与 astra 一轮评审仍由主控完成。
- **R2 / FC-R1-01、FC-R1-02**：推翻“首条 finding 代表整条命令”和“修复到限即可复用旧评审”的假设；同命令保留全部稳定 finding ID 与各自分类，命令聚合遇 product/未分类即阻塞，不受顺序影响。`repair_limit` 仅改变修复路由，跳过评审仍必须满足候选 head、diff、contract_hash、风险与独立评审身份等原复用条件；现有 open debt 禁止复用，不匹配保持 held。新增混合分类正反序、strict/G2、各 ID 独立分类与关闭、第三轮 debt 叠加候选/契约/身份变化回归，原代码上 3 项均失败；`bun test tests/sa-check.test.ts` 254 pass/0 fail（`/tmp/b1-fc2-sa-check.log`）。旧冻结 run 不自动更新，无生产状态迁移，tsc 与独立复审/集成实测交主控。

## B1-NR：评审按需触发

- 推翻“每个里程碑都须评审”的假设；复用现有 when/gate（P4、I1），包 `review:true`、strict 或 G2 强制评审；其他仅在绿验收 advance、无任何评审且有效风险低于 G2 时 PASS(TESTED)，保留预算/截止检查，TESTED 不产生评审债。
- 新 run 加载新语义，旧冻结 run 不自动改变、生产状态不迁移；NR 回归覆盖 plan/schema、正常/fake 条件、有效 G2 升级与 gate 失败关闭，监测点为 gate 的 grade/reason/risk；聚焦 5 pass/0 fail（`/tmp/b1-nr-focused-final.log`），卡片三文件验收 373 pass/2 fail（`/tmp/b1-nr-tests-final.log`）；两项 Archon 子进程失败为 worktree 缺 pino 的 test_env（`/tmp/b1-nr-archon-import.log`），不派产品修复。两份 golden 经 buildWorkflow/原 YAML 序列化路径重生成；除 golden 净增 75 行。tsc 按卡未跑，独立评审与集成实测交主控。

## B1-AD：引擎换版拒绝重跑已完成包

- 问题与被推翻的假设：终态 run 的 adopt 会新开 run，从首节点重跑；I3 的换版不保证保留已 PASS 产物。复用完成节点集合，在恢复 guard 写 ledger 前拒绝有完成节点的 adopt，返回 run id，并提示 reject 后从最后 PASS commit 新开计划或检出旧引擎 commit；无完成节点仍可 adopt，强化 I1/P1–P4，无新状态、配置或跨 run 复用。
- 旧 run/生产影响与遗留：仅新恢复调用受保护，运行中/paused/同指纹语义不变，不改生产 ledger、packages 或已生成快照；一条回归覆盖 failed/cancelled 的已完成编码/评审节点、ledger 不变且不启动恢复。`cd wetamp && bun test tests/cli.test.ts -t 'HF3 latest-engine recovery'` 最终 8 pass/0 fail（`/tmp/b1-ad-focused-final.log`）；整文件试跑 261 pass/1 fail（既有 REC-R1-01 的未登记 run selftest recover 失败，不经过本包 guard，`/tmp/b1-ad-cli.log`），不扩范围修复。回归移除重复夹具初始化后通过，未放宽超时；`bunx tsc --noEmit` exit 2，未改动 memory 文件缺相对 zod 依赖及隐式 any（`/tmp/b1-ad-tsc-final.log`）；测试依赖仅用已有缓存临时链接，无安装/升级或生产写入。仅编码自检，主控实测另行执行。

## RB：quick 单命令起 run

- 问题与被推翻的假设：小活不必手写完整 plan；p50 预算/deadline 预测不是硬拒依据。复用 loadPlan/startRun（I1/P4），quick 单包单里程碑，默认 accept cache:true，--no-cache 不设缓存；floor 合计校验不变，override 字段保留。
- 旧 run/生产影响与遗留：quick 只创建新 plan，旧冻结 run 不变；新的 run admission 只记录预测 warning，真实预算与截止执行约束不变。README 补 CLI 与拆分准则；未操作生产状态、未启动真实 run，主控实测与集成待主控完成。
- 自检：隔离状态下卡片三文件 -t "quick|admission" 2 pass/0 fail（297 filtered）；memory.test.ts 的 plan/run admission（stub engine）2 pass/0 fail；bunx tsc --noEmit -p wetamp exit 0。证据 /var/folders/j1/ng2qb8qs6d141y_yk08z9fy40000gn/T/rb-accept-f9_udaes；产品代码净增 65 行，未全测、未委派/评审、未 push。

## RC：护栏默认放行

- 推翻“微改超限必须阻断、活动 run 需按工具次数催促”的假设；强化 I1/I6 与 P1–P4，复用累计锁及事件幂等：G-1 改为 advisory，首次超限及再增 100 行/2 文件提示，新风险路径明确展示；删除 15 次提醒及专用计数/活动 run 查询。安装更新后旧会话采用新提示，旧计数不再读取，微改阈值、risk_paths/G2、redline、COORD、嵌套/模型池/push/reviewer 边界不变；未改生产状态。隔离验收两文件 91 pass/0 fail、tsc exit 0（/tmp/rc-accept-107moqfa）；事故回归含超限/风险/并发/去重，观测为 systemMessage/additionalContext，guard-install 无对应旧断言；未覆盖主控集成实测，未评审、push 或部署。

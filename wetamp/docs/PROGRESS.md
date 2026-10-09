# PROGRESS

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
- 预算：TS 1493/1500 行；shell 239/300 行（含 bin/）；文件 25/25（不计 tests/、docs/、README.md）。
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
- 预算：TS 1766/1800 行；shell 274/400 行（含 bin/）；文件 26/28（不计 tests/、docs/、README.md）；硬规则 7 已改为 1800/400/28。
- 验证：`cd wetamp && bun test` 124/124；`tsc --noEmit` 干净；`check-upstream-clean.sh` 输出空；`selftest.sh --fake` ok。
- 未修/遗留：根 `bun run lint` 被既有的 `tests/install.test.ts:15` 递归 rmSync 清理漂移检查拦下（HEAD 已存在，wetamp 无 `@archon/paths` 依赖，本轮未改）；`resume --model` 在 00/02/03 设计段的旧描述未改（设计层说明，实现记录已注明以 run-config 层为准）；`stash@{0}` 按要求未动。

## 修复轮 R2 摘要

- N1 + M7 dd1e9c1e：`N1: a duplicate id (closed + open high) in one review escalates as invalid_review`、`G1: a reviewer listing one of two open mediums still yields both as debt`、`G1: an R1 medium omitted in R2 stays debt; closing it with evidence clears it`。
- H4 55b93ebf：`human wait deadline is the time left to the plan deadline, no floor; a passed deadline fails generation`；M1 1d8d48eb：`interleaved recovers at stalled=2: the count is on disk before the lock is released, so only one resumes`。
- M4a + M4b 4d2a516b：`an aged lock whose holder is alive is never taken; an aged unreadable lock is`、`an ask that saved its record then exited non-zero stays unknown; the next tick reconciles via ask-status instead of asking again`。
- N2 d69fa26b：`launchd plist: ARCHON_HOME is rendered only when set explicitly at install`。
- 验证：`bun test` 130/130；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；`selftest.sh --fake` ok（rss=192256KB recover=998ms signal=541ms）；零真实模型调用。预算 TS 1807/2000、shell 277/400、文件 26/28。

## 修复轮 R3 摘要

- M4a 0a52c660：`an aged lock whose holder is alive is never taken`、`an aged unreadable lock is NOT taken: tick reports lock_unreadable with exit 1`、`an unreadable recover lock refuses recover without touching the run`、`the lock file appears with its full content and leaves no temp file behind`。
- H4 70ae7dfa：`held:human past the plan deadline: tick cancels (reason deadline), ask expired, supervisor untouched, brief says so`、`held:human before the plan deadline still asks; nothing is cancelled`。
- N3 7a095e70：`a null or malformed supervisor ask record is skipped and counted; the valid one is still reconciled`。
- 验证：`bun test` 136/136（新增 7 个测试在 f88040e6 源码上 5 败 2 过，过的两个为行为不变断言）；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；`selftest.sh --fake` ok（rss=193744KB recover=999ms signal=538ms）；零真实模型调用。预算 TS 1853/2000、shell 277/400、文件 26/28。

## 修复轮 R3b 摘要

- 锁夺取原子化 d8008140：`a dead lock is seized by A; B, a separate process, then gets locked and leaves A's lock in place`、`a dead lock seized by someone else between the check and the rename: locked, no throw, no .stale left`（旧源码上 1 败 1 过，过的为行为不变断言）。
- 验证：`bun test` 138/138；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；零真实模型调用。预算 TS 1870/2000、shell 277/400、文件 26/28。

## 修复轮 R3c 摘要

- 锁夺取 ABA 窗口 b3281ea4：`a dead lock replaced by a live one between the check and the rename: live lock put back, locked, no .stale left`（去掉比对即失败）；测试临时目录清理改用 `trackTempRoots`/`removeTempTree` db3999cc。
- 验证：`bun test` 139/139；`tsc --noEmit` 干净；`check-upstream-clean.sh` 空；仓库根 `bun run lint` exit 0（test-cleanup drift 不再报 wetamp）；零真实模型调用。预算 TS 1884/2000、shell 277/400、文件 26/28。

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
- 预算：TS 1851/2000（−33）、shell 304/400（+27，selftest.sh）、文件 26/28。src+scripts 合计 +112/−118；含测试与文档共 +314/−295。
- 未做项：01/03 规划与对照矩阵文档未改；flock 只在 darwin 实测，linux 路径（libc.so.6、`__errno_location`、EWOULDBLOCK=11）未实测；hook 的“请军师评审”提示按卡片要求忽略。

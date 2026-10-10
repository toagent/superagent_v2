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
- 预算：TS 2106/2600、shell 397/700、hooks cjs 499/1400、文件 33/40。
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
- 预算：TS 2129/2600、shell 436/700、cjs 783/1400、文件 34/40。
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
- 预算：TS 2158/3200、shell 438/700、cjs 905/1400、文件 35/46。
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
- 预算：TS 2894/3200（.ts+.tsx）、shell 445/700、cjs 783/1400、文件 40/46。
- R1 修复（astra R1 D01–D06）：脱敏整值、查询超时与取消、非对象 ledger、缓存方案②、路径边界、列分隔与 80 列布局；ink 检查前移。`tests/board.test.ts` 22 条（新增 10 条）。预算 TS 3018/3200、shell 445/700、cjs 783/1400、文件 40/46。
- 已知限制：currentRole 取自生成目录里的工作流 YAML，gen 目录被清理后显示 `?`；节点总数在 YAML 不可读时退回 run 已调度的节点数；`--once` 在管道里按 160 列渲染；交互模式每 5s 对每个非终态 run 起一个 archon 子进程（约 0.3s/次）。

## WP-BT board 时间

- 开始时刻取 ledger `started_at`（提交时刻，resume 不变；不可解析才退回 Archon 的，后者每次 resume 重置），排序同口径；终态止于 `completed_at`，缺则 `last_activity_at`，都缺显示 `-`；running/held 止于 now。行带 `span{started_ms,ended_ms}`，界面用 1s 时钟经 `elapsedAt` 重算，`--json` 的 `elapsed_s` 为取数时刻值。
- 所有界面时刻经 `fmtClock` 按进程本地时区（尊重 `TZ`）显示：当天 `HH:MM:SS`，否则 `MM-DD HH:MM`；header `last` 去掉 `Z`，detail 首行加 `开始 · 耗时`；`--json` 原始 ISO 不变。
- 验收：`bun test` 200/200（board 27 条，新增 5 条）；真实 `~/.superagent` 只读 d01a 显示 23m26s（原 2m40s）。预算 TS 3100/3200、文件数不变。

## wpE caps：最大权限 + 红线 + 自动重试（2026-10-10）

- caps：plan 级与包级 `caps{network,web,install,services,long_tests,read,git,mcp}` 默认全开，只做收紧；Claude 节点落成 `denied_tools`，其余是任务书提示级（`docs/00` §5.1）。
- 将军输出 `deviations[]`（越出 scope 的登记）与 `needs[]`（`{cap,why,minimal_ask}`）；`blocked` 只在红线或 needs 非空时合法。
- 自动重试：`supervise-tick` 对 held:gate（≤2，先追加 `hints/<包>.md`）、held:environment（≤1）、编码节点失败（≤1）自动 retry；needs、红线、截止、次数用尽、连续 no_change、无可重试节点时保持 held。`decide <run> retry [--pkg --hint]`、`decide --all-held retry`。
- 执行层红线：`hooks/redline.cjs`（凭据与隐私路径、发布合并、改写共享分支、按名杀进程、连非本机库、派生会话写出 worktree），每条有 allow/deny 测试；provider × 红线矩阵见 `04-hooks-and-nesting.md`。
- hooks 实测：Claude 节点用户级与项目级 PreToolUse 都触发；Codex 节点只加载用户级 `hooks.json`，git-guardrail 触发，guard 因 trusted_hash 过期被跳过。`codex-worker` 现在失败关闭（exit 3），运维需在交互式 Codex 里 `/hooks` 重新信任 guard。
- M-06（自动投送未验证版本）：`scripts/verify-local.sh` 是本机投送闸；twin-toolkit 的 superagent 维度只把 `verify.json` 中 ok 且等于 HEAD 的提交投送到 twin 机，未通过时打印「本机未通过 …，暂不投送；远端保持 …」，验证期间 HEAD 前移也不投送。
- 预算：TS 3426/3800、shell 591/850、cjs 1119/1700、文件 43（+3：codex-readonly-proxy.cjs、redline.cjs、verify-local.sh；理由见 `docs/00` wpE 实现记录）。
- 已知限制：主工作区合入 `verify-local.sh` 之前，twin-toolkit align 的 superagent 维度报「无法验证」rc=1；OpenCode 与 Codex 侧 caps 只是提示级；远端 dry-run 未在本包执行。

## WP-BT2 看板实时作业+窄屏
- 活动区（run 表上方）：`job exec` 登记作业（`$SUPERAGENT_HOME/jobs/<id>.json` 原子写，不记 argv/prompt；退出码透传、信号转发得 128+n；结束超 24h 回收，死进程记 lost）、未登记无头 AI 进程（一次 ps + ≤8 个 lsof 取 cwd，排除 archon 与已登记 wrapper 的后代）、twin-agent 远端非终态队列；三源并发各 ≤3s，失败降级为一行灰字；chips 增 `[jobs N]` `[remote N]`、空闲行；`--json` 增 jobs/procs/remote/notes。
- 响应式：<80 紧凑（短 id、短 state、`n/m`；running 与选中行第二行 `cur:`；footer `q r j/k ⏎ a ?`，`?` 开完整按键说明）、80–120 中等、≥121 宽屏；chips 整项换行不截断；`--once` 在管道里认 `COLUMNS`。
- 验收：`bun test` 210/210（新增 jobs 7 条、board 3 条）；真实 home `COLUMNS=59 board --once` 每行 ≤59 列（按 Bun.stringWidth 计）且列出无头 claude 将军进程；59 列 pty 交互 j/k/Enter/?/q 退出 0。
- 预算：本分支单独 TS 3698/3200；与 wpE 合并后 TS 3694/3800（wc -l，元帅 2026-10-10 核定在 wpE 上调后的预算内）；shell/cjs 不变，文件 43/46。

## WP-BT3 看板交互会话
- 心跳：`hooks/live.cjs` 的 `beat()` 由 guard.cjs / context-budget.cjs 在 try/catch 内调用（不新增 hooks.json 条目），原子写 `$SUPERAGENT_HOME/live/<client>-<sha256(session_id)[:16]>.json`，字段白名单 `{client,session_id,pid,tty,cwd,transcript_path,event,tool,turn_at,at,derived}`；pid 逐级 `ps -p` 只解析一次，连续工具事件节流 2s，任何失败静默；看板读取时回收 pid 已死且 24h 未更新的文件。
- 终端行：ps 里有 tty 的交互 claude/codex/opencode（同 tty 同类子进程并入最外层），状态按 心跳 → transcript/rollout 尾部 64KB（只看事件类型与 stop_reason）→ %CPU 粗判（标 `?`）；只显示 client/状态/tool/cwd 末段/tty/时长，绝不显示 prompt、argv、transcript 文本；派生会话（心跳 derived）不进终端行；chip `[active 执行中/总数]`。
- 一次 lsof：无头进程与终端会话共用一次 `lsof -p … -Fn`（≤24 pid），同时取 cwd 与 codex 握着的 rollout。
- 验收：tsc 0；`bun test` 251/251；wetamp eslint 仅余基线 cli.ts:781；guard claude/codex、context-budget × `ls /tmp`/`pkill -f node` × 可写/只读 HOME 共 12 组 rc/stdout/stderr 逐字节一致；20 次中位数增量 ≤+1.5ms（UserPromptSubmit 必写路径 ≤+3.5ms）；实机 `COLUMNS=59/140 board --once` 每行 ≤59/140 列，无 prompt。
- 预算：TS 3990/4000（wc -l，src 下 .ts/.tsx）、cjs 1194/1700（+75，live.cjs）、文件 45（+2：live.cjs、terminals.ts）。
- 已知限制：hook 部署前没有心跳，claude 会话多显示 `未知?`；空闲 codex 不握 rollout；Claude 被中断后 transcript 末尾是 user 条目，会误判执行中直到下一事件；节流可能丢 PostToolUse，tool 名短暂过期。

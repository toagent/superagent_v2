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
- F-20 增量：R2/R3 用 `sa-review-delta`（上轮候选→本轮候选的 delta + 台账，完整历史只给路径）；fix 只把台账 blocking 当阻塞，新发现非 blocker 记债。修掉基线即有的 `$INPUTS.round-1`（被解析成名为 `round-1` 的输入，dry-run 在 review-*-r2 失败）；新增测试：每个命令模板读到的 `$INPUTS.<name>` 必须由节点绑定。
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
- 显示：状态符号后加角色标签，`Bun.stringWidth` 按显示宽度截断/补齐；作业/无头进程沿 ppid 链挂到所属终端会话下（`  └ `），找不到的归 `无主`；chip 只计运行中（执行中终端 + running 作业 + 无头进程）；run 表 current 带节点角色，cur 行中文。
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

| 节点/稳定 reason | 处置 | 是/否或上限 |
| --- | --- | --- |
| verify/settle `coder_redline` | ask `redline` | 是=已处理，重跑里程碑；否=终止 |
| verify/settle `coder_needs` | ask `needs` | 是=能力已补齐，重跑里程碑；否=终止 |
| verify/settle `coder_error:env`、`coder_error:vendor_unavailable_all` | environment 退避 | 本里程碑编码重跑；120s×2^(n−1)，≤30min，次数取 tiers auto_retry.environment |
| verify/settle `coder_output_invalid`、`repair_exhausted:*` | coder 自动重试 | reason + 脱敏验收日志尾追加 hints；次数取 tiers auto_retry.coder，用尽→ask auto_retry_exhausted |
| verify/settle `coder_error:sandbox_denied/permission_denied/plan_invalid/scope_violation/budget_exhausted` | ask `coder_blocked` | 是=约束已处理，重跑里程碑；否=终止 |
| verify/settle 或 gate `budget_launches_exceeded`、`budget_tokens_exceeded` | ask `budget` | 是=增加上述一次 attempt 额度，再跑里程碑；否=终止；禁止自动重试 |
| verify/settle 未知 reason、产物缺失/损坏；gate 缺失 reason | ask `unknown_reason` | 是=重跑里程碑；否=终止；disposition 明记 unknown_reason |
| gate `*+review_limit` | ask `review_limit` | 是=再给一轮里程碑修复；否=终止 |
| gate `review_not_independent:*` | ask `review_not_independent` | 是=身份已处理，仅重跑本轮评审；否=终止 |
| gate `invalid_review`、`review_incomplete`、其他既有 gate 原因 | gate 自动重试 | 次数取 tiers auto_retry.gate，用尽→ask auto_retry_exhausted |
| gate `no_change` | 保留既有策略 | 连续两次→ask no_change；是=再给一轮；否=终止 |
| gate `deadline` / plan deadline 已过 | expire | 终止，不投提醒 |
| 自动重试用尽 / 旧工作流无 attempt / 恢复无进展 | ask 原行 | 原 fresh retry / resume 策略不变；否=终止 |
| environment / 非审批 paused / approval / human | 原行 | 原退避、≤2次 resume、是/否审批、签收流程不变 |

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
- 旧 pending asks 的两个真实 run 已 classified completed；展示口径改为 held:*，或 S3 接管策略内 failed（code/fix/verify/settle）且有未决 ask。completed/cancelled 旧 asks 不进“需要你”，running/owner_lost 也不被旧 asks 隐藏；没有关闭或改写源提问，S4 仍负责源头收尾。
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

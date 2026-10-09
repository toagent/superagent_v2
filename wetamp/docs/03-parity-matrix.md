# 功能对照表：旧 superagent（v2 守护进程版）→ 本方案（Archon 引擎 + wetamp 胶水）

用户 2026-10-09 要求：**旧版全部功能与遇到过的全部问题，本方案都必须解决**。本表是验收清单，每行在 `PROGRESS.md` 最终摘要里逐条打勾（✅ 已实现并有测试 / ⏭ 明确后置并说明）。
"由 Archon 原生承担" 的行不写代码，只在 selftest 里验证一次。

## A. 子命令（旧 `superagent --help` 全量）

| 旧命令                                        | 本方案                                                                                                                                                                                                                      | 阶段  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `run <plan> [--skip-selftest]`                | plan 校验 + preflight（磁盘、environment 命令、repo 白名单、`$SUPERAGENT_HOME/selftest.json` 7 天内有效否则拒绝，`--skip-selftest` 跳过）→ 生成 → `archon workflow run --branch sa/<run> --from <base_ref> --detach --json` | M1    |
| `selftest --repo <path> [--timeout] [--fake]` | `scripts/selftest.sh`（`--fake`：prompt 节点换成 bash 桩，不花模型额度）；通过后写 `selftest.json`                                                                                                                          | M0    |
| `wait [run] --timeout <s>`                    | `archon workflow wait` + `owner_lost` 自动 `recover`（§3）                                                                                                                                                                  | M1    |
| `status --brief` / `brief`                    | `workflow status/get --json` 压缩 ≤20 行：每里程碑状态、当前节点、评审结论摘要、评审债、证据路径                                                                                                                            | M1/M2 |
| `decide <pkg> approve`                        | `signal --event sa.human.<M>`（红线门）；非红线 run 没有可 approve 的东西，报错说明                                                                                                                                         | M2    |
| `decide <pkg> retry "hint"`                   | 把 hint 写到 `$SUPERAGENT_HOME/gen/<run>/.archon/hints/<pkg>.md`，`sa-code`/`sa-fix` 命令模板声明"存在则必读"，然后 `resume --detach`（失败节点重跑，已完成节点走缓存）                                                     | M2    |
| `decide <pkg> cancel [--force\|--cascade]`    | `workflow cancel`；`--force` 对 owner-lost 的 run 先核验 pid 死亡再 cancel                                                                                                                                                  | M1    |
| `cancel [run] [--force]`                      | 同上                                                                                                                                                                                                                        | M1    |
| `report` / `stats --since-days`               | 逐个 ledger `workflow get --verbose` 汇总：run 数、各里程碑评审轮次、一次通过率、失败分类（按节点 id 前缀）、owner-lost 恢复次数；token 后置                                                                                | M3    |
| `accept [run] [--pkg] [--quick]`              | 在该 run 的 Archon worktree 里本地执行 plan 的 `accept`/`accept_quick`，退出码即结果                                                                                                                                        | M2    |
| `playbook`                                    | 合并进 `brief`（证据路径清单）                                                                                                                                                                                              | M2    |
| `lessons`                                     | ⏭ 后置（经验沉淀走 `agent-evolution` 技能，不进引擎）                                                                                                                                                                      | —     |
| `capability` / `health`                       | `archon doctor` + 别名解析 + 作者≠评审断言 + `check-upstream-clean`                                                                                                                                                         | M0    |
| `land [run] [--each]`                         | 读 `land` 节点输出；`--each` 按里程碑分别打印                                                                                                                                                                               | M2    |
| `resume`                                      | `recover` → `resume --detach`                                                                                                                                                                                               | M1    |
| `gc [--dry-run]`                              | `scripts/gc.sh`（默认 dry-run，`--apply` 执行）：清理终态且已合入 run 的 Archon worktree、本地分支、`gen/<run>`、`runs/<run>.json`；Archon 自身记录用 `archon workflow cleanup`                                             | M3    |

## B. 旧版 hold / error_class → 本方案机制

| 旧状态                                                  | 本方案                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `held:review_missing`                                   | 评审节点由 Archon `retry` + `workflows.autoResumeOnQuotaReset` 自动重试；仍失败 → run failed，`brief` 标"评审缺席"，元帅 `resume --model @sa-reviewer=<另一厂商>` 切换          |
| `held:awaiting_signoff`                                 | 暂停在 `human-<M>` 事件门（§5）                                                                                                                                                 |
| `held:needs_decision`                                   | `vote-<M>` 平票或 `gate-<M>` escalate → run failed，`brief` 标红给用户                                                                                                          |
| `held:needs_diagnosis`（E3）                            | `verify-<pkg>` 失败后 `probe-<pkg>` bash 节点在 `base_ref` 临时工作树跑同一验收命令，输出 `{base_pass, candidate_pass}`；fixer 提示里带这份证据，基线预存失败不再被当成本包问题 |
| `held:disk` / `held:environment` / `disk_quota` / `env` | `run` 的 preflight 一次性检查，启动前失败                                                                                                                                       |
| `lost` / `lost_repeated`（E5/E9）                       | worker 死亡 = `owner_lost` → `recover`；`runs/<run>.json` 记恢复次数，同一 run 连续 3 次恢复且无新完成节点 → 停止自动恢复，`brief` 标红                                         |
| `external_write_unconfirmed`（E4）                      | run 在 Archon 自建 worktree + `sa/<run>` 分支上，主检出被外部自动提交推进不影响它；`land` 发现 `base_ref` 已前进时打印 rebase/merge 两套命令                                    |
| `review_limit`                                          | `gate-<M>` 三轮上限（§4.2）                                                                                                                                                     |
| `review_debt`（vote2 P-D：G1 中危不阻塞、记债）         | `reviewer-result.schema.json` 的 `debt[]`；`gate-<M>` 对 G1 只按 high 阻塞；`brief`/`report`/`land` 显示评审债                                                                  |
| `review_no_change`                                      | `fix-<M>-rN` 后 `diff-<M>` 哈希与上轮相同 → 直接 escalate，不再浪费一轮                                                                                                         |
| `no_progress`                                           | prompt 节点 `idle_timeout`                                                                                                                                                      |
| `deadline`                                              | plan `deadline` → 各 prompt 节点 `timeout` 与 run 级总时限（script 节点检查）                                                                                                   |
| `verification` + 失败指纹（E2）                         | `verify-<pkg>` 输出尾部哈希；连续两轮哈希相同 → 停止修复循环并 escalate（熔断由结构保证，不靠指纹算法）                                                                         |
| `sandbox_denied`                                        | 不适用（无沙箱）                                                                                                                                                                |
| `worktree_claim` / `git_operation`                      | Archon 负责 worktree；`land` 只打印命令                                                                                                                                         |
| `selftest_required`                                     | `run` 前置检查 `selftest.json`                                                                                                                                                  |
| `cancelled` / `upstream_cancelled`                      | `workflow cancel`；里程碑失败即 run 失败，不存在"下游包被上游取消"的半状态                                                                                                      |

## C. 效率诊断 E1–E9 → 本方案

| 问题                                            | 本方案                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| E1 57% 工时花在被取消的包                       | 合包 + 里程碑评审 + 结构化熔断（B 表 E2/E3 行），取消不再是默认出路                                       |
| E2 熔断永不触发                                 | 验收输出哈希连续相同即熔断（B 表）                                                                        |
| E3 归因靠人工                                   | `probe-<pkg>` 自动基线探测                                                                                |
| E4 外部提交闩锁                                 | worktree 隔离                                                                                             |
| E5/E9 杀进程留幽灵、槽位永久占用、wait 永不返回 | 无全局槽位账本（Archon 并发上限在 worker 进程内，进程死即释放）；`wait` 返回 `owner_lost`；`recover` 续跑 |
| E6 一次通过率 21%                               | hint 机制 + probe 证据 + 粗粒度包                                                                         |
| E7 排队 41%                                     | run 内串行、run 间并行（独立 worktree）；plan lint 对纯依赖链只告警                                       |
| E8 决策等待                                     | 无人值守：G2 评审过即放行、红线投提醒事项、其余 AI 投票                                                   |

## D. 由 Archon 原生承担（不写代码，selftest 验证）

DAG 与 `when`/`depends_on`、节点重试与 quota 自动恢复、worktree 与分支、detach/wait/signal/wake、runs 账本与 transcript、`output_format` JSON 校验、provider 并发上限、`idle_timeout`/`timeout`。

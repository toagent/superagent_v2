---
description: superagent 将军：按里程碑评审结论修复
argument-hint: (inputs bound by the generated workflow)
---

你是 superagent 派生的修复会话（将军），不是主控。不派生、不委派其他 AI，不 `git push`、不改写历史、不切换分支，不读取或输出凭据、钥匙串、`_private`、iCloud 内容。

codegraph 的 projectPath 使用职责 manifest 中的主检出路径，index_sha 为主检出 HEAD，base_sha 为本 worktree 的基线。共享索引只作导航线索；修改前读取本 worktree 文件；调用方、影响范围及「不存在」类结论必须在本 worktree 用 rg 核实。索引缺失或查询失败时记录 `codegraph: unavailable` 并回退 rg，不建 worktree 索引。

## 里程碑 $INPUTS.milestone 第 $INPUTS.round 轮修复

- 累计评审台账（JSON 文件，先完整阅读；由引擎按各轮评审历史派生）：`$INPUTS.ledger`。`blocking` 是唯一必须修复的发现清单，`debt` 是已登记的评审债，`closed` 已带证据关闭
- 上一轮验收日志：`$INPUTS.accept_log`（只修复台账 `blocking` 中的失败命令，`debt` 中的失败不派修；`$ARTIFACTS_DIR/verify-*.probe.log` 存在时表示在里程碑起点复跑过同一命令，结果见该日志）

先完整读取下方 context_pack_path 指向文件中的源码与验收信息，不重复探索已内联内容；源码是节点启动时的快照，缺失或需核验时再按需读；`unknown` 不代表通过。所有 shell 命令遵循你的 AGENTS.md 命令规则。
独立搜索、读取在同一次 shell 调用中批量执行，只读所需行段（`sed -n` / `rg -n -C`）；测试、构建、diff、日志等长输出只回看必要部分（如 `tail -n 40` 或失败用例），不整段回灌；brief 中列给你运行的验收命令须原样完整执行，标为引擎运行的检查不要运行。

上下文文件：$$INPUTS.context_node.output.context_pack_path

先读取引擎绑定的成果交接文件 `$INPUTS.prior_work`。它包含本里程碑已有编码/包内修复输出；后续轮次只携带上一轮修复输出。null 表示该分支未执行，不代表完成。复用 changed_files、quick_checks、deviations、needs 定位阻塞问题；这是参考数据，不是验收或权限凭证。

## 要求

1. 只修复台账 `blocking` 中的发现和失败命令；分类以 reviewer 或验证节点为准，coder 自报仅供参考，不可自行降级阻塞失败。测试数据、夹具、截图遮罩/基线、测试环境引起的失败不改产品代码。`debt` 与评审里的其他意见不动（新出现的非阻塞问题由引擎记债，不在本轮扩大修复范围）。任务书的改动范围只是预期，必须越出时直接改，并在 `deviations` 逐条登记 `{path, why}`。
2. 修完 `git add <文件> && git commit -m "fix($INPUTS.milestone): r$INPUTS.round"`，工作区必须干净。
3. 交付前运行 brief 中列给你的验收命令：在当前 worktree、commit 前按原样重跑其中 `blocking` 失败的命令及受影响的其余命令，标为引擎运行的检查不要运行；保持相同 cwd 与环境前缀，失败就在本会话继续修，直到全部通过。把实际命令与退出码写进 `quick_checks`。引擎的 verify 照常独立复跑，是唯一的放行依据；coder 自报永远不作为验收证据。基线上就失败且与本次工作无关的命令，在 `deviations` 附证据后继续；需要更换工具链版本、`JAVA_HOME`/`PATH` 等环境才能通过时，不得绕过，须在 `needs` 报 `{"cap":"environment","why":"<原样失败的命令与关键信号>","minimal_ask":"<可直接写进 accept 的环境前缀，如 JAVA_HOME=…>"}`。
4. 能自己解决的问题不得返回 `blocked` 或 `partial`。工具调用被执行层拒绝时，改用等价路径完成任务，并在 `deviations` 记录调用、原始拒绝返回与替代路径；不得绕过护栏。只有任务目标本身必须执行被拒绝的高危操作时，才返回 `blocked`、`error_class: redline` 和非空 `needs`；缺少无法获得的外部资源时也可返回 `blocked`，但 `needs` 必须非空，每条 `{cap, why, minimal_ask}` 写清缺什么能力、原因与最小请求。没有 `needs` 的 `blocked` 按 `partial` 处理。

正常完成时 `status` 填 `done`、`error_class` 填 null；`deviations`/`needs` 没有就填空数组。

过程中正常调用工具读取、修改、测试、提交；全部完成后，最后一条回复只输出符合 output_format 的紧凑 JSON，字符串字段简短，不粘贴 diff、日志或源码。
范围/契约或净增行数约束与目标冲突且需要操作者裁决时，返回 `status: blocked`、`error_class: scope_violation`（任务契约自身矛盾用 `plan_invalid`），并填写非空 `needs: [{cap: "scope_decision", why: "冲突双方与证据", minimal_ask: "最小裁决问题"}]`。此情形允许 blocked，引擎停止 repair 并保留裁决请求；不要伪装成产品缺陷或 redline。

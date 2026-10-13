# 本地交付，人工 push

新 `run` 与 `quick` 在启动时记录 `plan.repo` 对应 checkout 的当前分支和 HEAD。
`base_ref` 只控制开发基线。Claude/Codex 共用同一条交付路径。

```sh
superagent quick --goal '修复问题' --accept 'bun run check' --scope 'src/**' --repo /path/to/repo
superagent wait <run> --timeout 1500
superagent land <run> --apply
```

`wait` 仅对有启动目标绑定的真实 run 自动 finalize；legacy/fake 明确报告 unknown。
终态 JSON、quota 与执行 exit 保持权威；真实交付失败单列 blocked 与原始原因。
`land --apply` 可显式重试，legacy 保留原候选验收及审计路径。
Run completed 仍由引擎独占写入。交付失败不改 Run 的终态，且不能理解为已合入。
只有 completed run、completed land 节点及真实生成验收证据齐备才执行。
候选验收继续调用 `acceptRun` 与单一 `deliveryDecision`，G2/strict 不降级。

交付使用原 `applyLand` 的 common-dir/target lease、scratch merge、mergiraf、
候选验收和目标漂移检查。目标目录切换分支、启动后的目标 HEAD 漂移、dirty、
source HEAD 漂移或冲突均拒绝；保留用户文件与 source worktree。
`main/master/dev/develop/release-*` 不允许自动交付；`wetamp` 可正常交付。
自动交付仅原 owner 可执行，沿真实 run 的公开 admission、intervention 审计与
controller 落账边界；wait 不自动 claim 或接管其他负责人。

成功回执在 run artifacts 的 `delivery.json`，绑定任务、source SHA、原目标、
验收合同哈希、验收证据目录、候选 SHA、target tip 与实际 integrated SHA。
`status: manual_push` 表示已验收、已本地合入、待人工 push。
回执仅是投影，不授予权限。重复调用先核对 Git ancestry/tree；已合入不再
merge、install 或验收。只有完整匹配实际集成点的旧回执可恢复 manual_push；
回执丢失、损坏或目标后续改变时，报告 already integrated、acceptance unknown，
保留实际 SHA、来源与人工 push 说明，不伪造 accepted。快进保留原 commit；
非快进 merge message 使用任务标题及合同摘要，不调用模型生成说明。

所有新编码需求统一使用 `quick`（直接需求）或 `run`（已有计划），共用验收与 landing。
已验收 source 再次交付使用 `land --apply`。裸 `job exec` 仅为支持作业，
exit 0 不代表代码已验收；`--task-kind code` 明确拒绝并指向 `quick`，
不提供 codejob adapter 或 `job finalize`。

CLI JSON 回执包含完整 `push` 命令，由用户人工执行。程序不执行 push、PR、
远端 comment、发布或全局 hook 安装；`supervise-tick` 暂不触发交付。

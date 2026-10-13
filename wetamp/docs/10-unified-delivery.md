# 本地交付，人工 push

新 `run` 与 `quick` 在启动时记录 `plan.repo` 对应 checkout 的当前分支和 HEAD。
`base_ref` 只控制开发基线。Claude/Codex 共用同一条交付路径。

```sh
superagent quick --goal '修复问题' --accept 'bun run check' --scope 'src/**' --repo /path/to/repo
superagent wait <run> --timeout 1500
superagent land <run> --apply
```

`wait` 返回 completed 时调用本地 finalize；`land --apply` 可显式重试。
Run completed 仍由引擎独占写入。交付失败不改 Run 的终态，且不能理解为已合入。
只有 completed run、completed land 节点及真实生成验收证据齐备才执行。
候选验收继续调用 `acceptRun` 与单一 `deliveryDecision`，G2/strict 不降级。

交付使用原 `applyLand` 的 common-dir/target lease、scratch merge、mergiraf、
候选验收和目标漂移检查。目标目录切换分支、启动后的目标 HEAD 漂移、dirty、
source HEAD 漂移或冲突均拒绝；保留用户文件与 source worktree。
`main/master/dev/develop/release-*` 不允许自动交付；`wetamp` 可正常交付。
owner admission 沿真实 run 的公开 coordination 边界，不自动接管其他负责人。

成功回执在 run artifacts 的 `delivery.json`，绑定任务、source SHA、原目标、
验收合同哈希、验收证据目录、候选 SHA、target tip 与实际 integrated SHA。
`status: manual_push` 表示已验收、已本地合入、待人工 push。
回执仅是投影，不授予权限。重复调用依据 Git ancestry，仍验证实际候选；
合入后回执写失败也可重试恢复，source 保留用于核对。快进保留原 commit；
非快进 merge message 使用任务标题及合同摘要，不调用模型生成说明。

直接需求首选 `quick`。窄 codejob adapter 只支持**已有关联 run worktree**：

```sh
# 在该 run 的 source worktree 中运行；run 必须有新目标绑定。
superagent job exec --title '继续实现' --task-kind code --delivery-run <run> -- <command...>
superagent job finalize <job-id>
```

codejob exit 0 只表示开发尝试成功，最终 source 必须与真实 completed run 的 land
证据一致，再消费该 run 的验收合同。不支持用作者 JSON、自填 receipt 或任意
验证命令替代合同；新独立任务应使用 `quick`，不是裸 job 的自动验收。
`--task-kind read_only`、legacy job、legacy ledger 缺绑定时不自动合入。
job 回执为同一 artifacts 目录下的 `delivery-job-<id>.json`，不改变 Job.state。

CLI JSON 回执包含完整 `push` 命令，由用户人工执行。程序不执行 push、PR、
远端 comment、发布或全局 hook 安装；`supervise-tick` 暂不触发交付。

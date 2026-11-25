# agy 流式回放

`success.ndjson` 取自 [官方 Headless 文档](https://antigravity.google/docs/cli/headless) 的流式 JSON、工具调用、结构化输出示例。文本拆成两段，模型与会话标识换成测试值。

`denied.ndjson` 取自 2026-11-20 的 agy 1.5.13 隔离采样。全局 `PreToolUse` 拒绝读取测试文件。工具步骤为 `ERROR`，错误类型为 `TOOL_ERROR`，进程退出 0 且终态为 `SUCCESS`。夹具保留事件结构并简化标识、诊断与回复。

`outage.ndjson` 与 `outage.stderr` 取自 2026-11-25 的真实 agy 本地假网关实验。网关始终返回 HTTP 503，agy 重试后以退出码 3 结束。stdout 仅替换工作目录，stderr 保留结构化 `AGY_ERROR` 行。

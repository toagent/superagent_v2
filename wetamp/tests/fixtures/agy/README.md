# agy 流式回放

`success.ndjson` 取自 [官方 Headless 文档](https://antigravity.google/docs/cli/headless) 的流式 JSON、工具调用、结构化输出示例。文本拆成两段，模型与会话标识换成测试值。

`denied.ndjson` 取自 2026-11-20 的 agy 1.5.13 隔离采样。全局 `PreToolUse` 拒绝读取测试文件。工具步骤为 `ERROR`，错误类型为 `TOOL_ERROR`，进程退出 0 且终态为 `SUCCESS`。夹具保留事件结构并简化标识、诊断与回复。

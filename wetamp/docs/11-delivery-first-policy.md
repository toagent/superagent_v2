# Budget observation

预算只保留用量统计、报表与 `superagent.budget_observed` 告警，不阻止启动、fallback 或交付。
旧 plan 中的 `enforcement` 字段被忽略，不再申请或追加额度。
`budget_floor` 仅在缺少用量回执时提供保守估算，不用于准入。

run 数量、provider 并发、内存和磁盘不作为 superagent 准入门槛。
内存在 job 记录中观测；磁盘在 run 启动时输出 `superagent.disk_observed`。
启动身份登记、run-admission 锁及高危操作护栏保持有效。

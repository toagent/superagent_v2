# Plan 与交付默认值

`repo`、`base_ref`、`packages` 必填；`deadline` 与 `budget` 可省略。
缺省预算由 `loadPlan` 一次归一为 `weighted_tokens: 0`、`unlimited_tokens: true`，保留用量统计，不限制 token。预算阈值只产生 `superagent.budget_observed` 告警；旧文件的 `enforcement` 字段会被忽略。

未提供 deadline 表示没有到期时间；quick 不再自动设置 24 小时期限。显式 deadline 仍约束生成、验收、签收、合入与监督。人工提醒的有限 TTL 不构成 run 的截止时间。

run/quick 保留 controller 安装与磁盘空间检查，不读取 selftest 回执或自动启动诊断；land 也不自动刷新 selftest。需要诊断时显式运行 `wetamp/scripts/selftest.sh`。

paused run 不占启动容量；pending/running 与未知状态仍计数，身份不明的启动预留仍拒绝准入。恢复继续使用原生执行锁、owner 核验与执行资源准入。G2、strict、显式评审、human 签收与真实验收保持原契约。

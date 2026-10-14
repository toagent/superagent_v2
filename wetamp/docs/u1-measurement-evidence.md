# U1 测量单源交付证据

`ledger-metrics.ts` 复用并集中原有 UTC clock、plan 读取、firstPass、critical-path 和 measurement 公式。report 和 board 共用安全 snapshot，report/cockpit 共用今日 metrics；原生终态时间独立于看板 held 展示计时。缺失、不可读或 stale 数据保留 unknown。没有新增依赖。

## 只读真实报表对照

改动前：`SUPERAGENT_RELAY_QUOTA=off superagent report --json`，输出 `/tmp/u1-before.json`。
改动后：`SUPERAGENT_RELAY_QUOTA=off wetamp/bin/superagent report --json`，输出 `/tmp/u1-after.json`。

以上为当时命令；当前复现明细时添加 `--full`，默认 `report --json` 仅输出摘要。
同一保留数据集合：325 个 run、4081 个节点；分母为全部节点或全部 run，未剔除失败/取消。输出仅用于本地聚合，不提交原始生产数据。两个采样命令分别使用已安装 CLI 与本 worktree CLI；不是冻结数据库的离线回放，不据此宣称运行提速。

| unknown 字段             | 改动前             | 改动后             |
| ------------------------ | ------------------ | ------------------ |
| explore_ratio            | 3990/4081 (97.77%) | 3374/4081 (82.68%) |
| hold_ms                  | 324/325 (99.69%)   | 98/325 (30.15%)    |
| idle_ms                  | 324/325 (99.69%)   | 98/325 (30.15%)    |
| cancellations.unrecorded | 52/52 (100%)       | 52/52 (100%)       |

历史取消没有原因，不能补造；今后 cancel 的成功记录默认写 unstated，显式 reason 只接受 CLI 中的闭集。已注册 run 的失败操作继续由 append-only intervention 记录。

## 输出契约和验证

`measurement.<run>.critical_path_ms` 改名为 `wall_clock_ms`，表示墙钟；`critical_path.<run>.critical_path_ms` 保持分段和语义。仓库内旧墙钟字段消费者只定位到 `tests/report.test.ts`，已更新；仓库外消费者无法由本包证明不存在。其余原有 JSON 字段保留；`metrics.firstPass_unknown` 两端保留，provider timing 新增 `unrecognized_actions`，board 原生完成时间新增 `completed_at`。metrics 统一按操作者当地“今日”窗口，不再把 report 累计 completed 与 cockpit 今日达成混为一谈。

回归覆盖 Asia/Taipei 下 SQL/ISO 混合 UTC、segments 的 hold/idle、board/report firstPass（含 recovery）、真实终态却显示 held 的 decided、report/cockpit 完整 metrics 相等、缺失证据 unknown、解析失败动作保留分母、cancel 默认原因及闭集拒绝。自检不替代引擎独立 verify。

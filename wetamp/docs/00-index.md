
### 交付投入报告

`plan.request_ref` 是调用者明确传入的跨尝试需求引用（例如 issue URL）；生成的 plan 快照保留它，report 不从标题、goal 或包 ID 推断关联。旧 plan 保持兼容，需求归属记 unknown。`report.demands` 按引用计全部 run 尝试，包括失败/取消；完成度仅投影引擎 deliveryDecision，历时包含尝试间等待。

`usage.ts` 是报告 token 归一 owner：Archon 的 provider 回执已经是 gross input 和逐 turn 差分，不再次加缓存；ccusage Claude 的 raw input 加 cacheRead/cacheWrite，Codex cache 与 reasoning 分别属于 input/output 子集。累计 session 快照取末次记录，不与同 session 的 engine 回执相加。`usage.receipts` 保留原始分项与实际 provider；缺调用身份时总投入去重记 unknown，费用缺回执也记 unknown。共享学习投入在期间单列，不分摊给需求；policy tokens 不是账单。

`critical_path` 只读取 run 记录的冻结源及真实时钟，按依赖选择实际阻塞路径并与 run 历时对账，不累加并行资源时间。图/时钟缺失、重复 attempt、loop 或条件节点无法对应时记 unknown；未分类等待保留在历时内，不能据此声称人工等待、重启或生产 ROI 已获证明。

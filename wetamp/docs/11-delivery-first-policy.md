# Delivery-first budget policy

Wetamp 的 `plan.budget.enforcement` 可选 `observe` 或 `hard`。
省略时（包括旧 plan）默认 `observe`：launch/token 超额只产生结构化
`superagent.budget_observed` 告警，不阻止下一次调用、fallback 或已完成结果。
真实 attempts、tokens 与累计 usage 继续记录；未知用量仍按既有规则预留。
告警仅包含节点、额度和用量，不包含用户内容。

只有操作者明确选择 `hard` 才启用前后预算拒绝和生成期 package floor 校验。
`unlimited_tokens: true` 只豁免 token；hard 的显式 launch 限制仍生效。
旧 grant 沿用 plan 的 enforcement 与 token 豁免，不能把 hard 降成 observe。
通用 Archon dispatcher 的直接调用者未指定模式时仍保留原 hard 语义。

`quick` 生成 `weighted_tokens: 0, unlimited_tokens: true`，不附加 launch 上限。
默认 coder 的 `max_attempts` 为 3，沿既有 typed `transient` 通道重试；
不根据报错 prose 重试 product/fatal，也不增加无限循环。

## 交付门槛普查

- 预算：默认仅观察；显式 hard 保留。
- G1：已有默认无独审、无额外人工签收，保持原实现。
- 首次瞬态 coder 失败：默认允许共 3 次尝试。
- score：未发现实际引擎门槛，不增加配置。

安全/权限、真实产品验收失败、脏目录、冲突、deadline、显式 human signoff、
strict/G2 评审与既有 MAX_ROUNDS=3、无进展约束仍有效。
`git push` 仍由人工执行，预算观察不意味着验收通过。

## 已冻结 run

不修改旧 run 的 plan/context/review/验收产物。
升级引擎不会重写既有冻结脚本；由 run owner 经官方 `recover`/`decide`
边界处理后续执行，不能靠直接修改冻结文件或接管他人 run 应用新策略。

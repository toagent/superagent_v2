# 第一宪法：任务执行以效率为本

任务时长 T = Σ轮次 ×（模型往返 × 时延）+ 引擎开销 + 等待。
效率以达成验收所需的总投入衡量，不能靠省略验收降低表面耗时。

## 五条不变量

1. 合法等待是以下三类闭集：
   执行层明确拒绝的红线：以本节点任务书和动作入口的实际拒绝为准。
   原生 hooks 仅拒绝凭据隐私与不可逆破坏；再委派、普通发布或进程操作本身不构成 hook 等待边界。
   操作者显式声明：paused / held:paused、cancelled_source，尊重暂停或取消决定；
   plan 中工作包声明 signoff:"human" 时才允许 held:human / signoff / approval。
   自动补环境后仍缺外部资源的 held:environment，等价于带 needs 的 blocked。
   普通任务不得因排队、准入、配额、预算或未声明的人工 hold 等待。
2. 一次做对：coder 在交付前跑通验收命令；verify 只做独立确认。
   仅实际 diff 命中评审白名单（risk_paths 等运行期高危变更）或包声明非空 review_reason 时执行评审；
   声明 G2、strict 或 review:true 均不单独触发评审。
3. 引擎零误伤：内部辅助步骤故障不得被判成工作包 acceptance_failed。
   诊断缺失如实记录为引擎或诊断问题，不冒充产品验收失败。
4. 故障即改派：可分类的厂商故障换厂商继续，AI 节点使用 transient retry。
5. 测量驱动：每次 run 的 report 用 efficiency budget 与 slow_nodes 暴露回退。

## 修改规则

改变任一不变量须用户明确决定，并在同一提交中修改本文件与
`wetamp/tests/efficiency-constitution.test.ts` 的对应一致性测试。
测试必须消费类型、原因注册表或生成结果，不用源码关键字搜索代替行为断言。
测试不调用真实 provider，不联网；失败不得通过放宽闭集或改成跳过掩盖。

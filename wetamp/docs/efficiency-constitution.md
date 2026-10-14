# 第一宪法：任务执行以效率为本

任务时长 T = Σ轮次 ×（模型往返 × 时延）+ 引擎开销 + 等待。
效率以达成验收所需的总投入衡量，不能靠省略验收降低表面耗时。

## 五条不变量

1. 合法等待是以下三类闭集：
   高危六类：销毁任务范围外数据、改写共享历史、对外不可撤回（push/发布/部署/外部消息）、
   凭据与隐私、越权（按名或端口杀进程、改护栏/配置）、派生会话再委派。
   操作者显式声明：paused / held:paused、cancelled_source，尊重暂停或取消决定；
   plan 中工作包声明 signoff:"human" 时才允许 held:human / signoff / approval。
   自动补环境后仍缺外部资源的 held:environment，等价于带 needs 的 blocked。
   普通任务不得因排队、准入、配额、预算或未声明的人工 hold 等待。
2. 一次做对：coder 在交付前跑通验收命令；verify 只做独立确认。
   G0/G1 + auto 的 review 节点以运行期 G2 风险守卫默认跳过，触及 G2 时升级；
   G2、strict 或 review:true 执行评审，不加 G2 升级守卫。
3. 引擎零误伤：内部辅助步骤故障不得被判成工作包 acceptance_failed。
   诊断缺失如实记录为引擎或诊断问题，不冒充产品验收失败。
4. 故障即改派：可分类的厂商故障换厂商继续，AI 节点使用 transient retry。
5. 测量驱动：每次 run 的 report 用 efficiency budget 与 slow_nodes 暴露回退。

## 修改规则

改变任一不变量须用户明确决定，并在同一提交中修改本文件与
`wetamp/tests/efficiency-constitution.test.ts` 的对应一致性测试。
测试必须消费类型、原因注册表或生成结果，不用源码关键字搜索代替行为断言。
测试不调用真实 provider，不联网；失败不得通过放宽闭集或改成跳过掩盖。

## 当前验证 notes（2026-10-14）

budget_floor 仅为 budgetUsage 的加权观测下限，不是准入或停机门槛。
预算超限应只产生 advisory；完整处置入口未导出，对应行为断言暂为 test.todo。
classify/holdOf 不读取 plan；human 签收声明由生成器绑定并验证。
内部 probe 没有注入接口，故障归因断言暂为 test.todo，不修改产品行为。
未运行完整 fake 引擎链路；不把生成耗时当作引擎开销，不设置未经实测的上限。

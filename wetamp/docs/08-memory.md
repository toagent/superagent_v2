# 经验资格与反思回执

memory 保存 episode、候选、反馈及去重记录。helpful/harmful/votes 仅供候选排序，
不授权 stable，也不回写历史 status。只有已完成且全部正式验收为 true 的运行可计 helpful；
失败、取消、验收未知不算成功证明。旧冻结上下文与事件保持原样。

生产提示当前关闭经验消费，普通交付无需共享 home 或 agent-evolution 数据库。
trial 和无发布证明的 legacy stable 都不会进入新 brief、角色命令或 plan 提示。
候选检索仍供受限反思使用；这不代表生产学习已经完成。

## 控制面出口缺口

已核对 agent-evolution 的 Engine.export / snapshot_recall：export 仅含 schema、fingerprint、
stable、revision、audit_head/count、exported_at 与 checksum。它未携带原始证据副本、
来源执行回执、评审 assessments 或可鉴别发布者权限的通道。
自洽的 checksum、revision hash、audit hash 或自报分数不能证明资格；因此本包不增加一个
可由任意 caller 传入 JSON 后生效的导入入口，也不读取真实共享数据库或晋升实际经验。

最小后续适配由现有控制面 owner 完成：从已通过门禁的 revision 发布不可变 artifact，
绑定版本/hash、明确适用范围、反例与有效期，携带获准非私密原证据副本和来源执行回执、
资格门禁回执；发布通过受授权的控制面通道，权限不能靠 artifact 的 publisher 字段自证。
运行面需重算证据副本 hash 并核对来源关联、资格、scope、反例、过期与撤回后才能选择；
新 run 固定有限提示投影及版本/hash，撤回仅影响新选择。该入口属于 G2 权限边界，
须独立工作包及合格评审；本包未实施该权限变更，资格仍为 unknown，不能声称合格消费已通过。

## 反思

复用 job exec 的队列、内存准入、执行收据和既有 token 预算；无新 worker 平台。
普通首次成功可跳过，按 project/tag/category/signature 去重，记录过的尝试不自动重派。
追加 reflection 回执区分 queued、running、produced、rejected、failed、interrupted；
reflected 仅在模型成功返回后写入，空/非法输出为 rejected 而非候选。
崩溃后残留 queued/running 是未完成回执，不猜测活 owner、不把它当成功、不自动重试。
旧 reflected 标记继续读取且不回写。每日预留 9216，已知实际用量保留超额，未知 usage
明确为 null 且保留预留预算；模型调用仍登记在现有 jobs 用量链中。

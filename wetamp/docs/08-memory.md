# 经验资格与反思回执

memory 保存 episode、候选、反馈、publication 与去重记录。helpful、harmful 和 votes 只用于
候选排序，不授权 stable，也不改写 run 状态。只有完成且全部正式验收为 true 的运行可以提供
正向证据；失败、取消、缺证据和验收 unknown 都不能证明成功。

普通交付不依赖共享 home 或 agent-evolution 数据库。publication 缺失、过期或校验失败时记为
unavailable，不阻断交付，也不降级使用未经资格确认的候选。

## 发布

可信 controller 显式运行 memory publish。发布器只调用固定安装位置的 agent-evolution
`verify`、`export`、再次 `verify` 和 `snapshot-recall`。schema、fingerprint、checksum 或
audit count 不一致时拒绝，现有 publication 保持不变。

成功后原子写入 `$SUPERAGENT_HOME/memory/publication.json`；目录权限 0700，文件权限 0600。
不接受任意 JSON 导入或由候选自证 publisher。撤回时删除 publication，恢复后重新发布。

## Run 消费

每个 run 启动时从一次固定 publication 副本选择经验，运行面不读取资格数据库。scope 是
`project:<realpath plan.repo>`，domain 是 engineering。query 使用完整 goal 与 requirements；
超过上限时明确 unavailable，不截断后猜语义。

controller 校验 schema、checksum、fingerprint、新鲜度、scope、shareable 与 expiry。每包选择
数量和字节数有界，结果冻结到 `gen/learning.json`，`engine.json.lessons` 保存 ID 映射。
编码、修复与评审 manifest 消费同一选择。经验是 data-only：适用条件、排除条件、期限和证据
不能授予工具、权限或原则。publication 后续变化不重写在途 run。

## 反思

controller 可显式运行 memory propose，为终态 run 生成候选。request 指定 lesson、package、
证据 sha256、shareable、keywords、positive、negative 与 expires_at。候选必须精确引用该 run、
project scope 和已有 claim；不能替换证据中的作者、模型或事实。

唯一证据原件是该 run 的 package verify JSON，且必须位于项目或 `SUPERAGENT_HOME` 内。
系统拒绝 symlink、路径逃逸、隐私路径、缺失、不可解析、过大和 hash 不符；不会输出原文。
原件字节与 provenance 冻结到 `memory/evidence/<task>/`，proposal 只引用冻结副本。

模型身份来自引擎 invocation、attempt、provider 与 resolved model，不信任 requested model 或
候选自报。重试身份不明确时拒绝。propose 与 evaluate 产出的 prepared 仅表示待审；晋升仍需
可信控制面的独立证据与评审。

反思复用 `job exec` 的队列、内存准入、usage 与执行回执。状态区分 queued、running、
produced、rejected、failed、interrupted；只有合法模型输出才记 reflected。崩溃后残留的
queued/running 保持未完成，不猜 owner、不自动重派。未知 usage 保持 null，并保留预算预留。

## 完整性与恢复

fingerprint 漂移时拒绝消费，不通过修改 fingerprint 或 assessment 恢复资格。需要重建时先保存
可审计数据，再由 controller 建独立数据库，使用仍可核验的原始证据重新 evaluate、评审和
promote。缺原证据的条目只保留为历史数据。verify 证明结构完整性和当前资格，不重新证明事实。

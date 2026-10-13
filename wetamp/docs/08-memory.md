# 经验资格与反思回执

memory 保存 episode、候选、反馈及去重记录。helpful/harmful/votes 仅供候选排序，
不授权 stable，也不回写历史 status。只有已完成且全部正式验收为 true 的运行可计 helpful；
失败、取消、验收未知不算成功证明。旧冻结上下文与事件保持原样。

普通交付无需共享 home 或 agent-evolution 数据库；publication 缺失或拒用时为 unavailable，
不阻断交付，也不回退到 trial、legacy stable 或 votes。候选检索仍供受限反思使用。

## 显式发布与冻结消费

可信本地控制面执行 `superagent memory publish`，仅调用固定安装位置的 agent-evolution
`verify`、`export`、再次 `verify` 和 `snapshot-recall`，资格仍由该 owner 判断。
版本、fingerprint、checksum 或 audit_count 不一致则拒绝，失败不替换旧 publication。
成功后原子发布原 export schema 到 `$SUPERAGENT_HOME/memory/publication.json`，
目录 0700、文件 0600。无任意 JSON 导入或自证 publisher 字段；同账户管理员属于可信边界，
这些权限不隔离同账户管理员。可删除 publication 撤回，或由既有 rollback 后重新 publish。

新 run 仅从一次固定 publication 副本通过 owner 的 `snapshot-recall` 选择，运行面不读资格 DB。
scope 为 `project:<realpath plan.repo>`，domain 为 engineering；不猜旧 namespace。
query 为完整 goal 与 requirements 文本，超过 2000 字符明确 unavailable，不用正则分类或截断。
owner 校验 schema、checksum、fingerprint、7 天新鲜度、scope、shareable 与 expiry；
每包最多 5 条、12000 bytes。私有项目和 `SUPERAGENT_MEMORY=off` 禁用。
`gen/learning.json` 固定版本、hash、条目与 ID，`engine.json.lessons` 保存 ID 映射。
将军、修复与军师真实 manifest 的 learning 字段按 execution.packages 消费同一冻结选择。
适用/排除条件、有效期和证据引用作为 data-only 数据保留，不赋予工具、权限或原则；
语义适用性仍由执行者判断。后续 publish 或撤回不会重写旧 run；旧 run 缺文件兼容为空。

旧库 fingerprint 漂移必须拒用，不能改 fingerprint 或历史 assessment 恢复资格。
先备份历史，再由控制面建独立新库，使用仍可核验的原证据重新 evaluate、独立双评审、promote。
缺原证据的条目留历史，不晋升。verify 仅证明完整性与当前资格版本，不重新证明事实语义；
隔离夹具通过不代表旧库经验已重评，unknown 仍为 unknown。

## 反思

复用 job exec 的队列、内存准入、执行收据和既有 token 预算；无新 worker 平台。
普通首次成功可跳过，按 project/tag/category/signature 去重，记录过的尝试不自动重派。
追加 reflection 回执区分 queued、running、produced、rejected、failed、interrupted；
reflected 仅在模型成功返回后写入，空/非法输出为 rejected 而非候选。
崩溃后残留 queued/running 是未完成回执，不猜测活 owner、不把它当成功、不自动重试。
旧 reflected 标记继续读取且不回写。每日预留 9216，已知实际用量保留超额，未知 usage
明确为 null 且保留预留预算；模型调用仍登记在现有 jobs 用量链中。

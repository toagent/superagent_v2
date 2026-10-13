# 交付默认值

普通操作默认允许。Git 不按任务 root、claim、分支名、add -A、--no-verify、amend、config 或正常 push 拒绝；调用者仍遵守用户要求，由人工 push。文件归属与派发上下文限制只提示。run 生命周期授权与共享资源锁保持不变。

Git 危险判定唯一入口为 `hooks/git-danger.cjs`，项目 hook 与三端兼容 wrapper 都复用现有 shell AST 和安全删除查询。强推、删除远端、丢弃非任务数据、删除未保留提交仍受保护。凭据隐私保护保持不变。reviewer 的 Git 只读由原生 readonly sandbox 执行，不重复加 Git 门禁。

预算默认 observe；G0/G1 无默认独立评审；签收默认 auto。G2、strict 与显式评审要求仍走合格独立评审。

主控合入并确认整套 hooks/依赖后，备份现有脚本，再执行 `ln -s <已合入仓库>/wetamp/hooks/git-guardrail.sh ~/.wetamp/bin/git-guardrail.sh`。wrapper 经 symlink 定位相邻 tracked 入口；也可用 `SUPERAGENT_GIT_GUARD` 显式指定入口。不要只复制 cjs 单文件，AST 依赖和相邻模块必须可解析。本工作包不修改 live 脚本、配置或 core.hooksPath。

只读检查发现 live pre-commit 仍包含 secret 扫描、>10MB 自动 LFS/失败阻断、>500MB 阻断和本地 husky/lint-staged 链接检查；大文件/LFS 与本地检查属于现存非危险提交门槛，须主控另行决定安装变更。

当前 worktree 的有效 `core.hooksPath` 为 `.husky/_`；只读检查的 `~/.wetamp/git-hooks/pre-commit` 不代表它已在本检出启用。

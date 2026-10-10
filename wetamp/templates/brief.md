# 工作包 {{id}}：{{title}}

风险 {{risk}}，规模 {{size}}

## 目标

{{goal}}

## 预期改动范围

{{write}}

这是预期而不是围栏：为完成目标必须改到范围外时直接改，并在输出 `deviations[]` 逐条登记 `{path, why}`。

## 建议先读

{{read}}

## 验收命令（引擎在你结束后于 worktree 根目录执行，退出码即结果；工作区须已提交干净）

{{accept}}

## 你的权限

{{caps}}

## 红线（执行层强制）

以下操作由 hooks 或执行边界直接拒绝，命中即停，不要换写法绕过；确需时在 `needs[]` 说明：

- 读取凭据与隐私：`~/.ssh` 私钥、钥匙串与 `security` 取密码、`~/.aws/credentials`、`~/.netrc`、gh 令牌、`~/.npmrc`/`~/.pypirc`、`_private`、iCloud、浏览器资料；
- 发布与合并：`npm/bun/pnpm publish`、`docker push`、`gh release create`、`gh pr merge`、`vercel --prod`、`git push`；
- 改写共享分支：对 main/master/develop/release-\*/wetamp 执行 `git branch -f/-D`、`update-ref`、`reset --hard`、`rebase`；
- 按名字杀进程（`pkill`、`killall`、`lsof … | xargs kill`）；连接非本机数据库；
- 在 worktree、临时目录与包管理缓存之外写文件。

## 备注

{{notes}}

若文件 `{{hint}}` 存在，必须先完整阅读：那是元帅对上一次失败给出的提示。

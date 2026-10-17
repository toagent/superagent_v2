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

交付前在当前 worktree 按原样运行本包全部命令一次（不跑额外全量）；引擎会独立复验，结果与失败用例会回传给修复节点。命令通过不代替逐项核对需求的实现位置与对应测试。

新增测试上限（除非任务备注另有明确要求）：{{test_cases}} 个用例、{{test_lines}} 行测试代码。

{{accept}}

## 你的权限

{{caps}}

## 红线（执行层强制）

以下操作由 hooks 或执行边界直接拒绝，命中即停，不要换写法绕过；确需时在 `needs[]` 说明。拒绝消息若给出“可以：…”的补救方式（例如改用明确的本任务路径），且目标仍属本任务，按建议改写重试一次不算绕过、也不是红线；补救后仍被拒才停：

- 读取凭据与隐私：`~/.ssh` 私钥、钥匙串与 `security` 取密码、`~/.aws/credentials`、`~/.netrc`、gh 令牌、`~/.npmrc`/`~/.pypirc`、`_private`、iCloud、浏览器资料；
- 发布与合并：`npm/bun/pnpm publish`、`docker push`、`gh release create`、`gh pr merge`、`vercel --prod`、`git push`；
- 改写共享分支：对 main/master/develop/release-\*/wetamp 执行强制改写分支、删除、update-ref 或 rebase；非本任务检出的 hard reset / clean；删除别人的分支。本任务检出的 reset / clean 可放行；
- 按名称、模式、端口或全部选择进程；可对明确 PID 发信号；
- 提权，修改护栏、hook 或 agent/provider 配置；
- 销毁或覆盖不属于本任务的已有数据；worktree、临时目录、包缓存与本 run 产物可写；范围外新建文件可放行，但配置、系统目录与其他检出受保护。

`error_class: redline` 只用于上面这些安全边界。命令前缀（如 `rtk`）、输出格式、提交说明等过程规范的偏差不是红线：补正后继续，必要时在 `notes` 说明。之前轮次或会话里的红线自报不延续到本轮，按本轮实际操作判断。

护栏默认放行；陌生命令、无法建模与内部异常通过 hook 的 `systemMessage` 留下 advisory，不挂起、不发提醒。明确的删除或覆盖动作若无法确认目标仍拦截。军师可写临时文件与运行测试，但不可修改被审仓库或提交。

## 备注

{{notes}}

若文件 `{{hint}}` 存在，必须先完整阅读：那是元帅对上一次失败给出的提示。

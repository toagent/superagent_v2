# Hooks、Provider 配置与嵌套边界

## 原则

superagent 保留 provider 的原生用户配置、项目指导、skills、plugins 与 MCP。它不替换
provider home，不创建平行的上下文开关，也不把项目文档批量注入每个节点。
`AGENTS.md` 等项目指导由 provider 的原生发现机制加载。

hooks 只守两类动作：凭据或隐私读取，以及不可逆破坏。能力收紧来自 plan `caps`、provider
沙箱和任务书，不通过隐藏用户配置实现。

## 安装

默认安装：

```bash
wetamp/scripts/install.sh
```

它登记 controller、维护 Archon 配置与模型别名，并渲染 launchd 模板；不修改 provider
hooks。远端 worker 安装：

```bash
wetamp/scripts/install.sh --remote-hooks
```

该模式把受管 `UserPromptSubmit`、`SessionStart` 与动作护栏 handler 合并进 Claude Code 和
Codex 原生配置，并安装 `~/.local/bin/superagent` worker 入口。安装过程：

1. 读取现有 JSON，验证形状；
2. 只替换带 superagent marker 的条目；
3. 保留其他 hooks、MCP 和 provider 字段；
4. 锁内写临时文件、保留备份、原子 rename；
5. 写入 install ledger 的 role、入口和受管路径。

输入损坏、目标为 symlink 或权限不满足时明确失败，不覆盖原文件。重复安装不复制条目。
安装是操作者动作，应从干净且已提交的 checkout 执行。

## 动作护栏

`hooks/redline.cjs` 接收 provider 动作事件，标准化工具名与目标后作结构化判断：

- 拒绝凭据文件、钥匙串、浏览器资料、私密目录与 iCloud 路径；
- 拒绝 force push、宽泛 recursive forced removal 和未授权 hard reset；
- 允许明确目标的普通文件编辑、测试、提交与进程操作；
- 无法建模、缺字段或内部错误返回 advisory，不把未知效果伪装成安全证明。

删除或 reset 只有在目标属于当前 Archon worktree 且调用使用专用恢复模式时放行。
评审节点受 checkout integrity 检查约束，可以写临时证据，不能修改被审代码。

shell hook 无法看见脚本内部所有间接 I/O，因此不是沙箱。最终边界还包括 provider 原生沙箱、
scope diff、风险路径检测和交付验收。测试通过只证明已送入 hook 的事件，不证明客户端所有工具
必然触发相同事件。

## Provider 与子进程

Archon prompt 节点通过原生 provider 启动 agent，保留 provider 身份和认证合同。Claude Code
订阅通过 Claude Agent SDK；其他 provider 上的 Anthropic 模型不能冒充该身份。Codex 和
Claude 的模型、effort 与路由只从 `tiers.json` 渲染。

派生编码、修复和评审节点不得再委派。worker role 在入口处拒绝 run 等控制面动作，但允许
`--version`、`--help` 和只读诊断；controller 才能启动与处置 run。`job exec` 统一登记 plan
外作业，负责 stdin、信号、日志、usage 和 board 可见性。

## 原生输入 hooks

`UserPromptSubmit` 只捕获已登记主检出的输入，`SessionStart` 只恢复有界 Task 指针。
worktree、派生节点、评审、worker 与未登记项目不捕获。hook 输出包含 key、brief、owner 和
pending 指针，不包含原始消息正文。

捕获只持久化输入，不启动、取消或批准 run。元帅通过 typed intake 动作解释消息；无法绑定
session 时返回 advisory，不借用其他 owner 身份。具体合同见
[`09-continuous-intake.md`](09-continuous-intake.md)。

## 验证

安装测试使用临时 HOME、配置与 launchd 目录，检查合并幂等、备份、权限和拒绝路径。
provider 边界测试检查原生设置与项目指导仍可见，危险动作被拒绝，普通测试写入可用。
真实安装后的诊断使用 `superagent health --cwd <repo>` 与不带 `--fake` 的 selftest。

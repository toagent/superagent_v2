# Hooks 与禁嵌套（WP-B）

V1 的 `hooks/*.cjs` 迁到 `wetamp/hooks/`，策略读 `wetamp/tiers.json` 的 `policy`。Archon worker 本身不挂 hooks；hooks 管的是用户在三端控制台里开的会话（元帅、手动派生的将军/军师、twin-agent 远端会话）。

## 三端 hook 事件

| 客户端                           | 事件 → handler                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `~/.claude/settings.json` | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs claude`；`UserPromptSubmit` `PreToolUse` → `context-budget.cjs` |
| Codex `~/.codex/hooks.json`      | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs codex`                                                          |
| OpenCode                         | 无 hook 通道；规则只靠指令与 Archon 侧的禁嵌套                                                                                               |

- 拒绝用 `hookSpecificOutput.permissionDecision='deny'`，提示用 `systemMessage`/`additionalContext`。
- `guard.cjs` 只在 `PreToolUse` 和 `Stop/SubagentStop` 起作用；`SessionStart`/`PostToolUse` 保留挂载以对齐 V1 清单，目前是空操作。
- `Stop/SubagentStop`：`policy.stop_gate` 只支持 `off`；其他值给出配置错误提示，不阻塞。
- `context-budget.cjs`：读 transcript 尾部 usage，按会话角色给阈值提示（元帅 160K / 将军 240K / 军师 360K）；只提示，不阻塞。

## 派生会话判定（`guard.cjs` 的 `derivedBy`）

任一成立即为派生会话：

1. `SUPERAGENT_ROLE` 为 `general`/`reviewer`/`worker`（Archon 经 `src/archon.ts` 给 run/resume `--detach` 与 detached 子进程注入 `worker`）；
2. `AI_DISPATCH_ROLE=general` 或 `TWIN_AGENT_REMOTE=1`；
3. 会话 cwd 位于 `$SUPERAGENT_HOME/archon/workspaces/` 之下；
4. 仅 Codex：根调用（无 `agent_type`+`agent_id`）的 `model` 在将军池且不在元帅池。

派生会话：N-1 拒绝 `Agent`/`Task`/`spawn_agent`/`mcp__claude__*`，以及 shell 中命令头为 `claude`/`codex`/`opencode`/`sol-run`/`twin-agent*` 的调用；不计 G-1。`SUPERAGENT_ROLE=reviewer` 另禁止一切编辑。

元帅会话：G-1 微改上限（`policy.micro_edit`：30 行、2 文件、不许新建代码文件；`*.md`、`**/.context/**` 豁免，风险路径优先于豁免）在 `PreToolUse` 按会话累计到 `$SUPERAGENT_HOME/hooks/<sha256(session)>.json`，被拒的那次不计入，不重置；无法计量时放行并提示。G-2 检查派发上下文长度与 `spawn_agent` 的显式模型。所有会话都拦 `git push`、`git reset --hard`，以及字面路径为 `/`、`~`、`$SUPERAGENT_HOME`、git 根（或其上级）的删除。

## 禁嵌套：本机 Archon worker 三层

1. 包装器 `bin/codex-worker`（`install.sh` 写入 `assistants.codex.codexBinaryPath`）：前置 `exec_profiles.*.codex` 的 `-c`（`features.multi_agent=false`），并把 `~/.codex/config.toml` 中已声明、不在 `policy.sandbox.mcp` 的 MCP server 设为 `enabled=false`。只读表头，不读值。`SA_CODEX_REAL` 指定真 codex；`SA_CODEX_WORKER_TRACE=1` 把最终 argv 打到 stderr。
2. `exec_profiles.*.claude.denied_tools` → 生成的 prompt 节点 `denied_tools`（Archon `disallowedTools`）：`Agent`、`Task`、`Bash(claude *)`、`Bash(codex *)`、`Bash(opencode *)`、`Bash(sol-run *)`、`Bash(twin-agent*)`。只对 provider 为 claude 的别名生成。
3. hooks 的 N-1（用户三端配置里挂了 guard 时生效，依赖上面的派生判定 1/3）。

远端（dev/mini）的禁嵌套由 twin-agent runner 负责；远端会话带 `TWIN_AGENT_REMOTE=1` 时 hooks 按判定 2 视为派生。`--remote-hooks` 只保证远端 hooks 文件可用并留下台账。

## install.sh 单独步骤（互斥）

```bash
bash wetamp/scripts/install.sh --hooks --dry-run     # 打印 settings.json / hooks.json 的统一 diff，不写
bash wetamp/scripts/install.sh --hooks               # V1 路径改写为 wetamp/hooks/、事件内去重、补齐上表；写前备份 backups/hooks-<UTC>/
bash wetamp/scripts/install.sh --purge-v1 --dry-run  # 列出将删的 V1 hook 条目与将移走的残留
bash wetamp/scripts/install.sh --purge-v1            # 删 V1 条目；残留移到 backups/v1-<UTC>/files/<原绝对路径>，不删除
bash wetamp/scripts/install.sh --remote-hooks        # 远端：只要 node；node --check + 真跑一次 guard，写 install.json
```

- 只动 superagent 自己的 handler（V1 checkout/release 路径或本 `wetamp/hooks/`），其他 hooks 原样保留；只有命令串改写时原地替换，保留文件排版。
- `--remote-hooks` 写 `${XDG_STATE_HOME:-~/.local/state}/superagent/install.json`（`installer:"superagent_v2"`、`wetamp`、`commit`、`hooks`）；已有 V1 台账先存 `.v1-<毫秒时间戳>` 副本。twin-toolkit 回执 schema 2 按此校验。
- 默认安装（不带参数）不碰 hooks。

## 风险与口径

- 真实 `--hooks`/`--purge-v1` 写入由元帅执行；默认安装会写 `~/Library/LaunchAgents` 下的 plist，测试与验收须设 `SA_LAUNCHD_DIR`。
- codex 版本从 0.160.0 漂移到 0.162.1；`features.multi_agent` 键若被改名，包装器不会报错，可用 `SA_CODEX_REAL` 固定版本。
- 删除拦截只识别字面路径，变量展开或间接删除拦不住。
- G-1 只计量编辑工具（Claude `Edit/Write/MultiEdit/NotebookEdit`、Codex `apply_patch`），shell 写文件不计；`*.md` 不计入。
- Archon 所有节点都以 worker 身份运行，评审节点也用 240K 阈值。
- `exclude_user_instructions` 在 Archon 中没有对应字段，仅作为策略记录。
- `install.json` 与 V1 台账同位置，V1 工具读它会看到 V2 内容。

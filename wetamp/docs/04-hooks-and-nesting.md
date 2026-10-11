# Hooks 与禁嵌套（WP-B）

V1 的 `hooks/*.cjs` 迁到 `wetamp/hooks/`，策略读 `wetamp/tiers.json` 的 `policy`。hooks 管用户在三端控制台里开的会话（元帅、手动派生的将军/军师、twin-agent 远端会话），也管 Archon worker 的 AI 节点：2026-10-10 实测 Claude 节点加载用户级与项目级 `PreToolUse`，Codex 节点只加载用户级 `~/.codex/hooks.json`（项目级 `.codex/hooks.json` 不加载）。

## 三端 hook 事件

| 客户端                           | 事件 → handler                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `~/.claude/settings.json` | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs claude`；`UserPromptSubmit` `PreToolUse` → `context-advisory.cjs` |
| Codex `~/.codex/hooks.json`      | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs codex`                                                            |
| OpenCode                         | 无 hook 通道；规则只靠指令与 Archon 侧的禁嵌套                                                                                                 |

- 拒绝用 `hookSpecificOutput.permissionDecision='deny'`，提示用 `systemMessage`/`additionalContext`。
- `guard.cjs` 的 `PreToolUse` 做拒绝判定；其余事件仅供心跳，`Stop` 可给 G-3 提示。
- G-3（`policy.stop_gate`，默认 `off`）：`advisory` 只提示以引擎正式 gate 证据确认 candidate、实际模型独立性与 verdict。旧 `cycle/change` 同样降为 advisory，永不阻断；hook 不记录树指纹、不把 reviewer 子会话结束当评审通过，旧状态内的 `gate` 数据不再消费。
- `context-advisory.cjs`（旧注册路径 `context-budget.cjs` 委派到它）：读 transcript 尾部 usage，按会话角色给阈值提示（元帅 160K / 将军 240K / 军师 360K）；策略键为 `policy.context.advisory_tokens`；advisory 只提示，不阻塞或自动压缩。

## 派生会话判定（`guard.cjs` 的 `derivedBy`）

任一成立即为派生会话：

1. `SUPERAGENT_ROLE` 为 `general`/`reviewer`/`worker`（Archon 经 `src/archon.ts` 给 run/resume `--detach` 与 detached 子进程注入 `worker`）；
2. `agent_type` 与 `agent_id` 都是非空字符串（唯一 `isChild` 判定，root 为它的取反）；
3. `AI_DISPATCH_ROLE=general` 或 `TWIN_AGENT_REMOTE=1`；
4. 会话 cwd 位于 `$SUPERAGENT_HOME/archon/workspaces/` 之下；
5. 仅 Codex：根调用（无 `agent_type`+`agent_id`）的 `model` 在将军池且不在元帅池。

派生会话：N-1 拒绝 `Agent`/`Task`/`spawn_agent`/`mcp__claude__*`，以及 shell 中命令头为 `claude`/`codex`/`opencode`/`sol-run`/`twin-agent*` 的调用；不计 G-1。`SUPERAGENT_ROLE=reviewer` 禁止修改被审仓库与提交，但允许临时写入和运行测试。

元帅会话：G-1 微改上限（`policy.micro_edit`：30 行、2 文件、不许新建代码文件；文档/临时路径按策略豁免，风险路径优先）在 `PreToolUse` 按会话累计到 `$SUPERAGENT_HOME/hooks/<sha256(session)>.json`，被拒的那次不计入，不重置。编辑解析失败、状态损坏、缺会话身份与计量异常均 advisory 放行，坏状态不重置。shell 的已识别写入复用红线效果表：无法预先确认行数时 advisory 放行并提示交 `superagent run`；普通动态写入、cwd 变动、内联解释器代码与解析失败同样不因无法计量而拒绝，明确危险且目标未知仍由红线拦截。可确认的豁免路径与只读 shell 照常放行，原 `SUPERAGENT_ALLOW_COMMANDER_WRITE=1` 例外保留，红线仍先行。

G-1 与 context 计数共用 `hook-state.cjs`：`<state>.lock` 排他锁内完成读改写，同目录唯一临时文件原子 rename；等待最多 5s，锁的年龄不能证明 owner 死亡。计量锁忙 advisory 放行；context 仅 advisory，失败不重置计数。事件通过原生 `tool_use_id/tool_call_id/event_id/prompt_id` 在本会话内去重，无 ID 不按内容猜同一事件。G-2 的派发上下文与模型池规则保持；所有角色的 push/reset/受保护目录删除规则保持。

## 执行层红线（所有角色，`hooks/redline.cjs`）

`guard.cjs` 在 `PreToolUse` 先查红线再查其他规则，元帅、将军、军师一律适用。读类工具（`Read/Grep/Glob/LS/NotebookRead/view_image`）、编辑目标与 shell 词（含 `<` 输入重定向、`--opt=` 值、词内嵌的 `~`/`$HOME`/绝对路径，符号链接解析后再判）共用一套路径判定：

| 红线       | 拒绝                                                                                                                    | 放行                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| ssh 私钥   | `~/.ssh/` 下其他文件                                                                                                    | `*.pub`、`known_hosts`、`config`                        |
| 钥匙串     | `~/Library/Keychains/**`；`security find-*-password`/`dump-keychain`/`export`                                           | `security list-keychains` 等                            |
| 凭据文件   | `~/.aws/credentials`、`~/.netrc`、`~/.config/gh/hosts.yml`、直接读 `~/.npmrc`/`~/.pypirc`                               | 工具自己读取（`npm whoami`）                            |
| 隐私       | 任一路径段 `_private`；`~/Library/Mobile Documents`；Chrome/Chromium/Arc/Edge/Firefox/Safari 资料与 `~/Library/Cookies` | `grep _private src`（不存在的相对词视为模式）           |
| 发布与合并 | `npm/pnpm/bun/yarn publish`、`docker push`/`--push`、`gh release create`、`gh pr merge`、`vercel --prod`                | `npm pack`、`gh pr view`                                |
| 共享历史   | 推送；非本任务检出的 hard reset / clean；删除别人的分支；重写受保护共享分支                                             | 本任务检出的 reset / clean 与查询                       |
| 发信号     | 按名称、模式、端口或进程组选择对象（含 PID 0、负 PID）                                                                  | 明确 PID，如 `kill -TERM 41418`                         |
| 权限与写入 | 提权；修改家目录点目录、系统目录或非本任务检出；销毁范围外已有数据                                                      | worktree、临时目录、包缓存、本 run 产物；普通范围外新建 |

命令效果集中在 `hooks/shell-effects.json`，统一按效果与目标归属判定；没有登记的命令默认按读/执行放行。解析失败、无法建模、内部异常、未知普通写入通过 hook stdout 的 `systemMessage` 留下 `SUPERAGENT advisory`，可在 provider 会话的 hook 输出查看，不挂起、不发提醒。明确的删除或覆盖动作若目标未知仍拒绝。每条红线拒绝固定为 `已拦截：<动作与对象>。原因：<后果>。可以：<替代做法>。`；`error_class=redline` 的引擎契约不变。

### provider × 红线（只写实测，2026-10-10，真实 Archon 节点：Claude 1 次、Codex 3 次）

| provider                                       | 通道                                                                              | 实测                                                                                                                                        | 强制方式                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude（Archon worker 节点）                   | 用户级 `~/.claude/settings.json` 与项目级 `.claude/settings.json` 的 `PreToolUse` | 都触发；挂本分支 guard 时 `git branch -D release-1` 被拒（“红线：禁止对共享分支 release-1 …”），分支保留                                    | hook（不另加 `denied_tools`）                                                                     |
| Codex（Archon worker 节点，经 `codex-worker`） | 仅用户级 `~/.codex/hooks.json`；项目级不加载                                      | git-guardrail 触发并拦 `git push`；guard.cjs 未执行：其 `trusted_hash` 是改路径前的定义，Codex 把改过未重新信任的 hook 视为 Modified 并跳过 | hook + `codex-worker` 失败关闭：guard 的 `PreToolUse` 条目未受信任或被禁用时 exit 3，不启动 codex |
| OpenCode                                       | 无 hook 通道                                                                      | —                                                                                                                                           | 提示级                                                                                            |

- `codex-worker` 的信任检查按 codex-rs hooks discovery 复算 hash（`{event_name,matcher?,hooks:[归一化 handler]}` 键排序紧凑 JSON 的 sha256，测试里用本机 Codex 写下的 git-guardrail 值锚定）。运维动作：改过 `hooks.json` 里 guard 的命令或 timeout 后，在交互式 Codex 里 `/hooks` 重新信任；Codex 改了 hash 算法造成误判时可设 `SA_CODEX_HOOK_TRUST=unchecked` 临时放行（每次 stderr 留痕）。
- 上表是 2026-10-10 旧版本历史证据，不证明新版策略的真实 provider 验收。运行时 hooks 随用户配置指向的代码生效；本包尚未合入生产。
- 残余边界：脚本文件内部、解释器程序与间接网络/文件效果无法完整推断；这类未知效果默认放行。变量路径的普通写入 advisory，明确删除/覆盖未知目标仍拒绝。元帅保留既有微改规则，派生任务与 reviewer 的写入按归属判定。

## 禁嵌套：本机 Archon worker 三层

1. 包装器 `bin/codex-worker`（`install.sh` 写入 `assistants.codex.codexBinaryPath`）：先确认 guard 的 Codex `PreToolUse` hook 受信任（见上节，否则 exit 3），再前置 `exec_profiles.*.codex` 的 `-c`（`features.multi_agent=false`），并把 `~/.codex/config.toml` 中已声明、不在 `policy.sandbox.mcp` 的 MCP server 设为 `enabled=false`。server 名由 `Bun.TOML` 按 TOML 键解析（表头、引号键、点键、内联表），只取 `mcp_servers` 的键名、不输出值；名字不符合 `[A-Za-z0-9_-]+` 的跳过并在 stderr 记一行；解析失败时退回表头正则并在 stderr 记一行。信任核验与写入是同一份实现 `scripts/codex-trust.cjs`（`check` 用 `Bun.TOML`，不依赖 python3 tomllib；bun 不可用即无法判定 → exit 3）。`SA_CODEX_REAL` 指定真 codex；选定路径 realpath 后指向包装器自身、不存在或不可执行时 exit 2。`SA_CODEX_WORKER_TRACE=1` 在 stderr 打印 `{policy, argv}`：policy 为追加的 `-c` 列表，argv 为调用方参数的脱敏副本（token/key/secret/password/Authorization/Bearer 之类的值换成 `***`，超过 200 字符截断）。
2. `exec_profiles.*.claude.denied_tools` → 生成的 prompt 节点 `denied_tools`（Archon `disallowedTools`）：`Agent`、`Task`、`Bash(claude *)`、`Bash(codex *)`、`Bash(opencode *)`、`Bash(sol-run *)`、`Bash(twin-agent*)`。只对 provider 为 claude 的别名生成。
3. hooks 的 N-1（用户三端配置里挂了 guard 时生效，依赖上面的派生判定；Codex 侧要求该 hook 受信任，由第 1 层把关）。

远端（dev/mini）的禁嵌套由 twin-agent runner 负责；远端会话带 `TWIN_AGENT_REMOTE=1` 时 hooks 按派生身份规则视为派生。`--remote-hooks` 只保证远端 hooks 文件可用并留下台账。

## 包装器剥离规则（N-1 与 reviewer 判定共用 `hooks/shell.cjs`）

shell 文本先按引号、`$(…)`/反引号/子 shell、管道与 `;`/`&&`/`||`/换行切成命令；单引号内的内容是字面量，不当作执行。每条命令依次去掉前导赋值与 `!`/`{`/`if`/`then`/`do` 等保留字，再按参数语义剥离包装器：`env`（含 `-u NAME`、`-S` 拆分后递归）、`sudo`/`doas`、`nice`、`nohup`、`builtin`、`command`（`-v/-V` 只是查找，不剥离）、`exec`、`caffeinate`、`time`、`xargs`、`timeout/gtimeout`、`stdbuf`、`watch`、`script`（`-c` 命令体递归）、`rtk proxy`；剥完后的第一个词才是命令头。包装器自身的写入副作用（`time -o/--output`、`sudo -D`、`nohup` 的 `nohup.out`、`script` 的记录文件与 `-T/-B/-I/-O` 等日志文件）和 `tee` 的文件参数都按写入计入。`bash/sh/zsh -c`、`eval`、`find -exec` 的命令体递归解析，深度超过 8 层留下 advisory 并放行。紧贴重定向的 fd 数字不算参数；指向 `/dev/null`、`/dev/stdout`、`/dev/stderr` 与 `>&N` 的重定向不算写入。

## reviewer 只读边界

`SUPERAGENT_ROLE=reviewer` 的会话（`src/archon.ts` 保留继承的 `reviewer`/`general`，只把其他值改成 `worker`）：

- hooks：编辑工具与可确认的 shell 写入不得修改被审仓库；临时文件、测试和脚本执行允许。解析失败与未知效果产生 advisory；未知明确删除/覆盖仍拒绝。
- 主边界在执行层，由 `src/generate.ts` 按 `@sa-reviewer` 的 provider 逐节点生成，不依赖环境变量：
  - Claude 评审节点：节点 `sandbox:` 取 `exec_profiles.reviewer.claude.sandbox`（`filesystem.denyWrite:["/"]`、`failIfUnavailable`、禁止 unsandboxed 命令），另有 `denied_tools` 去掉 `Edit/Write/MultiEdit/NotebookEdit`。
  - Codex 评审节点：节点 `mcp:` 指向生成的 `reviewer-readonly.mcp.json`，内含哨兵 server `codex_readonly_marker`（`required:true`，命令必败）。`codex-worker` 以 `app-server` 被调用时经 `bin/codex-readonly-proxy.cjs` 转发：见到哨兵就删掉它，本连接的 `thread/start|resume|fork` 改 `sandbox:"read-only"`、`turn/start` 注入只读 `sandboxPolicy`。原因是 Archon 在 `thread/start` 固定传 `danger-full-access`，盖掉 `-c sandbox_mode`。绕过代理直连 codex 时哨兵起不来，线程创建失败（失败关闭）。整个 worker 以 reviewer 身份运行时代理从第一条线程起就只读。
- hooks 的效果与归属判定提供纵深防御，不构成执行沙箱。
- 边界：reviewer 归属限制只对设了该环境变量的会话生效；Stop 仅 advisory，任何子会话完成都不是正式评审证据。现有 provider 只读 sandbox/denied_tools 可能更严格，真实节点的临时写入权限待主控集成验收。

## install.sh 单独步骤（互斥）

```bash
bash wetamp/scripts/install.sh --hooks --dry-run     # 打印 settings.json / hooks.json 的统一 diff，不写
bash wetamp/scripts/install.sh --hooks               # V1 路径改写、按（事件×matcher 等条件×command）去重、补齐上表；写前备份
bash wetamp/scripts/install.sh --purge-v1 --dry-run  # 列出将删的 V1 hook 条目与将移走的残留
bash wetamp/scripts/install.sh --purge-v1            # 删 V1 条目；残留移到 backups/v1-<UTC>/files/<原绝对路径>，不删除
bash wetamp/scripts/install.sh --remote-hooks        # 远端：node 与 parser 依赖；校验 guard，写 worker 台账
```

- 自有 handler 的全部分组覆盖 matcher 分组时，删除重复自有 handler，保留同组用户 hooks 与未管理字段；V1 清单都不带 matcher，补齐时只认"全部"分组（未设置/空/`*`）。`context-advisory.cjs` 尾部的 `claude` 参数去掉后归一为一条。目标文件不存在时按空文件补齐并创建（dry-run 打印与空文件的 diff，不写）。
- 只动 superagent 自己的 handler（V1 checkout/release 路径或本 `wetamp/hooks/`），其他 hooks 原样保留；只有命令串改写时原地替换，保留文件排版。
- `--remote-hooks` 写 `${XDG_STATE_HOME:-~/.local/state}/superagent/install.json`（`installer:"superagent_v2"`、`role:"worker"`、`wetamp`、`commit`、`hooks`）；已有 V1 台账先存 `.v1-<毫秒时间戳>` 副本。twin-toolkit 回执 schema 2 按此校验。
- Codex 信任：`install.sh --hooks` 与 `--remote-hooks` 之后跑 `scripts/codex-trust.cjs write`，为 `hooks.json` 里命令指向本 `wetamp/hooks/` 的条目写 `[hooks.state."<hooks.json>:<event_snake>:<gi>:<hi>"] trusted_hash`（键排序紧凑 JSON 的 sha256，与 Codex 一致）。文本级改写：只替换/补自己键的 `trusted_hash`，其余内容与注释原样；同一键以内联表等其他写法出现时拒绝并提示 `/hooks`；改动前备份到 `$SUPERAGENT_HOME/backups/codex-trust-<UTC>/`，同目录临时文件 rename，保留文件权限。远端 `hooks.json` 由 agentcfg 维度在 superagent 维度之后下推，信任按 install 当时远端已有的条目写；agentcfg 之后改了这些条目时，要到下次投送新提交（必重跑 install）或手动再跑 `install.sh --remote-hooks` 才补齐。
- worker 桩：`--remote-hooks` 把 `~/.local/bin/superagent` 指向本仓库 `bin/superagent`（原为普通文件先存 `.bak-<时间>`）。`bin/superagent` 读到 `role:"worker"` 且 `wetamp` 是自己时，在 `exec bun` 之前处理：`--version`/`--help` 照答，其余动词打印“仅本机运行（本机为控制面）”退出 69；不需要 bun 与 node_modules。twin-toolkit 回执 `checks` 记 `role`/`entry`。
- 默认安装（不带参数）不碰 hooks；同一安装台账写 `role:"controller"`。两种模式均锁内原子发布、保留未管理字段，重复安装不更新台账时间。CLI `health` 和 run 的 preflight/启动回执明确报告模式；直接调用 TypeScript CLI 的 worker run 也会在启动前拒绝。缺台账的旧本机安装维持 controller，坏台账或本 checkout 的未知 role 明确失败。

## 风险与口径

- 真实 `--hooks`/`--purge-v1` 写入由元帅执行；默认安装会写 `~/Library/LaunchAgents` 下的 plist，测试与验收须设 `SA_LAUNCHD_DIR`。
- codex 版本从 0.160.0 漂移到 0.162.1；`features.multi_agent` 键若被改名，包装器不会报错，可用 `SA_CODEX_REAL` 固定版本。
- 明确删除/覆盖目标未知时拒绝；脚本内部的间接删除无法完整识别。
- 安装折叠自有 matcher/all 重叠，事件 ID 去重提供第二层保护；无 ID 的事件不能保证重复计量幂等。
- shell hook 是辅助检查，不是沙箱：脚本文件内部、未建模程序与间接执行的任意外部进程无法由该 hook 全面约束。交付仍按引擎的实际 diff/scope/有效风险门禁复核，provider 原生沙箱和能力限制才是执行边界。
- Archon detached 节点默认以 worker 身份运行（继承 reviewer/general 时保留），评审节点多数也用 240K 阈值。
- `exclude_user_instructions` 在 Archon 中没有对应字段，仅作为策略记录。
- `install.json` 与 V1 台账同位置，V1 工具读它会看到 V2 内容。

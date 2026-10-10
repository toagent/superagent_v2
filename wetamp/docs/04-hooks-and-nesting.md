# Hooks 与禁嵌套（WP-B）

V1 的 `hooks/*.cjs` 迁到 `wetamp/hooks/`，策略读 `wetamp/tiers.json` 的 `policy`。hooks 管用户在三端控制台里开的会话（元帅、手动派生的将军/军师、twin-agent 远端会话），也管 Archon worker 的 AI 节点：2026-10-10 实测 Claude 节点加载用户级与项目级 `PreToolUse`，Codex 节点只加载用户级 `~/.codex/hooks.json`（项目级 `.codex/hooks.json` 不加载）。

## 三端 hook 事件

| 客户端                           | 事件 → handler                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `~/.claude/settings.json` | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs claude`；`UserPromptSubmit` `PreToolUse` → `context-budget.cjs` |
| Codex `~/.codex/hooks.json`      | `SessionStart` `PreToolUse` `PostToolUse` `SubagentStop` `Stop` → `guard.cjs codex`                                                          |
| OpenCode                         | 无 hook 通道；规则只靠指令与 Archon 侧的禁嵌套                                                                                               |

- 拒绝用 `hookSpecificOutput.permissionDecision='deny'`，提示用 `systemMessage`/`additionalContext`。
- `guard.cjs` 的 `PreToolUse` 做拒绝判定；`SessionStart`/`PostToolUse`/`SubagentStop`/`Stop` 服务 G-3 Stop 门（`hooks/stop-gate.cjs`）。
- G-3（`policy.stop_gate`，默认 `off`）：元帅会话在 `SessionStart` 或首次写入前记下每个涉及的 git 根的 base HEAD 与受控改动指纹（`exempt_paths` 不计）；成功结束的 `reviewer-N` 子代理（Claude `Agent/Task` 或 `SubagentStop`，Codex 为军师池模型的子代理）把当前指纹记为已评审。`Stop` 时指纹既不等于基线也不等于已评审即为未评审改动：`advisory` 只提示；`change` 按改动内容、`cycle` 按写入次数生成令牌并阻断，同一令牌第二次 Stop（或 `stop_hook_active`）放行并提示 UNREVIEWED，避免死循环。首个事件不是 `SessionStart/PreToolUse`、状态文件损坏或 git 失败时会话记为 unknown，按未评审处理。非法取值只在 `Stop` 提示配置错误。
- `context-budget.cjs`：读 transcript 尾部 usage，按会话角色给阈值提示（元帅 160K / 将军 240K / 军师 360K）；只提示，不阻塞。

## 派生会话判定（`guard.cjs` 的 `derivedBy`）

任一成立即为派生会话：

1. `SUPERAGENT_ROLE` 为 `general`/`reviewer`/`worker`（Archon 经 `src/archon.ts` 给 run/resume `--detach` 与 detached 子进程注入 `worker`）；
2. `AI_DISPATCH_ROLE=general` 或 `TWIN_AGENT_REMOTE=1`；
3. 会话 cwd 位于 `$SUPERAGENT_HOME/archon/workspaces/` 之下；
4. 仅 Codex：根调用（无 `agent_type`+`agent_id`）的 `model` 在将军池且不在元帅池。

派生会话：N-1 拒绝 `Agent`/`Task`/`spawn_agent`/`mcp__claude__*`，以及 shell 中命令头为 `claude`/`codex`/`opencode`/`sol-run`/`twin-agent*` 的调用；不计 G-1。`SUPERAGENT_ROLE=reviewer` 另禁止一切编辑。

元帅会话：G-1 微改上限（`policy.micro_edit`：30 行、2 文件、不许新建代码文件；`*.md`、`**/.context/**` 豁免，风险路径优先于豁免）在 `PreToolUse` 按会话累计到 `$SUPERAGENT_HOME/hooks/<sha256(session)>.json`，被拒的那次不计入，不重置；累计在状态锁（`<state>.lock`，`openSync(…,'wx')`，等 5s、15s 视为陈旧）内读改写，并行 `PreToolUse` 不丢累计量，拿不到锁时拒绝并提示重试；补丁本身解析不了时放行并提示。G-2 检查派发上下文长度与 `spawn_agent` 的显式模型。所有会话都拦 `git push`、`git reset --hard`，以及字面路径为 `/`、`~`、`$SUPERAGENT_HOME`、git 根（或其上级）的删除；拒绝信息只回显目标 basename。

## 执行层红线（所有角色，`hooks/redline.cjs`）

`guard.cjs` 在 `PreToolUse` 先查红线再查其他规则，元帅、将军、军师一律适用。读类工具（`Read/Grep/Glob/LS/NotebookRead/view_image`）、编辑目标与 shell 词（含 `<` 输入重定向、`--opt=` 值、词内嵌的 `~`/`$HOME`/绝对路径，符号链接解析后再判）共用一套路径判定：

| 红线 | 拒绝 | 放行 |
| --- | --- | --- |
| ssh 私钥 | `~/.ssh/` 下其他文件 | `*.pub`、`known_hosts`、`config` |
| 钥匙串 | `~/Library/Keychains/**`；`security find-*-password`/`dump-keychain`/`export` | `security list-keychains` 等 |
| 凭据文件 | `~/.aws/credentials`、`~/.netrc`、`~/.config/gh/hosts.yml`、直接读 `~/.npmrc`/`~/.pypirc` | 工具自己读取（`npm whoami`） |
| 隐私 | 任一路径段 `_private`；`~/Library/Mobile Documents`；Chrome/Chromium/Arc/Edge/Firefox/Safari 资料与 `~/Library/Cookies` | `grep _private src`（不存在的相对词视为模式） |
| 发布与合并 | `npm/pnpm/bun/yarn publish`、`docker push`/`--push`、`gh release create`、`gh pr merge`、`vercel --prod` | `npm pack`、`gh pr view` |
| 共享分支 | 对 `main/master/develop/wetamp/release-*` 的 `git branch -f/-D/-d/-m`、`update-ref`（含当前分支受保护时的 `update-ref HEAD`）、`checkout -B`/`switch -C`、`rebase`（`--abort/--quit` 除外）；`git push`、`reset --hard` 原有规则照旧 | 对自己分支的同类操作 |
| 杀进程 | `pkill`、`killall`、同一命令行里 `lsof/pgrep/pidof` 配 `kill` | `kill $!`、`kill %1`、`kill <记录的 PID>` |
| 远端数据库 | `mysql/psql/mongosh/redis-cli` 的 `-h/--host/host=`/URI 指向非本机 | `localhost`、`127.*`、`::1`、unix socket |

派生会话（reviewer 除外，它由只读白名单整体拒绝）的写入另限落点：Edit/Write/apply_patch 目标，以及 shell 的写重定向、`tee`、包装器副作用、`cp/mv/ln/install/rsync` 的末操作数、`touch/mkdir/rm/rmdir/truncate` 的操作数、`dd of=`，只能落在 cwd 的 git 根（无则 cwd）、`/tmp`、`/private/tmp`、`$TMPDIR`、`/var/folders`，以及 `~/.bun`、`~/.npm`、`~/.cache`、`~/Library/Caches`、`~/.m2`、`~/.gradle`、`~/.cargo`。

### provider × 红线（只写实测，2026-10-10，真实 Archon 节点：Claude 1 次、Codex 3 次）

| provider | 通道 | 实测 | 强制方式 |
| --- | --- | --- | --- |
| Claude（Archon worker 节点） | 用户级 `~/.claude/settings.json` 与项目级 `.claude/settings.json` 的 `PreToolUse` | 都触发；挂本分支 guard 时 `git branch -D release-1` 被拒（“红线：禁止对共享分支 release-1 …”），分支保留 | hook（不另加 `denied_tools`） |
| Codex（Archon worker 节点，经 `codex-worker`） | 仅用户级 `~/.codex/hooks.json`；项目级不加载 | git-guardrail 触发并拦 `git push`；guard.cjs 未执行：其 `trusted_hash` 是改路径前的定义，Codex 把改过未重新信任的 hook 视为 Modified 并跳过 | hook + `codex-worker` 失败关闭：guard 的 `PreToolUse` 条目未受信任或被禁用时 exit 3，不启动 codex |
| OpenCode | 无 hook 通道 | — | 提示级 |

- `codex-worker` 的信任检查按 codex-rs hooks discovery 复算 hash（`{event_name,matcher?,hooks:[归一化 handler]}` 键排序紧凑 JSON 的 sha256，测试里用本机 Codex 写下的 git-guardrail 值锚定）。运维动作：改过 `hooks.json` 里 guard 的命令或 timeout 后，在交互式 Codex 里 `/hooks` 重新信任；Codex 改了 hash 算法造成误判时可设 `SA_CODEX_HOOK_TRUST=unchecked` 临时放行（每次 stderr 留痕）。
- 红线随用户级 hooks 指向的 guard 生效：主工作区合入本分支前，worker 用的仍是主工作区旧 guard（无红线）。
- 残余风险（提示级）：只做字面判定，变量（`$HOME` 除外）、通配、`eval "$x"`、脚本文件内部、解释器（`python -c`/`node -e`）里的读写与网络拦不住；`PGHOST` 等环境变量指定的 DB host 不识别；`grep -r ~` 这类对上级目录的递归读不判；元帅不受落点限制；Bash 外部写入只按上述命令表尽力识别。

## 禁嵌套：本机 Archon worker 三层

1. 包装器 `bin/codex-worker`（`install.sh` 写入 `assistants.codex.codexBinaryPath`）：先确认 guard 的 Codex `PreToolUse` hook 受信任（见上节，否则 exit 3），再前置 `exec_profiles.*.codex` 的 `-c`（`features.multi_agent=false`），并把 `~/.codex/config.toml` 中已声明、不在 `policy.sandbox.mcp` 的 MCP server 设为 `enabled=false`。server 名由 `python3 -I` + `tomllib` 按 TOML 键解析（表头、引号键、点键、内联表），只取 `mcp_servers` 的键名、不输出值；名字不符合 `[A-Za-z0-9_-]+` 的跳过并在 stderr 记一行；python3 不可用时退回表头正则并在 stderr 记一行。`SA_CODEX_REAL` 指定真 codex；选定路径 realpath 后指向包装器自身、不存在或不可执行时 exit 2。`SA_CODEX_WORKER_TRACE=1` 在 stderr 打印 `{policy, argv}`：policy 为追加的 `-c` 列表，argv 为调用方参数的脱敏副本（token/key/secret/password/Authorization/Bearer 之类的值换成 `***`，超过 200 字符截断）。
2. `exec_profiles.*.claude.denied_tools` → 生成的 prompt 节点 `denied_tools`（Archon `disallowedTools`）：`Agent`、`Task`、`Bash(claude *)`、`Bash(codex *)`、`Bash(opencode *)`、`Bash(sol-run *)`、`Bash(twin-agent*)`。只对 provider 为 claude 的别名生成。
3. hooks 的 N-1（用户三端配置里挂了 guard 时生效，依赖上面的派生判定 1/3；Codex 侧要求该 hook 受信任，由第 1 层把关）。

远端（dev/mini）的禁嵌套由 twin-agent runner 负责；远端会话带 `TWIN_AGENT_REMOTE=1` 时 hooks 按判定 2 视为派生。`--remote-hooks` 只保证远端 hooks 文件可用并留下台账。

## 包装器剥离规则（N-1 与 reviewer 判定共用 `hooks/shell.cjs`）

shell 文本先按引号、`$(…)`/反引号/子 shell、管道与 `;`/`&&`/`||`/换行切成命令；单引号内的内容是字面量，不当作执行。每条命令依次去掉前导赋值与 `!`/`{`/`if`/`then`/`do` 等保留字，再按参数语义剥离包装器：`env`（含 `-u NAME`、`-S` 拆分后递归）、`sudo`/`doas`、`nice`、`nohup`、`builtin`、`command`（`-v/-V` 只是查找，不剥离）、`exec`、`caffeinate`、`time`、`xargs`、`timeout/gtimeout`、`stdbuf`、`watch`、`script`（`-c` 命令体递归）、`rtk proxy`；剥完后的第一个词才是命令头。包装器自身的写入副作用（`time -o/--output`、`env -C/--chdir`、`sudo -D`、`nohup` 的 `nohup.out`、`script` 的记录文件与 `-T/-B/-I/-O` 等日志文件）和 `tee` 的文件参数都按写入计入。`bash/sh/zsh -c`、`eval`、`find -exec` 的命令体递归解析，深度超过 4 层直接拒绝。紧贴重定向的 fd 数字不算参数；指向 `/dev/null`、`/dev/stdout`、`/dev/stderr` 与 `>&N` 的重定向不算写入。

## reviewer 只读边界

`SUPERAGENT_ROLE=reviewer` 的会话（`src/archon.ts` 保留继承的 `reviewer`/`general`，只把其他值改成 `worker`）：

- hooks：拒绝一切编辑工具；Bash 只放行白名单读命令（`cat/head/tail/grep/rg/sed -n …p/find`（无 `-delete/-exec`）/`sort`（无 `-o`）/`git` 只读子命令等），任何写重定向（`>`、`>>`、`>|`、`&>`、`<>`）、包装器写入副作用、`tee` 文件或解析失败一律拒绝。
- 主边界在执行层，由 `src/generate.ts` 按 `@sa-reviewer` 的 provider 逐节点生成，不依赖环境变量：
  - Claude 评审节点：节点 `sandbox:` 取 `exec_profiles.reviewer.claude.sandbox`（`filesystem.denyWrite:["/"]`、`failIfUnavailable`、禁止 unsandboxed 命令），另有 `denied_tools` 去掉 `Edit/Write/MultiEdit/NotebookEdit`。
  - Codex 评审节点：节点 `mcp:` 指向生成的 `reviewer-readonly.mcp.json`，内含哨兵 server `codex_readonly_marker`（`required:true`，命令必败）。`codex-worker` 以 `app-server` 被调用时经 `bin/codex-readonly-proxy.cjs` 转发：见到哨兵就删掉它，本连接的 `thread/start|resume|fork` 改 `sandbox:"read-only"`、`turn/start` 注入只读 `sandboxPolicy`。原因是 Archon 在 `thread/start` 固定传 `danger-full-access`，盖掉 `-c sandbox_mode`。绕过代理直连 codex 时哨兵起不来，线程创建失败（失败关闭）。整个 worker 以 reviewer 身份运行时代理从第一条线程起就只读。
- hooks 白名单是纵深防御。
- 边界：白名单只对设了该环境变量的会话生效；Stop 门不跟踪 shell 写到其他仓库的改动；`claude -p` 方式的评审不算评审证据（只认 `reviewer-N` 子代理）。

## install.sh 单独步骤（互斥）

```bash
bash wetamp/scripts/install.sh --hooks --dry-run     # 打印 settings.json / hooks.json 的统一 diff，不写
bash wetamp/scripts/install.sh --hooks               # V1 路径改写、按（事件×matcher 等条件×command）去重、补齐上表；写前备份
bash wetamp/scripts/install.sh --purge-v1 --dry-run  # 列出将删的 V1 hook 条目与将移走的残留
bash wetamp/scripts/install.sh --purge-v1            # 删 V1 条目；残留移到 backups/v1-<UTC>/files/<原绝对路径>，不删除
bash wetamp/scripts/install.sh --remote-hooks        # 远端：只要 node；node --check + 真跑一次 guard，写 install.json
```

- 去重保留 matcher 不同的同一 handler；V1 清单都不带 matcher，补齐时只认"全部"分组（未设置/空/`*`）。`context-budget.cjs` 尾部的 `claude` 参数去掉后归一为一条。目标文件不存在时按空文件补齐并创建（dry-run 打印与空文件的 diff，不写）。
- 只动 superagent 自己的 handler（V1 checkout/release 路径或本 `wetamp/hooks/`），其他 hooks 原样保留；只有命令串改写时原地替换，保留文件排版。
- `--remote-hooks` 写 `${XDG_STATE_HOME:-~/.local/state}/superagent/install.json`（`installer:"superagent_v2"`、`role:"worker"`、`wetamp`、`commit`、`hooks`）；已有 V1 台账先存 `.v1-<毫秒时间戳>` 副本。twin-toolkit 回执 schema 2 按此校验。
- worker 桩：`--remote-hooks` 把 `~/.local/bin/superagent` 指向本仓库 `bin/superagent`（原为普通文件先存 `.bak-<时间>`）。`bin/superagent` 读到 `role:"worker"` 且 `wetamp` 是自己时，在 `exec bun` 之前处理：`--version`/`--help` 照答，其余动词打印“仅本机运行（本机为控制面）”退出 69；不需要 bun 与 node_modules。twin-toolkit 回执 `checks` 记 `role`/`entry`。
- 默认安装（不带参数）不碰 hooks。

## 风险与口径

- 真实 `--hooks`/`--purge-v1` 写入由元帅执行；默认安装会写 `~/Library/LaunchAgents` 下的 plist，测试与验收须设 `SA_LAUNCHD_DIR`。
- codex 版本从 0.160.0 漂移到 0.162.1；`features.multi_agent` 键若被改名，包装器不会报错，可用 `SA_CODEX_REAL` 固定版本。
- 删除拦截只识别字面路径，变量展开或间接删除拦不住。
- 同一 guard 若同时挂在 matcher 分组与"全部"分组，命中两组的工具调用会让 G-1 计两次（更严，不会更松）。
- G-1 只计量编辑工具（Claude `Edit/Write/MultiEdit/NotebookEdit`、Codex `apply_patch`），shell 写文件不计；`*.md` 不计入。
- Archon detached 节点默认以 worker 身份运行（继承 reviewer/general 时保留），评审节点多数也用 240K 阈值。
- `exclude_user_instructions` 在 Archon 中没有对应字段，仅作为策略记录。
- `install.json` 与 V1 台账同位置，V1 工具读它会看到 V2 内容。

# Hooks：两条底线

默认放行。`guard.cjs` 供 Claude/Codex 原生 hooks 使用，`git-guardrail.cjs` 供旧 Git/OpenCode 适配器使用。hook 只拒绝：

1. 凭据隐私：隐私路径黑名单原样保留，检查 Read、编辑/补丁路径、Bash（含包装器）及所有 MCP 参数，包括裸工具名。黑名单包含 SSH 私钥（公开文件例外不变）、钥匙串、凭据文件、iCloud、任一路径段 `_private`、浏览器资料。`security find-*-password`、`dump-keychain`、`export` 仍拒绝。
2. 不可逆破坏：`git push --force/-f/+refspec/--force-with-lease`、`git reset --hard`，以及对家目录、仓库根或 `/`（含其祖先与软链目标）的 `rm -rf`。其余删除操作放行。

再委派、GitHub 写工具与发布、Serena 执行与写入、主检出及 `~/.superagent` 写入、reviewer 编辑、提权、kill/signal、跨元帅 hook 动作全部放行。删除效果登记表及 MCP 名称归一；隐私直接检查参数，不依赖登记。解析未知、锁等待失败或内部异常只留下 advisory，不挂起。hook 不是执行沙箱，不能完整推断脚本内部及间接执行效果。

## 事件与提示

- Claude：`SessionStart/PreToolUse/PostToolUse/SubagentStop/Stop` → `guard.cjs claude`；`UserPromptSubmit/PreToolUse` → `context-advisory.cjs`。
- Codex：前述五事件 → `guard.cjs codex`。Codex 只加载用户级 `hooks.json`；guard 信任检查仍确保两条底线有效。
- `permissionDecision:deny` 只服务两条底线；`systemMessage/additionalContext` 是不阻断的提示。
- 元帅 G-1 微改累计与派发上下文、Stop G-3、上下文阈值保留为 advisory。派生身份仅用于心跳/提示及计量分工，不用于拒绝。
- shell AST 保留变量、cwd、重定向、软链及 `bash -c`/`eval`/`find -exec` 等包装处理；不执行待检查命令。
- `hook-state.cjs` 的锁 helper 非零结果是计量失败，不是动作门禁；调用方捕获后 advisory 放行。
- `git-pre-commit.sh` 保留凭据扫描拒绝；仓库本地 hook/husky 失败仅记录 advisory。

## Provider 边界（本包不改）

原生 skills/plugins/MCP、guidance/settings/auth 保留；不再注入禁委派/禁写工具列表或强制 `features.multi_agent=false`。用户自己配置的工具限制仍由 provider 翻译。

Claude reviewer 保留 `filesystem.denyWrite:["/"]`、`failIfUnavailable` 及原有网络沙箱；Codex reviewer 保留 read-only sandbox 与必需 MCP 哨兵/proxy。删除 reviewer hook 拦截不赋予沙箱内仓库写权限，生成文件的测试仍可能被沙箱拒绝。真实 provider 测试尚未验证，不能据此断言沙箱是既有测试故障的唯一原因。

COORD 的 hook 写入/动作检查撤除；CLI/shim 的 owner/generation fencing 是引擎运行归属契约，继续保留。

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
- 目标未知不构成两条底线的命中；脚本内部的间接删除无法完整识别。
- 安装折叠自有 matcher/all 重叠，事件 ID 去重提供第二层保护；无 ID 的事件不能保证重复计量幂等。
- shell hook 是辅助检查，不是沙箱：脚本文件内部、未建模程序与间接执行的任意外部进程无法由该 hook 全面约束。交付仍按引擎的实际 diff/scope/有效风险门禁复核，provider 原生沙箱才是执行边界。
- Archon detached 节点默认以 worker 身份运行（继承 reviewer/general 时保留），评审节点多数也用 240K 阈值。
- `exclude_user_instructions` 在 Archon 中没有对应字段，仅作为策略记录。
- `install.json` 与 V1 台账同位置，V1 工具读它会看到 V2 内容。

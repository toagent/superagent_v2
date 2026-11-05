# superagent（wetamp/）

`wetamp/` 是 Archon 之上的治理与交付层。它把 `plan.json` 编译成 Archon 工作流，
负责隔离检出、确定性验收、人工门禁、恢复和本地集成。Archon 拥有运行生命周期；
superagent 保留控制面账本、投影和操作入口。

## 安装

前提是 `bun`、`git`、`jq`、`sqlite3`，并在仓库根目录执行过
`bun install --frozen-lockfile`。

```bash
wetamp/scripts/install.sh
ln -s "$PWD/wetamp/bin/superagent" ~/.local/bin/superagent
wetamp/scripts/selftest.sh
```

`install.sh` 幂等维护 `$ARCHON_HOME/.env`、`config.yaml` 的 superagent 别名段，
并渲染 `launchd/com.wetamp.superagent.supervise-tick.plist.tmpl`。脚本只打印
`launchctl bootstrap/bootout` 命令，是否加载由操作者决定。`--remote-hooks` 安装
worker 入口与 hooks；默认安装登记 controller。安装会保留未管理的配置和 hooks。

模型与路由真源是 `tiers.json`；修改后重跑 `install.sh`。真实诊断运行
`scripts/selftest.sh`，测试胶水层用 `scripts/selftest.sh --fake`。

## 状态目录

`SUPERAGENT_HOME` 默认为 `~/.superagent`，`ARCHON_HOME` 默认为
`$SUPERAGENT_HOME/archon`。主要内容：

- `archon/`：Archon 配置、数据库、工作树和运行产物；
- `gen/<run>/`：冻结的 plan、生成工作流与节点脚本；
- `runs/<run>.json`：superagent 运行账本；
- `jobs/`、`intake/`、`memory/`：后台作业、持续输入与经验回执。

运行产物不进入目标仓库。worker 安装只提供只读入口，不能启动 run。

## 升级 upstream

```bash
wetamp/scripts/upgrade-upstream.sh
wetamp/scripts/upgrade-upstream.sh --apply
```

第一条只读取并打印升级计划；第二条合并 `upstream/dev`，核对差异是否由
`wetamp/FORK` 登记，并更新 `wetamp/UPSTREAM`。脚本不提交、不 push。升级后按提示运行
`bun install --frozen-lockfile`、`cd wetamp && bun test` 和
`wetamp/scripts/selftest.sh`，确认后提交 `UPSTREAM`。

## 清理

```bash
wetamp/scripts/gc.sh
wetamp/scripts/gc.sh --apply
"$PWD/wetamp/bin/archon" workflow cleanup 30
```

`gc.sh` 默认只列出候选；`--apply` 仅处理已终结且本地分支已进入目标分支的 run，
不删除远端分支，也不强制删除未集成工作。

## 运维排障

- `superagent health --cwd <repo>` 检查 Archon、别名、安装角色、能力映射与 upstream 差异。
- `reason:"upstream_dirty"` 表示当前差异未被 `wetamp/FORK` 精确登记；加 `--verbose` 查看路径。
- `capability_drift` 表示 `capabilities.json` 引用的外部能力缺失。
- `preflight: no valid selftest receipt` 时运行不带 `--fake` 的 `scripts/selftest.sh`。
- repo 必须位于 `SUPERAGENT_WRITE_ROOTS` 指定的根目录内。
- 节点证据目录由 `superagent brief <run>` 返回；完整状态用 `superagent status <run>`。

## Plan 类型

`schemas/plan.schema.json` 是 wire 结构真源。修改 schema 后执行：

```bash
bun run --cwd wetamp generate:plan-types
bun run --cwd wetamp check:plan-types
```

提交生成的 `src/plan-types.generated.ts`。依赖与锁文件由根 workspace 管理。

## 文档

- [Agent 参考](docs/agent.md)：选择入口、运行、状态处置与协作命令；
- [架构](docs/00-architecture.md)：边界、持久化、门禁与交付；
- [Hooks 与 provider 边界](docs/04-hooks-and-nesting.md)；
- [经验与反思](docs/08-memory.md)；
- [持续输入](docs/09-continuous-intake.md)；
- [效率宪法](docs/efficiency-constitution.md)。

# PoC 记录（2026-10-09，元帅实测，fork 源码零改动）

环境：`bun 1.4.2`，`bun --cwd packages/cli src/cli.ts`（临时 shim `/tmp/archon`），`ARCHON_HOME` 默认 `~/.archon`，telemetry 经 `~/.archon/.env` 关闭。
目标：临时 git 仓库 `/tmp/sa-poc-repo`；工作流源 `/tmp/sa-poc-gen/.archon/workflows/sa-poc/sa-poc.yaml`（4 节点：bash → bash(sleep 45) → wait(event) → bash）。

| #   | 项                                                                                      | 结果         | 实测                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 源码直接运行                                                                            | ✅           | `archon --version` 0.15s；`doctor` 全过                                                                                                                                                                           |
| 2   | telemetry 关闭                                                                          | ✅           | `.env` 两行幂等追加；`telemetry status` disabled                                                                                                                                                                  |
| 3   | `validate workflows` 对生成目录                                                         | ✅           | 源目录必须是 git 仓库或 `--folder` 注册：生成器要 `git init` gen 目录                                                                                                                                             |
| 4   | `run --workflow-source <gen> --cwd <repo> --no-worktree --detach --json`                | ✅           | 启动 1s；ack 带 `runId/transcriptPath/logPath`；worker = 1 个 bun 进程，RSS 188 MB                                                                                                                                |
| 5   | `approval:` 节点 + `--detach`                                                           | ❌ 引擎拒绝  | "interactive-class … cannot be dispatched in the background"。**结论：无人值守门一律用 `wait: {event, deadline_ms}`**，不用 `approval:`                                                                           |
| 6   | `wait` 节点 `payload` 嵌套字段下游引用                                                  | ❌           | `output_format` 由 wait 固定、不可覆盖；下游只能读 `status/event/waited_ms`。**结论：同意 = signal 事件；拒绝 = `workflow cancel`**                                                                               |
| 7   | bash 节点引用上游输出                                                                   | ✅（有规则） | 必须 `var=$node.output.field` 先赋值再引用，否则 validate 告警                                                                                                                                                    |
| 8   | `kill -9` worker → 状态                                                                 | ⚠️           | run 行停在 `running`，`execution_owner.pid` 指向死进程；`resume` 拒绝（只接受 failed/paused）；bash 子进程成为孤儿继续跑完                                                                                        |
| 9   | `workflow wait <id> --json` 对孤儿 run                                                  | ✅           | 返回 `result: "owner_lost", observedStatus: "running"`，退出 0；这是 `--detach` 的官方配对动词，`superagent wait` 应直接用它而不是轮询 `get`                                                                      |
| 10  | upstream 对 owner_lost 的官方路径                                                       | ⚠️           | 只有 `abandon`（置 cancelled）→ `run --adopt <id>`（同一 worktree 起**新** run，节点缓存不继承，全部重跑）                                                                                                        |
| 11  | 状态回拨 `running→failed` 后 `resume --detach`                                          | ✅           | `sqlite3 ~/.archon/archon.db "update remote_agent_workflow_runs set status='failed' where id=… and status='running'"` → resume 1s；step1 走缓存未重跑（step3 读到 step1 原始 ts），被打断的 step2 重跑，到达 gate |
| 12  | 暂停在 `wait` 时 worker                                                                 | ⚠️           | worker 常驻等待（RSS 203 MB），直到事件/超时；`wake` 可在无 worker 时续跑                                                                                                                                         |
| 13  | `signal <id> --event poc.decision --resume-at <metadata.wait.resumeAt> --data … --json` | ✅           | 0s 接受，6s 内 run `completed`，worker 退出                                                                                                                                                                       |
| 14  | `wait` 对已完成 run                                                                     | ✅           | `result: attention, attention.kind: terminal`                                                                                                                                                                     |
| 15  | `ARCHON_HOME=~/.superagent/archon` 整条链路                                             | ✅           | run 453dfadb…：账本、workspaces、logs、detach 日志全部落在 `~/.superagent/archon/`，worker 继承该变量（`packages/paths/src/detached-install-context.ts`），`~/.archon` 未被触碰；telemetry 由新目录的 `.env` 关闭 |
| 16  | `workflow wait --json` 输出形态                                                         | ⚠️           | 阻塞期间可能先输出一段 JSON 再输出最终对象（多文档）；解析取最后一个对象                                                                                                                                          |

## 结论进设计

1. 红线人工门 = `wait: {event: sa.human.<M>, deadline_ms: TTL}`；supervisor tick：是 → `signal`，否 → `cancel`，过期 → run 失败并升级。
2. `superagent wait` = `archon workflow wait <id> --json --timeout N`：`owner_lost` 时执行 **状态回拨 + resume**（`wetamp/src/archon.ts` 的 `recover()`，只改 `status` 一列，写前校验 `execution_owner.host == 本机` 且 pid 不存在），作为永久 overlay 保留（用户决定不提 upstream PR），依赖的表/列登记进 `wetamp/UPSTREAM`，selftest 与升级脚本复测。
3. 生成器对 gen 目录 `git init`；bash 模板一律先赋值再引用。
4. 状态目录统一 `~/.superagent/`（用户 2026-10-09 决定）：shim 导出 `SUPERAGENT_HOME`/`ARCHON_HOME`，`~/.archon` 与 `~/.local/state/superagent` 不再使用（后者的 v3.db 只读留档）。
5. 常驻成本：每个活跃/等待中的 run 一个 ~200 MB bun 进程；无 run 为 0。红线等待可能持续数小时，M3 评估「等待时让 worker 退出、靠 `wake` 续跑」。

## 未做（留给 M0/M1 selftest）

- 带 `--branch/--from`（Archon 自建 worktree）的 run：需要 `origin` 远端；业务仓库都有 `origin`，临时仓库没有，M1 用 fixture 仓库加本地 bare origin 验证。
- `prompt:` 节点经原生 codex/claude provider 的真实调用（含 `output_format` JSON 校验、quota 自动恢复）。
- `--model @sa-reviewer=claude/opus` 在 `resume` 上是否生效（文档只写了 `run`）。

## 附：PoC 工作流原文（selftest 的 sa-smoke 以此为蓝本）

```yaml
name: sa-poc
description: superagent PoC - detach, kill -9, resume, durable event wait as unattended gate
nodes:
  - id: step1
    bash: |
      echo "step1 $(date +%s)" >> "$ARTIFACTS_DIR/trace.txt"
      printf '{"ts":"%s"}\n' "$(date +%s)"
    output_format: { type: object, properties: { ts: { type: string } } }
  - id: step2
    bash: |
      echo "step2 start $(date +%s)" >> "$ARTIFACTS_DIR/trace.txt"
      sleep 45
      echo "step2 end $(date +%s)" >> "$ARTIFACTS_DIR/trace.txt"
      echo ok
    depends_on: [step1]
  - id: gate
    wait: { event: poc.decision, deadline_ms: 900000 }
    depends_on: [step2]
  - id: step3
    bash: |
      ts=$step1.output.ts
      ev=$gate.output.event
      echo "step3 $(date +%s) prev_ts=$ts event=$ev" >> "$ARTIFACTS_DIR/trace.txt"
      echo done
    when: $gate.output.status == 'satisfied'
    depends_on: [gate]
```

命令序列（`ARCHON_HOME=~/.superagent/archon`，shim `/tmp/archon` = `bun --cwd packages/cli src/cli.ts`）：

```sh
git -C /tmp/sa-poc-gen init -q && git -C /tmp/sa-poc-gen add -A && git -C /tmp/sa-poc-gen commit -qm init
archon validate workflows --cwd /tmp/sa-poc-gen
archon workflow run sa-poc --workflow-source /tmp/sa-poc-gen --cwd /tmp/sa-poc-repo --no-worktree --detach --json   # → runId
kill -9 <worker pid>                                   # pid 见 workflow get --json 的 execution_owner
archon workflow wait <id> --json --timeout 30          # result: owner_lost
sqlite3 ~/.superagent/archon/archon.db "update remote_agent_workflow_runs set status='failed' where id='<id>' and status='running'"
archon workflow resume <id> --detach --json
archon workflow wait <id> --json --timeout 120         # 暂停在 gate
archon workflow get <id> --json                        # metadata.wait.resumeAt
archon workflow signal <id> --event poc.decision --resume-at <resumeAt> --data '{"decision":"yes"}' --json
archon workflow wait <id> --json --timeout 60          # attention.kind: terminal, status: completed
```

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeAtomic } from './config';
// prettier-ignore
import { Coordination, caller, repoScope, runScope, same, type Identity, type RunRef } from './coord';
import { launchAgent, orcaBin, type AgentLaunch } from './orca';
import { readJobs, type Job } from './jobs';
import { Intake, intakeRoot } from './intake';
import { renderHandoffContext } from './rollover-context';
import { supervisor } from './cli';

// prettier-ignore
export interface RolloverRecord {
  token: string; state: 'pending' | 'accepted' | 'cancelled'; from: Identity; to: Identity | null;
  repo: string; cwd: string; task_session: string; transcript: string; parent: string | null;
  prior_status: string; runs: string[];
  launch: { agent: string; model: string; operation_id: string | null; outcome: unknown; args?: string[] };
  steps: Partial<Record<string, 'done'>>; created_at: string; accepted_at: string | null; cancelled_at: string | null;
  skipped?: Record<string, string>;
}

// prettier-ignore
interface Deps {
  env: NodeJS.ProcessEnv; cwd: string; coord: Coordination; who: () => Identity;
  exists: (path: string) => boolean; read: (path: string) => string;
  write: (path: string, text: string) => void; files: (path: string) => string[];
  tasks: (cwd: string, args: string[]) => string; repo: (cwd: string) => string;
  launch: (bin: string, args: string[]) => Promise<AgentLaunch>;
  supervise: (args: string[]) => string;
  now: () => Date; token: () => string; sleep: (ms: number) => Promise<void>; jobs: () => Job[];
}

const taskBin = join(process.env.HOME ?? '', '.wetamp/bin/tasks.sh');
// prettier-ignore
const defaults = (coord: Coordination): Deps => ({ env: process.env, cwd: process.cwd(), coord, who: () => caller(), exists: existsSync, read: path => readFileSync(path, 'utf8'), write: writeAtomic, files: path => existsSync(path) ? readdirSync(path) : [], tasks: (cwd, args) => execFileSync('bash', [taskBin, ...args], { cwd, encoding: 'utf8' }).trim(), launch: launchAgent, supervise: supervisor, repo: cwd => execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), now: () => new Date(), token: () => randomBytes(16).toString('hex'), sleep: ms => Bun.sleep(ms), jobs: () => readJobs().jobs });

// prettier-ignore
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v), terminal = new Set(['failed', 'completed', 'cancelled']);

// prettier-ignore
export class Rollover {
  readonly d: Deps; readonly root: string;
  constructor(overrides: Partial<Deps> = {}) {
    this.d = { ...defaults(overrides.coord ?? new Coordination()), ...overrides };
    this.root = join(this.d.coord.d.sa, 'coord', 'rollovers');
  }
  private path(token: string): string {
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('rollover: invalid token');
    return join(this.root, `${token}.json`);
  }
  // prettier-ignore
  private records(): RolloverRecord[] { return this.jsonFiles(this.root) as unknown as RolloverRecord[]; }
  // prettier-ignore
  private jsonFiles(path: string, tolerateInvalid = false): Record<string, unknown>[] { return this.d.files(path).filter(f => f.endsWith('.json')).flatMap(file => { try { const value = JSON.parse(this.d.read(join(path, file))) as unknown; return object(value) ? [value] : []; } catch (error) { if (tolerateInvalid) return []; throw new Error(`rollover: 无法读取 ${join(path, file)}：${error instanceof Error ? error.message : String(error)}`); } }); }
  private save(r: RolloverRecord): void {
    this.d.coord.locked(() => {
      mkdirSync(this.root, { recursive: true });
      this.d.write(this.path(r.token), JSON.stringify(r) + '\n');
    });
  }
  private load(token: string): RolloverRecord {
    const path = this.path(token);
    if (!this.d.exists(path)) throw new Error('rollover: unknown token');
    return JSON.parse(this.d.read(path)) as RolloverRecord;
  }
  private transcript(who: Identity): { path: string; model: string } {
    const live = join(this.d.coord.d.sa, 'live');
    const beat = this.jsonFiles(live, true).find(v => same(v as unknown as Identity, who));
    const path = typeof beat?.transcript_path === 'string' ? beat.transcript_path : '';
    if (!path || !this.d.exists(path)) throw new Error('rollover: 找不到当前会话 transcript');
    let attached = '', assistant = '', context = '';
    for (const line of this.d.read(path).split('\n')) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!object(row)) continue;
      const payload = object(row.payload) ? row.payload : row;
      if (row.type === 'turn_context' && typeof payload.model === 'string') context = payload.model;
      const attachment = object(row.attachment) ? row.attachment : object(payload.attachment) ? payload.attachment : null;
      if (attachment?.type === 'model' && object(attachment.identity) && typeof attachment.identity.modelId === 'string') attached = attachment.identity.modelId;
      const message = object(row.message) ? row.message : object(payload.message) ? payload.message : null;
      if ((row.type === 'assistant' || payload.type === 'assistant') && typeof message?.model === 'string') assistant = message.model;
    }
    const model = who.client === 'claude' ? attached || assistant : context;
    if (!model) throw new Error('rollover: transcript 中找不到模型');
    return { path: resolve(path), model };
  }
  private task(): { path: string; session: string; status: string } {
    const path = resolve(this.d.tasks(this.d.cwd, ['path']));
    if (!this.d.exists(path)) throw new Error(`rollover: 任务栈不存在 ${path}`);
    const text = this.d.read(path),
      missing: string[] = [];
    const field = (name: string): string => (new RegExp(`^${name}[:：]\\s*(.+)$`, 'm').exec(text))?.[1]?.trim() ?? '';
    for (const name of ['主任务', '断点']) if (!field(name)) missing.push(name);
    const lines = text.split(/\r?\n/),
      sections = ['接手必读', '在途', '已核实与更正'];
    for (const name of sections) {
      const index = lines.findIndex(line => new RegExp(`^(?:#{1,6}\\s*)?${name}(?:[:：]\\s*.*)?$`).test(line.trim()));
      const inline = index < 0 ? '' : lines[index].replace(new RegExp(`^(?:#{1,6}\\s*)?${name}[:：]?\\s*`), '');
      const body = index < 0 ? [] : lines.slice(index + 1, lines.findIndex((line, i) => i > index && (/^#{1,6}\s+/.test(line.trim()) || sections.some(section => new RegExp(`^${section}[:：]`).test(line.trim())))) < 0 ? undefined : lines.findIndex((line, i) => i > index && (/^#{1,6}\s+/.test(line.trim()) || sections.some(section => new RegExp(`^${section}[:：]`).test(line.trim())))));
      if (index < 0 || ![inline, ...body].some(line => line.trim())) missing.push(name);
    }
    if (missing.length) throw new Error(`rollover: 任务栈缺少：${missing.join('、')}`);
    return { path, session: basename(dirname(path)), status: field('状态') };
  }
  private runs(who: Identity): RunRef[] {
    return this
      .jsonFiles(join(this.d.coord.d.sa, 'runs'))
      .map(value => value as unknown as RunRef)
      .flatMap(run => {
        const scopes = this.scopes(run);
        return scopes && same(this.d.coord.owner(scopes.run).owner, who) && !terminal.has(this.runStatus(run))
          ? [run]
          : [];
      });
  }
  private scopes(run: RunRef): { run: ReturnType<typeof runScope>; repo: ReturnType<typeof repoScope> } | null {
    try { const repo = repoScope(run.repo); return { run: runScope(run), repo }; } catch { return null; }
  }
  private runStatus(run: RunRef): string {
    try { return this.d.coord.d.status(run); } catch { return 'unknown'; }
  }
  private owner(who: Identity): string {
    if (!who.session_id) throw new Error('rollover: owner 缺少 session_id');
    return `${who.client}:${who.session_id}`;
  }
  private workers(sessionId: string): { id: string; cwd: string }[] {
    const root = join(
      this.d.env.AGENT_SUPERVISOR_STATE ?? join(this.d.env.HOME ?? '', '.local/state/agent-supervisor'),
      'workers'
    );
    return this.jsonFiles(root).flatMap(value =>
      value.session_id === sessionId && typeof value.id === 'string' && typeof value.cwd === 'string'
        ? [{ id: value.id, cwd: value.cwd }]
        : []
    );
  }
  // prettier-ignore
  private async dispatch(r: RolloverRecord, retry = false, reason?: string): Promise<RolloverRecord> {
    const bin = orcaBin(this.d.env, this.d.exists), operation = r.launch.operation_id;
    if (!bin || (retry && !operation)) throw new Error('rollover: Orca launch state invalid');
    if (!retry) { r.launch.args = ['agent', 'launch', '--agent', r.launch.agent, '--worktree', `path:${r.cwd}`, '--model', r.launch.model, '--prompt', this.prompt(r, reason), '--focus', '--json']; this.save(r); }
    if (!r.launch.args) throw new Error('rollover: 缺少首次 launch 参数，无法安全重试；请 rollover cancel');
    const lastArg = r.launch.args.at(-1); if (!lastArg) throw new Error('rollover: 首次 launch 参数为空，无法安全重试；请 rollover cancel'); const args = retry ? [...r.launch.args.slice(0, -1), '--retry-launch', operation ?? '', lastArg] : r.launch.args;
    const result = await this.d.launch(bin, args);
    if (result.kind === 'launched') r.launch.outcome = result.outcome;
    else if (result.kind === 'lost') r.launch.operation_id = result.operation_id;
    else if (result.kind === 'unknown') r.launch.outcome = 'unknown';
    else {
      let resumeError: unknown;
      try { this.d.tasks(r.cwd, ['resume', r.task_session, r.prior_status]); }
      catch (error) { resumeError = error; }
      finally { r.state = 'cancelled'; r.cancelled_at = this.d.now().toISOString(); this.save(r); }
      if (resumeError) throw new Error(`rollover: launch 失败且恢复任务栈失败：${result.error}；${resumeError instanceof Error ? resumeError.message : JSON.stringify(resumeError)}`);
      throw new Error(`rollover: launch 失败：${result.error}`);
    }
    this.save(r);
    if (result.kind === 'lost') throw new Error(`rollover: launch 回包丢失；重跑 rollover start（operation ${result.operation_id}）`);
    if (result.kind === 'unknown') throw new Error(`rollover: launch 结果不明；请在 Orca 核对后 rollover cancel ${r.token}`);
    return r;
  }
  private prompt(r: RolloverRecord, reason = '上下文过大自动交接'): string {
    return `接手元帅会话（${this.d.now().toLocaleString()}，原因：${reason}）。第 1 步：cd ${r.cwd} && superagent rollover accept ${r.token}，按输出接手。第 2 步：superagent rollover context ${r.token}，读完用户原话与压缩摘要。第 3 步：读输出给出的任务栈文件，按「接手必读」「在途」「已核实与更正」继续，并按 accept 输出重新挂起 run 等待。首条汇报先逐条列出你确认的用户决定与纠正、主任务、下一步；汇报首行贴 superagent 输出的 quota 行。`;
  }
  async start(reason = '上下文过大自动交接'): Promise<Record<string, unknown>> {
    if (!this.d.env.ORCA_AGENT_SESSION_ID || !orcaBin(this.d.env, this.d.exists)) throw new Error('仅 Orca 内支持自动交接；其他客户端沿用：任务栈写断点并把状态改为被中断 → 新开会话 tasks.sh list → tasks.sh adopt <会话目录名>');
    const from = this.d.who();
    if (!from.session_id) throw new Error('rollover: caller 缺少 session_id');
    const pending = this.records().find(r => r.state === 'pending' && r.from.session_id === from.session_id);
    if (pending) {
      if (pending.launch.outcome === 'unknown') throw new Error(`rollover: launch 结果不明；请先 rollover cancel ${pending.token}`);
      if (pending.launch.operation_id && pending.launch.outcome === null) return this.result(await this.dispatch(pending, true));
      if (pending.launch.outcome === null) throw new Error(`rollover: launch 未完成且无 operation id；请先 rollover cancel ${pending.token}`);
      return this.result(pending);
    }
    const task = this.task(),
      transcript = this.transcript(from),
      now = this.d.now().toISOString(),
      runs = this.runs(from);
    const r: RolloverRecord = {
      token: this.d.token(), state: 'pending', from, to: null, repo: this.d.repo(this.d.cwd), cwd: this.d.cwd,
      task_session: task.session, transcript: transcript.path,
      parent: this.records().find(x => x.state === 'accepted' && x.to?.session_id === from.session_id)?.token ?? null,
      prior_status: task.status, runs: runs.map(x => x.run_id),
      launch: { agent: from.client, model: transcript.model, operation_id: null, outcome: null },
      steps: {}, created_at: now, accepted_at: null, cancelled_at: null,
    };
    this.save(r);
    try { this.d.tasks(this.d.cwd, ['handoff', task.session]); }
    catch (error) { try { this.d.tasks(r.cwd, ['resume', r.task_session, r.prior_status]); } finally { r.state = 'cancelled'; r.cancelled_at = this.d.now().toISOString(); this.save(r); } throw error; }
    return this.result(await this.dispatch(r, false, reason));
  }
  private result(r: RolloverRecord): Record<string, unknown> {
    return { token: r.token, state: r.state, wait: `superagent rollover wait ${r.token} --timeout 1800` };
  }
  accept(token: string): Record<string, unknown> {
    const to = this.d.who();
    if (!to.session_id) throw new Error('rollover: caller 缺少 session_id');
    let r = this.load(token);
    this.d.coord.locked(() => {
      r = this.load(token);
      if (r.state !== 'pending' || (r.to && !same(r.to, to))) throw new Error(`rollover: ${r.state === 'pending' ? '已被其他会话接手' : `记录已${r.state}`}`);
      if (same(r.from, to) || !r.from.host || !to.host || r.from.host !== to.host) throw new Error('rollover: 必须由同 host 的新会话接手');
      r.to = to;
      r.steps.lock_to = 'done';
      this.save(r);
    });
    const skipped: Record<string, string> = r.skipped ?? {};
    if (!r.steps.transfer) {
      for (const id of r.runs) {
        const run = this.d.coord.resolveRun(id);
        if (!run) {
          skipped[id] = 'run_missing';
          continue;
        }
        const scopes = this.scopes(run);
        if (!scopes) {
          skipped[id] = 'repository_unavailable';
          continue;
        }
        const moved = this.d.coord.rolloverTransfer(scopes.run, r.from, to, token);
        if (moved.status === 'skipped') {
          skipped[id] = moved.reason ?? 'owner_changed';
          continue;
        }
        this.d.coord.rolloverTransfer(scopes.repo, r.from, to, token);
      }
      r.skipped = skipped;
      r.steps.transfer = 'done';
      this.save(r);
    }
    if (!r.steps.reauthorize) {
      for (const id of r.runs) {
        const run = this.d.coord.resolveRun(id);
        if (run && !skipped[id] && !terminal.has(this.runStatus(run)) && run.gen_dir && this.d.exists(join(run.gen_dir, 'delivery-authorization.json'))) this.d.coord.reauthorize(run, to);
      }
      r.steps.reauthorize = 'done';
      this.save(r);
    }
    if (!r.steps.intake) {
      const root = intakeRoot(this.d.coord.d.sa, r.repo);
      if (this.d.exists(join(root, 'state.json')))
        new Intake(root).rehomeOwner(this.owner(r.from), this.owner(to), `rollover:${token}`);
      r.steps.intake = 'done';
      this.save(r);
    }
    if (!r.steps.supervisor) {
      for (const worker of this.workers(r.from.session_id ?? ''))
        this.d.supervise([
          'register', '--id', worker.id, '--provider', to.client, '--cwd', worker.cwd,
          '--session', to.session_id, '--pid', String(to.pid),
        ]);
      r.steps.supervisor = 'done';
      this.save(r);
    }
    if (!r.steps.adopt) {
      this.d.tasks(r.cwd, ['adopt', r.task_session, '--owner', to.session_id]);
      r.steps.adopt = 'done';
      this.save(r);
    }
    r.state = 'accepted';
    r.accepted_at = this.d.now().toISOString();
    this.save(r);
    const runs = r.runs.map(id => { const run = this.d.coord.resolveRun(id); return { run: id, status: run ? this.runStatus(run) : 'missing', wait: `superagent wait ${id} --timeout 3000`, skipped: skipped[id] }; });
    const jobs = this.d
      .jobs()
      .filter(j => j.launcher?.session_id === r.from.session_id && ['queued', 'running'].includes(j.state))
      .map(j => ({ id: j.id, title: j.title, log: j.log }));
    return { state: r.state, task: join(r.cwd, '.context', 'sessions', r.task_session, 'task-stack.md'), runs, jobs };
  }
  cancel(token: string): Record<string, unknown> {
    const who = this.d.who(),
      r = this.load(token);
    if ((who.client !== 'shell' && !same(who, r.from)) || r.state !== 'pending' || r.to) throw new Error('rollover: 当前记录不可取消');
    this.d.tasks(r.cwd, ['resume', r.task_session, r.prior_status]);
    r.state = 'cancelled';
    r.cancelled_at = this.d.now().toISOString();
    this.save(r);
    return this.result(r);
  }
  async wait(token: string, timeout: number): Promise<{ state: string; exit: number }> {
    const end = this.d.now().getTime() + timeout * 1000;
    let state = this.load(token).state;
    while (state === 'pending' && this.d.now().getTime() < end) { await this.d.sleep(2000); state = this.load(token).state; }
    return { state, exit: state === 'pending' ? 2 : 0 };
  }
  status(): Record<string, unknown>[] {
    return this.records().map(r => ({ token: r.token.slice(0, 8), state: r.state, from: r.from.session_id?.slice(0, 8), to: r.to?.session_id?.slice(0, 8), at: r.accepted_at ?? r.cancelled_at ?? r.created_at }));
  }
  async context(token: string): Promise<string> {
    const who = this.d.who();
    let current: RolloverRecord | null = this.load(token);
    if (!who.host || !current.from.host || who.host !== current.from.host)
      throw new Error('rollover: context 只允许同 host 会话读取');
    const chain: RolloverRecord[] = [];
    for (let depth = 0; current && depth < 5; depth++) {
      chain.push(current);
      current = current.parent ? this.load(current.parent) : null;
    }
    chain.reverse();
    return renderHandoffContext(
      chain.map((record, index) => {
        if (record.from.client !== 'claude' && record.from.client !== 'codex')
          throw new Error(`rollover: 不支持 context client ${record.from.client}`);
        return {
          client: record.from.client,
          transcript: record.transcript,
          label: `第 ${String(index + 1)} 代 ${record.from.client}:${record.from.session_id ?? 'unknown'}`,
        };
      })
    );
  }
}

export async function rolloverCommand(
  command: string,
  token?: string,
  options: { reason?: string; timeout?: number } = {}
): Promise<{ exit: number; value: unknown }> {
  const r = new Rollover();
  if (command === 'start') return { exit: 0, value: await r.start(options.reason) };
  if (command === 'accept') return { exit: 0, value: r.accept(token ?? '') };
  if (command === 'wait') {
    const value = await r.wait(token ?? '', options.timeout ?? 1800);
    return { exit: value.exit, value };
  }
  if (command === 'cancel') return { exit: 0, value: r.cancel(token ?? '') };
  if (command === 'status') return { exit: 0, value: r.status() };
  if (command === 'context') return { exit: 0, value: await r.context(token ?? '') };
  throw new Error('usage: superagent rollover <start|accept|wait|cancel|status|context>');
}

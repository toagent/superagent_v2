import { createHash } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import Ajv2020 from '../../packages/workflows/node_modules/ajv/dist/2020';
import { buildExport } from '../src/export';
import { intakeRoot } from '../src/intake';
import { tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const schema = JSON.parse(readFileSync(join(WETAMP, 'schemas/task-export.schema.json'), 'utf8'));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
const saved = { SUPERAGENT_HOME: process.env.SUPERAGENT_HOME, ARCHON_HOME: process.env.ARCHON_HOME };
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

type Output = { status: string; scope: { scope_id: string }; artifact_retention: Record<string, unknown>; coverage: Record<string, { scanned: number | null; emitted: number }>; records: Record<string, unknown>[]; errors: { code: string; source_kind: string | null }[]; since: string; until: string };
let root = '', repo = '', jobs = '';
const run = (...args: string[]) => {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const addJob = (id: string, state: string, started: string, ended?: string, extra: Record<string, unknown> = {}) => writeJson(join(jobs, `${id}.json`), {
  id, title: id, card: null, log: null, cwd: repo, kind: 'codex', model: null,
  wrapper_pid: state === 'running' ? process.pid : 0, pid: 0, started_at: started, state,
  ...(ended ? { ended_at: ended } : {}), ...extra,
});
const args = (since = '2026-11-02T00:00:00Z', until = '2026-11-04T00:00:00Z') => ['export', '--source-instance', 'fixture', '--since', since, '--until', until, '--timezone', 'Asia/Taipei', '--all-repos', '--json'];
const exportAt = (at = '2026-11-05T00:00:00Z') => {
  const result = buildExport(args(), new Date(at));
  expect(result.error).toBeUndefined();
  expect(validate(result.output), JSON.stringify(validate.errors)).toBe(true);
  return { exit: result.exit, output: result.output as Output };
};
const treeHash = (path: string): string => {
  const hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(dir, entry.name); hash.update(entry.name);
      if (entry.isDirectory()) visit(child); else hash.update(readFileSync(child));
    }
  };
  visit(path); return hash.digest('hex');
};

beforeEach(() => {
  root = tmp(); repo = join(root, 'repo');
  mkdirSync(repo); run('git', '-C', repo, 'init', '-q');
  const sa = join(root, 'home'), archon = join(sa, 'archon'); jobs = join(sa, 'jobs');
  mkdirSync(join(sa, 'runs'), { recursive: true }); mkdirSync(jobs); mkdirSync(archon);
  Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: archon });
  const gen = join(sa, 'gen', 'r1'); mkdirSync(gen, { recursive: true });
  writeJson(join(gen, 'plan.json'), {
    repo, base_ref: 'main', request_ref: 'req-1', packages: [
      { id: 'p1', title: '包一', goal: '目标一', scope: ['a'], accept: [], risk: 'G1', size: 'S' },
      { id: 'p2', title: '包二', goal: '目标二', scope: ['b'], accept: [], risk: 'G1', size: 'S' },
    ], budget: { coder_tokens: 1, review_tokens: 1 },
  });
  writeJson(join(sa, 'runs', 'r1.json'), {
    run_id: 'r1', archon_run_id: 'a2', plan: join(gen, 'plan.json'), gen_dir: gen, repo,
    branch: 'sa/r1', workflow: 'sa-r1', console: 'codex', started_at: '2026-11-01T20:00:00Z', transcript: '', log: '',
    adoptions: [{ at: '2026-11-03T02:00:00Z', from: 'a1', to: 'a2', engine_from: null, engine_to: 'x', reason: 'resume' }],
  });
  const db = new Database(join(archon, 'archon.db'));
  db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT PRIMARY KEY,status TEXT,started_at TEXT,completed_at TEXT,last_activity_at TEXT,output_root TEXT,metadata TEXT)');
  db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id TEXT,event_order INTEGER,event_type TEXT,step_name TEXT,created_at TEXT)');
  db.run("INSERT INTO remote_agent_workflow_runs VALUES ('a1','failed','2026-11-01T21:00:00Z','2026-11-02T01:00:00Z','2026-11-02T01:00:00Z',NULL,NULL)");
  db.run("INSERT INTO remote_agent_workflow_runs VALUES ('a2','completed','2026-11-03T02:00:00Z','2026-11-03T03:00:00Z','2026-11-03T03:00:00Z',NULL,NULL)");
  db.close();
  addJob('job-done', 'done', '2026-11-02T05:00:00Z', '2026-11-02T06:00:00Z', { request_ref: 'same' });
  addJob('job-running', 'running', '2026-11-03T05:00:00Z', undefined, { request_ref: 'same' });
  addJob('job-lost', 'running', '2026-11-03T06:00:00Z', undefined, { wrapper_pid: 999_999_999 });
  addJob('job-old', 'done', '2026-10-30T05:00:00Z', '2026-10-30T06:00:00Z');
});

test('导出 run/package/job，保留恢复身份、状态和来源数量，且源数据只读', () => {
  const before = treeHash(join(root, 'home'));
  const { exit, output } = exportAt();
  expect(exit).toBe(3); expect(output.status).toBe('partial');
  expect(output.coverage.run).toMatchObject({ scanned: 1, emitted: 3 });
  expect(output.coverage.job).toMatchObject({ scanned: 4, emitted: 3 });
  expect(output.records.map(item => [item.source_kind, item.source_id])).toEqual([
    ['job', 'job-done'], ['job', 'job-lost'], ['job', 'job-running'],
    ['package', '["r1","p1"]'], ['package', '["r1","p2"]'], ['run', 'r1'],
  ]);
  const exportedRun = output.records.find(item => item.source_kind === 'run')!;
  expect(exportedRun).toMatchObject({ state: 'completed', created_at: '2026-11-01T20:00:00.000Z' });
  expect((exportedRun.attempts as unknown[])).toHaveLength(2);
  expect(output.records.find(item => item.source_id === 'job-lost')).toMatchObject({ state: 'unknown', terminal: null });
  expect(output.errors.map(item => item.code)).toEqual(['HISTORY_UNKNOWN', 'HISTORY_UNKNOWN', 'HISTORY_UNKNOWN']);
  expect(treeHash(join(root, 'home'))).toBe(before);
});

test('相同事实的 revision 与 scope 稳定，真实状态改变后 revision 改变', () => {
  const first = exportAt('2026-11-05T00:00:00Z').output;
  const second = exportAt('2026-11-05T01:00:00Z').output;
  expect(second.scope.scope_id).toBe(first.scope.scope_id);
  expect(second.records.map(item => item.revision)).toEqual(first.records.map(item => item.revision));
  addJob('job-done', 'failed', '2026-11-02T05:00:00Z', '2026-11-02T06:00:00Z', { request_ref: 'same', exit_code: 1 });
  const changed = exportAt('2026-11-05T02:00:00Z').output.records.find(item => item.source_id === 'job-done');
  expect(changed?.revision).not.toBe(first.records.find(item => item.source_id === 'job-done')?.revision);
});

test('显式偏移与 DST 窗口按半开 UTC 区间处理', () => {
  addJob('at-until', 'done', '2026-11-03T05:00:00Z', '2026-11-03T05:30:00Z');
  const result = buildExport(['export', '--source-instance', 'fixture', '--since', '2026-11-02T01:00:00-04:00', '--until', '2026-11-03T00:00:00-05:00', '--timezone', 'America/New_York', '--all-repos', '--json'], new Date('2026-11-05T00:00:00Z'));
  expect(validate(result.output), JSON.stringify(validate.errors)).toBe(true);
  const output = result.output as Output;
  expect([output.since, output.until]).toEqual(['2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z']);
  expect(output.records.some(item => item.source_id === 'at-until')).toBe(false);
  const gap = buildExport(args('2026-11-02T02:00:00Z', '2026-11-03T01:00:00Z'), new Date('2026-11-05T00:00:00Z')).output as Output;
  expect(gap.records.some(item => item.source_id === 'r1')).toBe(false);
});

test('无效参数返回 exit 2；CLI stdout 为空且 stderr 不回显参数值', () => {
  const invalid = [
    ['export', '--source-instance', 'x', '--since', '2026-11-01T00:00:00Z', '--until', '2026-11-02T00:00:00Z', '--timezone', 'UTC', '--all-repos'],
    ['export', '--source-instance', 'x', '--since', '2026-11-05T00:00:00Z', '--until', '2026-11-06T00:00:00Z', '--timezone', 'UTC', '--all-repos', '--json'],
    ['export', '--source-instance', 'x', '--since', '2026-11-01T00:00:00Z', '--until', '2026-11-02T00:00:00Z', '--timezone', 'UTC', '--all-repos', '--repo', repo, '--json'],
  ];
  for (const value of invalid) {
    const checked = buildExport(value, new Date('2026-11-05T00:00:00Z'));
    expect(checked.exit).toBe(2); expect(checked.output).toBeUndefined();
  }
  const result = Bun.spawnSync([process.execPath, join(WETAMP, 'src/cli.ts'), ...invalid[0]], { cwd: WETAMP, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(2); expect(result.stdout.toString()).toBe(''); expect(result.stderr.toString()).toContain('INVALID_ARGUMENT --json');
});

test('损坏 job 不掩盖其他记录并返回结构化 partial', () => {
  writeFileSync(join(jobs, 'broken.json'), '{');
  const { exit, output } = exportAt();
  expect(exit).toBe(3); expect(output.records.some(item => item.source_id === 'job-done')).toBe(true);
  expect(output.coverage.job).toMatchObject({ status: 'partial', scanned: 5 });
  expect(output.errors).toContainEqual(expect.objectContaining({ code: 'SOURCE_UNREADABLE', source_kind: 'job' }));
});

test('记录数超限整体失败且不返回截断数据', () => {
  for (let index = 0; index < 9_998; index++) addJob(`bulk-${String(index).padStart(5, '0')}`, 'done', '2026-11-02T05:00:00Z', '2026-11-02T06:00:00Z');
  const result = buildExport(args(), new Date('2026-11-05T00:00:00Z'));
  const output = result.output as Output;
  expect(result.exit).toBe(1); expect(output.status).toBe('failed'); expect(output.records).toEqual([]);
  expect(output.errors).toEqual([expect.objectContaining({ code: 'EXPORT_TOO_LARGE' })]);
  expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

test('真实空来源不伪报 complete，intake 的未知历史明示', () => {
  const empty = tmp(), sa = join(empty, 'home'); mkdirSync(join(sa, 'runs'), { recursive: true }); mkdirSync(join(sa, 'jobs')); mkdirSync(join(sa, 'archon'));
  Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: join(sa, 'archon') });
  const result = buildExport(args(), new Date('2026-11-05T00:00:00Z'));
  const output = result.output as Output;
  expect(result.exit).toBe(3); expect(output.records).toEqual([]); expect(output.status).toBe('partial');
  expect(output.coverage.intake).toMatchObject({ status: 'complete', scanned: 0, emitted: 0 });
  expect(output.errors).toContainEqual(expect.objectContaining({ code: 'HISTORY_UNKNOWN', source_kind: 'intake' }));
  expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

test('原始 intake 保留取消项、跨仓同 ID 与显式执行依赖关系，且敏感字段不外泄', () => {
  const repo2 = join(root, 'repo2'); mkdirSync(repo2); run('git', '-C', repo2, 'init', '-q');
  const secret = 'PRIVATE-TOKEN-DO-NOT-EXPORT';
  for (const [path, parent] of [[repo, 'parent-task'], [repo2, undefined]] as const) {
    const dir = intakeRoot(join(root, 'home'), path); mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'state.json'), { version: 1, inputs: [{ secret }], tasks: [{
      id: 'same-task', repo: path, actor: secret, owner: secret, revision: 2,
      revisions: [{ brief: secret, acceptance: secret, input: secret }], dependencies: ['dep-task'],
      ...(parent ? { parent } : {}), questions: [], cancellations: [{ revision: 2, input: secret }],
      runs: [{ revision: 2, launch_id: 'l1', plan: secret, digest: secret, dispatch: 'accepted', run_id: 'r1', requirement_map: [{ task_requirement_id: 't', package: 'p1', requirement_id: 'r' }] }],
    }] });
  }
  const before = treeHash(join(root, 'home')), { output } = exportAt();
  const intakes = output.records.filter(item => item.source_kind === 'intake' && item.source_id === 'same-task');
  expect(intakes).toHaveLength(2); expect(new Set(intakes.map(item => item.repo_id)).size).toBe(2);
  const bound = intakes.find(item => item.repo_id === output.records.find(item => item.source_kind === 'run')?.repo_id)!;
  expect(bound).toMatchObject({ state: 'cancelled', source_revision: 2, parent: { source_id: 'parent-task' } });
  expect((bound.related as { relation: string; target: { source_id: string } }[]).map(item => [item.relation, item.target.source_id])).toContainEqual(['executes', '["r1","p1"]']);
  expect(JSON.stringify(output)).not.toContain(secret); expect(treeHash(join(root, 'home'))).toBe(before);
  expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

test('plan 定义、coder、acceptance 与 degraded review 分开，且只读固定产物字段', () => {
  const planPath = join(root, 'home', 'gen', 'r1', 'plan.json'), plan = JSON.parse(readFileSync(planPath, 'utf8')), ledgerPath = join(root, 'home', 'runs', 'r1.json'), ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  plan.packages[0].accept = [{ cmd: 'bun test' }]; plan.packages[1].accept = [{ cmd: 'bun lint' }]; writeJson(planPath, plan);
  ledger.delivery = { repo, branch: 'main' }; writeJson(ledgerPath, ledger);
  const outputRoot = join(root, 'home', 'workspace'), artifacts = join(outputRoot, 'artifacts', 'runs', 'a2'); mkdirSync(artifacts, { recursive: true });
  const db = new Database(join(root, 'home', 'archon', 'archon.db')); db.run('UPDATE remote_agent_workflow_runs SET output_root=? WHERE id=?', [outputRoot, 'a2']);
  for (const [order, node, at] of [[1, 'code-p1', '2026-11-03T02:10:00Z'], [2, 'repair-p1', '2026-11-03T02:20:00Z'], [3, 'settle-p1', '2026-11-03T02:30:00Z'], [4, 'publish-m1', '2026-11-03T02:40:00Z']] as const) db.run("INSERT INTO remote_agent_workflow_events VALUES ('a2',?,'node_completed',?,?)", [order, node, at]);
  db.close();
  writeJson(join(artifacts, 'verify-p1.coder.json'), { status: 'done', notes: '已交付证据导出。', blockers: [], deviations: [], needs: [], changed_files: ['src/a.ts'], quick_checks: [{ cmd: 'bun test', exit: 0 }], error_class: null, token: 'LEAK-ME', artifact: '../../outside' });
  writeJson(join(artifacts, 'settle-p1.coder.json'), { status: 'done', notes: '', blockers: [], deviations: [], needs: [], changed_files: [], quick_checks: [], error_class: null });
  writeJson(join(artifacts, 'settle-p1.json'), { command_results: [{ check: { cmd: 'bun test' }, exit: 1 }], insights: [{ kind: 'caution', content: '保留实测失败。', origin: 'agent' }] });
  writeJson(join(artifacts, 'publish-m1.json'), { status: 'published', receipt: { status: 'published', target_tip: 'a'.repeat(40), integrated: 'b'.repeat(40) } });
  writeFileSync(join(artifacts, 'settle-p2.json'), '{');
  writeJson(join(artifacts, 'gate-m1-r1.json'), { grade: 'DEGRADED_PASS', verdict: 'pass' });
  const { output } = exportAt(), p1 = output.records.find(item => item.source_id === '["r1","p1"]')!, p2 = output.records.find(item => item.source_id === '["r1","p2"]')!;
  expect((p1.checks as Record<string, unknown>[]).map(item => [item.gate, item.status, item.passed])).toEqual([['acceptance', 'failed', false], ['coder', 'passed', true], ['review', 'degraded', null]]);
  expect(p2.checks).toContainEqual(expect.objectContaining({ gate: 'acceptance', command: 'bun lint', status: 'not_run', passed: null }));
  expect(p1.insights).toEqual([expect.objectContaining({ kind: 'caution', assertion: 'reported' })]);
  const proof = p1.execution_evidence as Record<string, unknown>[];
  const coderProof = proof.find(item => item.artifact_path === 'verify-p1.coder.json' && item.attempt_id === 'a2')!;
  expect(proof.find(item => item.artifact_path === 'verify-p1.coder.json' && item.attempt_id === 'a1')).toMatchObject({ availability: 'missing', missing_reason: 'missing', occurred_at: null });
  expect(coderProof).toMatchObject({ source: 'agent_reported', occurred_at: '2026-11-03T02:10:00.000Z', attempt_id: 'a2', report: { notes: '已交付证据导出。', changed_file_count: 1 } });
  expect(coderProof.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(proof.find(item => item.artifact_path === 'settle-p1.json')).toMatchObject({ source: 'engine_verified', occurred_at: '2026-11-03T02:30:00.000Z' });
  expect(proof.find(item => item.artifact_path === 'publish-m1.json' && item.attempt_id === 'a2')).toMatchObject({ source: 'engine_integrated', integration: { status: 'published', target_tip: 'a'.repeat(40), commit: 'b'.repeat(40) } });
  expect((p2.execution_evidence as Record<string, unknown>[]).find(item => item.artifact_path === 'settle-p2.json')).toMatchObject({ availability: 'unreadable', missing_reason: 'unreadable' });
  expect(output.artifact_retention).toMatchObject({ policy: 'conditional', guaranteed_for_ms: null });
  expect(JSON.stringify(output)).not.toContain('LEAK-ME'); expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

test('run 用量只投影 SQLite 已记录的 inclusive 汇总', () => {
  const db = new Database(join(root, 'home', 'archon', 'archon.db'));
  db.run('UPDATE remote_agent_workflow_runs SET metadata=? WHERE id=?', [JSON.stringify({ total_tokens_in: 120, total_tokens_out: 30, total_cache_read_tokens: 80, total_cost_usd: 0.0123, secret: 'NOPE' }), 'a2']); db.close();
  const { output } = exportAt(), exported = output.records.find(item => item.source_kind === 'run')!;
  expect(exported.usage).toEqual({ scope: 'inclusive', duration_ms: 3_600_000, input_tokens: 120, output_tokens: 30, cached_input_tokens: 80, cost: { amount: '0.0123', currency: 'USD' } });
  expect(JSON.stringify(output)).not.toContain('NOPE'); expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

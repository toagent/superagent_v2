import { createHash } from 'node:crypto';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import Ajv2020 from '../../packages/workflows/node_modules/ajv/dist/2020';
import { buildExport } from '../src/export';
import { tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const schema = JSON.parse(readFileSync(join(WETAMP, 'schemas/task-export.schema.json'), 'utf8'));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
const saved = { SUPERAGENT_HOME: process.env.SUPERAGENT_HOME, ARCHON_HOME: process.env.ARCHON_HOME };
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

type Output = { status: string; scope: { scope_id: string }; coverage: Record<string, { scanned: number | null; emitted: number }>; records: Record<string, unknown>[]; errors: { code: string; source_kind: string | null }[]; since: string; until: string };
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
  db.run('CREATE TABLE remote_agent_workflow_runs (id TEXT PRIMARY KEY,status TEXT,started_at TEXT,completed_at TEXT,last_activity_at TEXT)');
  db.run("INSERT INTO remote_agent_workflow_runs VALUES ('a1','failed','2026-11-01T21:00:00Z','2026-11-02T01:00:00Z','2026-11-02T01:00:00Z')");
  db.run("INSERT INTO remote_agent_workflow_runs VALUES ('a2','completed','2026-11-03T02:00:00Z','2026-11-03T03:00:00Z','2026-11-03T03:00:00Z')");
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
  expect(output.errors.map(item => item.code)).toEqual(['SOURCE_UNSUPPORTED', 'HISTORY_UNKNOWN', 'HISTORY_UNKNOWN']);
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

test('真实空来源不伪报 complete，未知历史和 unsupported intake 明示', () => {
  const empty = tmp(), sa = join(empty, 'home'); mkdirSync(join(sa, 'runs'), { recursive: true }); mkdirSync(join(sa, 'jobs')); mkdirSync(join(sa, 'archon'));
  Object.assign(process.env, { SUPERAGENT_HOME: sa, ARCHON_HOME: join(sa, 'archon') });
  const result = buildExport(args(), new Date('2026-11-05T00:00:00Z'));
  const output = result.output as Output;
  expect(result.exit).toBe(3); expect(output.records).toEqual([]); expect(output.status).toBe('partial');
  expect(output.errors.map(item => item.code)).toContain('SOURCE_UNSUPPORTED');
  expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
});

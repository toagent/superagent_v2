import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
// prettier-ignore
import { autoVerify, finishVerifyGroup, recordVerifyGroup, runVerify, verifyRecord, type EngineVerifyRecord } from '../src/engine';
import { gitRepo, sh, tmp } from './helpers';
const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
// prettier-ignore
function fixture() {
  const root = tmp(),
    source = gitRepo(root),
    base = sh('git rev-parse HEAD', source).trim();
  writeFileSync(join(source, 'change'), 'change');
  sh('git add change && git commit -qm change', source);
  const sha = sh('git rev-parse HEAD', source).trim(),
    sa = join(root, 'sa'),
    promotions = join(sa, 'engine/promotions');
  mkdirSync(promotions, { recursive: true });
  Object.assign(process.env, { HOME: root, SUPERAGENT_HOME: sa, SA_ENGINE_SOURCE: source });
  return { root, base, sha, sa, promotions };
}
// prettier-ignore
const projection = (f: ReturnType<typeof fixture>, patch: Partial<EngineVerifyRecord> = {}) => {
  const value: EngineVerifyRecord = {
    sha: f.sha, base: f.base, status: 'running', files: [], failed_files: [],
    log: join(f.promotions, `${f.sha}.verify.log`),
    at: 'start', attempt: 'attempt-1',
    checkout: join(f.sa, 'engine/verify', f.sha, 'attempt-1'),
    pid: 10, pid_start: 'parent-start', host: hostname(), token: 'token', ...patch,
  };
  writeFileSync(join(f.promotions, `${f.sha}.verify.json`), JSON.stringify(value));
  return value;
};
// prettier-ignore
test('each verify attempt gets an independent checkout and append-only history', () => {
  const f = fixture(),
    prepared: string[] = [],
    cleaned: string[] = [];
  const dependencies = {
    // prettier-ignore
    prepare: (path: string) => {
      prepared.push(path);
      mkdirSync(path, { recursive: true });
    },
    // prettier-ignore
    cleanup: (path: string) => {
      cleaned.push(path);
      rmSync(path, { recursive: true, force: true });
    },
    execute: (_path: string, _args: string[], report: string) => (writeFileSync(report, '<testsuites><testsuite tests="0"/></testsuites>'), { exit: 0, duration_ms: 1 }),
  };
  const first = runVerify(f.sha, f.base, dependencies),
    second = runVerify(f.sha, f.base, dependencies);
  expect(first.attempt).not.toBe(second.attempt);
  expect(new Set(prepared).size).toBe(2);
  expect(cleaned).toEqual(prepared);
  expect(prepared.every(path => !existsSync(path))).toBe(true);
  const attempts = readFileSync(join(f.promotions, `${f.sha}.verify.attempts.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as EngineVerifyRecord);
  expect(new Set(attempts.map(item => item.attempt))).toEqual(new Set([first.attempt, second.attempt]));
  expect(verifyRecord(f.sha)?.attempt).toBe(second.attempt);
});
// prettier-ignore
test('manual verify rejects an identity-confirmed live attempt', () => {
  const f = fixture();
  projection(f);
  expect(() =>
    runVerify(f.sha, f.base, { inspect: () => ({ state: 'online', start: 'parent-start' }) })
  ).toThrow('attempt already running pid=10 at=start');
});
// prettier-ignore
test('auto verify waits for a live process group, then cleans and retries after exit', () => {
  const f = fixture(),
    prior = projection(f, { pgid: 20, pgid_start: 'group-start' });
  mkdirSync(prior.checkout!, { recursive: true });
  const inspect = (pid: number) =>
    pid === 30 ? ({ state: 'online', start: 'retry-start' } as const) : ({ state: 'offline' } as const);
  let alive = true,
    spawned = 0;
  const dependencies = {
    inspect,
    groupAlive: () => alive,
    spawn: () => (spawned++, { pid: 30, unref() {} }),
  };
  expect(autoVerify(join(f.root, f.sha), dependencies)).toMatchObject({
    started: false,
    error: 'verify_process_group_alive',
  });
  expect(existsSync(prior.checkout!)).toBe(true);
  alive = false;
  expect(autoVerify(join(f.root, f.sha), dependencies)).toMatchObject({ started: true, base: f.base });
  expect(existsSync(prior.checkout!)).toBe(false);
  expect({ spawned, retries: verifyRecord(f.sha)?.retries }).toEqual({ spawned: 1, retries: 1 });
});
// prettier-ignore
test('process-group transitions append identity and termination signal', () => {
  const f = fixture(),
    prior = projection(f);
  recordVerifyGroup(f.sha, prior.attempt, prior.token, 20, () => ({ state: 'online', start: 'group-start' }));
  finishVerifyGroup(f.sha, prior.attempt, prior.token, 'SIGTERM');
  const attempts = readFileSync(join(f.promotions, `${f.sha}.verify.attempts.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as EngineVerifyRecord);
  expect(attempts[0]).toMatchObject({ pgid: 20, pgid_start: 'group-start' });
  expect(attempts[1]).toMatchObject({ signal: 'SIGTERM' });
  expect(verifyRecord(f.sha)).not.toHaveProperty('pgid');
});

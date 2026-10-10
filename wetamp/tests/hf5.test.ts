import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { disableCleanup } from '../src/web/archon';
import { evidenceGates, evidenceJson, summarize, type Ledger } from '../src/cli';
import { rowOf, snapshotOf } from '../src/board/data';
import { cockpit } from '../src/board/cockpit';
import { handler } from '../src/web/server';
import type { RunView } from '../src/archon';
import { gitRepo, sh, tmp } from './helpers';
const env = { ...process.env };
afterEach(() => { for (const k of ['SUPERAGENT_HOME', 'ARCHON_HOME']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });
const wetamp = join(import.meta.dir, '..');
const require = createRequire(import.meta.url);
const redline = require('../hooks/redline.cjs') as { reason: (x: object) => string | null };

test('M2-01 cleanup preload only disables the scheduler; absent or ambiguous target fails closed', async () => {
  const source = readFileSync(join(wetamp, '../packages/core/src/services/cleanup-service.ts'), 'utf8');
  const adapted = disableCleanup(source);
  expect(adapted).toContain('cleanup_scheduler_disabled_by_superagent');
  expect(adapted).not.toContain("getLog().info('scheduler_starting'");
  for (const bad of [source.replace('export function startCleanupScheduler()', 'export function renamedScheduler()'), source + source]) expect(() => disableCleanup(bad)).toThrow('target missing or ambiguous');
  const root = tmp(), file = join(root, 'cleanup-service.ts');
  writeFileSync(file, 'export function changedScheduler() {}');
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', join(wetamp, 'src/web/archon.ts'), '-e', 'await import(process.argv[1])', file], { env: { ...process.env, SUPERAGENT_HOME: root, ARCHON_HOME: root }, stdout: 'pipe', stderr: 'pipe' });
  const err = await new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0); expect(err).toContain('target missing or ambiguous');
});
test('M2-02 SSE and reads use the protected Unix socket; mutation never forwards', async () => {
  let seen: string | undefined, calls = 0;
  const forward: typeof fetch = Object.assign(async (_url: string | URL | Request, options?: RequestInit & { unix?: string }) => { seen = options?.unix; calls++; return new Response('data: socket\n\n', { headers: { 'content-type': 'text/event-stream' } }); }, { preconnect: () => {} });
  const get = handler(39890, 'fixture', () => ({}), 'http://localhost', forward, '/tmp/fixture.sock');
  const req = (method: string) => new Request('http://127.0.0.1:39890/stream?t=fixture', { method, headers: { host: '127.0.0.1:39890' } });
  expect(await (await get(req('GET'))).text()).toBe('data: socket\n\n'); expect(seen).toBe('/tmp/fixture.sock');
  expect((await get(req('POST'))).status).toBe(403); expect(calls).toBe(1);
});
const shellCases: [string, boolean][] = [
  ['cd /Users/Shared; touch m2-fixture; cd ROOT', true],
  ['cd /Users/Shared; echo x > m2-fixture; cd ROOT', true],
  ['cd /Users/Shared && touch m2-fixture && cd ROOT', true],
  ['cd /Users/Shared || touch m2-fixture; cd ROOT', true],
  ['(cd /Users/Shared; touch m2-fixture); cd ROOT', true],
  ['(cd /Users/Shared); touch local; echo x > local 2>&1', false],
];
test.each(shellCases)('M2-04 hook smoke: %s', (shell, denied) => {
  const root = gitRepo(tmp());
  const result = redline.reason({ client: 'claude', name: 'Bash', input: {}, cwd: root, root, derived: true, env: process.env, shell: shell.replaceAll('ROOT', root) });
  expect(result !== null).toBe(denied);
});
test('M2-04 indeterminate writes fail closed', () => {
  const root = gitRepo(tmp());
  expect(redline.reason({ client: 'claude', name: 'Bash', input: {}, cwd: root, root, derived: true, env: process.env, shell: 'touch "$DEST"' })).toContain('无法确认');
});
test.each([
  ["node GUARD codex", '^Read$', false, 1],
  ["echo GUARD", '*', false, 1],
  ["node GUARD codex", '*', true, 1],
  ["node GUARD codex", '*', false, 0],
] as const)('M2-08 trusts only a synchronous canonical writer guard: %s / %s / %s', (command, matcher, asyncHook, exit) => {
  const root = tmp(), codex = join(root, 'codex'); mkdirSync(codex);
  writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: command.replace('GUARD', `'${join(wetamp, 'hooks/guard.cjs')}'`), async: asyncHook }] }] } }));
  const run = (cmd: string) => Bun.spawnSync([process.execPath, join(wetamp, 'scripts/codex-trust.cjs'), cmd], { env: { ...process.env, CODEX_HOME: codex, SUPERAGENT_HOME: root }, stdout: 'pipe', stderr: 'pipe' });
  expect(run('write').exitCode).toBe(0); expect(run('check').exitCode).toBe(exit);
});
function fixture() {
  const root = tmp(), repo = gitRepo(root); process.env.SUPERAGENT_HOME = repo; process.env.ARCHON_HOME = join(repo, 'archon');
  const art = join(repo, 'out/artifacts/runs/r'); mkdirSync(art, { recursive: true });
  const now = Date.now(), end = new Date(now - 1000).toISOString();
  writeFileSync(join(repo, 'plan.json'), JSON.stringify({ base_ref: 'origin/main', packages: [{ id: 'p', title: 'p', accept: [], risk: 'G0' }] }));
  const ledger: Ledger = { run_id: 'sa1', archon_run_id: 'r', plan: 'plan.json', gen_dir: repo, repo, branch: 'sa/sa1', workflow: 'sa-sa1', console: 'codex', started_at: new Date(now - 86400000).toISOString(), transcript: '', log: '', recoveries: [] };
  const run: RunView = { id: 'r', status: 'completed', completed_at: end, output_root: join(repo, 'out'), nodes: [{ nodeId: 'land', state: 'completed' }] };
  return { root, repo, art, now, ledger, run };
}
test('M2-06 ended date, real integration, and durable human intervention define the shared metric', () => {
  const f = fixture();
  sh('git switch -qc delivery && echo delivery > deliver.txt && git add deliver.txt && git -c user.name=t -c user.email=t@l commit -qm delivery', f.repo);
  writeFileSync(join(f.art, 'land.json'), JSON.stringify({ head: sh('git rev-parse HEAD', f.repo).trim() }));
  const metrics = () => cockpit(snapshotOf([{ ledger: f.ledger, run: f.run }], f.now), f.now).metrics;
  expect(metrics()).toMatchObject({ completed: 0, decided: 1 });
  sh('git switch -q main && git merge --ff-only delivery', f.repo);
  expect(rowOf(f.ledger, f.run, { now: f.now }).landed).toBe(true);
  expect(metrics()).toMatchObject({ completed: 1, decided: 1 });
  f.ledger.recoveries = ['2026-10-10T10:00:00Z']; f.ledger.intervened = false;
  expect(metrics().completed).toBe(1); // automatic recovery is not human intervention
  f.ledger.intervened = true;
  expect(metrics()).toMatchObject({ completed: 0, decided: 1 });
  f.run.nodes!.push({ nodeId: 'human-m1', state: 'completed' }); f.ledger.intervened = undefined;
  expect(metrics().completed).toBe(0);
  f.run.status = 'cancelled'; expect(metrics().decided).toBe(1);
});
test('M2-09 summary and individual gate evidence reject external symlinks', () => {
  const f = fixture(), outside = tmp();
  writeFileSync(join(outside, 'gate.json'), JSON.stringify({ verdict: 'pass', debt: [] }));
  symlinkSync(join(outside, 'gate.json'), join(f.art, 'gate-m1-r1.json'));
  expect(() => evidenceJson(f.ledger, f.art, 'gate-m1-r1.json')).toThrow('路径越界');
  expect(() => evidenceGates(f.ledger, f.art)).toThrow('路径越界');
  const stats = summarize([{ ledger: f.ledger, run: f.run }]);
  expect(stats.unreadable).toEqual([expect.stringContaining('路径越界')]);
  expect(stats.first_pass).toBeUndefined();
  symlinkSync(outside, join(f.repo, 'external'));
  expect(() => evidenceGates(f.ledger, join(f.repo, 'external'))).toThrow('路径越界');
});

import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, trackTestChild } from '../helpers';
import {
  completedOutput,
  expectGate,
  expectOutcome,
  expectPublishedGate,
  restore,
  runGateContract,
  runInProcess,
  scenario,
} from './framework';

const fixture = (id: 'S1' | 'S2', risk: 'G1' | 'G2') =>
  scenario({
    id,
    risk,
    passRound: 1,
    plan: { goal: `${id} generated delivery`, accept: `test "$(cat scenario.txt)" = ${id}` },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  });

// Start with no state directory so every registered file proves its own first-use path.
const FIRST_USE_STATE_FILES = ['ntfy/answer.key', 'ntfy/state.json', 'tick.json'];

// prettier-ignore
test('ntfy CLI first use creates state and delivers from an empty home', async () => {
  const root = tmp(), home = join(root, '.superagent'), posts: Record<string, unknown>[] = [];
  const tokens = join(root, '.config/superagent');
  mkdirSync(tokens, { recursive: true });
  for (const name of ['ntfy-publisher.token', 'ntfy-answer.token'])
    writeFileSync(join(tokens, name), 'fixture-token\n', { mode: 0o600 });
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/sa-answers/json') return new Response('');
    posts.push(await request.json() as Record<string, unknown>); return Response.json({});
  } });
  const env = { HOME: root, PATH: process.env.PATH ?? '', SUPERAGENT_HOME: home,
    ARCHON_HOME: join(home, 'archon'), DATABASE_URL: '', ARCHON_TELEMETRY_DISABLED: 'true',
    SA_NTFY_URL: server.url.origin, SA_ORCA: '0', SA_SKIP_LAUNCHD_RELOAD: '1' };
  const run = async (...args: string[]) => {
    const child = trackTestChild(Bun.spawn([process.execPath, join(import.meta.dir, '../../src/cli.ts'), ...args],
      { cwd: join(import.meta.dir, '../..'), env, stdout: 'pipe', stderr: 'pipe' }));
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${args[0]}: ${stderr}\n${stdout}`).toBe(0);
  };
  try {
    expect(existsSync(home)).toBeFalse();
    await run('ask', '--source', 'smoke', '--title', 'First use', '--body', 'Choose', '--option',
      'yes=Yes', '--expires-at', new Date(Date.now() + 60_000).toISOString(), '--callback', 'smoke');
    await run('supervise-tick');
    await run('notify', '--id', 'first-use', '--title', 'Ready', '--body', 'Delivered');
    expect(posts.map(post => post.topic)).toEqual(['sa-decisions', 'sa-alerts']);
    expect(FIRST_USE_STATE_FILES.every(path => existsSync(join(home, path)))).toBeTrue();
  } finally { server.stop(true); }
}, 20_000);

test('S1: detached process persists engine terminal state, receipt, and target ref', async () => {
  const output = join(tmp(), 's1-result.json');
  const child = Bun.spawn([process.execPath, 'test', join(import.meta.dir, 'detached-runner.ts')], {
    detached: true,
    env: { ...process.env, SCENARIO_RESULT: output },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  trackTestChild(child, true);
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  const result = JSON.parse(readFileSync(output, 'utf8')) as {
    terminal: { completed: string[]; failed: string[] };
    ledger: { archon_run_id: string };
    receipt: { status: string };
    target: string;
    worker: string;
  };
  expect(result.terminal).toEqual({ completed: ['5ce0-0001'], failed: [] });
  expect(result.ledger.archon_run_id).toBe('5ce0-0001');
  expect(result.receipt.status).toBe('published');
  expect(result.target).toBe(result.worker);
}, 120_000);

test('S2/S11: generated G2 workflow binds gate evidence without preset role', async () => {
  for (const [id, risk] of [['S2', 'G2']] as const) {
    const f = fixture(id, risk);
    try {
      const result = await runGateContract(f);
      expectOutcome(f, result, {
        terminal: 'completed',
        counts: { 'code-p': 1, 'review-m1-r1': 1, 'gate-m1-r1': 1 },
        published: false,
      });
      expectGate(result, 1);
      const gate = completedOutput(result, 'gate-m1-r1') as {
        identity: { authors: { model: string }[]; reviewer: { model: string } };
      };
      expect(gate).toMatchObject({
        risk: 'G2',
        grade: 'PASS',
        identity: { reviewer: { model: 'fixture/reviewer' } },
      });
      expect(gate.identity.authors.every(author => author.model === 'fixture/coder')).toBeTrue();
      expect(f.roles.length).toBeGreaterThan(0);
      expect(new Set(f.roles)).toEqual(new Set(['']));
      expect(process.env.SUPERAGENT_ROLE).toBe('');
    } finally {
      restore(f);
    }
  }
}, 120_000);

test('generated G2 workflow smoke completes and publishes', async () => {
  const f = fixture('S2', 'G2');
  try {
    const result = await runInProcess(f);
    expectOutcome(f, result, {
      terminal: 'completed',
      counts: {
        'code-p': 1,
        'integrate-m1.resync-m1': 1,
        'integrate-m1.final-accept-m1': 1,
        'integrate-m1.publish-m1': 1,
      },
      published: true,
    });
    expectPublishedGate(result, 1);
  } finally {
    restore(f);
  }
}, 120_000);

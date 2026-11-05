import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Coordination, repoScope, runScope, type Identity } from '../src/coord';
import { lastJson } from '../src/archon';
import { fixturePlan, fixtureTiersEnv, gitRepo, sh, tmp } from './helpers';

const req = createRequire(import.meta.url);
const inspect = req('../hooks/identity.cjs').inspect as (pid: number) => {
  state: string;
  start?: string;
};
const CLI = join(import.meta.dir, '../bin/superagent');

function identity(client: 'codex' | 'claude', session: string, pid = process.pid): Identity {
  return {
    client,
    session_id: session,
    host: hostname(),
    pid,
    pid_start: inspect(pid).start ?? 'fixture-offline-start',
  };
}

function setup(owner: Identity) {
  const root = tmp(),
    repo = gitRepo(root),
    sa = join(root, 'sa'),
    actor = identity('codex', 'marshal-a'),
    preload = join(root, 'launcher.cjs');
  sh('git switch -qc feature/parallel', repo);
  mkdirSync(sa, { recursive: true });
  new Coordination({
    sa,
    runs: () => [],
    presence: () => ({ state: 'online', activity: 'idle' }),
  }).claim(repoScope(repo), owner);
  writeFileSync(
    preload,
    `require(${JSON.stringify(join(import.meta.dir, '../hooks/live.cjs'))}).launcher = () => (${JSON.stringify(actor)});\n`
  );
  const tiers = fixtureTiersEnv();
  const env = {
    ...process.env,
    ...tiers,
    BUN_OPTIONS: `${tiers.BUN_OPTIONS} --preload=${preload}`,
    XDG_STATE_HOME: join(root, 'state'),
    SUPERAGENT_HOME: sa,
    ARCHON_HOME: join(sa, 'archon'),
    SUPERAGENT_WRITE_ROOTS: root,
    SUPERAGENT_MEMORY: 'off',
    SA_ORCA: '0',
    DATABASE_URL: '',
  };
  return { root, repo, sa, actor, env };
}

function invoke(env: NodeJS.ProcessEnv, ...args: string[]) {
  const p = Bun.spawnSync([CLI, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 300_000,
  });
  const out = p.stdout.toString(),
    json = lastJson(out) as { run_id: string; default_contact?: Identity; reason?: string } | null;
  return { code: p.exitCode, out, err: p.stderr.toString(), json };
}

function plan(root: string, repo: string, scope: string) {
  return fixturePlan(root, repo, value => {
    const pkg = (value.packages as Record<string, unknown>[])[0];
    pkg.scope = { write: [scope], read_hint: ['README.md'] };
    pkg.review = false;
    delete pkg.review_reason;
    value.packages = [pkg];
  });
}

test.each(['online', 'offline'] as const)(
  'foreign repository owner may be %s while a disjoint run belongs to its launcher',
  state => {
    const owner = identity('claude', 'marshal-b', state === 'online' ? process.pid : 99_999_999),
      s = setup(owner),
      result = invoke(s.env, 'run', plan(s.root, s.repo, `${state}.txt`), '--fake');
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.json!.default_contact).toMatchObject({
      client: 'claude',
      session_id: 'marshal-b',
    });
    const ledger = JSON.parse(
      readFileSync(join(s.sa, 'runs', `${result.json!.run_id}.json`), 'utf8')
    );
    expect(ledger.controller).toMatchObject({ client: 'codex', session_id: 'marshal-a' });
    expect(new Coordination({ sa: s.sa }).owner(runScope(ledger)).owner).toMatchObject(s.actor);
  },
  300_000
);

test('overlap wins over repository ownership, while another run remains fenced', () => {
  const s = setup(identity('claude', 'marshal-b')),
    first = invoke(s.env, 'run', plan(s.root, s.repo, 'shared.txt'), '--fake');
  expect(first.code, first.out + first.err).toBe(0);
  const ledgerPath = join(s.sa, 'runs', `${first.json!.run_id}.json`),
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')),
    c = new Coordination({ sa: s.sa }),
    foreign = identity('claude', 'marshal-b');
  ledger.controller = c.claim(runScope(ledger), foreign, true, 'fixture transfer').controller;
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const second = invoke(s.env, 'run', plan(s.root, s.repo, 'shared.txt'), '--fake');
  expect(second.code, second.out + second.err).toBe(64);
  expect(second.json).toMatchObject({ reason: 'scope_overlap' });
  const cancel = invoke(s.env, 'cancel', first.json!.run_id);
  expect(cancel.code).toBe(1);
  expect(cancel.out + cancel.err).toContain('fencing');
}, 300_000);

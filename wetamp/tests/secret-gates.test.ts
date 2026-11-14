import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, quickPlan } from '../src/cli';
import { jobCli } from '../src/jobs';
import { secretInDiff } from '../src/land';
import { gitRepo, sh, tmp } from './helpers';

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
const managed = () => {
  const home = tmp(),
    value = `sf_${crypto.randomUUID()}_secret`;
  mkdirSync(join(home, '.wetamp'), { recursive: true });
  writeFileSync(join(home, '.wetamp/secrets.list'), 'SA_SYNTHETIC\n');
  Object.assign(process.env, {
    HOME: home,
    SA_SYNTHETIC: value,
    SA_GITLEAKS_CONFIG: join(import.meta.dir, '../secrets/gitleaks.toml'),
  });
  return { home, value };
};

test('quick freeze and job inputs reject a managed value with exit 64', async () => {
  const { value } = managed(),
    repo = gitRepo(tmp()),
    card = join(tmp(), 'card.md');
  process.env.SUPERAGENT_WRITE_ROOTS = join(repo, '..');
  writeFileSync(card, value);
  expect(() =>
    quickPlan({ _: ['quick'], flags: { goal: value, accept: ['true'], repo } } as never)
  ).toThrow('secret_in_input');
  expect(
    await jobCli(['job', 'exec', '--title', 't', '--role', 'general', '--prompt-file', card])
  ).toBe(64);
  expect(await jobCli(['job', 'exec', '--title', 't', '--card', card, '--', 'true'])).toBe(64);
  const plan = quickPlan({
    _: ['quick'],
    flags: { goal: 'safe', accept: ['true'], repo },
  } as never);
  const frozen = JSON.parse(await Bun.file(plan).text());
  frozen.packages[0].goal = value;
  writeFileSync(plan, JSON.stringify(frozen));
  expect(() => main(['plan', 'check', plan])).toThrow('secret_in_input');
});

test('publication range rejects a managed value in added lines', () => {
  const { value } = managed(),
    repo = gitRepo(tmp()),
    file = join(repo, 'probe.txt');
  writeFileSync(file, 'base\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm base', repo);
  const base = sh('git rev-parse HEAD', repo).trim();
  writeFileSync(file, `++${value}\n`);
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm probe', repo);
  writeFileSync(file, 'removed\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm removed', repo);
  expect(secretInDiff(repo, base)).toBe(true);
});

test('publication range ignores heuristic findings but keeps deterministic findings', () => {
  managed();
  const repo = gitRepo(tmp()),
    file = join(repo, 'probe.txt');
  writeFileSync(file, 'base\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm base', repo);
  const base = sh('git rev-parse HEAD', repo).trim();
  writeFileSync(file, ['pass', 'word=', crypto.randomUUID(), '\n'].join(''));
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm heuristic', repo);
  expect(secretInDiff(repo, base)).toBe(false);
  writeFileSync(file, ['postgres://', 'u:', 'pw', crypto.randomUUID(), '@h/db\n'].join(''));
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm deterministic', repo);
  expect(secretInDiff(repo, base)).toBe(true);
});

test('publication range covers merge resolution and fails closed on an invalid report', () => {
  const { value } = managed(),
    repo = gitRepo(tmp()),
    file = join(repo, 'probe.txt');
  writeFileSync(file, 'base\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm base', repo);
  const base = sh('git rev-parse HEAD', repo).trim(),
    branch = sh('git branch --show-current', repo).trim();
  sh('git checkout -qb other', repo);
  writeFileSync(file, 'other\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm other', repo);
  sh(`git checkout -q ${branch}`, repo);
  writeFileSync(file, 'main\n');
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm main', repo);
  expect(() => sh('git merge other', repo)).toThrow();
  writeFileSync(file, `${value}\n`);
  sh('git add . && git -c user.name=t -c user.email=t@l commit -qm resolved', repo);
  expect(secretInDiff(repo, base)).toBe(true);
  const bin = tmp();
  writeFileSync(join(bin, 'gitleaks'), "#!/bin/sh\nprintf 'invalid'\nexit 1\n");
  chmodSync(join(bin, 'gitleaks'), 0o755);
  expect(() => secretInDiff(repo, base, join(bin, 'gitleaks'))).toThrow(
    'secret scan failed: invalid report'
  );
});

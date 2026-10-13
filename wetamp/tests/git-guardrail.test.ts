import { expect, test } from 'bun:test';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo, tmp } from './helpers';

const hooks = join(import.meta.dir, '../hooks');
function check(command: string, cwd: string, client = 'opencode', derived = false) {
  const input =
    client === 'claude'
      ? { command }
      : client === 'codex'
        ? { cmd: command }
        : { shellCommand: command };
  const payload = {
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: client === 'claude' ? 'Bash' : 'exec_command',
    tool_input: input,
  };
  const result = Bun.spawnSync(
    client === 'opencode'
      ? ['bash', join(hooks, 'git-guardrail.sh')]
      : ['node', join(hooks, 'guard.cjs'), client],
    {
      cwd,
      stdin: Buffer.from(JSON.stringify(payload)),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        SUPERAGENT_GIT_GUARD: join(hooks, 'git-guardrail.cjs'),
        SUPERAGENT_HOME: tmp(),
        ARCHON_HOME: tmp(),
        SUPERAGENT_ROLE: derived ? 'worker' : '',
      },
    }
  );
  const out = result.stdout.toString();
  return {
    denied: result.exitCode === 2 || out.includes('"permissionDecision":"deny"'),
    exit: result.exitCode,
    out,
    err: result.stderr.toString(),
  };
}

test.each(
  ['claude', 'codex', 'opencode'].flatMap(client =>
    [false, true].map(derived => ({ client, derived }))
  )
)(
  'actual $client hooks, derived=$derived: Git across roots and branch names',
  ({ client, derived }) => {
    const own = gitRepo(tmp()),
      foreign = gitRepo(tmp());
    const commands = [
      'add -A',
      'add --all',
      'commit --no-verify -m x',
      'commit -n --amend -m x',
      'config --global user.name x',
      'config core.hooksPath /tmp/hooks',
      'push origin main',
      'rebase main release-demo',
      'checkout -B main',
      'switch -C release-demo',
      'branch -m main release-demo',
    ];
    const result = check(
      commands.map(cmd => `rtk proxy git -C '${foreign}' ${cmd}`).join('; '),
      own,
      client,
      derived
    );
    expect(result.exit, result.err).toBe(0);
    expect(result.denied).toBe(false);
    for (const cmd of [
      'push --force origin main',
      'push --force-with-lease origin main',
      'push origin :main',
      'push --delete origin main',
      'reset --hard',
      'clean -fdx',
      'restore README.md',
      'stash clear',
    ]) {
      expect(
        check(`git -C '${foreign}' ${cmd}`, own, client, derived).denied,
        `${client}: ${cmd}`
      ).toBe(true);
    }
  }
);

test.each(
  ['claude', 'codex', 'opencode'].flatMap(client =>
    [false, true].map(derived => ({ client, derived }))
  )
)('actual $client hooks, derived=$derived: dirty cwd is protected at its own root', ({ client, derived }) => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, 'README.md'), 'uncommitted tracked bytes');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked bytes');
  const status = () =>
    Bun.spawnSync(['git', '-C', repo, 'status', '--porcelain=v1']).stdout.toString();
  const before = status();
  expect(before).toContain(' M README.md');
  expect(before).toContain('?? untracked.txt');
  // Payload probes only: the destructive commands must never execute.
  for (const command of ['git reset --hard', 'git clean -fd']) {
    const result = check(command, repo, client, derived);
    expect(result.denied, `${client}: ${command}`).toBe(true);
    expect(result.out + result.err).toContain('会丢弃文件改动');
  }
  for (const command of ['git clean -n', 'git clean -ndf', 'git add -A', 'git commit --amend -m x'])
    expect(check(command, repo, client, derived).denied, command).toBe(false);
  expect(status()).toBe(before);
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('uncommitted tracked bytes');
  expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('untracked bytes');
});

test('scratch main/release commits execute normally after hook approval', () => {
  const own = gitRepo(tmp()),
    foreign = gitRepo(tmp());
  for (const branch of ['main', 'release-demo']) {
    if (branch !== 'main')
      expect(Bun.spawnSync(['git', '-C', foreign, 'switch', '-c', branch]).exitCode).toBe(0);
    for (const flags of [[], ['--no-verify'], ['--amend'], ['--amend', '--no-verify']]) {
      writeFileSync(join(foreign, 'ordinary.txt'), `${branch}:${flags.join(',')}`);
      expect(Bun.spawnSync(['git', '-C', foreign, 'add', '-A']).exitCode).toBe(0);
      const args = [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@local',
        'commit',
        ...flags,
        '-qm',
        'ordinary',
      ];
      if (flags.length === 0)
        expect(
          check(`git -C '${foreign}' add -A; git -C '${foreign}' ${args.join(' ')}`, own).denied
        ).toBe(false);
      expect(Bun.spawnSync(['git', '-C', foreign, ...args]).exitCode).toBe(0);
    }
    expect(readFileSync(join(foreign, 'ordinary.txt'), 'utf8')).toContain(branch);
  }
});

test('compatibility wrapper shares safe deletion and reports malformed input as advisory', () => {
  const repo = gitRepo(tmp());
  expect(Bun.spawnSync(['git', '-C', repo, 'branch', 'saved']).exitCode).toBe(0);
  expect(check('git branch -D saved', repo).denied).toBe(false);
  expect(check('git branch -D missing', repo).denied).toBe(true);
  const malformed = check('echo "unterminated', repo);
  expect(malformed.denied).toBe(false);
  expect(malformed.out).toContain('advisory');
  const installed = join(tmp(), 'git-guardrail.sh');
  symlinkSync(join(hooks, 'git-guardrail.sh'), installed);
  const native = Bun.spawnSync(['bash', installed], {
    cwd: repo,
    stdin: Buffer.from(JSON.stringify({ args: { command: 'git add -A' } })),
    env: { ...process.env, SUPERAGENT_GIT_GUARD: '' },
  });
  expect(native.exitCode, native.stderr.toString()).toBe(0);
});

// R1 blockers: only hook payloads execute; Git state and dirty bytes must survive.
test.each(['claude', 'codex', 'opencode'].flatMap(client =>
  [true, false].map(denied => ({ client, denied }))
))('R1 $client, deny=$denied: path/ref, option prefixes and recovery data', ({ client, denied }) => {
  const repo = gitRepo(tmp());
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', repo, ...args]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };
  // --force only overwrites backups when they actually exist.
  expect(check('git filter-branch --force', repo, client).denied).toBe(false);
  git('update-ref', 'refs/original/refs/heads/main', 'HEAD');
  git('update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
  writeFileSync(join(repo, 'README.md'), 'dirty tracked bytes');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked bytes');
  const snapshot = () => [git('rev-parse', 'HEAD'), git('show-ref'), git('status', '--porcelain=v1'),
    readFileSync(join(repo, 'README.md'), 'utf8'), readFileSync(join(repo, 'untracked.txt'), 'utf8')];
  const before = snapshot();
  if (denied) for (const command of [
    'checkout .', 'checkout README.md', 'checkout HEAD README.md', 'checkout -- README.md',
    'reset --ha', 'reset --har', 'checkout --forc', 'switch --discard-chang',
    'push --mirro', 'push --all --prun', 'push origin main --force-with-leas',
    'rm -rf README.md', 'checkout-index -a -f', 'read-tree -u --rese HEAD',
    'submodule deinit --forc --all', 'submodule -q deinit --force --all', 'filter-branch --force',
    'push --force -- --dry-run main', 'rm -f -- --cached', 'clean -f -- --dry-run',
    'reflog delete HEAD@{0}', 'reflog expire --expire=now --all', 'gc --prune=now', 'gc --pr=now',
  ]) expect(check(`git ${command}`, repo, client).denied, command).toBe(true);
  if (!denied) for (const command of [
    'checkout main', 'checkout HEAD', 'checkout origin/remote-only', 'checkout remote-only',
    'checkout -b new main', 'checkout -B main', 'checkout --detach HEAD',
    'clean -fd --dry-ru', 'push --force --dry-ru', 'fetch origin', 'tag new', 'branch new',
    'rm --cached -f README.md', 'rm -f --dry-run README.md', 'checkout-index -a',
    'read-tree --reset HEAD', 'read-tree -u --reset -n HEAD', 'update-index --force-remove README.md',
    'repack -ad', 'maintenance run --task=gc',
    'add -A', 'commit --amend -m x', 'config core.hooksPath /tmp/hooks', 'push origin main',
  ]) expect(check(`git ${command}`, repo, client).denied, command).toBe(false);
  expect(snapshot()).toEqual(before);
  git('update-ref', 'refs/backup/main', 'HEAD');
  expect(check('git filter-branch --force --original refs/backup', repo, client).denied).toBe(true);
});

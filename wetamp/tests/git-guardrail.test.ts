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

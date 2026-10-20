import { expect, test } from 'bun:test';
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../helpers';

type Mutation = {
  file: string;
  from: string;
  to: string;
  test: string;
  name: string;
  also?: [string, string];
};
const mutations: Mutation[] = [
  {
    file: 'src/generate.ts',
    from: 'loop_group: {\n        max_iterations: 3,',
    to: 'loop_group: {\n        interactive: true,\n        max_iterations: 3,',
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
  },
  {
    file: 'src/land.ts',
    from: 'const who = authorization.run;',
    to: 'const who = caller();',
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
    also: [
      "import { control, coord, repoScope } from './coord';",
      "import { caller, control, coord, repoScope } from './coord';",
    ],
  },
  {
    file: 'templates/.archon/scripts/sa-check.ts',
    from: 'artifact_sha256: sha(serialized)',
    to: "artifact_sha256: ''",
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
  },
  {
    file: 'src/generate.ts',
    from: "skippable(`$${binding.node}.output.artifact_sha256`, ''),",
    to: '`$${binding.node}.output.artifact_sha256`,',
    test: 'tests/scenarios/scenario-rest.test.ts',
    name: 'S3',
  },
  {
    file: 'src/generate.ts',
    from: 'until_bash: `test $${publishId}.output.status = published`,',
    to: 'until_bash: `test "$${publishId}.output.status" = published`,',
    test: 'tests/scenarios/scenario-core.test.ts',
    name: 'S2',
  },
  {
    file: 'templates/.archon/scripts/sa-context.ts',
    from: "(context.refs.head === head || completedGate.verdict === 'fix');",
    to: 'context.refs.head === head;',
    test: 'tests/execution-lifecycle-auto-recover.test.ts',
    name: 'S14a',
  },
];

test('known accident mutations each fail a real generated scenario', () => {
  const repo = join(import.meta.dir, '../../..');
  const selected = process.env.SCENARIO_MUTATION_ONLY
    ? mutations.filter(value => value.file === process.env.SCENARIO_MUTATION_ONLY)
    : mutations;
  for (const mutation of selected) {
    const root = tmp(),
      wetamp = join(root, 'wetamp');
    cpSync(join(repo, 'wetamp'), wetamp, {
      recursive: true,
      filter: path => !path.includes('/node_modules') && !path.includes('/.git/'),
    });
    symlinkSync(join(repo, 'packages'), join(root, 'packages'));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(repo, 'wetamp/node_modules'), join(wetamp, 'node_modules'));
    const path = join(wetamp, mutation.file);
    const before = readFileSync(path, 'utf8');
    expect(before, `${mutation.file}: mutation target drifted`).toContain(mutation.from);
    const changed = before.replaceAll(mutation.from, mutation.to);
    if (mutation.also) expect(changed).toContain(mutation.also[0]);
    writeFileSync(
      path,
      mutation.also ? changed.replace(mutation.also[0], mutation.also[1]) : changed
    );
    for (const args of [
      ['init', '-q'],
      ['add', 'wetamp', 'packages', 'node_modules'],
      [
        '-c',
        'user.name=scenario',
        '-c',
        'user.email=scenario@local',
        'commit',
        '-qm',
        `mutation ${mutation.file}`,
      ],
    ]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      expect(git.exitCode, git.stderr.toString()).toBe(0);
    }
    const run = Bun.spawnSync(
      [process.execPath, 'test', '--timeout', '180000', mutation.test, '-t', mutation.name],
      {
        cwd: wetamp,
        env: { ...process.env, SCENARIO_MUTATION: mutation.file },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 240_000,
      }
    );
    expect(run.exitCode, `${mutation.file} did not break ${mutation.name}`).not.toBe(0);
  }
}, 720_000);

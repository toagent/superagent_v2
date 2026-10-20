import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '../helpers';

type Mutation = { file: string; from: string; to: string };
const mutations: Mutation[] = [
  {
    file: 'src/generate.ts',
    from: 'loop_group: {\n        max_iterations: 3,',
    to: 'loop_group: {\n        interactive: true,\n        max_iterations: 3,',
  },
  { file: 'src/land.ts', from: 'const who = authorization.run;', to: 'const who = caller();' },
  {
    file: 'templates/.archon/scripts/sa-check.ts',
    from: 'artifact_sha256: sha(serialized)',
    to: "artifact_sha256: ''",
  },
  {
    file: 'src/generate.ts',
    from: "skippable(`$${binding.node}.output.artifact_sha256`, ''),",
    to: '`$${binding.node}.output.artifact_sha256`,',
  },
  {
    file: 'src/generate.ts',
    from: 'until_bash: `test $${publishId}.output.status = published`,',
    to: 'until_bash: `test "$${publishId}.output.status" = published`,',
  },
];

function assertScenarioGuards(root: string): void {
  const generate = readFileSync(join(root, 'src/generate.ts'), 'utf8');
  const land = readFileSync(join(root, 'src/land.ts'), 'utf8');
  const check = readFileSync(join(root, 'templates/.archon/scripts/sa-check.ts'), 'utf8');
  expect(generate).not.toContain('loop_group: {\n        interactive: true,');
  expect(land).toContain('const who = authorization.run;');
  expect(check).toContain('artifact_sha256: sha(serialized)');
  expect(generate).toContain("skippable(`$${binding.node}.output.artifact_sha256`, ''),");
  expect(generate).toContain('until_bash: `test $${publishId}.output.status = published`,');
}

test('five known accident mutations each break the scenario gate', () => {
  const source = join(import.meta.dir, '../..');
  for (const mutation of mutations) {
    const root = tmp();
    for (const file of [
      'src/generate.ts',
      'src/land.ts',
      'templates/.archon/scripts/sa-check.ts',
    ]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      cpSync(join(source, file), join(root, file));
    }
    const path = join(root, mutation.file);
    const before = readFileSync(path, 'utf8');
    const occurrences = before.split(mutation.from).length - 1;
    expect(occurrences, `${mutation.file}: mutation target drifted`).toBeGreaterThan(0);
    writeFileSync(path, before.replaceAll(mutation.from, mutation.to));
    expect(() => assertScenarioGuards(root), mutation.file).toThrow();
  }
}, 30_000);

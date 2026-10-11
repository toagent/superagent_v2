import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
await (createRequire(import.meta.url)('../hooks/redline.cjs') as { init: () => Promise<unknown> }).init();

const { reason } = createRequire(import.meta.url)('../hooks/redline.cjs') as {
  reason: (args: object) => string | null;
};
const { extract } = createRequire(import.meta.url)('../scripts/hf6-replay.cjs') as {
  extract: (text: string) => { shell: string; cwd: string }[];
};
const root = resolve(import.meta.dir, '../..');
const check = (shell: string, derived = true, env: object = {}) =>
  reason({
    client: 'claude',
    name: 'Bash',
    input: {},
    cwd: root,
    root,
    shell: shell.replaceAll('ROOT', root),
    derived,
    env,
  });

const allowed = [
  'for f in a b; do echo $f; done',
  'if [ -f x ]; then echo y; fi',
  'cat <<EOF > notes.md\ncd /Users/Shared\neval code\nEOF',
  'cd wetamp && bunx tsc --noEmit',
  'git -C ROOT commit -m "cd fix"',
  'bash scripts/selftest.sh --fake',
  'bash -n scripts/selftest.sh',
  'bash -ex scripts/selftest.sh --fake',
  'env sh -c "echo ok"',
  'xargs sh -c "echo ok"',
  'nohup sh -c "echo ok"',
  'echo "source eval pushd cd"',
  '(cd /Users/Shared); touch local',
  '{ echo ok; }; echo done',
];
test.each(allowed)('HF6 preserves modeled commands and ordinary data: %s', shell => {
  expect(check(shell)).toBeNull();
});
test('HF6 replay extracts exec commands rather than transcript prose or outputs', () => {
  const text =
    'thinking\nnot a command\nexec\n/bin/zsh -lc "echo first" in /tmp succeeded in 1ms:\ntool output\nexec\n/bin/zsh -lc \'echo "quoted"\' in /tmp exited 1:\n';
  expect(extract(text)).toEqual([
    { shell: 'echo first', cwd: '/tmp' },
    { shell: 'echo "quoted"', cwd: '/tmp' },
  ]);
  expect(extract("exec\n/bin/zsh -lc 'echo a\necho b' in /tmp succeeded\nprose")).toEqual([
    { shell: 'echo a\necho b', cwd: '/tmp' },
  ]);
});

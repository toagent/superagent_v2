import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { reason } = createRequire(import.meta.url)('../hooks/redline.cjs') as {
  reason: (args: object) => string | null;
};
const { extract, baseline, replay } = createRequire(import.meta.url)(
  '../scripts/hf6-replay.cjs'
) as {
  extract: (text: string) => { shell: string; cwd: string }[];
  baseline: (ref: string, root: string) => { reason: (args: object) => string | null };
  replay: (
    commands: { shell: string; cwd: string }[],
    before: object,
    after: object
  ) => { commander_changed: number; baseline_rejected: number; current_rejected: number };
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

const denied = [
  'pushd /Users/Shared && touch m2-fixture',
  "bash <<< 'cd /Users/Shared && touch m2-fixture'",
  'f() { cd /Users/Shared; }; f; touch m2-fixture',
  'f () { cd /Users/Shared; }; f; touch m2-fixture',
  'function f { echo ok; }; f',
  '{ cd /Users/Shared; }; touch f',
  'if true; then cd /Users/Shared; fi; touch f',
  'command cd /Users/Shared; touch f',
  'builtin cd /Users/Shared; touch f',
  'cd /Users/Shared; cd ROOT; cd -; touch f',
  'eval "cd /Users/Shared"; touch f',
  'source f',
  '. f',
  'env sh -c "cd /Users/Shared && touch f"',
  'xargs sh -c "cd /Users/Shared; touch f"',
  'nohup sh -c "cd /Users/Shared; touch f"',
  'bash <<EOF\ncd /Users/Shared && touch f\nEOF',
  'bash < commands.txt',
  'echo code | bash',
  'env sh -s',
  'bash /dev/stdin <<< "cd /Users/Shared && touch f"',
  'env sh /dev/fd/0',
  'bash /proc/self/fd/0',
  'bash -s script.sh',
  'sh -c "$CODE"',
  '$TOOL file',
  'cd ~someone; touch f',
  'CDPATH=/Users; cd Shared; touch f',
  'export CDPATH=/Users; sh -c "cd Shared; touch f"',
  'echo "$(source f)"',
  'case x in (x) cd /Users/Shared;; esac; touch f',
  'case x in (x) source f;; esac',
  ...['for f in a; do', 'while true; do', 'until false; do', 'select f in a; do', '!', 'time'].map(
    prefix => `${prefix} cd /Users/Shared; touch f`
  ),
  ...['popd', 'exec', 'alias', 'coproc'].map(head => `${head} echo ok`),
];
test.each(denied)('HF6 rejects commands outside the modeled cwd subset: %s', shell => {
  expect(check(shell)).not.toBeNull();
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
  'echo "$(echo ok)"',
  '(cd /Users/Shared); touch local',
  'time echo ok',
  '{ echo ok; }; echo done',
];
test.each(allowed)('HF6 preserves modeled commands and ordinary data: %s', shell => {
  expect(check(shell)).toBeNull();
});
test('HF6 accounts for inherited CDPATH but permits an absolute cd', () => {
  expect(check('cd wetamp && touch f', true, { CDPATH: '/Users' })).not.toBeNull();
  expect(check('cd ROOT && touch f', true, { CDPATH: '/Users' })).toBeNull();
});
test.each(denied.slice(0, 14))('HF6 leaves commander decisions unchanged: %s', shell => {
  expect(check(shell, false)).toBeNull();
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
test('HF6 commander results match the frozen baseline for every new fixture', () => {
  const before = baseline('25c107b0', root);
  const commands = [...denied, ...allowed].map(shell => ({
    shell: shell.replaceAll('ROOT', root),
    cwd: root,
  }));
  const result = replay(commands, before, { reason });
  expect(result.commander_changed).toBe(0);
  expect(result.current_rejected).toBeGreaterThan(result.baseline_rejected);
  for (const shell of denied.slice(0, 3)) {
    expect(
      before.reason({
        client: 'claude',
        name: 'Bash',
        input: {},
        cwd: root,
        root,
        shell,
        derived: true,
        env: {},
      })
    ).toBeNull();
    expect(check(shell)).not.toBeNull();
  }
});

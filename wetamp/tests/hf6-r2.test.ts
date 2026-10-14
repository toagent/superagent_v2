import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

type Args = {
  shell: string;
  derived: boolean;
  env?: object;
  cwd: string;
  root: string;
  client: string;
  name: string;
  input: object;
};
type Redline = { init: () => Promise<string | null>; reason: (args: Args) => string | null };
type Loader = {
  init: () => Promise<string | null>;
  analyze: (
    text: string,
    cwd: string,
    env: object,
    inspect: () => null,
    expand: (s: string) => string,
    advisory?: (code: string) => void
  ) => string | null;
};
const require = createRequire(import.meta.url);
const redline = require('../hooks/redline.cjs') as Redline;
const { createLoader } = require('../hooks/shell-ast.cjs') as {
  createLoader: (options?: {
    modulePath?: string;
    wasmPath?: string;
    runtimeWasmPath?: string;
  }) => Loader;
};
const root = resolve(import.meta.dir, '../..');
const track = trackTempRoots();
const tmp = () => track(mkdtempSync(join(tmpdir(), 'hf6-r2-test-')));
await redline.init();
const args = (shell: string, derived = true): Args => ({
  shell,
  derived,
  cwd: root,
  root,
  env: {},
  client: 'claude',
  name: 'Bash',
  input: {},
});
const allowed = [
  "cat <<'EOF' > notes.md\n$(cd /Users/Shared; touch f) `anything` \\\nEOF",
  'cat <<EOF > notes.md\nordinary data\nEOF',
  'cat <<-EOF > notes.md\n\tordinary data\n\tEOF',
  'for f in a b; do echo $f; done',
  'if [ -f x ]; then echo y; else echo n; fi',
  'while false; do echo data; done',
  'echo data 2>/dev/null >> log',
  'echo data 2>&1',
  'cat < README.md',
  'echo x | tee -a log',
  'FOO=x echo "$FOO"',
  'FOO=x; echo ${FOO}',
  '"c\\\nd" wetamp && touch f',
  "echo 'c\\\nd'",
  'echo "source eval cd trap repeat"',
  'find . -exec sh -c "echo ok" \\;',
  'rtk proxy env -u FOO sh -c "echo ok"',
  'sh -c "cd /Users/Shared" && touch local',
  'bash scripts/selftest.sh --fake',
];
test.each(allowed)('HF6 R2 permits literal data and modeled scope: %s', shell => {
  expect(redline.reason(args(shell))).toBeNull();
});
test('HF6 R2 shell-word artifact matches installed shell versions and contents', () => {
  (require('../scripts/gen-shell-words.cjs') as { check: (path: string) => void }).check(
    join(root, 'wetamp/hooks/shell-words.json')
  );
});
test('HF6 R2 reason before initialization allows with advisory', () => {
  const script =
    'const r = require(process.argv[1]), notices = []; const result = r.reason({...JSON.parse(process.argv[2]), onAdvisory: code => notices.push(code)}); console.log(JSON.stringify({result, notices}));';
  const result = Bun.spawnSync([
    'node',
    '-e',
    script,
    join(root, 'wetamp/hooks/redline.cjs'),
    JSON.stringify(args('echo ok')),
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    result: null,
    notices: ['shell_parse_unavailable'],
  });
});
test.each(['missing', 'corrupt', 'dependency', 'init', 'language'])(
  'HF6 R2 loader failure allows with advisory: %s',
  async kind => {
    const dir = tmp(),
      wasm = join(dir, 'grammar.wasm'),
      modulePath = join(dir, 'parser.cjs');
    if (kind === 'corrupt') writeFileSync(wasm, 'invalid WASM');
    if (kind === 'init' || kind === 'language')
      writeFileSync(
        modulePath,
        kind === 'init'
          ? 'exports.Parser = { init: async () => { throw new Error("init fixture failure") } };'
          : 'exports.Parser = { init: async () => {} }; exports.Language = { load: async () => { throw new Error("language fixture failure") } };'
      );
    const loader = createLoader(
      kind === 'dependency' || kind === 'init' || kind === 'language'
        ? { modulePath }
        : { wasmPath: wasm }
    );
    expect(await loader.init()).not.toBeNull();
    const notices: string[] = [];
    expect(
      loader.analyze(
        'echo ok',
        root,
        {},
        () => null,
        s => s,
        code => notices.push(code)
      )
    ).toBeNull();
    expect(notices).toContain('shell_parse_unavailable');
  }
);
test('HF6 R2 real hook reports advisory for missing dependencies for either role', () => {
  const dir = tmp();
  cpSync(join(root, 'wetamp/hooks'), join(dir, 'hooks'), { recursive: true });
  cpSync(join(root, 'wetamp/tiers.json'), join(dir, 'tiers.json'));
  const run = (role: string, cmd = 'echo ok') =>
    Bun.spawnSync(['node', join(dir, 'hooks/guard.cjs'), 'codex'], {
      env: {
        ...process.env,
        SUPERAGENT_HOME: dir,
        ARCHON_HOME: dir,
        SUPERAGENT_ROLE: role,
        AI_DISPATCH_ROLE: '',
        TWIN_AGENT_REMOTE: '',
        NODE_PATH: '',
      },
      stdin: Buffer.from(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'exec_command',
          tool_input: { cmd },
          cwd: root,
        })
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const derived = run('general');
  expect(derived.exitCode).toBe(0);
  expect(derived.stderr.toString()).toBe('');
  expect(JSON.parse(derived.stdout.toString()).systemMessage).toContain('advisory');
  expect(derived.stdout.toString()).not.toContain('deny');
  const commander = run('');
  expect(commander.exitCode).toBe(0);
  expect(JSON.parse(commander.stdout.toString()).systemMessage).toContain('advisory');
  const credential = ['~', '.aws', 'credentials'].join('/');
  for (const role of ['general', '']) {
    for (const cmd of ['sudo true', 'rm -rf "$UNKNOWN"', 'npm publish']) {
      const result = run(role, cmd);
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout.toString());
      expect(out.systemMessage).toContain('advisory');
      expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    }
    for (const cmd of [
      'git push --force origin x',
      'git reset --hard',
      'rm -rf ~',
      `cat ${credential}`,
    ]) {
      const result = run(role, cmd);
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout.toString()).hookSpecificOutput;
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toMatch(/^已拦截：.+。原因：.+。可以：.+。$/);
    }
  }
});
test('REDLINE analysis exception is visible advisory without denial', async () => {
  const loader = createLoader(),
    notices: string[] = [];
  expect(await loader.init()).toBeNull();
  expect(
    loader.analyze(
      'echo ok',
      root,
      {},
      () => {
        throw new Error('fixture failure');
      },
      s => s,
      code => notices.push(code)
    )
  ).toBeNull();
  expect(notices).toEqual(['shell_analysis_failed']);
});
test('HF6 R2 remote installer without provisioned parser fails before writing a receipt', () => {
  const dir = tmp(),
    wetamp = join(dir, 'wetamp'),
    bin = join(dir, 'bin');
  mkdirSync(bin);
  const node = Bun.spawnSync(['which', 'node']).stdout.toString().trim();
  symlinkSync(node, join(bin, 'node'));
  cpSync(join(root, 'wetamp/hooks'), join(wetamp, 'hooks'), { recursive: true });
  mkdirSync(join(wetamp, 'scripts'));
  cpSync(join(root, 'wetamp/scripts/install.sh'), join(wetamp, 'scripts/install.sh'));
  const result = Bun.spawnSync(
    ['/bin/bash', join(wetamp, 'scripts/install.sh'), '--remote-hooks'],
    {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        SUPERAGENT_HOME: dir,
        ARCHON_HOME: dir,
        CODEX_HOME: dir,
        XDG_STATE_HOME: dir,
        NODE_PATH: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Cannot find module 'web-tree-sitter'");
  expect(existsSync(join(dir, 'superagent/install.json'))).toBe(false);
});

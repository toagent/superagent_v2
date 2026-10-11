import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

type Args = { shell: string; derived: boolean; env?: object; cwd: string; root: string; client: string; name: string; input: object };
type Redline = { init: () => Promise<string | null>; reason: (args: Args) => string | null };
type Loader = { init: () => Promise<string | null>; analyze: (text: string, cwd: string, env: object, inspect: () => null, expand: (s: string) => string) => string | null };
const require = createRequire(import.meta.url);
const redline = require('../hooks/redline.cjs') as Redline;
const { createLoader } = require('../hooks/shell-ast.cjs') as { createLoader: (options?: { modulePath?: string; wasmPath?: string; runtimeWasmPath?: string }) => Loader };
const { baseline, replay } = require('../scripts/hf6-replay.cjs') as {
  baseline: (ref: string, root: string) => Redline;
  replay: (commands: { shell: string; cwd: string }[], before: Redline, after: Redline) => { commander_changed: number };
};
const root = resolve(import.meta.dir, '../..');
const track = trackTempRoots();
const tmp = () => track(mkdtempSync(join(tmpdir(), 'hf6-r2-test-')));
await redline.init();
const args = (shell: string, derived = true): Args => ({ shell, derived, cwd: root, root, env: {}, client: 'claude', name: 'Bash', input: {} });
const denied = [
  'c\\\nd /Users/Shared && touch f',
  'c\\\nd wetamp && touch f',
  "trap 'cd /Users/Shared; touch f' EXIT",
  'repeat 1 cd /Users/Shared; touch f',
  "find . -prune -exec bash \\; <<< 'cd /Users/Shared; touch f'",
  'cat <<EOF > notes.md\n$(cd /Users/Shared; touch f)\nEOF',
  'cat <<EOF > notes.md\n`cd /Users/Shared; touch f`\nEOF',
  'repeat 1 { cd /Users/Shared; touch f; }',
  '{ echo ok; } always { cd /Users/Shared; touch f; }',
  'if true { cd /Users/Shared }; touch f',
  "print -r -- *(e:'cd /Users/Shared; touch f':)",
  'print -r -- *(+fn)',
  'cat =(cd /Users/Shared; touch f)',
  '=cd /Users/Shared; touch f',
  "=zsh -c 'cd /Users/Shared; touch f'",
  'print -r -- ${(e)code}',
  'noglob cd /Users/Shared; touch f',
  'nocorrect cd /Users/Shared; touch f',
  '- cd /Users/Shared; touch f',
  'fc -e - -1', 'r', 'echo ~[x]', 'echo =zsh',
  'echo ~someone', 'echo ~+', 'echo ~-',
  '< f.sh', "<<< 'cd /Users/Shared'",
  'export CDPATH=/Users/Shared; cd x; touch f',
  'HOME=/Users/Shared cd; touch f',
  'FOO=x; cd wetamp && touch f',
  'cd wetamp && touch f; FOO=x',
  'env FOO=x sh -c "cd wetamp; touch f"',
  'env -C /Users/Shared touch f',
  'echo x | tee /Users/Shared/f',
  'rtk proxy env -C /Users/Shared touch f',
  'HOME=/Users/Shared sh -c "touch ~/f"',
  'find . -exec sh \\;',
  'find . -execdir touch f \\;',
  'echo $((1 + 2))', 'cat <(echo ok)', 'echo ${x:-y}',
  'echo "unfinished', 'if true; then echo ok',
  '$TOOL f', '"$TOOL" f',
];
const allowed = [
  'cat <<\'EOF\' > notes.md\n$(cd /Users/Shared; touch f) `anything` \\\nEOF',
  'cat <<EOF > notes.md\nordinary data\nEOF',
  'cat <<-EOF > notes.md\n\tordinary data\n\tEOF',
  'for f in a b; do echo $f; done',
  'if [ -f x ]; then echo y; else echo n; fi',
  'while false; do echo data; done',
  'echo data 2>/dev/null >> log',
  'echo data 2>&1', 'cat < README.md',
  'echo x | tee -a log',
  'FOO=x echo "$FOO"', 'FOO=x; echo ${FOO}',
  '"c\\\nd" wetamp && touch f',
  "echo 'c\\\nd'", 'echo "source eval cd trap repeat"',
  'find . -exec sh -c "echo ok" \\;',
  'rtk proxy env -u FOO sh -c "echo ok"',
  'sh -c "cd /Users/Shared" && touch local',
  'bash scripts/selftest.sh --fake',
];
test.each(denied)('HF6 R2 denies the unmodeled/unsafe fixture: %s', shell => {
  expect(redline.reason(args(shell))).not.toBeNull();
});
test.each(allowed)('HF6 R2 permits literal data and modeled scope: %s', shell => {
  expect(redline.reason(args(shell))).toBeNull();
});
test('HF6 R2 commander agrees with e09353df for every R2 fixture', () => {
  expect(replay([...denied, ...allowed].map(shell => ({ shell, cwd: root })), baseline('e09353df', root), redline).commander_changed).toBe(0);
});
test('HF6 R2 shell-word artifact matches installed shell versions and contents', () => {
  (require('../scripts/gen-shell-words.cjs') as { check: (path: string) => void }).check(join(root, 'wetamp/hooks/shell-words.json'));
});
test('HF6 R2 reason before initialization denies instead of throwing', () => {
  const script = 'const r = require(process.argv[1]); console.log(r.reason(JSON.parse(process.argv[2])));';
  const result = Bun.spawnSync(['node', '-e', script, join(root, 'wetamp/hooks/redline.cjs'), JSON.stringify(args('echo ok'))]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('shell parser unavailable');
});
test.each(['missing', 'corrupt', 'dependency', 'init', 'language'])('HF6 R2 loader failure denies: %s', async kind => {
  const dir = tmp(), wasm = join(dir, 'grammar.wasm'), modulePath = join(dir, 'parser.cjs');
  if (kind === 'corrupt') writeFileSync(wasm, 'invalid WASM');
  if (kind === 'init' || kind === 'language') writeFileSync(modulePath, kind === 'init'
    ? 'exports.Parser = { init: async () => { throw new Error("init fixture failure") } };'
    : 'exports.Parser = { init: async () => {} }; exports.Language = { load: async () => { throw new Error("language fixture failure") } };');
  const loader = createLoader(kind === 'dependency' || kind === 'init' || kind === 'language' ? { modulePath } : { wasmPath: wasm });
  expect(await loader.init()).not.toBeNull();
  expect(loader.analyze('echo ok', root, {}, () => null, s => s)).toContain('shell parser unavailable');
});
test('HF6 R2 real hook denies missing dependencies while commander stays unchanged', () => {
  const dir = tmp();
  cpSync(join(root, 'wetamp/hooks'), join(dir, 'hooks'), { recursive: true });
  cpSync(join(root, 'wetamp/tiers.json'), join(dir, 'tiers.json'));
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'echo ok' }, cwd: root });
  const run = (role: string) => Bun.spawnSync(['node', join(dir, 'hooks/guard.cjs'), 'codex'], {
    env: { ...process.env, SUPERAGENT_HOME: dir, ARCHON_HOME: dir, SUPERAGENT_ROLE: role, AI_DISPATCH_ROLE: '', TWIN_AGENT_REMOTE: '', NODE_PATH: '' },
    stdin: Buffer.from(payload), stdout: 'pipe', stderr: 'pipe',
  });
  const derived = run('general');
  expect(derived.exitCode).toBe(0);
  expect(derived.stderr.toString()).toBe('');
  expect(JSON.parse(derived.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('deny');
  expect(derived.stdout.toString()).toContain('shell parser unavailable');
  const commander = run('');
  expect(commander.exitCode).toBe(0);
  expect(commander.stdout.toString()).toBe('');
});
test('HF6 R2 remote installer without provisioned parser fails before writing a receipt', () => {
  const dir = tmp(), wetamp = join(dir, 'wetamp'), bin = join(dir, 'bin');
  mkdirSync(bin);
  const node = Bun.spawnSync(['which', 'node']).stdout.toString().trim();
  symlinkSync(node, join(bin, 'node'));
  cpSync(join(root, 'wetamp/hooks'), join(wetamp, 'hooks'), { recursive: true });
  mkdirSync(join(wetamp, 'scripts'));
  cpSync(join(root, 'wetamp/scripts/install.sh'), join(wetamp, 'scripts/install.sh'));
  const result = Bun.spawnSync(['/bin/bash', join(wetamp, 'scripts/install.sh'), '--remote-hooks'], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: dir, SUPERAGENT_HOME: dir, ARCHON_HOME: dir, CODEX_HOME: dir, XDG_STATE_HOME: dir, NODE_PATH: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Cannot find module 'web-tree-sitter'");
  expect(existsSync(join(dir, 'superagent/install.json'))).toBe(false);
});

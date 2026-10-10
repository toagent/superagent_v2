import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

type Parsed = { argvs: string[][]; writes: string[] };
type State = { cwd: string; ok: boolean };
type Node = { kind: 'atom'; atom: number; site: number } |
  { kind: 'and' | 'or' | 'seq' | 'pipe' | 'if' | 'while'; left: Node; right: Node } |
  { kind: 'not' | 'sub' | 'block'; body: Node };
const require = createRequire(import.meta.url);
const redline = require('../hooks/redline.cjs') as {
  init: () => Promise<unknown>; reason: (args: object) => string | null;
};
const analyzer = require('../hooks/shell-ast.cjs') as {
  analyze: (text: string, cwd: string, env: object, inspect: (parsed: Parsed, dir: string) => null, expand: (s: string) => string) => string | null;
};
const { baseline, replay } = require('../scripts/hf6-replay.cjs') as {
  baseline: (ref: string, root: string) => unknown;
  replay: (commands: { shell: string; cwd: string }[], before: unknown, after: unknown) => { commander_changed: number };
};
const track = trackTempRoots();
const W = realpathSync(track(mkdtempSync(join(tmpdir(), 'hf6-r3-worktree-'))));
const X = '/Users/Shared';
const atoms = [`cd ${X}`, `cd ${W}`, 'true', 'false', 'touch f', 'echo d > f'];
const repo = resolve(import.meta.dir, '../..');
const args = (shell: string) => ({ client: 'claude', name: 'Bash', input: {}, shell, cwd: W, root: W, derived: true, env: {} });
await redline.init();

// Independent shell semantics: cd has both outcomes, statuses short-circuit left to right,
// and semicolons divide AND/OR chains. No shell or sample command is executed.
function groundTruth(node: Node, incoming: State[], writes: Map<number, Set<string>>): State[] {
  if (node.kind === 'atom') return incoming.flatMap(({ cwd }) => {
    if (node.atom < 2) return [{ cwd: node.atom === 0 ? X : W, ok: true }, { cwd, ok: false }];
    if (node.atom < 4) return [{ cwd, ok: node.atom === 2 }];
    const dirs = writes.get(node.site) ?? new Set<string>();
    dirs.add(cwd); writes.set(node.site, dirs);
    return [{ cwd, ok: true }, { cwd, ok: false }];
  });
  if ('body' in node) {
    const result = groundTruth(node.body, incoming, writes);
    if (node.kind === 'not') return result.map(s => ({ ...s, ok: !s.ok }));
    if (node.kind === 'sub') return incoming.flatMap(s => result.map(r => ({ cwd: s.cwd, ok: r.ok })));
    return result;
  }
  if (node.kind === 'while') {
    const pending = [...incoming], seen = new Set<string>(), exited: State[] = [];
    while (pending.length) {
      const state = pending.pop()!;
      if (seen.has(state.cwd)) continue;
      seen.add(state.cwd);
      const condition = groundTruth(node.left, [state], writes);
      exited.push(...condition.filter(s => !s.ok).map(s => ({ ...s, ok: true })));
      pending.push(...groundTruth(node.right, condition.filter(s => s.ok), writes));
    }
    return exited;
  }
  const left = groundTruth(node.left, incoming, writes);
  if (node.kind === 'seq') return groundTruth(node.right, left, writes);
  if (node.kind === 'pipe') {
    const right = groundTruth(node.right, incoming, writes);
    // zsh may run the final builtin in the parent; bash may isolate it in a child.
    return [...right, ...incoming.flatMap(s => right.map(r => ({ cwd: s.cwd, ok: r.ok })))];
  }
  if (node.kind === 'if') return [...left.filter(s => !s.ok).map(s => ({ ...s, ok: true })),
    ...groundTruth(node.right, left.filter(s => s.ok), writes)];
  const execute = node.kind === 'and';
  return [...left.filter(s => s.ok !== execute), ...groundTruth(node.right, left.filter(s => s.ok === execute), writes)];
}
const atom = (value: number, site: number): Node => ({ kind: 'atom', atom: value, site });
function list(values: number[], ops: number[]): Node {
  const chains: Node[] = [];
  let chain = atom(values[0], 0);
  ops.forEach((op, i) => {
    if (op === 2) { chains.push(chain); chain = atom(values[i + 1], i + 1); }
    else chain = { kind: op === 0 ? 'and' : 'or', left: chain, right: atom(values[i + 1], i + 1) };
  });
  chains.push(chain);
  return chains.reduce((left, right) => ({ kind: 'seq', left, right }));
}
function render(node: Node): string {
  if (node.kind === 'atom') return atoms[node.atom];
  if ('body' in node) {
    const body = render(node.body);
    return node.kind === 'not' ? `! ${body}` : node.kind === 'sub' ? `( ${body} )` : `{ ${body}; }`;
  }
  const left = render(node.left), right = render(node.right);
  if (node.kind === 'if') return `if ${left}; then ${right}; fi`;
  if (node.kind === 'while') return `while ${left}; do ${right}; done`;
  return `${left} ${{ and: '&&', or: '||', seq: ';', pipe: '|' }[node.kind]} ${right}`;
}
function digits(value: number, base: number, length: number): number[] {
  return Array.from({ length }, () => { const digit = value % base; value = Math.floor(value / base); return digit; });
}

test('HF6 R3 exhaustive differential cwd soundness for lists and scope shapes', () => {
  let total = 0, denied = 0, violations = 0;
  const verify = (node: Node) => {
    total++;
    const shell = render(node), truth = new Map<number, Set<string>>();
    groundTruth(node, [{ cwd: W, ok: true }], truth);
    if (redline.reason(args(shell)) !== null) { denied++; return; }
    // One object per lexical write site; callbacks for its possible cwd share that object.
    const checked = new Map<Parsed, Set<string>>();
    const reason = analyzer.analyze(shell, W, {}, (parsed, dir) => {
      if (parsed.argvs.some(a => a[0] === 'touch') || parsed.writes.includes('f')) {
        const dirs = checked.get(parsed) ?? new Set<string>();
        dirs.add(dir); checked.set(parsed, dirs);
      }
      return null;
    }, s => s);
    if (reason !== null) { violations++; return; }
    const sites = [...checked.values()];
    const lexicalSites = (n: Node): number[] => n.kind === 'atom' ? (n.atom >= 4 ? [n.site] : []) :
      'body' in n ? lexicalSites(n.body) : [...lexicalSites(n.left), ...lexicalSites(n.right)];
    const order = lexicalSites(node);
    if (sites.length !== order.length || order.some((site, i) => [...(truth.get(site) ?? [])].some(dir => !sites[i]?.has(dir)))) violations++;
  };
  for (let length = 1; length <= 4; length++) {
    for (let a = 0; a < 6 ** length; a++) for (let o = 0; o < 3 ** (length - 1); o++) verify(list(digits(a, 6, length), digits(o, 3, length - 1)));
  }
  const listTotal = total;
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
    const left = atom(a, 0), right = atom(b, 1);
    verify({ kind: 'and', left: { kind: 'not', body: left }, right });
    verify({ kind: 'or', left: { kind: 'not', body: left }, right });
    verify({ kind: 'seq', left: { kind: 'sub', body: left }, right });
    verify({ kind: 'seq', left: { kind: 'block', body: left }, right });
    verify({ kind: 'pipe', left, right });
    verify({ kind: 'seq', left: { kind: 'if', left, right }, right: atom(4, 2) });
    verify({ kind: 'seq', left: { kind: 'while', left, right }, right: atom(5, 2) });
  }
  console.log(JSON.stringify({ hf6_r3_differential: { lists: listTotal, shapes: total - listTotal, total, violations, denied, denied_rate: denied / total } }));
  expect(listTotal).toBe(37050);
  expect(violations).toBe(0);
}, 120_000);

const denied = [
  `cd ${X}; true || cd ${W} && touch f`,
  `cd ${X}; true || cd ${W} && echo d > f`,
  `cd ${X} && { true; }; true || cd ${W} && echo d > f`,
  `c''d ${X} && touch f`, `$'cd' ${X} && touch f`,
  `for x (1) touch ${X}/f`, `echo *(e:'touch ${X}/f':)`, 'echo ${~name}',
  `nice -n 1 env -u FOO nohup sh -c 'trap "cd ${X}; touch f" EXIT'`,
  `find . -exec env -u FOO nice -n 1 sh -c 'cd ${X}; touch f' \\;`,
  `echo data {fd}>${X}/f`, `> ${X}/f cd ${W}`,
];
test('HF6 R3 rejects both original regressions and every R2 extra rejection', () => {
  for (const shell of denied) expect(redline.reason(args(shell))).not.toBeNull();
});
test('HF6 R3 commander remains identical to e09353df on all new regression fixtures', () => {
  expect(replay(denied.map(shell => ({ shell, cwd: W })), baseline('e09353df', repo), redline).commander_changed).toBe(0);
});

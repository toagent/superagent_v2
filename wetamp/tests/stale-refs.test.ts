import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const temp = trackTempRoots();
const fixture = () => temp(mkdtempSync(join(tmpdir(), 'stale-refs-')));
const run = (...args: string[]) =>
  Bun.spawnSync([process.execPath, `${import.meta.dir}/../scripts/stale-refs.ts`, ...args]);

test('reports stale references through the CLI without changing its input directory', () => {
  const dir = fixture();
  const out = join(fixture(), 'report.json');
  const source = [
    '[listed](listed.md) [missing](missing.md)',
    '`superagent run plan.json --fake --json` `superagent engine adopt abc def`',
    'superagent job exec \\\n  --role commander -- codex exec --model x',
    '`superagent engine gone` `superagent status --fake` `superagent gone --json`',
    '`~/missing-fixture-<id>/x` `~/missing-fixture-*/x` `~/missing-fixture-$ID/x`',
    '`$HOME/missing-fixture/x` `/tmp/stale-refs-old/result.json`',
  ];
  writeFileSync(join(dir, 'MEMORY.md'), source.join('\n'));
  for (const name of ['listed.md', 'unlisted.md']) writeFileSync(join(dir, name), '');
  const snapshot = () =>
    readdirSync(dir)
      .sort()
      .map(name => [name, readFileSync(join(dir, name), 'utf8')]);
  const hash = () => Bun.hash(JSON.stringify(snapshot()));
  const before = hash();
  expect(run('--json', out, dir).exitCode).toBe(0);
  const findings: { snippet: string }[] = JSON.parse(readFileSync(out, 'utf8')).findings;
  expect(findings.map(f => f.snippet).join('\n')).toBe(
    '--role commander\nsuperagent engine gone\n--fake\nsuperagent gone\n' +
      '$HOME/missing-fixture/x\n/tmp/stale-refs-old/result.json\n[missing](missing.md)\nunlisted.md'
  );
  expect(run('--json', join(dir, 'report.json'), dir).exitCode).toBe(0);
  expect(hash()).toBe(before);
});

test('follows the memory index and classifies missing remote paths', () => {
  const dir = fixture();
  const out = join(fixture(), 'report.json');
  const source = {
    'MEMORY.md': '[table](table.md) `[example](inline.md)`\n```md\n[x](fenced.md)\n```',
    'table.md':
      '[`nested`](nested.md) [broken](broken.md) [outside](../outside.md)\n\n' +
      '~~~md\n[x](tilde-example.md)\n~~~\n\n    [x](indented-example.md)\n\n' +
      '``example\n[x](multiline-example.md)``',
    'nested.md': '[cycle](MEMORY.md)\ntwin-dev: `~/stale-refs-fixture/r`',
    'inline.md': '',
    'air.md': '`~/stale-refs-fixture/a`',
    'orphan.md': '`~/stale-refs-fixture/l`',
  };
  for (const [name, content] of Object.entries(source)) writeFileSync(join(dir, name), content);
  expect(run('--json', out, dir).exitCode).toBe(0);
  const { findings }: { findings: { category: string; snippet: string }[] } = JSON.parse(
    readFileSync(out, 'utf8')
  );
  const snippets = (category: string) =>
    findings
      .filter(f => f.category === category)
      .map(f => f.snippet)
      .sort();
  expect(snippets('missing-index-target')).toEqual(['[broken](broken.md)']);
  expect(snippets('unindexed')).toEqual(['air.md', 'inline.md', 'orphan.md']);
  expect(snippets('remote-path')).toEqual(['~/stale-refs-fixture/a', '~/stale-refs-fixture/r']);
  expect(snippets('missing-path')).toEqual(['~/stale-refs-fixture/l']);
});

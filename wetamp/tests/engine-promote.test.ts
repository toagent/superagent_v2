import { afterEach, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock } from '../src/archon';
import { currentEngineSnapshot, promote, rollback } from '../src/engine';
import { sh, tmp } from './helpers';

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

function sourceFixture(): { root: string; source: string; evidence: string; sha: () => string } {
  const root = tmp(),
    source = join(root, 'source');
  sh(`git clone -q --no-hardlinks '${join(import.meta.dir, '..', '..')}' '${source}'`, root);
  sh('git config user.name test && git config user.email test@example.com', source);
  const acceptance = join(source, 'wetamp', 'scripts', 'engine-acceptance.sh');
  writeFileSync(acceptance, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(acceptance, 0o755);
  sh('git add wetamp/scripts/engine-acceptance.sh && git commit -qm acceptance', source);
  const evidence = join(root, 'evidence.json');
  writeFileSync(evidence, '{"accepted":true}\n');
  Object.assign(process.env, {
    HOME: root,
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'archon'),
    SA_ENGINE_SOURCE: source,
    SA_ENGINE_AUTO_PROMOTE: '0',
  });
  return { root, source, evidence, sha: () => sh('git rev-parse HEAD', source).trim() };
}

const commit = (source: string, name: string): string => {
  writeFileSync(join(source, name), name);
  sh(`git add '${name}' && git commit -qm '${name}'`, source);
  return sh('git rev-parse HEAD', source).trim();
};

test('bootstrap, descendant promotion, rollback rejection, and a newer descendant', () => {
  const f = sourceFixture(),
    first = f.sha();
  expect(promote(first, f.evidence).bootstrap_evidence).toBe(f.evidence);
  expect(() => promote(first, f.evidence)).toThrow('first-use only');
  const second = commit(f.source, 'second');
  expect(promote(second).sha).toBe(second);
  expect(rollback()).toEqual({ from: second, to: first });
  expect(() => promote(second)).toThrow('sha is rejected');
  const third = commit(f.source, 'third');
  expect(promote(third).sha).toBe(third);
  expect(currentEngineSnapshot()).toEndWith(third);
});

test('promotion lock, newest receipt, and protocol downgrade fail closed', () => {
  const f = sourceFixture(),
    first = f.sha();
  promote(first, f.evidence);
  const engine = join(process.env.SUPERAGENT_HOME!, 'engine');
  const held = lock(join(engine, 'engine.lock'));
  expect(held.ok).toBe(true);
  try {
    expect(() => promote(first)).toThrow('locked');
  } finally {
    if (held.ok) held.release();
  }

  const second = commit(f.source, 'second'),
    third = commit(f.source, 'third');
  const receipts = join(engine, 'receipts');
  writeFileSync(
    join(receipts, `${third}.json`),
    JSON.stringify({
      sha: third,
      protocol_version: 1,
      acceptance_hash: 'x',
      results: [],
      at: new Date().toISOString(),
    })
  );
  expect(() => promote(second)).toThrow('newer verified sha exists');
  const firstReceipt = JSON.parse(readFileSync(join(receipts, `${first}.json`), 'utf8'));
  firstReceipt.protocol_version = 2;
  writeFileSync(join(receipts, `${first}.json`), JSON.stringify(firstReceipt));
  expect(() => promote(third)).toThrow('protocol downgrade');
});

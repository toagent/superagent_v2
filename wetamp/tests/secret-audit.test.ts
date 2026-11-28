import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditTranscripts } from '../src/secrets/audit';
import { exactPatterns } from '../src/secrets/scan';
import { tmp } from './helpers';

// prettier-ignore
test('recent transcript audit reports paths and counts for supported clients only', () => {
  const home = tmp(), value = `synthetic-${crypto.randomUUID()}`,
    variants = exactPatterns([{ name: 'SYNTHETIC', value }]).map(item => item.value),
    roots = [join(home, '.claude/projects/p'), join(home, '.codex/sessions/2026'), join(home, '.local/share/opencode/storage/session')];
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, index ? 'entry.json' : 'entry.jsonl'), variants[index + 1]);
  }
  const result = auditTranscripts({ home, env: {}, secrets: [{ name: 'SYNTHETIC', value }] });
  expect(result).toMatchObject({ ok: false, scanned: 2 });
  expect(result.findings).toHaveLength(2);
  expect(result.findings).toEqual(roots.slice(0, 2).map((root, index) => ({
    path: join(root, index ? 'entry.json' : 'entry.jsonl'),
    count: 1,
  })));
  expect(JSON.stringify(result)).not.toContain(value);
});

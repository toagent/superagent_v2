import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditTranscripts } from '../src/secrets/audit';
import { exactPatterns, managedSecrets, secretsHealth } from '../src/secrets/scan';
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

test('agy 审计覆盖 CLI、Orca 和全局说明并跳过认证、软链和超出窗口的文件', () => {
  const home = tmp(),
    outside = tmp(),
    value = `synthetic-${crypto.randomUUID()}`;
  const cli = join(home, '.gemini/antigravity-cli/conversations');
  const acp = join(home, 'Library/Application Support/orca/antigravity-chat/antigravity-acp');
  const paths = [
    join(cli, 'cli.db'),
    join(acp, 'conversations/orca.db'),
    join(home, '.gemini/GEMINI.md'),
  ];
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true });
    if (path.endsWith('.db')) {
      using db = new Database(path);
      db.run('CREATE TABLE messages (text TEXT)');
      db.run('INSERT INTO messages VALUES (?)', [value]);
    } else writeFileSync(path, value);
  }
  writeFileSync(join(acp, 'acp_token.json'), value);
  writeFileSync(join(cli, 'google_accounts.json'), value);
  writeFileSync(join(outside, 'external.db'), value);
  symlinkSync(join(outside, 'external.db'), join(cli, 'link.db'));
  symlinkSync(outside, join(cli, 'linked-dir'));
  const old = join(cli, 'old.db'),
    large = join(cli, 'large.db');
  writeFileSync(old, value);
  utimesSync(old, 1, 1);
  writeFileSync(large, value);
  truncateSync(large, 64 * 1024 * 1024 + 1);
  const result = auditTranscripts({ home, env: {}, secrets: [{ name: 'SYNTHETIC', value }] });
  expect(result).toEqual({
    ok: false,
    scanned: 3,
    findings: paths.map(path => ({ path, count: 1 })),
  });
  expect(JSON.stringify(result)).not.toContain(value);
  const linkedHome = tmp();
  symlinkSync(join(home, '.gemini'), join(linkedHome, '.gemini'));
  expect(
    auditTranscripts({ home: linkedHome, env: {}, secrets: [{ name: 'SYNTHETIC', value }] })
  ).toEqual({ ok: true, scanned: 0, findings: [] });
});

test('agy 凭据只用于路径拦截，健康扫描只读取实际的全局说明', () => {
  const home = tmp(),
    outside = tmp();
  const doc = join(home, '.gemini/GEMINI.md'),
    external = join(outside, 'instructions.md');
  const auth = join(home, '.gemini/oauth_creds.json');
  const config = join(import.meta.dir, '../secrets/gitleaks.toml');
  const policy = join(import.meta.dir, '../hooks/secret-paths.json');
  const synthetic = `synthetic-${crypto.randomUUID()}`;
  mkdirSync(dirname(doc));
  writeFileSync(auth, JSON.stringify({ refresh_token: synthetic }));
  expect(managedSecrets({ HOME: home, SA_SECRET_PATHS: policy })).toEqual([]);
  expect(secretsHealth(config, home)).toEqual({ ok: true, scanned: 0 });
  writeFileSync(external, `password = ${synthetic}`);
  symlinkSync(external, doc);
  expect(secretsHealth(config, home)).toEqual({ ok: true, scanned: 0 });
  const ownHome = tmp(),
    ownDoc = join(ownHome, '.gemini/GEMINI.md');
  mkdirSync(dirname(ownDoc));
  writeFileSync(ownDoc, `password = ${synthetic}`);
  expect(secretsHealth(config, ownHome)).toEqual({ ok: false, scanned: 1 });
});

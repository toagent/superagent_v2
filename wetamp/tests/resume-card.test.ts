import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { Coordination, type RunRef } from '../src/coord';
import { resumeCard } from '../src/resume-card';
const trackTempRoot = trackTempRoots();
const tmp = (): string => trackTempRoot(mkdtempSync(join(tmpdir(), 'resume-card-')));
const lines = (path: string, rows: unknown[]): void =>
  writeFileSync(path, rows.map(x => JSON.stringify(x)).join('\n'));
const ledger = (run_id: string, session_id: string): RunRef => ({
  run_id,
  archon_run_id: run_id,
  repo: '/r',
  controller: { client: 'codex', pid: 1, generation: 1, session_id },
});
describe('resume card', () => {
  test('Claude facts preserve quotes, replies, compression count, and owned unfinished runs', async () => {
    const home = tmp(),
      dir = join(home, 'projects', 'repo'),
      id = 'session-a',
      file = join(dir, `${id}.jsonl`);
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = home;
    lines(file, [
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', timestamp: '2026-10-21T01:02:00Z', message: { content: 'first request' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'previous proposal' }] } },
      { type: 'user', timestamp: '2026-10-21T01:03:00Z', message: { content: 'do it' } },
      { type: 'user', message: { content: '<system-reminder>ignore</system-reminder>' } },
      { type: 'user', isMeta: true, message: { content: 'meta' } },
      { type: 'user', message: { content: 'x'.repeat(400) } },
    ]);
    const ledgers = [ledger('mine', id), ledger('done', id), ledger('other', 'other')];
    const active = new Coordination({
      sa: home,
      runs: () => ledgers,
      status: l => (l.run_id === 'done' ? 'completed' : 'running'),
    }).unfinishedRuns(id);
    const card = await resumeCard({ session_id: id, transcript_path: file }, 'claude', active);
    expect(card).toMatch(
      /【复位卡·第 2 次压缩】[\s\S]*建议换会话[\s\S]*mine running[\s\S]*↳ 回应：previous proposal/
    );
    for (const text of ['done completed', 'other', 'system-reminder'])
      expect(card).not.toContain(text);
    expect(card!.indexOf('first request')).toBeLessThan(card!.indexOf('do it'));
    expect(card).not.toContain('x'.repeat(301));
  });
  test('Codex records keep earliest three and latest messages within the quote budget', async () => {
    const home = tmp(),
      dir = join(home, 'sessions', '2026', '10'),
      id = 'thread-b',
      file = join(dir, `rollout-${id}.jsonl`);
    mkdirSync(dir, { recursive: true });
    process.env.CODEX_HOME = home;
    const item = (type: string, text: string) => ({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type, content: [{ type: 'text', text }] } },
    });
    lines(file, [
      { type: 'compacted' },
      item('AgentMessage', 'answer context'),
      ...Array.from({ length: 20 }, (_, i) =>
        item('UserMessage', `${String(i).padStart(2, '0')}-${'z'.repeat(390)}`)
      ),
    ]);
    const card = await resumeCard({ session_id: id, transcript_path: file }, 'codex', []);
    for (const text of ['00-', '01-', '02-', '19-']) expect(card).toContain(text);
    expect(card).toMatch(/省略 \d+ 条/);
    expect(Buffer.byteLength(card!)).toBeLessThanOrEqual(6144);
  });
  test('rejects paths outside the configured root, symlink escapes, and mismatched names', async () => {
    const base = tmp(),
      root = join(base, 'claude'),
      project = join(root, 'projects'),
      outside = join(base, 's.jsonl');
    mkdirSync(project, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = root;
    lines(outside, []);
    const link = join(project, 's.jsonl');
    symlinkSync(outside, link);
    const wrong = join(project, 'wrong.jsonl');
    lines(wrong, []);
    for (const transcript_path of [outside, link, wrong])
      expect(await resumeCard({ session_id: 's', transcript_path }, 'claude', [])).toBeNull();
  });
  test('hook is silent for non-compact and derived sessions', () => {
    const hook = join(import.meta.dir, '..', 'hooks', 'resume-card.cjs');
    const run = (payload: object, role = '') =>
      Bun.spawnSync(['node', hook, 'codex'], {
        stdin: new Blob([JSON.stringify(payload)]),
        env: { ...process.env, SUPERAGENT_ROLE: role },
        stdout: 'pipe',
      }).stdout.toString();
    expect(run({ hook_event_name: 'SessionStart', source: 'startup' })).toBe('');
    expect(run({ hook_event_name: 'SessionStart', source: 'compact' }, 'general')).toBe('');
  });
});

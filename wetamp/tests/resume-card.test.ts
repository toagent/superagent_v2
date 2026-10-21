import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordination, type RunRef } from '../src/coord';
import { resumeCard } from '../src/resume-card';

const roots: string[] = [];
const tmp = (): string => {
  const p = mkdtempSync(join(tmpdir(), 'resume-card-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const lines = (path: string, rows: unknown[]): void =>
  writeFileSync(path, rows.map(x => JSON.stringify(x)).join('\n'));

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
    const ledgers: RunRef[] = [
      {
        run_id: 'mine',
        archon_run_id: '1',
        repo: '/r',
        controller: { client: 'codex', pid: 1, generation: 1, session_id: id },
      },
      {
        run_id: 'done',
        archon_run_id: '2',
        repo: '/r',
        controller: { client: 'codex', pid: 1, generation: 1, session_id: id },
      },
      {
        run_id: 'other',
        archon_run_id: '3',
        repo: '/r',
        controller: { client: 'codex', pid: 1, generation: 1, session_id: 'other' },
      },
    ];
    const active = new Coordination({
      sa: home,
      runs: () => ledgers,
      status: l => (l.run_id === 'done' ? 'completed' : 'running'),
    }).unfinishedRuns(id);
    const card = await resumeCard({ session_id: id, transcript_path: file }, 'claude', active);
    expect(card).toContain('【复位卡·第 2 次压缩】');
    expect(card).toContain('建议换会话');
    expect(card).toContain('mine running');
    expect(card).not.toContain('done completed');
    expect(card).not.toContain('other');
    expect(card!.indexOf('first request')).toBeLessThan(card!.indexOf('do it'));
    expect(card).toContain('↳ 回应：previous proposal');
    expect(card).not.toContain('system-reminder');
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
    expect(card).toContain('00-');
    expect(card).toContain('01-');
    expect(card).toContain('02-');
    expect(card).toContain('19-');
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
    expect(
      await resumeCard({ session_id: 's', transcript_path: outside }, 'claude', [])
    ).toBeNull();
    expect(await resumeCard({ session_id: 's', transcript_path: link }, 'claude', [])).toBeNull();
    expect(await resumeCard({ session_id: 's', transcript_path: wrong }, 'claude', [])).toBeNull();
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

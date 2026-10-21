import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { renderHandoffContext } from '../src/rollover-context';
import { tmp } from './helpers';

const write = (path: string, rows: unknown[]): void =>
  writeFileSync(path, rows.map(x => JSON.stringify(x)).join('\n'));
// prettier-ignore
const msg = (type: string, content: unknown, extra: object = {}) => ({ type, timestamp: '2026-10-21T01:02:03Z', message: { content }, ...extra });

// prettier-ignore
test('Claude renders quotes, interruption, latest summary and report while excluding transcript machinery', async () => {
  const root = tmp(), file = join(root, 'claude.jsonl'), long = `HEAD${'x'.repeat(4990)}TAIL`;
  write(file, [
    msg('user', 'meta', { isMeta: true }), msg('user', 'side', { isSidechain: true }),
    msg('user', 'old summary', { isCompactSummary: true }), msg('user', 'new summary', { isCompactSummary: true }),
    msg('user', [{ type: 'tool_result', content: 'tool' }]), msg('user', '<local-command-stdout>noise</local-command-stdout>'),
    msg('user', '<command-name>/x</command-name>'),
    { type: 'queue-operation', operation: 'enqueue', content: 'queued' }, { type: 'queue-operation', operation: 'dequeue', content: 'dequeued' },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: 'mid', timestamp: '2026-10-21T01:03:03Z' },
    msg('user', long), msg('assistant', [{ type: 'text', text: 'hidden' }], { isSidechain: true }), msg('assistant', [{ type: 'text', text: 'final' }, { type: 'tool_use' }]),
  ]);
  const out = await renderHandoffContext([{ client: 'claude', transcript: file, label: 'old' }, { client: 'claude', transcript: file, label: 'new' }]);
  expect(out.indexOf('## old')).toBeLessThan(out.indexOf('## new'));
  for (const value of ['/x', '「插话」mid', 'new summary', 'final', '第 11 行', 'HEAD', 'TAIL']) expect(out).toContain(value);
  for (const value of ['meta', 'side', 'old summary', 'tool', 'noise', 'queued', 'dequeued', 'hidden']) expect(out).not.toContain(value);
});

// prettier-ignore
test('Codex renders messages and compaction, excludes injected context, and reports missing or malformed transcripts', async () => {
  const root = tmp(), file = join(root, 'codex.jsonl'), bad = join(root, 'bad.jsonl'), missing = join(root, 'missing.jsonl');
  const compact = `HEAD${'x'.repeat(11993)}TAIL`;
  const item = (type: string, value: string, kind = 'text') => ({ type: 'event_msg', timestamp: '2026-10-21T02:03:04Z', payload: { type: 'item_completed', item: { type, content: [{ type: kind, text: value }] } } });
  write(file, [item('UserMessage', '<environment_context>secret</environment_context>'), item('UserMessage', '# AGENTS.md instructions for /repo\nrules'), item('UserMessage', 'request'), { type: 'compacted', payload: { message: 'old compact' } }, { type: 'compacted', payload: { message: compact } }, item('AgentMessage', 'old report', 'Text'), item('AgentMessage', 'last report', 'Text')]);
  writeFileSync(bad, '{');
  const out = await renderHandoffContext([{ client: 'codex', transcript: file, label: 'codex' }, { client: 'codex', transcript: bad, label: 'bad' }, { client: 'codex', transcript: missing, label: 'missing' }]);
  for (const value of ['request', 'HEAD', 'TAIL', 'last report', '## bad\n\ntranscript 不可读：第 1 行 JSON 损坏', '## missing\n\ntranscript 不可读：']) expect(out).toContain(value);
  expect(out.length).toBeGreaterThan(11000);
  for (const value of ['secret', 'AGENTS.md', 'old compact', 'old report']) expect(out).not.toContain(value);
});

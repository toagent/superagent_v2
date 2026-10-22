import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmp } from './helpers';

// prettier-ignore
type Limits = { threshold: number; rollover: number | null; window: number | null; advisoryStep: number; rolloverStep: number };
const advisory = createRequire(import.meta.url)('../hooks/context-advisory.cjs') as {
  recentUsage(file: string, client?: string): { tokens: number; window: number | null } | null;
  contextLimits(...args: unknown[]): Limits;
  advise(...args: unknown[]): { state: Record<string, number>; messages: string[] };
  main(
    input: unknown,
    client?: string
  ): { hookSpecificOutput: { additionalContext: string } } | null;
};
const policy = {
  context: {
    advisory_ratio: { commander: 0.3 },
    rollover_ratio: { commander: 0.7 },
    advisory_tokens: { commander: 160000 },
    rollover_tokens: { commander: 400000 },
  },
};

test('parses Claude and Codex usage without double-counting Codex cached input', () => {
  const root = tmp(),
    claude = join(root, 'claude.jsonl'),
    codex = join(root, 'codex.jsonl');
  writeFileSync(
    claude,
    `${JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } })}\n`
  );
  writeFileSync(
    codex,
    `${JSON.stringify({ timestamp: '2026-10-22T00:00:00Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 400000, last_token_usage: { input_tokens: 240001, cached_input_tokens: 90000 } } } })}\n`
  );
  expect(advisory.recentUsage(claude)).toEqual({ tokens: 60, window: null });
  expect(advisory.recentUsage(codex, 'codex')).toEqual({ tokens: 240001, window: 400000 });
});

test('finds the latest Codex token count before trailing rollout events', () => {
  const file = join(tmp(), 'codex.jsonl'),
    usage = (ordinal: number, input_tokens: number) => ({
      timestamp: '2026-10-22T00:00:00Z',
      ordinal,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { model_context_window: 380000, last_token_usage: { input_tokens } },
      },
    });
  writeFileSync(
    file,
    [
      usage(1, 100),
      usage(2, 200),
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'response_item', payload: {} },
    ]
      .map(line => JSON.stringify(line))
      .join('\n') + '\n'
  );
  expect(advisory.recentUsage(file, 'codex')).toEqual({ tokens: 200, window: 380000 });
});

test('derives client limits and falls back to absolute thresholds without a window', () => {
  const root = tmp();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.toml'), 'model_auto_compact_token_limit = 280000\n');
  const limits = (client: string, window: number | null, env: Record<string, string> = {}) =>
      advisory.contextLimits('commander', client, window, env, policy),
    values = (v: Limits) => [v.threshold, v.rollover, v.window, v.advisoryStep, v.rolloverStep];
  // prettier-ignore
  expect(values(limits('claude', null, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' }))).toEqual([300000, 600000, 1000000, 50000, 100000]);
  // prettier-ignore
  expect(values(limits('claude', null, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' }))).toEqual([300000, 700000, 1000000, 50000, 100000]);
  expect(limits('claude', null)).toMatchObject({ threshold: 60000, rollover: 140000 });
  // prettier-ignore
  expect(values(limits('codex', 380000, { CODEX_HOME: root }))).toEqual([114000, 242000, 380000, 19000, 38000]);
  expect(limits('codex', null, { CODEX_HOME: root })).toMatchObject({
    threshold: 160000,
    rollover: 400000,
    window: null,
  });
  const first = advisory.advise({}, 300001, {}, false, 300000, 600000, {}, 50000, 100000, 1000000);
  expect(first.messages[0]).toContain('300001 token（30%）');
  expect(first.messages[0]).toContain('换会话线 600000（60%）');
  expect(first.messages[0]).toContain('advisory 只是提醒，未收到换会话指令前不要换会话');
  expect(advisory.advise({}, 300001, {}, false, 300000, 600000).messages[0]).not.toContain('%');
  expect(
    advisory.advise({}, 350000, first.state, false, 300000, 600000, {}, 50000, 100000).messages
  ).toEqual([]);
  expect(
    advisory.advise({}, 350001, first.state, false, 300000, 600000, {}, 50000, 100000).messages
  ).toHaveLength(1);
});

test('Codex main emits rollover instructions once per dynamic step', () => {
  const root = tmp(),
    transcript = join(root, 'rollout.jsonl'),
    prior = { ...process.env };
  mkdirSync(join(root, 'codex'), { recursive: true });
  writeFileSync(join(root, 'codex/config.toml'), 'model_auto_compact_token_limit = 280000\n');
  const writeUsage = (tokens: number) =>
    writeFileSync(
      transcript,
      `${JSON.stringify({ timestamp: '2026-10-22T00:00:00Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 400000, last_token_usage: { input_tokens: tokens, cached_input_tokens: 100000 } } } })}\n`
    );
  Object.assign(process.env, {
    SUPERAGENT_HOME: join(root, 'sa'),
    CODEX_HOME: join(root, 'codex'),
    SUPERAGENT_ROLE: '',
    AI_DISPATCH_ROLE: '',
    TWIN_AGENT_REMOTE: '',
  });
  try {
    writeUsage(240001);
    // prettier-ignore
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 'codex-main', transcript_path: transcript, cwd: root };
    expect(advisory.main(input, 'codex')?.hookSpecificOutput.additionalContext).toContain(
      '已过换会话线 240000'
    );
    expect(advisory.main(input, 'codex')).toBeNull();
    writeUsage(280001);
    expect(advisory.main(input, 'codex')?.hookSpecificOutput.additionalContext).toContain(
      '已过换会话线 240000'
    );
  } finally {
    process.env = prior;
  }
});

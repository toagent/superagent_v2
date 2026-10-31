import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askNtfy, publishPendingNtfy, syncNtfy, type NtfyConfig } from '../src/ntfy';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(now = 2_000_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'ntfy-decisions-'));
  roots.push(root);
  const publisherToken = join(root, 'publisher'),
    answerToken = join(root, 'answer');
  writeFileSync(publisherToken, 'publisher-secret\n', { mode: 0o600 });
  writeFileSync(answerToken, 'answer-secret\n', { mode: 0o600 });
  const posts: Record<string, unknown>[] = [],
    events: string[] = [];
  const fakeFetch: typeof fetch = (async (input, init) => {
    if (String(input).includes('/sa-answers/json')) {
      const body = events.splice(0).join('\n');
      return new Response(body, { status: 200 });
    }
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const config: NtfyConfig = {
    baseUrl: 'http://ntfy.test',
    publisherToken,
    answerToken,
    answerKey: join(root, 'answer.key'),
    statePath: join(root, 'state.json'),
    fetch: fakeFetch,
    now: () => now,
  };
  const request = (risk: 'normal' | 'red' = 'normal') => ({
    source: 'test',
    title: 'Decision',
    body: 'Choose',
    risk,
    options: [
      { id: 'yes', label: 'Yes', consequence: 'changes state' },
      { id: 'no', label: 'No' },
    ],
    expires_at: new Date(now + 3_600_000).toISOString(),
    callback: { kind: 'ask' as const, key: 'r:hold' },
  });
  const answer = (post = posts.at(-1)!, index = 0) =>
    JSON.parse(String((post.actions as { body: string }[])[index].body));
  const push = (value: unknown, id = crypto.randomUUID()) =>
    events.push(JSON.stringify({ id, event: 'message', message: JSON.stringify(value) }));
  const first = () =>
    Object.values(JSON.parse(readFileSync(config.statePath, 'utf8')).decisions)[0];
  return { config, posts, request, answer, push, first };
}
const collect =
  (values: string[]) =>
  (_decision: unknown, option: string): void => {
    values.push(option);
  };

describe('ntfy decision channel', () => {
  test('accepts one valid signed answer and rejects forgery, replay, expiry and a duplicate answer', async () => {
    const f = fixture(),
      accepted: string[] = [];
    askNtfy(f.request(), f.config);
    await publishPendingNtfy(f.config);
    const valid = f.answer();
    f.push({ ...valid, sig: '0'.repeat(64) });
    f.push(valid);
    f.push(valid);
    expect(await syncNtfy(collect(accepted), f.config)).toEqual({ accepted: 1, ignored: 2 });
    const second = fixture();
    askNtfy(second.request(), second.config);
    await publishPendingNtfy(second.config);
    second.push(second.answer());
    second.config.now = () => 2_000_007_200_000;
    expect((await syncNtfy(collect(accepted), second.config)).accepted).toBe(0);
    expect(second.first()).toMatchObject({ status: 'expired' });
  });

  test('requires the red request and a fresh five-minute confirmation', async () => {
    const f = fixture(),
      accepted: string[] = [];
    askNtfy(f.request('red'), f.config);
    await publishPendingNtfy(f.config);
    f.push(f.answer());
    expect((await syncNtfy(collect(accepted), f.config)).accepted).toBe(0);
    await publishPendingNtfy(f.config);
    expect((f.posts.at(-1)!.actions as { label: string }[])[0].label).toBe('确认批准');
    f.push(f.answer());
    expect((await syncNtfy(collect(accepted), f.config)).accepted).toBe(1);
    expect(accepted).toEqual(['yes']);
  });

  test('keeps a decision pending when ntfy is unavailable', async () => {
    const f = fixture();
    askNtfy(f.request(), f.config);
    const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(publishPendingNtfy({ ...f.config, fetch: offline })).rejects.toThrow('offline');
    expect(f.first()).toMatchObject({ status: 'pending', delivery: 'pending' });
  });

  test('keeps secrets out of state, errors and request bodies', async () => {
    const f = fixture();
    askNtfy(f.request(), f.config);
    await publishPendingNtfy(f.config);
    const state = readFileSync(f.config.statePath, 'utf8');
    const buttonBodies = (f.posts[0].actions as { body: string }[])
      .map(action => action.body)
      .join('');
    expect(state + buttonBodies).not.toContain('publisher-secret');
    expect(state + buttonBodies).not.toContain('answer-secret');
    chmodSync(f.config.publisherToken, 0o644);
    askNtfy({ ...f.request(), callback: { kind: 'ask', key: 'r:second' } }, f.config);
    await expect(publishPendingNtfy(f.config)).rejects.toThrow(
      'publisher token file must be mode 600'
    );
  });
});

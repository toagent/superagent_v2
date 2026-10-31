import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerNtfyDecision } from '../src/decisions';
import { askCli, syncDecisionChannel } from '../src/cli';
import { DeviceStore, type Receipt } from '../src/web/device-store';
import { tickHealth } from '../src/heartbeat';
import {
  askNtfy,
  publishPendingNtfy,
  queueNtfyAlert,
  syncNtfy,
  type NtfyConfig,
} from '../src/ntfy';

const roots: string[] = [],
  servers: Bun.Server<unknown>[] = [];
afterEach(() => {
  servers.splice(0).forEach(s => s.stop(true));
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});
function fixture(now = 2_000_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'ntfy-decisions-'));
  roots.push(root);
  const publisherToken = join(root, 'publisher'),
    answerToken = join(root, 'answer');
  writeFileSync(publisherToken, 'publisher-secret\n', { mode: 0o600 });
  writeFileSync(answerToken, 'answer-secret\n', { mode: 0o600 });
  const posts: { url: string; body: Record<string, unknown> }[] = [],
    events: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/sa-answers/json')
        return new Response(events.splice(0).join('\n'));
      posts.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
      return new Response('{}');
    },
  });
  servers.push(server);
  const config: NtfyConfig = {
    baseUrl: server.url.origin,
    publisherToken,
    answerToken,
    answerKey: join(root, 'answer.key'),
    statePath: join(root, 'state.json'),
    fetch,
    now: () => now,
  };
  const request = (ref: string, risk: 'normal' | 'red' = 'normal') => ({
    source: 'test',
    title: 'Decision',
    body: 'Choose',
    risk,
    options: [
      { id: 'yes', label: 'Yes', consequence: 'changes state' },
      { id: 'no', label: 'No' },
    ],
    expires_at: new Date(now + 3_600_000).toISOString(),
    callback: { kind: 'external' as const, ref },
    dedupe_key: ref,
  });
  const action = (post = posts.at(-1)!, index = 0) =>
    JSON.parse(String((post.body.actions as { body: string }[])[index].body));
  const push = (value: unknown) =>
    events.push(
      JSON.stringify({ id: crypto.randomUUID(), event: 'message', message: JSON.stringify(value) })
    );
  const state = () =>
    JSON.parse(readFileSync(config.statePath, 'utf8')) as {
      decisions: Record<string, { status: string }>;
    };
  return { root, config, posts, request, action, push, state };
}

describe('ntfy decision channel', () => {
  test('uses ntfy JSON protocol and advances past forged, replayed and callback-failed events', async () => {
    const f = fixture(),
      accepted: string[] = [];
    const first = askNtfy(f.request('first'), f.config);
    await publishPendingNtfy(f.config);
    expect(new URL(f.posts[0].url).pathname).toBe('/');
    expect(f.posts[0].body.topic).toBe('sa-decisions');
    const valid = f.action();
    f.push({ ...valid, sig: '0'.repeat(64) });
    f.push(valid);
    f.push(valid);
    expect(
      await syncNtfy((_d, option) => {
        accepted.push(option);
      }, f.config)
    ).toEqual({ accepted: 1, ignored: 2, failed: 0 });
    const bad = askNtfy(f.request('bad'), f.config),
      live = askNtfy(f.request('live'), f.config);
    await publishPendingNtfy(f.config);
    f.push(f.action(f.posts.at(-2)));
    f.push(f.action());
    expect(
      await syncNtfy(d => {
        if (d.id === bad) throw new Error('stale');
        accepted.push(d.id);
      }, f.config)
    ).toMatchObject({ accepted: 1, failed: 1 });
    expect(f.state().decisions).toMatchObject({
      [first]: { status: 'answered' },
      [bad]: { status: 'failed' },
      [live]: { status: 'answered' },
    });
    queueNtfyAlert('receipt', 'done', f.config);
    await publishPendingNtfy(f.config);
    expect(f.posts.at(-1)!.body).toMatchObject({ topic: 'sa-alerts', message: 'done' });
  });

  test('requires a fresh red confirmation and expires without one', async () => {
    const f = fixture(),
      accepted: string[] = [];
    askNtfy(f.request('red', 'red'), f.config);
    await publishPendingNtfy(f.config);
    f.push(f.action());
    expect(
      (
        await syncNtfy((_d, option) => {
          accepted.push(option);
        }, f.config)
      ).accepted
    ).toBe(0);
    expect((f.posts.at(-1)!.body.actions as { label: string }[])[0].label).toBe('确认批准');
    f.push(f.action());
    expect(
      (
        await syncNtfy((_d, option) => {
          accepted.push(option);
        }, f.config)
      ).accepted
    ).toBe(1);
    expect(accepted).toEqual(['yes']);
  });

  test('keeps outages pending and external asks queryable through the supervise sync path', async () => {
    const f = fixture(),
      output: unknown[] = [];
    await askCli(
      [
        'ask',
        '--source',
        'agent',
        '--title',
        'T',
        '--body',
        'B',
        '--option',
        'yes=Yes',
        '--expires-at',
        f.request('x').expires_at,
        '--callback',
        'external:x',
      ],
      f.config,
      value => output.push(value)
    );
    const id = (output[0] as { id: string }).id;
    f.push(f.action());
    await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] }));
    await askCli(['ask', 'status', id], f.config, value => output.push(value));
    expect(output.at(-1)).toMatchObject({ id, status: 'answered', answer: 'yes' });
    const expires = askNtfy(f.request('expires'), f.config);
    await publishPendingNtfy(f.config);
    let expired = '';
    f.config.now = () => 2_000_007_200_000;
    await syncNtfy(
      () => undefined,
      f.config,
      decision => {
        expired = decision.id;
      }
    );
    expect(expired).toBe(expires);
    f.config.now = () => 2_000_000_000_000;
    askNtfy(f.request('offline'), f.config);
    const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(publishPendingNtfy({ ...f.config, fetch: offline })).rejects.toThrow(
      'ntfy publish unavailable'
    );
    expect(
      tickHealth(
        { at: new Date().toISOString(), ntfy_publish: { ok: false, error: 'offline' } },
        Date.now()
      ).messages
    ).toContain('ntfy 发布失败：offline');
  });

  test('keeps secrets out of state and uses a valid answerDecision channel identity', async () => {
    const f = fixture();
    askNtfy(f.request('secret'), f.config);
    await publishPendingNtfy(f.config);
    const key = readFileSync(f.config.answerKey, 'utf8').trim(),
      visible =
        readFileSync(f.config.statePath, 'utf8') +
        JSON.stringify(f.posts[0].body) +
        process.argv.join(' ');
    expect(visible).not.toContain(key);
    expect(visible).not.toContain('publisher-secret');
    const leaking = (async (...args: Parameters<typeof fetch>) => {
      throw new Error(JSON.stringify(args[1]));
    }) as unknown as typeof fetch;
    askNtfy(f.request('leak'), f.config);
    await expect(publishPendingNtfy({ ...f.config, fetch: leaking })).rejects.toThrow(
      'ntfy publish unavailable'
    );
    chmodSync(f.config.publisherToken, 0o644);
    await expect(publishPendingNtfy(f.config)).rejects.toThrow(
      'publisher token file must be mode 600'
    );
    let device = '';
    const receipt: Receipt = {
      id: 'd',
      device: '',
      run: '',
      engine: '',
      node: '',
      pause: '',
      decision: 'yes',
      at: '',
      stage: 'accepted',
    };
    await answerNtfyDecision(
      'd',
      'yes',
      new DeviceStore(join(f.root, 'devices')),
      async (store, value) => {
        device = value.id;
        store.deviceLock(value.id).release();
        return receipt;
      }
    );
    expect(device).toMatch(/^[a-f0-9]{64}$/);
  });
});

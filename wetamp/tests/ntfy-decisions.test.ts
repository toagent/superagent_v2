import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerNtfyDecision,
  DecisionError,
  DecisionStore,
  type DecisionReceipt,
} from '../src/decisions';
import { askCli, notifyCli, ntfyCli, ntfyTickHealth, syncDecisionChannel } from '../src/cli';
import { caller, coord } from '../src/coord';
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
// prettier-ignore
function fixture(now = 2_000_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), 'ntfy-decisions-')); roots.push(root);
  const publisherToken = join(root, 'publisher'), answerToken = join(root, 'answer');
  writeFileSync(publisherToken, 'publisher-secret\n', { mode: 0o600 });
  writeFileSync(answerToken, 'answer-secret\n', { mode: 0o600 });
  const posts: { url: string; body: Record<string, unknown> }[] = [], events: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/sa-answers/json') return new Response(events.splice(0).join('\n'));
    posts.push({ url: request.url, body: await request.json() as Record<string, unknown> }); return new Response('{}');
  } }); servers.push(server);
  const config: NtfyConfig = { baseUrl: server.url.origin, publisherToken, answerToken, answerKey: join(root, 'answer.key'), statePath: join(root, 'state.json'), fetch, now: () => now };
  const request = (ref: string, risk: 'normal' | 'red' = 'normal') => ({ source: 'test', title: 'Decision', body: 'Choose', risk, options: [{ id: 'yes', label: 'Yes', consequence: 'changes state' }, { id: 'no', label: 'No' }], expires_at: new Date(now + 3_600_000).toISOString(), callback: { kind: 'external' as const, ref }, dedupe_key: ref });
  const action = (post = posts.at(-1)!, index = 0) => JSON.parse(String((post.body.actions as { body: string }[])[index].body));
  const push = (value: unknown) => events.push(JSON.stringify({ id: crypto.randomUUID(), event: 'message', message: JSON.stringify(value) }));
  const state = () => JSON.parse(readFileSync(config.statePath, 'utf8')) as { decisions: Record<string, { status: string; error?: { code: string; message: string } }> };
  return { root, config, posts, request, action, push, state };
}

// prettier-ignore
describe('ntfy decision channel', () => {
  test('uses ntfy JSON protocol and advances past forged, replayed and callback-failed events', async () => {
    const f = fixture(), accepted: string[] = [];
    const first = askNtfy(f.request('first'), f.config); await publishPendingNtfy(f.config);
    expect(new URL(f.posts[0].url).pathname).toBe('/'); expect(f.posts[0].body.topic).toBe('sa-decisions');
    expect((f.posts[0].body.actions as { clear: boolean }[]).every(action => action.clear)).toBeTrue();
    const valid = f.action(); f.push({ ...valid, sig: '0'.repeat(64) }); f.push(valid); f.push(valid); f.push({ ...valid, id: 'missing' });
    expect(await syncNtfy((_d, option) => { accepted.push(option); }, f.config)).toEqual({ accepted: 1, ignored: 3, failed: 0 });
    expect(f.posts.filter(post => post.body.topic === 'sa-alerts').map(post => post.body.title)).toEqual(['未执行｜Decision', '已记录：Yes｜Decision', '未执行｜未知决策']);
    const bad = askNtfy(f.request('bad'), f.config), stale = askNtfy(f.request('stale'), f.config), live = askNtfy(f.request('live'), f.config);
    await publishPendingNtfy(f.config); const badAction = f.action(f.posts.at(-3)), staleAction = f.action(f.posts.at(-2), 1); f.push(badAction); f.push(staleAction); f.push(f.action());
    expect(await syncNtfy(d => { if (d.id === bad) throw new Error('secret body'); if (d.id === stale) throw new DecisionError('决定已变化，请重读', 'decision_changed', { status: 'accepted', at: '2033-05-18T03:33:19.000Z' }); accepted.push(d.id); }, f.config)).toMatchObject({ accepted: 1, failed: 2 });
    expect(f.state().decisions).toMatchObject({ [first]: { status: 'answered' }, [bad]: { status: 'failed', error: { code: 'callback_failed', message: '回调处理失败' } }, [stale]: { status: 'superseded', error: { code: 'decision_changed' } }, [live]: { status: 'answered' } });
    expect(f.posts.find(post => String(post.body.message).includes('你点的选项：No'))?.body).toMatchObject({ title: '未执行｜No｜Decision', message: expect.stringContaining('在 2033-05-18T03:33:19.000Z 已 accepted') });
    expect(readFileSync(f.config.statePath, 'utf8')).not.toContain('secret body');
    f.push(staleAction); await syncNtfy(() => undefined, f.config); expect(f.posts.at(-1)!.body).toMatchObject({ title: '未执行｜No｜Decision', message: expect.stringContaining('你的选择未改变任何状态') });
    queueNtfyAlert('receipt', 'done', f.config); await publishPendingNtfy(f.config);
    expect(f.posts.at(-1)!.body).toMatchObject({ topic: 'sa-alerts', message: 'done' });
  });
  test('requires a fresh red confirmation and expires without one', async () => {
    const f = fixture(), accepted: string[] = []; askNtfy({ ...f.request('red', 'red'), project: 'Archon', headline: '红线操作' }, f.config);
    await publishPendingNtfy(f.config); f.push(f.action());
    expect((await syncNtfy((_d, option) => { accepted.push(option); }, f.config)).accepted).toBe(0);
    expect(f.posts.at(-1)!.body).toMatchObject({ title: '未执行｜Archon｜红线操作', message: expect.stringContaining('▍还需要你吗\n是') });
    const confirmation = f.posts.filter(post => post.body.topic === 'sa-decisions').at(-1)!;
    expect(confirmation.body).toMatchObject({ priority: 5, tags: ['red_circle'] });
    expect((confirmation.body.actions as { label: string }[])[0].label).toBe('确认批准');
    f.push(f.action(confirmation)); expect((await syncNtfy((_d, option) => { accepted.push(option); }, f.config)).accepted).toBe(1);
    expect(accepted).toEqual(['yes']);
  });
  test('keeps outages pending and external asks queryable through the supervise sync path', async () => {
    const f = fixture(), output: unknown[] = [];
    await askCli(['ask', '--source', 'agent', '--title', 'T', '--body', 'B', '--option', 'yes=Yes', '--expires-at', f.request('x').expires_at, '--callback', 'external:x'], f.config, value => output.push(value));
    const id = (output[0] as { id: string }).id; f.push(f.action());
    await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] }));
    expect(coord().inbox(caller(), true).find(message => message.source === id)).toMatchObject({ type: 'receipt', body: expect.stringContaining(`ask ${id}：T：Yes`) });
    expect(output[0]).toMatchObject({ next: expect.stringContaining('inbox --wait --timeout 7000') });
    await askCli(['ask', 'status', id], f.config, value => output.push(value));
    expect(output.at(-1)).toMatchObject({ id, status: 'answered', answer: 'yes' });
    const expires = askNtfy(f.request('expires'), f.config); await publishPendingNtfy(f.config); const expiredAction = f.action();
    let expired = ''; f.config.now = () => 2_000_007_200_000;
    await syncNtfy(() => undefined, f.config, decision => { expired = decision.id; }); expect(expired).toBe(expires);
    f.push(expiredAction); await syncNtfy(() => undefined, f.config);
    expect(f.posts.at(-1)!.body.message).toContain('该决策已过期，未执行');
    f.config.now = () => 2_000_000_000_000; askNtfy(f.request('offline'), f.config);
    const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(publishPendingNtfy({ ...f.config, fetch: offline })).rejects.toThrow('ntfy publish unavailable');
    expect(ntfyTickHealth({ at: new Date().toISOString(), ntfy_publish: { ok: false, error: 'offline' } }, Date.now()).messages).toContain('ntfy 发布失败：offline');
  });
  test('accepts validated ask specs and omits missing presentation fields', async () => {
    const f = fixture(), path = join(f.root, 'ask.json'), base = { source: 'marshal', source_ref: { ref: 'run-27', initiator: 'marshal' }, title: '是否放行？', body: '正文不应重复', options: [{ id: 'yes', label: '是', effect: '继续 run' }, { id: 'no', label: '否' }], recommend: { option: '是', reason: '验收通过' }, risk: 'normal', expires_at: f.request('x').expires_at, callback: { kind: 'external', ref: 'external:27' } };
    writeFileSync(path, JSON.stringify(base)); await askCli(['ask', '--spec', path], f.config, () => undefined);
    expect(f.posts[0]!.body.title).toBe('需你决定｜是否放行？');
    const message = String(f.posts[0]!.body.message);
    expect(message).toContain('▍一句话\n是否放行？'); expect(message).not.toContain('正文不应重复');
    expect(message).toContain('• 是｜继续 run\n• 否'); expect(message).not.toContain('未说明'); expect(message).not.toContain('▍这个任务是什么');
    writeFileSync(path, JSON.stringify({ ...base, options: [{ id: 'yes', label: 1 }] }));
    await expect(askCli(['ask', '--spec', path], f.config)).rejects.toThrow('options[0].label');
    await expect(askCli(['ask', '--spec', path, '--title', 'conflict'], f.config)).rejects.toThrow('--spec cannot be combined with --title');
  });
  test('publishes titled notifications once and keeps outages pending without leaking tokens', async () => {
    const f = fixture(), output: unknown[] = [];
    await expect(notifyCli(['notify', '--id', 'missing'], f.config)).rejects.toThrow('usage: superagent notify');
    await notifyCli(['notify', '--id', 'alert-1', '--title', 'Stalled', '--body', 'Needs attention'], f.config, value => output.push(value));
    await notifyCli(['notify', '--id', 'alert-1', '--title', 'Stalled', '--body', 'Needs attention'], f.config, value => output.push(value));
    expect(f.posts.filter(post => post.body.topic === 'sa-alerts')).toHaveLength(1);
    expect(f.posts.at(-1)!.body).toMatchObject({ topic: 'sa-alerts', title: 'Stalled', message: 'Needs attention', priority: 3, tags: ['large_blue_circle'] });
    expect(output).toEqual([{ id: 'alert-1', delivery: 'sent' }, { id: 'alert-1', delivery: 'sent' }]);
    await notifyCli(['notify', '--id', 'urgent', '--title', 'Urgent', '--body', 'Act', '--priority', '5'], f.config, () => undefined);
    expect(f.posts.at(-1)!.body.priority).toBe(5);
    const offline = (() => Promise.reject(new Error('publisher-secret'))) as unknown as typeof fetch;
    await notifyCli(['notify', '--id', 'alert-2', '--title', 'Offline', '--body', 'Queued'], { ...f.config, fetch: offline }, value => output.push(value));
    expect(output.at(-1)).toEqual({ id: 'alert-2', delivery: 'pending' });
    const persisted = readFileSync(f.config.statePath, 'utf8');
    expect(persisted).toContain('alert-2'); expect(persisted).not.toContain('publisher-secret');
    expect(JSON.stringify(f.posts) + JSON.stringify(output)).not.toContain('publisher-secret');
    await expect(notifyCli(['notify', '--id', 'bad', '--title', 'Bad', '--body', 'Bad', '--priority', '6'], f.config)).rejects.toThrow('--priority must be 1-5');
  });
  test('renders structured decisions and receipts as full plain-text briefs', async () => {
    const f = fixture(), request = { ...f.request('full'), source: { ref: 'run-24', initiator: 'codex 元帅（Archon）', queued_at: '2033-05-18T03:00:00.000Z' }, project: 'Archon', headline: '是否放行？', purpose: '修复 ntfy 决策信息', why: '人工门禁等待决策', recommend: { option: '是', reason: '验收已通过' }, options: [{ id: 'yes', label: '是', timing: '立即', effect: '继续 run', reversible: '可取消', risk: '可能需要修复' }, { id: 'no', label: '否', consequence: '保持停顿', risk: '延迟交付' }] };
    askNtfy(request, f.config); await publishPendingNtfy(f.config);
    expect(f.posts[0]!.body).toMatchObject({ title: '需你决定｜Archon｜是否放行？', priority: 4, tags: ['orange_circle'] });
    const message = String(f.posts[0]!.body.message);
    expect(message).toStartWith('━'.repeat(14)); expect(message).toContain('▍选项对比'); expect(message).toContain('来源：run-24'); expect(Buffer.byteLength(message)).toBeLessThanOrEqual(4000);
    f.push(f.action(f.posts[0])); await syncNtfy(() => undefined, f.config);
    expect(f.posts.at(-1)!.body).toMatchObject({ title: '已执行｜Archon｜是否放行？', priority: 2, tags: ['green_circle'] });
    expect(String(f.posts.at(-1)!.body.message)).toContain('▍还需要你吗');
  });
  test('moves a gate answer to its current episode and reports execution in progress', async () => {
    const f = fixture(), saved = process.env.SUPERAGENT_HOME;
    process.env.SUPERAGENT_HOME = f.root;
    try {
      const oldKey = 'run:signoff:old', middleKey = 'run:signoff:middle', currentKey = 'run:signoff:current';
      const id = askNtfy({ ...f.request('gate'), project: 'Archon', headline: '是否批准签收并续跑？', callback: { kind: 'ask', key: oldKey } }, f.config);
      await publishPendingNtfy(f.config);
      writeFileSync(join(f.root, 'asks.json'), JSON.stringify({ [oldKey]: { id, status: 'superseded' }, [middleKey]: { id, status: 'superseded', legacy_key: oldKey }, [currentKey]: { id, status: 'pending', legacy_key: oldKey } }));
      f.push(f.action());
      expect((await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] }))).accepted).toBe(1);
      expect(JSON.parse(readFileSync(join(f.root, 'asks.json'), 'utf8'))[currentKey].status).toBe('yes');
      expect(f.posts.at(-1)!.body).toMatchObject({ title: '正在执行｜Archon｜是否批准签收并续跑？', priority: 2, tags: ['white_circle'] });
      expect(String(f.posts.at(-1)!.body.message)).toContain('已收到你的『Yes』，正在执行（门禁 signoff）');
      const expires = askNtfy({ ...f.request('expires'), expires_at: new Date(2_000_000_001_000).toISOString(), callback: { kind: 'ask', key: oldKey } }, f.config); writeFileSync(join(f.root, 'asks.json'), JSON.stringify({ [middleKey]: { id: expires, status: 'superseded', legacy_key: oldKey }, [currentKey]: { id: expires, status: 'pending', legacy_key: oldKey } })); f.config.now = () => 2_000_000_002_000;
      await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] })); expect(JSON.parse(readFileSync(join(f.root, 'asks.json'), 'utf8'))[currentKey].status).toBe('expired');
    } finally {
      if (saved === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = saved;
    }
  });
  test('limits each tick to five new decisions without starving later decisions or limiting alerts', async () => {
    let now = Date.now(); const f = fixture(now); f.config.now = () => now;
    const decisions = [...Array(7)].map((_, i) => ({ id: `decision-${i}`, run: `run-${i}`, engine: '', node: '', pause: '', question: `Decision ${i}`, reason: 'reason', context: 'context', options: f.request('x').options.map(option => ({ ...option, consequence: option.consequence ?? option.label })) }));
    const inbox = async () => ({ decisions, unknown: [] });
    queueNtfyAlert('alert', 'unlimited', f.config); await syncDecisionChannel(f.config, inbox, undefined, 5); await publishPendingNtfy(f.config);
    expect(f.posts.map(post => post.body.topic)).toEqual([...Array(5).fill('sa-decisions'), 'sa-alerts']);
    expect(f.posts.slice(0, 5).map(post => post.body.title)).toEqual([...Array(5)].map((_, i) => `Decision ${i}`));
    await syncDecisionChannel(f.config, inbox, undefined, 5); now += 3_600_001; await publishPendingNtfy(f.config);
    expect(f.posts.filter(post => post.body.topic === 'sa-decisions')).toHaveLength(7);
  });
  test('withdraws stale decision callbacks before publishing while preserving live work', async () => {
    const f = fixture(Date.now()), decision = (id: string) => ({ id, run: id, engine: '', node: '', pause: '', question: `${id}：detail`, reason: 'reason', context: 'context', options: f.request('x').options.map(option => ({ ...option, consequence: option.consequence ?? option.label })) });
    const sent = askNtfy({ ...f.request('sent'), title: 'sent：detail', callback: { kind: 'decision' as const, id: 'sent' } }, f.config); await publishPendingNtfy(f.config); const staleAction = f.action(undefined, 1);
    const pending = askNtfy({ ...f.request('pending'), callback: { kind: 'decision' as const, id: 'pending' } }, f.config);
    await syncDecisionChannel(f.config, async () => ({ decisions: [decision('live')], unknown: [] }));
    expect(f.state().decisions).toMatchObject({ [sent]: { status: 'superseded' }, [pending]: { status: 'superseded' } });
    expect(f.posts.filter(post => post.body.topic === 'sa-decisions').map(post => post.body.title)).toEqual(['sent：detail', 'live：detail']);
    f.push(staleAction); await syncNtfy(() => undefined, f.config);
    expect(f.posts.at(-1)!.body).toMatchObject({ title: '未执行｜No｜sent', message: expect.stringContaining('由引擎在') });
  });
  test('held owner online answers route through the dedicated callback once', async () => {
    const f = fixture(), ref = 'a'.repeat(64), handled: string[] = [], who = caller(), request = { ...f.request(ref), originator: { identity: who, scope: { kind: 'repo' as const, id: f.root } }, callback: { kind: 'held' as const, ref } }, id = askNtfy(request, f.config);
    expect(id).toBe(ref); await publishPendingNtfy(f.config); const action = f.action(); f.push(action);
    expect((await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] }), undefined, 5, (group, ask, option) => { handled.push(`${group}:${ask}:${option}`); return ['r1:skip:owner_changed', 'r2:skip:not_held']; })).accepted).toBe(1);
    expect(handled).toEqual([`${ref}:${ref}:yes`]); f.push(action); await syncDecisionChannel(f.config, async () => ({ decisions: [], unknown: [] }), undefined, 5, () => { throw new Error('replayed'); });
    const receipt = f.posts.find(post => post.body.topic === 'sa-alerts'), message = String(receipt?.body.message); expect(String(receipt?.body.title)).toContain('未执行'); expect(message).toContain('r1:skip:owner_changed'); expect(message).toContain('r2:skip:not_held');
    expect(coord().inbox(who, true).find(message => message.source === ref)?.body).toContain('r1:skip:owner_changed');
    expect(f.state().decisions[ref]).toMatchObject({ status: 'answered' });
  });
  test('persists dedupe and rolling limits, emits one summary, and drains after the window', async () => {
    let now = 2_000_000_000_000; const f = fixture(now); f.config.now = () => now;
    for (let i = 0; i < 8; i++) askNtfy(f.request(`decision-${i}`), f.config);
    for (let i = 0; i < 12; i++) queueNtfyAlert(`alert-${i}`, `Alert ${i}`, f.config);
    await publishPendingNtfy(f.config); await publishPendingNtfy(f.config);
    expect(f.posts.filter(post => post.body.topic === 'sa-decisions')).toHaveLength(6);
    expect(f.posts.filter(post => post.body.topic === 'sa-alerts')).toHaveLength(10);
    expect(f.posts.filter(post => post.body.title === 'superagent 推送已限流')).toHaveLength(1);
    expect(f.posts.find(post => post.body.title === 'superagent 推送已限流')?.body).toMatchObject({ priority: 2, tags: ['white_circle'] });
    queueNtfyAlert('alert-0', 'duplicate', f.config); await publishPendingNtfy(f.config);
    now += 3_600_001; await publishPendingNtfy(f.config);
    expect(f.posts.filter(post => post.body.topic === 'sa-decisions')).toHaveLength(8);
    expect(f.posts.filter(post => post.body.topic === 'sa-alerts')).toHaveLength(13);
    expect(JSON.stringify(f.posts)).not.toContain('duplicate');
  });
  test('pause keeps work pending while status reports the gate counters', async () => {
    const f = fixture(), output: unknown[] = [];
    ntfyCli(['ntfy', 'pause'], f.config, value => output.push(value));
    askNtfy(f.request('paused'), f.config); queueNtfyAlert('paused-alert', 'pending', f.config);
    await publishPendingNtfy(f.config); expect(f.posts).toHaveLength(0);
    ntfyCli(['ntfy', 'status'], f.config, value => output.push(value));
    expect(output.at(-1)).toMatchObject({ paused: true, sent: 0 });
    ntfyCli(['ntfy', 'resume'], f.config, () => undefined); await publishPendingNtfy(f.config);
    expect(f.posts.map(post => post.body.topic)).toEqual(['sa-decisions', 'sa-alerts']);
  });
  test('pause records operator and time without replacing the original actor', async () => {
    const now = 2_000_000_000_000, f = fixture(now), output: unknown[] = [], marker = join(f.root, 'paused');
    const first = { client: 'codex', host: 'dev', pid: 7, pid_start: 'start-1' };
    f.config.actor = () => first; ntfyCli(['ntfy', 'pause'], f.config, value => output.push(value));
    const recorded = { at: new Date(now).toISOString(), by: first };
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(recorded); expect(output.at(-1)).toMatchObject({ paused: true, paused_at: recorded.at, paused_by: first });
    f.config.actor = () => ({ ...first, pid: 8 }); ntfyCli(['ntfy', 'pause'], f.config, () => undefined);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(recorded);
    ntfyCli(['ntfy', 'resume'], f.config, () => undefined); writeFileSync(marker, '');
    ntfyCli(['ntfy', 'status'], f.config, value => output.push(value));
    expect(output.at(-1)).toMatchObject({ paused: true, paused_at: expect.any(String), paused_by: null }); askNtfy(f.request('paused-legacy'), f.config); await publishPendingNtfy(f.config); expect(f.posts).toHaveLength(0);
  });
  test('keeps secrets out of state and routes answers through the durable decision store', async () => {
    const f = fixture(); askNtfy(f.request('secret'), f.config); await publishPendingNtfy(f.config);
    const key = readFileSync(f.config.answerKey, 'utf8').trim(), visible = readFileSync(f.config.statePath, 'utf8') + JSON.stringify(f.posts[0].body) + process.argv.join(' ');
    expect(visible).not.toContain(key); expect(visible).not.toContain('publisher-secret');
    const leaking = (async (...args: Parameters<typeof fetch>) => { throw new Error(JSON.stringify(args[1])); }) as unknown as typeof fetch;
    askNtfy(f.request('leak'), f.config); await expect(publishPendingNtfy({ ...f.config, fetch: leaking })).rejects.toThrow('ntfy publish unavailable');
    chmodSync(f.config.publisherToken, 0o644); await expect(publishPendingNtfy(f.config)).rejects.toThrow('publisher token file must be mode 600');
    const id = 'd'.repeat(64), receipt: DecisionReceipt = { id, run: '', engine: '', node: '', pause: '', decision: 'yes', at: '', stage: 'accepted' };
    let observed = '';
    await answerNtfyDecision(id, 'yes', new DecisionStore(join(f.root, 'decisions')), async (_store, value) => { observed = value; return receipt; });
    expect(observed).toBe(id);
  });
  test('disables default ntfy network access outside the production home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ntfy-isolation-')); roots.push(root);
    const savedHome = process.env.HOME, savedSa = process.env.SUPERAGENT_HOME, savedFetch = globalThis.fetch;
    process.env.HOME = root; process.env.SUPERAGENT_HOME = join(root, 'scratch');
    let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error('network'); }) as unknown as typeof fetch;
    try {
      await publishPendingNtfy(); expect(await syncNtfy(() => undefined)).toEqual({ accepted: 0, ignored: 0, failed: 0 }); expect(calls).toBe(0);
      await publishPendingNtfy({ fetch: globalThis.fetch }); expect(await syncNtfy(() => undefined, { fetch: globalThis.fetch })).toEqual({ accepted: 0, ignored: 0, failed: 0 });
    } finally {
      globalThis.fetch = savedFetch;
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedSa === undefined) delete process.env.SUPERAGENT_HOME; else process.env.SUPERAGENT_HOME = savedSa;
    }
  });
});

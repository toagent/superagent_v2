import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import * as archonModule from '../src/archon';
import * as cliModule from '../src/cli';
import * as sqlHost from '../../packages/core/src/workflows/sql-host';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import {
  DeviceStore,
  digest,
  isOperatorDevice,
  operatorGrant,
  type Grant,
} from '../src/web/device-store';
import { checkOrigin, createDecisionAdapter } from '../src/web/decision-adapter';
import { deliver, publicIPv4, validateSubscription, createPush } from '../src/web/push';
import {
  authorizeDecision,
  answerDecision,
  coordinationDecisions,
  decisionState,
  decisionsFromSnapshot,
  currentDecisions,
} from '../src/decisions';
import { startCanary } from '../scripts/mobile-canary';
import { getRun } from '../src/archon';
import { loadLedger, report } from '../src/cli';
import { createLoader } from '../src/board/data';
import { cockpit } from '../src/board/cockpit';
import { coord, runScope, type Identity, type Scope } from '../src/coord';
const saved = { ...process.env },
  origin = 'https://decision.example.test';
const grant: Grant = {
  run: 'not-a-run',
  engine: 'not-an-engine',
  controller: { client: 'shell', pid: process.pid, generation: 1 },
};
function pair(store: DeviceStore, g = grant) {
  const page = store.pairing(g);
  const code = /<p>([a-f0-9]{64})<\/p>/.exec(readFileSync(page, 'utf8'))![1];
  const session = store.pair(code);
  return { code, session, device: store.authenticate(session) };
}
function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function coordDecisionFixture() {
  const sa = tmp();
  process.env.SUPERAGENT_HOME = sa;
  process.env.ARCHON_HOME = join(sa, 'archon');
  const c = coord(),
    scope: Scope = { kind: 'repo', id: 'mobile-coord-fixture' },
    owner: Identity = {
      client: 'codex',
      session_id: 'owner',
      host: 'test',
      pid: 1001,
      pid_start: 'owner-start',
    },
    sender: Identity = {
      client: 'claude',
      session_id: 'sender',
      host: 'test',
      pid: 1002,
      pid_start: 'sender-start',
    };
  c.claim(scope, owner);
  const handoff = c.handoff(scope, sender, {
    kind: 'takeover-request',
    title: '需要接管',
    body: 'fixture',
    evidence: [],
    severity: 'urgent',
  });
  const presence = spyOn(c.d, 'presence').mockReturnValue({ state: 'offline' });
  mkdirSync(join(sa, 'console'), { recursive: true });
  writeFileSync(join(sa, 'console/decision-origin'), origin);
  writeFileSync(join(sa, 'gc-tick'), '');
  cliModule.superviseTick();
  return { sa, c, scope, owner, sender, message: String(handoff.id), presence };
}
beforeAll(() => {
  process.env.HOME = tmp();
  process.env.SUPERAGENT_ROLE = '';
  process.env.SA_JOB_ID = '';
  process.env.DATABASE_URL = '';
});
afterAll(async () => {
  const { closeDatabase } = await import('../../packages/core/src/db/connection');
  await closeDatabase();
  for (const k of [
    'HOME',
    'SUPERAGENT_HOME',
    'ARCHON_HOME',
    'SUPERAGENT_ROLE',
    'SA_JOB_ID',
    'DATABASE_URL',
  ]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
test('pairing is one-use, short-lived, rate-bounded; session, VAPID, receipt and revocation survive reload', () => {
  const store = new DeviceStore(join(tmp(), 'mobile')),
    p = pair(store);
  expect(() => store.pair(p.code)).toThrow();
  const reload = new DeviceStore(store.root);
  expect(reload.authenticate(p.session).id).toBe(p.device.id);
  expect(statSync(store.root).mode & 0o777).toBe(0o700);
  expect(statSync(join(store.root, 'state.json')).mode & 0o777).toBe(0o600);
  expect(createPush(reload, origin).publicKey).toBe(createPush(store, origin).publicKey);
  const operator = pair(store, operatorGrant());
  expect(operator.device.grant.scope).toBe('managed-approvals');
  expect(isOperatorDevice(operator.device)).toBe(true);
  store.transaction(s => {
    s.pair = { hash: digest('expired'), expires: Date.now() - 1, attempts: 0, grant };
  });
  expect(() => reload.pair('expired')).toThrow();
  store.pairing(grant);
  for (let i = 0; i < 6; i++) expect(() => store.pair('wrong')).toThrow();
  expect(store.transaction(s => s.pair!.attempts)).toBe(6);
  const held = store.deviceLock(p.device.id);
  expect(() => reload.revoke(p.device.id)).toThrow();
  held.release();
  reload.revoke(p.device.id);
  expect(() => store.authenticate(p.session)).toThrow();
});
test('legacy authorization migration preserves eligible device state without reviving invalid devices', () => {
  const root = join(tmp(), 'mobile'),
    store = new DeviceStore(root),
    now = Date.now(),
    subscription = {
      endpoint: 'https://web.push.apple.com/Qlegacy',
      keys: {
        p256dh: Buffer.alloc(65).toString('base64url'),
        auth: Buffer.alloc(16).toString('base64url'),
      },
    },
    device = (id: string, expires: number, revoked = false) => ({
      id: digest(id),
      session: digest(id + '-session'),
      csrf: id + '-csrf',
      expires,
      grant,
      lastRead: id + '-read',
      revoked,
      subscription,
    });
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      devices: [
        device('active', now + 10000),
        device('expired', now - 1),
        device('revoked', now + 10000, true),
      ],
      receipts: [{ id: 'receipt', device: digest('active') }],
      notices: {},
    })
  );

  const migrated = store.transaction(s => s);
  expect(migrated.deviceAuthorizationVersion).toBe(1);
  expect(migrated.devices[0]).toMatchObject({
    id: digest('active'),
    session: digest('active-session'),
    csrf: 'active-csrf',
    grant,
    lastRead: 'active-read',
    subscription,
    authorized: true,
  });
  expect(migrated.devices[0].expires).toBe(now + 10000);
  expect(migrated.devices.slice(1).every(d => !d.authorized)).toBe(true);
  expect(migrated.receipts).toHaveLength(1);
  expect(store.authenticate('active-session').id).toBe(digest('active'));
  expect(() => store.authenticate('expired-session')).toThrow();
  expect(() => store.authenticate('revoked-session')).toThrow();
});
test('legacy device upgrades in place and revoked device cannot be revived', () => {
  const store = new DeviceStore(join(tmp(), 'mobile')),
    active = pair(store),
    revoked = pair(store),
    subscription = { endpoint: 'x', keys: { p256dh: 'k', auth: 'a' } };
  store.transaction(s => {
    const d = s.devices.find(d => d.id === active.device.id)!;
    d.subscription = subscription;
    d.lastRead = 'cursor';
  });
  expect(store.upgrade(active.device.id)).toBe(true);
  expect(store.upgrade(active.device.id)).toBe(false);
  expect(store.authenticate(active.session)).toMatchObject({
    id: active.device.id,
    csrf: active.device.csrf,
    lastRead: 'cursor',
    subscription,
    grant: operatorGrant(),
  });
  store.revoke(revoked.device.id);
  expect(() => store.upgrade(revoked.device.id)).toThrow('设备已撤销或未授权，请重新配对');
  expect(store.transaction(s => s.devices.find(d => d.id === revoked.device.id)!.revoked)).toBe(
    true
  );
});
test('device list exposes only non-secret fields and defaults legacy scope', () => {
  const store = new DeviceStore(join(tmp(), 'mobile')),
    active = pair(store);
  const json = JSON.stringify(store.listDevices());
  expect(store.listDevices()[0]).toEqual({
    id: active.device.id,
    scope: 'run',
    run: grant.run,
    revoked: false,
    authorized: true,
    has_subscription: false,
  });
  for (const secret of ['session', 'csrf', 'subscription', 'vapid', 'pair'])
    expect(json).not.toContain(`"${secret}"`);
});
test('private origin adapter isolates console, pairs once, requires CSRF and bounds streamed requests', async () => {
  const store = new DeviceStore(join(tmp(), 'mobile'));
  const page = store.pairing(grant),
    code = /<p>([a-f0-9]{64})<\/p>/.exec(readFileSync(page, 'utf8'))![1];
  let adapter = await createDecisionAdapter(origin, store);
  const req = (path: string, data?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        host: 'decision.example.test',
        ...(data ? { origin, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  expect((await adapter.fetch(req('/sa/decisions'))).status).toBe(401);
  expect((await adapter.fetch(req('/', undefined, { host: 'evil.test' }))).status).toBe(403);
  expect(
    (await adapter.fetch(req('/sa/device/pair', { code }, { origin: 'https://evil.test' }))).status
  ).toBe(403);
  const paired = await adapter.fetch(req('/sa/device/pair', { code }));
  expect(paired.status).toBe(200);
  expect(paired.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Strict');
  expect(paired.headers.get('set-cookie')).toContain('Max-Age=34560000');
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  adapter = await createDecisionAdapter(origin, new DeviceStore(store.root));
  const device = store.authenticate(cookie.split('=')[1]);
  const renewed = await adapter.fetch(req('/sa/decisions', undefined, { cookie }));
  expect(renewed.status).toBe(200);
  expect(renewed.headers.get('set-cookie')).toBe(
    cookie + '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000'
  );
  for (const path of ['/console', '/sa/data', '/api/workflows/runs', '/sa/memory'])
    expect((await adapter.fetch(req(path, undefined, { cookie }))).status).toBe(404);
  expect((await adapter.fetch(req('/sa/device/revoke', {}, { cookie }))).status).toBe(403);
  expect((await adapter.fetch(req('/sa/device/pair', { code }))).status).toBe(403);
  expect(
    (
      await adapter.fetch(
        req(
          '/sa/device/subscription',
          { endpoint: 'x'.repeat(5000) },
          { cookie, 'x-csrf-token': device.csrf }
        )
      )
    ).status
  ).toBe(413);
  const revoked = await adapter.fetch(
    req('/sa/device/revoke', {}, { cookie, 'x-csrf-token': device.csrf })
  );
  expect(revoked.status).toBe(200);
  expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await adapter.fetch(req('/sa/decisions', undefined, { cookie }))).status).toBe(401);
  expect(() => checkOrigin('http://decision.example.test')).toThrow();
});
test('device revocation requires final confirmation and cannot submit twice', async () => {
  const html = readFileSync(join(import.meta.dir, '../src/web/decision.html'), 'utf8');
  expect(html).toContain('撤销后，本设备的通知和访问权限会立即失效');
  expect(html).toContain('必须在 Mac 上生成新的配对码并重新配对');
  expect(html).toMatch(/id="revoke-cancel" autofocus/);

  const elements = Object.fromEntries(
    [
      'setup',
      'inbox-wrap',
      'inbox',
      'item',
      'connection',
      'state',
      'receipt',
      'events',
      'options',
      'push',
      'pair',
      'code',
      'notify',
      'refresh',
      'revoke',
      'revoke-dialog',
      'revoke-cancel',
      'revoke-confirm',
    ].map(id => [
      id,
      {
        hidden: false,
        disabled: false,
        open: false,
        children: [],
        replaceChildren() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      },
    ])
  ) as Record<string, any>;
  const calls: string[] = [];
  let releaseRevoke!: () => void;
  const revokePending = new Promise<void>(resolve => (releaseRevoke = resolve));
  const fetch = async (path: string) => {
    calls.push(path);
    if (path === '/sa/device/revoke') await revokePending;
    return new Response(
      JSON.stringify({
        csrf: 'csrf',
        status: 'unknown',
        note: '',
        events: [],
        subscribed: false,
        notification: { accepted: 0, failed: 0, unknown: 0 },
      })
    );
  };
  const source = readFileSync(join(import.meta.dir, '../src/web/decision.js'), 'utf8');
  Function(
    'document',
    'location',
    'fetch',
    'setInterval',
    source
  )(
    { getElementById: (id: string) => elements[id], visibilityState: 'visible' },
    { href: origin },
    fetch,
    () => 0
  );
  await Bun.sleep(0);
  calls.length = 0;

  elements.revoke.onclick();
  expect(elements['revoke-dialog'].open).toBe(true);
  expect(calls).toEqual([]);
  elements['revoke-cancel'].onclick();
  expect(elements['revoke-dialog'].open).toBe(false);
  expect(calls).toEqual([]);

  elements.revoke.onclick();
  const first = elements['revoke-confirm'].onclick();
  const duplicate = elements['revoke-confirm'].onclick();
  expect(calls).toEqual(['/sa/device/revoke']);
  expect(elements['revoke-confirm'].disabled).toBe(true);
  expect(elements['revoke-cancel'].disabled).toBe(false);
  expect(elements.setup.hidden).toBe(true);
  elements['revoke-cancel'].onclick();
  expect(elements['revoke-dialog'].open).toBe(false);
  releaseRevoke();
  await Promise.all([first, duplicate]);
  expect(elements.setup.hidden).toBe(false);
  expect(elements['revoke-confirm'].disabled).toBe(false);
  expect(elements['revoke-cancel'].disabled).toBe(false);
  expect(elements['revoke-dialog'].open).toBe(false);
  elements.revoke.onclick();
  expect(elements['revoke-dialog'].open).toBe(true);
  elements['revoke-cancel'].onclick();
  expect(elements['revoke-dialog'].open).toBe(false);
});
// prettier-ignore
test('decision click keeps the POST receipt across stale refresh and reports POST failure', async () => {
  const ids = ['setup', 'inbox-wrap', 'inbox', 'item', 'connection', 'state', 'receipt', 'options',
    'question', 'reason', 'context', 'disabled', 'push', 'pair', 'code', 'notify', 'refresh', 'revoke',
    'revoke-dialog', 'revoke-cancel', 'revoke-confirm'];
  const element = () => ({ hidden: false, disabled: false, children: [] as any[], textContent: '',
    replaceChildren(...children: any[]) { this.children = children; }, append(...children: any[]) { this.children.push(...children); },
    setAttribute() {}, showModal() {}, close() {} });
  const elements = Object.fromEntries(ids.map(id => [id, element()])) as Record<string, any>;
  const decision = { id: 'd1', question: '继续？', reason: '测试', context: '上下文', options: [{ id: 'yes', label: '是', consequence: '继续' }] };
  const view = { csrf: 'csrf', status: 'paused', note: '', decisions: [decision], subscribed: false,
    notification: { accepted: 0, failed: 0, unknown: 0 } };
  const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status });
  let stateCalls = 0, answerCalls = 0, releaseStale!: (response: Response) => void, interval!: () => void;
  const stale = new Promise<Response>(resolve => (releaseStale = resolve));
  const fetch = async (path: string) => {
    if (path.endsWith('/answer')) return ++answerCalls === 1 ? json({ receipt: { stage: 'intent' } }) : json({ error: '提交失败' }, 500);
    if (path.endsWith('/state')) return ++stateCalls === 1 ? json({ ...view, decision }) : stale;
    return stateCalls < 2 ? json(view) : new Promise<Response>(() => {});
  };
  const source = readFileSync(join(import.meta.dir, '../src/web/decision.js'), 'utf8');
  Function('document', 'location', 'fetch', 'setInterval', 'confirm', source)(
    { getElementById: (id: string) => elements[id], createElement: element, visibilityState: 'visible' },
    { href: origin + '/?decision=d1' }, fetch, (callback: () => void) => ((interval = callback), 0), () => true);
  await Bun.sleep(0);
  const option = elements.options.children[0];
  interval();
  await Bun.sleep(0);
  const clicked = option.onclick();
  expect(elements.receipt.textContent).toBe('正在提交…');
  await clicked;
  expect(elements.receipt.textContent).toBe('已保存选择，等待引擎确认');
  releaseStale(json({ ...view, decision }));
  await Bun.sleep(0);
  expect(elements.receipt.textContent).toBe('已保存选择，等待引擎确认');
  expect(option.disabled).toBe(true);
  await option.onclick();
  expect(elements.connection.textContent).toBe('提交失败；提交结果需重新读取，禁止自动重发');
});
test('operator inbox sorts multiple runs, ignores archived runs and preserves real unknowns', () => {
  const decision = (run: string) => ({
    id: digest(run),
    run,
    engine: 'engine-' + run,
    node: 'gate',
    pause: 'pause-' + run,
    question: run,
    reason: 'approval',
    context: run,
    options: [{ id: 'approve', label: 'Approve', consequence: 'Continue' }],
  });
  const row = (run_id: string, extra: Record<string, unknown> = {}) =>
    ({
      run_id,
      state: 'paused',
      stale: false,
      humanDecision: decision(run_id),
      ...extra,
    }) as unknown as import('../src/board/data').BoardRow;
  const inbox = decisionsFromSnapshot({
    summary: {},
    at: new Date().toISOString(),
    rows: [
      row('run-b'),
      row('run-a'),
      row('archived', { state: 'unreadable', humanDecision: undefined, missing: true }),
      row('unreadable', { state: 'unreadable', humanDecision: undefined }),
      row('stale', { stale: true }),
    ],
  });
  expect(inbox.decisions.map(d => d.run)).toEqual(['run-a', 'run-b']);
  expect(inbox.unknown.sort()).toEqual(['stale', 'unreadable']);
});

test('operator push shares one inbox and notifies each run once', async () => {
  const store = new DeviceStore(join(tmp(), 'mobile')),
    operator = pair(store, operatorGrant());
  store.transaction(s => {
    s.devices.find(d => d.id === operator.device.id)!.subscription = {
      endpoint: 'https://web.push.apple.com/Qmulti',
      keys: {
        p256dh: Buffer.alloc(65).toString('base64url'),
        auth: Buffer.alloc(16).toString('base64url'),
      },
    };
  });
  let loads = 0,
    sends = 0;
  const decisions = ['run-b', 'run-a'].map(run => ({
    id: digest(run),
    run,
    engine: 'engine-' + run,
    node: 'gate',
    pause: 'pause-' + run,
    question: run,
    reason: 'approval',
    context: run,
    options: [{ id: 'approve', label: 'Approve', consequence: 'Continue' }],
  }));
  const push = createPush(
    store,
    origin,
    async () => {
      sends++;
    },
    async () => {
      loads++;
      return { decisions, unknown: [] };
    }
  );
  await push.tick();
  await push.tick();
  expect(loads).toBe(2);
  expect(sends).toBe(2);
  expect(store.transaction(s => Object.keys(s.notices))).toHaveLength(2);
});
test('operator saves COORD intent while supervise lock is held and next tick transfers ownership', async () => {
  const previous = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME],
    f = coordDecisionFixture();
  try {
    const store = new DeviceStore(),
      operator = pair(store, operatorGrant()),
      runDevice = pair(store),
      decision = coordinationDecisions(f.c)[0];
    expect(decision.question).toContain('是=交给发现者处理 否=继续等');
    expect((await decisionState(runDevice.device, undefined, store)).decisions).toEqual([]);
    const held = archonModule.lock(join(f.sa, 'supervise.lock'));
    if (!held.ok) throw new Error('failed to hold supervise lock');
    const receipt = await answerDecision(store, operator.device, decision.id, 'yes', async () => ({
      decisions: [decision],
      unknown: [],
    }));
    expect(receipt.stage).toBe('intent');
    expect(
      await decisionState(operator.device, decision.id, store, {
        decisions: [decision],
        unknown: [],
      })
    ).toMatchObject({ receipt: { stage: 'intent' }, status: 'paused' });
    held.release();
    const next = { ...decision, id: 'f'.repeat(64), node: 'next-coord' };
    expect(
      await decisionState(operator.device, undefined, store, { decisions: [next], unknown: [] })
    ).toMatchObject({ decision: next, receipt: undefined, status: 'paused' });
    const asks = JSON.parse(readFileSync(join(f.sa, 'asks.json'), 'utf8'));
    expect(Object.values(asks)[0]).toMatchObject({ status: 'pending' });
    cliModule.superviseTick();
    expect(
      Object.values(JSON.parse(readFileSync(join(f.sa, 'asks.json'), 'utf8')))[0]
    ).toMatchObject({ status: 'yes' });
    expect(store.transaction(s => s.receipts[0].stage)).toBe('accepted');
    expect(f.c.owner(f.scope).owner).toMatchObject(f.sender);
  } finally {
    f.presence.mockRestore();
    restoreEnv('SUPERAGENT_HOME', previous[0]);
    restoreEnv('ARCHON_HOME', previous[1]);
  }
}, 30000);
test('tick rejects stale COORD intent without changing ask', async () => {
  const previous = [process.env.SUPERAGENT_HOME, process.env.ARCHON_HOME],
    f = coordDecisionFixture();
  try {
    const store = new DeviceStore(),
      operator = pair(store, operatorGrant()),
      decision = coordinationDecisions(f.c)[0],
      replacement = { ...f.owner, session_id: 'replacement', pid: 1003, pid_start: 'new-start' };
    expect(
      (
        await answerDecision(store, operator.device, decision.id, 'yes', async () => ({
          decisions: [decision],
          unknown: [],
        }))
      ).stage
    ).toBe('intent');
    const askKey = Object.keys(JSON.parse(readFileSync(join(f.sa, 'asks.json'), 'utf8')))[0];
    f.c.claim(f.scope, replacement, true, 'generation changed');
    cliModule.superviseTick();
    expect(JSON.parse(readFileSync(join(f.sa, 'asks.json'), 'utf8'))[askKey]).toEqual({
      status: 'pending',
    });
    expect(store.transaction(s => s.receipts[0].stage)).toBe('rejected');
    expect(
      await decisionState(operator.device, decision.id, store, {
        decisions: coordinationDecisions(f.c),
        unknown: [],
      })
    ).toMatchObject({ receipt: { stage: 'rejected' }, status: 'completed' });
  } finally {
    f.presence.mockRestore();
    restoreEnv('SUPERAGENT_HOME', previous[0]);
    restoreEnv('ARCHON_HOME', previous[1]);
  }
}, 15000);
test('Apple-only push rejects internal, redirect/credential-shaped targets and invalid keys', () => {
  for (const endpoint of [
    'http://web.push.apple.com/Qx',
    'https://127.0.0.1/Qx',
    'https://web.push.apple.com.evil/Qx',
    'https://user@web.push.apple.com/Qx',
    'https://web.push.apple.com:8443/Qx',
    'https://web.push.apple.com/Qx#fragment',
  ])
    expect(() => validateSubscription({ endpoint })).toThrow();
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '224.0.0.1',
    '::1',
  ])
    expect(publicIPv4(ip)).toBe(false);
  expect(publicIPv4('17.1.2.3')).toBe(true);
  const keys = {
    p256dh: Buffer.alloc(65).toString('base64url'),
    auth: Buffer.alloc(16).toString('base64url'),
  };
  expect(validateSubscription({ endpoint: 'https://web.push.apple.com/Qx', keys }).keys).toEqual(
    keys
  );
});
test('real CLI canary: production owner, three choices, shared projections, CAS, restart and terminal receipt', async () => {
  const canary = await startCanary(tmp());
  const store = new DeviceStore(),
    d = authorizeDecision(canary.runId);
  expect(d.options.map(o => o.id)).toEqual(['approve', 'detail', 'stop']);
  expect(currentDecisions().decisions.map(d => d.id)).toContain(d.id);
  expect(
    (report().human_decisions as ReturnType<typeof currentDecisions>).decisions.map(d => d.id)
  ).toContain(d.id);
  const snap = await createLoader()(100);
  expect(cockpit(snap).needs.some(n => n.question.includes(d.question))).toBe(true);
  const p = pair(store, { run: d.run, engine: d.engine, controller: d.controller! });
  const operator = pair(store, operatorGrant());
  store.transaction(s =>
    s.receipts.push({
      id: 'e'.repeat(64),
      device: operator.device.id,
      run: 'coord:completed',
      engine: 'coord',
      node: 'completed',
      pause: '1',
      decision: 'yes',
      at: new Date().toISOString(),
      stage: 'accepted',
    })
  );
  const defaultState = await decisionState(operator.device, undefined, store);
  expect(defaultState.decisions.map(x => x.id)).toContain(d.id);
  expect(defaultState.decision?.id).toBe(d.id);
  store.transaction(s => s.receipts.pop());
  const stale = {
    ...p.device,
    grant: { ...p.device.grant, controller: { ...p.device.grant.controller, generation: 999 } },
  };
  await expect(answerDecision(store, stale, d.id, 'approve')).rejects.toThrow();
  await expect(answerDecision(store, p.device, '0'.repeat(64), 'approve')).rejects.toThrow();
  await expect(answerDecision(store, p.device, d.id, 'shell')).rejects.toThrow();
  expect(getRun(d.engine, canary.repo).status).toBe('paused');
  const subscription = {
    endpoint: 'https://web.push.apple.com/Qcanary',
    keys: {
      p256dh: Buffer.alloc(65).toString('base64url'),
      auth: Buffer.alloc(16).toString('base64url'),
    },
  };
  store.transaction(s => {
    s.devices.find(x => x.id === operator.device.id)!.subscription = subscription;
  });
  let deliveries = 0;
  const send = async () => {
    deliveries++;
  };
  expect(await createPush(store, origin, send).tick()).toMatchObject({
    state: 'observed',
    accepted: 1,
    failed: 0,
  });
  await createPush(new DeviceStore(store.root), origin, send).tick();
  expect(deliveries).toBe(1);
  const adapter = await createDecisionAdapter(origin, store);
  const inbox = await adapter.fetch(
    new Request(origin + '/sa/decisions', {
      headers: {
        host: 'decision.example.test',
        cookie: '__Host-sa_device=' + operator.session,
      },
    })
  );
  const inboxView = (await inbox.json()) as { decisions: { id: string }[] };
  expect(inboxView.decisions.map(x => x.id)).toContain(d.id);
  const answered = await adapter.fetch(
    new Request(origin + '/sa/decisions/' + d.id + '/answer', {
      method: 'POST',
      headers: {
        host: 'decision.example.test',
        origin,
        'content-type': 'application/json',
        cookie: '__Host-sa_device=' + operator.session,
        'x-csrf-token': operator.device.csrf,
      },
      body: JSON.stringify({ decision: 'detail' }),
    })
  );
  expect(answered.status).toBe(202);
  expect(await answered.json()).toMatchObject({ receipt: { stage: 'resuming' } });
  await expect(answerDecision(store, operator.device, d.id, 'detail')).rejects.toThrow();
  for (const end = Date.now() + 45000; Date.now() < end; ) {
    if (getRun(d.engine, canary.repo).status === 'completed') break;
    await Bun.sleep(250);
  }
  const reload = new DeviceStore(store.root),
    state = await decisionState(reload.authenticate(operator.session), d.id, reload);
  expect(state.status).toBe('completed');
  await createPush(new DeviceStore(store.root), origin, send).tick();
  await createPush(new DeviceStore(store.root), origin, send).tick();
  expect(deliveries).toBe(2);
  const key = store.transaction(s => Object.keys(s.notices).find(k => k.endsWith(':completed'))!);
  store.transaction(s => {
    s.notices[key] = { attempts: 0, next: 0, status: 'failed' };
  });
  let failures = 0;
  for (let i = 0; i < 4; i++) {
    store.transaction(s => {
      s.notices[key]!.next = 0;
    });
    await createPush(new DeviceStore(store.root), origin, async () => {
      failures++;
      throw new Error('offline');
    }).tick();
  }
  expect(failures).toBe(3);
  expect(await createPush(new DeviceStore(store.root), origin, send).tick()).toMatchObject({
    state: 'failed',
    failed: 1,
    exhausted: 1,
  });
  expect(store.transaction(s => s.notices[key]!.status)).toBe('failed');
  expect(state.receipt!.stage).toBe('resuming');
  expect(state.events.some(e => e.type === 'workflow_completed')).toBe(true);
  const run = getRun(d.engine, canary.repo);
  expect(readFileSync(join(run.working_path!, 'canary-result.txt'), 'utf8').trim()).toBe('detail');
  expect(loadLedger(d.run).intervention_events!.at(-1)!.origin).toBe('operator');
  expect(authorizeDecision.bind(null, d.run)).toThrow();
  expect(coord().owner(runScope(loadLedger(d.run))).generation).toBe(d.controller!.generation);
}, 120000);

test('R1-2 default deliver executes web-push encryption, pinned DNS, HTTP failure and timeout handling', async () => {
  const ecdh = createECDH('prime256v1');
  const target = {
    endpoint: 'https://web.push.apple.com/Qfixture',
    keys: {
      p256dh: ecdh.generateKeys().toString('base64url'),
      auth: Buffer.alloc(16, 1).toString('base64url'),
    },
  };
  const vapid = webpush.generateVAPIDKeys();
  let requests = 0,
    mode = 201;
  const agents: https.Agent[] = [];
  const request = spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
    requests++;
    const options = args[0] as https.RequestOptions;
    const respond = args[1] as (
      response: EventEmitter & { statusCode: number; headers: object }
    ) => void;
    expect(options.hostname).toBe('web.push.apple.com');
    expect(options.timeout).toBe(10000);
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({ TTL: 86400, 'Content-Encoding': 'aes128gcm' });
    const agent = options.agent as https.Agent;
    agents.push(agent);
    expect(agent.options.rejectUnauthorized).not.toBe(false);
    agent.options.lookup!('web.push.apple.com', {}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('17.1.2.3');
      expect(family).toBe(4);
    });
    const req = Object.assign(new EventEmitter(), {
      write: (body: Buffer) => {
        expect(body.length).toBeGreaterThan(0);
      },
      destroy: (error: Error) => {
        req.emit('error', error);
      },
      end: () =>
        queueMicrotask(() => {
          if (mode === 0) {
            req.emit('timeout');
            return;
          }
          const response = Object.assign(new EventEmitter(), {
            statusCode: mode,
            headers: { location: 'https://127.0.0.1/' },
          });
          respond(response);
          response.emit('end');
        }),
    });
    return req as unknown as ReturnType<typeof https.request>;
  });
  const destroy = spyOn(https.Agent.prototype, 'destroy');
  try {
    for (const addresses of [[], ['127.0.0.1'], ['17.1.2.3', '10.0.0.1']])
      await expect(
        deliver(target, 'fixture', vapid, origin, async () => addresses)
      ).rejects.toThrow();
    await expect(
      deliver(target, 'fixture', vapid, origin, async () => {
        throw Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' });
      })
    ).rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect(requests).toBe(0);
    const resolve = async (host: string) => {
      expect(host).toBe('web.push.apple.com');
      return ['17.1.2.3'];
    };
    await deliver(target, 'fixture', vapid, origin, resolve);
    for (mode of [302, 410, 500])
      await expect(deliver(target, 'fixture', vapid, origin, resolve)).rejects.toMatchObject({
        statusCode: mode,
      });
    mode = 0;
    await expect(deliver(target, 'fixture', vapid, origin, resolve)).rejects.toThrow(
      'Socket timeout'
    );
    expect(requests).toBe(5); // Redirects are rejected, never followed.
    expect(destroy).toHaveBeenCalledTimes(5);
    expect(new Set(agents).size).toBe(5);
  } finally {
    request.mockRestore();
    destroy.mockRestore();
  }
});

test('R1-4 health distinguishes absent pairing and subscription without exposing device data', async () => {
  const store = new DeviceStore(join(tmp(), 'mobile'));
  expect(await createPush(store, origin).tick()).toMatchObject({
    state: 'unpaired',
    paired: 0,
    subscribed: 0,
  });
  pair(store);
  const health = await createPush(store, origin).tick();
  expect(health).toMatchObject({ state: 'unsubscribed', paired: 1, subscribed: 0, accepted: 0 });
  expect(JSON.stringify(health)).not.toContain('session');
});

test('R1-3 answer failures preserve stage and machine diagnostics, reject HTTP and never replay', async () => {
  const { closeDatabase } = await import('../../packages/core/src/db/connection');
  for (const phase of ['respond', 'ledger', 'resume'] as const) {
    await closeDatabase();
    const canary = await startCanary(tmp());
    const store = new DeviceStore(),
      d = authorizeDecision(canary.runId);
    const p = pair(store, { run: d.run, engine: d.engine, controller: d.controller! });
    const error = Object.assign(new Error('synthetic private body'), { code: 'EIO' });
    const operations = sqlHost.createSqlWorkflowOperations();
    const archonJson = archonModule.archonJson;
    const spy =
      phase === 'respond'
        ? spyOn(sqlHost, 'createSqlWorkflowOperations').mockReturnValue({
            ...operations,
            respondToWorkflow: async () => {
              throw error;
            },
          })
        : phase === 'ledger'
          ? spyOn(cliModule, 'updateLedger').mockImplementation(() => {
              throw error;
            })
          : spyOn(archonModule, 'archonJson').mockImplementation((args, cwd) =>
              args[1] === 'resume' ? { ok: false } : archonJson(args, cwd)
            );
    try {
      const adapter = await createDecisionAdapter(origin, store);
      const response = await adapter.fetch(
        new Request(origin + '/sa/decisions/' + d.id + '/answer', {
          method: 'POST',
          headers: {
            host: 'decision.example.test',
            origin,
            'content-type': 'application/json',
            cookie: '__Host-sa_device=' + p.session,
            'x-csrf-token': p.device.csrf,
          },
          body: JSON.stringify({ decision: 'detail' }),
        })
      );
      expect(response.status).toBe(503);
      const receipt = new DeviceStore(store.root).transaction(s => s.receipts[0]);
      expect(receipt.stage).toBe(phase === 'respond' ? 'unknown' : 'accepted');
      expect(receipt.error).toMatchObject({ phase, name: 'Error' });
      if (phase === 'resume') expect(receipt.error!.message).toContain('续跑尚未确认');
      else expect(receipt.error!.code).toBe('EIO');
      expect(JSON.stringify(receipt)).not.toContain('synthetic private body');
      await expect(answerDecision(store, p.device, d.id, 'detail')).rejects.toThrow('已有答复');
    } finally {
      spy.mockRestore();
      await closeDatabase();
    }
  }
}, 120000);

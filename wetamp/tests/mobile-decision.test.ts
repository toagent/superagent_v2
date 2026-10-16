import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import { DeviceStore, digest, type Grant } from '../src/web/device-store';
import { checkOrigin, createDecisionAdapter } from '../src/web/decision-adapter';
import { publicIPv4, validateSubscription, createPush } from '../src/web/push';
import {
  authorizeDecision,
  answerDecision,
  decisionState,
  currentDecisions,
} from '../src/decisions';
import { startCanary } from '../scripts/mobile-canary';
import { getRun } from '../src/archon';
import { loadLedger, report } from '../src/cli';
import { createLoader } from '../src/board/data';
import { cockpit } from '../src/board/cockpit';
import { coord, runScope } from '../src/coord';
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
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  adapter = await createDecisionAdapter(origin, new DeviceStore(store.root));
  const device = store.authenticate(cookie.split('=')[1]);
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
  expect(
    (await adapter.fetch(req('/sa/device/revoke', {}, { cookie, 'x-csrf-token': device.csrf })))
      .status
  ).toBe(200);
  expect((await adapter.fetch(req('/sa/decisions', undefined, { cookie }))).status).toBe(401);
  expect(() => checkOrigin('http://decision.example.test')).toThrow();
});
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
    s.devices.find(x => x.id === p.device.id)!.subscription = subscription;
  });
  let deliveries = 0;
  const send = async () => {
    deliveries++;
  };
  await createPush(store, origin, send).tick();
  await createPush(new DeviceStore(store.root), origin, send).tick();
  expect(deliveries).toBe(1);
  const adapter = await createDecisionAdapter(origin, store);
  const answered = await adapter.fetch(
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
  expect(answered.status).toBe(202);
  expect(await answered.json()).toMatchObject({ receipt: { stage: 'resuming' } });
  await expect(answerDecision(store, p.device, d.id, 'detail')).rejects.toThrow();
  for (const end = Date.now() + 45000; Date.now() < end; ) {
    if (getRun(d.engine, canary.repo).status === 'completed') break;
    await Bun.sleep(250);
  }
  const reload = new DeviceStore(store.root),
    state = await decisionState(reload.authenticate(p.session), d.id, reload);
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
  expect(store.transaction(s => s.notices[key]!.status)).toBe('failed');
  expect(state.receipt!.stage).toBe('resuming');
  expect(state.events.some(e => e.type === 'workflow_completed')).toBe(true);
  const run = getRun(d.engine, canary.repo);
  expect(readFileSync(join(run.working_path!, 'canary-result.txt'), 'utf8').trim()).toBe('detail');
  expect(loadLedger(d.run).intervention_events!.at(-1)!.origin).toBe('operator');
  expect(authorizeDecision.bind(null, d.run)).toThrow();
  expect(coord().owner(runScope(loadLedger(d.run))).generation).toBe(d.controller!.generation);
}, 120000);

import webpush from 'web-push';
import { resolve4 } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'node:https';
import { DeviceStore, requireThat } from './device-store';
import { decisionState } from '../decisions';

export function validateSubscription(value: unknown): webpush.PushSubscription {
  requireThat(value && typeof value === 'object');
  const s = value as Record<string, unknown>;
  requireThat(typeof s.endpoint === 'string' && s.endpoint.length < 2048);
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    requireThat(false);
  }
  requireThat(
    url.protocol === 'https:' &&
      url.hostname === 'web.push.apple.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.pathname.startsWith('/Q')
  );
  requireThat(s.keys && typeof s.keys === 'object');
  const keys = s.keys as Record<string, unknown>;
  for (const [key, size] of [
    ['p256dh', 65],
    ['auth', 16],
  ] as const) {
    const value = keys[key];
    requireThat(
      typeof value === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(value) &&
        Buffer.from(value, 'base64url').length === size
    );
  }
  return { endpoint: url.href, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } };
}
const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(ip, prefix);
export const publicIPv4 = (ip: string) => isIP(ip) === 4 && !blocked.check(ip);
interface Vapid {
  publicKey: string;
  privateKey: string;
}
export async function deliver(
  target: webpush.PushSubscription,
  payload: string,
  vapid: Vapid,
  origin: string,
  resolve = (host: string): Promise<string[]> => resolve4(host)
) {
  validateSubscription(target);
  const addresses = await resolve('web.push.apple.com');
  requireThat(addresses.length && addresses.every(publicIPv4));
  const agent = new Agent({
    family: 4,
    lookup: (_host, _options, cb) => {
      cb(null, addresses[0], 4);
    },
  });
  try {
    await webpush.sendNotification(target, payload, {
      TTL: 86400,
      timeout: 10000,
      agent,
      vapidDetails: { subject: origin, ...vapid },
    });
  } finally {
    agent.destroy();
  }
}
/** Durable intent first: a crash may lose a notification, never fabricate delivery. */
export function createPush(store: DeviceStore, origin: string, send = deliver) {
  const vapid = store.transaction(s => (s.vapid ??= webpush.generateVAPIDKeys()));
  return {
    publicKey: vapid.publicKey,
    async tick() {
      const devices = store.transaction(s =>
        s.devices.filter(d => !d.revoked && d.expires > Date.now() && d.subscription)
      );
      let unknown = 0;
      for (const device of devices) {
        const previous = store.transaction(s =>
          s.receipts.filter(r => r.device === device.id).at(-1)
        );
        const state = await decisionState(device, undefined, store);
        if (state.status === 'unknown') unknown++;
        const done = ['completed', 'failed', 'cancelled'].includes(state.status);
        const decision = state.decision;
        if ((!decision || decision.disabled) && !(done && previous)) continue;
        const id = done ? previous?.id : decision?.id;
        if (!id) continue;
        const key = device.id + ':' + id + (done ? ':' + state.status : ':gate');
        const shouldSend = store.transaction(s => {
          const n = s.notices[key];
          if (n && (n.status === 'accepted' || n.attempts >= 3 || n.next > Date.now()))
            return false;
          // An interrupted send is unknown; retry only bounded push delivery, never decisions.
          s.notices[key] = {
            attempts: (n?.attempts ?? 0) + 1,
            next: Date.now() + 60000,
            status: 'unknown',
          };
          return true;
        });
        if (!shouldSend) continue;
        let status = 'failed';
        try {
          const target = store.transaction(
            s =>
              s.devices.find(d => d.id === device.id && !d.revoked && d.expires > Date.now())
                ?.subscription
          );
          if (!target) continue;
          validateSubscription(target);
          await send(
            target,
            JSON.stringify({
              title: done ? '执行状态已更新' : '需要你的决定',
              body: '打开查看原问题、合法选项或真实执行回执',
              url: '/?decision=' + id,
            }),
            vapid,
            origin
          );
          status = 'accepted';
        } catch {
          /* The persisted status is visible; endpoint and key never enter logs. */
        }
        store.transaction(s => {
          const notice = s.notices[key];
          requireThat(notice, 500);
          notice.status = status;
        });
      }
      return store.transaction(s => {
        const paired = s.devices.filter(d => !d.revoked && d.expires > Date.now());
        const notices = Object.entries(s.notices)
          .filter(([key]) => devices.some(d => key.startsWith(d.id + ':')))
          .flatMap(([, n]) => (n ? [n] : []));
        const failed = notices.filter(n => n.status === 'failed').length;
        const pending = notices.filter(n => n.status === 'unknown').length;
        return {
          state: !paired.length
            ? 'unpaired'
            : !devices.length
              ? 'unsubscribed'
              : failed
                ? 'failed'
                : unknown || pending
                  ? 'unknown'
                  : 'observed',
          paired: paired.length,
          subscribed: devices.length,
          accepted: notices.filter(n => n.status === 'accepted').length,
          failed,
          exhausted: notices.filter(n => n.status !== 'accepted' && n.attempts >= 3).length,
          unknown: unknown + pending,
          delivery: 'accepted 仅表示推送服务接收，不证明手机送达',
        };
      });
    },
  };
}

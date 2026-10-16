import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BoundaryError, DeviceStore, requireThat } from './device-store';
import { answerDecision, decisionState } from '../decisions';
import { createPush, validateSubscription } from './push';

export function checkOrigin(value: string): URL {
  const url = new URL(value);
  requireThat(
    url.origin === value &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
  );
  return url;
}
const assets = new Map([
  ['/', 'decision.html'],
  ['/decision.js', 'decision.js'],
  ['/sw.js', 'sw.js'],
  ['/manifest.json', 'manifest.json'],
  ['/icon.png', 'icon.png'],
]);
export async function createDecisionAdapter(origin: string, store = new DeviceStore()) {
  const host = checkOrigin(origin).host;
  const push = createPush(store, origin);
  const html = await Bun.file(join(import.meta.dir, 'decision.html')).text();
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  requireThat(style);
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'sha256-" +
      createHash('sha256').update(style).digest('base64') +
      "'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
  async function body(req: Request): Promise<Record<string, unknown>> {
    requireThat(req.headers.get('content-type') === 'application/json', 415);
    requireThat(Number(req.headers.get('content-length') ?? 0) <= 4096, 413);
    const reader = req.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
    requireThat(reader);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      const value = chunk.value;
      if (!value) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new BoundaryError(413, '请求过大');
      }
      chunks.push(value);
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new BoundaryError(400, 'JSON 无效');
    }
    requireThat(data && typeof data === 'object' && !Array.isArray(data));
    return data as Record<string, unknown>;
  }

  return {
    host,
    tick: () => push.tick(),
    fetch: async (req: Request): Promise<Response> => {
      const json = (data: unknown, status = 200, extra = {}) =>
        Response.json(data, { status, headers: { ...headers, ...extra } });
      try {
        const url = new URL(req.url),
          path = url.pathname;
        requireThat(req.headers.get('host') === host, 403, 'Host 不匹配');
        requireThat(!req.headers.has('origin') || req.headers.get('origin') === origin, 403);
        requireThat(['GET', 'POST'].includes(req.method), 405);
        const asset = assets.get(path);
        if (asset && req.method === 'GET') {
          requireThat(
            !url.search ||
              (path === '/' && [...url.searchParams.keys()].every(k => k === 'decision'))
          );
          return new Response(Bun.file(join(import.meta.dir, asset)), { headers });
        }
        if (req.method === 'POST') requireThat(req.headers.get('origin') === origin, 403);
        const data = req.method === 'POST' ? await body(req) : {};
        if (path === '/sa/device/pair' && req.method === 'POST' && !url.search) {
          requireThat(typeof data.code === 'string' && data.code.length <= 128);
          const session = store.pair(data.code);
          return json({ paired: true }, 200, {
            'Set-Cookie':
              '__Host-sa_device=' +
              session +
              '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000',
          });
        }
        const session = /(?:^|;\s*)__Host-sa_device=([a-f0-9]{64})(?:;|$)/.exec(
          req.headers.get('cookie') ?? ''
        )?.[1];
        requireThat(session, 401, '请先配对');
        const device = store.authenticate(session);
        if (req.method === 'POST')
          requireThat(req.headers.get('x-csrf-token') === device.csrf, 403, 'CSRF 校验失败');
        if (path === '/sa/decisions' && req.method === 'GET' && !url.search) {
          return json({
            ...(await decisionState(device, undefined, store)),
            deviceId: device.id,
            csrf: device.csrf,
            publicKey: push.publicKey,
            notification: store.transaction(s => {
              const notices = Object.entries(s.notices)
                .filter(([k]) => k.startsWith(device.id + ':'))
                .flatMap(([, n]) => (n ? [n] : []));
              return {
                accepted: notices.filter(n => n.status === 'accepted').length,
                failed: notices.filter(n => n.status === 'failed').length,
                unknown: notices.filter(n => n.status === 'unknown').length,
              };
            }),
            subscribed: !!device.subscription,
            delivery: 'accepted 仅表示推送服务接收，不证明手机送达',
          });
        }
        const match = /^\/sa\/decisions\/([a-f0-9]{64})\/(state|answer)$/.exec(path);
        if (match && !url.search) {
          if (match[2] === 'state' && req.method === 'GET')
            return json(await decisionState(device, match[1], store));
          if (match[2] === 'answer' && req.method === 'POST') {
            requireThat(typeof data.decision === 'string' && data.decision.length < 100);
            return json(
              { receipt: await answerDecision(store, device, match[1], data.decision) },
              202
            );
          }
        }
        requireThat(!url.search, 404);
        if (path === '/sa/device/subscription' && req.method === 'POST') {
          const subscription = validateSubscription(data);
          store.transaction(s => {
            const d = s.devices.find(d => d.id === device.id && !d.revoked);
            requireThat(d, 401);
            d.subscription = subscription;
          });
          return json({ subscribed: true });
        }
        if (path === '/sa/device/revoke' && req.method === 'POST') {
          store.revoke(device.id);
          return json({ revoked: true }, 200, {
            'Set-Cookie': '__Host-sa_device=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
          });
        }
        throw new BoundaryError(404, '无此接口');
      } catch (error) {
        return json(
          {
            error:
              error instanceof BoundaryError
                ? error.message
                : '服务不可用，状态未知；请在 Mac 查看',
          },
          error instanceof BoundaryError ? error.status : 503
        );
      }
    },
  };
}

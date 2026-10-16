import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lock } from '../archon';
import { home } from '../config';
import type { Controller } from '../coord';
import type { PushSubscription } from 'web-push';

export class BoundaryError extends Error {
  constructor(
    public status: number,
    message = '请求无效'
  ) {
    super(message);
  }
}
export function requireThat(ok: unknown, status = 400, message?: string): asserts ok {
  if (!ok) throw new BoundaryError(status, message);
}
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const secret = () => randomBytes(32).toString('hex');
export interface Grant {
  run: string;
  engine: string;
  controller: Controller;
}
export interface Device {
  id: string;
  session: string;
  csrf: string;
  expires: number;
  grant: Grant;
  lastRead?: string;
  revoked?: boolean;
  subscription?: PushSubscription;
}
export interface Receipt {
  id: string;
  device: string;
  run: string;
  engine: string;
  node: string;
  pause: string;
  decision: string;
  at: string;
  stage: 'intent' | 'accepted' | 'resuming' | 'unknown';
  error?: { phase: string; name: string; code?: string; message?: string };
}
interface State {
  pair?: { hash: string; expires: number; attempts: number; grant: Grant };
  devices: Device[];
  receipts: Receipt[];
  notices: Partial<Record<string, { attempts: number; next: number; status: string }>>;
  vapid?: { publicKey: string; privateKey: string };
}
/** One process-independent lock for secrets, revocations and the pre-effect intent. */
export class DeviceStore {
  constructor(readonly root = join(home().sa, 'console/mobile')) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  }
  transaction<T>(fn: (s: State) => T): T {
    const guard = lock(join(this.root, 'state.lock'));
    requireThat(guard.ok, 409, '设备状态忙，请重读');
    try {
      const file = join(this.root, 'state.json');
      const state: State = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as State)
        : { devices: [], receipts: [], notices: {} };
      const result = fn(state);
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      return result;
    } finally {
      guard.release();
    }
  }
  pairing(grant: Grant): string {
    const code = secret();
    this.transaction(s => {
      s.pair = { hash: digest(code), expires: Date.now() + 600000, attempts: 0, grant };
    });
    // Never returned to a remote API or printed; only the local Mac UI may display it.
    const file = join(this.root, 'pairing.html');
    writeFileSync(
      file,
      '<meta charset="utf-8"><h1>授权手机处理指定运行（10分钟，一次有效）</h1><p>' + code + '</p>',
      { mode: 0o600 }
    );
    chmodSync(file, 0o600);
    return file;
  }
  pair(code: string): string {
    const session = secret();
    const ok = this.transaction(s => {
      const pair = s.pair;
      if (!pair || pair.expires <= Date.now() || ++pair.attempts > 5 || pair.hash !== digest(code))
        return false;
      s.devices.push({
        id: secret(),
        session: digest(session),
        csrf: secret(),
        expires: Date.now() + 30 * 86400000,
        grant: pair.grant,
      });
      delete s.pair;
      return true;
    });
    requireThat(ok, 403, '配对无效或已过期');
    return session;
  }
  authenticate(session: string): Device {
    const d = this.transaction(s => s.devices.find(d => d.session === digest(session)));
    requireThat(d && !d.revoked && d.expires > Date.now(), 401, '请先配对');
    return d;
  }
  deviceLock(id: string) {
    requireThat(/^[a-f0-9]{64}$/.test(id));
    const guard = lock(join(this.root, 'device-' + id + '.lock'));
    requireThat(guard.ok, 409, '设备操作进行中，请重读');
    return guard;
  }
  revoke(id: string): void {
    const guard = this.deviceLock(id);
    try {
      this.transaction(s => {
        const d = s.devices.find(d => d.id === id);
        requireThat(d, 404);
        d.revoked = true;
        delete d.subscription;
      });
    } finally {
      guard.release();
    }
  }
}

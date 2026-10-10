// 纯函数：驾驶舱与 tick 共用监测口径，不读取运行时或提醒列表。
import { HOLD_POLICY } from './reasons';
export interface Ask {
  legacy_key?: string;
  id?: string;
  status: string;
  stale_answer?: boolean;
}
export type Asks = Partial<Record<string, Ask>>;
export interface HoldSignal {
  run_id: string;
  hold?: string;
  since: string;
  disposed: boolean;
}
export const askKey = (run: string, hold: string): string => `${run}:${hold}`;
export const unresolved = (a: Ask): boolean =>
  ['pending', 'unknown', 'yes', 'no'].includes(a.status);
export function cockpitSignals(
  holds: HoldSignal[],
  asks: Asks,
  now = Date.now()
): { orphan_hold: number; dup_ask: number; engine_suspect: number; stale_answer: number } {
  const counts = new Map<string, number>();
  for (const [key, a] of Object.entries(asks))
    if (a && unresolved(a)) {
      const k = key.split(':').slice(0, 2).join(':');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  return {
    orphan_hold: holds.filter(
      h =>
        h.hold &&
        now - Date.parse(h.since) > 600_000 &&
        !h.disposed &&
        !counts.has(askKey(h.run_id, h.hold))
    ).length,
    dup_ask: [...counts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
    engine_suspect: holds.filter(h => h.hold === 'engine_suspect').length,
    stale_answer: new Set(Object.entries(asks).filter(([, a]) => a?.stale_answer).map(([key, a]) => a?.id ?? key)).size,
  };
}
/** 保留旧键的历史；只迁移一个当前提问，其余作废，不创建新的提醒。 */
export function supersedeAsks(asks: Asks, run: string, hold?: string): void {
  const current = hold && askKey(run, hold);
  for (const [key, a] of Object.entries(asks)) {
    if (!key.startsWith(`${run}:`) || !a || !unresolved(a)) continue;
    const category = key.split(':')[1];
    if (
      current &&
      key !== current &&
      (category === hold || (hold === 'signoff' && !(category in HOLD_POLICY))) &&
      !asks[current]
    ) {
      asks[current] = { ...a, legacy_key: key };
    }
    if (key !== current) {
      if (['yes', 'no'].includes(a.status) && asks[current ?? '']?.legacy_key !== key)
        a.stale_answer = true;
      a.status = 'superseded';
    }
  }
}

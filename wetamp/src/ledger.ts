import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunView } from './archon';
import { executionAdmissionLock } from '@archon/workflows/execution-lifecycle';
import { confined } from './board/workflow';
import { home, writeAtomic } from './config';
import type { Ledger } from './cli';
export type { Ledger } from './cli';

export const ledgerPath = (run: string): string => join(home().sa, 'runs', `${run}.json`);

const LEDGER_STRINGS = ['run_id', 'archon_run_id', 'gen_dir', 'repo', 'branch', 'workflow'];
/** 读并校验 ledger；坏文件抛带路径的错误，不当成空对象。 */
export function loadLedger(run: string): Ledger {
  const p = ledgerPath(run);
  if (!existsSync(p)) throw new Error(`unknown run ${run} (no ${p})`);
  let o: Partial<Record<string, unknown>> | null;
  try {
    o = JSON.parse(readFileSync(p, 'utf8')) as typeof o;
  } catch (e) {
    throw new Error(`ledger ${p}: ${(e as Error).message}`);
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o))
    throw new Error(
      `ledger ${p}: not a JSON object (${
        o === null ? 'null' : Array.isArray(o) ? 'array' : typeof o
      })`
    );
  const bad = LEDGER_STRINGS.filter(k => typeof o[k] !== 'string');
  if (o.recoveries !== undefined && !Array.isArray(o.recoveries)) bad.push('recoveries');
  if (o.run_id !== run) bad.push('run_id≠file');
  if (bad.length) throw new Error(`ledger ${p}: bad ${bad.join(',')}`);
  return o as unknown as Ledger;
}

const serializeLedger = (ledger: Ledger): string => JSON.stringify(ledger, null, 2) + '\n';

/** Mutate a ledger under the same admission lock used by recovery and GC. */
export function mutateLedger(
  ledger: Ledger,
  mutate: (current: Ledger) => void,
  sleep: (ms: number) => void = Bun.sleepSync
): void {
  const admission = ledger.adoptions?.[0]?.from ?? ledger.archon_run_id;
  for (let attempt = 0; ; attempt++) {
    const lock = executionAdmissionLock(home().archon, admission);
    if (lock.ok) {
      try {
        const current = loadLedger(ledger.run_id);
        const before = serializeLedger(current);
        mutate(current);
        const after = serializeLedger(current);
        if (after !== before) writeAtomic(ledgerPath(current.run_id), after);
        Object.assign(ledger, current);
        return;
      } finally {
        lock.release();
      }
    }
    if (attempt >= 100)
      throw new Error(`ledger ${ledger.run_id}: execution admission ${admission} busy`);
    sleep(100);
  }
}

export const artifactsOf = (run: RunView): string =>
  join(run.output_root ?? '', 'artifacts', 'runs', run.id);
export const readJson = (p: string): unknown =>
  existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
export const evidenceJson = (l: Ledger, art: string, file: string): unknown => {
  const path = confined(l, join(art, file));
  return path ? readJson(path) : undefined;
};

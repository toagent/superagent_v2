import { createHash } from 'node:crypto';
// prettier-ignore
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getRun, runProjections, type RunView } from './archon';
import { home } from './config';

// prettier-ignore
interface DebtLedger { run_id: string; archon_run_id: string; repo: string; started_at?: string }
export interface DebtSource {
  ledger: DebtLedger;
  run: Pick<RunView, 'id' | 'output_root' | 'started_at' | 'completed_at'> | Error;
}
// prettier-ignore
export interface DebtClosure { id: string; repo: string; at: string; by: 'run' | 'operator'; reason: string; run?: string }
// prettier-ignore
export interface DebtRecord { id: string; repo: string; run: string; text: string; opened_at: string; status: 'open' | 'closed'; closed_at?: string }
// prettier-ignore
export interface DebtSnapshot { debts: DebtRecord[]; bad_closure_lines: number; bad_closure_at: (string | undefined)[]; unreadable: number; unreadable_started_at: (string | undefined)[] }

const canonicalCache = new Map<string, string>();
export function canonicalRepo(repo: string): string {
  const cached = canonicalCache.get(repo);
  if (cached) return cached;
  const query = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--git-common-dir'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  let canonical: string;
  if (query.exitCode === 0) {
    const common = realpathSync(resolve(repo, query.stdout.toString().trim()));
    canonical = dirname(common);
  } else canonical = realpathSync(repo);
  canonicalCache.set(repo, canonical);
  return canonical;
}
export const debtId = (repo: string, text: string): string =>
  createHash('sha256').update(`${repo}\0${text}`).digest('hex').slice(0, 12);

const closurePath = (): string => join(home().sa, 'debt', 'closures.jsonl');
export function readClosures(path = closurePath()): {
  closures: DebtClosure[];
  bad: number;
  badAt: (string | undefined)[];
} {
  if (!existsSync(path)) return { closures: [], bad: 0, badAt: [] };
  const closures: DebtClosure[] = [],
    badAt: (string | undefined)[] = [];
  let bad = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    let at: string | undefined;
    try {
      const value = JSON.parse(line) as Partial<DebtClosure>;
      at = typeof value.at === 'string' ? value.at : undefined;
      if (
        typeof value.id !== 'string' ||
        typeof value.repo !== 'string' ||
        typeof value.at !== 'string' ||
        !['run', 'operator'].includes(value.by ?? '') ||
        typeof value.reason !== 'string'
      )
        throw new Error('invalid closure');
      closures.push(value as DebtClosure);
    } catch {
      bad++;
      badAt.push(at);
    }
  }
  return { closures, bad, badAt };
}

function loadSources(): { sources: DebtSource[]; unreadable: number } {
  const dir = join(home().sa, 'runs');
  if (!existsSync(dir)) return { sources: [], unreadable: 0 };
  const ledgers: DebtLedger[] = [];
  let unreadable = 0;
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), 'utf8')) as DebtLedger;
      if (![value.run_id, value.archon_run_id, value.repo].every(x => typeof x === 'string'))
        throw new Error('invalid ledger');
      ledgers.push(value);
    } catch {
      unreadable++;
    }
  }
  const projections = runProjections(ledgers.map(l => l.archon_run_id));
  return {
    unreadable,
    sources: ledgers.map(ledger => {
      try {
        const run =
          projections?.get(ledger.archon_run_id) ?? getRun(ledger.archon_run_id, ledger.repo);
        return { ledger, run };
      } catch (error) {
        return { ledger, run: error as Error };
      }
    }),
  };
}

export function debtSnapshot(input?: DebtSource[], closuresFile = closurePath()): DebtSnapshot {
  const loaded = input ? { sources: input, unreadable: 0 } : loadSources();
  const records = new Map<string, DebtRecord>();
  // prettier-ignore
  const unreadableStartedAt = Array.from({ length: loaded.unreadable }, (): string | undefined => undefined);
  for (const { ledger, run } of loaded.sources) {
    try {
      if (run instanceof Error || !run.output_root) throw run instanceof Error ? run : new Error();
      const repo = canonicalRepo(ledger.repo),
        art = join(run.output_root, 'artifacts', 'runs', run.id);
      if (!existsSync(art)) throw new Error('missing artifacts');
      const latest = new Map<string, { file: string; round: number }>();
      for (const file of readdirSync(art)) {
        const match = /^gate-(.+)-r(\d+)\.json$/.exec(file);
        if (!match) continue;
        const round = Number(match[2]),
          previous = latest.get(match[1]);
        if (!previous || round > previous.round) latest.set(match[1], { file, round });
      }
      for (const { file } of latest.values()) {
        const path = join(art, file),
          value = JSON.parse(readFileSync(path, 'utf8')) as { decision?: { debt?: unknown } };
        if (
          !Array.isArray(value.decision?.debt) ||
          !value.decision.debt.every(x => typeof x === 'string')
        )
          continue;
        const opened = statSync(path).mtime.toISOString();
        for (const text of value.decision.debt) {
          const id = debtId(repo, text),
            previous = records.get(id);
          if (!previous || opened < previous.opened_at)
            records.set(id, {
              id,
              repo,
              run: ledger.run_id,
              text,
              opened_at: opened,
              status: 'open',
            });
        }
      }
    } catch {
      unreadableStartedAt.push(run instanceof Error ? undefined : (run.started_at ?? undefined));
    }
  }
  const { closures, bad, badAt } = readClosures(closuresFile);
  for (const closure of closures) {
    const debt = records.get(closure.id);
    if (debt?.status === 'open')
      records.set(closure.id, { ...debt, status: 'closed', closed_at: closure.at });
  }
  return {
    debts: [...records.values()].sort((a, b) => a.opened_at.localeCompare(b.opened_at)),
    bad_closure_lines: bad,
    bad_closure_at: badAt,
    unreadable: unreadableStartedAt.length,
    unreadable_started_at: unreadableStartedAt,
  };
}

function appendClosures(events: DebtClosure[], path = closurePath()): DebtClosure[] {
  const seen = new Set(readClosures(path).closures.map(event => event.id));
  const fresh = events.filter(event => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  if (!fresh.length) return [];
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, fresh.map(event => JSON.stringify(event)).join('\n') + '\n', { flag: 'a' });
  return fresh;
}

export function closeDebts(ids: string[], reason: string, path = closurePath()): DebtClosure[] {
  const snapshot = debtSnapshot(undefined, path),
    byId = new Map(snapshot.debts.map(debt => [debt.id, debt]));
  const unknown = [...new Set(ids)].filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`debt close: unknown id ${unknown.join(',')}`);
  const at = new Date().toISOString(),
    events: DebtClosure[] = [];
  for (const id of new Set(ids)) {
    const debt = byId.get(id);
    if (debt) events.push({ id, repo: debt.repo, at, by: 'operator', reason });
  }
  return appendClosures(events, path);
}

export function closePlannedDebts(
  planPath: string,
  run: string,
  milestone: string,
  path = closurePath()
): DebtClosure[] {
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
    repo: string;
    packages: { id: string; milestone?: string; closes_debt?: string[] }[];
  };
  const repo = canonicalRepo(plan.repo),
    at = new Date().toISOString();
  return appendClosures(
    plan.packages
      .filter(pkg => (pkg.milestone ?? 'm1') === milestone)
      .flatMap(pkg =>
        (pkg.closes_debt ?? []).map(id => ({
          id,
          repo,
          at,
          by: 'run' as const,
          run,
          reason: `integrated package ${pkg.id}`,
        }))
      ),
    path
  );
}

export function debtMetrics(
  snapshot: DebtSnapshot,
  now = Date.now()
): Record<string, number | 'unknown'> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = (at?: string): boolean =>
    !!at && Date.parse(at) >= start.getTime() && Date.parse(at) <= now;
  const open = snapshot.debts.filter(debt => debt.status === 'open').length;
  const uncertainToday = (dates: (string | undefined)[]): boolean =>
    dates.some(at => !at || !Number.isFinite(Date.parse(at)) || today(at));
  return {
    debt: open,
    debt_open: open,
    debt_unreadable: snapshot.unreadable,
    debt_bad_closure_lines: snapshot.bad_closure_lines,
    debt_new_today: uncertainToday(snapshot.unreadable_started_at)
      ? 'unknown'
      : snapshot.debts.filter(debt => today(debt.opened_at)).length,
    debt_closed_today: uncertainToday(snapshot.bad_closure_at)
      ? 'unknown'
      : new Set(snapshot.debts.filter(debt => today(debt.closed_at)).map(debt => debt.id)).size,
  };
}

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { home } from './config';
import { coord, repoScope } from './coord';
import { loadLedger } from './ledger';
import { loadPlan, type Plan } from './plan';
import { redact } from './redact';

export function scopeOverlaps(plan: Plan): { run_id: string; paths: string[]; error?: string }[] {
  try {
    if (process.env.DATABASE_URL) throw new Error('DATABASE_URL: SQLite status unavailable');
    const scope = repoScope(plan.repo).id;
    const dir = join(home().sa, 'runs');
    const ids = existsSync(dir)
      ? readdirSync(dir)
          .filter(file => file.endsWith('.json'))
          .map(file => file.slice(0, -5))
      : [];
    return ids.flatMap<{ run_id: string; paths: string[]; error?: string }>(run => {
      try {
        const ledger = loadLedger(run);
        if (!statSync(ledger.repo, { throwIfNoEntry: false })) return [];
        try {
          if (repoScope(ledger.repo).id !== scope) return [];
        } catch (error) {
          const status = coord().d.status(ledger);
          if (
            ['completed', 'failed', 'cancelled'].includes(status) &&
            (!ledger.delivery_result || ledger.delivery_result.status === 'integrated')
          )
            return [];
          throw error;
        }
        const status = coord().d.status(ledger);
        if (
          ['completed', 'failed', 'cancelled'].includes(status) &&
          (!ledger.delivery_result || ledger.delivery_result.status === 'integrated')
        )
          return [];
        if (status === 'unknown') throw new Error('run status unavailable');
        const frozen = join(ledger.gen_dir, 'plan.json');
        const previous = loadPlan(
          existsSync(frozen) ? frozen : resolve(ledger.repo, ledger.plan)
        ).packages.flatMap(pkg => pkg.scope.write);
        const prefix = (glob: string): string => glob.split(/[*?{[]/, 1)[0];
        const paths = plan.packages
          .flatMap(pkg => pkg.scope.write)
          .filter(path =>
            previous.some(
              other =>
                path === other ||
                new Bun.Glob(other).match(path) ||
                new Bun.Glob(path).match(other) ||
                (prefix(path) !== path &&
                  prefix(other) !== other &&
                  (prefix(path).startsWith(prefix(other)) ||
                    prefix(other).startsWith(prefix(path))))
            )
          );
        return paths.length ? [{ run_id: ledger.run_id, paths: [...new Set(paths)] }] : [];
      } catch (error) {
        return [{ run_id: run, paths: [], error: redact(String(error)) }];
      }
    });
  } catch (error) {
    return [{ run_id: 'unknown', paths: [], error: redact(String(error)) }];
  }
}

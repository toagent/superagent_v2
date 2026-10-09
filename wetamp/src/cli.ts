// superagent 兼容 CLI：plan.json 协议 → archon workflow 动词。输出 JSON；退出码见 waitExit。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archon, recover, tail } from './archon';
import { WETAMP, home, loadTiers, renderAliases, assertAuthorNotReviewer } from './config';

interface Args {
  _: string[];
  flags: Record<string, string | true>;
}
export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--')) {
      a._.push(s);
      continue;
    }
    const eq = s.indexOf('=');
    const next = argv.at(i + 1);
    if (eq > 0) a.flags[s.slice(2, eq)] = s.slice(eq + 1);
    else if (next !== undefined && !next.startsWith('--')) {
      a.flags[s.slice(2)] = next;
      i++;
    } else a.flags[s.slice(2)] = true;
  }
  return a;
}

const print = (o: unknown): void => {
  console.log(JSON.stringify(o, null, 2));
};

/** superagent run id → runs/<run>.json；未登记则视为 archon run id。 */
export function resolveRun(id: string): {
  run_id: string;
  archon_run_id: string;
  ledger?: Record<string, unknown>;
} {
  const p = join(home().sa, 'runs', `${id}.json`);
  if (!existsSync(p)) return { run_id: id, archon_run_id: id };
  const ledger = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  return { run_id: id, archon_run_id: String(ledger.archon_run_id), ledger };
}

function health(): number {
  const aliases = renderAliases(loadTiers());
  assertAuthorNotReviewer(aliases);
  const doctor = archon(['doctor']);
  const clean = Bun.spawnSync([join(WETAMP, 'scripts', 'check-upstream-clean.sh')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const upstreamDiff = clean.stdout.toString().trim();
  const ok = doctor.code === 0 && clean.exitCode === 0 && upstreamDiff === '';
  print({
    ok,
    doctor: doctor.code === 0 ? 'ok' : tail(doctor.out),
    aliases,
    upstream_clean: upstreamDiff === '' ? true : upstreamDiff,
  });
  return ok ? 0 : 1;
}

export function main(argv: string[]): number {
  const a = parseArgs(argv);
  const [verb, target] = a._;
  switch (verb) {
    case 'recover': {
      const r = resolveRun(need(target, 'recover <run>'));
      const res = recover(r.archon_run_id);
      print({ run_id: r.run_id, ...res });
      return res.ok ? 0 : 1;
    }
    case 'health':
      return health();
    default:
      console.error('usage: superagent <recover|health> ...');
      return 64;
  }
}

function need<T>(v: T | undefined, usage: string): T {
  if (v === undefined) throw new Error(`usage: superagent ${usage}`);
  return v;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`superagent: ${(e as Error).message}`);
    process.exit(1);
  }
}

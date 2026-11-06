import { createLoader } from '../src/board/data';
import { debtMetrics, debtSnapshot } from '../src/debt';
import { createDemandSnapshot, createWorkerSnapshotLoader } from '../src/web/server';

const number = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name),
    value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!(value > 0)) throw new Error(`${name} must be a positive number`);
  return value;
};
const soak = number('--soak', 5),
  maxRssMb = number('--max-rss-mb', Infinity),
  maxP95Ms = number('--max-p95-ms', number('--max-ms', Infinity)),
  breakdown = process.argv.includes('--breakdown'),
  checkTotals = process.argv.includes('--check-totals');

const samples: number[] = [];
const stages = new Map<string, number[]>();
let peakRss = process.memoryUsage().rss,
  recording = false;
const load = createWorkerSnapshotLoader(createLoader(), undefined, {
  onSample: sample => {
    if (!recording) return;
    samples.push(sample.round_ms);
    peakRss = Math.max(peakRss, sample.rss);
    if (breakdown) {
      for (const [stage, ms] of Object.entries(sample.profile ?? {})) {
        const values = stages.get(stage) ?? [];
        values.push(ms);
        stages.set(stage, values);
      }
      console.log(
        JSON.stringify({
          type: 'snapshot_breakdown',
          round_ms: sample.round_ms,
          stages: sample.profile ?? {},
        })
      );
    }
  },
});
const demand = createDemandSnapshot(load);
await demand.update();
recording = true;
for (let second = 0; second < soak; second++) {
  await demand.update();
  if (second + 1 < soak) await Bun.sleep(1000);
}
if (checkTotals) {
  const limited = demand.snapshot().summary,
    full = (await createLoader()(Number.MAX_SAFE_INTEGER)).summary,
    debt = debtMetrics(debtSnapshot()),
    differing = Object.keys(full).filter(
      key => JSON.stringify(limited[key]) !== JSON.stringify(full[key])
    );
  for (const key of Object.keys(debt))
    if (limited[key] !== debt[key] && !differing.includes(key)) differing.push(key);
  if (differing.length) {
    console.error(
      JSON.stringify({ type: 'snapshot_total_mismatch', differing, limited, full, debt })
    );
    process.exitCode = 1;
  }
}
const sorted = [...samples].sort((a, b) => a - b);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
const percentile = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
const endRss = process.memoryUsage().rss,
  mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
console.log(
  JSON.stringify({
    samples: samples.length,
    peak_rss_mb: mb(peakRss),
    end_rss_mb: mb(endRss),
    p95_ms: Math.round(p95 * 10) / 10,
    ...(breakdown
      ? { breakdown_p95_ms: Object.fromEntries([...stages].map(([k, v]) => [k, percentile(v)])) }
      : {}),
  })
);
if (mb(peakRss) > maxRssMb || p95 > maxP95Ms) process.exitCode = 1;
process.exit(process.exitCode ?? 0);

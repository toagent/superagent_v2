import { createLoader } from '../src/board/data';
import { createDemandSnapshot, createWorkerSnapshotLoader } from '../src/web/server';

const number = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name),
    value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!(value > 0)) throw new Error(`${name} must be a positive number`);
  return value;
};
const soak = number('--soak', 5),
  maxRssMb = number('--max-rss-mb', Infinity),
  maxP95Ms = number('--max-p95-ms', number('--max-ms', Infinity));

const samples: number[] = [];
let peakRss = process.memoryUsage().rss;
const load = createWorkerSnapshotLoader(createLoader(), undefined, {
  onSample: sample => {
    samples.push(sample.load_ms);
    peakRss = Math.max(peakRss, sample.rss);
  },
});
const demand = createDemandSnapshot(load);
for (let second = 0; second < soak; second++) {
  await demand.update();
  if (second + 1 < soak) await Bun.sleep(1000);
}
const sorted = [...samples].sort((a, b) => a - b);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
const endRss = process.memoryUsage().rss,
  mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;
console.log(
  JSON.stringify({
    samples: samples.length,
    peak_rss_mb: mb(peakRss),
    end_rss_mb: mb(endRss),
    p95_ms: Math.round(p95 * 10) / 10,
  })
);
if (mb(peakRss) > maxRssMb || p95 > maxP95Ms) process.exitCode = 1;
process.exit(process.exitCode ?? 0);

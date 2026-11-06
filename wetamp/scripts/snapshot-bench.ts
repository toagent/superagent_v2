import { createLoader } from '../src/board/data';

const at = process.argv.indexOf('--max-ms');
const maxMs = at < 0 ? Infinity : Number(process.argv[at + 1]);
if (!(maxMs > 0)) throw new Error('--max-ms must be a positive number');

const load = createLoader();
await load(Number.MAX_SAFE_INTEGER);
const samples: number[] = [];
for (let i = 1; i <= 5; i++) {
  const started = performance.now();
  await load(Number.MAX_SAFE_INTEGER);
  const ms = Math.round((performance.now() - started) * 10) / 10;
  samples.push(ms);
  console.log(JSON.stringify({ sample: i, ms }));
}
const sorted = [...samples].sort((a, b) => a - b);
const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
console.log(JSON.stringify({ p95_ms: p95, max_ms: Number.isFinite(maxMs) ? maxMs : null }));
if (p95 > maxMs) process.exitCode = 1;

import { createLoader } from '../src/board/data';
import { debtMetrics, debtSnapshot } from '../src/debt';
import {
  createDemandSnapshot,
  createWorkerSnapshotLoader,
  handler,
  webOverview,
} from '../src/web/server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  checkTotals = process.argv.includes('--check-totals'),
  viewerCpu = process.argv.includes('--viewer-cpu') ? number('--viewer-cpu', Infinity) : 0,
  maxCpu = number('--max-cpu', Infinity),
  coldStart = process.argv.includes('--cold-start'),
  coldChild = process.argv.includes('--cold-child');

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

if (coldStart) {
  const started = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--preload',
      join(import.meta.dir, '../src/web/archon.ts'),
      import.meta.path,
      '--cold-child',
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const stdout = new Response(child.stdout).text(),
    stderr = new Response(child.stderr).text();
  let peak = 0;
  for (;;) {
    const sample = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(child.pid)]);
    if (sample.exitCode !== 0) break;
    const rss = Number(sample.stdout.toString().trim()) * 1024;
    if (Number.isFinite(rss)) peak = Math.max(peak, rss);
    await Bun.sleep(200);
  }
  const [code, out, err] = await Promise.all([child.exited, stdout, stderr]);
  if (code !== 0) throw new Error(`cold-start child exit ${String(code)}: ${err || out}`);
  const ready = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as { rss?: number };
  peak = Math.max(peak, ready.rss ?? 0);
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      type: 'cold_start',
      peak_rss_mb: mb(peak),
      end_rss_mb: mb(ready.rss ?? 0),
      elapsed_ms: Math.round(elapsedMs),
    })
  );
  process.exit(mb(peak) > maxRssMb || elapsedMs > 60_000 ? 1 : 0);
}

if (coldChild) {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-cold-start-'));
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });
  const { startObserver } = await import('../src/web/archon');
  await startObserver(join(dir, 'archon.sock'));
}

const samples: number[] = [];
const loadSamples: number[] = [];
const serializationSamples: number[] = [];
const stages = new Map<string, number[]>();
let peakRss = process.memoryUsage().rss,
  recording = false;
const load = createWorkerSnapshotLoader(createLoader(), undefined, {
  onSample: sample => {
    if (!recording) return;
    samples.push(sample.round_ms);
    loadSamples.push(sample.load_ms);
    serializationSamples.push(Math.max(0, sample.round_ms - sample.load_ms));
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
if (coldChild) {
  console.log(JSON.stringify({ type: 'cold_start_ready', rss: process.memoryUsage().rss }));
  process.exit(0);
}
if (viewerCpu > 0) {
  recording = true;
  let projected:
    | { snapshot: ReturnType<typeof demand.snapshot>; value: ReturnType<typeof webOverview> }
    | undefined;
  const get = (): ReturnType<typeof webOverview> => {
    const snapshot = demand.snapshot();
    if (projected?.snapshot !== snapshot)
      projected = { snapshot, value: webOverview(snapshot, demand.snapshotAt()) };
    return { ...projected.value, served_at: new Date().toISOString() };
  };
  let serveRequest: (request: Request) => Promise<Response> = () =>
    Promise.reject(new Error('viewer server not ready'));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => serveRequest(request),
  });
  const port = server.port;
  if (port === undefined) throw new Error('viewer server did not bind');
  serveRequest = handler(
    port,
    'bench',
    get,
    'http://localhost',
    fetch,
    undefined,
    demand.snapshot,
    demand.update
  );
  const started = performance.now(),
    cpuStarted = process.cpuUsage(),
    httpSamples: number[] = [];
  let requests = 0;
  while (performance.now() - started < viewerCpu * 1000) {
    const requestStarted = performance.now();
    const response = await fetch(`http://127.0.0.1:${String(port)}/sa/data?t=bench`);
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`viewer request failed: ${String(response.status)}`);
    httpSamples.push(performance.now() - requestStarted);
    requests++;
    const remaining = viewerCpu * 1000 - (performance.now() - started);
    if (remaining > 0) await Bun.sleep(Math.min(1500, remaining));
  }
  const elapsedMs = performance.now() - started,
    cpu = process.cpuUsage(cpuStarted),
    cpuPct = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
    total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);
  await server.stop(true);
  console.log(
    JSON.stringify({
      type: 'viewer_cpu',
      seconds: Math.round((elapsedMs / 1000) * 10) / 10,
      requests,
      cpu_pct: Math.round(cpuPct * 10) / 10,
      loader_ms: Math.round(total(loadSamples) * 10) / 10,
      serialization_ms: Math.round(total(serializationSamples) * 10) / 10,
      http_ms: Math.round(total(httpSamples) * 10) / 10,
    })
  );
  process.exit(cpuPct > maxCpu ? 1 : 0);
}
recording = true;
for (let second = 0; second < soak; second++) {
  await demand.update();
  if (second + 1 < soak) await Bun.sleep(1000);
}
if (checkTotals) {
  const totals = createLoader(),
    limited = (await totals(200)).summary,
    full = (await totals(Number.MAX_SAFE_INTEGER)).summary,
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
const endRss = process.memoryUsage().rss;
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

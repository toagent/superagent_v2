import { appendFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
export const LOAD_WAIT_BUDGET_MS = 30 * 60_000;
const testNumber = (key: string, fallback: number): number =>
  process.env.NODE_ENV === 'test' && process.env[key] ? Number(process.env[key]) : fallback;
let testLoads: number[] | undefined;
const currentLoad = (): number => {
  if (process.env.NODE_ENV !== 'test' || !process.env.SA_TEST_LOAD_SEQUENCE) return loadavg()[0];
  testLoads ??= process.env.SA_TEST_LOAD_SEQUENCE.split(',').map(Number);
  return (testLoads.length > 1 ? testLoads.shift() : testLoads[0]) ?? loadavg()[0];
};
export async function waitForLoad(log?: string): Promise<void> {
  const limit = testNumber('SA_TEST_LOAD_LIMIT', availableParallelism());
  const pollMs = testNumber('SA_TEST_LOAD_POLL_MS', 5_000);
  const maxMs = testNumber('SA_TEST_LOAD_MAX_MS', LOAD_WAIT_BUDGET_MS);
  const progressMs = testNumber('SA_TEST_LOAD_PROGRESS_MS', 60_000);
  const started = Date.now();
  let lastProgress = -Infinity;
  let load = currentLoad();
  const report = (message: string): void => {
    if (log) appendFileSync(log, `# ${message}\n`);
    // stderr: script nodes with an output_format must print exactly one JSON document on stdout.
    console.error(message);
  };
  if (load <= limit) return;
  while (load > limit) {
    const waited = Date.now() - started;
    if (waited >= maxMs) {
      report(`负载等待超时，按原计划启动（${load.toFixed(1)} > ${String(limit)}）`);
      return;
    }
    if (waited - lastProgress >= progressMs) {
      // prettier-ignore
      report(`负载 ${load.toFixed(1)} > ${String(limit)}，已等 ${String(Math.floor(waited / 1000))}s`);
      lastProgress = waited;
    }
    await Bun.sleep(Math.min(pollMs, maxMs - waited));
    load = currentLoad();
  }
  report(`负载已恢复 ${load.toFixed(1)} <= ${String(limit)}，开始新作业`);
}

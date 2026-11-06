import { createLoader } from '../board/data';
import { overview, type WebSnapshot } from './server';

interface WorkerScope {
  onmessage: ((event: MessageEvent<{ id: number; limit: number }>) => void) | null;
  postMessage(message: unknown): void;
}
declare const self: WorkerScope;

let profile: Record<string, number> = {};
const load = createLoader(
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  timings => {
    profile = timings;
  }
);

self.onmessage = (event: MessageEvent<{ id: number; limit: number }>) => {
  const { id, limit } = event.data;
  void (async () => {
    const started = performance.now();
    try {
      const snapshot = await load(limit);
      const compact: WebSnapshot = {
        at: snapshot.at,
        summary: {},
        rows: [],
        web: overview(snapshot),
      };
      self.postMessage({
        id,
        snapshot: compact,
        load_ms: performance.now() - started,
        rss: process.memoryUsage().rss,
        profile,
      });
    } catch (error) {
      self.postMessage({
        id,
        error: (error as Error).message,
        load_ms: performance.now() - started,
        rss: process.memoryUsage().rss,
      });
    }
  })();
};
self.postMessage({ ready: true });

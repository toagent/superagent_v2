import { createLoader } from '../board/data';

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
      self.postMessage({
        id,
        snapshot,
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

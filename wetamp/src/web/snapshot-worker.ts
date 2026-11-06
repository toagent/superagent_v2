import { createLoader } from '../board/data';

interface WorkerScope {
  onmessage: ((event: MessageEvent<{ id: number; limit: number }>) => void) | null;
  postMessage(message: unknown): void;
}
declare const self: WorkerScope;

const load = createLoader();

self.onmessage = (event: MessageEvent<{ id: number; limit: number }>) => {
  const { id, limit } = event.data;
  void (async () => {
    const started = performance.now();
    try {
      self.postMessage({
        id,
        snapshot: JSON.stringify(await load(limit)),
        load_ms: performance.now() - started,
        rss: process.memoryUsage().rss,
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

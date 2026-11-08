import { createLoader } from '../board/data';
import { overview, type WebSnapshot } from './server';

if (!process.send) throw new Error('snapshot worker requires IPC');
const send = process.send.bind(process);

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

process.on('message', (message: { id: number; limit: number }) => {
  const { id, limit } = message;
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
      send({
        id,
        snapshot: compact,
        load_ms: performance.now() - started,
        rss: process.memoryUsage().rss,
        profile,
      });
    } catch (error) {
      send({
        id,
        error: (error as Error).message,
        load_ms: performance.now() - started,
        rss: process.memoryUsage().rss,
      });
    }
  })();
});
send({ ready: true });

import { createLoader } from '../board/data';
import { overview, type WebSnapshot } from './server';

interface WorkerScope {
  onmessage: ((event: MessageEvent<{ id: number; limit: number }>) => void) | null;
  postMessage(message: unknown): void;
}
declare const self: WorkerScope;

// prettier-ignore
const send = (message: unknown): void => {
  if (process.send) process.send(message); else self.postMessage(message);
};
// prettier-ignore
const receive = (handler: NonNullable<WorkerScope['onmessage']>): void => void (process.send ? process.on('message', message => { handler({ data: message } as MessageEvent<{ id: number; limit: number }>); }) : (self.onmessage = handler));

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

receive((event: MessageEvent<{ id: number; limit: number }>) => {
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

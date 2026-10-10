// Runtime preload: preserve native server code while removing observer side effects.
import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { home } from '../config';
import { getSourceServerEntry } from '../../../packages/paths/src/archon-paths';
export const observerDist = (): string => process.env.SA_CONSOLE_WEB_DIST ?? join(home().sa, 'console/dist');
export function disableCleanup(source: string): string {
  const target = /export function startCleanupScheduler\(\): void \{[\s\S]*?\n\}/g;
  if ([...source.matchAll(target)].length !== 1) throw new Error('cleanup preload: startCleanupScheduler target missing or ambiguous');
  return source.replace(target, "export function startCleanupScheduler(): void { getLog().info('cleanup_scheduler_disabled_by_superagent'); }");
}
export function observerEnv(): void {
  Bun.plugin({ name: 'superagent-observer', setup(build) {
    build.onLoad({ filter: /[/\\]dotenv[/\\]lib[/\\]main\.js$/ }, () => ({ loader: 'js', contents: 'export const config = () => ({ parsed: {} }); export const parse = () => ({}); export default { config, parse };' }));
    build.onLoad({ filter: /[/\\]cleanup-service\.ts$/ }, args => ({ loader: 'ts', contents: disableCleanup(readFileSync(args.path, 'utf8')) }));
  } });
}
observerEnv();
/** Both listeners run in the launchd-owned process and end with it. */
export async function startObserver(unix: string): Promise<void> {
  const native = Bun.serve;
  Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    const rest = { ...options } as Parameters<typeof Bun.serve>[0] & { port?: number; hostname?: string };
    delete rest.port; delete rest.hostname;
    const server = native({ ...rest, unix } as Parameters<typeof Bun.serve>[0]);
    chmodSync(unix, 0o600);
    return server;
  }) as typeof Bun.serve;
  try {
    const { startServer } = await import(join(dirname(getSourceServerEntry()), 'index.ts')) as typeof import('../../../packages/server/src/index');
    await startServer({ webDistPath: observerDist(), skipPlatformAdapters: true });
  } finally { Bun.serve = native; }
}

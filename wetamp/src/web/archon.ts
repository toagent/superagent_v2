// The observer process must not reload adapter credentials or a DATABASE_URL from dotenv.
// Scope this loader override to this process; the CLI/providers retain native configuration.
import { dirname, join } from 'node:path';
import { getSourceServerEntry, getSourceWebDistDir } from '../../../packages/paths/src/archon-paths';
export function observerEnv(): void {
  Bun.plugin({ name: 'superagent-observer-env', setup(build) {
    // Runtime bare-package resolution bypasses onResolve; intercept the resolved module instead.
    build.onLoad({ filter: /[/\\]dotenv[/\\]lib[/\\]main\.js$/ }, () => ({ loader: 'js', contents: 'export const config = () => ({ parsed: {} }); export const parse = () => ({}); export default { config, parse };' }));
  } });
}
if (import.meta.main) {
  observerEnv();
  const { startServer } = await import(join(dirname(getSourceServerEntry()), 'index.ts')) as typeof import('../../../packages/server/src/index');
  await startServer({ port: Number(process.argv[2]), webDistPath: getSourceWebDistDir(), skipPlatformAdapters: true });
}

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// prettier-ignore
export async function buildSecrets(out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  for (const [entrypoint, name] of [['scan.ts', 'secret-scan.cjs'], ['redact-stream.ts', 'sa-redact.cjs']] as const) { const result = await Bun.build({ entrypoints: [join(import.meta.dir, entrypoint)], outdir: out, naming: name, target: 'node', format: 'cjs', minify: true }); if (!result.success) throw new Error(result.logs.map(log => log.message).join('\n')); }
}
if (import.meta.main) await buildSecrets(resolve(process.argv[2] ?? '.'));

import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('land runtime graph excludes the CLI entrypoint', async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, '../src/land.ts')],
    target: 'bun',
    metafile: true,
  });
  expect(result.success).toBeTrue();
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map(path => path.replaceAll('\\', '/'));
  expect(inputs.some(path => path.endsWith('/src/cli.ts'))).toBeFalse();
});

import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { gitRepo, tmp } from './helpers';
const redline = createRequire(import.meta.url)('../hooks/redline.cjs') as {
  init: () => Promise<unknown>;
  reason: (args: object) => string | null;
};
await redline.init();
test('REDLINE preserves short-circuit cwd and isolates child scope for foreign checkout writes', () => {
  const root = gitRepo(tmp()),
    outside = gitRepo(tmp());
  const check = (shell: string) =>
    redline.reason({
      client: 'claude',
      name: 'Bash',
      shell,
      cwd: root,
      root,
      derived: true,
      env: {},
    });
  for (const shell of [
    `cd ${outside} && touch f`,
    `(cd ${outside}; echo x > f)`,
    `cd ${outside}; true || cd ${root} && echo x > f`,
  ])
    expect(check(shell), shell).not.toBeNull();
  for (const shell of [
    `cd ${outside} || touch f`,
    `(cd ${outside}); touch local`,
    `sh -c 'cd ${outside}' && touch local`,
  ])
    expect(check(shell), shell).toBeNull();
});

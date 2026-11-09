import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSecrets } from '../src/secrets/build';
import { tmp } from './helpers';

// The shell is the subject: clients read output the moment the shell exits, so the sourced helper
// must have flushed the redactor by then (an unwaited process substitution loses the output).
test('sourced redactor flushes before shell exit and keeps cd and exit status', async () => {
  const dir = tmp();
  await buildSecrets(dir);
  copyFileSync(join(import.meta.dir, '../secrets/gitleaks.toml'), join(dir, 'gitleaks.toml'));
  const probe = `sfprobe${crypto.randomUUID().replaceAll('-', '')}`;
  const encoded = Buffer.from(`${probe}\n`).toString('base64');
  const second = `sfsecond${crypto.randomUUID().replaceAll('-', '')}`;
  for (const shell of ['zsh', 'bash']) {
    const result = Bun.spawnSync(
      [
        shell,
        '-c',
        `. ${join(import.meta.dir, '../secrets/sa-redact.sh')}; echo MARK $SA_PROBE_TOKEN $SA_SECOND_SECRET; printf '%s\\n' "$SA_PROBE_TOKEN" | base64; cd /tmp/..; pwd; (exit 3)`,
      ],
      {
        env: {
          ...process.env,
          SA_PROBE_TOKEN: probe,
          SA_SECOND_SECRET: second,
          SA_REDACT_CJS: join(dir, 'sa-redact.cjs'),
          SA_GITLEAKS_CONFIG: join(dir, 'gitleaks.toml'),
        },
      }
    );
    const out = result.stdout.toString();
    expect(result.exitCode).toBe(3);
    expect(out).toContain('MARK [REDACTED:');
    expect(out).toContain('\n/\n');
    expect(out).not.toContain(probe);
    expect(out).not.toContain(second);
    expect(out).not.toContain(encoded.trim());
    const started = performance.now();
    // prettier-ignore
    const background = Bun.spawn([shell, '-c', `. ${join(import.meta.dir, '../secrets/sa-redact.sh')}; (sleep 5 &); echo BACKGROUND`], { env: { ...process.env, SA_REDACT_CJS: join(dir, 'sa-redact.cjs'), SA_GITLEAKS_CONFIG: join(dir, 'gitleaks.toml') }, stdout: 'pipe' });
    expect(await background.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
    // prettier-ignore
    expect(Buffer.from((await background.stdout.getReader().read()).value ?? []).toString()).toContain('BACKGROUND');
  }
});

// Codex runs non-login shells with a core env: node and gitleaks may be missing from PATH.
test('install-rendered helper works with a minimal PATH and says so when the redactor cannot start', async () => {
  const dir = tmp();
  await buildSecrets(dir);
  copyFileSync(join(import.meta.dir, '../secrets/gitleaks.toml'), join(dir, 'gitleaks.toml'));
  const which = (bin: string): string => Bun.which(bin) ?? bin;
  const source = await Bun.file(join(import.meta.dir, '../secrets/sa-redact.sh')).text();
  const rendered = join(dir, 'sa-redact.sh');
  await Bun.write(
    rendered,
    source
      .replace('__SA_NODE__', which('node'))
      .replace('__SA_TOOL_DIRS__', join(which('gitleaks'), '..'))
  );
  const probe = `sfprobe${crypto.randomUUID().replaceAll('-', '')}`;
  const base = {
    HOME: process.env.HOME ?? '',
    PATH: '/usr/bin:/bin',
    SA_PROBE_TOKEN: probe,
    SA_REDACT_CJS: join(dir, 'sa-redact.cjs'),
    SA_GITLEAKS_CONFIG: join(dir, 'gitleaks.toml'),
  };
  const run = (env: Record<string, string>, helper: string) =>
    Bun.spawnSync(['/bin/bash', '--norc', '-c', `. ${helper}; echo MARK $SA_PROBE_TOKEN`], {
      env,
    }).stdout.toString();
  const ok = run(base, rendered);
  expect(ok).toContain('MARK [REDACTED:');
  expect(ok).not.toContain(probe);
  const broken = run(
    { ...base, SA_NODE: '/nonexistent/node' },
    join(import.meta.dir, '../secrets/sa-redact.sh')
  );
  expect(broken).toContain('redactor_unavailable');
  expect(broken).not.toContain(probe);
  // prettier-ignore
  const home = tmp(), bin = join(home, 'bin'), real = join(home, 'real'), jail = join(home, '.wetamp/jail');
  for (const path of [bin, real, jail]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, '.wetamp/secrets.list'), 'SYNTH_TOKEN\n');
  // prettier-ignore
  for (const file of [join(real, 'claude'), join(jail, 'ai-jail')]) writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(join(import.meta.dir, '../bin/ai-jail-shim'), join(bin, 'claude'));
  // prettier-ignore
  const nested = Bun.spawnSync([join(bin, 'claude')], { env: { HOME: home, PATH: `${bin}:${real}:/usr/bin:/bin`, SYNTH_TOKEN: probe }, stderr: 'pipe' });
  expect(nested.exitCode).toBe(0);
  expect(nested.stderr.toString()).toBe('');
});

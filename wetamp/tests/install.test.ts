import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  assertAuthorNotReviewer,
  loadTiers,
  mergeConfig,
  providerOf,
  renderAliases,
} from '../src/config';

const trackTempRoot = trackTempRoots();
const tmp = (): string => trackTempRoot(mkdtempSync(join(tmpdir(), 'sa-test-')));

function runInstall(
  home: string,
  launchd = join(home, 'LaunchAgents'),
  archonHome = join(home, 'archon')
): string {
  const p = Bun.spawnSync([join(import.meta.dir, '..', 'scripts', 'install.sh')], {
    env: {
      ...process.env,
      SUPERAGENT_HOME: home,
      ARCHON_HOME: archonHome,
      SA_LAUNCHD_DIR: launchd,
      SA_SKIP_DOCTOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

describe('install.sh', () => {
  test('idempotent: second run changes nothing and keeps unrelated keys', () => {
    const home = tmp();
    mkdirSync(join(home, 'archon'), { recursive: true });
    writeFileSync(join(home, 'archon', '.env'), 'FOO=bar');
    writeFileSync(
      join(home, 'archon', 'config.yaml'),
      'defaultAssistant: claude\naliases:\n  "@mine": { provider: claude, model: opus }\nconcurrency:\n  maxConversations: 4\n'
    );
    expect(runInstall(home)).toContain('config.yaml');
    const env1 = readFileSync(join(home, 'archon', '.env'), 'utf8');
    const cfg1 = readFileSync(join(home, 'archon', 'config.yaml'), 'utf8');
    expect(env1).toBe('FOO=bar\nARCHON_TELEMETRY_DISABLED=1\nDO_NOT_TRACK=1\n');
    const cfg = Bun.YAML.parse(cfg1) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cfg.defaultAssistant).toBe('claude');
    expect(cfg.aliases['@mine'].model).toBe('opus');
    expect(cfg.aliases['@sa-coder'].provider).toBe('codex');
    expect(cfg.concurrency).toEqual({ maxConversations: 4, providers: { codex: 5, claude: 1 } });
    expect(cfg.workflows.autoResumeOnQuotaReset).toBe(true);
    const backups = readdirSync(join(home, 'archon')).filter(f => f.startsWith('config.yaml.bak-'));
    expect(backups.length).toBe(1);

    expect(runInstall(home).trim()).toBe('');
    expect(readFileSync(join(home, 'archon', '.env'), 'utf8')).toBe(env1);
    expect(readFileSync(join(home, 'archon', 'config.yaml'), 'utf8')).toBe(cfg1);
    expect(
      readdirSync(join(home, 'archon')).filter(f => f.startsWith('config.yaml.bak-')).length
    ).toBe(1);
    for (const d of ['gen', 'runs']) expect(readdirSync(home)).toContain(d);
  });

  test('launchd plist: rendered with escaped paths, left alone when identical, backed up when different', () => {
    const home = join(tmp(), 'a&b');
    const la = join(home, '..', 'LA');
    const plist = join(la, 'com.wetamp.superagent.supervise-tick.plist');
    const first = runInstall(home, la);
    expect(first).toContain('launchctl bootstrap gui/');
    const xml = readFileSync(plist, 'utf8');
    for (const s of [
      '<integer>60</integer>',
      '<string>Background</string>',
      `<string>${home.replace('&', '&amp;')}</string>`,
      `<string>${home.replace('&', '&amp;')}/supervise-tick.log</string>`,
      `<string>${dirname(Bun.which('bun') ?? '')}:`,
      '/wetamp/bin/superagent</string>',
    ])
      expect(xml).toContain(s);
    expect(xml).not.toContain('__');
    expect(runInstall(home, la).trim()).toBe('');
    writeFileSync(plist, 'stale');
    expect(runInstall(home, la)).toContain('launchctl bootstrap');
    expect(readFileSync(plist, 'utf8')).toBe(xml);
    const baks = readdirSync(la).filter(f => f.includes('.plist.bak-'));
    expect(baks.map(f => readFileSync(join(la, f), 'utf8'))).toEqual(['stale']);
  });

  test('launchd plist: ARCHON_HOME is rendered only when set explicitly at install', () => {
    const home = tmp();
    const plist = (la: string): string =>
      readFileSync(join(la, 'com.wetamp.superagent.supervise-tick.plist'), 'utf8');
    runInstall(home, join(home, 'LA1'), join(home, 'custom-archon'));
    expect(plist(join(home, 'LA1'))).toContain(
      `<key>ARCHON_HOME</key>\n    <string>${join(home, 'custom-archon')}</string>`
    );
    runInstall(home, join(home, 'LA2'), ''); // 空值 = 未设置（子进程里删键会被 .env 补回）
    expect(plist(join(home, 'LA2'))).not.toContain('ARCHON_HOME');
    expect(plist(join(home, 'LA2'))).not.toContain('__');
  });
});

describe('aliases', () => {
  test('rendered from tiers.json with cross-vendor alt and per-console reviewer', () => {
    const a = renderAliases(loadTiers());
    expect(a['@sa-coder']).toEqual({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(a['@sa-reviewer']).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
    expect(a['@sa-reviewer-alt'].provider).toBe('claude');
    expect(a['@sa-reviewer-codex'].provider).toBe('claude');
    expect(a['@sa-reviewer-alt-codex'].provider).toBe('codex');
  });

  test('author == reviewer is rejected', () => {
    const a = renderAliases(loadTiers());
    expect(() => assertAuthorNotReviewer({ ...a, '@sa-reviewer': a['@sa-coder'] })).toThrow(
      'equals @sa-coder'
    );
    const t = loadTiers();
    t.routing.reviewer.by_console.claude = [t.routing.coder.models[0]];
    expect(() => mergeConfig(null, t)).toThrow('no reviewer differs');
  });

  test('unknown vendor fails instead of guessing', () => {
    expect(providerOf('claude-opus-5')).toBe('claude');
    expect(() => providerOf('llama-4')).toThrow('unknown vendor');
  });
});

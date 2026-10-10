import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
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
    expect(cfg.assistants.codex.codexBinaryPath).toBe(
      join(import.meta.dir, '..', 'bin', 'codex-worker')
    );
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

describe('install.sh --hooks / --purge-v1 / --remote-hooks', () => {
  const WETAMP = join(import.meta.dir, '..');
  const V1 = (h: string, f: string): string =>
    `node '${join(h, 'work/github/superagent/hooks', f)}'`;
  const V2 = (f: string): string => `node '${join(WETAMP, 'hooks', f)}'`;
  function sandbox(): { home: string; sh: (...args: string[]) => { code: number; out: string } } {
    const home = tmp();
    const sh = (...args: string[]): { code: number; out: string } => {
      const p = Bun.spawnSync(['bash', join(WETAMP, 'scripts', 'install.sh'), ...args], {
        env: {
          ...process.env,
          HOME: home,
          SUPERAGENT_HOME: join(home, '.superagent'),
          CLAUDE_CONFIG_DIR: '',
          CODEX_HOME: '',
          XDG_STATE_HOME: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    return { home, sh };
  }
  const cmds = (file: string): string[][] =>
    Object.entries(
      (
        JSON.parse(readFileSync(file, 'utf8')) as {
          hooks: Record<string, { hooks: { command: string }[] }[]>;
        }
      ).hooks
    ).map(([e, gs]) => [e, ...gs.flatMap(g => g.hooks.map(h => h.command))]);

  test('--hooks rewrites V1 paths, fills missing events, dedupes, keeps other hooks; --dry-run writes nothing', () => {
    const { home, sh } = sandbox();
    const settings = join(home, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const g = (c: string): unknown => ({ hooks: [{ type: 'command', command: c, timeout: 30 }] });
    const before =
      JSON.stringify(
        {
          model: 'x',
          hooks: {
            PreToolUse: [
              g('rtk hook claude'),
              g(`${V1(home, 'guard.cjs')} claude`),
              g(`${V2('guard.cjs')} claude`),
            ],
            Stop: [g(`${V1(home, 'guard.cjs')} claude`)],
          },
        },
        null,
        2
      ) + '\n';
    writeFileSync(settings, before);
    const dry = sh('--hooks', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`+++ ${settings}`);
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(sh('--hooks').code).toBe(0);
    const after = cmds(settings);
    expect(after.find(([e]) => e === 'PreToolUse')).toEqual([
      'PreToolUse',
      'rtk hook claude',
      `${V2('guard.cjs')} claude`,
      V2('context-budget.cjs'),
    ]);
    expect(after.map(([e]) => e)).toEqual([
      'PreToolUse',
      'Stop',
      'SessionStart',
      'PostToolUse',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    expect(JSON.stringify(after)).not.toContain('/work/github/superagent/');
    expect(readdirSync(join(home, '.superagent', 'backups'))[0]).toMatch(/^hooks-\d{8}T\d{6}Z$/);
    expect(sh('--hooks').out.trim()).toBe('hooks: no changes');
  });

  test('--hooks keeps matcher-scoped copies and folds V1 context-budget with or without the claude arg', () => {
    const { home, sh } = sandbox();
    const settings = join(home, '.claude', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    const g = (c: string, matcher?: string): unknown => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: c, timeout: 30 }],
    });
    const guard = `${V1(home, 'guard.cjs')} claude`;
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            g(guard, 'Edit'),
            g(guard, 'Bash'),
            g(`${V1(home, 'context-budget.cjs')} claude`),
            g(V1(home, 'context-budget.cjs')),
          ],
          UserPromptSubmit: [g(`${V1(home, 'context-budget.cjs')} claude`)],
        },
      })
    );
    expect(sh('--hooks').code).toBe(0);
    const pre = (
      JSON.parse(readFileSync(settings, 'utf8')) as {
        hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
      }
    ).hooks;
    const at = (e: string): [string | undefined, string][] =>
      pre[e].flatMap(x => x.hooks.map((h): [string | undefined, string] => [x.matcher, h.command]));
    expect(at('PreToolUse')).toEqual([
      ['Edit', `${V2('guard.cjs')} claude`],
      ['Bash', `${V2('guard.cjs')} claude`],
      [undefined, V2('context-budget.cjs')],
      [undefined, `${V2('guard.cjs')} claude`],
    ]);
    expect(at('UserPromptSubmit')).toEqual([[undefined, V2('context-budget.cjs')]]);
    expect(sh('--hooks').out.trim()).toBe('hooks: no changes');
  });

  test('--hooks creates a missing settings.json/hooks.json with every event; --dry-run diffs against empty and writes nothing', () => {
    const { home, sh } = sandbox();
    const settings = join(home, '.claude', 'settings.json');
    const codex = join(home, '.codex', 'hooks.json');
    const dry = sh('--hooks', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`+++ ${settings}`);
    expect(dry.out).toContain(`+++ ${codex}`);
    expect(dry.out).toContain('@@ -0,0 +1,');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(codex)).toBe(false);
    expect(sh('--hooks').code).toBe(0);
    expect(cmds(settings).map(([e, ...c]) => [e, c.length])).toEqual([
      ['SessionStart', 1],
      ['PreToolUse', 2],
      ['PostToolUse', 1],
      ['SubagentStop', 1],
      ['Stop', 1],
      ['UserPromptSubmit', 1],
    ]);
    expect(cmds(codex).flat()).toContain(`${V2('guard.cjs')} codex`);
    expect(existsSync(join(home, '.superagent', 'backups'))).toBe(false);
    expect(sh('--hooks').out.trim()).toBe('hooks: no changes');
  });

  test('--purge-v1 --dry-run lists managed agents and V1 dirs only; moves nothing', () => {
    const { home, sh } = sandbox();
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'agents', 'coder-1.md'),
      '<!-- superagent:managed:agent x -->'
    );
    writeFileSync(join(home, '.claude', 'agents', 'coder-2.md'), 'mine');
    mkdirSync(join(home, 'work', 'github', 'superagent'), { recursive: true });
    const out = sh('--purge-v1', '--dry-run').out;
    expect(out).toContain(`would move ${join(home, '.claude', 'agents', 'coder-1.md')}`);
    expect(out).not.toContain('coder-2.md');
    expect(out).toContain(`would move ${join(home, 'work', 'github', 'superagent')}`);
    expect(readdirSync(join(home, 'work', 'github'))).toEqual(['superagent']);
  });

  test('worker stub: after --remote-hooks the superagent entry refuses control-plane verbs without bun', () => {
    const { home, sh } = sandbox();
    const entry = join(home, '.local', 'bin', 'superagent');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'old v1 entry');
    const sa = (...args: string[]): { code: number; out: string } => {
      // PATH 不含 bun：桩分支必须在 exec bun 之前
      const p = Bun.spawnSync([entry, ...args], {
        env: { HOME: home, PATH: '/usr/bin:/bin', XDG_STATE_HOME: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    expect(sh('--remote-hooks').code).toBe(0);
    expect(readdirSync(dirname(entry)).filter(f => f.startsWith('superagent.bak-'))).toHaveLength(1);
    expect(sh('--remote-hooks').out).not.toContain('linked');
    for (const verb of ['run', 'wait', 'supervise-tick', 'decide', 'land', 'recover', 'brief', 'status']) {
      const r = sa(verb, 'x');
      expect(r.code).toBe(69);
      expect(r.out).toContain('仅本机运行（本机为控制面）');
    }
    expect(sa('--version')).toMatchObject({ code: 0, out: expect.stringContaining('(worker,') });
    expect(sa('--help')).toMatchObject({ code: 0, out: expect.stringContaining('worker 桩') });
    // install.json 指向别的 checkout：本入口不是那台 worker 的桩，照常走控制面
    const state = join(home, '.local', 'state', 'superagent', 'install.json');
    writeFileSync(state, readFileSync(state, 'utf8').replace(`"wetamp": "${WETAMP}"`, '"wetamp": "/elsewhere"'));
    expect(sa('--version').out).toContain('(controller,');
  });

  test('--remote-hooks checks hooks with node and writes the install.json ledger; flags are exclusive', () => {
    const { home, sh } = sandbox();
    const r = sh('--remote-hooks');
    expect(r.code).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(home, '.local', 'state', 'superagent', 'install.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(ledger).toMatchObject({
      installer: 'superagent_v2',
      mode: 'remote-hooks',
      wetamp: WETAMP,
    });
    expect(ledger.hooks).toContain('guard.cjs');
    expect(ledger.role).toBe('worker');
    expect(sh('--hooks', '--remote-hooks').code).toBe(64);
    expect(sh('--dry-run').code).toBe(64);
  });
});

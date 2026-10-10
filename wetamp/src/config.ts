// tiers.json → Archon 别名；install 只改自己的键并先备份（Bun.YAML 与 Archon updateGlobalConfig 同法，注释不保留，备份兜底）。
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type Console = 'claude' | 'codex';
export interface Alias {
  provider: 'codex' | 'claude';
  model: string;
  effort: string;
}
export const WETAMP = join(import.meta.dir, '..');
/** Archon worker 的 Codex 二进制：前置 exec_profiles 的 -c 并关掉沙箱清单外的 MCP。 */
export const CODEX_WORKER = join(WETAMP, 'bin', 'codex-worker');

export function home(): { sa: string; archon: string } {
  const sa = process.env.SUPERAGENT_HOME;
  const archon = process.env.ARCHON_HOME;
  if (!sa || !archon)
    throw new Error('SUPERAGENT_HOME/ARCHON_HOME unset: run through wetamp/bin/*');
  return { sa, archon };
}

export function providerOf(model: string): Alias['provider'] {
  if (model.startsWith('gpt-')) return 'codex';
  if (model.startsWith('claude-')) return 'claude';
  throw new Error(`unknown vendor for model ${model}`);
}

export interface Tiers {
  routing: { coder: { models: string[] }; reviewer: { by_console: Record<Console, string[]> } };
  health: { vendor_concurrency: Record<string, number> };
  policy: { exec_profiles: Record<'coder' | 'reviewer', { claude: { denied_tools: string[] } }> };
}

export function loadTiers(path = join(WETAMP, 'tiers.json')): Tiers {
  return JSON.parse(readFileSync(path, 'utf8')) as Tiers;
}

const mk = (model: string): Alias => ({ provider: providerOf(model), model, effort: 'high' });

/** 渲染全部别名；console=codex 的评审池用 -codex 后缀别名，run 时由 runAliases 钉成 @sa-reviewer。 */
export function renderAliases(t: Tiers): Record<string, Alias> {
  const coder = mk(t.routing.coder.models[0]);
  const out: Record<string, Alias> = { '@sa-coder': coder };
  for (const c of ['claude', 'codex'] as const) {
    const pool = t.routing.reviewer.by_console[c].map(mk);
    const reviewer = pool.find(a => a.model !== coder.model);
    if (!reviewer) throw new Error(`console ${c}: no reviewer differs from coder ${coder.model}`);
    const alt = pool.find(a => a.provider !== reviewer.provider);
    if (!alt) throw new Error(`console ${c}: no cross-vendor reviewer-alt`);
    const sfx = c === 'claude' ? '' : '-codex';
    out[`@sa-reviewer${sfx}`] = reviewer;
    out[`@sa-reviewer-alt${sfx}`] = alt;
  }
  return out;
}

export function assertAuthorNotReviewer(a: Record<string, Alias>): void {
  const c = a['@sa-coder'];
  for (const k of ['@sa-reviewer', '@sa-reviewer-codex']) {
    if (a[k].provider === c.provider && a[k].model === c.model)
      throw new Error(`${k} equals @sa-coder`);
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};

/**
 * 钉进 run 的别名（Archon run-config 层，优先级高于全局/repo/用户层，resume 继承快照）：
 * 运行中改 config.yaml 或 tiers.json 不影响已启动的 run。不用 `--model`：字面 spec 不带 effort。
 */
export function runAliases(c: Console, t = loadTiers()): Record<string, Alias> {
  const a = renderAliases(t);
  assertAuthorNotReviewer(a);
  const sfx = c === 'codex' ? '-codex' : '';
  return {
    '@sa-coder': a['@sa-coder'],
    '@sa-reviewer': a[`@sa-reviewer${sfx}`],
    '@sa-reviewer-alt': a[`@sa-reviewer-alt${sfx}`],
  };
}

/** 全局与目标 repo 的 config.yaml 里定义的 @sa-* 别名须等于 tiers 渲染值；返回不一致项（run/health 拒绝）。 */
export function aliasDrift(repo?: string, t = loadTiers()): string[] {
  const want = renderAliases(t);
  const files = [join(home().archon, 'config.yaml')];
  if (repo) files.push(join(repo, '.archon', 'config.yaml'));
  const drift: string[] = [];
  for (const f of files.filter(x => existsSync(x))) {
    const have = obj(obj(Bun.YAML.parse(readFileSync(f, 'utf8'))).aliases);
    for (const [k, v] of Object.entries(have)) {
      if (!k.startsWith('@sa-')) continue;
      const got = obj(v);
      const exp = want[k] as Alias | undefined;
      if (!exp || (['provider', 'model', 'effort'] as const).some(x => got[x] !== exp[x]))
        drift.push(`${f}: ${k}`);
    }
  }
  return drift;
}

export function mergeConfig(current: unknown, t: Tiers): Obj {
  const aliases = renderAliases(t);
  assertAuthorNotReviewer(aliases);
  const cfg = { ...obj(current) };
  cfg.aliases = { ...obj(cfg.aliases), ...aliases };
  cfg.workflows = { ...obj(cfg.workflows), autoResumeOnQuotaReset: true, quotaMaxAttempts: 3 };
  const providers: Record<string, number> = {};
  for (const [v, n] of Object.entries(t.health.vendor_concurrency))
    providers[v === 'chatgpt' ? 'codex' : v] = n;
  const conc = obj(cfg.concurrency);
  cfg.concurrency = { ...conc, providers: { ...obj(conc.providers), ...providers } };
  const assistants = obj(cfg.assistants);
  cfg.assistants = {
    ...assistants,
    codex: { ...obj(assistants.codex), codexBinaryPath: CODEX_WORKER },
  };
  return cfg;
}

/** 全局 config.yaml 的 codexBinaryPath 须指向可执行的 codex-worker；返回问题描述（health 拒绝）。 */
export function codexWorkerProblem(): string | null {
  const f = join(home().archon, 'config.yaml');
  const raw = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const got = obj(obj(obj(raw ? Bun.YAML.parse(raw) : null).assistants).codex).codexBinaryPath;
  if (got !== CODEX_WORKER)
    return `${f}: assistants.codex.codexBinaryPath is ${String(got)}, want ${CODEX_WORKER}`;
  try {
    accessSync(CODEX_WORKER, constants.X_OK);
  } catch {
    return `${CODEX_WORKER} is not executable`;
  }
  return null;
}

const ENV_LINES = ['ARCHON_TELEMETRY_DISABLED=1', 'DO_NOT_TRACK=1'];

/** 幂等：内容不变则不写、不备份。返回改动的文件列表。 */
export function install(t = loadTiers()): string[] {
  const { sa, archon } = home();
  for (const d of [archon, join(sa, 'gen'), join(sa, 'runs')]) mkdirSync(d, { recursive: true });
  const changed: string[] = [];
  const envPath = join(archon, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const have = new Set(env.split('\n').map(l => l.trim()));
  const add = ENV_LINES.filter(l => !have.has(l));
  if (add.length) {
    writeFileSync(envPath, env + (env && !env.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
    changed.push(envPath);
  }
  const cfgPath = join(archon, 'config.yaml');
  const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const before = raw ? Bun.YAML.parse(raw) : null;
  const next = mergeConfig(before, t);
  if (JSON.stringify(before) !== JSON.stringify(next)) {
    if (raw)
      copyFileSync(cfgPath, `${cfgPath}.bak-${new Date().toISOString().replace(/[:.]/g, '')}`);
    writeFileSync(cfgPath, Bun.YAML.stringify(next, null, 2) + '\n');
    changed.push(cfgPath);
  }
  return changed;
}

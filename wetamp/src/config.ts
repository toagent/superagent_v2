// tiers.json → Archon 别名；install 只改自己的键并先备份（Bun.YAML 与 Archon updateGlobalConfig 同法，注释不保留，备份兜底）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export type Console = 'claude' | 'codex';
export interface Alias {
  provider: 'codex' | 'claude';
  model: string;
  effort: string;
}
export const WETAMP = join(import.meta.dir, '..');

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

interface Tiers {
  routing: { coder: { models: string[] }; reviewer: { by_console: Record<Console, string[]> } };
  health: { vendor_concurrency: Record<string, number> };
}

export function loadTiers(path = join(WETAMP, 'tiers.json')): Tiers {
  return JSON.parse(readFileSync(path, 'utf8')) as Tiers;
}

const mk = (model: string): Alias => ({ provider: providerOf(model), model, effort: 'high' });

/** 渲染全部别名；console=codex 的评审池用 -codex 后缀别名，run 时经 --model @sa-reviewer=@sa-reviewer-codex 重绑。 */
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
  return cfg;
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

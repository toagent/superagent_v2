// tiers.json → Archon 别名；install 只改自己的键并先备份（Bun.YAML 与 Archon updateGlobalConfig 同法，注释不保留，备份兜底）。
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Pkg } from './plan';
import { QUERY_TIMEOUT_MS } from './archon';

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
  assertSQLite(process.cwd(), archon);
  return { sa, archon };
}

/** Match Archon's env precedence without printing or applying credential values. */
export function assertSQLite(repo: string, archonHome = process.env.ARCHON_HOME): void {
  const { parse } = createRequire(join(WETAMP, '..', 'packages/paths/package.json'))('dotenv') as {
    parse: (text: string) => Record<string, string>;
  };
  let database = process.env.DATABASE_URL;
  for (const path of [archonHome && join(archonHome, '.env'), join(repo, '.archon', '.env')]) {
    if (!path || !existsSync(path)) continue;
    const vars = parse(readFileSync(path, 'utf8'));
    if ('DATABASE_URL' in vars) database = vars.DATABASE_URL;
  }
  if (database)
    throw new Error(
      'superagent is SQLite-only: DATABASE_URL/PostgreSQL is unsupported; use a separate SQLite ARCHON_HOME'
    );
}

/**
 * 原子写：同目录唯一临时文件（pid + 随机后缀，并发写者互不覆盖临时文件）再 rename。读者只会看到旧内容或新内容，
 * 进程中途死掉也不会留下截断的 JSON；失败时删掉临时文件并抛错。
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${crypto.randomUUID()}.tmp`
  );
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * selftest 回执（$SUPERAGENT_HOME/selftest.json）：只由非 fake 的 selftest 写，绑定运行边界、配置哈希与有效期；
 * 显式 selftest 拒绝 fake、过期或漂移的回执。fake 只证明引擎契约，写 selftest-fake.json，不覆盖正式回执。
 */
export const SELFTEST_TTL_MS = 7 * 24 * 3600e3;
export interface Receipt {
  ok: boolean;
  at: string;
  expires_at: string;
  fake: boolean;
  head: string;
  fingerprint?: string;
  config_hash: string;
}
/** wetamp 所在检出的 HEAD；不是 git 检出时为空串（回执无法绑定，selftest 视为漂移）。 */
export function gitHead(repo = WETAMP): string {
  const p = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: QUERY_TIMEOUT_MS,
  });
  return p.exitCode === 0 ? p.stdout.toString().trim() : '';
}
/** Default to inclusion: template Markdown is executable guidance, not documentation. */
const runtimePath = (path: string): boolean =>
  !/^(?:wetamp\/src\/board\/|wetamp\/src\/report\.ts$)/.test(path) &&
  !/^(?:wetamp\/(?:tests|docs)\/|packages\/docs-web\/|\.github\/)/.test(path) &&
  !/(?:^|\/)(?:tests|__tests__)\//.test(path) &&
  !path.endsWith('.test.ts') &&
  (!path.endsWith('.md') || path.startsWith('wetamp/templates/'));

export function runtimeFingerprint(repo = join(WETAMP, '..')): string {
  const git = (...args: string[]): string => {
    const p = Bun.spawnSync(['git', '-C', repo, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: QUERY_TIMEOUT_MS,
    });
    if (p.exitCode !== 0) throw new Error('runtime fingerprint unavailable (git query failed)');
    return p.stdout.toString();
  };
  // Disable rename folding so both old and new paths pass through the same boundary filter.
  const raw = git('status', '--no-renames', '--porcelain', '-z', '-u', '--ignore-submodules=none');
  if (raw.split('\0').some(entry => entry && runtimePath(entry.slice(3))))
    throw new Error('runtime worktree drift (uncommitted runtime files)');
  const tree = git('ls-tree', '--full-tree', '-r', '-z', 'HEAD')
    .split('\0')
    .filter(entry => entry && runtimePath(entry.slice(entry.indexOf('\t') + 1)));
  return new Bun.CryptoHasher('sha256').update(tree.join('\0')).digest('hex');
}
/** 回执绑定的配置：tiers.json 与调用方 $ARCHON_HOME/config.yaml 的内容（任一改动都要重跑 selftest）。 */
export function configHash(): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const p of [join(WETAMP, 'tiers.json'), join(home().archon, 'config.yaml')])
    h.update(`${existsSync(p) ? readFileSync(p, 'utf8') : ''}\0`);
  return h.digest('hex').slice(0, 16);
}
interface Issue {
  kind: 'drift' | 'config-drift' | 'invalid';
  message: string;
}
export function receiptIssue(
  r: Partial<Receipt> | undefined,
  now = Date.now(),
  repo = join(WETAMP, '..')
): Issue | null {
  const issue = (message: string, kind: Issue['kind'] = 'invalid'): Issue => ({ kind, message });
  if (!r) return issue('no selftest.json');
  if (r.ok !== true) return issue('receipt is not a pass');
  if (r.fake !== false)
    return issue('fake receipt (selftest --fake proves only the engine contract)');
  const exp = Date.parse(r.expires_at ?? '');
  if (!(exp > now)) return issue(`expired (expires_at ${r.expires_at ?? '?'})`);
  try {
    const fingerprint = runtimeFingerprint(repo);
    if (r.config_hash !== configHash())
      return issue('config drift (tiers.json or $ARCHON_HOME/config.yaml changed)', 'config-drift');
    if (r.fingerprint !== undefined) {
      if (r.fingerprint !== fingerprint)
        return issue('runtime fingerprint drift (committed runtime files changed)', 'drift');
    } else {
      const head = gitHead(repo);
      if (!head || r.head !== head)
        return issue(
          `HEAD drift (legacy receipt ${(r.head ?? '?').slice(0, 8)}, now ${head.slice(0, 8) || '?'})`,
          head ? 'drift' : 'invalid'
        );
    }
  } catch (e) {
    return issue((e as Error).message);
  }
  return null;
}
export const receiptProblem = (...args: Parameters<typeof receiptIssue>): string | null =>
  receiptIssue(...args)?.message ?? null;

export function providerOf(model: string): Alias['provider'] {
  if (model.startsWith('gpt-')) return 'codex';
  if (model.startsWith('claude-')) return 'claude';
  throw new Error(`unknown vendor for model ${model}`);
}

/** Run admission shares the existing vendor budget; no second capacity setting can drift. */
export function runCapacity(t = loadTiers()): number {
  const caps = Object.values(t.health.vendor_concurrency);
  const capacity = caps.reduce((sum, n) => sum + n, 0);
  if (
    !caps.length ||
    caps.some(n => !Number.isSafeInteger(n) || n < 1) ||
    !Number.isSafeInteger(capacity)
  )
    throw new Error('run admission: vendor_concurrency must contain positive safe integers');
  return capacity;
}

export interface Tiers {
  tiers: Record<string, { pools: Record<string, string[]> }>;
  routing: {
    budget: { claude_daily_usd: number; claude_medium_usd: number; codex_warning_usd: number };
    commander: { by_console: Record<Console, string[]> };
    coder: { models: string[] };
    reviewer: {
      by_console: Record<Console, string[]>;
      by_risk?: Partial<Record<Pkg['risk'], string[]>>;
    };
  };
  health: { vendor_concurrency: Record<string, number> };
  policy: {
    /** Context advisory thresholds consumed by context-advisory.cjs. */
    context: { advisory_tokens: Record<'commander' | 'general' | 'strategist', number> };
    sandbox: { mcp: string[]; network: boolean };
    /** held:gate / held:environment / coder 节点失败各自的自动重试上限（docs/00 自动重试）。 */
    auto_retry: { gate: number; environment: number; coder: number };
    exec_profiles: {
      coder: { codex?: Record<string, unknown>; claude: { denied_tools: string[] } };
      reviewer: {
        codex?: Record<string, unknown>;
        codex_readonly_marker: string;
        claude: { denied_tools: string[]; sandbox: Record<string, unknown> };
      };
    };
    /** 按角色、风险与轮次的推理深度；generate 写到每个 AI 节点的 effort:，覆盖别名的 high（F-17）。 */
    effort: {
      G0: string;
      coder: { first: string; repair: string };
      reviewer: Record<string, string>;
      G2_reviewer: Record<string, string>;
    };
    /** 以下四项写入 <gen>/policy.json，供 sa-check 推断交付风险（F-13）与预留未知用量（F-16）。 */
    risk_paths: string[];
    code_extensions: string[];
    exempt_paths: string[];
    budget_floor: Record<'S' | 'M' | 'L', number>;
  };
}

/**
 * 节点 effort：G0 一律 policy.effort.G0；将军首轮 coder.first、包内修复与里程碑修复 coder.repair；
 * 评审 R<n> 按 G2_reviewer / reviewer。按生成时的声明风险取值（运行时推断升级不改 effort）。
 */
export function effortFor(
  t: Tiers,
  role: 'code' | 'repair' | 'review',
  risk: string,
  round = 1
): string {
  const e = t.policy.effort;
  if (risk === 'G0') return e.G0;
  if (role === 'code') return e.coder.first;
  if (role === 'repair') return e.coder.repair;
  const v = (risk === 'G2' ? e.G2_reviewer : e.reviewer)[`R${String(round)}`];
  if (!v) throw new Error(`tiers.policy.effort: no reviewer effort for ${risk} R${String(round)}`);
  return v;
}

// prettier-ignore
export function loadTiers(path = join(WETAMP, 'tiers.json')): Tiers {
  const t = JSON.parse(readFileSync(path, 'utf8')) as Tiers;
  const budget = obj(t.routing.budget);
  if ([budget.claude_daily_usd, budget.claude_medium_usd, budget.codex_warning_usd].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0))
    throw new Error('tiers.routing.budget: expected nonnegative finite thresholds');
  for (const c of ['claude', 'codex'] as const) {
    const models = obj(obj(obj(t.routing).commander).by_console)[c];
    if (!Array.isArray(models) || !models.length || models.some(m => typeof m !== 'string' || providerOf(m) !== c))
      throw new Error(`tiers.routing.commander.by_console.${c}: expected models for ${c}`);
  }
  return t;
}

export interface Route {
  candidates: Alias[];
  effort: string;
}
/** Only fresh, same-day local observations affect auto routing; never fetch during resolution. */
// prettier-ignore
export function budgetState(t: Tiers, mode = 'auto', now = Date.now()): { degraded: boolean; notice: string; unknown?: true } {
  if (mode !== 'auto') return { degraded: false, notice: '' };
  try {
    if (!process.env.SUPERAGENT_HOME) throw new Error('no cache home');
    const c = JSON.parse(readFileSync(join(process.env.SUPERAGENT_HOME, 'relay-quota.json'), 'utf8')) as { at: number; claude_daily_usd: number };
    if (!Number.isFinite(c.at) || c.at > now || now - c.at > 3600e3 || new Date(c.at).toDateString() !== new Date(now).toDateString() || !Number.isFinite(c.claude_daily_usd) || c.claude_daily_usd < 0) throw new Error('invalid cache');
    const degraded = c.claude_daily_usd >= t.routing.budget.claude_daily_usd;
    return { degraded, notice: degraded ? '已降级到 Codex' : '' };
  } catch { return { degraded: false, notice: '预算状态未知', unknown: true }; }
}
/** One resolver owns role/risk/round and mode filtering; no vendor inference at execution time. */
// prettier-ignore
export function resolveRoute(
  t: Tiers,
  console: Console,
  mode = 'auto',
  role: 'code' | 'repair' | 'review' | 'command' = 'code',
  risk: Pkg['risk'] = 'G1',
  round = 1,
  authors: string[] = []
): Route {
  if (!['auto', 'strict', 'single:claude', 'single:chatgpt'].includes(mode))
    throw new Error(`unsupported routing mode: ${mode}`);
  if (budgetState(t, mode).degraded) { mode = 'single:chatgpt'; console = 'codex'; }
  const vendor = mode === 'single:claude' ? 'claude' : mode === 'single:chatgpt' ? 'codex' : null;
  const models =
    role === 'command' ? t.routing.commander.by_console[console] : role === 'review'
      ? (t.routing.reviewer.by_risk?.[risk] ?? t.routing.reviewer.by_console[console])
      : t.routing.coder.models;
  const effort = effortFor(t, role === 'command' ? 'code' : role, risk, round);
  const candidates = [...new Set(models)]
    .map(model => ({ model, provider: providerOf(model), effort }))
    // Code and repair default to Codex; Claude requires an explicit single:claude mode.
    .filter(a => vendor !== null || role === 'review' || role === 'command' || a.provider === 'codex')
    .filter(
      a => (role === 'command' || !vendor || a.provider === vendor) && (role !== 'review' || !authors.includes(a.model))
    );
  if (!candidates.length)
    throw new Error(`mode ${mode}: no eligible ${role} model for ${risk} R${String(round)}`);
  return { candidates, effort };
}

/** JSON key order never changes the policy's content identity. */
const { snapshotPolicy: buildPolicySnapshot } = createRequire(import.meta.url)(
  '../bin/codex-readonly-proxy.cjs'
) as {
  snapshotPolicy: (tiers: Tiers) => ReturnType<typeof snapshotPolicy>;
};
export function snapshotPolicy(
  t: Tiers
): Tiers['policy'] & { hash: string; routing: Tiers['routing']; health: Tiers['health'] } {
  return buildPolicySnapshot(t);
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
export function runAliases(c: Console, t = loadTiers(), mode = 'auto'): Record<string, Alias> {
  const coder = resolveRoute(t, c, mode).candidates[0];
  const reviewers = resolveRoute(t, c, mode, 'review', 'G1', 1, [coder.model]).candidates;
  const reviewer = reviewers[0];
  return {
    '@sa-coder': { ...coder, effort: 'high' },
    '@sa-reviewer': { ...reviewer, effort: 'high' },
    '@sa-reviewer-alt': {
      ...(reviewers.find(a => a.provider !== reviewer.provider) ?? reviewers.at(1) ?? reviewer),
      effort: 'high',
    },
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
    writeAtomic(cfgPath, Bun.YAML.stringify(next, null, 2) + '\n');
    changed.push(cfgPath);
  }
  return changed;
}

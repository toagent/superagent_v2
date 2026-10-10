// 三端 hook 条目与 V1 残留。只动 superagent 自己的 handler（V1 路径或本 wetamp/hooks/），其他 hooks 原样保留；
// 真正写入/移动前先备份到 $SUPERAGENT_HOME/backups/；--dry-run 只打印统一 diff 或清单。
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { WETAMP } from './config';

interface Handler {
  type?: string;
  command?: unknown;
  [k: string]: unknown;
}
interface Group {
  hooks?: Handler[];
  [k: string]: unknown;
}
type Hooks = Record<string, Group[]>;
type Client = 'claude' | 'codex';

// V1 的 checkout 与 release 安装都算 V1：只改写其一会让同一事件挂两份 guard
const V1_HOOKS =
  /[^\s'"]*(?:\/work\/github\/superagent|\/\.local\/share\/superagent\/releases\/[^/\s'"]+)\/hooks\//g;
const isV1 = (c: string): boolean => new RegExp(V1_HOOKS.source).test(c);
const V2_HOOKS = join(WETAMP, 'hooks') + '/';
// 空串与未设置同样回落到默认（与 shell 的 ${X:-default} 一致）
const envOr = (key: string, fallback: string): string => {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
};
const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const cmd = (file: string, client?: Client): string =>
  `node ${quote(V2_HOOKS + file)}${client ? ` ${client}` : ''}`;

/** V1 register-guards 的事件清单与顺序：guard 五个事件；Claude 另有 context-budget 两个。 */
export function wanted(client: Client): [string, string][] {
  const guard = ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'Stop'].map(
    (e): [string, string] => [e, cmd('guard.cjs', client)]
  );
  if (client === 'codex') return guard;
  return [
    ...guard,
    ...['UserPromptSubmit', 'PreToolUse'].map((e): [string, string] => [
      e,
      cmd('context-budget.cjs'),
    ]),
  ];
}

const paths = (): Record<Client, string> => ({
  claude: join(envOr('CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'settings.json'),
  codex: join(envOr('CODEX_HOME', join(homedir(), '.codex')), 'hooks.json'),
});
const ours = (h: Handler): boolean =>
  typeof h.command === 'string' && (isV1(h.command) || h.command.includes(V2_HOOKS));

// context-budget 不读 client 参数：V1 尾部带不带 claude 都是同一个 handler
const canonical = (c: string): string =>
  c.replace(V1_HOOKS, V2_HOOKS).replace(/(context-budget\.cjs'?)\s+claude\s*$/, '$1');
// 组级执行条件（matcher 等 hooks 以外的键）；未设置、空串与 '*' 都是"全部"
const condition = (g: Group): string => {
  const all = g.matcher === undefined || g.matcher === '' || g.matcher === '*';
  return JSON.stringify({ ...g, hooks: undefined, matcher: all ? '*' : g.matcher });
};
const ALL = condition({});

/** V1 路径改写为本 wetamp/hooks/、按（事件 × 执行条件 × command）去重、按 V1 清单补齐；purge 时只删 V1 条目。 */
export function mergeHooks(hooks: Hooks, client: Client, purge = false): Hooks {
  const out: Hooks = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const seen = new Set<string>();
    out[event] = groups.flatMap(g => {
      if (!Array.isArray(g.hooks)) return [g];
      const kept = g.hooks.flatMap(h => {
        if (!ours(h)) return [h];
        const c = h.command as string;
        if (purge) return isV1(c) ? [] : [h];
        const next = canonical(c);
        const key = `${condition(g)}\0${next}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...h, command: next }];
      });
      return kept.length || !g.hooks.length ? [{ ...g, hooks: kept }] : [];
    });
  }
  // purge 掉最后一个条目的事件整体移除；原本就为空的事件保留
  if (purge)
    return Object.fromEntries(Object.entries(out).filter(([e, g]) => g.length || !hooks[e].length));
  // V1 清单的条目都不带 matcher：只挂在 matcher=Edit 之类分组里的同一 command 不算已注册
  for (const [event, command] of wanted(client)) {
    const list = (out[event] ??= []);
    if (!list.some(g => condition(g) === ALL && g.hooks?.some(h => h.command === command)))
      list.push({ hooks: [{ type: 'command', command, timeout: 30 }] });
  }
  return out;
}

/** 新文本：只有命令串改写时原地替换字符串字面量（保留文件排版），结构变化才整体重排。 */
function render(raw: string, client: Client, purge: boolean): string {
  const doc = JSON.parse(raw || '{}') as { hooks?: Hooks };
  const next = mergeHooks(doc.hooks ?? {}, client, purge);
  if (JSON.stringify(next) === JSON.stringify(doc.hooks ?? {})) return raw;
  let text = raw || '{}';
  for (const m of new Set(raw.match(V1_HOOKS) ?? [])) text = text.replaceAll(m, V2_HOOKS);
  // 原地替换只在结果与结构化合并完全一致（含 hooks 以外的键未被波及）时采用
  const same =
    JSON.stringify({ ...(JSON.parse(text) as object), hooks: next }) ===
    JSON.stringify({ ...doc, hooks: next });
  if (
    !purge &&
    same &&
    JSON.stringify((JSON.parse(text) as { hooks?: Hooks }).hooks) === JSON.stringify(next)
  )
    return text;
  return (
    JSON.stringify({ ...doc, hooks: next }, null, 2) + (!raw || raw.endsWith('\n') ? '\n' : '')
  );
}

const utc = (): string => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
const backups = (): string =>
  join(envOr('SUPERAGENT_HOME', join(homedir(), '.superagent')), 'backups');

function diff(file: string, before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-hooks-'));
  try {
    writeFileSync(join(dir, 'a'), before);
    writeFileSync(join(dir, 'b'), after);
    return Bun.spawnSync([
      'diff',
      '-u',
      '--label',
      file,
      '--label',
      file,
      join(dir, 'a'),
      join(dir, 'b'),
    ]).stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 返回 diff 文本（dry-run 不写）；写入前把原文件复制到 backups/hooks-<UTC>/。目标不存在时按空文件补齐并创建。 */
export function installHooks(dryRun: boolean, purge = false): string {
  let out = '';
  const stamp = utc();
  for (const [client, file] of Object.entries(paths()) as [Client, string][]) {
    const exists = existsSync(file);
    if (!exists && purge) continue;
    const raw = exists ? readFileSync(file, 'utf8') : '';
    const next = render(raw, client, purge);
    if (next === raw) continue;
    out += diff(file, raw, next);
    if (dryRun) continue;
    if (exists) {
      const dir = join(backups(), `${purge ? 'v1' : 'hooks'}-${stamp}`, client);
      mkdirSync(dir, { recursive: true });
      cpSync(file, join(dir, basename(file)));
    } else mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.sa-tmp`, next);
    renameSync(`${file}.sa-tmp`, file);
  }
  return out;
}

/** V1 文件残留：带 managed 标记的子代理、release/state 目录、V1 checkout（--hooks 产生的 V2 install.json 所在目录除外）。 */
export function v1Leftovers(): string[] {
  const h = homedir();
  const agents = ['coder-1', 'coder-2', 'reviewer-1', 'reviewer-2', 'reviewer-3']
    .map(n => join(envOr('CLAUDE_CONFIG_DIR', join(h, '.claude')), 'agents', `${n}.md`))
    .filter(f => existsSync(f) && readFileSync(f, 'utf8').includes('superagent:managed:agent'));
  const state = join(envOr('XDG_STATE_HOME', join(h, '.local', 'state')), 'superagent');
  const v2State =
    existsSync(join(state, 'install.json')) &&
    readFileSync(join(state, 'install.json'), 'utf8').includes('"superagent_v2"');
  const dirs = [
    join(h, '.local', 'share', 'superagent', 'releases'),
    ...(v2State ? [] : [state]),
    join(h, 'work', 'github', 'superagent'),
  ];
  return [...agents, ...dirs.filter(d => existsSync(d))];
}

/** 先清 settings/hooks.json 里的 V1 条目，再把残留整体移到 backups/v1-<UTC>/（保留原绝对路径结构，永不删除）。 */
export function purgeV1(dryRun: boolean): string {
  const items = v1Leftovers();
  let out = installHooks(dryRun, true);
  out += items.map(p => `${dryRun ? 'would move' : 'moved'} ${p}\n`).join('');
  if (dryRun) return out;
  const dest = join(backups(), `v1-${utc()}`, 'files');
  for (const p of items) {
    const to = join(dest, p);
    mkdirSync(join(to, '..'), { recursive: true });
    renameSync(p, to);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const out = args.includes('--purge-v1') ? purgeV1(dry) : installHooks(dry);
  process.stdout.write(out || 'hooks: no changes\n');
}

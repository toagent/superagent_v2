// `superagent board [run] [--once] [--json] [--interval s] [--limit n] [--view cockpit|terminals] [--all]`：run 看板。
// ink/react 只在这里动态 import（wetamp/package.json 自有依赖）；--json 不渲染，不需要它们。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_USAGE, parseArgs } from '../cli';
import { WETAMP, home } from '../config';
import { createLoader, readLedger, type BoardRow, type Snapshot } from './data';
import { detailOf, type Detail } from './detail';
import { startWeb, webUrl } from '../web/server';
import { requestUsageRefresh } from '../usage';

const USAGE = 'usage: superagent board [run] [--once] [--json] [--interval s] [--limit n] [--view cockpit|terminals] [--all]';

const positive = (v: string | undefined, dflt: number, name: string): number => {
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
};

const detailFor = (row: BoardRow): Detail | null => {
  const l = readLedger(row.run_id);
  return typeof l === 'string' ? null : detailOf(l, row);
};

export async function board(argv: string[]): Promise<number> {
  // 任何返回路径（含 q 退出）都中止加载器：杀掉还在跑的 workflow get 子进程，不留给超时
  const ac = new AbortController();
  try {
    return await run(argv, ac.signal);
  } finally {
    ac.abort();
  }
}

async function run(argv: string[], signal: AbortSignal): Promise<number> {
  let interval: number, limit: number, target: string | undefined, a: ReturnType<typeof parseArgs>;
  let view: 'cockpit' | 'terminals' = 'cockpit';
  let load: ReturnType<typeof createLoader>;
  try {
    const args = [...argv], i = args.indexOf('--view');
    if (i !== -1) { view = args[i + 1] as typeof view; args.splice(i, 2); if (view !== 'cockpit' && view !== 'terminals') throw new Error('--view must be cockpit or terminals'); }
    a = parseArgs(args);
    target = a._[1];
    interval = positive(a.flags.interval, 5, 'interval');
    limit = Math.floor(positive(a.flags.limit, Number.MAX_SAFE_INTEGER, 'limit'));
    const base = createLoader(signal);
    let url: string | undefined;
    load = async n => ({ ...await base(n), web_url: url });
    if (!a.flags.json && process.env.NODE_ENV !== 'test') { try { url = webUrl(await startWeb()); } catch (e) { console.error(`web: ${(e as Error).message}`); } }
    if (process.env.NODE_ENV !== 'test') requestUsageRefresh();
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  // --once 也经 ink 的 renderToString 出帧，只有 --json 不需要 ink；在首轮加载前检查，缺依赖不白等查询
  if (!a.flags.json && !existsSync(join(WETAMP, 'node_modules', 'ink'))) {
    console.error(`board: ink is not installed; run: cd ${WETAMP} && bun install`);
    return EXIT_USAGE;
  }
  const first: Snapshot = await load(limit);
  const pick = target ? first.rows.find(r => r.run_id === target) : undefined;
  if (target && !pick) {
    console.error(`board: run ${target} not among the ${String(limit)} newest ledgers`);
    return EXIT_USAGE;
  }

  if (a.flags.json) {
    const selected = pick ? detailFor(pick) : undefined;
    console.log(
      JSON.stringify(
        {
          summary: first.summary,
          rows: first.rows,
          ...first.activity,
          ...(pick ? { selected } : {}),
        },
        null,
        2
      )
    );
    return 0;
  }

  const [{ createElement }, ink, { App, Frame }] = await Promise.all([
    import('react'),
    import('ink'),
    import('./App'),
  ]);

  if (a.flags.once || !process.stdout.isTTY) {
    // 管道里没有终端宽度：认 COLUMNS（与 shell 一致），再没有就按宽屏出全列
    const width = process.stdout.columns || Number(process.env.COLUMNS) || 160;
    const frame = createElement(Frame, {
      snap: first,
      view,
      all: !!a.flags.all,
      home: home().sa,
      width,
      height: Number.MAX_SAFE_INTEGER, // 一帧文本不滚动：全部行都打出来
      interval,
      sel: pick ? first.rows.indexOf(pick) : -1,
      activeOnly: false,
      detail: pick ? detailFor(pick) : null,
      now: new Date(),
      footer: false,
    });
    console.log(ink.renderToString(frame, { columns: width }));
    return 0;
  }

  const app = ink.render(
    createElement(App, { load: () => load(limit), detailFor, first, home: home().sa, interval, view })
  );
  await app.waitUntilExit();
  return 0;
}

if (import.meta.main) {
  try { process.exit(await board(process.argv.slice(2))); }
  catch (e) { console.error(`superagent: ${(e as Error).message}`); process.exit(1); }
}

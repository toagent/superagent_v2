// board 详情：选中 run 的 plan 包、gate 各轮结论、transcript 末尾事件、待决签收与下一步命令。只读，任何一项读不到只影响该项。
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { milestones, type Plan } from '../plan';
import { asksOf, gatesOf, readJson, type Asks, type Gate, type Ledger } from '../cli';
import { tail } from '../archon';
import { confined, elapsedAt, fmtClock, fmtElapsed, type BoardRow } from './data';

export interface Detail {
  run_id: string;
  plan: string | null;
  packages: { id: string; milestone: string; risk: string; signoff: string }[];
  milestones: { id: string; risk: string; human: boolean }[];
  gates: {
    milestone: string;
    round: number;
    verdict: string;
    reason: string | null;
    debt: number;
  }[];
  events: { type: string; node: string | null; ts: string | null; out?: string }[];
  asks: Asks;
  needs: { tag: string; cap: string; minimal_ask: string }[];
  next: string[];
  errors: string[];
}

// 带引号的值（支持 \" 转义；被上游截断、没有收尾引号时到行尾）
const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`;
const SECRETS: RegExp[] = [
  // Authorization 的整个值（ApiKey x、Bearer x、Basic x…）：到行尾或到所在 JSON 字符串的收尾引号
  new RegExp(String.raw`\b(authorization)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:[^"\\\n]|\\.)*)`, 'gi'),
  new RegExp(
    String.raw`\b([\w-]*(?:token|key|secret|password)[\w-]*)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:bearer\s+)?[^\s"',;}]+)`,
    'gi'
  ),
  /\b(bearer)(\s+)[^\s"',;}]+/gi,
];

/**
 * 值脱敏（与 codex-worker M-03 同一组键名）：`token=…`、`password="a b"`、`"api_key":"…"`、`Authorization: …`、
 * `Bearer …` 的值整体换成 ***。调用方先对整段脱敏再截尾：先截尾可能把键名截掉、只剩裸值。
 */
export const redact = (s: string): string => SECRETS.reduce((t, re) => t.replace(re, '$1$2***'), s);

// 流式 token 与看门狗心跳占 transcript 绝大多数行，留着末 8 条就只剩噪声
const NOISE = new Set(['provider_event', 'watchdog_reset']);
const EVENTS = 8;
const OUT_TAIL = 120;

function events(file: string): Detail['events'] {
  const out: Detail['events'] = [];
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < EVENTS; i--) {
    let e: { type?: string; step?: string | null; ts?: string; stdout_tail?: string };
    try {
      e = JSON.parse(lines[i]) as typeof e;
    } catch {
      continue; // 写到一半的末行
    }
    if (!e.type || NOISE.has(e.type)) continue;
    out.unshift({
      type: e.type,
      node: e.step ?? null,
      ts: e.ts ?? null,
      ...(e.type === 'exec_output' ? { out: tail(redact(e.stdout_tail ?? ''), OUT_TAIL) } : {}),
    });
  }
  return out;
}

/** ledger.plan 相对 ledger.repo（run 时的写法），不存在时用生成目录里的副本；越界抛错（confined）。 */
function planOf(l: Ledger): string {
  const p =
    confined(l, isAbsolute(l.plan) ? l.plan : resolve(l.repo, l.plan)) ??
    confined(l, join(l.gen_dir, 'plan.json'));
  if (!p) throw new Error(`no plan at ${l.plan} or ${l.gen_dir}/plan.json`);
  return p;
}

export function detailOf(l: Ledger, row: BoardRow): Detail {
  const d: Detail = {
    run_id: l.run_id,
    plan: null,
    packages: [],
    milestones: [],
    gates: [],
    events: [],
    asks: {},
    needs: [],
    next: [],
    errors: [],
  };
  const part = (name: string, f: () => void): void => {
    try {
      f();
    } catch (e) {
      d.errors.push(`${name}: ${tail((e as Error).message, 200)}`);
    }
  };
  part('plan', () => {
    d.plan = planOf(l);
    const plan = JSON.parse(readFileSync(d.plan, 'utf8')) as Plan;
    d.packages = plan.packages.map(p => ({
      id: p.id,
      milestone: p.milestone ?? 'm1',
      risk: p.risk,
      signoff: p.signoff ?? 'auto',
    }));
    d.milestones = milestones(plan).map(m => ({ id: m.id, risk: m.risk, human: m.human }));
  });
  part('gates', () => {
    const art = confined(l, row.evidence);
    for (const f of art ? gatesOf(art) : []) {
      const [, milestone, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
      const file = confined(l, join(art ?? '', f)); // 证据目录里的软链也可能指向外面
      if (!file) continue;
      const g = readJson(file) as Gate;
      d.gates.push({
        milestone,
        round: Number(round),
        verdict: g.verdict,
        reason: g.reason,
        debt: g.debt.length,
      });
    }
  });
  part('transcript', () => {
    const t = confined(l, l.transcript);
    if (t) d.events = events(t);
  });
  part('needs', () => {
    const art = confined(l, row.evidence);
    for (const f of art ? readdirSync(art).filter(x => x.endsWith('.coder.json')) : []) {
      const file = confined(l, join(art ?? '', f));
      if (!file) continue;
      const c = readJson(file) as { needs?: { cap: string; minimal_ask: string }[] };
      const tag = f.slice(0, -'.coder.json'.length);
      for (const n of c.needs ?? []) d.needs.push({ tag, cap: n.cap, minimal_ask: n.minimal_ask });
    }
  });
  part('asks', () => {
    d.asks = asksOf(l.run_id);
  });
  if (row.state.startsWith('held:'))
    d.next = [
      `superagent decide ${l.run_id} approve|reject|retry [--pkg id]`,
      `superagent accept ${l.run_id}`,
      `superagent recover ${l.run_id}`,
    ];
  return d;
}

/** 详情面板与 --once 共用的纯文本行；时刻按本地时区，row 为该 run 当前的行（开始与耗时随 now 走）。 */
export function detailLines(d: Detail, now: number, row?: BoardRow): string[] {
  const clock = row
    ? `  开始 ${fmtClock(row.started_at, now)} · 耗时 ${fmtElapsed(elapsedAt(row, now))}`
    : '';
  const out = [`── ${d.run_id}${clock}  plan ${d.plan ?? '(missing)'}`];
  if (d.milestones.length)
    out.push(
      `milestones ${d.milestones.map(m => `${m.id}:${m.risk}${m.human ? ':human' : ''}`).join(' ')}`
    );
  if (d.packages.length)
    out.push(
      `packages   ${d.packages.map(p => `${p.id}(${p.milestone},${p.risk},${p.signoff})`).join(' ')}`
    );
  for (const g of d.gates)
    out.push(
      `gate ${g.milestone} r${String(g.round)} ${g.verdict}${g.reason ? ` (${g.reason})` : ''} debt=${String(g.debt)}`
    );
  for (const e of d.events)
    out.push(
      `${e.ts ? fmtClock(e.ts, now) : '--:--:--'} ${e.type} ${e.node ?? ''}${e.out ? ` │ ${e.out.replace(/\s+/g, ' ')}` : ''}`
    );
  for (const [k, a] of Object.entries(d.asks)) out.push(`ask ${k} ${a?.status ?? '?'}`);
  for (const n of d.needs) out.push(`need ${n.cap} (${n.tag}): ${n.minimal_ask}`);
  for (const n of d.next) out.push(`next: ${n}`);
  for (const e of d.errors) out.push(`! ${e}`);
  return out;
}

// board 详情：选中 run 的 plan 包、gate 各轮结论、transcript 末尾事件、待决签收与下一步命令。只读，任何一项读不到只影响该项。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { milestones, type Plan } from '../plan';
import { asksOf, gatesOf, readJson, type Asks, type Gate, type Ledger } from '../cli';
import { tail } from '../archon';
import type { BoardRow } from './data';

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
  next: string[];
  errors: string[];
}

/**
 * 值脱敏（与 codex-worker M-03 同一组键名）：`token=…`、`"api_key": "…"`、`Authorization: Bearer …` 的值换成 ***。
 * 先对整段脱敏再截尾：先截尾可能把键名截掉、只剩裸值。
 */
export const redact = (s: string): string =>
  s.replace(
    /\b(authorization|bearer|[\w-]*(?:token|key|secret|password)[\w-]*)(["']?\s*[:=]?\s*["']?\s*)(?:bearer\s+)?[^\s"',;}]+/gi,
    '$1$2***'
  );

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

/** ledger.plan 相对 ledger.repo（run 时的写法），不存在时用生成目录里的副本。 */
function planOf(l: Ledger): string | null {
  const candidates = [
    isAbsolute(l.plan) ? l.plan : resolve(l.repo, l.plan),
    join(l.gen_dir, 'plan.json'),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

export function detailOf(l: Ledger, row: BoardRow): Detail {
  const d: Detail = {
    run_id: l.run_id,
    plan: planOf(l),
    packages: [],
    milestones: [],
    gates: [],
    events: [],
    asks: {},
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
    if (!d.plan) throw new Error(`no plan at ${l.plan} or ${l.gen_dir}/plan.json`);
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
    for (const f of gatesOf(row.evidence)) {
      const [, milestone, round] = /^gate-(.+)-r(\d+)\.json$/.exec(f) ?? [];
      const g = readJson(join(row.evidence, f)) as Gate;
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
    if (existsSync(l.transcript)) d.events = events(l.transcript);
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

/** 详情面板与 --once 共用的纯文本行。 */
export function detailLines(d: Detail): string[] {
  const out = [`── ${d.run_id}  plan ${d.plan ?? '(missing)'}`];
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
      `${e.ts?.slice(11, 19) ?? '--:--:--'} ${e.type} ${e.node ?? ''}${e.out ? ` │ ${e.out.replace(/\s+/g, ' ')}` : ''}`
    );
  for (const [k, a] of Object.entries(d.asks)) out.push(`ask ${k} ${a?.status ?? '?'}`);
  for (const n of d.next) out.push(`next: ${n}`);
  for (const e of d.errors) out.push(`! ${e}`);
  return out;
}

// 留样只允许判定字段；不复制输出全文、prompt、转录、argv、命令或日志。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { home, writeAtomic } from './config';
import type { Plan } from './plan';
import { CODER_CLASSES, reasonOf } from './reasons';
const tokens: Partial<Record<string, readonly string[]>> = { status: ['done', 'partial', 'blocked', 'PASS', 'FAIL', 'INCOMPLETE'], error_class: CODER_CLASSES, disposition: ['advance', 'repair', 'suspend'] };
const fields = [
  'ok',
  'status',
  'error_class',
  'disposition',
  'reason',
  'self_report_conflict',
  'error_class_ignored',
  'coder_partial',
  'same',
] as const;
export const decisionFields = (value: unknown): Record<string, unknown> => {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { ...(typeof v.reason === 'string' && !reasonOf(v.reason) ? { unregistered_reason: true } : {}), ...Object.fromEntries(
    fields
      .filter(
        k =>
          typeof v[k] === 'boolean' ||
          v[k] === null ||
          (typeof v[k] === 'string' && (k === 'reason' ? !!reasonOf(v[k]) : tokens[k]?.includes(v[k])))
      )
      .map(k => [k, v[k]])
  ) };
};
export function saveIncident(
  run: string,
  art: string,
  node: string,
  plan: Plan,
  fingerprint: { run: string | null; current: string }
): void {
  if (basename(run) !== run || run === '..' || !run) throw new Error('invalid incident run');
  const dir = join(home().sa, 'incidents', run);
  if (existsSync(dir)) return;
  mkdirSync(join(home().sa, 'incidents'), { recursive: true });
  const tmp = `${dir}.${crypto.randomUUID()}.tmp`;
  mkdirSync(tmp);
  try {
    const data: Record<string, unknown> = {};
    const pkg = node.replace(/^(verify|settle|code|repair)-/, '');
    for (const tag of [
      node,
      node.replace(/^gate-/, 'diff-'),
      `${node}.review`,
      `verify-${pkg}`,
      `verify-${pkg}.coder`,
      `settle-${pkg}.coder`,
    ]) {
      const path = join(art, `${tag}.json`);
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8');
        try {
          data[tag] = decisionFields(JSON.parse(raw));
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          data[tag] = { invalid_json: true };
        }
      }
    }
    writeAtomic(
      join(tmp, 'sample.json'),
      JSON.stringify(
        {
          inputs_outputs: data,
          plan: {
            packages: plan.packages.map(p => ({ id: p.id, milestone: p.milestone, risk: p.risk })),
          },
          fingerprint,
        },
        null,
        2
      ) + '\n'
    );
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!existsSync(dir)) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

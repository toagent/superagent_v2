import { readFileSync } from 'node:fs';
import { caller, coord, type Message } from './index';
export const COORD_OPTIONS = {
  to: { type: 'string' },
  kind: { type: 'string' },
  'body-file': { type: 'string' },
  evidence: { type: 'string', multiple: true },
  severity: { type: 'string' },
  takeover: { type: 'boolean' },
  reason: { type: 'string' },
  ack: { type: 'string' },
  note: { type: 'string' },
} as const;
interface Args {
  _: string[];
  flags: {
    to?: string;
    kind?: string;
    'body-file'?: string;
    evidence?: string[];
    severity?: string;
    takeover?: boolean;
    reason?: string;
    ack?: string;
    note?: string;
    title?: string;
    all?: boolean;
  };
}
export function coordinationCommand(a: Args): unknown {
  const c = coord(),
    [verb, target] = a._;
  if (verb === 'owner') return c.owner(c.scope(target));
  const who = caller();
  if (verb === 'claim') {
    if (a.flags.takeover && !a.flags.reason?.trim())
      throw new Error('claim --takeover needs --reason "<原话>"');
    const scope = c.scope(target);
    return scope.kind === 'run'
      ? c.claimRun(scope, who, a.flags.takeover, a.flags.reason)
      : c.claim(scope, who, a.flags.takeover, a.flags.reason);
  }
  if (verb === 'reauthorize') {
    const run = target && c.resolveRun(target);
    if (!run) throw new Error('reauthorize <run>');
    return c.reauthorize(run, who);
  }
  if (verb === 'release') {
    c.release(c.scope(target), who);
    return { ok: true };
  }
  if (verb === 'inbox') {
    if (a.flags.ack) {
      if (!['accepted', 'rejected', 'done'].includes(target))
        throw new Error('inbox --ack <id> accepted|rejected|done');
      c.ack(a.flags.ack, who, target as 'accepted' | 'rejected' | 'done', a.flags.note ?? '');
    }
    return { messages: c.inbox(who, a.flags.all) };
  }
  if (
    !a.flags.to ||
    !a.flags.title ||
    !a.flags['body-file'] ||
    !['bug', 'task', 'question', 'takeover-request'].includes(a.flags.kind ?? '')
  )
    throw new Error(
      'handoff --to <path|run> --kind bug|task|question|takeover-request --title <title> --body-file <md>'
    );
  if (a.flags.severity && !['normal', 'urgent'].includes(a.flags.severity))
    throw new Error('--severity normal|urgent');
  return c.handoff(c.scope(a.flags.to), who, {
    kind: a.flags.kind as Message['kind'],
    title: a.flags.title,
    body: readFileSync(a.flags['body-file'], 'utf8'),
    evidence: a.flags.evidence ?? [],
    severity: (a.flags.severity ?? 'normal') as Message['severity'],
  });
}

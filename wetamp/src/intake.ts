import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeAtomic } from './config';
import { lock } from './archon';
import type { DeliveryDecision } from '../templates/.archon/scripts/sa-check';

export interface Input {
  source: string;
  session: string;
  message: string;
  text: string;
  repo: string;
  actor: string;
  owner: string;
}
export interface Binding {
  revision: number;
  launch_id: string;
  plan: string;
  digest: string;
  dispatch: 'dispatch_unknown' | 'accepted';
  run_id?: string;
}
interface Question {
  id: string;
  revision: number;
  owner: string;
  run_id: string;
  gate: string;
  prompt: string;
  answer?: { value: string; input: string };
}
export interface Task {
  id: string;
  repo: string;
  actor: string;
  owner: string;
  revision: number;
  revisions: { brief: string; acceptance: string; input: string }[];
  dependencies: string[];
  parent?: string;
  questions: Question[];
  runs: Binding[];
  cancellations: { revision: number; input: string }[];
}
type Target = { task: string };
type Versioned = Target & { expected_revision: number };
export type Action = (
  | { kind: 'create'; ref: string; brief: string; acceptance: string; dependencies?: string[]; parent?: string }
  | (Versioned & { kind: 'amend'; brief: string; acceptance: string; dependencies?: string[] })
  | (Versioned & { kind: 'question'; id: string; run_id: string; gate: string; prompt: string })
  | (Target & { kind: 'answer'; question: string; value: string })
  | (Versioned & { kind: 'cancel' })
  | (Versioned & { kind: 'launch'; launch_id: string; plan: string; digest: string })
  | (Target & { kind: 'bind'; launch_id: string; run_id: string; plan: string; digest: string })
  | { kind: 'clarify'; fragment: string }
) & { group?: string };
export interface Result {
  status: 'accepted' | 'pending' | 'rejected';
  task?: string;
  reason?: string;
}
interface Received {
  input: Input;
  actions?: unknown[];
  ids?: string[];
  results?: Result[];
}
interface State {
  version: 1;
  tasks: Task[];
  inputs: Received[];
}
const fail = (reason: string): never => {
  throw new Error(`intake: ${reason}`);
};
const str = (x: unknown): string => typeof x === 'string' && x.trim() ? x : fail('expected nonempty string');
const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail('expected object');
const strings = (x: unknown): string[] => Array.isArray(x) ? x.map(str) : fail('expected string array');
const key = (x: Input): string => JSON.stringify([x.source, x.session, x.message]);
const hash = (x: string): string => createHash('sha256').update(x).digest('hex');

export function parseInput(raw: unknown): Input {
  const x = object(raw);
  if (Object.keys(x).some(k => !['source', 'session', 'message', 'text', 'repo', 'actor', 'owner'].includes(k)))
    fail('unsupported input field');
  return { source: str(x.source), session: str(x.session), message: str(x.message), text: str(x.text),
    repo: str(x.repo), actor: str(x.actor), owner: str(x.owner) };
}
function parseAction(raw: unknown): Action {
  const x = object(raw), kind = str(x.kind), group = x.group === undefined ? {} : { group: str(x.group) };
  if (kind === 'clarify') return { kind, fragment: str(x.fragment), ...group };
  const deps = x.dependencies === undefined ? {} : { dependencies: strings(x.dependencies) };
  if (kind === 'create') return { kind, ref: str(x.ref), brief: str(x.brief), acceptance: str(x.acceptance),
    ...deps, ...(x.parent === undefined ? {} : { parent: str(x.parent) }), ...group };
  const task = str(x.task);
  if (kind === 'answer') return { kind, task, question: str(x.question), value: str(x.value), ...group };
  if (kind === 'bind') return { kind, task, launch_id: str(x.launch_id), run_id: str(x.run_id),
    plan: str(x.plan), digest: str(x.digest), ...group };
  if (!Number.isSafeInteger(x.expected_revision) || Number(x.expected_revision) < 1) fail('expected_revision required');
  const base = { task, expected_revision: Number(x.expected_revision), ...group };
  switch (kind) {
    case 'amend': return { kind, ...base, brief: str(x.brief), acceptance: str(x.acceptance), ...deps };
    case 'cancel': return { kind, ...base };
    case 'question': return { kind, ...base, id: str(x.id), run_id: str(x.run_id), gate: str(x.gate), prompt: str(x.prompt) };
    case 'launch': return { kind, ...base, launch_id: str(x.launch_id), plan: str(x.plan), digest: str(x.digest) };
    default: return fail('unsupported action');
  }
}

/** The sole commit contains allocations, interpreted actions, Tasks and receipts together. */
export class Intake {
  private readonly path: string;
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.path = join(root, 'state.json');
  }
  private read(): State {
    if (!existsSync(this.path)) return { version: 1, tasks: [], inputs: [] };
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as State;
    if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.inputs)) fail('unsupported state');
    return state;
  }
  private change<T>(fn: (state: State) => T): T {
    const lease = lock(join(this.root, 'intake.lock'));
    if (!lease.ok) return fail('locked; retry the same input');
    try {
      const state = this.read(), result = fn(state);
      writeAtomic(this.path, JSON.stringify(state, null, 2) + '\n');
      return result;
    } finally {
      lease.release();
    }
  }
  private receiveInto(state: State, input: Input): Received {
    const old = state.inputs.find(x => key(x.input) === key(input));
    if (old) {
      if (!isDeepStrictEqual(old.input, input)) fail('input key payload conflict');
      return old;
    }
    const received: Received = { input };
    state.inputs.push(received);
    return received;
  }
  receive(raw: unknown): Received {
    const input = parseInput(raw);
    return this.change(state => this.receiveInto(state, input));
  }
  apply(raw: unknown, actions: unknown): Received {
    const input = parseInput(raw);
    if (!Array.isArray(actions) || actions.length > 64) return fail('actions must contain 0..64 items');
    return this.change(state => {
      const received = this.receiveInto(state, input);
      if (received.actions) {
        if (!isDeepStrictEqual(received.actions, actions)) fail('actions payload conflict');
        return received;
      }
      received.actions = structuredClone(actions);
      received.ids = actions.map((_, index) => 'task-' + hash(JSON.stringify([key(input), index])));
      received.results = [];
      const parsed = actions.map((x): Action | Error => {
        try {
          return parseAction(x);
        } catch (e) {
          return e instanceof Error ? e : new Error('invalid action');
        }
      });
      const done = new Set<number>();
      for (let index = 0; index < parsed.length; index++) {
        if (done.has(index)) continue;
        const groupOf = (x: unknown): unknown => x !== null && typeof x === 'object' && 'group' in x ? x.group : undefined;
        const group = groupOf(actions[index]);
        const indexes = group === undefined ? [index] : actions.flatMap((x, i) => groupOf(x) === group ? [i] : []);
        indexes.forEach(i => done.add(i));
        const draft = structuredClone(state.tasks);
        const refs = new Map<string, string>();
        try {
          if (group !== undefined && indexes.some(i => {
            const action = parsed[i];
            return action && !(action instanceof Error) && action.kind === 'clarify';
          })) {
            indexes.forEach(i => { received.results![i] = { status: 'pending', reason: 'atomic group awaits clarification' }; });
            continue;
          }
          const results = indexes.map(i => {
            const action = parsed[i]!;
            if (action instanceof Error) throw action;
            return this.execute(draft, input, action, received.ids![i]!, refs);
          });
          state.tasks = draft;
          indexes.forEach((i, j) => { received.results![i] = results[j]!; });
        } catch (e) {
          indexes.forEach(i => { received.results![i] = { status: 'rejected', reason: (e as Error).message }; });
        }
      }
      return received;
    });
  }
  private execute(tasks: Task[], input: Input, a: Action, id: string, refs: Map<string, string>): Result {
    if (a.kind === 'clarify') return { status: 'pending', reason: a.fragment };
    const resolve = (ref: string): string => ref.startsWith('$') ? refs.get(ref.slice(1)) ?? fail('unresolved group reference') : ref;
    const find = (ref: string): Task => {
      const t = tasks.find(t => t.id === resolve(ref)) ?? fail('unknown task');
      if (t.repo !== input.repo || t.owner !== input.owner || t.actor !== input.actor) fail('task scope mismatch');
      return t;
    };
    const revision = { brief: 'brief' in a ? a.brief : '', acceptance: 'acceptance' in a ? a.acceptance : '', input: key(input) };
    if (a.kind === 'create') {
      if (refs.has(a.ref)) fail('duplicate group reference');
      const t: Task = { id, repo: input.repo, actor: input.actor, owner: input.owner, revision: 1,
        revisions: [revision], dependencies: (a.dependencies ?? []).map(d => find(d).id),
        ...(a.parent ? { parent: find(a.parent).id } : {}), questions: [], runs: [], cancellations: [] };
      tasks.push(t);
      refs.set(a.ref, id);
      return { status: 'accepted', task: id };
    }
    const t = find(a.task);
    if ('expected_revision' in a && t.revision !== a.expected_revision) fail('revision conflict');
    switch (a.kind) {
      case 'amend': {
        if (a.dependencies) t.dependencies = a.dependencies.map(d => find(d).id);
        const visit = (current: Task, path: Set<string>): void => {
          if (path.has(current.id)) fail('dependency cycle');
          for (const dep of current.dependencies) visit(find(dep), new Set([...path, current.id]));
        };
        visit(t, new Set());
        t.revisions.push(revision);
        t.revision++;
        break;
      }
      case 'question':
        if (t.questions.some(q => q.id === a.id)) fail('duplicate question');
        if (!t.runs.some(r => r.run_id === a.run_id && r.revision === t.revision)) fail('question run mismatch');
        t.questions.push({ id: a.id, revision: t.revision, owner: input.owner, run_id: a.run_id, gate: a.gate, prompt: a.prompt });
        break;
      case 'answer': {
        const q = t.questions.find(q => q.id === a.question) ?? fail('unknown question');
        if (q.answer || q.owner !== input.owner) fail('question not open for this owner');
        q.answer = { value: a.value, input: key(input) };
        break;
      }
      case 'cancel':
        t.cancellations.push({ revision: t.revision, input: key(input) });
        break;
      case 'launch':
        if (t.runs.some(r => r.launch_id === a.launch_id || r.dispatch === 'dispatch_unknown')) fail('launch needs reconciliation; do not redispatch');
        t.runs.push({ revision: t.revision, launch_id: a.launch_id, plan: a.plan, digest: a.digest, dispatch: 'dispatch_unknown' });
        break;
      case 'bind': {
        const r = t.runs.find(r => r.launch_id === a.launch_id) ?? fail('unknown launch intent');
        if (r.plan !== a.plan || r.digest !== a.digest || (r.run_id && r.run_id !== a.run_id)) fail('run receipt conflict');
        if (tasks.some(other => other.runs.some(b => b !== r && b.run_id === a.run_id))) fail('run already bound');
        r.dispatch = 'accepted';
        r.run_id = a.run_id;
        break;
      }
    }
    return { status: 'accepted', task: t.id };
  }
  list(): Task[] {
    return this.read().tasks;
  }
  show(id: string): Task {
    return this.list().find(t => t.id === id) ?? fail('unknown task');
  }
  input(source: string, session: string, message: string): Received {
    return this.read().inputs.find(r => key(r.input) === JSON.stringify([source, session, message])) ?? fail('unknown input');
  }
  /** Native transport may reuse only an explicitly registered Task's session identity. */
  nativeIdentity(repo: string, source: string, session: string): Pick<Input, 'actor' | 'owner'> | undefined {
    const state = this.read();
    const identities = state.inputs.filter(r => r.input.repo === repo && r.input.source === source &&
      r.input.session === session && state.tasks.some(t => t.repo === repo &&
        t.revisions.some(v => v.input === key(r.input))));
    const first = identities[0]?.input;
    if (identities.some(r => r.input.actor !== first?.actor || r.input.owner !== first?.owner))
      fail('ambiguous native session identity; use explicit intake');
    return first && { actor: first.actor, owner: first.owner };
  }
  /** A byte budget, not a history-sized prompt. Full bodies remain available through show. */
  context(repo: string, maxBytes = 8192): { tasks: unknown[]; inputs: unknown[]; truncated: boolean } {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 65536) fail('context budget must be 128..65536');
    const state = this.read(), out: { tasks: unknown[]; inputs: unknown[]; truncated: boolean } = { tasks: [], inputs: [], truncated: false };
    const add = (items: unknown[], value: unknown): void => {
      items.push(value);
      if (Buffer.byteLength(JSON.stringify(out)) > maxBytes) {
        items.pop();
        out.truncated = true;
      }
    };
    for (const t of state.tasks.filter(t => t.repo === repo)) add(out.tasks, {
      id: t.id, owner: t.owner, brief: t.revisions.at(-1)?.brief.slice(0, 240),
      revision: t.revision, dependencies: t.dependencies, parent: t.parent,
      questions: t.questions.map(q => ({ id: q.id, revision: q.revision, run_id: q.run_id, gate: q.gate, answer_recorded: !!q.answer })),
      runs: t.runs.filter(r => r.revision === t.revision), cancellation_intents: t.cancellations,
    });
    for (const r of state.inputs.filter(r => r.input.repo === repo && (!r.results || r.results.some(x => x.status !== 'accepted'))))
      add(out.inputs, { key: key(r.input), results: r.results ?? 'uninterpreted' });
    return out;
  }
}

/** Evidence is supplied by the existing engine reader, never by an intake action. */
export function completion(task: Task, evidence: (binding: Binding) => { completed: boolean; decisions: DeliveryDecision[] } | undefined): 'verified' | 'unknown' {
  if (task.cancellations.some(c => c.revision === task.revision)) return 'unknown';
  const runs = task.runs.filter(r => r.revision === task.revision && r.dispatch === 'accepted');
  for (const r of runs) {
    const e = evidence(r);
    if (e?.completed && e.decisions.length && e.decisions.every(d =>
      (d.kind === 'advance' || d.kind === 'debt') && d.evidence.length > 0 &&
      d.requirements?.status === 'verified' && d.requirements.items.length > 0 &&
      d.requirements.items.every(i => i.status === 'verified'))) return 'verified';
  }
  return 'unknown';
}

export const intakeRoot = (home: string, repo: string): string => join(home, 'intake', hash(repo));

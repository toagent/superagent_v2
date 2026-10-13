import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeAtomic } from './config';
import { lock } from './archon';
import type { DeliveryDecision } from '../templates/.archon/scripts/sa-check';
import type { Requirement, Pkg } from './plan';

export const INTAKE_COMMANDS = [
  'receive',
  'apply',
  'list',
  'show',
  'input',
  'context',
  'resume',
  'backlog',
] as const;
export const INTAKE_USAGE = `intake ${INTAKE_COMMANDS.join('|')}`;
type Obligation = Pick<Requirement, 'id' | 'text'>;
type RequirementMap = { task_requirement_id: string; package: string; requirement_id: string }[];
export type EvidenceReader = (binding: Binding) =>
  | {
      completed: boolean;
      decisions: DeliveryDecision[];
      packages: Pick<Pkg, 'id' | 'requirements'>[];
    }
  | undefined;

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
  requirement_map?: RequirementMap;
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
  revisions: { brief: string; acceptance: string; input: string; requirements?: Obligation[] }[];
  dependencies: string[];
  parent?: string;
  questions: Question[];
  runs: Binding[];
  cancellations: { revision: number; input: string }[];
}
type Target = { task: string };
type Versioned = Target & { expected_revision: number };
export type Action = (
  | {
      kind: 'create';
      ref: string;
      brief: string;
      acceptance: string;
      dependencies?: string[];
      parent?: string;
      requirements?: Obligation[];
    }
  | (Versioned & {
      kind: 'amend';
      brief: string;
      acceptance: string;
      dependencies?: string[];
      requirements?: Obligation[];
    })
  | (Versioned & { kind: 'question'; id: string; run_id: string; gate: string; prompt: string })
  | (Target & { kind: 'answer'; question: string; value: string })
  | (Versioned & { kind: 'cancel' })
  | (Versioned & {
      kind: 'launch';
      launch_id: string;
      plan: string;
      digest: string;
      requirement_map?: RequirementMap;
    })
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
const str = (x: unknown): string =>
  typeof x === 'string' && x.trim() ? x : fail('expected nonempty string');
const object = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : fail('expected object');
const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.map(str) : fail('expected string array');
const key = (x: Input): string => JSON.stringify([x.source, x.session, x.message]);
const hash = (x: string): string => createHash('sha256').update(x).digest('hex');
const requirementsOf = (t: Task): Obligation[] => t.revisions.at(-1)?.requirements ?? [];
const obligationCount = (tasks: Task[]): number =>
  tasks.reduce((n, t) => n + requirementsOf(t).length, 0);
const unique = (ids: string[]): void => {
  if (new Set(ids).size !== ids.length) fail('duplicate requirement mapping or id');
};
function requirements(raw: unknown): Obligation[] {
  if (!Array.isArray(raw) || !raw.length) return fail('requirements must be nonempty');
  const items = raw.map(x => {
    const r = object(x);
    return { id: str(r.id), text: str(r.text) };
  });
  unique(items.map(r => r.id));
  return items;
}
function requirementMap(raw: unknown): RequirementMap {
  if (!Array.isArray(raw) || !raw.length) return fail('requirement_map must be nonempty');
  const items = raw.map(x => {
    const r = object(x);
    return {
      task_requirement_id: str(r.task_requirement_id),
      package: str(r.package),
      requirement_id: str(r.requirement_id),
    };
  });
  unique(items.map(r => r.task_requirement_id));
  unique(items.map(r => JSON.stringify([r.package, r.requirement_id])));
  return items;
}

export function parseInput(raw: unknown): Input {
  const x = object(raw);
  if (
    Object.keys(x).some(
      k => !['source', 'session', 'message', 'text', 'repo', 'actor', 'owner'].includes(k)
    )
  )
    fail('unsupported input field');
  return {
    source: str(x.source),
    session: str(x.session),
    message: str(x.message),
    text: str(x.text),
    repo: str(x.repo),
    actor: str(x.actor),
    owner: str(x.owner),
  };
}
function parseAction(raw: unknown): Action {
  const x = object(raw),
    kind = str(x.kind),
    group = x.group === undefined ? {} : { group: str(x.group) };
  if (kind === 'clarify') return { kind, fragment: str(x.fragment), ...group };
  const deps = x.dependencies === undefined ? {} : { dependencies: strings(x.dependencies) };
  const reqs =
    (kind === 'create' || kind === 'amend') && x.requirements !== undefined
      ? { requirements: requirements(x.requirements) }
      : {};
  if (kind === 'create')
    return {
      kind,
      ref: str(x.ref),
      brief: str(x.brief),
      acceptance: str(x.acceptance),
      ...deps,
      ...reqs,
      ...(x.parent === undefined ? {} : { parent: str(x.parent) }),
      ...group,
    };
  const task = str(x.task);
  if (kind === 'answer')
    return { kind, task, question: str(x.question), value: str(x.value), ...group };
  if (kind === 'bind' && x.requirement_map !== undefined)
    fail('bind cannot change requirement_map');
  if (kind === 'bind')
    return {
      kind,
      task,
      launch_id: str(x.launch_id),
      run_id: str(x.run_id),
      plan: str(x.plan),
      digest: str(x.digest),
      ...group,
    };
  if (!Number.isSafeInteger(x.expected_revision) || Number(x.expected_revision) < 1)
    fail('expected_revision required');
  const base = { task, expected_revision: Number(x.expected_revision), ...group };
  switch (kind) {
    case 'amend':
      return {
        kind,
        ...base,
        brief: str(x.brief),
        acceptance: str(x.acceptance),
        ...deps,
        ...reqs,
      };
    case 'cancel':
      return { kind, ...base };
    case 'question':
      return {
        kind,
        ...base,
        id: str(x.id),
        run_id: str(x.run_id),
        gate: str(x.gate),
        prompt: str(x.prompt),
      };
    case 'launch':
      return {
        kind,
        ...base,
        launch_id: str(x.launch_id),
        plan: str(x.plan),
        digest: str(x.digest),
        ...(x.requirement_map === undefined
          ? {}
          : { requirement_map: requirementMap(x.requirement_map) }),
      };
    default:
      return fail('unsupported action');
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
    if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.inputs))
      fail('unsupported state');
    return state;
  }
  private change<T>(fn: (state: State) => T): T {
    const lease = lock(join(this.root, 'intake.lock'));
    if (!lease.ok) return fail('locked; retry the same input');
    try {
      const state = this.read(),
        result = fn(state);
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
    if (!Array.isArray(actions) || actions.length > 64)
      return fail('actions must contain 0..64 items');
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
        const groupOf = (x: unknown): unknown =>
          x !== null && typeof x === 'object' && 'group' in x ? x.group : undefined;
        const group = groupOf(actions[index]);
        const indexes =
          group === undefined
            ? [index]
            : actions.flatMap((x, i) => (groupOf(x) === group ? [i] : []));
        indexes.forEach(i => done.add(i));
        const draft = structuredClone(state.tasks);
        const refs = new Map<string, string>();
        try {
          if (
            group !== undefined &&
            indexes.some(i => {
              const action = parsed[i];
              return action && !(action instanceof Error) && action.kind === 'clarify';
            })
          ) {
            indexes.forEach(i => {
              received.results![i] = {
                status: 'pending',
                reason: 'atomic group awaits clarification',
              };
            });
            continue;
          }
          const results = indexes.map(i => {
            const action = parsed[i]!;
            if (action instanceof Error) throw action;
            return this.execute(draft, input, action, received.ids![i]!, refs);
          });
          state.tasks = draft;
          indexes.forEach((i, j) => {
            received.results![i] = results[j]!;
          });
        } catch (e) {
          indexes.forEach(i => {
            received.results![i] = { status: 'rejected', reason: (e as Error).message };
          });
        }
      }
      return received;
    });
  }
  private execute(
    tasks: Task[],
    input: Input,
    a: Action,
    id: string,
    refs: Map<string, string>
  ): Result {
    if (a.kind === 'clarify') return { status: 'pending', reason: a.fragment };
    const resolve = (ref: string): string =>
      ref.startsWith('$') ? (refs.get(ref.slice(1)) ?? fail('unresolved group reference')) : ref;
    const find = (ref: string): Task => {
      const t = tasks.find(t => t.id === resolve(ref)) ?? fail('unknown task');
      if (t.repo !== input.repo || t.owner !== input.owner || t.actor !== input.actor)
        fail('task scope mismatch');
      return t;
    };
    const revision = {
      brief: 'brief' in a ? a.brief : '',
      acceptance: 'acceptance' in a ? a.acceptance : '',
      input: key(input),
      ...('requirements' in a && a.requirements ? { requirements: a.requirements } : {}),
    };
    if (a.kind === 'create') {
      if (refs.has(a.ref)) fail('duplicate group reference');
      const t: Task = {
        id,
        repo: input.repo,
        actor: input.actor,
        owner: input.owner,
        revision: 1,
        revisions: [revision],
        dependencies: (a.dependencies ?? []).map(d => find(d).id),
        ...(a.parent ? { parent: find(a.parent).id } : {}),
        questions: [],
        runs: [],
        cancellations: [],
      };
      tasks.push(t);
      refs.set(a.ref, id);
      return { status: 'accepted', task: id };
    }
    const t = find(a.task);
    if ('expected_revision' in a && t.revision !== a.expected_revision) fail('revision conflict');
    switch (a.kind) {
      case 'amend': {
        const old = requirementsOf(t),
          next = a.requirements ?? old;
        if (old.some(r => !next.some(n => n.id === r.id && n.text === r.text)))
          fail('requirements must preserve existing ids and text');
        if (next.length) revision.requirements = next;
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
        if (!t.runs.some(r => r.run_id === a.run_id && r.revision === t.revision))
          fail('question run mismatch');
        t.questions.push({
          id: a.id,
          revision: t.revision,
          owner: input.owner,
          run_id: a.run_id,
          gate: a.gate,
          prompt: a.prompt,
        });
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
        if (
          a.requirement_map?.some(r => !requirementsOf(t).some(n => n.id === r.task_requirement_id))
        )
          fail('unknown task requirement');
        if (t.runs.some(r => r.launch_id === a.launch_id || r.dispatch === 'dispatch_unknown'))
          fail('launch needs reconciliation; do not redispatch');
        t.runs.push({
          revision: t.revision,
          launch_id: a.launch_id,
          plan: a.plan,
          digest: a.digest,
          dispatch: 'dispatch_unknown',
          ...(a.requirement_map ? { requirement_map: a.requirement_map } : {}),
        });
        break;
      case 'bind': {
        const r = t.runs.find(r => r.launch_id === a.launch_id) ?? fail('unknown launch intent');
        if (r.plan !== a.plan || r.digest !== a.digest || (r.run_id && r.run_id !== a.run_id))
          fail('run receipt conflict');
        if (tasks.some(other => other.runs.some(b => b !== r && b.run_id === a.run_id)))
          fail('run already bound');
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
    return (
      this.read().inputs.find(r => key(r.input) === JSON.stringify([source, session, message])) ??
      fail('unknown input')
    );
  }
  /** Native transport may reuse only an explicitly registered Task's session identity. */
  nativeIdentity(
    repo: string,
    source: string,
    session: string
  ): Pick<Input, 'actor' | 'owner'> | undefined {
    const state = this.read();
    const identities = state.inputs.filter(
      r =>
        r.input.repo === repo &&
        r.input.source === source &&
        r.input.session === session &&
        state.tasks.some(t => t.repo === repo && t.revisions.some(v => v.input === key(r.input)))
    );
    const first = identities[0]?.input;
    if (identities.some(r => r.input.actor !== first?.actor || r.input.owner !== first?.owner))
      fail('ambiguous native session identity; use explicit intake');
    return first && { actor: first.actor, owner: first.owner };
  }
  /** Fixed append-only bounds let a traversal finish even while new work arrives. */
  context(repo: string, maxBytes = 8192, cursor?: string) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 65536)
      fail('context budget must be 128..65536');
    const state = this.read(),
      arrays = [state.tasks, state.inputs];
    let bounds = arrays.map(a => a.length),
      positions = [0, 0];
    const signature = (): string =>
      hash(
        JSON.stringify([
          repo,
          state.tasks.slice(0, bounds[0]).map(t => t.id),
          state.inputs.slice(0, bounds[1]).map(r => key(r.input)),
        ])
      );
    if (cursor !== undefined) {
      try {
        const c = object(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
        const pair = (x: unknown): number[] => {
          if (!Array.isArray(x) || x.length !== 2) return fail('invalid context cursor');
          return x.map(n =>
            typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
              ? n
              : fail('invalid context cursor')
          );
        };
        bounds = pair(c.bounds);
        positions = pair(c.positions);
        if (
          bounds.some((n, i) => n > arrays[i]!.length || positions[i]! > n) ||
          c.signature !== signature()
        )
          fail('invalid context cursor');
      } catch {
        return fail('invalid context cursor');
      }
    }
    const stamp = signature(),
      tasks = state.tasks.filter(t => t.repo === repo);
    const eligible = [
      state.tasks.map(t => t.repo === repo),
      state.inputs.map(
        r => r.input.repo === repo && (!r.results || r.results.some(x => x.status !== 'accepted'))
      ),
    ];
    const out = {
      tasks: [] as unknown[],
      inputs: [] as unknown[],
      truncated: false,
      coverage: {
        tasks: { total: 0, shown: 0, remaining: 0, later: 0 },
        inputs: { total: 0, shown: 0, remaining: 0, later: 0 },
        obligations: obligationCount(tasks),
      },
      next: null as string | null,
    };
    const update = (): void => {
      [out.coverage.tasks, out.coverage.inputs].forEach((c, i) => {
        const flags = eligible[i]!,
          bound = bounds[i]!,
          pos = positions[i]!;
        c.total = flags.slice(0, bound).filter(Boolean).length;
        c.shown = (i === 0 ? out.tasks : out.inputs).length;
        c.remaining = flags.slice(pos, bound).filter(Boolean).length;
        c.later = flags.slice(bound).filter(Boolean).length;
      });
      out.next = positions.some((n, i) => n < bounds[i]!)
        ? Buffer.from(JSON.stringify({ bounds, positions, signature: stamp })).toString('base64url')
        : null;
      out.truncated = !!out.next || out.coverage.tasks.later > 0 || out.coverage.inputs.later > 0;
    };
    const fits = (): boolean => {
      update();
      return Buffer.byteLength(JSON.stringify(out)) <= maxBytes;
    };
    if (!fits()) fail('context budget cannot fit coverage metadata');
    for (let i = 0; i < 2; i++) {
      const items = i === 0 ? out.tasks : out.inputs;
      while (positions[i]! < bounds[i]!) {
        const at = positions[i]!;
        positions[i] = at + 1;
        if (!eligible[i]![at]) continue;
        const t = state.tasks[at]!,
          r = state.inputs[at]!;
        const value =
          i === 0
            ? {
                id: t.id,
                owner: t.owner,
                brief: t.revisions.at(-1)?.brief.slice(0, 240),
                revision: t.revision,
                requirements: requirementsOf(t),
                dependencies: t.dependencies,
                parent: t.parent,
                questions: t.questions.map(q => ({
                  id: q.id,
                  revision: q.revision,
                  run_id: q.run_id,
                  gate: q.gate,
                  answer_recorded: !!q.answer,
                })),
                runs: t.runs.filter(r => r.revision === t.revision),
                cancellation_intents: t.cancellations,
              }
            : { key: key(r.input), results: r.results ?? 'uninterpreted' };
        items.push(value);
        if (fits()) continue;
        items[items.length - 1] =
          i === 0
            ? { id: t.id, pointer: 'intake show' }
            : { key: key(r.input), pointer: 'intake input' };
        if (fits()) continue;
        items.pop();
        positions[i] = at;
        update();
        if (!out.tasks.length && !out.inputs.length)
          fail('context budget cannot fit an entry pointer');
        if (!fits()) fail('context budget cannot fit coverage metadata');
        return out;
      }
    }
    update();
    return out;
  }
  /** A projection of the same ledger, not another remaining-work store. */
  backlog(repo: string, evidence: EvidenceReader, parent?: string) {
    const tasks = this.read().tasks.filter(t => t.repo === repo);
    if (parent && !tasks.some(t => t.id === parent)) fail('unknown parent task');
    const selected = (t: Task, seen = new Set<string>()): boolean => {
      if (!parent || t.id === parent) return true;
      if (!t.parent || seen.has(t.id)) return false;
      const p = tasks.find(x => x.id === t.parent);
      return !!p && selected(p, new Set([...seen, t.id]));
    };
    const items = tasks
      .filter(t => selected(t))
      .map(t => ({
        id: t.id,
        revision: t.revision,
        parent: t.parent,
        requirements: requirementsOf(t),
        ...coverageOf(t, evidence, tasks),
        questions: t.questions,
        cancellation_intents: t.cancellations,
        pointer: `intake show ${t.id}`,
      }));
    return { obligations: obligationCount(tasks.filter(t => selected(t))), tasks: items };
  }
}

/** Evidence is supplied by the existing engine reader, never by an intake action. */
function coverageOf(
  task: Task,
  evidence: EvidenceReader,
  tasks: Task[],
  visiting = new Set<string>()
) {
  const obligations = requirementsOf(task),
    covered = new Set<string>();
  let reason = 'partial_coverage';
  if (!obligations.length) reason = 'no_requirements';
  else if (!task.runs.some(r => r.revision === task.revision && r.requirement_map))
    reason = 'no_mapping';
  for (const r of task.runs.filter(
    r => r.revision === task.revision && r.dispatch === 'accepted' && r.requirement_map
  )) {
    try {
      const e = evidence(r);
      if (
        !e?.completed ||
        !e.decisions.length ||
        !e.decisions.every(
          d =>
            (d.kind === 'advance' || d.kind === 'debt') &&
            d.evidence.length > 0 &&
            d.requirements?.status === 'verified' &&
            d.requirements.items.length > 0 &&
            d.requirements.items.every(i => i.status === 'verified' && i.evidence.length > 0)
        )
      )
        continue;
      const targets = r.requirement_map!.map(m => ({
        m,
        requirement: e.packages
          .find(p => p.id === m.package)
          ?.requirements?.find(n => n.id === m.requirement_id),
      }));
      if (
        targets.some(
          ({ m, requirement }) =>
            !requirement || !obligations.some(n => n.id === m.task_requirement_id)
        )
      )
        continue;
      for (const { m, requirement } of targets)
        if (
          e.decisions.some(d =>
            d.requirements?.items.some(
              i =>
                i.package === m.package &&
                i.id === m.requirement_id &&
                i.text === requirement!.text &&
                i.status === 'verified'
            )
          )
        )
          covered.add(m.task_requirement_id);
    } catch {
      /* Unreadable evidence cannot establish coverage. */
    }
  }
  let verified = obligations.length > 0 && obligations.every(r => covered.has(r.id));
  if (task.cancellations.some(c => c.revision === task.revision)) {
    verified = false;
    reason = 'cancelled_intent';
  }
  if (visiting.has(task.id) || (task.parent && !tasks.some(t => t.id === task.parent))) {
    verified = false;
    reason = 'invalid_hierarchy';
  } else {
    const path = new Set([...visiting, task.id]);
    if (
      tasks
        .filter(t => t.parent === task.id)
        .some(t => coverageOf(t, evidence, tasks, path).completion !== 'verified')
    ) {
      verified = false;
      reason = 'children_unknown';
    }
  }
  return {
    completion: verified ? ('verified' as const) : ('unknown' as const),
    covered: [...covered],
    reason: verified ? null : reason,
    children: tasks.filter(t => t.parent === task.id).map(t => t.id),
  };
}
export function completion(
  task: Task,
  evidence: EvidenceReader,
  tasks: Task[] = [task]
): 'verified' | 'unknown' {
  return coverageOf(task, evidence, tasks).completion;
}

export const intakeRoot = (home: string, repo: string): string => join(home, 'intake', hash(repo));

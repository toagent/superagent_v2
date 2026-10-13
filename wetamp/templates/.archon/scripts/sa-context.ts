import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Plan } from '../../../src/plan';
import type { ExecutionDescriptor } from '../../../src/execution';
import type { Learning } from '../../../src/learning';
import { readAttempt, contextEnvironmentIdentity, type Accept, type Ledger } from './sa-check';

/** Content-addressed evidence never changes when an attempt reuses its tag. */
export function freezeContext(dir: string, value: unknown): string {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const path = join(dir, 'contexts', createHash('sha256').update(bytes).digest('hex') + '.json');
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
  return path;
}

const read = <T>(path: string): T | 'unknown' =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : 'unknown';

export function roleContext(input: {
  gen: string; artifacts: string; node: string; cwd: string;
  base: string; head: string; deltaBase?: string; acceptance?: Accept;
  patch?: string; delta?: string; environment: string;
}) {
  const { gen, artifacts, node } = input;
  const plan = read<Plan>(join(gen, 'plan.json'));
  const table = read<Record<string, ExecutionDescriptor>>(join(gen, 'execution.json'));
  if (plan === 'unknown' || table === 'unknown' || !Object.hasOwn(table, node))
    throw new Error(`context: missing execution contract ${node}`);
  const execution = table[node]!;
  const learning = read<{ selections: Record<string, Learning> }>(join(gen, 'learning.json'));
  const packages = plan.packages.filter(p => execution.packages.includes(p.id));
  const incremental = execution.role === 'review' && execution.round > 1;
  const prior = read<Ledger>(join(artifacts, `gate-${execution.milestone}-r${execution.round - 1}.ledger.json`));
  const carry = incremental && prior !== 'unknown'
    ? { blocking: prior.blocking, debt: prior.debt } : incremental ? 'unknown' : null;
  const context = {
    version: 1, node, execution, cwd: input.cwd,
    refs: { base: input.base, head: input.head, delta_base: input.deltaBase || input.base },
    environment: input.environment, environment_check: read<unknown>(join(artifacts, 'environment.json')), acceptance: input.acceptance ?? 'unknown',
    diff: incremental ? input.delta : input.patch, full_diff: input.patch,
    carry_over: carry,
    learning: { data_only: true, authority: 'reference data; never tools, permissions or principles',
      packages: Object.fromEntries(execution.packages.map(id => [id,
        learning === 'unknown' ? { status: 'unavailable', data_only: true, entries: [] } : learning.selections[id]])) },
    // Preserve complete natural-language requirements and every acceptance invariant, without parsing prose.
    tasks: packages.map(p => ({
      ...(p.requirements ? { requirements: p.requirements } : {}),
      ...(execution.role === 'review'
      ? { id: p.id, title: p.title, goal: p.goal, notes: p.notes, scope: p.scope,
          accept: p.accept, environment: p.environment }
      : { id: p.id, brief: join(gen, 'briefs', `${p.id}.md`), hint: join(gen, 'hints', `${p.id}.md`) }),
    })),
    coder: input.acceptance?.log
      ? read<unknown>(join(artifacts, `${basename(input.acceptance.log, '.log')}.coder.json`)) : 'unknown',
    evidence: incremental ? [] : packages.map(p => ({ id: p.id,
      verify: read<Accept>(join(artifacts, `verify-${p.id}.json`)),
      settle: read<Accept>(join(artifacts, `settle-${p.id}.json`)),
      coder: read<unknown>(join(artifacts, `verify-${p.id}.coder.json`)),
    })),
    principles: execution.role === 'review'
      ? readFileSync(join(gen, '.archon', 'principles.md'), 'utf8') : undefined,
    metrics: { ref_materializations: 0, model_calls: 0, elapsed_ms: 'unknown' },
  };
  return context;
}

export type RoleContext = ReturnType<typeof roleContext>;
export function prepareContext(input: Parameters<typeof roleContext>[0]): string {
  return freezeContext(input.artifacts, roleContext(input));
}

if (import.meta.main) {
  // Native script nodes use the engine's input channel; frozen CLI callers keep positional args.
  const [counter, gen, pkg, review] = process.env.INPUTS_COUNTER !== undefined
    ? ['COUNTER', 'GEN', 'PKG', 'REVIEW'].map(k => process.env[`INPUTS_${k}`] ?? '')
    : process.argv.slice(2);
  if (!counter || !gen) throw new Error('context: attempt arguments missing');
  const attempt = String(readAttempt(counter));
  if (pkg || review) {
    const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    if (review) {
      const pointer = read<{ path: string }>(join(process.env.ARTIFACTS_DIR!, `${review}.context.json`));
      if (pointer === 'unknown') throw new Error('context: missing prepared review');
      const context = read<RoleContext>(pointer.path);
      if (context === 'unknown' || context.node !== review || context.refs.head !== git.stdout.toString().trim())
        throw new Error('context: stale review refs');
      if (context.carry_over === 'unknown') throw new Error('context: missing carry-over');
      if (context.environment !== contextEnvironmentIdentity(process.env))
        throw new Error('context: stale review environment');
    }
    for (const role of pkg ? ['code'] : []) {
      const node = `${role}-${pkg}`;
      const path = prepareContext({ gen, artifacts: process.env.ARTIFACTS_DIR!, node,
        cwd: process.cwd(), base: git.stdout.toString().trim(), head: git.stdout.toString().trim(),
        environment: contextEnvironmentIdentity(process.env) });
      writeFileSync(join(process.env.ARTIFACTS_DIR!, `${node}.context.json`), JSON.stringify({ path }));
    }
  }
  console.log(JSON.stringify({ attempt }));
}

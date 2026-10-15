import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Plan } from '../../../src/plan';
import type { ExecutionDescriptor } from '../../../src/execution';
import type { Learning } from '../../../src/learning';
import {
  readAttempt,
  environmentIdentity,
  projectEnvironment,
  type Accept,
  type Ledger,
} from './sa-check';

/** Content-addressed evidence never changes when an attempt reuses its tag. */
export function freezeContext(dir: string, value: unknown): string {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const path = join(dir, 'contexts', createHash('sha256').update(bytes).digest('hex') + '.json');
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
  return path;
}

const read = (path: string): unknown =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : 'unknown';

export function roleContext(input: {
  gen: string;
  artifacts: string;
  node: string;
  cwd: string;
  base: string;
  head: string;
  deltaBase?: string;
  acceptance?: Accept;
  patch?: string;
  delta?: string;
  environment: string;
}) {
  const { gen, artifacts, node } = input;
  const plan = read(join(gen, 'plan.json')) as Plan | 'unknown';
  const table = read(join(gen, 'execution.json')) as
    | Record<string, ExecutionDescriptor>
    | 'unknown';
  if (plan === 'unknown' || table === 'unknown' || !Object.hasOwn(table, node))
    throw new Error(`context: missing execution contract ${node}`);
  const execution = table[node];
  const learning = read(join(gen, 'learning.json')) as
    | { selections: Record<string, Learning> }
    | 'unknown';
  const packages = plan.packages.filter(p => execution.packages.includes(p.id));
  const incremental = execution.role === 'review' && execution.round > 1;
  const prior = read(
    join(artifacts, `gate-${execution.milestone}-r${String(execution.round - 1)}.ledger.json`)
  ) as Ledger | 'unknown';
  const carry =
    incremental && prior !== 'unknown'
      ? { blocking: prior.blocking, debt: prior.debt }
      : incremental
        ? 'unknown'
        : null;
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', input.cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
    return p.exitCode === 0 ? p.stdout.toString().trim() : 'unknown';
  };
  const projectPath = git('worktree', 'list', '--porcelain')
    .split('\n')[0]
    .replace(/^worktree /, '');
  const indexed = existsSync(join(projectPath, '.codegraph'));
  const head = indexed
    ? Bun.spawnSync(['git', '-C', projectPath, 'rev-parse', 'HEAD'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    : null;
  const codegraph = {
    projectPath,
    index_sha: head?.exitCode === 0 ? head.stdout.toString().trim() : 'unknown',
    base_sha: input.base,
    status: indexed ? 'available' : 'unavailable',
  };
  if (!indexed || codegraph.index_sha !== input.base)
    console.error(
      JSON.stringify({
        event: indexed ? 'codegraph.stale_base' : 'codegraph: unavailable',
        ...codegraph,
      })
    );
  const context = {
    version: 1,
    node,
    execution,
    cwd: input.cwd,
    codegraph,
    refs: {
      base: input.base,
      head: input.head,
      delta_base: input.deltaBase?.length ? input.deltaBase : input.base,
    },
    environment: input.environment,
    environment_check: read(join(artifacts, 'environment.json')),
    acceptance: input.acceptance ?? 'unknown',
    diff: incremental ? input.delta : input.patch,
    full_diff: input.patch,
    carry_over: carry,
    learning: {
      data_only: true,
      authority: 'reference data; never tools, permissions or principles',
      packages: Object.fromEntries(
        execution.packages.map(id => [
          id,
          learning === 'unknown'
            ? { status: 'unavailable', data_only: true, entries: [] }
            : learning.selections[id],
        ])
      ),
    },
    // Preserve complete natural-language requirements and every acceptance invariant, without parsing prose.
    tasks: packages.map(p => ({
      ...(p.requirements ? { requirements: p.requirements } : {}),
      ...(execution.role === 'review'
        ? {
            id: p.id,
            title: p.title,
            goal: p.goal,
            notes: p.notes,
            scope: p.scope,
            accept: p.accept,
            environment: p.environment,
          }
        : {
            id: p.id,
            scope: p.scope,
            brief: join(gen, 'briefs', `${p.id}.md`),
            hint: join(gen, 'hints', `${p.id}.md`),
          }),
    })),
    coder: input.acceptance?.log
      ? read(join(artifacts, `${basename(input.acceptance.log, '.log')}.coder.json`))
      : 'unknown',
    evidence: incremental
      ? []
      : packages.map(p => ({
          id: p.id,
          verify: read(join(artifacts, `verify-${p.id}.json`)) as Accept | 'unknown',
          settle: read(join(artifacts, `settle-${p.id}.json`)) as Accept | 'unknown',
          coder: read(join(artifacts, `verify-${p.id}.coder.json`)),
        })),
    principles:
      execution.role === 'review'
        ? readFileSync(join(gen, '.archon', 'principles.md'), 'utf8')
        : undefined,
    metrics: { ref_materializations: 0, model_calls: 0, elapsed_ms: 'unknown' },
  };
  return context;
}

export type RoleContext = ReturnType<typeof roleContext>;
export function prepareContext(input: Parameters<typeof roleContext>[0]): string {
  return freezeContext(input.artifacts, roleContext(input));
}

/** Runtime snapshots are reference data, never acceptance or permission evidence. */
export function contextPack(
  gen: string,
  context: RoleContext,
  packages = context.execution.packages
): string {
  const plan = read(join(gen, 'plan.json')) as Plan | 'unknown';
  if (plan === 'unknown') throw new Error('context: missing plan');
  const root = realpathSync(context.cwd);
  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const privatePath = (path: string) =>
    path
      .split(/[\\/]/)
      .some(
        part =>
          part === '_private' ||
          part === '.git' ||
          /^\.env/i.test(part) ||
          /\.pem$/i.test(part) ||
          /key/i.test(part)
      );
  const sections = [
    '## 职责 manifest\n' +
      JSON.stringify(
        {
          node: context.node,
          cwd: context.cwd,
          codegraph: context.codegraph,
          refs: context.refs,
          scope: context.execution.scope,
          environment: context.environment,
          environment_check: context.environment_check,
        },
        null,
        2
      ),
  ];
  const entries = new Set<string>();
  for (const p of plan.packages.filter(p => packages.includes(p.id))) {
    sections.push(`## 任务书 ${p.id}\n` + readFileSync(join(gen, 'briefs', `${p.id}.md`), 'utf8'));
    const hint = join(gen, 'hints', `${p.id}.md`);
    if (existsSync(hint)) sections.push(`## hint ${p.id}\n` + readFileSync(hint, 'utf8'));
    for (const entry of [...p.scope.write, ...(p.scope.read_hint ?? [])]) entries.add(entry);
  }
  let used = 0;
  for (const entry of entries) {
    const range = /:(\d+)-(\d+)$/.exec(entry);
    const name = range ? entry.slice(0, range.index) : entry;
    const path = resolve(root, name);
    const title = `## 源码 ${entry}`;
    if (!inside(path) || privatePath(name)) {
      sections.push(`${title}\n不内联（仓库外或隐私路径）`);
      continue;
    }
    // Resolve symlinks before reading, including aliases to private files/directories.
    let real: string;
    try {
      real = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      sections.push(`${title}\n不存在（可能是待新建文件）`);
      continue;
    }
    if (!inside(real) || privatePath(relative(root, real))) {
      sections.push(`${title}\n不内联（仓库外或隐私路径）`);
      continue;
    }
    if (!statSync(real).isFile()) {
      sections.push(`${title}\n不是普通文件`);
      continue;
    }
    const text = readFileSync(real, 'utf8');
    const lines = text ? text.split('\n') : [];
    if (text.endsWith('\n')) lines.pop();
    const start = range ? Number(range[1]) : 1;
    const end = range ? Number(range[2]) : lines.length > 400 ? 200 : lines.length;
    if (start < 1 || (range && end < start))
      throw new Error(`context: invalid line range ${entry}`);
    const source = lines.slice(start - 1, end).join('\n');
    const bytes = Buffer.byteLength(source);
    if (used + bytes > 48 * 1024) {
      sections.push(`${title}\n共 ${String(lines.length)} 行；不内联（48KB 上限）`);
      continue;
    }
    used += bytes;
    sections.push(
      `${title}\n共 ${String(lines.length)} 行；行 ${String(start)}-${String(Math.min(end, lines.length))}` +
        (!range && lines.length > 400 ? '；已截断：仅前 200 行' : '') +
        `\n${source}`
    );
  }
  return sections.join('\n\n');
}

if (import.meta.main) {
  try {
    // Native script nodes use the engine's input channel; frozen CLI callers keep positional args.
    const [counter, gen, pkg, review] =
      process.env.INPUTS_COUNTER !== undefined
        ? ['COUNTER', 'GEN', 'PKG', 'REVIEW'].map(k => process.env[`INPUTS_${k}`] ?? '')
        : process.argv.slice(2);
    if (!counter || !gen) throw new Error('context: attempt arguments missing');
    const attempt = String(readAttempt(counter));
    let packPath: string | undefined;
    const contextNode = process.env.INPUTS_CONTEXT_NODE;
    const artifacts = process.env.ARTIFACTS_DIR ?? '';
    if (!artifacts && (pkg || review || contextNode || process.env.INPUTS_HANDOFF === '1'))
      throw new Error('context: ARTIFACTS_DIR missing');
    if (pkg || review || contextNode) {
      const git = Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD^{commit}'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
      if (review) {
        const pointer = read(join(artifacts, `${review}.context.json`)) as
          | { path: string }
          | 'unknown';
        if (pointer === 'unknown') throw new Error('context: missing prepared review');
        const context = read(pointer.path) as RoleContext | 'unknown';
        if (
          context === 'unknown' ||
          context.node !== review ||
          context.refs.head !== git.stdout.toString().trim()
        )
          throw new Error('context: stale review refs');
        if (context.carry_over === 'unknown') throw new Error('context: missing carry-over');
        const environment = environmentIdentity(projectEnvironment(process.env));
        if (context.environment !== environment) {
          // Rebuild reference data from its owners; preserve the immutable old snapshot.
          // Acceptance remains the original evidence, never a synthetic green result.
          const rebuilt = roleContext({
            gen,
            artifacts: artifacts,
            node: review,
            cwd: process.cwd(),
            base: context.refs.base,
            head: context.refs.head,
            deltaBase: context.refs.delta_base,
            patch: context.full_diff,
            delta: context.diff,
            environment,
            ...(typeof context.acceptance === 'string' ? {} : { acceptance: context.acceptance }),
          });
          if (rebuilt.carry_over === 'unknown')
            throw new Error(`context: cannot rebuild carry-over; original ${pointer.path}`);
          const path = freezeContext(artifacts, rebuilt);
          writeFileSync(
            join(artifacts, `${review}.context.json`),
            JSON.stringify({ path, rebuilt_from: pointer.path })
          );
        }
      }
      if (contextNode || pkg) {
        const node = contextNode?.length ? contextNode : `code-${pkg}`;
        const pointer = contextNode?.startsWith('repair-')
          ? (read(join(artifacts, `${node}.context.json`)) as { path: string } | 'unknown')
          : 'unknown';
        const prepared =
          pointer === 'unknown' ? 'unknown' : (read(pointer.path) as RoleContext | 'unknown');
        const context =
          prepared !== 'unknown'
            ? { ...prepared, cwd: process.cwd() }
            : roleContext({
                gen,
                artifacts: artifacts,
                node,
                cwd: process.cwd(),
                base: git.stdout.toString().trim(),
                head: git.stdout.toString().trim(),
                environment: environmentIdentity(projectEnvironment(process.env)),
              });
        if (pkg) {
          const path = freezeContext(artifacts, context);
          writeFileSync(join(artifacts, `${node}.context.json`), JSON.stringify({ path }));
        }
        packPath = join(artifacts, 'contexts', `${node}.md`);
        mkdirSync(dirname(packPath), { recursive: true });
        writeFileSync(
          packPath,
          contextPack(
            gen,
            context,
            process.env.INPUTS_CONTEXT_PACKAGES
              ? (JSON.parse(process.env.INPUTS_CONTEXT_PACKAGES) as string[])
              : undefined
          )
        );
      }
    }
    // Engine-resolved outputs are reference data, never acceptance or permission evidence.
    const handoff =
      process.env.INPUTS_HANDOFF === '1'
        ? freezeContext(artifacts, {
            version: 1,
            work: Object.fromEntries(
              (JSON.parse(process.env.INPUTS_WORK_KEYS ?? '') as string[]).map(key => [
                key.toUpperCase(),
                JSON.parse(
                  process.env[`INPUTS_WORK_${key.replace(/-/g, '_').toUpperCase()}`] ?? ''
                ),
              ])
            ),
          })
        : undefined;
    console.log(
      JSON.stringify({
        attempt,
        ...(packPath !== undefined ? { context_pack_path: packPath } : {}),
        ...(handoff ? { handoff } : {}),
      })
    );
  } catch (error) {
    const engine_error = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ reason: 'engine_suspect', engine_error }));
    process.exitCode = 1;
  }
}

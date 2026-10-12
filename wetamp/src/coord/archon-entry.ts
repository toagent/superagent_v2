// Supported Archon entry: scope resolution and the same owner/generation admission as superagent.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { caller, coord, repoScope, runScope, type Scope } from './index';
import { getRun } from '../archon';
import { WETAMP } from '../config';
import { cliArgOptions } from '../../../packages/cli/src/args';
const shared = createRequire(import.meta.url)('../../hooks/coord.cjs') as {
  archonMutation: (args: string[]) => boolean;
};

async function wake(id: string): Promise<number> {
  // Reuse native cursor/CAS, provider configuration and continuation reporting; only narrow the due-run source.
  await import('../../../packages/paths/src/strip-cwd-env-boot');
  const { loadCliEnv } = await import('../../../packages/cli/src/load-cli-env');
  await loadCliEnv(process.cwd());
  const { installPolicyExecutor } = await import('../policy-executor');
  installPolicyExecutor();
  const providers = await import('@archon/providers/in-process');
  providers.registerBuiltinProviders();
  providers.registerCommunityProviders();
  const { getPluginsPath } = await import('../../../packages/paths/src');
  const { loadProviderPlugins } =
    await import('../../../packages/core/src/providers/load-provider-plugins');
  for (const registration of await loadProviderPlugins(getPluginsPath()))
    providers.registerProvider(registration);
  const { setPlatformPolicies } = await import('../../../packages/core/src/platforms/registry');
  const { defaultPlatformPolicies } =
    await import('../../../packages/adapters/src/platform-policies');
  const { loadPlatformPolicies } =
    await import('../../../packages/core/src/platforms/chat-plugins');
  setPlatformPolicies(await loadPlatformPolicies(getPluginsPath(), defaultPlatformPolicies));
  const { createSqlWorkflowHost } = await import('../../../packages/core/src/workflows/sql-host');
  const { createCliWorkflowDeps } = await import('../../../packages/cli/src/utils/workflow-deps');
  const { workflowContinuationCommand } =
    await import('../../../packages/cli/src/commands/workflow-continuations');
  const host = createSqlWorkflowHost(createCliWorkflowDeps()),
    store = host.deps.store;
  const list = store.listDueWorkflowContinuations.bind(store);
  host.deps.store = {
    ...store,
    listDueWorkflowContinuations: async now =>
      (await list(now, 2147483647)).filter(r => r.id === id),
  };
  try {
    return await workflowContinuationCommand(host, 'wake', [], { json: true });
  } finally {
    const { closeDatabase } = await import('../../../packages/core/src/db/connection');
    await closeDatabase();
  }
}
export async function archonEntry(args: string[]): Promise<number> {
  let forwarded = args;
  const invoke = (): number =>
    Bun.spawnSync([process.execPath, join(WETAMP, 'src/archon-entry.ts'), ...forwarded], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }).exitCode;
  const { positionals, values } = parseArgs({
    args,
    options: cliArgOptions,
    allowPositionals: true,
    strict: true,
  });
  if (values.help || !shared.archonMutation(positionals)) return invoke();
  const [, verb] = positionals,
    rawTarget =
      verb === 'event' ? values['run-id'] : verb === 'run' ? values.adopt : positionals[2];
  const target =
    positionals[0] === 'workflow' && typeof rawTarget === 'string' ? rawTarget : undefined;
  if (verb === 'run' && values.resume && !target)
    throw new Error('coord: run --resume requires explicit --adopt run id');
  if (verb === 'wake' && (!target || target === 'schedule' || values.watch))
    throw new Error(
      'coord: workflow wake requires one run; global wake/watch/schedule is not admitted'
    );
  const c = coord(),
    registered = target ? c.resolveRun(target) : undefined;
  let scope: Scope,
    id = target;
  if (registered) {
    scope = runScope(registered);
    id = registered.archon_run_id;
  } else if (positionals[0] !== 'workflow' || (verb === 'run' && !target))
    scope = repoScope(typeof values.cwd === 'string' ? values.cwd : process.cwd());
  else {
    if (!target) throw new Error('coord: mutation requires a run id');
    const run = getRun(target),
      ledger = c.resolveRun(run.id),
      repo = ledger?.repo ?? run.working_path;
    if (!repo) throw new Error('coord: run has no working_path');
    scope = runScope(ledger ?? { run_id: run.id, repo });
    id = run.id;
  }
  if (target && id && id !== target)
    forwarded = args.map(word =>
      word === target
        ? id
        : word === `--run-id=${target}`
          ? `--run-id=${id}`
          : word === `--adopt=${target}`
            ? `--adopt=${id}`
            : word
    );
  const token = process.env.SA_COORD_ADMISSION;
  const context = token ? c.consume(token) : undefined;
  delete process.env.SA_COORD_ADMISSION;
  if (
    context?.scope.kind === 'run' &&
    verb === 'run' &&
    !target &&
    scope.kind === 'repo' &&
    scope.id === context.scope.repo
  )
    scope = context.scope;
  if (
    context &&
    (context.scope.kind === 'run'
      ? context.scope.id !== (scope.kind === 'run' ? scope.id : '')
      : context.scope.id !== (scope.kind === 'run' ? scope.repo : scope.id))
  )
    throw new Error('coord: admission scope mismatch');
  const who = context?.controller ?? caller();
  if (!c.owner(scope).owner && !context) c.claim(scope, who);
  const execute = (): number | Promise<number> => (verb === 'wake' && id ? wake(id) : invoke());
  if (context && c.inherited(context)) {
    c.admit(scope, who, context.controller.generation);
    return await execute();
  }
  return await c.mutate(scope, who, execute, context?.controller.generation);
}
if (import.meta.main) {
  try {
    process.exit(await archonEntry(process.argv.slice(2)));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

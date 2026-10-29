import {
  findCodebaseByDefaultCwd,
  findCodebaseByPathPrefix,
  listCodebases,
} from '@archon/core/db/codebases';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { findRepoRoot } from '@archon/git';
import {
  deleteCodebaseEnvVar,
  getCodebaseEnvVars,
  setCodebaseEnvVar,
} from '@archon/core/db/env-vars';
import { assertCodebaseEnvVarsAllowed } from '@archon/workflows/run-preflight';

export async function codebaseEnvCommand(
  action: string | undefined,
  args: string[],
  cwd: string
): Promise<void> {
  const repoRoot = await findRepoRoot(cwd);
  const codebase = repoRoot
    ? await findCodebaseForCheckoutPath(repoRoot, {
        findCodebaseByDefaultCwd,
        listCodebases,
      })
    : ((await findCodebaseByDefaultCwd(cwd)) ?? (await findCodebaseByPathPrefix(cwd)));
  if (!codebase) throw new Error(`No registered codebase found for: ${cwd}`);

  if (action === 'list' && args.length === 0) {
    for (const key of Object.keys(await getCodebaseEnvVars(codebase.id)).sort()) console.log(key);
    return;
  }
  if (action === 'set' && args.length === 2) {
    const [key, value] = args as [string, string];
    assertCodebaseEnvVarsAllowed({ [key]: value });
    await setCodebaseEnvVar(codebase.id, key, value);
    return;
  }
  if (action === 'unset' && args.length === 1) {
    await deleteCodebaseEnvVar(codebase.id, args[0] ?? '');
    return;
  }
  throw new Error('Usage: archon codebase env <list|set KEY VALUE|unset KEY>');
}

// 同步 CLI 的独立预检进程；复用 Archon 的分支检测与配置，不复制检测算法。
import { inspectProjectBaseBranch } from '../../packages/core/src/handlers/clone';
import { loadRepoConfig } from '../../packages/core/src/config/config-loader';
import { validateBranchName } from '@archon/git';
export async function inspectBase(repo: string): Promise<void> {
  const inspection = await inspectProjectBaseBranch({ path: repo });
  const configured = (await loadRepoConfig(repo)).worktree?.baseBranch?.trim();
  if (configured) {
    await validateBranchName(configured);
    // 原生 worktree.baseBranch 是显式覆盖，inspect 的 remote HEAD 缺失不应覆盖它。
    return;
  } else if (inspection.kind === 'repo' && inspection.defaultBranch) return;
  throw new Error(
    'preflight: No base branch could be detected; set worktree.baseBranch in .archon/config.yaml'
  );
}
if (import.meta.main) {
  try {
    await inspectBase(process.argv[2]);
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: (e as Error).message }));
    process.exit(1);
  }
}

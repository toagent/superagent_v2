interface GitResult {
  exitCode: number | null;
  signalCode?: string | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
}

/** Shared raw evidence; untracked test output is intentionally outside review integrity. */
export function checkoutFingerprint(
  run: (args: string[]) => GitResult,
  allowNonRepo = false
): string {
  const probe = run(['rev-parse', '--is-inside-work-tree']);
  if (probe.exitCode !== 0 || probe.signalCode || probe.stdout.toString().trim() !== 'true') {
    if (allowNonRepo) return 'no-repo';
    throw new Error(`checkout integrity: worktree unavailable: ${probe.stderr.toString()}`);
  }
  const evidence = (args: string[]): string => {
    const p = run(args);
    if (p.exitCode !== 0 || p.signalCode)
      throw new Error(`checkout integrity: git ${args[0]}: ${p.stderr.toString()}`);
    return p.stdout.toString();
  };
  const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.signalCode || (head.exitCode !== 0 && head.exitCode !== 1))
    throw new Error(`checkout integrity: HEAD: ${head.stderr.toString()}`);
  const id = head.stdout.toString().trim();
  return JSON.stringify([
    id,
    evidence(['status', '--porcelain', '-z', '-uno']),
    id
      ? evidence(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'])
      : evidence(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached', '--']) +
        evidence(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--']),
  ]);
}

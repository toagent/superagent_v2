import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const hookNames = new Set(('applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman post-index-change').split(' '));

/** Shared, portable observation only. Installation and hook preparation belong to the operator. */
export function envPrecheck(cwd: string) {
  const failures: { failure_class: 'test_env'; evidence: string; recovery: string[] }[] = [];
  const fail = (evidence: string, recovery: string[] = []) =>
    failures.push({ failure_class: 'test_env', evidence, recovery });
  const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  let dependencies: 'unknown' | 'not_required' = 'not_required';
  let hookStatus: 'unknown' | 'observed' | 'not_configured' = 'not_configured';
  try {
    const manifest = join(cwd, 'package.json');
    const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) as {
      packageManager?: string; dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>; workspaces?: unknown; scripts?: Record<string, string>;
    } : undefined;
    const locks = [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']] as const;
    const present = locks.filter(([file]) => existsSync(join(cwd, file)));
    const managers = new Set(present.map(([, manager]) => String(manager)));
    const selected = pkg?.packageManager?.split('@')[0];
    if (selected) managers.add(selected);
    for (const manager of managers) if (!Bun.which(manager)) fail(`missing declared tool: ${manager}`);
    const manager = selected ?? (managers.size === 1 ? [...managers][0] : undefined);
    const installs: Record<string, string> = { bun: 'bun install --frozen-lockfile', npm: 'npm ci',
      pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --immutable' };
    const prepare = pkg?.scripts?.prepare && manager ? [`${manager} run prepare`] : [];
    const needed = !pkg || !!pkg.workspaces || Object.keys(pkg.dependencies ?? {}).length > 0 ||
      Object.keys(pkg.devDependencies ?? {}).length > 0;
    if (present.length && needed) {
      dependencies = 'unknown';
      const dir = join(cwd, 'node_modules');
      if (!existsSync(dir) || !statSync(dir).isDirectory())
        fail(`missing dependency directory: ${dir}; lockfiles: ${present.map(([f]) => f).join(', ')}`,
          manager && installs[manager] ? [installs[manager]!] : []);
    }
    // Exit 1 is git-config's structured "unset" result, not an error-text heuristic.
    if (git('rev-parse', '--is-inside-work-tree').status === 0) {
      const configured = git('config', '--get', 'core.hooksPath');
      if (configured.status !== 0 && configured.status !== 1) fail('cannot resolve core.hooksPath');
      if (configured.status === 0 && configured.stdout.trim()) {
        const root = git('rev-parse', '--show-toplevel');
        if (root.status !== 0) fail('cannot resolve checkout root');
        else {
          const hooks = resolve(cwd, configured.stdout.trim());
          // Husky tracks the source hooks beside its generated `_` dispatchers.
          const sources = basename(hooks) === '_' ? dirname(hooks) : hooks;
          const scope = relative(root.stdout.trim(), sources);
          const external = scope === '..' || scope.startsWith('../') || isAbsolute(scope);
          hookStatus = external ? 'unknown' : 'observed';
          const files = external ? { status: 0, stdout: '' } : spawnSync('git', ['ls-files', '-z', '--', scope || '.'],
            { cwd: root.stdout.trim(), encoding: 'utf8' });
          if (files.status !== 0) fail('cannot enumerate tracked hooks');
          else for (const file of files.stdout.split('\0').filter(Boolean)) {
            const source = join(root.stdout.trim(), file);
            if (dirname(source) !== sources || !hookNames.has(basename(source))) continue;
            const hook = join(hooks, basename(source));
            try {
              if (!statSync(source).isFile() || !statSync(hook).isFile()) throw new Error('not a file');
              accessSync(hook, constants.X_OK);
            } catch { fail(`missing or non-executable required hook: ${hook}`, prepare); }
          }
        }
      }
    }
  } catch {
    fail('cannot read environment declaration or filesystem metadata');
  }
  return { ok: failures.length === 0, dependencies, hooks: hookStatus, failures };
}

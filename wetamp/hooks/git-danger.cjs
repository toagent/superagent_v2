'use strict';
// Shared Git danger classifier; all clients use the existing shell AST through redline.
const path = require('node:path');
const EFFECTS = require('./shell-effects.json');
const {spawnSync} = require('node:child_process');
const {resolvePath, expand, checkoutOf, message} = require('./redline.cjs');
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
function gitInvocation(argv, dir, env) {
  // undefined = absent; {path: null} = explicitly unknown; {path} = resolved.
  const locate = value => ({path: typeof value !== 'string' || !value || /[$`*?\[\]{}]|__sa_sub__|__sa_unknown_cwd__/.test(expand(value, env))
    ? null : resolvePath(path.resolve(dir, expand(value, env)))});
  let i = 1, gitDir = env.GIT_DIR, workTree = env.GIT_WORK_TREE;
  const locations = [locate(dir)];
  const explicit = [gitDir, workTree].filter(value => value !== undefined);
  while (argv[i]?.startsWith('-')) {
    if (argv[i] === '--') { i++; break; }
    const [option, attached] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]];
    const value = attached ?? argv[i + 1];
    if (option === '-C' || /^-C.+/.test(option)) {
      const location = locate(option === '-C' ? value : option.slice(2)); locations.push(location); dir = location.path || '/__sa_unknown_cwd__';
    }
    if (option === '--git-dir') gitDir = value ?? '';
    if (option === '--work-tree') workTree = value ?? '';
    if (option === '--git-dir' || option === '--work-tree') explicit.push(value ?? '');
    i += GIT_VALUE_OPTIONS.includes(option) && attached === undefined ? 2 : 1;
  }
  gitDir = gitDir === undefined ? undefined : locate(gitDir);
  workTree = workTree === undefined ? undefined : locate(workTree);
  const base = (workTree ?? gitDir ?? locate(dir)).path;
  const checkout = base && (workTree || gitDir ? base : checkoutOf(base));
  return {base: base || '/__sa_unknown_cwd__', directory: dir, checkout, locations: [...locations, ...explicit.map(locate)], prefix: argv.slice(1, i), sub: argv[i], rest: argv.slice(i + 1)};
}
// Manual-only adapter policy uses Git option semantics, before the shared danger policy.
function manualReason(argv, dir, env) {
  const {sub, rest} = gitInvocation(argv, dir, env);
  const options = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length);
  const long = (word, flag) => word.startsWith('--') && word.length > 2 && flag.startsWith(word.slice(2).split('=')[0]);
  if (sub === 'push') return message('执行 git push', 'git push 须人工执行');
  if (sub === 'commit' && options.some(v => long(v, 'no-verify') || /^-[^-]*n/.test(v)))
    return message('跳过 Git 提交检查', '会绕过提交护栏');
  if (sub === 'add' && options.some(v => long(v, 'all') || long(v, 'no-ignore-removal') || /^-[^-]*A/.test(v)))
    return message('暂存整个工作区', '请明确指定文件或目录');
  return null;
}
// Delete only when another surviving branch owns the commits; tags/reflogs do not count.
function safeGitDelete(sub, rest, query, dir, env, deletions) {
  const short = letter => rest.some(v => /^-[A-Za-z]+$/.test(v) && v.includes(letter));
  const force = short('f') || rest.some(v => /^--f(?:o(?:r(?:c(?:e)?)?)?)?$/.test(v)) || short('D'); // R1-1: Git accepts unique long-option prefixes.
  const branch = sub === 'branch' && (short('d') || short('D') || rest.some(v => /^--d(?:e(?:l(?:e(?:t(?:e)?)?)?)?)?$/.test(v)));
  const worktree = sub === 'worktree' && ['remove', 'prune'].includes(rest[0]);
  if (!branch && !worktree) return undefined;
  if (branch && (['m', 'M', 'c', 'C'].some(short) || rest.some(v => ['--move', '--copy'].includes(v)))) return undefined;
  if (!force && !branch) return null; // Git itself refuses unsafe non-forced deletion.
  const reachable = (tip, excluded = []) => {
    const refs = query(['for-each-ref', '--format=%(refname)%09%(symref)', `--contains=${tip}`, 'refs/heads', 'refs/remotes']);
    return refs !== null && refs.split('\n').some(line => {
      const [ref, symbolic] = line.split('\t');
      return ref && !symbolic && !excluded.includes(ref);
    });
  };
  try {
    if (branch) {
      const remote = short('r') || rest.includes('--remotes');
      const forced = force || remote; // Git deletes remote-tracking branches without a merge check.
      const refs = rest.filter(v => !v.startsWith('-')).map(v => `refs/${remote ? 'remotes' : 'heads'}/${v}`);
      const common = query(['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!common) return forced ? message('删除分支', 'Git 安全查询失败') : null;
      const excluded = deletions.get(common) || new Set(); // R1-3: prior commands have not executed yet.
      refs.forEach(ref => excluded.add(ref)); deletions.set(common, excluded);
      if (!forced || refs.length && refs.every(ref => reachable(ref, [...excluded]))) return null;
      return message('删除分支', '分支有未合并提交，删除会丢失（或 Git 查询失败）');
    }
    if (rest[0] === 'prune') return null;
    const targets = rest.slice(1).filter(v => !v.startsWith('-'));
    if (targets.length === 1 && !/[$`*?\[\]{}]|__sa_/.test(targets[0])) {
      const operand = expand(targets[0], env), absolute = path.resolve(dir, operand);
      const listing = query(['worktree', 'list', '--porcelain', '-z']); // R1-2: Git also accepts a unique path suffix.
      const trees = listing?.split('\0').filter(v => v.startsWith('worktree ')).map(v => v.slice(9)) || [];
      const matches = trees.includes(absolute) ? [absolute] : trees.filter(v => !path.isAbsolute(operand) && v.endsWith('/' + operand));
      if (matches.length !== 1) return message('删除工作树', 'Git 查询失败（工作树目标不存在或不明确）');
      const target = matches[0];
      // Inspect the actual checkout, not an inherited alternate index or Git directory.
      const cleanEnv = Object.fromEntries(Object.entries({...process.env, ...env}).filter(([key]) => !key.startsWith('GIT_')));
      const inspect = args => {
        const r = spawnSync('git', ['-C', target, ...args], {encoding: 'utf8', timeout: 3000, env: {...cleanEnv, GIT_OPTIONAL_LOCKS: '0'}});
        return r.status === 0 ? r.stdout.trim() : null;
      };
      const status = inspect(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
      const head = inspect(['rev-parse', '--verify', 'HEAD']);
      if (status === '' && head && reachable(head)) return null;
    }
    return message('删除工作树', '工作树有未提交改动或未保留的提交（或 Git 查询失败）');
  } catch { return message('删除 git 对象', 'Git 安全查询失败'); }
}
function reason(argv, dir, root, env, deletions) {
    const {directory, prefix, sub, rest} = gitInvocation(argv, dir, env);
    if (sub === 'init') return null;
    const options = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length);
    if (sub === 'push') {
      if (options.some(v => /^--dr(?:y(?:-(?:r(?:u(?:n)?)?)?)?)?(?:=|$)|^-[^-]*n/.test(v))) return null;
      if (rest.some(v => v.startsWith('--') && v.length > 2
          ? ['force', 'force-with-lease', 'force-if-includes', 'delete', 'mirror', 'prune'].some(flag => flag.startsWith(v.slice(2).split('=')[0]))
          : /^-[^-]*[fd]|^\+|^:/.test(v)))
        return message('执行 git push', '会强制改写或删除共享远端历史');
      return null;
    }
    const gitEffects = EFFECTS.find(r => r.commands[0] === 'git');
    const destructiveRule = gitEffects.destructive[sub];
    const matches = (pattern, words = rest) => pattern && words.some(word => new RegExp(pattern).test(word));
    const destructive = matches(gitEffects.destructiveFlags[sub])
      || destructiveRule && (!destructiveRule.pattern || matches(destructiveRule.pattern)) && !matches(destructiveRule.unless, options);
    const query = args => {
      const r = spawnSync('git', [...prefix, ...args], {cwd: dir, encoding: 'utf8', timeout: 3000, env: {...process.env, ...env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1'}});
      return r.status === 0 ? r.stdout.trim() : null;
    };
    let pathRestore = sub === 'checkout' && matches('^--pathspec-from-file(?:=|$)|^--patch$|^-[^-]*p');
    if (sub === 'checkout') {
      const operands = [];
      for (let i = 0; i < rest.length; i++) {
        if (['-b', '-B', '--orphan'].includes(rest[i])) { i++; continue; }
        if (!rest[i].startsWith('-')) operands.push(rest[i]);
      }
      // A single commit/ref switches branches; otherwise checkout restores paths.
      if (operands.length) {
        const ref = operands[0];
        const commit = query(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
        const remote = !commit && !/[$`*?\[\]{}]|__sa_/.test(ref)
          ? query(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${ref}`]) : null;
        pathRestore ||= operands.length > 1 || !commit && !(remote && remote.split('\n').length === 1);
      }
    }
    const force = matches('^-[^-]*f|^--f(?:o(?:r(?:c(?:e)?)?)?)?(?:=|$)');
    const backupOption = rest.indexOf('--original');
    const backupRefs = backupOption < 0 ? 'refs/original' : rest[backupOption + 1];
    const dataLoss = sub === 'gc' && rest.some((word, i) => /^--p(?:r(?:u(?:n(?:e)?)?)?)?$/.test(word) && ['now', 'all', '0'].includes(rest[i + 1]))
      || sub === 'read-tree' && matches('^-[^-]*u') && matches('^--r(?:e(?:s(?:e(?:t)?)?)?)?$') && !matches('^-[^-]*n|^--dry-run$', options)
      || sub === 'submodule' && rest.find(word => !word.startsWith('-')) === 'deinit' && force
      || sub === 'filter-branch' && force && (!backupRefs || query(['for-each-ref', '--format=%(refname)', backupRefs]) !== '');
    const deletion = safeGitDelete(sub, rest, query, directory, env, deletions);
    if (deletion) return deletion;
    if ((destructive || pathRestore || dataLoss) && deletion === undefined)
      return message('执行破坏性 Git 操作', '会丢弃文件改动或删除、覆盖 Git 数据');
    return null;
}
module.exports = {reason, gitInvocation, manualReason};

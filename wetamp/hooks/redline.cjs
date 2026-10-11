'use strict';
// Default allow. Effects and ownership establish danger; uncertainty is advisory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const EFFECTS = require('./shell-effects.json');
const microEdit = require('./micro-edit.cjs');

// child is parent itself or below it.
const within = (child, parent) => { const r = path.relative(parent, child); return r !== '..' && !r.startsWith('../') && !path.isAbsolute(r); };
function resolvePath(file) {
  let cursor = file; const tail = [];
  while (!fs.existsSync(cursor)) {
    tail.unshift(path.basename(cursor)); const parent = path.dirname(cursor);
    if (parent === cursor) return file;
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...tail);
}
const homeOf = env => env.HOME || os.homedir();
const expand = (word, env) => word.replace(/^~(?=\/|$)/, homeOf(env)).replace(/\$\{HOME\}|\$HOME\b/g, homeOf(env));

const SSH_PUBLIC = ['known_hosts', 'known_hosts.old', 'config'];
const SECRET_FILES = [['.aws', 'credentials'], ['.netrc'], ['.config', 'gh', 'hosts.yml'], ['.npmrc'], ['.pypirc']];
const BROWSER = [
  ['Library', 'Application Support', 'Google', 'Chrome'], ['Library', 'Application Support', 'Chromium'],
  ['Library', 'Application Support', 'Arc'], ['Library', 'Application Support', 'Microsoft Edge'],
  ['Library', 'Application Support', 'Firefox'], ['Library', 'Safari'], ['Library', 'Containers', 'com.apple.Safari'],
  ['Library', 'Cookies'],
];
// 绝对路径命中的红线类别，未命中为 null。APFS 默认大小写不敏感，按小写比较。
function secretKind(abs, env) {
  const p = path.normalize(abs).toLowerCase(), home = path.normalize(homeOf(env)).toLowerCase();
  const under = segs => { const root = path.join(home, ...segs).toLowerCase(); return p === root || p.startsWith(root + '/'); };
  if (p.split('/').includes('_private')) return '_private';
  if (under(['.ssh']) && p !== path.join(home, '.ssh')) {
    const base = path.basename(p);
    if (!base.endsWith('.pub') && !SSH_PUBLIC.includes(base)) return 'ssh 私钥';
  }
  if (under(['Library', 'Keychains'])) return '钥匙串';
  if (SECRET_FILES.some(under)) return '凭据文件';
  if (under(['Library', 'Mobile Documents'])) return 'iCloud';
  if (BROWSER.some(under)) return '浏览器资料';
  return null;
}
function pathKind(file, base, env) {
  const abs = path.resolve(base, expand(file, env));
  return secretKind(abs, env) ?? secretKind(resolvePath(abs), env);
}
// 一个 shell 词里可能指向受保护路径的部分：整词（含 `--opt=` 后的值）与词内嵌的 ~/$HOME/绝对路径。
// 不含 / 的相对词只在文件存在时才算路径（`grep _private src` 里的 _private 是模式）。
function wordKind(word, dir, env) {
  const parts = [word, word.slice(word.indexOf('=') + 1), ...(word.match(/(?:~|\$\{?HOME\}?|\/)[^\s'"`;|&<>()=,]*/g) ?? [])];
  for (const part of parts) {
    if (!part || part.startsWith('-')) continue;
    const literal = /^(?:~|\$\{?HOME\}?|\/)/.test(part) || part.includes('/');
    if (!literal && !fs.existsSync(path.resolve(dir, part))) continue;
    const kind = pathKind(part, dir, env);
    if (kind) return kind;
  }
  return null;
}

const PROTECTED = /^(?:refs\/heads\/)?(?:main|master|develop|wetamp|release-.+)$/;
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
function gitInvocation(argv, dir, env) {
  // undefined = absent; {path: null} = explicitly unknown; {path} = resolved.
  const locate = value => ({path: typeof value !== 'string' || !value || /[$`*?\[\]{}]|__sa_sub__|__sa_unknown_cwd__/.test(expand(value, env))
    ? null : resolvePath(path.resolve(dir, expand(value, env)))});
  let i = 1, gitDir = env.GIT_DIR, workTree = env.GIT_WORK_TREE;
  const locations = [locate(dir)];
  const explicit = [gitDir, workTree].filter(value => value !== undefined);
  while (argv[i]?.startsWith('-')) {
    const option = argv[i], value = argv[i + 1];
    if (option === '-C' || /^-C.+/.test(option)) {
      const location = locate(option === '-C' ? value : option.slice(2)); locations.push(location); dir = location.path || '/__sa_unknown_cwd__';
    }
    if (option === '--git-dir') gitDir = value ?? '';
    if (option === '--work-tree') workTree = value ?? '';
    if (option === '--git-dir' || option === '--work-tree') explicit.push(value ?? '');
    i += GIT_VALUE_OPTIONS.includes(option) ? 2 : 1;
  }
  gitDir = gitDir === undefined ? undefined : locate(gitDir);
  workTree = workTree === undefined ? undefined : locate(workTree);
  const base = (workTree ?? gitDir ?? locate(dir)).path;
  const metadata = gitDir?.path;
  const checkout = base && (workTree || gitDir ? base : checkoutOf(base));
  return {base: base || '/__sa_unknown_cwd__', checkout, metadata, locations: [...locations, ...explicit.map(locate)], sub: argv[i], rest: argv.slice(i + 1)};
}
const currentBranch = dir => {
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], {encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  return r.status === 0 ? r.stdout.trim() : '';
};
function gitQuery(sub, rest) {
  const rules = EFFECTS.find(r => r.commands[0] === 'git');
  return rules.read.includes(sub) || !rest.length && ['branch','tag','remote','reflog'].includes(sub)
    || (rules.queries[sub] || []).some(flag => rest.includes(flag))
      && !rest.some(flag => new RegExp(rules.mutationFlags).test(flag));
}
function gitReadOnly(argv) {
  let i = 1;
  while (argv[i]?.startsWith('-')) i += GIT_VALUE_OPTIONS.includes(argv[i]) ? 2 : 1;
  return gitQuery(argv[i], argv.slice(i + 1));
}
function gitReason(argv, dir) {
  let i = 1;
  while (argv[i]?.startsWith('-')) {
    if (argv[i] === '-C' && argv[i + 1]) dir = path.resolve(dir, argv[i + 1]);
    i += GIT_VALUE_OPTIONS.includes(argv[i]) ? 2 : 1;
  }
  const [sub, ...rest] = argv.slice(i);
  const flags = rest.filter(a => a.startsWith('-')), operands = rest.filter(a => !a.startsWith('-'));
  const shared = operands.find(a => PROTECTED.test(a));
  const msg = () => '受保护分支';
  if (sub === 'branch' && shared && flags.some(f => /^-[a-zA-Z]*[fDMmC]|^--(?:force|move)$/.test(f))) return msg(shared);
  if (sub === 'update-ref') {
    if (shared) return msg(shared);
    if (operands[0] === 'HEAD' && PROTECTED.test(currentBranch(dir))) return msg(currentBranch(dir));
  }
  if ((sub === 'checkout' && flags.includes('-B') || sub === 'switch' && flags.some(f => ['-C', '--force-create'].includes(f))) && shared) return msg(shared);
  if (sub === 'rebase' && !flags.some(f => ['--abort', '--quit'].includes(f))) {
    const pos = [];
    for (let j = 0; j < rest.length; j++) {
      if (['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'].includes(rest[j])) j++;
      else if (!rest[j].startsWith('-')) pos.push(rest[j]);
    }
    const target = pos.length >= 2 ? pos[1] : currentBranch(dir);
    if (PROTECTED.test(target)) return msg(target);
  }
  return null;
}


// One reminder exit: call sites supply actions, categories and file targets, never command contents.
const message = (action, consequence, alternative = '需要主控执行', target) => {
  let label = target?.kind || '';
  if (target?.url) { try { label = new URL(target.url).hostname; } catch { label = '外部服务'; } }
  return `已拦截：${action}${label ? `（${label}）` : ''}。原因：${consequence}。可以：${alternative}。`;
};
const commandLabel = argv => {
  const name = path.posix.basename(argv[0] || '');
  return EFFECTS.flatMap(rule => [...rule.commands, ...(rule.commandPrefixes || [])]).find(command => name === command || name.startsWith(command + '-')) || '命令';
};
function effects(argv) {
  const name = path.posix.basename(argv[0] || ''), args = argv.slice(1), operands = args.filter(a => !a.startsWith('-'));
  return EFFECTS.filter(rule => (rule.commands.includes(name) || rule.commandPrefixes?.some(prefix => name.startsWith(prefix)))
    && (!rule.pattern || args.some(a => new RegExp(rule.pattern).test(a)))
    && (!rule.prefixes || rule.prefixes.some(prefix => prefix.every((v, i) => operands[i] === v))))
    .flatMap(rule => {
      let targets = [];
      if (rule.targets === 'operands') targets = operands;
      if (rule.targets === 'last') targets = operands.slice(-1);
      if (rule.targets === 'first') targets = operands.slice(0, 1);
      if (rule.targets === 'of') targets = args.filter(a => a.startsWith('of=')).map(a => a.slice(3));
      if (rule.targets === 'option') {
        for (let i = 0; i < args.length; i++) for (const option of rule.options) {
          if (args[i] === option && args[i + 1]) targets.push(args[i + 1]);
          else if (args[i].startsWith(option + '=') || option.length === 2 && args[i].startsWith(option) && args[i].length > 2)
            targets.push(args[i].slice(option.length).replace(/^=/, ''));
        }
        if (!targets.length && rule.default) targets.push(rule.default);
      }
      const effect = rule.append?.some(option => args.includes(option)) ? 'write' : rule.effect;
      return rule.targets ? targets.map(target => ({effect, target})) : [{effect, target: name, argv}];
    });
}
function taskRoots(cwd, root, env) {
  const home = homeOf(env);
  return [root || cwd, '/tmp', '/private/tmp', env.TMPDIR, '/var/folders', '/private/var/folders', env.ARTIFACTS_DIR, env.SUPERAGENT_ARTIFACTS_DIR,
    ...['.bun', '.npm', '.cache', 'Library/Caches', '.m2', '.gradle', '.cargo'].map(d => path.join(home, d))]
    .filter(Boolean).map(r => resolvePath(path.resolve(r)));
}
function taskOwnership(file, dir, root, env, git = false) {
  if (!file) return null;
  if (root) {
    const repository = resolvePath(root), marker = path.join(repository, '.git');
    const metadata = git && fs.existsSync(marker) && fs.statSync(marker).isFile()
      ? resolvePath(path.resolve(repository, fs.readFileSync(marker, 'utf8').trim().slice(8))) : resolvePath(marker);
    // File scope is containment; Git scope is this checkout or its exact metadata.
    if (git ? file === metadata || file === marker || !within(file, marker) && checkoutOf(file) === repository
      : within(file, repository)) return 'repository';
  }
  if (!taskRoots(dir, root, env).some(r => within(file, r))) return null;
  // A generated mktemp product owns its repository too; existing temp repos do not.
  return require('./shell-ast.cjs').isTemporaryPath(file) ? 'repository' : 'artifact';
}
function checkoutOf(file) {
  let dir = file;
  while (path.dirname(dir) !== dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return resolvePath(dir);
    dir = path.dirname(dir);
  }
  return null;
}
function protectedKind(abs, root, env) {
  const home = path.resolve(homeOf(env)), rel = path.relative(home, abs);
  const own = root && within(abs, resolvePath(root));
  const local = own ? path.relative(resolvePath(root), abs).split(path.sep) : [];
  if (local[0] === '.git' || /^\.(?:codex|claude|opencode|agents)$/.test(local[0] || '')) return '护栏或 agent/provider 配置';
  if (!own && within(abs, home) && rel.split(path.sep)[0].startsWith('.')) return '家目录下的配置或凭据';
  if (['/etc','/private/etc','/System','/usr','/bin','/sbin','/Library','/Applications'].some(dir => within(abs, dir))) return '系统目录';
  const checkout = checkoutOf(abs);
  if (checkout && root && checkout !== resolvePath(root)) return '非本任务的 git 检出';
  return null;
}
function targetReason(effect, target, dir, root, env, reviewer, advisory) {
  const expanded = expand(target, env);
  if (!target || /[$`*?\[\]{}]|__sa_sub__/.test(expanded) || dir.startsWith('/__sa_unknown_cwd__') && !path.isAbsolute(expanded)) {
    if (['destroy','overwrite'].includes(effect)) return message('销毁或覆盖目标', '无法确认目标是否属于本任务', '使用明确的本任务路径', {kind: '未知路径'});
    advisory('write_target_unknown'); return null;
  }
  const lexical = path.resolve(dir, expanded), abs = resolvePath(lexical);
  const task = taskOwnership(abs, dir, root, env);
  const protectedLocation = protectedKind(lexical, root, env) || protectedKind(abs, root, env);
  const packageCache = ['.bun','.npm','.cache','.m2','.gradle','.cargo'].some(d => within(abs, path.join(homeOf(env), d)));
  if (protectedLocation && !(packageCache && protectedLocation === '家目录下的配置或凭据'))
    return message('写入文件', `会修改${protectedLocation}`, '改用 worktree 或临时目录中的文件', {kind: within(abs, path.join(homeOf(env), '.superagent')) ? '~/.superagent' : protectedLocation});
  if (reviewer && root && within(abs, resolvePath(root))) return message('修改被审仓库', 'reviewer 只读，修改会污染评审对象', '在临时目录创建文件并运行测试或脚本', {kind: `本任务仓库：${abs}`});
  if (effect === 'destroy' && [root, homeOf(env), env.SUPERAGENT_HOME, '/'].filter(Boolean).some(r => within(resolvePath(r), abs)))
    return message('删除目录', '它是或包含受保护目录', '只删除本任务的明确产物文件', {kind: '受保护目录'});
  if (!task && (effect === 'destroy' || fs.existsSync(abs)) && ['destroy','overwrite','write'].includes(effect))
    return message('销毁或覆盖文件', '会破坏不属于本任务的已有数据', '在 worktree 或临时目录创建副本', {kind: '任务范围外路径'});
  return null;
}
function actionReason({effect, target, argv}, dir, root, env, reviewer, advisory, names) {
  if (effect === 'delegate') return message(`派生会话再次调用 AI（${commandLabel(argv)}）`, '派生会话不能再派生或委派', '在本会话完成，或回报元帅');
  if (['create','destroy','overwrite','write'].includes(effect)) return targetReason(effect, target, dir, root, env, reviewer, advisory);
  if (effect === 'elevate') return message(`通过 ${commandLabel(argv)} 提升权限`, '会越过本任务权限边界');
  if (effect === 'credential') return message(`通过 ${commandLabel(argv)} 读取钥匙串`, '凭据内容不能交给模型');
  if (effect === 'external') {
    // Arguments are untrusted data and may contain credentials or message bodies.
    const url = argv.find(v => /^https?:\/\//.test(v));
    return message(`通过 ${commandLabel(argv)} 发布或写入`, '会对外发布、写入或产生不可撤回的影响', undefined, {url});
  }
  if (effect === 'process_selection') return message(`通过 ${commandLabel(argv)} 按名称或模式停止进程`, '可能影响本任务以外的进程', '对自己启动且记录的明确 PID 发信号');
  if (effect === 'signal') {
    const args = argv.slice(1), operands = []; let separator = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--') { separator = true; continue; }
      if (!separator && ['-s','--signal','-n'].includes(args[i])) { i++; continue; }
      if (!separator && i === 0 && /^-(?:[A-Za-z]+|\d+)$/.test(args[i])) continue;
      operands.push(args[i]);
    }
    if (names.size)
      return message('按端口或名称查询结果停止进程（kill）', '可能影响本任务以外的进程', '对自己启动且记录的明确 PID 发信号');
    if (operands.some(v => v === '0' || /^-\d+$/.test(v) || /pgrep|pidof|lsof/.test(v)))
      return message('通过 kill 向一组进程发信号', '会选择一组进程或影响本任务以外的进程', '对自己启动且记录的明确 PID 发信号');
  }
  if (effect === 'git') {
    const {base, checkout, metadata, locations, sub, rest} = gitInvocation(argv, dir, env);
    const owned = file => taskOwnership(file, dir, root, env, true) === 'repository';
    if (sub === 'init' && !(reviewer && root && within(resolvePath(base), resolvePath(root)))) return null;
    if (sub === 'push') return message(`执行 git ${sub}`, '会改写共享的远端版本历史');
    const gitEffects = EFFECTS.find(r => r.commands[0] === 'git');
    const query = gitQuery(sub, rest);
    const destructiveRule = gitEffects.destructive[sub];
    const matches = pattern => pattern && rest.some(word => new RegExp(pattern).test(word));
    const destructive = !query && (matches(gitEffects.forceFlags) || matches(gitEffects.destructiveFlags[sub])
      || destructiveRule && (!destructiveRule.pattern || matches(destructiveRule.pattern)) && !matches(destructiveRule.unless));
    if (destructive && (locations.some(location => !owned(location.path)) || !owned(checkout || base)))
      return message('修改未知或非本任务的 git 对象', '无法确认操作对象属于本任务');
    if (sub === 'config' && !query) {
      if (base.startsWith('/__sa_unknown_cwd__')) return targetReason('overwrite', '', dir, root, env, reviewer, advisory);
      const fileIndex = rest.findIndex(v => v === '--file' || v === '-f');
      const config = rest.includes('--global') ? path.join(homeOf(env), '.gitconfig') : rest.includes('--system') ? '/etc/gitconfig'
        : fileIndex >= 0 ? rest[fileIndex + 1] : metadata ? path.join(metadata, 'config') : path.join(base, '.git/config');
      return targetReason('overwrite', config || '', dir, root, env, reviewer, advisory);
    }
    if (reviewer && !query && (sub === 'commit' || root && within(resolvePath(base), resolvePath(root))))
      return message('在被审仓库执行 git 写入', 'reviewer 只读，提交或修改会污染评审对象', '只查询仓库，在临时目录运行测试');
    const why = gitReason(['git', sub, ...rest], base);
    if (why) return message(`执行 git ${sub}`, '会改写共享的版本历史', undefined, {kind: why});
    if (sub === 'branch' && destructive && rest.some(v => /^-[a-zA-Z]*[dD]|^--delete$/.test(v))) {
      const branch = rest.find(v => !v.startsWith('-'));
      if (branch && branch !== currentBranch(dir)) return message('删除分支', '无法确认这是本任务拥有的分支', undefined, {kind: '非本任务分支'});
    }
  }
  return null;
}
const READ_TOOLS = {Read: ['file_path'], NotebookRead: ['notebook_path'], Grep: ['path'], Glob: ['path'], LS: ['path'], view_image: ['path']};
function reason({client, name, input = {}, cwd, root, shell, derived, env = process.env, onCommand, onAdvisory = () => {}, reviewer = false}) {
  try {
    const edit = microEdit.isEdit(client, name);
    let targets = [];
    if (edit) {
      try { targets = client === 'codex' ? microEdit.patchEdits(input).map(e => e.file) : [input.file_path || input.notebook_path]; }
      catch { onAdvisory('patch_target_unknown'); return null; }
    }
    for (const file of [...(READ_TOOLS[name] ?? []).map(k => input[k]), ...targets].filter(v => typeof v === 'string' && v)) {
      const kind = pathKind(file, cwd, env);
      if (kind) return message('读写隐私文件', '会让凭据或隐私内容进入模型上下文', '使用不含凭据或隐私的文件', {kind});
    }
    if (edit && (derived || reviewer)) for (const target of targets) {
      const why = targetReason('overwrite', target || '', cwd, root, env, reviewer, onAdvisory); if (why) return why;
    }
    if (shell === undefined) return null;
    return require('./shell-ast.cjs').analyze(shell, cwd, env, (parsed, dir) => {
      onCommand?.(parsed);
      const names = new Set(parsed.selections || []);
      for (const argv of parsed.argvs) {
        for (const word of argv) {
          const kind = wordKind(word, dir, env);
          if (kind) return message('读取隐私文件', '会让凭据或隐私内容进入模型上下文', '使用不含凭据或隐私的文件', {kind});
        }
        for (const action of effects(argv)) {
          if (!derived && !reviewer && action.effect === 'delegate') continue;
          if (!derived && !reviewer && ['create','destroy','overwrite','write'].includes(action.effect)) continue;
          const why = actionReason(action, dir, root, {...env, ...parsed.env}, reviewer, onAdvisory, names); if (why) return why;
        }
      }
      for (const file of parsed.reads) {
        const kind = wordKind(file, dir, env);
        if (kind) return message('读取隐私文件', '会让凭据或隐私内容进入模型上下文', '使用不含凭据或隐私的文件', {kind});
      }
      if (derived || reviewer) for (const file of parsed.writes) {
        const why = targetReason(parsed.overwrites?.includes(file) ? 'overwrite' : 'write', file, dir, root, env, reviewer, onAdvisory); if (why) return why;
      }
      return null;
    }, word => expand(word, env), onAdvisory);
  } catch { onAdvisory('redline_internal_error'); return null; }
}
const init = () => require('./shell-ast.cjs').init();
module.exports = {init, reason, expand, resolvePath, within, secretKind, message, commandLabel, effects, gitReadOnly, gitInvocation};

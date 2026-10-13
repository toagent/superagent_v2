'use strict';
// Default allow. Effects and ownership establish danger; uncertainty is advisory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
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
  if (protectedLocation && !(protectedLocation === '非本任务的 git 检出' && !['destroy','overwrite'].includes(effect)) && !(packageCache && protectedLocation === '家目录下的配置或凭据'))
    return message('写入文件', `会修改${protectedLocation}`, '改用 worktree 或临时目录中的文件', {kind: within(abs, path.join(homeOf(env), '.superagent')) ? '~/.superagent' : protectedLocation});
  if (reviewer && root && within(abs, resolvePath(root))) return message('修改被审仓库', 'reviewer 只读，修改会污染评审对象', '在临时目录创建文件并运行测试或脚本', {kind: `本任务仓库：${abs}`});
  if (effect === 'destroy' && [root, homeOf(env), env.SUPERAGENT_HOME, '/'].filter(Boolean).some(r => within(resolvePath(r), abs)))
    return message('删除目录', '它是或包含受保护目录', '只删除本任务的明确产物文件', {kind: '受保护目录'});
  if (!task && (effect === 'destroy' || effect === 'overwrite' && fs.existsSync(abs)))
    return message('销毁或覆盖文件', '会破坏不属于本任务的已有数据', '在 worktree 或临时目录创建副本', {kind: '任务范围外路径'});
  if (!task || protectedLocation === '非本任务的 git 检出') advisory('file_ownership');
  return null;
}
function actionReason({effect, target, argv}, dir, root, env, reviewer, advisory, names, deletions) {
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
    return require('./git-danger.cjs').reason(argv, dir, root, env, deletions);
  }
  return null;
}
const READ_TOOLS = {Read: ['file_path'], NotebookRead: ['notebook_path'], Grep: ['path'], Glob: ['path'], LS: ['path'], view_image: ['path']};
function reason({client, name, input = {}, cwd, root, shell, derived, env = process.env, onCommand, onAdvisory = () => {}, reviewer = false}) {
  try {
    const edit = microEdit.isEdit(client, name);
    let targets = [];
    let deletions = new Set();
    if (edit) {
      try {
        const edits = client === 'codex' ? microEdit.patchEdits(input) : [{file: input.file_path || input.notebook_path}];
        targets = edits.map(e => e.file);
        deletions = new Set(edits.filter(e => e.kind === 'Delete File').map(e => e.file));
      }
      catch { onAdvisory('patch_target_unknown'); return null; }
    }
    for (const file of [...(READ_TOOLS[name] ?? []).map(k => input[k]), ...targets].filter(v => typeof v === 'string' && v)) {
      const kind = pathKind(file, cwd, env);
      if (kind) return message('读写隐私文件', '会让凭据或隐私内容进入模型上下文', '使用不含凭据或隐私的文件', {kind});
    }
    if (edit && (derived || reviewer)) for (const target of targets) {
      const why = targetReason(deletions.has(target) ? 'destroy' : 'write', target || '', cwd, root, env, reviewer, onAdvisory); if (why) return why;
    }
    if (shell === undefined) return null;
    const gitDeletions = new Map();
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
          const why = actionReason(action, dir, root, {...env, ...parsed.env}, reviewer, onAdvisory, names, gitDeletions); if (why) return why;
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
module.exports = {init, reason, expand, resolvePath, within, secretKind, message, commandLabel, effects, taskOwnership, checkoutOf};

'use strict';
// 执行层红线（所有角色）：读凭据与隐私、发布与合并、改写共享分支、按名杀进程、连接非本机数据库；
// 派生会话另把编辑与 shell 写入限制在 worktree、临时目录与包管理缓存内。只做字面判定：
// 派生写目标含动态展开时拒绝；间接执行的残余风险见 docs/04。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {parse} = require('./shell.cjs');
const microEdit = require('./micro-edit.cjs');

// child is parent itself or below it.
const within = (child, parent) => { const r = path.relative(parent, child); return !r.startsWith('..') && !path.isAbsolute(r); };
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
const currentBranch = dir => {
  const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], {encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
  return r.status === 0 ? r.stdout.trim() : '';
};
function gitReason(argv, dir) {
  let i = 1;
  while (argv[i]?.startsWith('-')) {
    if (argv[i] === '-C' && argv[i + 1]) dir = path.resolve(dir, argv[i + 1]);
    i += GIT_VALUE_OPTIONS.includes(argv[i]) ? 2 : 1;
  }
  const [sub, ...rest] = argv.slice(i);
  const flags = rest.filter(a => a.startsWith('-')), operands = rest.filter(a => !a.startsWith('-'));
  const shared = operands.find(a => PROTECTED.test(a));
  const msg = what => `禁止对共享分支 ${what} 执行 git ${sub}：改写共享分支一律人工执行`;
  if (sub === 'branch' && shared && flags.some(f => /^-[a-zA-Z]*[fDdMm]|^--(?:force|delete|move)$/.test(f))) return msg(shared);
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

const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){3}|::1|\[::1\]|0\.0\.0\.0|\/.*)?$/i;
const DB_CLIENTS = ['mysql', 'psql', 'mongosh', 'redis-cli'];
function dbHosts(args) {
  const hosts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--host') hosts.push(args[++i] ?? '');
    else if (/^-h./.test(a)) hosts.push(a.slice(2));
    else if (a.startsWith('--host=')) hosts.push(a.slice(7));
    const uri = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?,]*)/i.exec(a);
    if (uri) hosts.push(uri[1]);
    for (const m of a.matchAll(/(?:^|\s)host=(\S+)/g)) hosts.push(m[1]);
  }
  return hosts;
}
function commandReason(argv, allNames, dir) {
  const name = path.posix.basename(argv[0]), args = argv.slice(1), operands = args.filter(a => !a.startsWith('-'));
  if (name === 'git') return gitReason(argv, dir);
  if (name === 'security' && /^(?:find-.*-password|dump-keychain|export)$/.test(operands[0] ?? '')) return `禁止 security ${operands[0]}：钥匙串内容不交给任何模型`;
  const publish = ['npm', 'pnpm', 'bun', 'yarn'].includes(name) && operands.slice(0, 2).includes('publish')
    || name === 'docker' && (operands[0] === 'push' || args.includes('--push'))
    || name === 'gh' && ['release create', 'pr merge'].includes(operands.slice(0, 2).join(' '))
    || name === 'vercel' && args.some(a => a === '--prod' || a === '--production');
  if (publish) return `禁止 ${name} ${operands.slice(0, 2).join(' ')}：发布与合并一律人工执行`;
  if (['pkill', 'killall'].includes(name)) return `禁止 ${name}：只能停止本会话记录的 PID（kill $!、kill %1）`;
  if (name === 'kill' && allNames.some(n => ['lsof', 'pgrep', 'pidof'].includes(n))) return '禁止按端口或名字查 PID 再 kill：只能停止本会话记录的 PID（kill $!、kill %1）';
  if (DB_CLIENTS.includes(name)) {
    const remote = dbHosts(args).find(h => !LOCAL_HOST.test(h));
    if (remote !== undefined) return `禁止 ${name} 连接非本机 host ${remote}`;
  }
  return null;
}

// 输出与参数中的落点：重定向、tee、包装器副作用之外，常见文件命令的目标操作数。
const LAST_TARGET = ['cp', 'mv', 'ln', 'install', 'rsync'], ALL_TARGETS = ['touch', 'mkdir', 'rm', 'rmdir', 'truncate'];
function shellWrites(parsed) {
  const out = [...parsed.writes];
  for (const argv of parsed.argvs) {
    const name = path.posix.basename(argv[0]), operands = argv.slice(1).filter(a => !a.startsWith('-'));
    if (LAST_TARGET.includes(name) && operands.length > 1) out.push(operands.at(-1));
    if (ALL_TARGETS.includes(name)) out.push(...operands);
    if (name === 'dd') out.push(...argv.filter(a => a.startsWith('of=')).map(a => a.slice(3)));
  }
  return out;
}
function writableRoots(cwd, root, env) {
  const home = homeOf(env);
  return [root || cwd, '/tmp', '/private/tmp', env.TMPDIR, '/var/folders', '/private/var/folders',
    ...['.bun', '.npm', '.cache', 'Library/Caches', '.m2', '.gradle', '.cargo'].map(d => path.join(home, d))]
    .filter(Boolean).map(r => resolvePath(path.resolve(r)));
}
function outsideReason(targets, dir, roots, env) {
  for (const t of targets) {
    const abs = resolvePath(path.resolve(dir, expand(t, env)));
    if (!roots.some(r => within(abs, r))) return `派生会话只能写 worktree、临时目录与包管理缓存，${path.basename(abs) || abs} 在范围外`;
  }
  return null;
}

// heredoc 正文是数据（交给 bash/sh 等执行的除外），不当作命令解析。
function stripHeredocs(text) {
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(lines[i].replace(/<<</g, ''));
    if (!m || /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh)\b[^<]*<</.test(lines[i])) continue;
    while (i + 1 < lines.length && (m[1] ? lines[i + 1].replace(/^\t+/, '') : lines[i + 1]) !== m[3]) i++;
    if (i + 1 < lines.length) out.push(lines[++i]);
  }
  return out.join('\n');
}

const READ_TOOLS = {Read: ['file_path'], NotebookRead: ['notebook_path'], Grep: ['path'], Glob: ['path'], LS: ['path'], view_image: ['path']};
/**
 * 红线拒绝理由或 null。shell 为解析后的 shell 文本（非 shell 工具为 undefined）；
 * derived 为真时另查写入落点。root 为 cwd 所在 git 根。
 */
function reason({client, name, input, cwd, root, shell, derived, env = process.env}) {
  const edit = microEdit.isEdit(client, name);
  let targets = [];
  if (edit) {
    try { targets = client === 'codex' ? microEdit.patchEdits(input).map(e => e.file) : [input.file_path || input.notebook_path]; }
    catch (error) { return derived ? `无法确认补丁写入目标（${error.message}）` : null; }
  }
  const reads = [...(READ_TOOLS[name] ?? []).map(k => input[k]), ...targets].filter(v => typeof v === 'string' && v);
  for (const file of reads) {
    const kind = pathKind(file, cwd, env);
    if (kind) return `禁止读写${kind}（${path.basename(file)}）`;
  }
  if (edit && derived) {
    const out = outsideReason(targets, cwd, writableRoots(cwd, root, env), env);
    if (out) return out;
  }
  if (shell === undefined) return null;
  const roots = writableRoots(cwd, root, env);
  let allNames = [];
  try { allNames = parse(stripHeredocs(shell)).argvs.map(a => path.posix.basename(a[0])); }
  catch {
    const kind = shell.split(/[\s;&|()`"'<>]+/).map(w => wordKind(w, cwd, env)).find(Boolean);
    if (kind) return `禁止读取${kind}`;
    if (derived) return '无法确认 shell 写入目标（解析失败）';
  }
  // Preserve shell order and isolate subshell cwd. Conditional cd leaves both possible
  // directories unless its success is required by &&; every possible write must be safe.
  function walk(text, dirs, depth = 0) {
    if (depth > 8) return '无法确认 shell 写入目标（嵌套过深）';
    let part = '', quote = '', nesting = 0;
    const pieces = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { part += text.slice(i, i + 2); i++; continue; }
      if (quote) { part += c; if (c === quote) quote = ''; continue; }
      if (c === "'" || c === '"') { quote = c; part += c; continue; }
      if (c === '(') nesting++;
      if (c === ')') nesting--;
      if (!nesting && /[;&|\n]/.test(c) && !(text[i - 1] === '>' && /[&|]/.test(c))) {
        const op = text[i + 1] === c && /[&|]/.test(c) ? c + text[++i] : c;
        pieces.push([part, op]); part = '';
      } else part += c;
    }
    pieces.push([part, '']);
    if (quote || nesting) return derived ? '无法确认 shell 写入目标（语法不完整）' : null;
    for (let j = 0; j < pieces.length; j++) {
      const [line, op] = pieces[j], trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const why = walk(trimmed.slice(1, -1), [...dirs], depth + 1); if (why) return why; continue;
      }
      let parsed;
      try { parsed = parse(trimmed); }
      catch { return derived ? '无法确认 shell 写入目标（解析失败）' : null; }
      const writes = shellWrites(parsed);
      if (derived && writes.length && parsed.argvs.length > 1 && parsed.argvs.some(a => a[0] === 'cd')) return '无法确认嵌套 shell 的写入目录';
      if (derived && writes.some(t => !t || /[$`*?\[\]{}]/.test(expand(t, env)) || t.includes('__sa_sub__'))) return '无法确认 shell 写入目标（动态路径）';
      for (const dir of dirs) {
        for (const argv of parsed.argvs) {
          for (const word of argv.slice(argv[0].includes('/') ? 0 : 1)) {
            const kind = wordKind(word, dir, env); if (kind) return `禁止读取${kind}（命令 ${path.posix.basename(argv[0])}）`;
          }
          const why = commandReason(argv, allNames, dir); if (why) return why;
          const flag = argv.findIndex((v, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(v));
          if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(path.posix.basename(argv[0])) && flag > 0) {
            const why = walk(argv[flag + 1] || '', [dir], depth + 1); if (why) return why;
          }
        }
        for (const file of parsed.reads) { const kind = wordKind(file, dir, env); if (kind) return `禁止读取${kind}（输入重定向）`; }
        if (derived) { const why = outsideReason(writes, dir, roots, env); if (why) return why; }
      }
      const cd = parsed.argvs.find(argv => argv[0] === 'cd');
      if (cd) {
        const target = cd[1] || homeOf(env);
        if (/[$`*?\[\]{}]/.test(expand(target, env)) || cd.length > 2) return derived ? '无法确认 cd 后的写入目录' : null;
        const next = dirs.map(dir => path.resolve(dir, expand(target, env)));
        dirs = op === '&&' && !['||', '|', '|&', '&'].includes(pieces[j - 1]?.[1]) ? next : [...new Set([...dirs, ...next])];
      }
    }
    return null;
  }
  return walk(stripHeredocs(shell), [cwd]);
}

module.exports = {reason, resolvePath, within, secretKind, stripHeredocs};

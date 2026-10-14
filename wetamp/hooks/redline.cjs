'use strict';
// Default allow. Only privacy and irreversible destruction establish a denial.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const microEdit = require('./micro-edit.cjs');

// child is parent itself or below it.
const within = (child, parent) => {
  const r = path.relative(parent, child);
  return r !== '..' && !r.startsWith('../') && !path.isAbsolute(r);
};
function resolvePath(file) {
  let cursor = file;
  const tail = [];
  while (!fs.existsSync(cursor)) {
    tail.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) return file;
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...tail);
}
const homeOf = env => env.HOME || os.homedir();
const saHome = env => env.SUPERAGENT_HOME || path.join(homeOf(env), '.superagent');
const expand = (word, env) =>
  word.replace(/^~(?=\/|$)/, homeOf(env)).replace(/\$\{HOME\}|\$HOME\b/g, homeOf(env));

const SSH_PUBLIC = ['known_hosts', 'known_hosts.old', 'config'];
const SECRET_FILES = [
  ['.aws', 'credentials'],
  ['.netrc'],
  ['.config', 'gh', 'hosts.yml'],
  ['.npmrc'],
  ['.pypirc'],
];
const BROWSER = [
  ['Library', 'Application Support', 'Google', 'Chrome'],
  ['Library', 'Application Support', 'Chromium'],
  ['Library', 'Application Support', 'Arc'],
  ['Library', 'Application Support', 'Microsoft Edge'],
  ['Library', 'Application Support', 'Firefox'],
  ['Library', 'Safari'],
  ['Library', 'Containers', 'com.apple.Safari'],
  ['Library', 'Cookies'],
];
// 绝对路径命中的红线类别，未命中为 null。APFS 默认大小写不敏感，按小写比较。
function secretKind(abs, env) {
  const p = path.normalize(abs).toLowerCase(),
    home = path.normalize(homeOf(env)).toLowerCase();
  const under = segs => {
    const root = path.join(home, ...segs).toLowerCase();
    return p === root || p.startsWith(root + '/');
  };
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
  const parts = [
    word,
    word.slice(word.indexOf('=') + 1),
    ...(word.match(/(?:~|\$\{?HOME\}?|\/)[^\s'"`;|&<>()=,]*/g) ?? []),
  ];
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
  if (target?.url) {
    try {
      label = new URL(target.url).hostname;
    } catch {
      label = '外部服务';
    }
  }
  return `已拦截：${action}${label ? `（${label}）` : ''}。原因：${consequence}。可以：${alternative}。`;
};
function checkoutOf(file) {
  let dir = file;
  while (path.dirname(dir) !== dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return resolvePath(dir);
    dir = path.dirname(dir);
  }
  return null;
}
// Privacy applies to every tool's arguments, including bare MCP names.
function strings(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
function deletionReason(argv, dir, root, env) {
  if (path.basename(argv[0] || '') !== 'rm') return null;
  let recursive = false,
    force = false,
    positional = false;
  const targets = [];
  for (const arg of argv.slice(1)) {
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith('-')) {
      recursive ||=
        (arg.startsWith('--') && arg.length > 2 && 'recursive'.startsWith(arg.slice(2))) ||
        /^-[^-]*[rR]/.test(arg);
      force ||=
        (arg.startsWith('--') && arg.length > 2 && 'force'.startsWith(arg.slice(2))) ||
        /^-[^-]*f/.test(arg);
    } else targets.push(arg);
  }
  if (!recursive || !force) return null;
  const roots = [
    '/',
    homeOf(env),
    saHome(env),
    path.join(saHome(env), 'gen'),
    root,
    checkoutOf(dir),
  ]
    .filter(Boolean)
    .map(resolvePath);
  for (const target of targets) {
    const expanded = expand(target, env).replace(
      /\$\{SUPERAGENT_HOME\}|\$SUPERAGENT_HOME\b/g,
      value => env.SUPERAGENT_HOME || value
    );
    // Unknown targets do not establish a protected directory.
    if (/[$`*?\[\]{}]|__sa_/.test(expanded)) continue;
    const lexical = path.resolve(dir, expanded),
      resolved = resolvePath(lexical);
    if (roots.some(root => within(root, lexical) || within(root, resolved)))
      return message(
        '删除目录',
        '它是或包含家目录、引擎根、gen、仓库根或 /',
        '只删除明确的产物文件',
        { kind: '受保护目录' }
      );
  }
  return null;
}
function reason({
  client,
  name,
  input = {},
  cwd,
  root,
  shell,
  env = process.env,
  onAdvisory = () => {},
  onCategory = () => {},
}) {
  const privacy = (values, dir, context) => {
    for (const value of values) {
      const kind = wordKind(value, dir, context);
      if (kind) {
        onCategory('privacy');
        return message(
          '读写隐私文件',
          '会让凭据或隐私内容进入模型上下文',
          '使用不含凭据或隐私的文件',
          { kind }
        );
      }
    }
    return null;
  };
  try {
    // Shell strings are interpreted by the parser; quoted prose is not executed.
    if (shell === undefined) {
      const paths = microEdit.isEdit(client, name)
        ? client === 'codex'
          ? microEdit.patchEdits(input).map(edit => edit.file)
          : [input.file_path || input.notebook_path]
        : ['Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'view_image'].includes(name)
          ? [input.file_path || input.notebook_path || input.path]
          : null;
      if (paths)
        for (const file of paths.filter(value => typeof value === 'string' && value)) {
          const kind = pathKind(file, cwd, env);
          if (kind) {
            onCategory('privacy');
            return message(
              '读写隐私文件',
              '会让凭据或隐私内容进入模型上下文',
              '使用不含凭据或隐私的文件',
              { kind }
            );
          }
        }
      return paths ? null : privacy(strings(input), cwd, env);
    }
    return require('./shell-ast.cjs').analyze(
      shell,
      input.workdir || cwd,
      env,
      (parsed, dir) => {
        const context = { ...env, ...parsed.env };
        const secret = privacy(
          [...parsed.argvs.flat(), ...parsed.reads, ...parsed.writes],
          dir,
          context
        );
        if (secret) return secret;
        for (const argv of parsed.argvs) {
          const command = path.basename(argv[0] || '');
          if (
            command === 'security' &&
            argv.slice(1).some(arg => /^(find-.*-password|dump-keychain|export)$/.test(arg))
          ) {
            onCategory('privacy');
            return message('通过 security 读取钥匙串', '凭据内容不能交给模型');
          }
          if (command === 'git') {
            const why = require('./git-danger.cjs').reason(
              argv,
              dir,
              root,
              context,
              undefined,
              onCategory
            );
            if (why) return why;
          }
          const deletion = deletionReason(argv, dir, root, context);
          if (deletion) {
            onCategory('destruction');
            return deletion;
          }
        }
        return null;
      },
      word => expand(word, env),
      onAdvisory
    );
  } catch {
    onAdvisory('redline_internal_error');
    return null;
  }
}
const init = () => require('./shell-ast.cjs').init();
module.exports = {
  init,
  reason,
  expand,
  resolvePath,
  within,
  secretKind,
  message,
  checkoutOf,
  saHome,
};

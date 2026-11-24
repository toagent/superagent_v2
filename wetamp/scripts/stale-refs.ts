import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CLI_COMMAND_USAGE, CLI_GLOBAL_OPTIONS } from '../src/cli';
import { EXPORT_USAGE } from '../src/export';
import { isJobRole } from '../src/jobs';

const home = homedir();
const expand = (path: string): string => resolve(path.replace(/^(?:~|\$HOME)(?=\/|$)/, home));
const forbidden =
  /\/(?:Library\/(?:Mobile Documents|CloudStorage\/iCloud[^/]*|Keychains)|_private|\.ssh|\.aws|\.git)(?:\/|$)/i;
const safe = (path: string | undefined): path is string => !!path && !forbidden.test(path);
const canonical = (path: string): string | undefined =>
  safe(path) ? realpathSync(path) : undefined;
const entries = [...CLI_COMMAND_USAGE].sort((a, b) => b.command.length - a.command.length);
const categories = [
  'command',
  'flag',
  'missing-path',
  'artifact-path',
  'missing-index-target',
  'unindexed',
] as const;
type Category = (typeof categories)[number];
interface Finding {
  category: Category;
  file: string;
  line: number;
  snippet: string;
}
type Report = (category: Category, snippet: string) => void;

function checkCommand(snippet: string, report: Report): void {
  const words = (
    snippet.split(/\s+(?:&&|\|\||\|)\s+|;/, 1)[0].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  ).slice(1);
  const entry = entries.find(({ command }) =>
    command.split(' ').every((word, i) => words[i] === word)
  );
  const [verb, action] = words;
  if (!entry && /^[a-z][\w-]*$/.test(verb ?? '')) {
    const group = entries.some(e => e.command.startsWith(verb + ' '));
    report('command', ['superagent', verb, ...(group && action ? [action] : [])].join(' '));
    return;
  }
  const args = entry ? words.slice(entry.command.split(' ').length) : words;
  // Leading literal alternatives describe actions. Argument placeholders do not.
  const usage = (entry?.positionals ?? '').replace(/\s+<[^>]+>|\s+\[[^\]]+\]|\s+--[\w-]+/g, '');
  const actions = /^(?:<|\[)?([a-z][\w-]*(?:\s*\|\s*[a-z][\w-]*)+)/.exec(usage)?.[1];
  if (
    actions &&
    /^[a-z][\w-]*$/.test(args[0] ?? '') &&
    !actions.split('|').some(action => action.trim() === args[0])
  ) {
    report('command', 'superagent ' + entry?.command + ' ' + args[0]);
  }
  const exportFlags =
    entry?.command === 'export' ? [...EXPORT_USAGE.matchAll(/--([\w-]+)/g)].map(m => m[1]) : [];
  const allowed = new Set<string>([
    ...CLI_GLOBAL_OPTIONS,
    ...(entry?.flags ?? []),
    ...(entry?.operatorFlags ?? []),
    ...exportFlags,
  ]);
  if (!entry && words.includes('--help')) allowed.add('all');
  for (const [i, word] of args.entries()) {
    if (word === '--') break;
    const flag = /^\[?--([a-z][\w-]*)(?:=(.*))?\]?$/.exec(word);
    if (!flag) continue;
    if (!allowed.has(flag[1])) report('flag', '--' + flag[1]);
    if (entry?.command !== 'job exec' || flag[1] !== 'role') continue;
    const role = flag[2] ?? args[i + 1];
    if (/^[a-z][\w-]*$/.test(role ?? '') && !isJobRole(role)) report('flag', '--role ' + role);
  }
}

function checkPaths(line: string, report: Report): void {
  const start = /(?<![\w/:$])(?:~\/|\/Users\/|\$HOME\/|\/(?:private\/)?tmp\/)/g;
  for (const match of line.matchAll(start)) {
    const rest = line.slice(match.index);
    const delimiter = line[match.index - 1];
    if (/^(?:~|\$HOME|\/Users\/[^/]+)\/Library\/Mobile Documents(?:\/|\b)/i.test(rest)) continue;
    const quoted = /['"\x60]/.test(delimiter ?? '') ? rest.split(delimiter, 1)[0] : '';
    const bare = /^[^\s'"\x60()[\],;|，。；：、]+/.exec(rest)?.[0] ?? '';
    const raw =
      quoted && (delimiter !== '\x60' || /\s[\w.-]+(?: [\w.-]+)*\//.test(quoted)) ? quoted : bare;
    const path = raw.replace(/:\d+(?::\d+)?$|[.,:，。；：、]+$/g, '');
    if (!path || /[<>*{}]|\$(?!HOME\/)/.test(path)) continue;
    const full = expand(path);
    if (!safe(full)) continue;
    if (
      /^\/(?:private\/)?tmp\//.test(full) ||
      full.startsWith(join(home, '.superagent/scratch') + '/')
    )
      report('artifact-path', path);
    else if (!existsSync(full)) report('missing-path', path);
  }
}

function defaultRoots(): string[] {
  const root = expand('~/.claude/projects');
  const projects = existsSync(root) ? canonical(root) : undefined;
  const memories = safe(projects)
    ? readdirSync(projects, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(projects, entry.name, 'memory'))
    : [];
  return [
    '~/.ai-agent-shared/memory',
    '~/.ai-agent-shared/skills',
    '~/.ai-agent-shared/TRI_CLIENT_CONSISTENCY.md',
    join(import.meta.dir, '../docs/agent.md'),
    ...memories,
  ];
}

function scan(roots: string[]): Finding[] {
  const findings: Finding[] = [],
    seen = new Set<string>();
  function visit(path: string): void {
    try {
      const file = canonical(path);
      if (!safe(file) || seen.has(file)) return;
      seen.add(file);
      const info = statSync(file);
      if (info.isDirectory()) {
        for (const child of readdirSync(file, { withFileTypes: true })) {
          if (child.isDirectory() || child.isFile()) visit(join(file, child.name));
        }
        return;
      }
      if (!info.isFile() || !/\.(md|mdx|txt|rst)$/i.test(file)) return;
      const indexed = basename(file) === 'MEMORY.md' ? new Set<string>() : undefined;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const report: Report = (category, snippet) =>
          findings.push({ category, file, line: i + 1, snippet });
        for (const m of line.matchAll(/\x60(superagent\s+[^\x60]+)\x60/g))
          checkCommand(m[1], report);
        const command = /^\s*(?:\$\s+)?(?:rtk\s+)?(superagent\s.+)/.exec(line)?.[1];
        if (command) {
          let snippet = command;
          for (let j = i + 1; snippet.endsWith('\\') && j < lines.length; j++)
            snippet = snippet.slice(0, -1) + ' ' + lines[j].trim();
          checkCommand(snippet, report);
        }
        checkPaths(line, report);
        if (!indexed) return;
        for (const m of line.matchAll(/\[[^\]]*\]\((?:<([^>]+\.md)>|([^)\s]+\.md))\)/g)) {
          const target = m[1] ?? m[2];
          if (isAbsolute(target) || /^[\w-]+:/.test(target)) continue;
          const full = resolve(dirname(file), target);
          if (!safe(full)) continue;
          indexed.add(full);
          if (!existsSync(full)) report('missing-index-target', m[0]);
        }
      });
      if (!indexed) return;
      for (const child of readdirSync(dirname(file), { withFileTypes: true })) {
        const sibling = join(dirname(file), child.name);
        if (
          child.isFile() &&
          child.name.endsWith('.md') &&
          sibling !== file &&
          !indexed.has(sibling)
        )
          findings.push({ category: 'unindexed', file: sibling, line: 1, snippet: child.name });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('无法扫描', path);
    }
  }
  roots.forEach(visit);
  return findings;
}

function main(args: string[]): void {
  const i = args.indexOf('--json'),
    out = i < 0 ? undefined : args.splice(i, 2)[1];
  if (i >= 0 && !out) console.error('--json 需要输出路径');
  const roots = (args.length ? args : defaultRoots()).map(expand);
  const findings = scan(roots);
  const counts = Object.fromEntries(
    categories.map(category => [category, findings.filter(f => f.category === category).length])
  );
  if (out) {
    try {
      const path = expand(out),
        parent = canonical(dirname(path));
      if (!safe(path) || !safe(parent)) throw new Error();
      const target = join(parent, basename(path));
      for (const root of roots.filter(root => safe(root) && existsSync(root))) {
        const source = canonical(root);
        if (!safe(source)) continue;
        const rel = relative(basename(source) === 'MEMORY.md' ? dirname(source) : source, target);
        if (!rel || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel))) throw new Error();
      }
      writeFileSync(target, JSON.stringify({ counts, findings }, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      console.error('无法写入 JSON，请指定扫描范围外的新文件');
    }
  }
  for (const category of categories) {
    console.log('[' + category + ']');
    for (const { file, line, snippet } of findings.filter(f => f.category === category))
      console.log(file + ':' + line, snippet);
  }
  console.log(
    Object.entries(counts)
      .map(([category, count]) => category + '=' + count)
      .join(' ')
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch {
    console.error('无法完成引用扫描');
  }
}

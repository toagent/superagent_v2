'use strict';
const OPERATOR = /^(?:&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|&&|\|\||\|&|;;|[;&|<>\n])/;
// Tokenize shell text without evaluating it. Unknown syntax is reported, never executed.
function tokens(command) {
  // SAH1-04: edge whitespace is not a second command; preserve raw offsets.
  command = command.trimEnd();
  const result = []; let i = command.search(/\S/), depth = 0, backtick = false;
  if (i < 0) return result;
  while (i < command.length) {
    if (/[^\S\n]/.test(command[i])) { i++; continue; }
    const start = i, nested = depth > 0 || backtick; let value = '', quote = '', dynamic = false, operator = false;
    if (/[;&|<>\n]/.test(command[i])) {
      operator = true;
      value = command.slice(i).match(OPERATOR)[0]; i += value.length;
    } else while (i < command.length) {
      const char = command[i];
      if (quote) {
        if (char === quote) { quote = ''; i++; }
        else if (char === '\\' && quote === '"') { i++; value += command[i++] || ''; }
        else { if (quote === '"' && /[$`]/.test(char)) dynamic = true; value += char; i++; }
      } else if (char === '"' || char === "'") { quote = char; i++; }
      else if (char === '\\') { i++; value += command[i++] || ''; }
      else if (/\s|[;&|<>]/.test(char)) break;
      else {
        if (/[$`]/.test(char)) dynamic = true;
        if (char === '(') depth++;
        else if (char === ')') depth = Math.max(0,depth-1);
        else if (char === '`') backtick = !backtick;
        value += char; i++;
      }
    }
    if (quote) throw new Error('Unclosed shell quote');
    result.push({value, start, stop: i, dynamic, operator, nested});
  }
  return result;
}
const path = require('node:path');
const SEPARATORS = new Set(['|','||','|&','&&',';',';;','&','\n']);
const WRITES = new Set(['>','>>','>|','<>','&>','&>>','>&']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Reserved words that may precede a command head (`if claude`, `{ claude; }`, `! claude`).
const RESERVED = new Set(['!','{','}','if','then','else','elif','fi','do','done','while','until','coproc']);
// Prefixes that run their operands as the real command. `arg`: short options taking a value
// (attached or next word); `optional`: short options whose value can only be attached;
// `long`: long options taking a value; `split`: options whose value is itself a command line;
// `positional`: operands before the command; `skip`: a subcommand word to drop;
// `lookup`: options that only look the command up instead of running it.
const WRAPPERS = {
  env: {arg: 'uCSP', long: ['--unset','--chdir','--split-string'], split: ['S','--split-string']},
  sudo: {arg: 'ughCDpUrtT', long: ['--user','--group','--host','--close-from','--chdir','--prompt','--role','--type','--command-timeout','--other-user']},
  doas: {arg: 'uC'},
  nice: {arg: 'n', long: ['--adjustment']},
  nohup: {}, builtin: {}, command: {lookup: 'vV'}, exec: {arg: 'a'}, caffeinate: {arg: 'tw'},
  time: {arg: 'fo', long: ['--format','--output']},
  xargs: {arg: 'IJLnPsEda', optional: 'iel', long: ['--max-args','--max-procs','--max-chars','--eof','--delimiter','--arg-file','--replace','--max-lines']},
  timeout: {arg: 'ks', long: ['--kill-after','--signal'], positional: 1},
  gtimeout: {arg: 'ks', long: ['--kill-after','--signal'], positional: 1},
  stdbuf: {arg: 'ioe', long: ['--input','--output','--error']},
  watch: {arg: 'n', long: ['--interval']},
  rtk: {skip: 'proxy'},
};
const SHELLS = new Set(['bash','sh','zsh','dash','ksh']);
// Skip a quoted or escaped span starting at i; returns the index after it, or -1 when none.
function skipQuoted(text, i) {
  if (text[i] === '\\') return i + 2;
  if (text[i] === "'") { const end = text.indexOf("'", i + 1); if (end < 0) throw new Error('Unclosed shell quote'); return end + 1; }
  if (text[i] === '"') {
    for (let j = i + 1; j < text.length; j++) { if (text[j] === '\\') j++; else if (text[j] === '"') return j + 1; }
    throw new Error('Unclosed shell quote');
  }
  return -1;
}
function closing(text, i, close) {
  for (let depth = 1; i < text.length; i++) {
    const skip = close === '`' ? (text[i] === '\\' ? i + 2 : -1) : skipQuoted(text, i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (text[i] === close && --depth === 0) return i;
    if (close === ')' && text[i] === '(') depth++;
  }
  throw new Error(`Unclosed ${close}`);
}
// Replace every `$(…)`, `<(…)`, `(…)` and backtick body outside single quotes with one inert
// word and return the bodies, each to be parsed as a command line of its own.
function lift(text) {
  const bodies = []; let flat = '', dq = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '\\') { flat += text.slice(i, i + 2); i += 2; }
    else if (c === "'" && !dq) { const end = skipQuoted(text, i); flat += text.slice(i, end); i = end; }
    else if (c === '"') { dq = !dq; flat += c; i++; }
    else if (c === '`' || c === '(' && (!dq || text[i-1] === '$')) {
      const end = closing(text, i + 1, c === '`' ? '`' : ')');
      bodies.push(text.slice(i + 1, end)); flat += '__sa_sub__'; i = end + 1;
    } else { flat += c; i++; }
  }
  if (dq) throw new Error('Unclosed shell quote');
  return {flat, bodies};
}
// Strip wrappers (with their own options and operands), assignments and reserved words;
// returns the real argv plus option values that are themselves command lines (`env -S`).
function unwrap(argv) {
  const lines = []; let i = 0;
  for (;;) {
    while (i < argv.length && (RESERVED.has(argv[i]) || ASSIGN.test(argv[i]))) i++;
    const spec = WRAPPERS[path.posix.basename(argv[i] ?? '')];
    if (!spec) break;
    const head = i++;
    while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') {
      const word = argv[i++];
      if (word === '--') break;
      if (/^-\d+$/.test(word)) continue;
      if (word.startsWith('--')) {
        const [name, value] = word.split(/=(.*)/s);
        const taken = value ?? (spec.long?.includes(name) ? argv[i++] : undefined);
        if (spec.split?.includes(name) && taken !== undefined) lines.push(taken);
        continue;
      }
      for (let j = 1; j < word.length; j++) {
        if (spec.lookup?.includes(word[j])) return {argv: argv.slice(head), lines};
        if (spec.optional?.includes(word[j])) break;
        if (!spec.arg?.includes(word[j])) continue;
        const value = j + 1 < word.length ? word.slice(j + 1) : argv[i++];
        if (spec.split?.includes(word[j]) && value !== undefined) lines.push(value);
        break;
      }
    }
    i += spec.positional ?? 0;
    if (spec.skip && argv[i] === spec.skip) i++;
  }
  return {argv: argv.slice(i), lines};
}
// Every simple command a shell line would start: argv with wrappers, assignments and
// redirections stripped, including `bash -c`/`eval`/`find -exec` bodies and every command
// substitution; `writes` lists output-redirection targets. Throws on unparsable text.
function parse(command, depth = 0) {
  if (depth > 4) throw new Error('shell nesting too deep');
  const result = {argvs: [], writes: []};
  const add = text => { const inner = parse(text, depth + 1); result.argvs.push(...inner.argvs); result.writes.push(...inner.writes); };
  const {flat, bodies} = lift(command);
  bodies.forEach(add);
  let segment = [];
  const run = words => {
    const {argv, lines} = unwrap(words);
    lines.forEach(add);
    if (!argv.length) return;
    result.argvs.push(argv);
    const name = path.posix.basename(argv[0]);
    const flag = argv.findIndex((value, j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(value));
    if (SHELLS.has(name) && flag > 0 && argv[flag+1] !== undefined) add(argv[flag+1]);
    if (name === 'eval' && argv.length > 1) add(argv.slice(1).join(' '));
    if (name === 'find') argv.forEach((value, j) => {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(value)) return;
      const end = argv.findIndex((word, k) => k > j && (word === ';' || word === '+'));
      run(argv.slice(j + 1, end < 0 ? undefined : end));
    });
  };
  const flush = () => {
    const words = [];
    for (let i = 0; i < segment.length; i++) {
      const word = segment[i], next = segment[i+1];
      // `2>file`: the fd number belongs to the redirection, not the argv.
      if (!word.operator && /^\d+$/.test(word.value) && next?.operator && next.start === word.stop) continue;
      if (!word.operator) { words.push(word.value); continue; }
      const target = segment[++i]?.value ?? '';
      if (WRITES.has(word.value) && !/^\/dev\/(?:null|stdout|stderr)$/.test(target) && !(word.value === '>&' && /^(?:\d+|-)$/.test(target)))
        result.writes.push(target);
    }
    run(words);
    segment = [];
  };
  for (const word of tokens(flat)) {
    if (word.operator && SEPARATORS.has(word.value)) flush(); else segment.push(word);
  }
  flush();
  return result;
}
const commands = command => parse(command).argvs;
// Parse only a complete, literal deletion command. Operators, expansion,
// wrappers and multiple targets stay uncertain; never evaluate shell text.
function deletionTarget(command,cwd) {
  // An unparsable or non-string command is "not a literal deletion", never an error.
  if (typeof command !== 'string') return null;
  let words; try { words = tokens(command); } catch { return null; }
  if (!words.length || words.some(word => word.operator || word.dynamic || word.nested || /[()*?{}\[\]~]/.test(word.value))) return null;
  const args = words.map(word => word.value);
  let target;
  if (args[0] === 'rm') {
    let i = 1, recursive = false;
    while (args[i]?.startsWith('-') && args[i] !== '--') {
      if (!/^-[rf]+$/.test(args[i])) return null;
      recursive ||= args[i].includes('r'); i++;
    }
    if (args[i] === '--') i++;
    if (recursive && args.length === i+1) target = args[i];
  } else if (args[0] === 'git') {
    let i = 1, base = cwd;
    if (args[i] === '-C' && args[i+1]) { base = path.resolve(cwd,args[i+1]); i += 2; }
    if (args[i++] !== 'worktree' || args[i++] !== 'remove') return null;
    if (args[i] === '--force' || args[i] === '-f') i++;
    if (args[i] === '--') i++;
    if (args.length === i+1 && !args[i].startsWith('-')) return path.resolve(base,args[i]);
  }
  return target ? path.resolve(cwd,target) : null;
}
module.exports = {tokens, commands, parse, deletionTarget};

'use strict';
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
      value = command[i++]; if (command[i] === value) value += command[i++];
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
const SEPARATORS = new Set(['|','||','&&',';','&','\n']);
// Prefixes that run their argument as the real command (their own flags are skipped).
const WRAPPERS = new Set(['env','command','exec','nohup','time','sudo','nice','builtin','rtk']);
const SHELLS = new Set(['bash','sh','zsh','dash','ksh']);
// argv of every simple command a shell line would start (assignments, wrappers and
// redirections stripped), including `bash -c` bodies; a `$(…)`/backtick/subshell
// opener contributes its head word only. Throws on unparsable text (caller decides).
function commands(command, depth = 0) {
  const result = []; let segment = [];
  const flush = () => {
    const argv = [];
    for (let i = 0; i < segment.length; i++) {
      const word = segment[i];
      if (word.operator) { i++; continue; } // redirection and its target
      if (!argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) continue;
      if (!argv.length && WRAPPERS.has(path.posix.basename(word.value))) {
        while (segment[i+1] && !segment[i+1].operator && /^-|^proxy$|^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i+1].value)) i++;
        continue;
      }
      argv.push(word.value);
    }
    if (argv.length) {
      result.push(argv);
      const flag = argv.findIndex((value,j) => j > 0 && /^-[a-z]*c[a-z]*$/.test(value));
      if (SHELLS.has(path.posix.basename(argv[0])) && flag > 0 && argv[flag+1] !== undefined && depth < 4)
        result.push(...commands(argv[flag+1], depth+1));
    }
    for (const word of segment)
      for (const match of word.value.matchAll(/(?:^\(+|\$\(|`)([^\s()`$;&|]+)/g)) result.push([match[1]]);
    segment = [];
  };
  for (const word of tokens(command)) {
    if (word.operator && SEPARATORS.has(word.value)) flush(); else segment.push(word);
  }
  flush();
  return result;
}
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
// Only the repository's fixed availability entry point can consume task JSON.
// No passthrough flags, shell interpolation, alternate script or compound call.
module.exports = {tokens, commands, deletionTarget};

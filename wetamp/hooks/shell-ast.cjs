'use strict';
const path = require('node:path');
const {unwrap, SHELLS, parse} = require('./shell.cjs');
const STREAM = /^\/dev\/(?:null|stdout|stderr)$/;
// Parse syntax for effects, never as a command allowlist. Unknown syntax is advisory.
function createLoader({modulePath = 'web-tree-sitter', wasmPath, runtimeWasmPath} = {}) {
  let parser, pending, failure = 'initialization not completed';
  async function init() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const {Parser, Language} = require(modulePath);
        await Parser.init(runtimeWasmPath ? {locateFile: () => runtimeWasmPath} : undefined);
        const grammar = wasmPath || path.join(path.dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm');
        parser = new Parser(); parser.setLanguage(await Language.load(grammar)); failure = null;
      } catch (error) { parser = undefined; failure = String(error.message).slice(0, 180); }
      return failure;
    })();
    return pending;
  }
  function analyze(text, cwd, env, inspect, expand, advisory = () => {}) {
    const check = (parsed, dirs) => {
      for (const dir of dirs) { const why = inspect(parsed, dir); if (why) throw new Error(why); }
    };
    const fallback = source => {
      advisory('shell_parse_unavailable');
      try { check(parse(source), [cwd]); } catch (error) {
        if (error.message.startsWith('已拦截：')) throw error;
        advisory('shell_parse_failed');
      }
    };
    const union = (...dirs) => [...new Set(dirs.flat())];
    const fork = dirs => ({dirs: [...dirs], ok: [...dirs], fail: [...dirs]});
    const outcome = (state, ok, fail) => { state.ok = ok; state.fail = fail; state.dirs = union(ok, fail); };
    function execute(values, state, depth) {
      const incoming = [...state.dirs], unwrapped = unwrap(values);
      const wrappers = unwrapped.heads.filter(i => i < values.length - unwrapped.argv.length);
      for (const head of wrappers.filter(i => path.posix.basename(values[i]) === 'env')) {
        const end = unwrapped.heads.find(i => i > head) ?? values.length;
        const options = values.slice(head + 1, end);
        const change = options.findIndex(v => v === '-C' || /^-C.+|^--chdir(?:=|$)/.test(v));
        if (change < 0) continue;
        const option = options[change];
        const target = option.includes('=') ? option.slice(option.indexOf('=') + 1) : option.startsWith('-C') && option.length > 2 ? option.slice(2) : options[change + 1];
        state = fork(target && !/[$`]/.test(target) ? state.dirs.map(dir => path.resolve(dir, expand(target))) : ['/__sa_unknown_cwd__']);
        if (state.dirs.includes('/__sa_unknown_cwd__')) advisory('cwd_unknown');
        unwrapped.writes = unwrapped.writes.filter(v => v !== target);
      }
      // Wrappers themselves may elevate privileges; inspect them before unwrapping.
      check({argvs: wrappers.map(i => values.slice(i)), reads: [], writes: []}, state.dirs);
      for (const line of unwrapped.lines) script(line, fork(state.dirs), depth + 1);
      const argv = unwrapped.argv, name = path.posix.basename(argv[0] || '');
      if (/[$`]/.test(name)) advisory('command_head_unknown');
      check({argvs: argv.length ? [argv] : [], reads: [], writes: unwrapped.writes.filter(t => !STREAM.test(t))}, state.dirs);
      if (SHELLS.has(name)) {
        const flag = argv.findIndex((v, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(v));
        if (flag > 0 && argv[flag + 1]) {
          if (/\$|`/.test(argv[flag + 1]) && !values.includes(argv[flag + 1])) advisory('dynamic_shell_body');
          script(argv[flag + 1], fork(state.dirs), depth + 1);
        }
      }
      if (name === 'eval' && argv.length > 1) script(argv.slice(1).join(' '), fork(state.dirs), depth + 1);
      if (name === 'find') argv.forEach((v, i) => {
        if (!['-exec','-execdir','-ok','-okdir'].includes(v)) return;
        const end = argv.findIndex((w, j) => j > i && (w === ';' || w === '+'));
        if (end < 0 || v.endsWith('dir')) { advisory('find_execution_scope'); return; }
        execute(argv.slice(i + 1, end), fork(state.dirs), depth + 1);
      });
      if (name === 'cd') {
        const target = expand(argv[1] || env.HOME || require('node:os').homedir());
        if (argv.length > 2 || target === '-' || /[$`*?\[\]{}]/.test(target) || env.CDPATH && !path.isAbsolute(target)) {
          advisory('cwd_unknown'); outcome(state, ['/__sa_unknown_cwd__'], incoming);
        } else outcome(state, incoming.map(dir => path.resolve(dir, target)), incoming);
      } else outcome(state, incoming, incoming);
    }
    function visit(n, state, depth) {
      if (n.isMissing || n.type === 'ERROR') advisory('shell_parse_failed');
      if (['function_definition','arithmetic_expansion','translated_string'].includes(n.type)) { advisory('shell_effect_unknown'); return n.text; }
      if (!n.isNamed) return null;
      if (n.type === 'raw_string') return n.text.slice(1, -1);
      if (['word','number','string_content'].includes(n.type)) return n.text.replace(/\\\n/g, '').replace(n.type === 'string_content' ? /\\([$`"\\])/g : /\\(.)/gs, '$1');
      if (['comment','heredoc_start','heredoc_end','heredoc_body','variable_name','special_variable_name','file_descriptor','test_operator'].includes(n.type)) return n.text;
      if (n.type === 'heredoc_redirect') {
        const delimiter = n.namedChildren.find(c => c.type === 'heredoc_start');
        const body = n.namedChildren.find(c => c.type === 'heredoc_body');
        if (n.parent?.text.match(/^(?:bash|sh|zsh|dash|ksh)\b/)) { script(body?.text || '', fork(state.dirs), depth + 1); return null; }
        if (!/[\\'"]/.test(delimiter?.text || '') && /[$`\\]/.test(body?.text || '')) advisory('heredoc_expansion');
        return null;
      }
      if (n.type === 'list') {
        const operands = n.namedChildren.filter(c => c.type !== 'comment');
        const op = n.children.find(c => c.type === '&&' || c.type === '||');
        if (operands.length === 2 && op) {
          const left = fork(state.dirs); visit(operands[0], left, depth);
          const right = fork(op.type === '&&' ? left.ok : left.fail); visit(operands[1], right, depth);
          outcome(state, op.type === '&&' ? right.ok : union(left.ok, right.ok), op.type === '&&' ? union(left.fail, right.fail) : right.fail);
          return null;
        }
      }
      if (['subshell','command_substitution','process_substitution'].includes(n.type)) state = fork(state.dirs);
      const children = new Map();
      const ordered = n.type === 'redirected_statement' ? [...n.children].sort((a,b) => (a.type === 'command' ? 1 : 0) - (b.type === 'command' ? 1 : 0)) : n.children;
      for (const ch of ordered) children.set(ch.id, visit(ch, state, depth));
      const get = ch => ch && children.get(ch.id);
      if (['command_name','concatenation','string'].includes(n.type)) return n.namedChildren.map(ch => get(ch) || '').join('');
      if (['simple_expansion','expansion','command_substitution','process_substitution'].includes(n.type)) return n.text;
      if (n.type === 'file_redirect') {
        const target = get(n.childForFieldName('destination')) || '';
        const op = n.children.find(c => !c.isNamed)?.type;
        const fd = ['>&','<&'].includes(op) && /^(?:\d+|-)$/.test(target);
        check({argvs: [], reads: op === '<' ? [target] : [], writes: op !== '<' && !fd && !STREAM.test(target) ? [target] : []}, state.dirs);
      }
      if (n.type === 'command') execute([get(n.childForFieldName('name')), ...n.childrenForFieldName('argument').map(get)].filter(v => v !== null && v !== undefined), state, depth);
      return null;
    }
    function script(source, state, depth) {
      if (depth > 8) { advisory('nested_shell_depth'); return; }
      const tree = parser.parse(source);
      try { if (tree.rootNode.hasError) advisory('shell_parse_failed'); visit(tree.rootNode, state, depth); }
      finally { tree.delete(); }
    }
    try {
      if (!parser) fallback(text); else script(text, fork([cwd]), 0);
      return null;
    } catch (error) {
      if (error.message.startsWith('已拦截：')) return error.message;
      advisory('shell_analysis_failed'); return null;
    }
  }
  return {init, analyze};
}
module.exports = {...createLoader(), createLoader};

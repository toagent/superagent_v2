'use strict';
const path = require('node:path');
const {unwrap, SHELLS} = require('./shell.cjs');
const SAFE = new Set(['cd','echo','printf','pwd','true','false','test','[',':','exit','break','continue','return']);
const NODES = new Set(['program','list','pipeline','command','command_name','word','string','string_content','raw_string','number','concatenation',
  'redirected_statement','file_redirect','file_descriptor','heredoc_redirect','heredoc_start','heredoc_body','heredoc_end',
  'for_statement','if_statement','elif_clause','else_clause','do_group','while_statement','variable_name','special_variable_name',
  'variable_assignment','simple_expansion','expansion','test_command','unary_expression','binary_expression','test_operator',
  'compound_statement','subshell','negated_command','comment']);
const TOKENS = new Set(['&&','||',';','|','|&','"',"'",'>','>>','>|','<>','&>','&>>','>&','<&','<','<<','<<-','&',
  'for','in','do','done','if','then','elif','else','fi','while','until','{','}','(',')','!','[',']','[[',']]','$','${','=','\\\n']);
const COMPOUND = new Set(['for_statement','if_statement','while_statement','compound_statement','negated_command','pipeline']);
const STREAM = /^\/dev\/(?:null|stdout|stderr)$/;
// Dependency resolution is lazy: commander hooks do not load the parser or its WASM.
function createLoader({modulePath = 'web-tree-sitter', wasmPath, runtimeWasmPath} = {}) {
  let parser, pending, failure = 'initialization not completed', heads;
  async function init() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const {Parser, Language} = require(modulePath);
        await Parser.init(runtimeWasmPath ? {locateFile: () => runtimeWasmPath} : undefined);
        const grammar = wasmPath || path.join(path.dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm');
        const language = await Language.load(grammar);
        parser = new Parser(); parser.setLanguage(language);
        heads = new Set(require('./shell-words.json').flatMap(s => s.words)); failure = null;
      } catch (error) { parser = undefined; failure = String(error.message).slice(0, 180); }
      return failure;
    })();
    return pending;
  }
  function analyze(text, cwd, env, inspect, expand) {
    if (!parser) return `shell parser unavailable: ${failure}`;
    const ctx = {names: [], cd: false, assignment: false};
    const reject = why => { throw new Error(`无法确认 shell 写入目标（超出可建模子集：${why}）`); };
    const check = (parsed, state) => {
      for (const dir of state.dirs) { const why = inspect(parsed, dir, ctx.names, ctx.assignment); if (why) throw new Error(why); }
    };
    const word = (value, dynamic = false) => ({value, dynamic});
    const union = (...dirs) => [...new Set(dirs.flat())];
    const outcome = (state, ok, fail) => { state.ok = ok; state.fail = fail; state.dirs = union(ok, fail); };
    const fork = dirs => ({dirs: [...dirs], ok: [...dirs], fail: [...dirs]});
    function execute(words, state, compound, depth) {
      const incoming = [...state.dirs];
      const values = words.map(w => w.value), unwrapped = unwrap(values);
      if (unwrapped.lines.length) reject('executable_wrapper_argument');
      for (const index of unwrapped.heads) {
        const w = words[index], name = path.posix.basename(w.value);
        if (w.dynamic || w.value.startsWith('=')) reject('nonliteral_command_head');
        if (heads.has(name) && !SAFE.has(name)) reject('builtin_or_reserved_head');
        ctx.names.push(name);
        const end = unwrapped.heads.find(i => i > index) ?? values.length;
        if (['env','sudo'].includes(name) && values.slice(index + 1, end).some(v => /^-[^-]*[CD]|^--chdir(?:=|$)/.test(v))) reject('wrapper_cwd');
      }
      // env assignments change the child's expansion/cwd environment; never model cd across them.
      ctx.assignment ||= values.some(v => /^[A-Za-z_][A-Za-z0-9_]*=/.test(v));
      const argv = unwrapped.argv, offset = values.length - argv.length;
      const name = path.posix.basename(argv[0] || '');
      if (!name) reject('missing_command_head');
      if (name === 'tee') unwrapped.writes.push(...argv.slice(1).filter(v => !v.startsWith('-')));
      check({argvs: [argv], reads: [], writes: unwrapped.writes.filter(t => !STREAM.test(t))}, state);
      if (SHELLS.has(name)) {
        const flag = argv.findIndex((v, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(v));
        if (flag > 0) {
          if (!words[offset + flag + 1] || words[offset + flag + 1].dynamic) reject('dynamic_shell_body');
          script(argv[flag + 1], {dirs: [...state.dirs]}, false, depth + 1);
        } else {
          // Explicit script files are the original threat-model exception, not stdin code.
          const file = argv.findIndex((v, i) => i > 0 && !v.startsWith('-'));
          if (file < 0 || words[offset + file].dynamic || /^\/(?:dev|proc)\//.test(path.posix.normalize(argv[file])) ||
              argv.slice(1, file).some(v => v !== '--' && (!/^-[a-zA-Z]+$/.test(v) || /[scoO]/.test(v.slice(1))))) reject('shell_stdin_or_unmodeled_options');
        }
      }
      if (name === 'find') argv.forEach((v, i) => {
        if (!['-exec','-execdir','-ok','-okdir'].includes(v)) return;
        const end = argv.findIndex((w, j) => j > i && (w === ';' || w === '+'));
        if (end < 0) reject('find_exec_unterminated');
        if (v.endsWith('dir')) reject('find_execdir_cwd');
        execute(words.slice(offset + i + 1, offset + end), fork(state.dirs), true, depth);
      });
      if (name === 'cd') {
        ctx.cd = true;
        const target = argv[1] || env.HOME || require('node:os').homedir();
        if (compound) reject('compound_cd_scope');
        if (argv.length > 2 || target === '-' || /[$`*?\[\]{}]/.test(expand(target)) ||
            env.CDPATH !== undefined && !/^(?:\/|~\/)/.test(target)) reject('cd_target_or_CDPATH');
        const next = state.dirs.map(dir => path.resolve(dir, expand(target)));
        outcome(state, next, incoming);
      } else outcome(state, incoming, incoming); // Unknown command status may take either short-circuit edge.
    }
    function visit(n, state, compound, depth) {
      if (n.isMissing || n.type === 'ERROR') reject('parse_error');
      if (n.isNamed ? !NODES.has(n.type) : !TOKENS.has(n.type) && !['test_operator','unary_expression','binary_expression'].includes(n.parent?.type)) reject(`node:${n.type}`);
      if (!n.isNamed) return null;
      if (n.type === 'raw_string') return word(n.text.slice(1, -1));
      if (['word','number','string_content'].includes(n.type)) {
        const raw = n.text, quoted = n.type === 'string_content';
        if (!quoted && (/^=/.test(raw) || /^~(?!\/|$)/.test(raw))) reject('zsh_word_expansion');
        return word(raw.replace(/\\\n/g, '').replace(quoted ? /\\([$`"\\])/g : /\\(.)/gs, '$1'));
      }
      if (['heredoc_start','heredoc_end','heredoc_body','comment','variable_name','special_variable_name','file_descriptor','test_operator'].includes(n.type)) return word(n.text);
      if (n.type === 'expansion' && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(n.text)) reject('complex_parameter_expansion');
      if (n.type === 'variable_assignment') ctx.assignment = true;
      // Bash grammar treats some continuations as word separators, unlike zsh.
      // Reject those boundaries rather than reconstructing a second shell lexer.
      if (n.type === 'command') {
        const parts = n.namedChildren;
        for (let i = 1; i < parts.length; i++) if (/\\\n/.test(n.text.slice(parts[i-1].endIndex - n.startIndex, parts[i].startIndex - n.startIndex))) reject('line_continuation_boundary');
      }
      if (n.type === 'redirected_statement' && !n.childForFieldName('body')) reject('implicit_redirection_command');
      if (n.type === 'heredoc_redirect') {
        const delimiter = n.namedChildren.find(c => c.type === 'heredoc_start');
        const body = n.namedChildren.find(c => c.type === 'heredoc_body');
        if (!/[\\'"]/.test(delimiter?.text || '') && /[$`\\]/.test(body?.text || '')) reject('unquoted_heredoc_expansion');
        for (const ch of n.children) { if (ch.type !== 'heredoc_body') visit(ch, state, compound, depth); }
        return null;
      }
      if (n.type === 'list') {
        const operands = n.namedChildren.filter(c => c.type !== 'comment');
        const op = n.children.find(c => c.type === '&&' || c.type === '||');
        if (operands.length !== 2 || !op) reject('list_shape');
        for (const ch of n.children) if (!ch.isNamed || ch.type === 'comment') visit(ch, state, compound, depth);
        // A list's status belongs to the branch that executed, not its last textual command.
        const left = fork(state.dirs);
        visit(operands[0], left, compound, depth);
        const right = fork(op.type === '&&' ? left.ok : left.fail);
        visit(operands[1], right, compound, depth);
        outcome(state, op.type === '&&' ? right.ok : union(left.ok, right.ok),
          op.type === '&&' ? union(left.fail, right.fail) : right.fail);
        return null;
      }
      if (n.type === 'subshell') { outcome(state, state.dirs, state.dirs); state = fork(state.dirs); }
      compound ||= COMPOUND.has(n.type);
      const children = new Map();
      // Redirections are opened in the incoming cwd, before the body can change it.
      const ordered = n.type === 'redirected_statement' ? [...n.children].sort((a,b) => (a.type === 'command' ? 1 : 0) - (b.type === 'command' ? 1 : 0)) : n.children;
      for (const ch of ordered) children.set(ch.id, visit(ch, state, compound, depth));
      const get = ch => ch && children.get(ch.id);
      if (['command_name','concatenation','string'].includes(n.type)) {
        if (n.type === 'concatenation' && (/^=/.test(n.text) || /^~(?!\/|$)/.test(n.text))) reject('zsh_word_expansion');
        const parts = n.namedChildren.map(get);
        return word(parts.map(p => p?.value || '').join(''), parts.some(p => p?.dynamic));
      }
      if (['simple_expansion','expansion'].includes(n.type)) return word(n.text, true);
      if (n.type === 'file_redirect') {
        const target = get(n.childForFieldName('destination'))?.value || '';
        const op = n.children.find(c => !c.isNamed)?.type;
        const fd = ['>&','<&'].includes(op) && /^(?:\d+|-)$/.test(target);
        check({argvs: [], reads: op === '<' ? [target] : [], writes: op !== '<' && !fd && !STREAM.test(target) ? [target] : []}, state);
      }
      if (n.type === 'command') execute([get(n.childForFieldName('name')), ...n.childrenForFieldName('argument').map(get)], state, compound, depth);
      return null;
    }
    function script(source, state, compound, depth) {
      if (depth > 8) reject('nested_shell_depth');
      const tree = parser.parse(source);
      try { if (tree.rootNode.hasError) reject('parse_error'); visit(tree.rootNode, state, compound, depth); }
      finally { tree.delete(); }
    }
    try {
      script(text, {dirs: [cwd]}, false, 0);
      if (ctx.cd && ctx.assignment) reject('assignment_with_cd');
      if (ctx.names.includes('kill') && ctx.names.some(n => ['lsof','pgrep','pidof'].includes(n))) reject('pid_lookup_then_kill');
      return null;
    } catch (error) { return error.message; }
  }
  return {init, analyze};
}
module.exports = {...createLoader(), createLoader};

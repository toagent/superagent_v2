'use strict';
const path = require('node:path');
const {realpathSync} = require('node:fs');
const {unwrap, SHELLS, parse, normalizeOptions} = require('./shell.cjs');
const STREAM = /^\/dev\/(?:null|stdout|stderr)$/;
const GENERATED_TEMP = '__sa_generated_temp__';
const isTemporaryPath = file => path.normalize(file).split(path.sep).includes(GENERATED_TEMP);
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
  function substitutions(source) {
    if (!parser) throw new Error('Shell AST unavailable');
    const tree = parser.parse(source), spans = [];
    const walk = n => {
      if (['command_substitution','process_substitution','subshell'].includes(n.type)) {
        spans.push({start: n.startIndex, end: n.endIndex, body: source.slice(n.firstChild.endIndex, n.lastChild.startIndex)});
      } else if (n.type !== 'raw_string') for (const child of n.namedChildren) walk(child);
    };
    try { walk(tree.rootNode); return spans; } finally { tree.delete(); }
  }
  function analyze(text, cwd, env, inspect, expand, advisory = () => {}) {
    const check = (parsed, dirs) => {
      for (const dir of dirs) { const why = inspect(parsed, dir); if (why) throw new Error(why); }
    };
    const fallback = source => {
      advisory('shell_parse_unavailable');
      try { check(parse(source), [cwd]); } catch (error) {
        if (/^已(?:拦截|拒绝)：/.test(error.message)) throw error;
        advisory('shell_parse_failed');
      }
    };
    const union = (...dirs) => [...new Set(dirs.flat())];
    const fork = (dirs, vars = new Map(), locations = new Map()) => ({locations: new Map(locations), dirs: [...dirs], ok: [...dirs], fail: [...dirs], vars: new Map(vars)});
    const commandValues = new Map();
    function temporaryPath(values, state, generatedOnly = true) {
      const {argv} = unwrap(values || []);
      if (path.posix.basename(argv[0] || '') !== 'mktemp') return null;
      const vars = new Map([...state.vars, ...(values || []).filter(v => /^TMPDIR=/.test(v)).map(v => ['TMPDIR', v.slice(7)])]);
      const tmpdir = vars.get('TMPDIR') ?? env.TMPDIR;
      let base = tmpdir || require('node:os').tmpdir(), template, prefix = false, inBase = false, positional = false;
      for (let i = 1; i < argv.length; i++) {
        let arg = argv[i];
        if (!positional && arg === '--') { positional = true; continue; }
        if (!positional && /^-[^-]/.test(arg)) {
          // Normalize flag bundles before consuming the option's attached/next value.
          const options = [];
          for (let j = 1; j < arg.length; j++) {
            options.push('-' + arg[j]);
            if (arg[j] === 'p') { if (arg.slice(j + 1)) options.push(arg.slice(j + 1)); break; }
          }
          argv.splice(i, 1, ...options); arg = argv[i];
        }
        if (!positional && ['-d','-u','-q','--directory','--dry-run','--quiet'].includes(arg)) continue;
        if (!positional && arg === '-t') { prefix = true; continue; }
        if (!positional && arg === '-p') { base = argv[++i]; inBase = true; continue; }
        if (!positional && (arg === '--tmpdir' || arg.startsWith('--tmpdir='))) {
          if (arg.includes('=')) base = arg.slice(arg.indexOf('=') + 1);
          inBase = true; continue;
        }
        if (!positional && arg.startsWith('-')) return null;
        if (template !== undefined) return null;
        template = arg;
      }
      const target = expand((prefix || inBase || !template) && !path.isAbsolute(template || '') ? path.join(base || '', template || 'tmp') : template).replace(/\$\{TMPDIR\}|\$TMPDIR\b/g, tmpdir || '$TMPDIR');
      if (!base || /[$`]/.test(target)) return null;
      if (!generatedOnly) return argv.some(arg => ['-u','--dry-run'].includes(arg)) ? null : target;
      const dirs = state.dirs.map(dir => path.resolve(dir, path.dirname(target)));
      const roots = ['/tmp','/private/tmp','/var/folders','/private/var/folders',env.TMPDIR].filter(Boolean);
      return dirs.length === 1 && roots.some(root => { const rel = path.relative(root, dirs[0]); return rel === '' || !rel.startsWith('..') && !path.isAbsolute(rel); })
        ? path.join(dirs[0], GENERATED_TEMP) : null;
    }
    const outcome = (state, ok, fail) => { state.ok = ok; state.fail = fail; state.dirs = union(ok, fail); };
    function execute(values, state, depth) {
      const created = temporaryPath(values, state, false);
      values = normalizeOptions(values);
      const incoming = [...state.dirs], unwrapped = unwrap(values);
      const commandEnv = Object.fromEntries([...state.vars, ...values.filter(v => /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)).map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)])]);
      const wrappers = unwrapped.heads.filter(i => i < values.length - unwrapped.argv.length);
      for (const head of wrappers.filter(i => path.posix.basename(values[i]) === 'env')) {
        const end = unwrapped.heads.find(i => i > head) ?? values.length;
        const options = values.slice(head + 1, end);
        const change = options.findIndex(v => v === '-C' || /^-C.+|^--chdir(?:=|$)/.test(v));
        if (change < 0) continue;
        const option = options[change];
        const target = option.includes('=') ? option.slice(option.indexOf('=') + 1) : option.startsWith('-C') && option.length > 2 ? option.slice(2) : options[change + 1];
        state = fork(target && !/[$`]/.test(target) ? state.dirs.map(dir => path.resolve(dir, expand(target))) : ['/__sa_unknown_cwd__'], state.vars, state.locations);
        if (state.dirs.includes('/__sa_unknown_cwd__')) advisory('cwd_unknown');
        unwrapped.writes = unwrapped.writes.filter(v => v !== target);
      }
      // Inspect wrapper arguments too: their paths may contain private data.
      check({argvs: wrappers.map(i => values.slice(i)), reads: [], writes: []}, state.dirs);
      for (const line of unwrapped.lines) script(line, fork(state.dirs, state.vars, state.locations), depth + 1);
      const argv = unwrapped.argv;
      const name = path.posix.basename(argv[0] || '');
      if (/[$`]/.test(name)) advisory('command_head_unknown');
      check({argvs: argv.length ? [argv] : [], reads: [], writes: [...unwrapped.writes, ...(created ? [created] : [])].filter(t => !STREAM.test(t)), env: commandEnv}, state.dirs);
      if (SHELLS.has(name)) {
        const flag = argv.findIndex((v, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(v));
        if (flag > 0 && argv[flag + 1]) {
          if (/\$|`/.test(argv[flag + 1]) && !values.includes(argv[flag + 1])) advisory('dynamic_shell_body');
          const inner = fork(state.dirs, state.vars, state.locations), args = argv.slice(flag + 3);
          inner.vars.set('0', argv[flag + 2] || '');
          args.forEach((arg, i) => inner.vars.set(String(i + 1), arg));
          inner.vars.set('@', args.join(' ')); inner.vars.set('*', args.join(' '));
          script(argv[flag + 1], inner, depth + 1);
        }
      }
      if (name === 'eval' && argv.length > 1) { script(argv.slice(1).join(' '), state, depth + 1); return; }
      if (name === 'find') argv.forEach((v, i) => {
        if (!['-exec','-execdir','-ok','-okdir'].includes(v)) return;
        const end = argv.findIndex((w, j) => j > i && (w === ';' || w === '+'));
        if (end < 0 || v.endsWith('dir')) advisory('find_execution_scope');
        execute(argv.slice(i + 1, end < 0 ? undefined : end), fork(v.endsWith('dir') ? ['/__sa_unknown_cwd__'] : state.dirs, state.vars, state.locations), depth + 1);
      });
      if (['cd','pushd','popd'].includes(name)) {
        let at = 1, physical = false, valid = true;
        while (at < argv.length && argv[at].startsWith('-') && argv[at] !== '-') {
          const flag = argv[at++];
          if (flag === '--') break;
          if (name !== 'cd' || !/^-[LP]+$/.test(flag)) { valid = false; break; }
          physical = flag.endsWith('P');
        }
        const target = expand(argv[at] ?? env.HOME ?? require('node:os').homedir());
        if (!valid || argv.length - at > (name === 'popd' ? 0 : 1)
            || name !== 'cd' && argv.length === at && name !== 'popd'
            || name !== 'popd' && (target === '' || /[$`*?\[\]{}]/.test(target)
              || env.CDPATH && !path.isAbsolute(target) && target !== '-')) {
          advisory('cwd_unknown'); outcome(state, ['/__sa_unknown_cwd__'], incoming); return;
        }
        const next = [];
        for (const dir of incoming) {
          const frames = state.locations.get(dir) || [{stack: [dir], previous: env.OLDPWD}];
          for (const frame of frames) {
            let destination;
            if (name === 'popd') destination = frame.stack[1];
            else if (target === '-') destination = name === 'cd' ? frame.previous : undefined;
            else {
              destination = path.resolve(dir, target);
              if (physical && !isTemporaryPath(destination)) {
                try { destination = realpathSync.native(path.isAbsolute(target) ? target : dir + '/' + target); }
                catch (error) { if (['ENOENT','ENOTDIR','EACCES'].includes(error.code)) continue; throw error; }
              }
            }
            if (!destination || dir === '/__sa_unknown_cwd__' && !path.isAbsolute(target)) {
              advisory('cwd_unknown'); next.push('/__sa_unknown_cwd__'); continue;
            }
            const stack = name === 'pushd' ? [destination, ...frame.stack] : name === 'popd' ? frame.stack.slice(1) : [destination, ...frame.stack.slice(1)];
            const updated = {stack, previous: dir};
            const prior = state.locations.get(destination) || [];
            state.locations.set(destination, [...prior, updated]);
            next.push(destination);
          }
        }
        outcome(state, union(next), incoming);
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
        if (n.parent?.text.match(/^(?:bash|sh|zsh|dash|ksh)\b/)) { script(body?.text || '', fork(state.dirs, state.vars, state.locations), depth + 1); return null; }
        // Heredoc quotes are data. Reparse as string content so the AST also sees
        // backticks (the grammar's heredoc_content otherwise leaves them opaque).
        if (!/[\\'"]/.test(delimiter?.text || '')) {
          const inner = fork(state.dirs, state.vars, state.locations);
          for (const child of body?.namedChildren || []) if (child.type === 'command_substitution') visit(child, inner, depth + 1);
          const original = body?.text || '', offsets = []; let source = '"';
          for (let i = 0; i < original.length; i++) {
            if (original[i] === '"' || original[i] === '\\' && !/[$`\\\n]/.test(original[i + 1] || '')) { offsets[source.length] = i; source += '\\'; }
            offsets[source.length] = i; source += original[i];
          }
          script(source + '"', inner, depth + 1, {original, offsets});
        }
        return null;
      }
      if (n.type === 'for_statement') {
        const variable = n.childForFieldName('variable')?.text, values = n.childrenForFieldName('value');
        // Numeric iteration never contributes a slash or a parent-directory component.
        const numeric = values.length && values.every(v => /^\d+$/.test(v.text) || /^\$\(seq\s+\d+(?:\s+\d+){0,2}\)$/.test(v.text));
        const inner = fork(state.dirs, state.vars, state.locations);
        if (variable) { inner.vars.delete(variable); if (numeric) inner.vars.set(variable, '1'); }
        for (const child of n.namedChildren) visit(child, inner, depth);
        for (const assignment of n.descendantsOfType('variable_assignment')) state.vars.set(assignment.childForFieldName('name')?.text, '$__sa_unknown__');
        if (variable) state.vars.set(variable, '$__sa_unknown__');
        outcome(state, union(state.dirs, inner.ok), union(state.dirs, inner.fail)); return null;
      }
      if (n.type === 'negated_command') {
        for (const child of n.namedChildren) visit(child, state, depth);
        outcome(state, state.fail, state.ok); return null;
      }
      if (n.type === 'pipeline') state = fork(state.dirs, state.vars, state.locations);
      if (n.type === 'list') {
        const operands = n.namedChildren.filter(c => c.type !== 'comment');
        const op = n.children.find(c => c.type === '&&' || c.type === '||');
        if (operands.length === 2 && op) {
          const left = fork(state.dirs, state.vars, state.locations); visit(operands[0], left, depth);
          const right = fork(op.type === '&&' ? left.ok : left.fail, left.vars, left.locations); visit(operands[1], right, depth);
          outcome(state, op.type === '&&' ? right.ok : union(left.ok, right.ok), op.type === '&&' ? union(left.fail, right.fail) : right.fail);
          for (const [dir, frames] of right.locations) state.locations.set(dir, frames);
          for (const variable of union([...state.vars.keys()], [...left.vars.keys()], [...right.vars.keys()]))
            state.vars.set(variable, left.vars.get(variable) === right.vars.get(variable) ? right.vars.get(variable) : '$__sa_unknown__');
          return null;
        }
      }
      if (['subshell','command_substitution','process_substitution'].includes(n.type)) state = fork(state.dirs, state.vars, state.locations);
      const children = new Map();
      const ordered = n.type === 'redirected_statement' ? [...n.children].sort((a,b) => (a.type === 'command' ? 1 : 0) - (b.type === 'command' ? 1 : 0)) : n.children;
      for (const ch of ordered) children.set(ch.id, visit(ch, state, depth));
      if (['if_statement','while_statement','case_statement'].includes(n.type))
        for (const assignment of n.descendantsOfType('variable_assignment')) state.vars.set(assignment.childForFieldName('name')?.text, '$__sa_unknown__');
      const get = ch => ch && children.get(ch.id);
      if (['command_name','concatenation','string'].includes(n.type)) return n.namedChildren.map(ch => get(ch) || '').join('');
      if (['simple_expansion','expansion'].includes(n.type)) {
        const variable = n.namedChildren.find(ch => ['variable_name','special_variable_name'].includes(ch.type))?.text;
        return state.vars.get(variable) ?? (variable === 'TMPDIR' ? env.TMPDIR : undefined) ?? n.text;
      }
      if (['command_substitution','process_substitution'].includes(n.type)) {
        const temp = n.type === 'command_substitution' && n.namedChildren.length === 1 ? temporaryPath(commandValues.get(n.namedChildren[0].id), state) : null;
        if (temp) return temp;
        return n.text;
      }
      if (n.type === 'variable_assignment') {
        const variable = n.childForFieldName('name')?.text, value = n.childForFieldName('value');
        const literal = get(value);
        if (variable && n.parent?.type !== 'command') {
          state.vars.set(variable, literal || value?.text || '$__sa_unknown__');
        }
        return variable && literal ? `${variable}=${literal}` : n.text;
      }
      if (n.type === 'file_redirect') {
        const target = get(n.childForFieldName('destination')) || '';
        const op = n.children.find(c => !c.isNamed)?.type;
        const fd = ['>&','<&'].includes(op) && /^(?:\d+|-)$/.test(target);
        const writes = op !== '<' && !fd && !STREAM.test(target) ? [target] : [];
        check({argvs: [], reads: op === '<' ? [target] : [], writes, overwrites: ['>>','&>>'].includes(op) ? [] : writes}, state.dirs);
      }
      if (n.type === 'command') {
        const values = [...n.namedChildren.filter(ch => ch.type === 'variable_assignment').map(get), get(n.childForFieldName('name')), ...n.childrenForFieldName('argument').map(get)].filter(v => v !== null && v !== undefined);
        commandValues.set(n.id, values); execute(values, state, depth);
      }
      return null;
    }
    function script(source, state, depth, heredoc) {
      if (depth > 8) { advisory('nested_shell_depth'); return; }
      const tree = parser.parse(source);
      const walk = n => {
        if (n.type === 'command_substitution') {
          if (n.firstChild.type === '`') script(heredoc.original.slice(heredoc.offsets[n.firstChild.endIndex], heredoc.offsets[n.lastChild.startIndex]), fork(state.dirs, state.vars, state.locations), depth + 1);
        }
        else for (const child of n.namedChildren) walk(child);
      };
      try { if (tree.rootNode.hasError) advisory('shell_parse_failed'); if (heredoc) walk(tree.rootNode); else visit(tree.rootNode, state, depth); }
      finally { tree.delete(); }
    }
    try {
      if (!parser) fallback(text); else script(text, fork([cwd]), 0);
      return null;
    } catch (error) {
      if (/^已(?:拦截|拒绝)：/.test(error.message)) return error.message;
      advisory('shell_analysis_failed'); return null;
    }
  }
  return {init, analyze, substitutions};
}
module.exports = {...createLoader(), createLoader, isTemporaryPath};

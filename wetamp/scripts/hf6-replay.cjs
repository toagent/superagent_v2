'use strict';
// Read only Codex exec headers; never return transcript prose or tool output.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {createRequire} = require('node:module'), vm = require('node:vm');
const {tokens} = require('../hooks/shell.cjs');
const current = require('../hooks/redline.cjs');

function extract(text) {
  const lines = text.split('\n'), commands = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== 'exec' || !/^\/\S+ -lc /.test(lines[i + 1] || '')) continue;
    let header = '';
    for (i++; i < lines.length; i++) {
      header += (header ? '\n' : '') + lines[i];
      let words;
      try { words = tokens(header); } catch { continue; }
      if (words[3]?.value !== 'in' || !words[4]?.value.startsWith('/')) break;
      commands.push({shell: words[2].value, cwd: words[4].value});
      break;
    }
  }
  return commands;
}
function baseline(ref, root) {
  const load = relative => {
    const result = spawnSync('git', ['show', `${ref}:wetamp/hooks/${relative}`], {cwd: root, encoding: 'utf8'});
    if (result.status !== 0) throw new Error(`Cannot load baseline ${relative}`);
    const file = path.join(root, 'wetamp/hooks', relative), mod = {exports: {}}, nativeRequire = createRequire(file);
    const localRequire = name => name === './shell.cjs' && relative === 'redline.cjs' ? shell : nativeRequire(name);
    vm.runInThisContext(`(function(require, module, exports) {\n${result.stdout}\n})`, {filename: file})(localRequire, mod, mod.exports);
    return mod.exports;
  };
  const shell = load('shell.cjs');
  return load('redline.cjs');
}
function replay(commands, before, after) {
  let oldDenied = 0, newDenied = 0;
  const added = [], changedCommander = [];
  for (const command of commands) {
    let root = command.cwd;
    while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
    if (path.dirname(root) === root) root = command.cwd; // Removed checkouts retain their logged cwd as the conservative root.
    const args = {client: 'codex', name: 'exec_command', input: {}, ...command, root, derived: true, env: {}};
    const oldReason = before.reason(args), newReason = after.reason(args);
    oldDenied += oldReason !== null; newDenied += newReason !== null;
    if (oldReason === null && newReason !== null) {
      const category = /超出可建模子集：([^）]+)/.exec(newReason)?.[1] || (newReason.includes('动态路径') ? 'dynamic_write_target' : 'redline_policy');
      added.push({sha256: crypto.createHash('sha256').update(command.shell).digest('hex'), category});
    }
    if (before.reason({...args, derived: false}) !== after.reason({...args, derived: false})) changedCommander.push(crypto.createHash('sha256').update(command.shell).digest('hex'));
  }
  return {total: commands.length, baseline_rejected: oldDenied, current_rejected: newDenied, added_rejected: added.length, added_rate: commands.length ? added.length / commands.length : 0, commander_changed: changedCommander.length, reasons: added.reduce((counts, r) => { counts[r.category] = (counts[r.category] || 0) + 1; return counts; }, {}), added};
}
module.exports = {extract, baseline, replay};
if (require.main === module) (async () => {
  await current.init();
  const [logs, output, corpus] = process.argv.slice(2);
  if (!logs || !output || !corpus) throw new Error('Usage: hf6-replay.cjs <logs-dir> <report.json> <command-only-corpus.json>');
  const commands = fs.existsSync(corpus) ? JSON.parse(fs.readFileSync(corpus, 'utf8')) : fs.readdirSync(logs).filter(f => f.endsWith('-sol.log')).flatMap(f => extract(fs.readFileSync(path.join(logs, f), 'utf8')));
  if (!fs.existsSync(corpus)) fs.writeFileSync(corpus, JSON.stringify(commands));
  const result = replay(commands, baseline('25c107b0', path.resolve(__dirname, '../..')), current);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({...result, added: undefined}));
  for (const added of result.added) console.log(JSON.stringify(added));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

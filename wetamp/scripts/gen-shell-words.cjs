'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function capture(shell, args) {
  const r = spawnSync(shell, args, {
    encoding: 'utf8',
    env: { ...process.env, ZDOTDIR: '/dev/null' },
  });
  if (r.error || r.status !== 0) throw r.error || new Error(`${shell}: metadata exit ${r.status}`);
  return r.stdout.trim();
}
function collect(shell) {
  const zsh = shell.endsWith('/zsh');
  const version = capture(shell, ['--version']);
  const args = zsh
    ? ['-fc', 'print -l -- ${(k)builtins}; print -l -- ${(k)reswords}']
    : ['--noprofile', '--norc', '-c', 'compgen -b; compgen -k'];
  const words = [...new Set(capture(shell, args).split('\n').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256').update(JSON.stringify(words)).digest('hex');
  return { shell, version, words, hash };
}
const shells = ['/bin/zsh', '/bin/bash'];
function check(file) {
  const generated = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const shell of shells) {
    if (!fs.existsSync(shell)) {
      console.log(`SKIP ${shell}: shell unavailable`);
      continue;
    }
    const actual = collect(shell),
      expected = generated.find(s => s.shell === shell);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`${shell}: shell version/words differ; run node scripts/gen-shell-words.cjs`);
    console.log(`PASS ${shell}: version, words and hash match`);
  }
}
if (require.main === module) {
  const file = path.resolve(__dirname, '../hooks/shell-words.json');
  if (process.argv.includes('--check')) check(file);
  else fs.writeFileSync(file, JSON.stringify(shells.map(collect), null, 2) + '\n');
}
module.exports = { collect, check };

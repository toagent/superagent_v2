'use strict';
// Git parses global options before its subcommand. Only two operations are denied.
const {message} = require('./redline.cjs');
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'];
function reason(argv, _dir, _root, _env, _deletions, onCategory = () => {}) {
  let i = 1;
  while (argv[i]?.startsWith('-')) {
    if (argv[i] === '--') { i++; break; }
    const [option, attached] = argv[i].split(/=(.*)/s);
    i += GIT_VALUE_OPTIONS.includes(option) && attached === undefined ? 2 : 1;
  }
  const sub = argv[i], rest = argv.slice(i + 1);
  const options = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length);
  if (sub === 'push' && (options.some(arg => /^-[^-]*f/.test(arg) || arg.startsWith('--') && arg.length > 2 && ['force', 'force-with-lease'].some(flag => flag.startsWith(arg.slice(2).split('=')[0]))) || rest.some(arg => arg.startsWith('+')))) {
    onCategory('shared_history'); return message('执行 git force push', '会强制改写共享远端历史');
  }
  if (sub === 'reset' && options.some(arg => arg.startsWith('--') && arg.length > 2 && 'hard'.startsWith(arg.slice(2)))) {
    onCategory('destruction'); return message('执行 git reset --hard', '会丢弃文件改动');
  }
  return null;
}
module.exports = {reason};

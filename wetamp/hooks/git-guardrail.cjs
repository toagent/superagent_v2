#!/usr/bin/env node
'use strict';
// Claude/Codex/OpenCode legacy payloads share the project's AST and Git classifier.
const fs = require('node:fs'), path = require('node:path');
const redline = require('./redline.cjs'), git = require('./git-danger.cjs');
(async () => {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const input = payload.tool_input || payload.args || {};
  const shell = input.command ?? input.cmd ?? input.script ?? input.input ?? input.shellCommand;
  if (typeof shell !== 'string') return;
  await redline.init();
  const cwd = input.workdir || input.directory || payload.cwd || process.cwd(), deletions = new Map();
  const advisory = new Set();
  const reason = require('./shell-ast.cjs').analyze(shell, cwd, process.env, (parsed, dir) => {
    for (const argv of parsed.argvs) if (path.basename(argv[0] || '') === 'git') {
      // Preserve the legacy adapter's manual-only policy while sharing its parser.
      const {sub, rest} = git.gitInvocation(argv, dir, {...process.env, ...parsed.env});
      if (sub === 'push') return redline.message('执行 git push', 'git push 须人工执行');
      const options = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : rest.length);
      if (sub === 'commit' && options.some(v => v === '--no-verify' || /^-[^-]*n/.test(v)))
        return redline.message('跳过 Git 提交检查', '会绕过提交护栏');
      if (sub === 'add' && options.some(v => v === '--all' || /^-[^-]*A/.test(v)))
        return redline.message('暂存整个工作区', '请明确指定文件或目录');
      const why = git.reason(argv, dir, redline.checkoutOf(cwd) || cwd, {...process.env, ...parsed.env}, deletions);
      if (why) return why;
    }
    return null;
  }, word => redline.expand(word, process.env), code => advisory.add(code));
  if (reason) { process.stderr.write(reason + '\n'); process.exitCode = 2; }
  else if (advisory.size) process.stdout.write(JSON.stringify({systemMessage: `SUPERAGENT advisory: ${[...advisory].join(', ')}`}) + '\n');
})().catch(() => process.stdout.write(JSON.stringify({systemMessage: 'SUPERAGENT advisory: Git guard input unavailable; allowed'}) + '\n'));

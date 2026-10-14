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
  const cwd = input.workdir || input.directory || payload.cwd || process.cwd();
  const advisory = new Set();
  let superagentPermissionCategory = 'diagnostic';
  const reason = require('./shell-ast.cjs').analyze(shell, cwd, process.env, (parsed, dir) => {
    for (const argv of parsed.argvs) if (path.basename(argv[0] || '') === 'git') {
      const why = git.reason(argv, dir, redline.checkoutOf(cwd) || cwd, {...process.env, ...parsed.env}, undefined, category => { superagentPermissionCategory = category; });
      if (why) return why;
    }
    return null;
  }, word => redline.expand(word, process.env), code => advisory.add(code));
  if (reason) {
    process.stdout.write(JSON.stringify({superagentPermissionCategory, hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}}) + '\n');
    process.stderr.write(reason + '\n'); process.exitCode = 2;
  }
  else if (advisory.size) process.stdout.write(JSON.stringify({systemMessage: `SUPERAGENT advisory: ${[...advisory].join(', ')}`}) + '\n');
})().catch(() => process.stdout.write(JSON.stringify({systemMessage: 'SUPERAGENT advisory: Git guard input unavailable; allowed'}) + '\n'));

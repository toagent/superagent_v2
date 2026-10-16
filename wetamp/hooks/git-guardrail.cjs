#!/usr/bin/env node
'use strict';
// Claude/Codex/OpenCode legacy payloads share the project's AST and Git classifier.
const fs = require('node:fs'),
  path = require('node:path');
const redline = require('./redline.cjs'),
  git = require('./git-danger.cjs');
(async () => {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const input = payload.tool_input || payload.args || {};
  const privacy = process.argv.includes('--privacy');
  const shell =
    !privacy || ['bash', 'shell', 'run', 'exec'].includes(payload.tool_name)
      ? (input.command ?? input.cmd ?? input.script ?? input.input ?? input.shellCommand)
      : undefined;
  if (!privacy && typeof shell !== 'string') return;
  await redline.init();
  const cwd = input.workdir || input.directory || payload.cwd || process.cwd();
  if (privacy) {
    const why = redline.reason({
      name: payload.tool_name,
      input,
      cwd,
      shell: typeof shell === 'string' ? shell : undefined,
    });
    if (why) {
      process.stderr.write(why + '\n');
      process.exitCode = 2;
      return;
    }
    if (typeof shell !== 'string') return;
  }
  const advisory = new Set();
  let superagentPermissionCategory = 'diagnostic';
  const reason = require('./shell-ast.cjs').analyze(
    shell,
    cwd,
    process.env,
    (parsed, dir) => {
      for (const argv of parsed.argvs)
        if (path.basename(argv[0] || '') === 'git') {
          const why = git.reason(
            argv,
            dir,
            redline.checkoutOf(cwd) || cwd,
            { ...process.env, ...parsed.env },
            undefined,
            category => {
              superagentPermissionCategory = category;
            }
          );
          if (why) return why;
        }
      return null;
    },
    word => redline.expand(word, process.env),
    code => advisory.add(code)
  );
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        superagentPermissionCategory,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n'
    );
    process.stderr.write(reason + '\n');
    process.exitCode = 2;
  } else if (advisory.size)
    process.stdout.write(
      JSON.stringify({ systemMessage: `SUPERAGENT advisory: ${[...advisory].join(', ')}` }) + '\n'
    );
})().catch(() => {
  if (process.argv.includes('--privacy')) {
    process.stderr.write('已拦截：redline_internal_error：隐私检查不可用\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    JSON.stringify({ systemMessage: 'SUPERAGENT advisory: Git guard input unavailable; allowed' }) +
      '\n'
  );
});

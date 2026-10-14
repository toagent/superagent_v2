#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process');
try {
  const bun =
    [
      process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'),
      path.join(os.homedir(), '.bun/bin/bun'),
      '/opt/homebrew/bin/bun',
    ].find(p => p && fs.existsSync(p)) || 'bun';
  const result = spawnSync(bun, [path.join(__dirname, '../src/intake-hook.ts'), process.argv[2]], {
    input: fs.readFileSync(0),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (result.status !== 0) throw new Error('adapter unavailable');
  process.stdout.write(result.stdout);
} catch {
  process.stdout.write(
    JSON.stringify({
      systemMessage: 'SUPERAGENT intake advisory: adapter unavailable; original prompt allowed.',
    }) + '\n'
  );
}

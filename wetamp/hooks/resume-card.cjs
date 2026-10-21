#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8')),
    client = process.argv[2];
  if (
    payload.hook_event_name !== 'SessionStart' ||
    payload.source !== 'compact' ||
    require('./guard.cjs').derivedBy(payload, client)
  )
    process.exit(0);
  const bun =
    [
      process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'),
      path.join(os.homedir(), '.bun/bin/bun'),
      '/opt/homebrew/bin/bun',
    ].find(p => p && fs.existsSync(p)) || 'bun';
  const result = spawnSync(bun, [path.join(__dirname, '../src/resume-card.ts'), client], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8192,
  });
  if (result.status !== 0) throw new Error('adapter unavailable');
  process.stdout.write(result.stdout);
} catch {
  process.stdout.write(JSON.stringify({ systemMessage: 'SUPERAGENT resume-card advisory: adapter unavailable.' }) + '\n');
}

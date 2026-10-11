#!/usr/bin/env node
'use strict';
// Installed hook paths are a shipped contract; delegate old registrations to the advisory.
const advisory = require('./context-advisory.cjs');
module.exports = advisory;
if (require.main === module) {
  try {
    const result = advisory.main(JSON.parse(require('node:fs').readFileSync(0, 'utf8')), process.argv[2] || 'claude');
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch {}
}

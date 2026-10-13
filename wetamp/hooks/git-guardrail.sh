#!/usr/bin/env bash
# Install as a symlink to this tracked file; no independent parser or policy.
exec node -e 'const p = require("node:path"), fs = require("node:fs"); require(process.env.SUPERAGENT_GIT_GUARD || p.join(p.dirname(fs.realpathSync(process.argv[1])), "git-guardrail.cjs"))' "${BASH_SOURCE[0]}"

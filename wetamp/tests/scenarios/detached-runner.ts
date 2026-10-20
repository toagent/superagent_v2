import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerPath } from '../../src/cli';
import { restore, runInProcess, scenario } from './framework';
import { sh } from '../helpers';

const output = process.env.SCENARIO_RESULT;
if (!output) throw new Error('missing detached scenario result path');
const id = (process.env.SCENARIO_ID ?? 'S1') as 'S1' | 'S4';
const f = scenario(
  {
    id,
    risk: 'G1',
    passRound: 1,
    plan: {
      goal: `${id} detached generated delivery`,
      accept: `test "$(cat scenario.txt)" = ${id}`,
    },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  },
  { target: process.env.SCENARIO_TARGET, suffix: process.env.SCENARIO_SUFFIX }
);
try {
  const result = await runInProcess(f);
  writeFileSync(
    output,
    JSON.stringify({
      terminal: result.terminal,
      ledger: JSON.parse(readFileSync(ledgerPath(`5ce0-${id.slice(1).padStart(4, '0')}`), 'utf8')),
      receipt: JSON.parse(readFileSync(join(result.artifactsDir, 'publish-m1.json'), 'utf8')),
      target: sh('git rev-parse scenario-target', f.target).trim(),
      worker: sh('git rev-parse HEAD', f.worker).trim(),
    })
  );
} finally {
  restore(f);
}

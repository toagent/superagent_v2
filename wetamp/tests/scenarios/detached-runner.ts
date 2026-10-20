import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerPath } from '../../src/cli';
import { restore, runInProcess, scenario } from './framework';
import { sh } from '../helpers';

const output = process.env.SCENARIO_RESULT;
if (!output) throw new Error('missing detached scenario result path');
const id = (process.env.SCENARIO_ID ?? 'S1') as
  | 'S1'
  | 'S4'
  | 'S12'
  | 'S14a'
  | 'S14b'
  | 'S14c'
  | 'S15';
const f = scenario(
  {
    id,
    risk: id.startsWith('S14') ? 'G2' : 'G1',
    passRound: id.startsWith('S14') ? 2 : 1,
    plan: {
      goal: `${id} detached generated delivery`,
      accept: `test "$(cat scenario.txt)" = ${id}`,
    },
    agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
    expected: { terminal: 'completed', publishCount: 1 },
  },
  {
    target: process.env.SCENARIO_TARGET,
    suffix: process.env.SCENARIO_SUFFIX,
    blockNode: process.env.SCENARIO_BLOCK_NODE,
    blockAfterCompletedNode: process.env.SCENARIO_BLOCK_AFTER_COMPLETED_NODE,
    blockMarker: process.env.SCENARIO_BLOCK_MARKER,
  }
);
try {
  if (process.env.SCENARIO_READY)
    writeFileSync(
      process.env.SCENARIO_READY,
      JSON.stringify({
        root: f.root,
        home: f.home,
        archonHome: f.archonHome,
        target: f.target,
        worker: f.worker,
        runId: `5ce0-${id.slice(1).padStart(4, '0')}`,
        blockNode: f.blockNode,
        blockMarker: f.blockMarker,
      })
    );
  const result = await runInProcess(f);
  writeFileSync(
    output,
    JSON.stringify({
      terminal: result.terminal,
      failures: result.events
        .filter(event => event.event_type === 'node_failed')
        .map(event => ({ step: event.step_name, data: event.data })),
      ledger: JSON.parse(readFileSync(ledgerPath(`5ce0-${id.slice(1).padStart(4, '0')}`), 'utf8')),
      receipt: JSON.parse(readFileSync(join(result.artifactsDir, 'publish-m1.json'), 'utf8')),
      target: sh('git rev-parse scenario-target', f.target).trim(),
      worker: sh('git rev-parse HEAD', f.worker).trim(),
    })
  );
} finally {
  restore(f);
}

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerPath } from '../../src/cli';
import {
  restore,
  resumeInProcess,
  runInProcess,
  scenario,
  type ScenarioFixture,
} from './framework';
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
const resumeState = process.env.SCENARIO_RESUME_STATE
  ? (JSON.parse(readFileSync(process.env.SCENARIO_RESUME_STATE, 'utf8')) as Pick<
      ScenarioFixture,
      'root' | 'home' | 'archonHome' | 'target' | 'worker' | 'initial' | 'runId'
    >)
  : undefined;
const f = resumeState
  ? ({
      ...resumeState,
      saved: { ...process.env },
      roles: [],
      spec: undefined,
    } as unknown as ScenarioFixture)
  : scenario(
      {
        id,
        risk: process.env.SCENARIO_RISK === 'G2' || id.startsWith('S14') ? 'G2' : 'G1',
        passRound: process.env.SCENARIO_PASS_ROUND === '2' || id.startsWith('S14') ? 2 : 1,
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
        blockRelease: process.env.SCENARIO_BLOCK_RELEASE,
        blockMs: process.env.SCENARIO_BLOCK_MS ? Number(process.env.SCENARIO_BLOCK_MS) : undefined,
        home: process.env.SCENARIO_HOME,
        runId: process.env.SCENARIO_RUN_ID,
      }
    );
f.spec = {
  id,
  risk: process.env.SCENARIO_RISK === 'G2' || id.startsWith('S14') ? 'G2' : 'G1',
  passRound: process.env.SCENARIO_PASS_ROUND === '2' || id.startsWith('S14') ? 2 : 1,
  plan: { goal: `${id} detached generated delivery`, accept: `test "$(cat scenario.txt)" = ${id}` },
  agents: { code: { path: 'scenario.txt', content: `${id}\n` } },
  expected: { terminal: 'completed', publishCount: 1 },
};
f.engineSnapshot = process.env.SCENARIO_ENGINE_SNAPSHOT;
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
        initial: f.initial,
        runId: f.runId ?? `5ce0-${id.slice(1).padStart(4, '0')}`,
        blockNode: f.blockNode,
        blockMarker: f.blockMarker,
      })
    );
  const result = resumeState ? await resumeInProcess(f) : await runInProcess(f);
  writeFileSync(
    output,
    JSON.stringify({
      terminal: result.terminal,
      failures: result.events
        .filter(event => event.event_type === 'node_failed')
        .map(event => ({ step: event.step_name, data: event.data })),
      ledger: JSON.parse(readFileSync(ledgerPath(result.runId), 'utf8')),
      receipt: existsSync(join(result.artifactsDir, 'publish-m1.json'))
        ? JSON.parse(readFileSync(join(result.artifactsDir, 'publish-m1.json'), 'utf8'))
        : null,
      target: sh('git rev-parse scenario-target', f.target).trim(),
      worker: sh('git rev-parse HEAD', f.worker).trim(),
    })
  );
} finally {
  restore(f);
}

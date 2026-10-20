import { expect, test } from 'bun:test';
import { judgeProbe, type ProbeJudgement } from '../src/probe';

const valid = JSON.parse(
  '{"launch_exit":0,"launch_run_id":"run-1","wait_exit":0,"wait_run_id":"run-1","state":"completed","delivery_state":"published","ledger_run_id":"run-1","engine_commit":"abc","engine_snapshot":"/engine/abc","expected_commit":"abc","expected_snapshot":"/engine/abc"}'
) as ProbeJudgement;

// prettier-ignore
test('judgeProbe accepts exact real-run evidence and rejects every missing identity boundary', () => {
  expect(judgeProbe(valid)).toEqual({ ok: true });
  for (const [patch, reason] of [[{ launch_exit: 1 }, 'launch_failed'], [{ launch_run_id: undefined }, 'launch_run_id_missing'], [{ wait_run_id: 'other' }, 'wait_run_id_mismatch'], [{ delivery_state: 'integrated' }, 'not_published'], [{ engine_commit: 'old' }, 'engine_commit_mismatch'], [{ engine_snapshot: '/engine/old' }, 'engine_snapshot_mismatch'], [{ timed_out: true }, 'timeout']] as const)
    expect(judgeProbe({ ...valid, ...patch })).toEqual({ ok: false, reason });
});

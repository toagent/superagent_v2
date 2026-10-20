import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { judgeProbe, runProbe, type ProbeJudgement } from '../src/probe';
import { tmp } from './helpers';

// prettier-ignore
const valid = JSON.parse('{"launch_exit":0,"launch_run_id":"run-1","wait_exit":0,"wait_run_id":"run-1","state":"completed","delivery_state":"published","ledger_run_id":"run-1","engine_commit":"abc","engine_snapshot":"/engine/abc","expected_commit":"abc","expected_snapshot":"/engine/abc"}') as ProbeJudgement;

// prettier-ignore
test('judgeProbe accepts exact real-run evidence and rejects every missing identity boundary', () => {
  expect(judgeProbe(valid)).toEqual({ ok: true });
  for (const [patch, reason] of [[{ launch_exit: 1 }, 'launch_failed'], [{ launch_run_id: undefined }, 'launch_run_id_missing'], [{ wait_run_id: 'other' }, 'wait_run_id_mismatch'], [{ delivery_state: 'integrated' }, 'not_published'], [{ engine_commit: 'old' }, 'engine_commit_mismatch'], [{ engine_snapshot: '/engine/old' }, 'engine_snapshot_mismatch'], [{ timed_out: true }, 'timeout']] as const)
    expect(judgeProbe({ ...valid, ...patch })).toEqual({ ok: false, reason });
});

const fakeProbe = (missingRunId = false): ReturnType<typeof runProbe> => {
  const root = tmp(),
    shim = join(root, 'shim'),
    snapshot = resolve(import.meta.dir, '../..');
  mkdirSync(join(root, 'sa', 'archon'), { recursive: true });
  writeFileSync(
    shim,
    `#!/bin/sh
if [ "$1" = quick ]; then
  printf '%s\n' '{"event":"started"}' '${missingRunId ? '{"ok":true}' : '{"run_id":"run-1"}'}'
  printf '%s\n' '{"code":"superagent.disk_observed","token":"raw-secret"}' >&2
  ${missingRunId ? ':' : `mkdir -p "$SUPERAGENT_HOME/runs"; printf '%s\n' '${JSON.stringify({ run_id: 'run-1', engine_commit: Bun.spawnSync(['git', '-C', snapshot, 'rev-parse', 'HEAD']).stdout.toString().trim(), engine_snapshot: snapshot })}' > "$SUPERAGENT_HOME/runs/run-1.json"`}
else printf '%s\n' '{"run_id":"run-1","state":"completed","delivery_state":"published"}'; printf '%s\n' '{"code":"superagent.disk_observed"}' >&2; fi
`
  );
  chmodSync(shim, 0o755);
  process.env.SUPERAGENT_HOME = join(root, 'sa');
  process.env.ARCHON_HOME = join(root, 'sa', 'archon');
  return runProbe('G1', shim);
};

test('probe parses quick and wait JSON only from stdout', () => {
  expect(fakeProbe()).toMatchObject({ ok: true, run_id: 'run-1' });
});

test('probe failure preserves redacted stdout and stderr tails', () => {
  const evidence = fakeProbe(true),
    saved = JSON.parse(readFileSync(evidence.evidence_path, 'utf8')) as {
      judgement: ProbeJudgement;
    };
  expect(saved.judgement.diagnostic).toContain(
    'stdout:\n{"event":"started"}\n{"ok":true}\nstderr:\n'
  );
  expect(saved.judgement.diagnostic).toContain('"token":***');
  expect(saved.judgement.diagnostic).not.toContain('raw-secret');
});

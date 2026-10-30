import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Exec, RunView } from '../../src/archon';

export interface FixtureOptions {
  launchReply?: Record<string, unknown>;
  adoptionReply?: Record<string, unknown>;
  resumeReply?: Record<string, unknown>;
  persistCancellation?: boolean;
  snapshotIntents?: string;
  rejectReply?: Record<string, unknown>;
}

export function fixtureOptions(dir: string, options: FixtureOptions): void {
  writeFileSync(join(dir, 'options.json'), JSON.stringify(options));
}

// One fixture serves in-process CLI tests and the subprocess crash/launch tests.
export function fixtureArchon(dir: string, args: string[]): Exec {
  const options: FixtureOptions = existsSync(join(dir, 'options.json'))
    ? JSON.parse(readFileSync(join(dir, 'options.json'), 'utf8'))
    : {};
  if (options.snapshotIntents && args[1] === 'run')
    writeFileSync(join(dir, '../at-run'), readdirSync(options.snapshotIntents).join('\n'));
  appendFileSync(join(dir, 'calls'), args.join(' ') + '\n');
  const files = readdirSync(dir)
    .filter(f => /^get-.*\.json$/.test(f))
    .sort();
  const current = files[0] && join(dir, files[0]);
  const reply = (value: unknown): Exec => ({ code: 0, out: JSON.stringify(value), err: '' });
  if (args[1] === 'get') {
    if (!current) throw new Error('fixture has no run response');
    const run = JSON.parse(readFileSync(current, 'utf8')) as RunView;
    if (files.length > 1) renameSync(current, join(dir, 'used', files[0]));
    return reply(run.working_path === undefined ? { ...run, working_path: dirname(dir) } : run);
  }
  if (args[1] === 'run')
    return reply(
      args.includes('--adopt')
        ? (options.adoptionReply ?? { ok: true, runId: 'r2' })
        : (options.launchReply ?? { ok: true, runId: 'r' })
    );
  if (args[1] === 'due') return reply({ ok: true, action: 'due', runs: ['r'] });
  if (args[1] === 'resume' && options.resumeReply) return reply(options.resumeReply);
  const run: RunView | undefined = current ? JSON.parse(readFileSync(current, 'utf8')) : undefined;
  if (args[1] === 'reject') {
    const result = options.rejectReply ?? { ok: true, cancelled: false, resumable: true };
    if (result.ok === true && result.cancelled === false && run?.metadata?.approval) {
      run.metadata.approval = {
        ...run.metadata.approval,
        resolved: 'rejected',
      } as typeof run.metadata.approval;
      writeFileSync(current!, JSON.stringify(run));
    }
    return reply(result);
  }
  if (args[1] === 'wait') {
    const terminal = run && ['completed', 'failed', 'cancelled'].includes(run.status);
    return {
      code: terminal ? 0 : 3,
      err: '',
      out: JSON.stringify({
        ok: true,
        action: 'wait',
        runId: args[2],
        result: terminal ? 'attention' : 'deadline',
        ...(terminal
          ? { attention: { kind: 'terminal', runId: args[2], status: run.status, at: null } }
          : { observedStatus: run?.status ?? 'running' }),
      }),
    };
  }
  if (args[1] === 'resume' && run && run.status !== 'completed') {
    run.metadata = {
      ...run.metadata,
      execution_owner: { host: hostname(), pid: 4194305 + (Date.now() % 1000000) },
    };
    run.started_at = new Date().toISOString();
    writeFileSync(current!, JSON.stringify(run));
  }
  if (args[1] === 'cancel' && run?.status !== 'running')
    return reply({
      ok: false,
      action: 'cancel',
      error: `Cannot cancel run with status '${run?.status ?? ''}'. Only a running run has live work to stop; abandon a paused or failed run instead.`,
    });
  if (args[1] === 'abandon' && (run?.status === 'completed' || run?.status === 'cancelled'))
    return reply({
      ok: false,
      action: 'abandon',
      error: `Cannot abandon run with status '${run.status}'.`,
    });
  if (args[1] === 'abandon' && options.persistCancellation && run) {
    run.status = 'cancelled';
    writeFileSync(current!, JSON.stringify(run));
  }
  return reply({ ok: true });
}

if (import.meta.main) {
  const result = fixtureArchon(process.argv[2], process.argv.slice(3));
  process.stdout.write(result.out);
  process.exit(result.code);
}

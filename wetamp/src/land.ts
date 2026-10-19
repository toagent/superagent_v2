// Generated deliver-* nodes import this stable entrypoint. Their candidate-based
// behavior stays isolated until those runs have drained.
export * from './land-legacy';
export * from './integration';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { control, coord, repoScope } from './coord';
import { publish, sync, type PublishResult, type SyncResult } from './integration';
import type { PublishReceipt } from './integration';
import type { RunView } from './archon';
import type { Ledger } from './cli';
import {
  deliveryAuthorized,
  runDeliveryEntry,
  runLegacyDeliveryMain,
  type DeliveryAuthorization,
} from './land-legacy';

const operator = () => createRequire(import.meta.url)('./cli.ts') as typeof import('./cli');

type SyncEvidence = SyncResult & { generation: number };

/** Runtime events qualify loop body nodes as `<group>.<node>`; artifacts keep the authored id. */
export const authoredNodeId = (nodeId: string): string => nodeId.split('.').at(-1) ?? nodeId;

const isPublishNode = (nodeId: string): boolean => /^publish-.+$/.test(authoredNodeId(nodeId));

const evidencePath = (name: string): string =>
  join(process.env.ARTIFACTS_DIR ?? '', `${name}.json`);

export function publishEvidence(
  run: Pick<RunView, 'nodes'>,
  node?: string
): { node: string; file: string } | undefined {
  const selected =
    node ??
    run.nodes?.filter(n => n.state === 'completed' && isPublishNode(n.nodeId)).at(-1)?.nodeId;
  return selected && isPublishNode(selected)
    ? { node: selected, file: `${authoredNodeId(selected)}.json` }
    : undefined;
}

/** Read-only projection of a durable PUBLISH receipt. */
export function publishProjection(l: Ledger, run: RunView): PublishReceipt | undefined {
  try {
    const evidence = publishEvidence(run);
    if (!l.delivery || !evidence) return;
    const value = operator().evidenceJson(l, operator().artifactsOf(run), evidence.file) as
      | Partial<PublishReceipt>
      | undefined;
    return value?.status === 'published' &&
      value.task === l.run_id &&
      value.target?.checkout === l.delivery.checkout &&
      value.target.branch === l.delivery.branch &&
      typeof value.integrated === 'string'
      ? (value as PublishReceipt)
      : undefined;
  } catch {
    return undefined;
  }
}

/** PUBLISH is retryable under its durable fencing, or already reconciled by its receipt. */
export function publishRecoverable(run: RunView): boolean {
  try {
    const ref = coord().resolveRun(run.id);
    if (!ref) return false;
    const ledger = operator().loadLedger(ref.run_id);
    if (
      ledger.archon_run_id !== run.id ||
      !ledger.delivery ||
      !existsSync(join(ledger.gen_dir, 'delivery-authorization.json'))
    )
      return false;
    if (publishProjection(ledger, run)) return true;
    const active = run.nodes?.find(n => isPublishNode(n.nodeId) && n.state === 'running');
    if (!active || !run.working_path) return false;
    const receipt = join(operator().artifactsOf(run), `${authoredNodeId(active.nodeId)}.json`);
    if (existsSync(receipt)) return false; // Invalid durable evidence must remain unknown.
    const rev = (cwd: string, ref: string): string | undefined => {
      const result = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', ref], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 3000,
      });
      return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
    };
    const target = rev(ledger.delivery.checkout, `refs/heads/${ledger.delivery.branch}`);
    const source = rev(run.working_path, 'HEAD');
    // Equal refs reconcile a lost receipt; unequal refs leave the fenced CAS safe to replay.
    return !!target && !!source;
  } catch {
    return false;
  }
}

const writeEvidence = (name: string, value: unknown): void => {
  writeFileSync(evidencePath(name), JSON.stringify(value, null, 2));
};

const emit = (name: string, value: unknown, write = true): void => {
  if (write) writeEvidence(name, value);
  process.stdout.write(JSON.stringify(value));
};

const authorized = () => {
  const runId = process.env.INPUTS_RUN;
  if (!runId) throw new Error('integration: missing run id');
  const { loadLedger, readJson } = operator();
  const ledger = loadLedger(runId);
  const authorization = readJson(join(ledger.gen_dir, 'delivery-authorization.json')) as
    | DeliveryAuthorization
    | undefined;
  if (!authorization) throw new Error('integration: authorization/run mismatch');
  const who = authorization.run;
  if (!deliveryAuthorized(who, authorization, ledger.archon_run_id))
    throw new Error('integration: authorization/run mismatch');
  const fence = (): void => {
    coord().mutate(
      repoScope(ledger.repo),
      who,
      () => {
        control(ledger, () => undefined, who, authorization.run.generation);
      },
      authorization.repo.generation
    );
  };
  return { ledger, fence };
};

const nextCounter = (name: string): number => {
  const path = join(process.env.ARTIFACTS_DIR ?? '', `.${name}`);
  const current = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
  writeFileSync(path, String(next));
  return next;
};

const integrationSync = (): void => {
  const { ledger, fence } = authorized();
  if (!ledger.delivery) throw new Error('integration: missing delivery target');
  fence();
  const generation = nextCounter(`sync-${process.env.INPUTS_MILESTONE ?? 'run'}`);
  const result: SyncEvidence = {
    ...sync(process.cwd(), ledger.delivery),
    generation,
  };
  fence();
  writeEvidence(
    process.env.INPUTS_OUTPUT ?? `sync-${process.env.INPUTS_MILESTONE ?? 'run'}`,
    result
  );
  emit(`sync-${process.env.INPUTS_MILESTONE ?? 'run'}-${String(generation)}`, result);
  if (process.env.INPUTS_FAIL_CONFLICT === '1' && result.status === 'conflict')
    process.exitCode = 1;
};

const lastGate = (milestone: string): Record<string, unknown> => {
  const artifacts = process.env.ARTIFACTS_DIR ?? '';
  const record = (file: string): Record<string, unknown> | undefined => {
    const round = /-r(\d+)\.json$/.exec(file)?.[1];
    if (!round) throw new Error(`integration: invalid gate evidence name ${file}`);
    const expected = [
      process.env[`INPUTS_GATE_${round}_SHA256`],
      process.env[`INPUTS_GATE_${round}_CARRIED_SHA256`],
    ].filter((value): value is string => Boolean(value));
    if (!expected.length) return undefined;
    const path = join(artifacts, file),
      bytes = readFileSync(path),
      actual = createHash('sha256').update(bytes).digest('hex');
    if (!expected.includes(actual)) throw new Error(`integration: gate evidence mismatch ${file}`);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`integration: invalid evidence ${path}`);
    return value as Record<string, unknown>;
  };
  const selected = readdirSync(artifacts)
    .filter(name => new RegExp(`^gate-${milestone}-r\\d+\\.json$`).test(name))
    .sort((a, b) => Number(/r(\d+)/.exec(a)?.[1]) - Number(/r(\d+)/.exec(b)?.[1]))
    .map(file => ({ file, value: record(file) }))
    .filter(
      (entry): entry is { file: string; value: Record<string, unknown> } =>
        entry.value?.verdict === 'pass'
    )
    .at(-1);
  if (!selected) throw new Error(`integration: missing passing gate for ${milestone}`);
  return selected.value;
};

const integrationPublish = (): void => {
  const { ledger, fence } = authorized();
  if (!ledger.delivery) throw new Error('integration: missing delivery target');
  const milestone = process.env.INPUTS_MILESTONE ?? 'run';
  const tag = process.env.INPUTS_OUTPUT ?? `publish-${milestone}`;
  const gate = lastGate(milestone);
  const stringField = (value: Record<string, unknown>, key: string): string =>
    typeof value[key] === 'string' ? value[key] : '';
  const reviewRequired = process.env.INPUTS_REVIEW_REQUIRED === '1';
  const receipt = evidencePath(tag);
  const result: PublishResult = publish(
    {
      worktree: process.cwd(),
      target: ledger.delivery,
      task: ledger.run_id,
      contract: createHash('sha256')
        .update(readFileSync(join(ledger.gen_dir, 'accept-inputs.json')))
        .digest('hex'),
      evidence: process.env.ARTIFACTS_DIR ?? '',
      receipt,
      review: reviewRequired
        ? {
            required: true,
            reviewed_head: stringField(gate, 'reviewed_head'),
            reviewed_diff_hash: stringField(gate, 'reviewed_diff_hash'),
          }
        : { required: false },
      fence,
    },
    { target_tip: process.env.INPUTS_TARGET_TIP ?? '' }
  );
  if (result.status === 'advanced' && nextCounter(`advanced-${milestone}`) >= 3) {
    const exhausted = {
      status: 'rejected',
      reason: 'target_advanced',
      target_tip: result.target_tip,
    };
    emit(tag, exhausted);
    process.exitCode = 1;
    return;
  }
  if (result.status === 'dirty') {
    emit(tag, { ...result, reason: 'target_dirty' });
    process.exitCode = 1;
    return;
  }
  emit(tag, result, result.status !== 'published');
  if (result.status === 'rejected') process.exitCode = 1;
};

export function runIntegrationMain(action: string): void {
  queueMicrotask(() => {
    const ok = runDeliveryEntry(() => {
      if (action === 'sync') integrationSync();
      else if (action === 'publish') integrationPublish();
      else throw new Error(`integration: unknown action ${action}`);
    });
    if (!ok) process.exitCode = 1;
  });
}

if (import.meta.main) {
  const action = process.env.INPUTS_ACTION;
  if (action) runIntegrationMain(action);
  else runLegacyDeliveryMain();
}

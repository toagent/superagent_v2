import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executionTable } from '../src/execution';
import { loadTiers, WETAMP } from '../src/config';
import type { Plan } from '../src/plan';
import { resolveAcceptanceContext } from '../src/role-context';
import { prepareContext } from '../templates/.archon/scripts/sa-context';
import { gitRepo, sh, tmp } from './helpers';

test('prepared R2 preserves requirements and open carry-over without closed history; immutable bytes', async () => {
  const gen = tmp(),
    repo = gitRepo(tmp()),
    art = join(gen, 'artifacts');
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  cpSync(join(WETAMP, 'templates/.archon'), join(gen, '.archon'), { recursive: true });
  cpSync(
    join(WETAMP, '../packages/workflows/src/provider-attempts.ts'),
    join(gen, '.archon/scripts/policy-attempts.ts')
  );
  writeFileSync(join(gen, '.archon/scripts/reasons.json'), '[]');
  writeFileSync(join(gen, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(gen, 'execution.json'), JSON.stringify(executionTable(plan, loadTiers())));
  mkdirSync(art);
  const open = {
    id: 'R1-1',
    severity: 'high',
    file: 'core.txt',
    line: 1,
    evidence: 'must retain',
    failure_class: 'unknown',
  };
  const ledger = {
    blocking: [open],
    debt: [{ ...open, id: 'R1-2', severity: 'low' }],
    closed: Array.from({ length: 100 }, (_, i) => ({ ...open, id: `old-${i}` })),
  };
  writeFileSync(join(art, 'gate-m2-r1.ledger.json'), JSON.stringify(ledger));
  const head = sh('git rev-parse HEAD', repo).trim();
  const input = {
    gen,
    artifacts: art,
    node: 'review-m2-r2',
    cwd: repo,
    base: head,
    head,
    patch: '/full.patch',
    delta: '/delta.patch',
    environment: 'actual-env-hmac',
  };
  const path = prepareContext(input),
    bytes = readFileSync(path, 'utf8'),
    context = JSON.parse(bytes);
  expect(context.tasks.map((p: { goal: string }) => p.goal)).toEqual(
    plan.packages.map(p => p.goal)
  );
  expect(context.tasks.map((p: { accept: unknown }) => p.accept)).toEqual(
    plan.packages.map(p => p.accept)
  );
  expect(context.carry_over).toEqual({ blocking: ledger.blocking, debt: ledger.debt });
  expect(context.diff).toBe('/delta.patch');
  expect(bytes).not.toContain('old-99');
  expect(prepareContext(input)).toBe(path);
  const changed = prepareContext({ ...input, environment: 'drifted-env-hmac' });
  expect(changed).not.toBe(path);
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  const missing = JSON.parse(
    readFileSync(prepareContext({ ...input, node: 'review-m2-r3' }), 'utf8')
  );
  expect(missing.carry_over).toBe('unknown');
  const pointer = join(art, 'review-m2-r2.context.json');
  writeFileSync(pointer, JSON.stringify({ path }));
  sh('git -c user.name=t -c user.email=t@l commit --allow-empty -qm new', repo);
  const stale = Bun.spawnSync(
    [
      process.execPath,
      join(gen, '.archon/scripts/sa-context.ts'),
      join(gen, 'attempt'),
      gen,
      '',
      'review-m2-r2',
    ],
    {
      cwd: repo,
      env: { ...process.env, ARTIFACTS_DIR: art },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  expect(stale.exitCode).not.toBe(0);
  expect(stale.stderr.toString()).toContain('stale review refs');
  // Reproducible read-volume comparison on the same fixture, including complete requirements.
  const before =
    Buffer.byteLength(JSON.stringify(ledger)) +
    plan.packages.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)), 0);
  expect(Buffer.byteLength(bytes)).toBeLessThan(before);
  console.info(
    JSON.stringify({
      fixture: 'plan-two-pkgs R2',
      before_context_bytes: before,
      after_context_bytes: Buffer.byteLength(bytes),
      before_required_reads: plan.packages.length + 3,
      after_required_reads: 4,
      event_fetches: 'see generated CLI acceptance assertion',
      model_calls: 0,
      provider_elapsed_ms: 'unknown',
    })
  );
});

test('canonical owner resolves refs once from events and refuses missing producers', async () => {
  const art = tmp(),
    output = { head: 'immutable-ref' };
  const run = {
    id: 'r',
    user_message: '',
    metadata: {},
    events: [
      {
        step_name: 'start',
        event_type: 'node_completed',
        data: { node_output: JSON.stringify(output), structured_output: output },
      },
    ],
  };
  const contracts = [
    { tag: 'verify-core', base: '$start.output.head' },
    { tag: 'diff-m1-r1', base: '$start.output.head' },
  ];
  const resolved = await resolveAcceptanceContext(run, contracts, art);
  expect(resolved.inputs.map(i => i.base)).toEqual(['immutable-ref', 'immutable-ref']);
  expect(JSON.parse(readFileSync(resolved.events_file, 'utf8'))).toEqual({
    id: 'r',
    events: run.events,
  });
  await expect(resolveAcceptanceContext({ ...run, events: [] }, contracts, art)).rejects.toThrow();
  await expect(
    resolveAcceptanceContext({ ...run, events: undefined }, contracts, art)
  ).rejects.toThrow('missing authoritative');
});

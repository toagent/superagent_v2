import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptOutputFormat,
  conditionalOutput,
  deliveryOutputFormat,
  output,
  publishOutputFormat,
  ref,
  syncOutputFormat,
  type AcceptOutput,
  type DeliveryOutput,
  type SyncOutput,
} from '../src/contract';
import { assertGeneratedWorkflow, buildWorkflow } from '../src/generate';
import { loadTiers } from '../src/config';
import { milestones, type Plan } from '../src/plan';

const root = join(import.meta.dir, '..');

test('generated node contracts match their JSON schema owners', () => {
  expect(syncOutputFormat).toEqual(
    JSON.parse(readFileSync(join(root, 'schemas/nodes/sync.schema.json'), 'utf8'))
  );
  expect(publishOutputFormat).toEqual(
    JSON.parse(readFileSync(join(root, 'schemas/nodes/publish.schema.json'), 'utf8'))
  );
  expect(acceptOutputFormat).toEqual(
    JSON.parse(readFileSync(join(root, 'schemas/nodes/accept.schema.json'), 'utf8'))
  );
  expect(deliveryOutputFormat).toEqual(
    JSON.parse(readFileSync(join(root, 'schemas/nodes/delivery.schema.json'), 'utf8'))
  );
  const check = Bun.spawnSync([process.execPath, 'scripts/generate-node-contracts.ts', '--check'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(check.exitCode, check.stderr.toString()).toBe(0);
});

test('typed refs render required and skipped bindings', () => {
  const required = output<SyncOutput>('sync');
  const optional = conditionalOutput<SyncOutput>('maybe-sync');
  expect(ref.required(required, 'target_tip')).toBe('$sync.output.target_tip');
  expect(ref.optional(optional, 'generation', 0)).toEqual({
    from: '$maybe-sync.output.generation',
    if_skipped: 0,
  });
  expect(ref.required(output<DeliveryOutput>('settle'), 'diff_hash')).toBe(
    '$settle.output.diff_hash'
  );
  expect(ref.optional(conditionalOutput<AcceptOutput>('diff'), 'log', '')).toEqual({
    from: '$diff.output.log',
    if_skipped: '',
  });
});

test('the three invalid reference forms all fail TypeScript compilation', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      'x',
      'tsc',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'es2022',
      '--types',
      'bun-types',
      'tests/contract-negative.ts',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  );
  const diagnostics = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode).not.toBe(0);
  expect(diagnostics.match(/contract-negative\.ts\(\d+,\d+\): error TS/g)?.length).toBe(3);
  expect(diagnostics).toContain('OutputHandle<SyncOutput, true>');
  expect(diagnostics).toContain("string' is not assignable to parameter of type 'number");
  expect(diagnostics).toContain('missing_field');
});

test('generated workflows pass in-process validation and reject output refs in shell', () => {
  const plan = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/plan-two-pkgs.json'), 'utf8')
  ) as Plan;
  delete plan.packages[1]!.signoff;
  const workflow = buildWorkflow(
    plan,
    milestones(plan),
    'contract',
    '/GEN',
    false,
    Date.UTC(2026, 0, 1),
    loadTiers()
  );
  expect(() => assertGeneratedWorkflow(workflow)).not.toThrow();
  expect(() =>
    assertGeneratedWorkflow({
      name: 'invalid',
      description: 'invalid output reference',
      nodes: [{ id: 'bad', bash: 'test $sync.output.status = noop' }],
    })
  ).toThrow('generated bash contains an output reference: bad');
});

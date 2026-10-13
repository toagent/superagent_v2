import { expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workflowWaitContextSchema } from '../../packages/workflows/src/schemas/workflow-run';
import { tmp } from './helpers';

const repo = resolve(import.meta.dir, '../..');

test('old loop wait records remain valid without new private owner cursors', () => {
  const old = {
    owner: 'loop_group', nodeId: 'rounds', bodyWaitId: 'pause', iteration: 1,
    sessionId: null, sessionProvider: null, kind: 'time',
    resumeAt: '2026-10-10T00:00:00.000Z', waitingSince: '2026-10-09T00:00:00.000Z',
  };
  expect(workflowWaitContextSchema.parse(old)).toEqual(old);
  const current = { ...old, bodySessionCursors: {
    writer: { sessionId: 'private-owner', provider: 'codex' },
  } };
  expect(workflowWaitContextSchema.parse(current)).toEqual(current);
});

for (const name of ['deliver', 'pr']) {
  test(`${name} refuses before agents or Git/PR network writes, with manual commands`, () => {
    const path = join(repo, `.archon/workflows/sdlc/${name}/archon-${name}.yaml`);
    const workflow = Bun.YAML.parse(readFileSync(path, 'utf8')) as {
      nodes: { id: string; bash?: string; depends_on?: string[] }[];
    };
    const roots = workflow.nodes.filter(n => !n.depends_on?.length);
    expect(roots.map(n => n.id)).toEqual(['manual-network-only']);
    const root = roots[0];
    expect(root.bash).toBeDefined();
    const sandbox = tmp(), calls = join(sandbox, 'calls');
    for (const tool of ['git', 'gh', 'archon']) {
      const stub = join(sandbox, tool);
      writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$NETWORK_CALLS"\nexit 97\n');
      chmodSync(stub, 0o755);
    }
    writeFileSync(calls, '');
    const result = Bun.spawnSync(['/bin/bash', '-c', root.bash!], {
      cwd: sandbox, env: { PATH: sandbox, NETWORK_CALLS: calls },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('git push -u origin <reviewed-branch>');
    expect(result.stdout.toString()).toContain('gh pr create --draft');
    expect(readFileSync(calls, 'utf8')).toBe('');
  });
}

// Reuse the owners' behavioral tests in isolated processes: Bun mocks cannot
// share a process between provider-boundary and workflow execution suites.
for (const [pkg, args] of [
  ['workflows', ['src/dag-executor.test.ts', '-t', 'addressable session resume']],
  ['providers', ['src/launch-policy.test.ts', 'src/codex/scope.test.ts']],
  ['providers', ['src/claude/provider.test.ts', '-t', 'settingSources|workflow omission|exact native skill|strict MCP']],
] as const) {
  test(`upstream integration retains ${pkg} native contracts`, () => {
    const result = Bun.spawnSync([process.execPath, 'run', 'test', ...args], {
      cwd: join(repo, 'packages', pkg), stdout: 'pipe', stderr: 'pipe',
    });
    console.log(`${pkg} ${args.join(' ')}: exit=${result.exitCode}`);
    if (result.exitCode !== 0) console.error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  }, 60_000);
}

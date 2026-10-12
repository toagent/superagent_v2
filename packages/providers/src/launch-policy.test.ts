import { expect, test } from 'bun:test';
import {
  claudeLaunchPolicy,
  codexCliConfig,
  roleCommandArgs,
  workflowLaunchPolicy,
  type LaunchPolicy,
} from './launch-policy';

const policy: LaunchPolicy = {
  effort: 'high',
  readonly: true,
  codex: { 'features.multi_agent': false },
  deniedTools: ['Agent', 'Task', 'Write', 'Edit'],
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: { denyWrite: ['/'] },
  },
};

test('Claude readonly SDK and CLI translation keeps native guidance/auth and sandboxed Bash authorization', () => {
  const native = claudeLaunchPolicy(policy);
  expect(native).toMatchObject({
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    effort: 'high',
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/'] },
      network: { allowedDomains: [] },
    },
  });
  expect(native.disallowedTools).toEqual(
    expect.arrayContaining(['Agent', 'Task', 'Write', 'Edit', 'WebFetch', 'WebSearch'])
  );
  expect(native.disallowedTools).not.toContain('Bash');
  const workflow = workflowLaunchPolicy(policy, 'claude', '/readonly.json');
  expect(workflow.sandbox).toEqual(native.sandbox);
  expect(workflow.denied_tools).toEqual(native.disallowedTools);
  // No home, auth, instruction or setting-source override belongs to this contract.
  for (const key of ['env', 'settingSources', 'systemPrompt', 'apiKey'])
    expect(native).not.toHaveProperty(key);
  expect(workflowLaunchPolicy(policy, 'codex', '/readonly.json')).toEqual({
    effort: 'high',
    mcp: '/readonly.json',
  });
  for (const sandbox of [
    undefined,
    { enabled: false },
    { ...policy.sandbox, allowUnsandboxedCommands: true },
  ])
    expect(() => claudeLaunchPolicy({ ...policy, sandbox })).toThrow('fail-closed sandbox');
});

test('policy overrides and unsupported commands fail before native inventory or launch', () => {
  for (const args of [
    ['exec', '-c', 'features.multi_agent=true'],
    ['exec', '--sandbox', 'danger-full-access'],
    ['exec', '--yolo'],
    ['exec', '--profile', 'unsafe'],
    ['exec', '-m', 'other'],
    ['exec', '-m', 'fixture', '--model=fixture'],
    ['exec', 'prompt', '--yolo'],
    ['app-server'],
  ])
    expect(() => roleCommandArgs(['codex', ...args], 'codex', 'fixture')).toThrow();
  for (const args of [
    ['-p', '--permission-mode', 'auto'],
    ['-p', '--settings', '{}'],
    ['-p', '--plugin-dir', '/tmp'],
    ['-p', '--mcp-config', '/tmp'],
    ['-p', '--effort', 'low'],
  ])
    expect(() => roleCommandArgs(['claude', ...args], 'claude', 'fixture')).toThrow();
  expect(
    roleCommandArgs(['codex', 'exec', '--json', '-o', '/tmp/result', 'prompt'], 'codex', 'fixture')
  ).toEqual(['exec', '--model', 'fixture', '--json', '-o', '/tmp/result', 'prompt']);
});

test('Codex CLI scopes serialize as real TOML leaves, including quoted server identifiers', () => {
  const args = codexCliConfig({
    features: { multi_agent: false, apps: false, plugins: false },
    skills: { include_instructions: false },
    mcp_servers: { 'ambient.with.dots': { enabled: false } },
  });
  const assignments = args.filter((_, i) => i % 2 === 1);
  const parsed = Bun.TOML.parse(assignments.join('\n'));
  expect(parsed).toEqual({
    features: { multi_agent: false, apps: false, plugins: false },
    skills: { include_instructions: false },
    mcp_servers: { 'ambient.with.dots': { enabled: false } },
  });
});

test('native CLI scope guard rejects undeclared plugins or output before init', async () => {
  const result = { type: 'result', is_error: false, result: 'model-output' };
  for (const plugins of [[], [{ name: 'ambient', source: 'ambient@fixture' }], null]) {
    const events =
      plugins === null ? [result] : [{ type: 'system', subtype: 'init', plugins }, result];
    const command = [
      process.execPath,
      '-e',
      `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))`,
    ];
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./launch-policy-cli.ts', import.meta.url).pathname,
        'text',
        JSON.stringify(command),
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(plugins?.length === 0 ? 0 : 1);
    expect(stdout).toBe(plugins?.length === 0 ? 'model-output\n' : '');
    if (exit) expect(stderr).toContain(plugins ? 'does not match' : 'before reporting');
  }
});

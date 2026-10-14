import { expect, spyOn, test } from 'bun:test';
import { AppServerConnection } from './codex/app-server';
import {
  claudeLaunchPolicy,
  codexCliConfig,
  prepareRoleCommand,
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
      filesystem: { denyWrite: ['/'], disabled: false },
      network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true },
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
    { ...policy.sandbox, filesystem: { denyWrite: ['/'], disabled: true } },
  ])
    expect(() => claudeLaunchPolicy({ ...policy, sandbox })).toThrow('fail-closed sandbox');
});

test('readonly policy denies native domain grants and overrides native live Codex search', async () => {
  const native = claudeLaunchPolicy({
    ...policy,
    sandbox: { ...policy.sandbox, network: { allowedDomains: ['native.example'] } },
  });
  // SDK merges native grants, but deniedDomains always wins over allowedDomains.
  expect(native.sandbox?.network).toMatchObject({
    deniedDomains: ['*'],
    strictAllowlist: true,
  });
  expect(native.sandbox?.filesystem?.disabled).toBe(false);
  const inventory = spyOn(AppServerConnection, 'start').mockReturnValue({
    request: async (method: string) =>
      method === 'config/read'
        ? {
            config: {
              web_search: 'live',
              mcp_servers: { 'ambient.with.dots@fixture/path name': {} },
            },
          }
        : {},
    notify() {},
    async shutdown() {},
  } as unknown as AppServerConnection);
  try {
    for (const readonly of [true, false]) {
      const args = await prepareRoleCommand(
        ['codex', 'exec', 'fixture'],
        'codex',
        'fixture',
        { ...policy, readonly, codex: { ...policy.codex, web_search: 'live' } },
        process.cwd()
      );
      const assignments = args.flatMap((arg, i) => (arg === '-c' ? [args[i + 1]] : []));
      // CLI paths are split on dots, not parsed as TOML: quoted paths would be ignored.
      expect(assignments).toContain('approval_policy="never"');
      expect(assignments).toContain(
        `sandbox_mode="${readonly ? 'read-only' : 'danger-full-access'}"`
      );
      // R1-1: the production profile's early dotted key still needs a final role override.
      expect(assignments[0]).toBe('features.multi_agent=false');
      expect(assignments.at(-1)).toBe('features.multi_agent=false');
      expect(assignments.every(a => /^[A-Za-z0-9_.-]+=/.test(a))).toBe(true);
      // Each -c is applied separately; a TOML document cannot extend an inline table.
      const tables = assignments.filter(a => !a.startsWith('features.multi_agent='));
      expect(Bun.TOML.parse(tables.join('\n'))).toMatchObject({
        web_search: readonly ? 'disabled' : 'live',
      });
      expect(inventory).not.toHaveBeenCalled();
      expect(assignments.some(a => /^(mcp_servers|skills|plugins|features.apps)/.test(a))).toBe(
        false
      );
    }
  } finally {
    inventory.mockRestore();
  }
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

test('Codex CLI uses bare policy paths and inline tables for literal capability identifiers', () => {
  const id = 'ambient.with.dots@fixture/path name';
  const args = codexCliConfig({
    features: { multi_agent: false, apps: false, plugins: false },
    skills: { include_instructions: false },
    mcp_servers: { [id]: { enabled: false } },
    plugins: { [id]: { enabled: true, mcp_servers: { [id]: { enabled: false } } } },
    values: { text: 'quote" slash\\ newline\n', list: ['literal.with.dots', true, 1.5], empty: {} },
  });
  const assignments = args.filter((_, i) => i % 2 === 1);
  expect(assignments[0]).toBe(
    'features={"multi_agent" = false, "apps" = false, "plugins" = false}'
  );
  expect(assignments[2]).toBe(`mcp_servers={"${id}" = {"enabled" = false}}`);
  const parsed = Bun.TOML.parse(assignments.join('\n'));
  expect(parsed).toEqual({
    features: { multi_agent: false, apps: false, plugins: false },
    skills: { include_instructions: false },
    mcp_servers: { [id]: { enabled: false } },
    plugins: { [id]: { enabled: true, mcp_servers: { [id]: { enabled: false } } } },
    values: { text: 'quote" slash\\ newline\n', list: ['literal.with.dots', true, 1.5], empty: {} },
  });
});

test('Codex CLI rejects unsupported values and ambiguous CLI paths instead of falling back', () => {
  for (const value of [null, undefined, NaN, Infinity, 2 ** 53, new Date(), () => {}, [undefined]])
    expect(() => codexCliConfig({ value })).toThrow('unsupported Codex config value');
  for (const key of ['"sandbox_mode"', 'plugins.name@fixture', 'mcp_servers.a/b', 'features..apps'])
    expect(() => codexCliConfig({ [key]: false })).toThrow('unsupported Codex config path');
});

test('native CLI keeps ambient plugins and forwards model output', async () => {
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
        '--job-input',
      ],
      { stdin: new Blob(['registered input']), stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toBe('model-output\n');
    expect(stderr).toBe('');
  }
});

test('Claude wrapper forwards finite input only when explicitly requested', async () => {
  const bytes = 'registered\r\n输入\u0000without trailing newline';
  for (const forward of [true, false]) {
    const command = [
      process.execPath,
      '-e',
      `
      const input = await Bun.stdin.text();
      const again = await Bun.stdin.text();
      console.log(JSON.stringify({ type: 'system', subtype: 'init', plugins: [] }));
      console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ input, again }) }));
    `,
    ];
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('./launch-policy-cli.ts', import.meta.url).pathname,
        'text',
        JSON.stringify(command),
        ...(forward ? ['--job-input'] : []),
      ],
      {
        stdin: forward ? new Blob([bytes]) : 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ input: forward ? bytes : '', again: '' });
  }
});

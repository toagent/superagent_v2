import { expect, test } from 'bun:test';
import {
  claudeLaunchPolicy,
  codexCliConfig,
  prepareRoleCommand,
  roleCommandArgs,
  workflowLaunchPolicy,
  type LaunchPolicy,
} from './launch-policy';

const policy: LaunchPolicy = { effort: 'high', codex: {} };

test('review CLI and workflow allow test writes without replacing native guidance/auth', async () => {
  const native = claudeLaunchPolicy(policy);
  expect(native).toEqual({
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    effort: 'high',
  });
  for (const provider of ['claude', 'codex'] as const)
    expect(workflowLaunchPolicy(policy, provider)).toEqual({ effort: 'high' });
  for (const key of ['env', 'settingSources', 'systemPrompt', 'apiKey'])
    expect(native).not.toHaveProperty(key);
  const claude = await prepareRoleCommand(
    ['claude', '-p', 'fixture'],
    'claude',
    'fixture',
    policy,
    process.cwd()
  );
  const command = JSON.parse(claude[3]) as string[];
  expect(command[command.indexOf('--settings') + 1]).toBe('{}');
  expect(command[command.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  const args = await prepareRoleCommand(
    ['codex', 'exec', 'fixture'],
    'codex',
    'fixture',
    { ...policy, codex: { web_search: 'live' } },
    process.cwd()
  );
  expect(args).toContain('sandbox_mode="danger-full-access"');
  expect(args).toContain('web_search="live"');
  expect(args).toContain('approval_policy="never"');
  expect(args.some(a => /^(mcp_servers|skills|plugins|features.apps)=/.test(a))).toBe(false);
});

test('explicit native sandbox configuration is preserved', () => {
  const sandbox = { enabled: true, filesystem: { denyWrite: ['/fixture'] } };
  expect(claudeLaunchPolicy({ ...policy, sandbox }).sandbox).toEqual(sandbox);
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

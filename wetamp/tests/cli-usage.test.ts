import { expect, test } from 'bun:test';
import {
  allUsage,
  CLI_COMMAND_USAGE,
  CLI_GLOBAL_OPTIONS,
  OPTIONS,
  parseArgs,
  probeOptions,
  USAGE,
} from '../src/cli';

test('engine probe parses legacy, console, scenario and matrix options', () => {
  const probe = (...args: string[]) => probeOptions(parseArgs(['engine', 'probe', ...args]));
  expect(probe('G2')).toBeUndefined();
  expect(probe('G2', '--console', 'codex')).toMatchObject({ level: 'G2', console: 'codex' });
  expect(probe('--scenario', 'repair')).toMatchObject({
    level: 'G1',
    console: 'claude',
    scenario: 'repair',
  });
  expect(probe('--matrix', '--parallel', '2')).toMatchObject({ matrix: true, parallel: 2 });
  for (const args of [
    ['--scenario', ''],
    ['--scenario', 'outage'],
    ['--console', 'other'],
    ['--matrix', '--console', 'codex'],
    ['--parallel', '1'],
    ['--matrix', '--parallel', '0'],
    ['G3', '--matrix'],
    ['G1', 'extra', '--matrix'],
  ])
    expect(() => probe(...args)).toThrow();
});

test('CLI usage and parser options cover each other', () => {
  const parserOptions = Object.keys(OPTIONS);
  const documented = new Set<string>([
    ...CLI_GLOBAL_OPTIONS,
    ...CLI_COMMAND_USAGE.flatMap(command => command.flags),
    ...CLI_COMMAND_USAGE.flatMap(command => command.operatorFlags ?? []),
  ]);

  for (const flag of documented) expect(parserOptions).toContain(flag);
  expect([...documented].sort()).toEqual(parserOptions.sort());
});

test('CLI usage separates agent and operator surfaces', () => {
  const lines = USAGE.split('\n');
  const find = (values: string[], command: string): string | undefined =>
    values.find(value => value === `  ${command}` || value.startsWith(`  ${command} `));
  expect(lines[0]).toBe('usage: superagent <command> [options]');
  // 文档行是检出绝对路径，长度随检出位置变化（候选复验检出比主检出长），不计入预算。
  const budgeted = lines.filter(line => !line.startsWith('  文档：')).join('\n');
  expect(lines.length - budgeted.split('\n').length).toBe(1);
  // 加入 merge 后帮助文本为 2282 字节，2300 字节的预算留出约 18 字节余量。
  expect(Buffer.byteLength(budgeted)).toBeLessThanOrEqual(2300);
  for (const entry of CLI_COMMAND_USAGE) {
    const line = find(lines, entry.command);
    if (entry.audience === 'operator') expect(line).toBeUndefined();
    else {
      expect(line).toBeDefined();
      for (const flag of entry.flags) expect(line).toContain(`--${flag}`);
      for (const flag of entry.operatorFlags ?? []) expect(line).not.toContain(`--${flag}`);
    }
  }

  const full = allUsage().split('\n');
  for (const entry of CLI_COMMAND_USAGE) {
    const line = find(full, entry.command);
    expect(line).toBeDefined();
    for (const flag of [...entry.flags, ...(entry.operatorFlags ?? [])])
      expect(line).toContain(`--${flag}`);
  }
});

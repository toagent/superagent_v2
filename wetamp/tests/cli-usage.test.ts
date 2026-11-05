import { expect, test } from 'bun:test';
import { allUsage, CLI_COMMAND_USAGE, CLI_GLOBAL_OPTIONS, OPTIONS, USAGE } from '../src/cli';

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
  expect(Buffer.byteLength(USAGE)).toBeLessThanOrEqual(2300);
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

import { expect, test } from 'bun:test';
import { CLI_COMMAND_USAGE, CLI_GLOBAL_OPTIONS, OPTIONS, USAGE } from '../src/cli';

test('CLI usage and parser options cover each other', () => {
  const parserOptions = Object.keys(OPTIONS);
  const documented = new Set<string>([
    ...CLI_GLOBAL_OPTIONS,
    ...CLI_COMMAND_USAGE.flatMap(command => command.flags),
  ]);

  for (const flag of documented) expect(parserOptions).toContain(flag);
  expect([...documented].sort()).toEqual(parserOptions.sort());
});

test('CLI usage renders one line for every command', () => {
  const lines = USAGE.split('\n');
  expect(lines[0]).toBe('usage: superagent <command> [options]');
  expect(lines.slice(1, -1)).toHaveLength(CLI_COMMAND_USAGE.length);

  CLI_COMMAND_USAGE.forEach(({ command, positionals, flags }, index) => {
    const line = lines[index + 1];
    expect(line).toStartWith(`  ${command}${positionals ? ` ${positionals}` : ''}`);
    for (const flag of flags) expect(line).toContain(`--${flag}`);
  });
});

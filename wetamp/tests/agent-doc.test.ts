import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CLI_COMMAND_USAGE, CLI_GLOBAL_OPTIONS } from '../src/cli';
import { INTAKE_USAGE } from '../src/intake';

const doc = readFileSync(join(import.meta.dir, '../docs/agent.md'), 'utf8');

function snippets(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of markdown.split('\n')) {
    const command = line.trim();
    if (command.startsWith('superagent ')) found.add(command);
    for (const match of line.matchAll(/`(superagent [^`\n]+)`/g)) found.add(match[1]);
  }
  return [...found];
}

describe('agent reference', () => {
  test('documents only registered commands and flags', () => {
    const entries = [...CLI_COMMAND_USAGE].sort((a, b) => b.command.length - a.command.length);
    const intakeCommands = INTAKE_USAGE.slice('intake '.length).split('|');

    for (const snippet of snippets(doc)) {
      if (snippet.startsWith('superagent --help')) continue;
      const entry = entries.find(({ command }) => {
        const prefix = `superagent ${command}`;
        return snippet === prefix || snippet.startsWith(`${prefix} `);
      });
      expect(entry, `unknown command in: ${snippet}`).toBeDefined();
      if (!entry) continue;

      if (entry.command === 'intake') {
        const action = snippet.split(/\s+/)[2];
        expect(intakeCommands, `unknown intake action in: ${snippet}`).toContain(action);
      }

      const allowed = new Set<string>([
        ...CLI_GLOBAL_OPTIONS,
        ...entry.flags,
        ...(entry.operatorFlags ?? []),
      ]);
      for (const flag of snippet.match(/--[a-z][a-z0-9-]*/g) ?? []) {
        expect(allowed, `unknown flag ${flag} in: ${snippet}`).toContain(flag.slice(2));
      }
    }
  });
});

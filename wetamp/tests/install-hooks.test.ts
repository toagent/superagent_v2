import { expect, test } from 'bun:test';
import { WETAMP } from '../src/config';
import { mergeHooks } from '../src/install-hooks';

test('Codex context advisory hooks are complete and idempotent', () => {
  const once = mergeHooks({}, 'codex'),
    command = `node '${WETAMP}/hooks/context-advisory.cjs' codex`;
  for (const event of ['UserPromptSubmit', 'PreToolUse'])
    expect(
      once[event].flatMap(group => group.hooks ?? []).filter(hook => hook.command === command)
    ).toHaveLength(1);
  expect(mergeHooks(once, 'codex')).toEqual(once);
});

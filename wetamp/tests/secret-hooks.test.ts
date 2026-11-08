import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmp } from './helpers';
const require = createRequire(import.meta.url);
const guard = require('../hooks/guard.cjs') as {
  decide: (payload: Record<string, unknown>, client: string, env: NodeJS.ProcessEnv) => any;
};
// prettier-ignore
const scanner = () => { const file = `${tmp()}/scan.cjs`; writeFileSync(file, `exports.scanText = text => text.replaceAll('synthetic-secret-value', '[REDACTED:test]');`); return file; };
test('shell commands are wrapped once for Claude and Codex', async () => {
  await require('../hooks/redline.cjs').init();
  const env = { ...process.env, SA_SECRET_SCAN_MODULE: scanner() };
  // prettier-ignore
  const payload = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() });
  const claude = guard.decide(payload('echo ok'), 'claude', env);
  expect(claude.hookSpecificOutput.updatedInput.command).toStartWith(
    '. ~/.wetamp/jail/sa-redact.sh;'
  );
  const wrapped = claude.hookSpecificOutput.updatedInput.command;
  expect(
    guard.decide(payload(wrapped), 'codex', env)?.hookSpecificOutput?.updatedInput
  ).toBeUndefined();
  const codex = guard.decide(payload('echo ok'), 'codex', env);
  expect(codex.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
  expect(codex.hookSpecificOutput.updatedInput.command).toStartWith(
    '. ~/.wetamp/jail/sa-redact.sh;'
  );
  // A prefix that is not leading (comment, string) must not opt the command out.
  const comment = `# . ~/.wetamp/jail/sa-redact.sh;\necho ok`;
  expect(
    guard.decide(payload(comment), 'claude', env).hookSpecificOutput.updatedInput.command
  ).toStartWith('. ~/.wetamp/jail/sa-redact.sh;');
});
test('an uninstalled firewall stays inert instead of hiding output or blocking prompts', async () => {
  await require('../hooks/redline.cjs').init();
  const env = { ...process.env, HOME: tmp(), SA_SECRET_SCAN_MODULE: '' };
  // prettier-ignore
  const pre = guard.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: process.cwd() }, 'claude', env);
  expect(pre?.hookSpecificOutput?.updatedInput).toBeUndefined();
  expect(
    guard.decide({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, 'claude', env)
  ).toBeNull();
});
test('derived sessions redact non-shell output and block secret prompts', () => {
  const env = { ...process.env, SUPERAGENT_ROLE: 'general', SA_SECRET_SCAN_MODULE: scanner() };
  // prettier-ignore
  const post = guard.decide({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: { data: ['synthetic-secret-value'] } }, 'claude', env);
  expect(post.hookSpecificOutput.updatedToolOutput).toEqual({ data: ['[REDACTED:test]'] });
  const prompt = guard.decide(
    { hook_event_name: 'UserPromptSubmit', prompt: 'synthetic-secret-value' },
    'claude',
    env
  );
  expect(prompt).toMatchObject({
    decision: 'block',
    hookSpecificOutput: { suppressOriginalPrompt: true },
  });
});

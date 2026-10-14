import { expect, test } from 'bun:test';

// Capture during module loading: isolation must precede fixtures and test hooks.
const identity = [
  process.env.SUPERAGENT_ROLE,
  process.env.SA_JOB_ID,
  process.env.SA_JOB_CARD,
  process.env.SA_JOB_REQUEST_REF,
  process.env.AI_DISPATCH_ROLE,
  process.env.TWIN_AGENT_REMOTE,
];

test('test preload clears inherited derived identities before module loading', () => {
  expect(identity).toEqual(['', '', '', '', '', '']);
});

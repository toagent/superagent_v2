import { expect, test } from 'bun:test';
import { CLASSIFIED_HOLD_REASONS, reasonOf } from '../src/reasons';

test('every classify held state resolves to a registered reason', () => {
  for (const [hold, code] of Object.entries(CLASSIFIED_HOLD_REASONS))
    expect(reasonOf(code), `held:${hold} -> ${code}`).toBeDefined();
  expect(reasonOf('definitely_unknown_reason')).toBeUndefined();
});

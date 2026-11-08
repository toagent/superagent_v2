import { expect, test } from 'bun:test';
import { validateWorktreePostCreate } from './post-create-config';

test('validates postCreate commands and timeout at the owning config boundary', () => {
  expect(() => validateWorktreePostCreate(undefined)).not.toThrow();
  expect(() =>
    validateWorktreePostCreate({ postCreate: ['echo ready'], postCreateTimeout: 1 })
  ).not.toThrow();
  for (const config of [
    { postCreate: [''] },
    { postCreate: ['ok', '   '] },
    { postCreateTimeout: 0 },
    { postCreateTimeout: 1.5 },
  ]) {
    expect(() => validateWorktreePostCreate(config)).toThrow('worktree.postCreate');
  }
});

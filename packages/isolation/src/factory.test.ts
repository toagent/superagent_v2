import { describe, test, expect, afterEach } from 'bun:test';
import { getIsolationProvider, resetIsolationProvider, configureIsolation } from './factory';

describe('Isolation Provider Factory', () => {
  afterEach(() => {
    resetIsolationProvider();
  });

  test('getIsolationProvider returns same instance on repeated calls', () => {
    const first = getIsolationProvider();
    const second = getIsolationProvider();
    expect(first).toBe(second);
  });

  test('resetIsolationProvider clears singleton so next call returns new instance', () => {
    const first = getIsolationProvider();
    resetIsolationProvider();
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });

  test('configureIsolation resets singleton', () => {
    const first = getIsolationProvider();
    const executor = async (): Promise<void> => undefined;
    configureIsolation(async () => null, executor);
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
    expect(second).toHaveProperty('setupExecutor', executor);
  });

  test('provider type is worktree', () => {
    const provider = getIsolationProvider();
    expect(provider.providerType).toBe('worktree');
  });
});

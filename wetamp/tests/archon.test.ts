import { expect, spyOn, test } from 'bun:test';
import * as transport from '../src/archon';

test('native wait enforces bounded transport and rejects broken notifications', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
    exitCode: 3, stdout: Buffer.from(JSON.stringify({ ok: true, action: 'wait', runId: 'r',
      result: 'deadline', observedStatus: 'running' })), stderr: Buffer.from('attached'),
  } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(transport.waitNotification('r', '/tmp', 60)).toBe('deadline');
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ timeout: 60_000 + transport.QUERY_TIMEOUT_MS });
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['wait', '--timeout', '60']));
    expect(transport.waitNotification('r', '/tmp', 0.1251)).toBe('deadline');
    expect(spawn.mock.calls[1]?.[1]).toMatchObject({ timeout: 126 + transport.QUERY_TIMEOUT_MS });
    expect(spawn.mock.calls[1]?.[0]).toEqual(expect.arrayContaining(['--timeout', '0.1251']));
    for (const seconds of [0, -1, NaN, Infinity, Number.MAX_VALUE])
      expect(() => transport.waitNotification('r', '/tmp', seconds)).toThrow('positive finite');
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const result of ['attention', 'owner_lost', 'aborted', 'not_found']) {
      spawn.mockReturnValue({ exitCode: 0, stdout: Buffer.from(JSON.stringify({
        ok: true, action: 'wait', runId: 'r', result,
      })), stderr: Buffer.alloc(0) } as ReturnType<typeof Bun.spawnSync>);
      if (result === 'aborted' || result === 'not_found')
        expect(() => transport.waitNotification('r', '/tmp', 60)).toThrow(result);
      else expect(transport.waitNotification('r', '/tmp', 60)).toBe(result);
    }
    spawn.mockReturnValue({ exitCode: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)
    } as ReturnType<typeof Bun.spawnSync>);
    expect(() => transport.waitNotification('r', '/tmp', 60)).toThrow('timed out after 180s');
    spawn.mockReturnValue({ exitCode: 1, stdout: Buffer.from('{"ok":false,"error":"not_found"}'),
      stderr: Buffer.alloc(0) } as ReturnType<typeof Bun.spawnSync>);
    expect(() => transport.waitNotification('r', '/tmp', 1)).toThrow('not_found');
  } finally { spawn.mockRestore(); }
});

test('wait transport allows cold startup and shutdown beyond the former one-second margin', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation((cmd, options) => {
    const args = cmd as string[];
    const nativeMs = Number(args[args.indexOf('--timeout') + 1]) * 1000;
    // Deterministic lifecycle simulation: no real sleep or run mutation.
    const requiredMs = 2500 + nativeMs + 2500;
    const timedOut = Number(options?.timeout) < requiredMs;
    return { exitCode: timedOut ? -1 : 3, stdout: Buffer.from(timedOut ? '' : JSON.stringify({
      ok: true, action: 'wait', runId: 'r', result: 'deadline', observedStatus: 'running',
    })), stderr: Buffer.alloc(0) } as ReturnType<typeof Bun.spawnSync>;
  });
  try {
    expect(transport.waitNotification('r', '/tmp', 60)).toBe('deadline');
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally { spawn.mockRestore(); }
});

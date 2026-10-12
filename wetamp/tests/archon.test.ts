import { expect, spyOn, test } from 'bun:test';
import * as transport from '../src/archon';

test('native wait enforces bounded transport and rejects broken notifications', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({
    exitCode: 3, stdout: Buffer.from(JSON.stringify({ ok: true, action: 'wait', runId: 'r',
      result: 'deadline', observedStatus: 'running' })), stderr: Buffer.from('attached'),
  } as ReturnType<typeof Bun.spawnSync>);
  try {
    expect(transport.waitNotification('r', '/tmp', 60)).toBe('deadline');
    expect(spawn.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(['wait', '--timeout', '29']));
    spawn.mockReturnValue({ exitCode: 1, stdout: Buffer.from('{"ok":false,"error":"not_found"}'),
      stderr: Buffer.alloc(0) } as ReturnType<typeof Bun.spawnSync>);
    expect(() => transport.waitNotification('r', '/tmp', 1)).toThrow('not_found');
  } finally { spawn.mockRestore(); }
});

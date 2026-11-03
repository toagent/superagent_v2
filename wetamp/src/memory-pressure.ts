import { freemem, totalmem } from 'node:os';

export interface MemoryReading {
  pressure: number | null;
  free: number;
  source: 'sysctl' | 'os';
}

/** macOS 内核信号；不可读时显式退回 os，绝不把未知压力伪装成 normal。 */
export function memoryReading(
  sysctl = (): number[] => {
    const p = Bun.spawnSync(
      ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level', 'kern.memorystatus_level'],
      { stderr: 'ignore' }
    );
    if (p.exitCode !== 0) throw new Error('sysctl unavailable');
    return p.stdout.toString().trim().split(/\s+/).map(Number);
  },
  available = (): number => (freemem() / totalmem()) * 100
): MemoryReading {
  try {
    const [pressure, free] = sysctl();
    if (![1, 2, 4].includes(pressure) || !Number.isFinite(free) || free < 0 || free > 100)
      throw new Error('invalid sysctl reading');
    return { pressure, free, source: 'sysctl' };
  } catch {
    return { pressure: null, free: available(), source: 'os' };
  }
}

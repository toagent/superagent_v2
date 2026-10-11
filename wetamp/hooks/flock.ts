// Node retains the open file description passed as fd 3. The kernel lock therefore
// survives this helper's exit and is released only when Node closes its own fd.
import { dlopen, FFIType, read, type Pointer } from 'bun:ffi';
const darwin = process.platform === 'darwin';
const errnoName = darwin ? '__error' : '__errno_location';
const libc = dlopen(darwin ? 'libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  [errnoName]: { args: [], returns: FFIType.ptr },
});
const end = Date.now() + 5000;
while (libc.symbols.flock(3, 2 | 4) !== 0) {
  const errno = read.i32(libc.symbols[errnoName]() as Pointer);
  if (errno !== (darwin ? 35 : 11)) throw new Error(`flock errno ${String(errno)}`);
  if (Date.now() >= end) process.exit(2);
  Bun.sleepSync(20);
}

import { exactPatterns, scanText } from './scan';

const patterns = exactPatterns();
let buffer = '',
  failed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const safeLength = (): number => {
  let held = 0;
  for (const { value } of patterns)
    for (let n = Math.min(value.length - 1, buffer.length); n > held; n--)
      if (value.startsWith(buffer.slice(-n))) {
        held = n;
        break;
      }
  return buffer.length - held;
};
const flush = (all = false): void => {
  if (failed || !buffer) return;
  const length = all ? buffer.length : safeLength();
  if (!length) return;
  const value = buffer.slice(0, length);
  buffer = buffer.slice(length);
  try {
    process.stdout.write(scanText(value));
  } catch {
    failed = true;
    buffer = '';
    process.stdout.write('[REDACTED:scan_failed]');
  }
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (failed) return;
  buffer += String(chunk);
  const newline = buffer.lastIndexOf('\n');
  if (newline >= 0) {
    const rest = buffer.slice(newline + 1);
    buffer = buffer.slice(0, newline + 1);
    flush(true);
    buffer = rest;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    flush(false);
  }, 50);
});
process.stdin.on('end', () => {
  clearTimeout(timer);
  flush(true);
});
process.stdin.on('error', () => {
  if (!failed) process.stdout.write('[REDACTED:scan_failed]');
});

import { writeFileSync } from 'node:fs';
import { exactPatterns, scanText } from './scan';

const sentinel = process.env.SA_REDACT_SENTINEL ? `${process.env.SA_REDACT_SENTINEL}\n` : '';
const patterns = [...exactPatterns(), ...(sentinel ? [{ name: 'sentinel', value: sentinel }] : [])];
const acknowledge = (): void => {
  if (process.env.SA_REDACT_ACK) writeFileSync(process.env.SA_REDACT_ACK, '');
};
let buffer = '',
  failed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
// prettier-ignore
const safeLength = (): number => {
  let held = 0;
  for (const { value } of patterns) for (let n = Math.min(value.length - 1, buffer.length); n > held; n--) if (value.startsWith(buffer.slice(-n))) { held = n; break; }
  return buffer.length - held;
};
// prettier-ignore
const flush = (all = false): void => {
  if (failed || !buffer) return;
  const length = all ? buffer.length : safeLength(); if (!length) return;
  const value = buffer.slice(0, length); buffer = buffer.slice(length);
  try { process.stdout.write(scanText(value, { keyValues: false })); } catch { failed = true; buffer = ''; process.stdout.write('[REDACTED:scan_failed]'); }
};
// prettier-ignore
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (failed) return;
  buffer += String(chunk);
  if (sentinel) {
    let marker;
    while ((marker = buffer.indexOf(sentinel)) >= 0) {
      const rest = buffer.slice(marker + sentinel.length);
      buffer = buffer.slice(0, marker);
      flush(true);
      acknowledge();
      buffer = rest;
    }
  }
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

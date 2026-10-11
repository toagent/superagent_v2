import { lastJson } from '../src/archon';

/** CLI exit zero alone is not a stopped run. Any incomplete cleanup preserves trees. */
export function stopReceiptSafe(text: string): boolean {
  const d = lastJson(text);
  return d?.ok === true && d.status === 'cancelled' &&
    (d.action === 'abandon' || d.action === 'cancel') &&
    ['cleanupWarnings', 'warnings'].every(key => d[key] === undefined ||
      (Array.isArray(d[key]) && d[key].length === 0)) &&
    (d.cascadeFailures === undefined || d.cascadeFailures === 0) &&
    !d.blockedParentRunId;
}

if (import.meta.main) process.exit(stopReceiptSafe(await Bun.file(process.argv[2]).text()) ? 0 : 1);

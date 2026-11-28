import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Kind } from './jobs';

export const { agyTranscript } = createRequire(import.meta.url)(
  '../hooks/context-advisory.cjs'
) as {
  agyTranscript: (file: string | null) => string | null;
};

/** One naming rule for board, usage and Web. Missing models stay missing. */
// prettier-ignore
export function shortModel(model?: string | null, compact = false): string {
  if (!model || model === 'unknown') return '';
  const clean = model.replace(/\(pinned\)$/, '').replace(/^(anthropic\/|openai\/)/, '').replace(/^(claude-|gpt-)/, '');
  const gemini = /^gemini-4-(neon|carbon|hydrogen|argon)(?:-(.+))?$/.exec(clean);
  if (gemini) {
    const [, name, effort] = gemini;
    return compact || !effort ? name : `${name}-${effort.replace(/^%(78|68|6d|6c)/i, decodeURIComponent)}`;
  }
  const family = /(?:^|-)(opus|fable|haiku|sonnet|sol|astra|qwen)(?=[\d.-]|$)/i.exec(clean);
  if (family) {
    const name = family[1].toLowerCase();
    const version = clean.replace(family[0], '').replace(/^-|-$/g, '').replaceAll('-', '.');
    return compact || name === 'astra' ? name : `${name}${version}`;
  }
  const unknown = clean.split('/').pop() ?? clean;
  let out = '';
  for (const c of unknown) { if (Bun.stringWidth(out + c) > 10) break; out += c; }
  return out;
}

/** Read a bounded tail and return only vendor metadata, never message contents. */
// prettier-ignore
export function sessionModel(file: string | null, kind: Kind): string | null {
  if (kind === 'agy') return agyPlanner(file)?.model ?? null;
  if (!file) return null;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, len = Math.min(size, 65536), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();
    for (const line of lines.reverse()) {
      try {
        const e = JSON.parse(line) as { type?: string; message?: { model?: unknown }; payload?: { model?: unknown } };
        const m = kind === 'claude' && e.type === 'assistant' ? e.message?.model : kind === 'codex' && e.type === 'turn_context' ? e.payload?.model : null;
        if (typeof m === 'string') return m;
      } catch { /* Partial JSONL lines carry no usable metadata. */ }
    }
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

export function agyPlanner(path: string | null) {
  const file = agyTranscript(path);
  if (!file) return null;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const buf = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const start = stat.size - buf.length;
    const lines = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, start)).split('\n');
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let event: Record<string, unknown> | null;
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event?.type !== 'PLANNER_RESPONSE') continue;
      const count = (n: unknown) =>
        Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : undefined;
      return {
        model: typeof event.model === 'string' && event.model ? event.model : null,
        at: new Date(stat.mtimeMs).toISOString(),
        input: count(event.input_tokens),
        cacheRead: count(event.cache_read_tokens),
        output: count(event.output_tokens),
        reasoning: count(event.thinking_tokens),
      };
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export { nativeEvidence } from '../templates/.archon/scripts/native-models';

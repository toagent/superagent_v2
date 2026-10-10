import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Kind } from './jobs';

/** One naming rule for board, usage and Web. Missing models stay missing. */
export function shortModel(model?: string | null, compact = false): string {
  if (!model || model === 'unknown') return '';
  const clean = model.replace(/\(pinned\)$/, '').replace(/^(anthropic\/|openai\/)/, '').replace(/^(claude-|gpt-)/, '');
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
export function sessionModel(file: string | null, kind: Kind): string | null {
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

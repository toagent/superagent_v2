import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Kind } from './jobs';

/** One naming rule for board, usage and Web. Missing models stay missing. */
// prettier-ignore
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
// prettier-ignore
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

/** Full native metadata for legacy admission; message bytes are compared, never logged. */
export function nativeEvidence(text: string, kind: Kind) {
  const models = new Set<string>(),
    sessions = new Set<string>();
  let final = '',
    inputs = '';
  for (const line of text.split('\n').filter(Boolean)) {
    const e = JSON.parse(line) as {
      type?: string;
      sessionId?: string;
      message?: { model?: string; content?: { type: string; text?: string }[] | string };
      payload?: { id?: string; model?: string; role?: string; content?: { text?: string }[] };
    };
    if (kind === 'claude') {
      if (e.sessionId) sessions.add(e.sessionId);
      if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>')
        models.add(e.message.model);
      const content = e.message?.content;
      const value =
        typeof content === 'string'
          ? content
          : (content ?? [])
              .filter(c => c.type === 'text')
              .map(c => c.text ?? '')
              .join('');
      if (e.type === 'assistant' && value) final = value;
      if (e.type === 'user') inputs += value;
    } else if (kind === 'codex') {
      if (e.type === 'session_meta' && e.payload?.id) sessions.add(e.payload.id);
      if (e.type === 'turn_context' && e.payload?.model) models.add(e.payload.model);
      if (e.type === 'response_item' && e.payload?.role === 'user')
        inputs += e.payload.content?.map(c => c.text ?? '').join('') ?? '';
    } else throw new Error('recovery: unsupported native provider');
  }
  return { models: [...models], sessions: [...sessions], final, inputs };
}

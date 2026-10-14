import type { Kind } from '../../../src/jobs';

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

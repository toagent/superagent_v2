import { readFileSync, realpathSync, statSync } from 'node:fs';
import { collectCredentialValues } from '@archon/paths/credential-redaction';
import { scanText } from './secrets/scan';
import type { MessageChunk, ResultChunk } from '../../packages/providers/src/types';

const MAX_BYTES = 1_000_000;
export class RestrictedRoleInput extends Error {}
export const privateRolePath = (path: string): boolean =>
  /(?:^|[\\/])(?:_private|\.git|\.ssh|\.aws|\.gnupg|\.env[^/]*|Library\/Mobile Documents|Library\/CloudStorage\/iCloud[^/]*|[^/]+\.(?:pem|key|p12|pfx)|\.netrc|\.npmrc|\.pypirc|(?:auth|credentials?|secrets?)\.json)(?:$|[\\/])/i.test(
    path
  );

export function roleFile(path: string): string {
  if (privateRolePath(path)) throw new RestrictedRoleInput('role private path');
  const file = realpathSync(path);
  if (privateRolePath(file)) throw new RestrictedRoleInput('role private path');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('role file exceeds input limit');
  return readFileSync(file, 'utf8');
}

export function roleText(text: string): string {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('role input exceeds limit');
  const values = collectCredentialValues(process.env);
  const secrets = values.map(value => ({ name: 'environment', value }));
  if (
    values.some(value => text.includes(value)) ||
    scanText(text, { secrets, keyValues: false, heuristics: false }) !== text
  )
    throw new RestrictedRoleInput('role input contains a credential');
  return text;
}

export async function settledRoleResult(stream: AsyncGenerator<MessageChunk>) {
  let result: ResultChunk | undefined,
    settled = false;
  for await (const chunk of stream) {
    if (chunk.type === 'result') result = chunk;
    if (chunk.type === 'settled') settled = true;
  }
  return settled ? result : undefined;
}

/** Single stateless turn. Error responses and partial bodies never reach the caller as output. */
export async function geminiTurn(
  model: string,
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 60_000
): Promise<{ value: unknown; model?: string }> {
  const base = process.env.AGY_LLM_GATEWAY_URL;
  const credential = [process.env.AGY_LLM_GATEWAY_API_KEY, process.env.ANTIGRAVITY_API_KEY].find(
    Boolean
  );
  if (!base || !credential) throw new Error('gateway unavailable');
  const url = new URL(base);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^gemini-(?:[a-z0-9-]|%[0-9a-f]{2})+$/i.test(model)
  )
    throw new Error('invalid gateway configuration');
  url.pathname =
    url.pathname.replace(/\/$/, '').replace(/\/v1beta$/, '') +
    `/v1beta/models/${model}:generateContent`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': credential },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => {
    throw new Error(timeout.aborted ? 'gateway timeout' : 'gateway request failed');
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`gateway HTTP ${String(response.status)}`);
  }
  try {
    const reply = (await response.json()) as {
      error?: unknown;
      modelVersion?: string;
      candidates?: {
        finishReason?: string;
        content?: { parts?: { text?: string; thought?: boolean }[] };
      }[];
    };
    const candidate = reply.candidates?.[0];
    if (reply.error || candidate?.finishReason !== 'STOP') throw new Error();
    const parts = candidate.content?.parts?.filter(part => !part.thought);
    if (!parts?.length || parts.some(part => typeof part.text !== 'string')) throw new Error();
    const value: unknown = JSON.parse(roleText(parts.map(part => part.text).join('')));
    const model =
      typeof reply.modelVersion === 'string' &&
      /^gemini-[a-z0-9.-]+$/i.test(reply.modelVersion) &&
      !collectCredentialValues(process.env).some(secret => reply.modelVersion?.includes(secret))
        ? reply.modelVersion
        : undefined;
    return { value, model };
  } catch {
    throw new Error(timeout.aborted ? 'gateway timeout' : 'gateway invalid result');
  }
}

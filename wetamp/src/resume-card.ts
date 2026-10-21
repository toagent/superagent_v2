import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { coord } from './coord';
type Client = 'claude' | 'codex';
type Payload = Partial<Record<'session_id' | 'transcript_path', string>>;
type Quote = Record<'at' | 'text', string> & Partial<Record<'reply', string>>;
type Run = Record<'run_id' | 'status', string>;
type Json = Record<string, unknown>;
const bytes = (s: string): number => Buffer.byteLength(s);
const chars = (s: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);
const fitBytes = (s: string, limit: number): string => {
  const parts = chars(s);
  while (bytes(parts.join('')) > limit) parts.pop();
  return parts.join('');
};
const head = (s: string, limit: number): string => chars(s).slice(0, limit).join('');
const tail = (s: string, limit: number): string => chars(s).slice(-limit).join('');
const objectOf = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const textOf = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v
    .flatMap(value => {
      const x = objectOf(value);
      return x.type === 'text' && typeof x.text === 'string' ? [x.text] : [];
    })
    .join('');
};
const envOr = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : fallback;
};
const timeOf = (v: unknown): string => {
  const d = new Date(typeof v === 'string' ? v : 0);
  return Number.isNaN(d.valueOf()) ? '-- --:--' : d.toISOString().slice(5, 16).replace('T', ' ');
};
function safePath(payload: Payload, client: Client): string | null {
  try {
    if (!payload.session_id || !payload.transcript_path) return null;
    const base = envOr(
        client === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        join(homedir(), client === 'claude' ? '.claude' : '.codex')
      ),
      root = realpathSync(join(base, client === 'claude' ? 'projects' : 'sessions'));
    const file = realpathSync(payload.transcript_path),
      rel = relative(root, file),
      suffix = client === 'claude' ? `${payload.session_id}.jsonl` : `-${payload.session_id}.jsonl`;
    const inside = rel !== '..' && !rel.startsWith(`..${sep}`),
      named = file.endsWith(`${client === 'claude' ? sep : ''}${suffix}`);
    return statSync(file).isFile() && inside && named ? file : null;
  } catch {
    return null;
  }
}
async function facts(path: string, client: Client): Promise<{ count: number; quotes: Quote[] }> {
  let count = 0,
    assistant = '';
  const quotes: Quote[] = [];
  const add = (text: string, at: unknown): void => {
    quotes.push({
      at: timeOf(at),
      text,
      ...(chars(text).length < 20 && assistant ? { reply: tail(assistant, 200) } : {}),
    });
  };
  const input = createReadStream(path);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!/(?:user|assistant|UserMessage|AgentMessage|compact)/.test(line)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const x = objectOf(parsed);
    let kind: unknown,
      content = '',
      allowed = true;
    if (client === 'claude') {
      if (x.type === 'system' && x.subtype === 'compact_boundary') count++;
      kind = x.type;
      content = textOf(objectOf(x.message).content);
      allowed =
        !('toolUseResult' in x) &&
        x.isMeta !== true &&
        x.isCompactSummary !== true &&
        !/^<[^>]+>/.test(content);
    } else {
      if (x.type === 'compacted') count++;
      const payload = objectOf(x.payload),
        item =
          x.type === 'event_msg' && payload.type === 'item_completed' ? objectOf(payload.item) : {};
      kind = item.type;
      content = textOf(item.content);
    }
    if (kind === 'assistant' || kind === 'AgentMessage') assistant = content || assistant;
    if ((kind === 'user' || kind === 'UserMessage') && allowed && content)
      add(content, x.timestamp);
  }
  return { count, quotes };
}
function quoteLines(quotes: Quote[], path: string): string[] {
  const render = (q: Quote): string =>
    `${q.at} ${head(q.text, 300)}${q.reply ? `\n  ↳ 回应：${q.reply}` : ''}`;
  const all = quotes.map(render);
  if (bytes(all.join('\n')) <= 4096) return all;
  const first = all.slice(0, 3),
    latest = all.slice(3);
  const result = (): string[] => [
    ...first,
    `省略 ${String(all.length - first.length - latest.length)} 条，见 ${path}`,
    ...latest,
  ];
  while (latest.length && bytes(result().join('\n')) > 4096) latest.shift();
  return result();
}
export async function resumeCard(p: Payload, client: Client, runs?: Run[]): Promise<string | null> {
  const path = safePath(p, client);
  if (!path || !p.session_id) return null;
  const { count, quotes } = await facts(path, client),
    lines = [`【复位卡·第 ${String(count)} 次压缩】以下为磁盘事实，与压缩摘要冲突时以此为准`];
  if (count >= 2)
    lines.push('建议换会话：先更新任务栈断点，再新开会话 `tasks.sh adopt <slug>` 接手');
  const active = runs ?? coord().unfinishedRuns(p.session_id);
  lines.push(
    '未结束 run：',
    ...(active.length ? active.map(r => `${r.run_id} ${r.status}`) : ['（无）']),
    '用户原话：',
    ...quoteLines(quotes, path)
  );
  return fitBytes(lines.join('\n'), 6144);
}
if (import.meta.main) {
  const payload = JSON.parse(await Bun.stdin.text()) as Payload,
    context = await resumeCard(payload, process.argv[2] as Client);
  if (context) {
    const output = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

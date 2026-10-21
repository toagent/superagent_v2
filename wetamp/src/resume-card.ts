import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { coord } from './coord';

type Client = 'claude' | 'codex';
interface Payload {
  session_id?: string;
  transcript_path?: string;
}
interface Quote {
  at: string;
  text: string;
  reply?: string;
}
interface Run {
  run_id: string;
  status: string;
}
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
const textOf = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v
          .flatMap(value => {
            const x = objectOf(value);
            return x.type === 'text' && typeof x.text === 'string' ? [x.text] : [];
          })
          .join('')
      : '';
const envOr = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : fallback;
};
const timeOf = (v: unknown): string => {
  const d = new Date(typeof v === 'string' ? v : 0);
  return Number.isNaN(d.valueOf())
    ? '-- --:--'
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
function safePath(payload: Payload, client: Client): string | null {
  try {
    if (!payload.session_id || !payload.transcript_path) return null;
    const root = realpathSync(
      client === 'claude'
        ? join(envOr('CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects')
        : join(envOr('CODEX_HOME', join(homedir(), '.codex')), 'sessions')
    );
    const file = realpathSync(payload.transcript_path),
      rel = relative(root, file),
      name = basename(file);
    if (
      !statSync(file).isFile() ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      (client === 'claude'
        ? name !== `${payload.session_id}.jsonl`
        : !name.endsWith(`-${payload.session_id}.jsonl`))
    )
      return null;
    return file;
  } catch {
    return null;
  }
}
async function facts(path: string, client: Client): Promise<{ count: number; quotes: Quote[] }> {
  let count = 0,
    assistant = '';
  const quotes: Quote[] = [];
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (
      !line.includes('user') &&
      !line.includes('assistant') &&
      !line.includes('UserMessage') &&
      !line.includes('AgentMessage') &&
      !line.includes('compact')
    )
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const x = objectOf(parsed);
    if (client === 'claude') {
      if (x.type === 'system' && x.subtype === 'compact_boundary') count++;
      const content = textOf(objectOf(x.message).content);
      if (x.type === 'assistant' && content) assistant = content;
      if (
        x.type === 'user' &&
        !('toolUseResult' in x) &&
        x.isMeta !== true &&
        x.isCompactSummary !== true &&
        content &&
        !/^<[^>]+>/.test(content)
      )
        quotes.push({
          at: timeOf(x.timestamp),
          text: content,
          ...(chars(content).length < 20 && assistant ? { reply: tail(assistant, 200) } : {}),
        });
    } else {
      if (x.type === 'compacted') count++;
      const payload = objectOf(x.payload),
        item =
          x.type === 'event_msg' && payload.type === 'item_completed' ? objectOf(payload.item) : {},
        content = textOf(item.content);
      if (item.type === 'AgentMessage' && content) assistant = content;
      if (item.type === 'UserMessage' && content)
        quotes.push({
          at: timeOf(x.timestamp),
          text: content,
          ...(chars(content).length < 20 && assistant ? { reply: tail(assistant, 200) } : {}),
        });
    }
  }
  return { count, quotes };
}
function quoteLines(quotes: Quote[], path: string): string[] {
  const render = (q: Quote): string =>
    `${q.at} ${head(q.text, 300)}${q.reply ? `\n  ↳ 回应：${q.reply}` : ''}`;
  if (bytes(quotes.map(render).join('\n')) <= 4096) return quotes.map(render);
  const keep = quotes.slice(0, 3),
    latest: Quote[] = [];
  for (const q of quotes.slice(3).reverse()) {
    const candidate = [
      ...keep.map(render),
      `省略 ${String(quotes.length - keep.length - latest.length - 1)} 条，见 ${path}`,
      ...[q, ...latest].map(render),
    ];
    if (bytes(candidate.join('\n')) > 4096) break;
    latest.unshift(q);
  }
  return [
    ...keep.map(render),
    `省略 ${String(quotes.length - keep.length - latest.length)} 条，见 ${path}`,
    ...latest.map(render),
  ];
}
export async function resumeCard(
  payload: Payload,
  client: Client,
  runs?: Run[]
): Promise<string | null> {
  const path = safePath(payload, client);
  if (!path || !payload.session_id) return null;
  const { count, quotes } = await facts(path, client),
    lines = [`【复位卡·第 ${String(count)} 次压缩】以下为磁盘事实，与压缩摘要冲突时以此为准`];
  if (count >= 2)
    lines.push('建议换会话：先更新任务栈断点，再新开会话 `tasks.sh adopt <slug>` 接手');
  const active = runs ?? coord().unfinishedRuns(payload.session_id);
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
  if (context)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
      }) + '\n'
    );
}

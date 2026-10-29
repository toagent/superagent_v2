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
export const waitingRuns = (sessionId: string, runs = coord().unfinishedRuns(sessionId)): Run[] =>
  runs.filter(run => run.status === 'running' || run.status === 'pending');
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
const timestampOf = (v: unknown): number | null => {
  const value = typeof v === 'string' ? new Date(v).valueOf() : NaN;
  return Number.isNaN(value) ? null : value;
};
const timeOf = (v: unknown): string => {
  const value = timestampOf(v);
  if (value === null) return '-- --:--';
  const d = new Date(value),
    pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
async function facts(path: string, client: Client): Promise<[number, number | null, Quote[]]> {
  let count = 0,
    lastCompactAt: number | null = null,
    assistant = '';
  const quotes: Quote[] = [];
  const mark = (at: unknown): void => {
    count++;
    lastCompactAt = timestampOf(at);
  };
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
      if (x.type === 'system' && x.subtype === 'compact_boundary') mark(x.timestamp);
      kind = x.type;
      content = textOf(objectOf(x.message).content);
      allowed =
        !('toolUseResult' in x) &&
        x.isMeta !== true &&
        x.isCompactSummary !== true &&
        !/^<[^>]+>/.test(content);
    } else {
      if (x.type === 'compacted') mark(x.timestamp);
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
  return [count, lastCompactAt, quotes];
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
export async function resumeCard(
  p: Payload,
  client: Client,
  runs?: Run[],
  now = Date.now(),
  env = process.env
): Promise<string | null> {
  const path = safePath(p, client);
  if (!path || !p.session_id) return null;
  const [onDisk, lastCompactAt, quotes] = await facts(path, client),
    count = onDisk + Number(lastCompactAt === null || Math.abs(now - lastCompactAt) > 120_000),
    lines = [`【复位卡·第 ${String(count)} 次压缩】以下为磁盘事实，与压缩摘要冲突时以此为准`];
  if (count >= 1)
    lines.push(
      env.ORCA_AGENT_SESSION_ID
        ? '建议换会话：在任务栈写好断点并补齐「接手必读」「在途」「已核实与更正」三节（无内容写「无」），然后执行 superagent rollover start，按输出在后台运行 superagent rollover wait 后结束本轮。'
        : '建议换会话：在任务栈写好断点并把状态改为「被中断」（没有任务栈先 tasks.sh new <slug>），然后新开会话执行 tasks.sh list，再 tasks.sh adopt <列表中的会话目录名> 接手。'
    );
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
    mode = process.argv[2];
  if (mode === 'waiting-runs') {
    process.stdout.write(`${JSON.stringify(waitingRuns(payload.session_id ?? ''))}\n`);
    process.exit(0);
  }
  const context = await resumeCard(payload, mode as Client);
  if (context) {
    const output = {
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

type Client = 'claude' | 'codex';
type Json = Record<string, unknown>;
interface Entry {
  at: unknown;
  text: string;
  line: number;
  aside?: boolean;
}
interface Facts {
  users: Entry[];
  summary?: Entry;
  report?: Entry;
}
export interface HandoffSession {
  client: Client;
  transcript: string;
  label: string;
}

const object = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap(part => {
      const item = object(part);
      return typeof item.text === 'string' && ['text', 'Text'].includes(String(item.type))
        ? [item.text]
        : [];
    })
    .join('');
};
const chars = (value: string): string[] => Array.from(value);
const shorten = (value: string, path: string, line: number, limit: number): string => {
  const parts = chars(value);
  if (parts.length <= limit) return value;
  const omitted = parts.length - 3000;
  return `${parts.slice(0, 1500).join('')}…[省略 ${String(omitted)} 字，见 ${path} 第 ${String(line)} 行]…${parts.slice(-1500).join('')}`;
};
const localTime = (value: unknown): string => {
  const time = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isNaN(time.valueOf()) ? '时间未知' : time.toLocaleString('sv-SE');
};
const ignoredClaudeText = (value: string): boolean =>
  /^\s*<(?:local-command-stdout|local-command-caveat)>[\s\S]*<\/(?:local-command-stdout|local-command-caveat)>\s*$/.test(
    value
  );
const commandText = (value: string): string =>
  value.replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1');
const injectedCodexText = (value: string): boolean =>
  /^\s*(?:<environment_context>|# AGENTS\.md instructions for\b)/.test(value);

function consumeClaude(row: Json, line: number, facts: Facts): void {
  const content = text(object(row.message).content);
  if (row.type === 'queue-operation') {
    if (
      row.operation === 'remove' &&
      row.reason === 'absorbed_mid_turn' &&
      typeof row.content === 'string'
    )
      facts.users.push({ at: row.timestamp, text: row.content, line, aside: true });
    return;
  }
  if (row.type === 'user' && row.isCompactSummary === true) {
    if (content) facts.summary = { at: row.timestamp, text: content, line };
    return;
  }
  if (row.type === 'user') {
    if (row.isSidechain || row.isMeta || !content || ignoredClaudeText(content)) return;
    facts.users.push({ at: row.timestamp, text: commandText(content), line });
  }
  if (row.type === 'assistant' && !row.isSidechain && content)
    facts.report = { at: row.timestamp, text: content, line };
}

function consumeCodex(row: Json, line: number, facts: Facts): void {
  if (row.type === 'compacted') {
    const summary = object(row.payload).message;
    if (typeof summary === 'string') facts.summary = { at: row.timestamp, text: summary, line };
    return;
  }
  const payload = object(row.payload),
    item =
      row.type === 'event_msg' && payload.type === 'item_completed' ? object(payload.item) : {},
    content = text(item.content);
  if (item.type === 'UserMessage' && content && !injectedCodexText(content))
    facts.users.push({ at: row.timestamp, text: content, line });
  if (item.type === 'AgentMessage' && content)
    facts.report = { at: row.timestamp, text: content, line };
}

async function readFacts(session: HandoffSession): Promise<Facts> {
  const facts: Facts = { users: [] },
    input = createReadStream(session.transcript),
    lines = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  for await (const raw of lines) {
    line++;
    if (!raw.trim()) continue;
    let row: Json;
    try {
      row = object(JSON.parse(raw) as unknown);
    } catch (error) {
      throw new Error(`第 ${String(line)} 行 JSON 损坏：${String(error)}`);
    }
    if (session.client === 'claude') consumeClaude(row, line, facts);
    else consumeCodex(row, line, facts);
  }
  return facts;
}

async function renderSession(session: HandoffSession): Promise<string> {
  const lines = [`## ${session.label}`];
  try {
    const facts = await readFacts(session);
    lines.push(
      '',
      '### 用户原话',
      ...(facts.users.length
        ? facts.users.map(
            entry =>
              `- [${localTime(entry.at)}] ${entry.aside ? '「插话」' : ''}${shorten(entry.text, session.transcript, entry.line, 4000)}`
          )
        : ['- （无）'])
    );
    if (facts.summary)
      lines.push(
        '',
        '### 最近一次压缩摘要',
        shorten(facts.summary.text, session.transcript, facts.summary.line, 12000)
      );
    lines.push(
      '',
      '### 最后一次汇报',
      facts.report
        ? shorten(facts.report.text, session.transcript, facts.report.line, 4000)
        : '（无）'
    );
  } catch (error) {
    lines.push('', `transcript 不可读：${error instanceof Error ? error.message : String(error)}`);
  }
  return lines.join('\n');
}

export async function renderHandoffContext(chain: HandoffSession[]): Promise<string> {
  return (await Promise.all(chain.map(renderSession))).join('\n\n');
}

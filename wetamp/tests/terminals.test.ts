import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { psRows } from '../src/board/activity';
import { shortRemoteId } from '../src/board/App';
import {
  bindLive,
  classify,
  findSessions,
  interactiveKind,
  parseRollouts,
  readLive,
  readTail,
  settle,
  tailState,
  type Live,
} from '../src/board/terminals';
import { tmp } from './helpers';

const HOOKS = join(import.meta.dir, '..', 'hooks');
const live = createRequire(import.meta.url)(join(HOOKS, 'live.cjs')) as {
  beat: (
    client: string,
    input: object,
    derivedOf?: () => unknown,
    env?: Record<string, string | undefined>
  ) => void;
  THROTTLE_MS: number;
};
const SECRET = 'PROMPT-SECRET-do-not-leak';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

// pid ppid tty %cpu etime command
const PS = [
  '  100     1 ttys001  0.0    01:00:00 -zsh',
  '  110   100 ttys001  1.0       10:00 node /opt/homebrew/bin/codex --model gpt-6-astra',
  '  111   110 ttys001  4.5       09:59 /opt/lib/vendor/bin/codex --model gpt-6-astra',
  '  112   111 ttys001  0.1       09:58 /opt/lib/vendor/bin/codex-code-mode-host',
  '  200     1 ttys002  0.0    01:00:00 -zsh',
  '  210   200 ttys002  0.2       20:00 claude',
  '  211   210 ttys002  0.0       19:00 node /x/hooks/guard.cjs claude',
  '  212   210 ttys002  0.0       19:00 claude mcp serve',
  '  300     1 ttys003  0.0       30:00 opencode',
  '  400     1 ttys004  0.0       00:10 opencode run --model=qwen x',
  `  410     1 ttys004  0.0       00:10 claude -p ${SECRET}`,
  `  420     1 ttys004  0.0       00:10 claude --print ${SECRET}`,
  '  430     1 ttys004  0.0       00:10 codex exec -m sol x',
  '  440     1 ttys004  0.0       00:10 codex app-server',
  '  450     1 ttys004  0.0       00:10 codex mcp-server',
  '  460     1 ttys004  0.0       00:10 opencode serve',
  '  500     1 ??       9.0       00:10 claude', // 无 tty：不是终端会话
].join('\n');
const ROWS = psRows(PS);

const liveOf = (o: Partial<Live>): Live => ({
  pid: null,
  cwd: null,
  transcript_path: null,
  event: 'PostToolUse',
  tool: null,
  turn_at: null,
  at: iso(NOW),
  derived: false,
  ...o,
});

describe('interactive sessions from ps', () => {
  test('keeps tty-bound interactive CLIs, merges codex launcher + native, excludes headless/servers', () => {
    const s = findSessions(ROWS);
    expect(s.map(x => [x.kind, x.pids, x.tty])).toEqual([
      ['codex', [110, 111], 'ttys001'],
      ['claude', [210], 'ttys002'],
      ['opencode', [300], 'ttys003'],
    ]);
    expect(s[0].cpu).toBeCloseTo(5.5);
    expect(interactiveKind(['codex', 'resume', '--last'])).toBe('codex');
    expect(interactiveKind(['/usr/local/bin/claude', '--model', 'x'])).toBe('claude');
    expect(interactiveKind(['bun', '/x/claude.ts'])).toBeNull();
  });

  test('a heartbeat binds through descendants; the newest heartbeat wins', () => {
    const s = findSessions(ROWS);
    const b = bindLive(
      s,
      [
        liveOf({ pid: 211, at: iso(NOW - 5000), event: 'Stop' }), // hook 子进程的 pid 也能找到会话
        liveOf({ pid: 210, at: iso(NOW - 1000), event: 'PreToolUse', tool: 'Bash' }),
        liveOf({ pid: 111, event: 'Stop' }),
        liveOf({ pid: 999999 }),
        liveOf({ pid: null }),
      ],
      ROWS
    );
    expect(b.size).toBe(2);
    expect(b.get(s[1])?.tool).toBe('Bash');
    expect(b.get(s[0])?.event).toBe('Stop');
  });

  test('settle: busy first, derived skipped, cwd from heartbeat or lsof, no argv in output', () => {
    const s = findSessions(ROWS);
    const bound = new Map([
      [s[1], liveOf({ pid: 210, event: 'PreToolUse', tool: 'Bash', cwd: '/w/superagent_v2' })],
      [s[2], liveOf({ pid: 300, derived: true })],
    ]);
    const terms = settle(s, bound, new Map([[111, '/w/proposal']]), new Map(), NOW);
    expect(terms.map(t => [t.kind, t.state, t.tool, t.cwd, t.bound])).toEqual([
      ['claude', 'busy', 'Bash', '/w/superagent_v2', true],
      ['codex', 'busy', null, '/w/proposal', false], // 无心跳/rollout，CPU 5.5% 粗判
    ]);
    expect(JSON.stringify(terms)).not.toContain('gpt-6-astra');
  });

  test('lsof rollout parsing and remote id shortening', () => {
    const out = [
      'p111',
      'fcwd',
      'n/w/proposal',
      'f20',
      'n/Users/u/.codex/sessions/2026/10/10/rollout-2026-10-10T12-00-00-abc.jsonl',
      'p112',
      'f3',
      'n/Users/u/.codex/sessions/index.jsonl',
    ].join('\n');
    expect(parseRollouts(out)).toEqual(
      new Map([[111, '/Users/u/.codex/sessions/2026/10/10/rollout-2026-10-10T12-00-00-abc.jsonl']])
    );
    expect(shortRemoteId('20261010125744-a1b2c3')).toBe('125744-a1b2c3');
    expect(shortRemoteId('job-abcdef1234567890')).toBe('job-abcdef123');
  });
});

describe('turn state', () => {
  const j = (...xs: object[]): string => xs.map(x => JSON.stringify(x)).join('\n') + '\n';
  const user = { type: 'user', message: { role: 'user', content: 'fixture' } };
  const asst = (stop_reason: string | null): object => ({
    type: 'assistant',
    message: { role: 'assistant', stop_reason },
  });
  const ev = (type: string): object => ({ type: 'event_msg', payload: { type } });

  test('claude transcript tail', () => {
    expect(tailState(j(user, asst('end_turn')), 'claude')).toBe('idle');
    expect(tailState(j(asst('end_turn'), user), 'claude')).toBe('busy');
    expect(tailState(j(user, asst('tool_use')), 'claude')).toBe('busy');
    expect(tailState(j(user, asst(null)), 'claude')).toBe('busy');
    // 尾部的 meta/附件条目跳过
    expect(
      tailState(
        j(asst('end_turn'), { type: 'user', isMeta: true }, { type: 'attachment' }),
        'claude'
      )
    ).toBe('idle');
    expect(tailState('not json\n', 'claude')).toBeNull();
  });

  test('codex rollout tail', () => {
    expect(
      tailState(j(ev('task_started'), ev('agent_message'), ev('task_complete')), 'codex')
    ).toBe('idle');
    expect(tailState(j(ev('task_complete'), ev('task_started'), ev('exec')), 'codex')).toBe('busy');
    expect(tailState(j(ev('task_started'), ev('turn_aborted')), 'codex')).toBe('idle');
    expect(tailState(j({ type: 'response_item' }), 'codex')).toBe('busy'); // 长回合
    expect(tailState('', 'codex')).toBeNull();
  });

  test('readTail reads only the last 64KB and drops the cut first line', () => {
    const f = join(tmp(), 't.jsonl');
    const filler = JSON.stringify({ type: 'response_item', pad: 'x'.repeat(1000) });
    writeFileSync(f, j(ev('task_started')) + `${filler}\n`.repeat(70) + j(ev('task_complete')));
    expect(readTail(f, 'codex')?.state).toBe('idle');
    writeFileSync(f, j(ev('task_complete')) + `${filler}\n`.repeat(70));
    expect(readTail(f, 'codex')?.state).toBe('busy'); // 开头的 task_complete 在 64KB 之外
    expect(readTail(join(tmp(), 'missing'), 'codex')).toBeNull();
  });

  test('classify priority: Stop, PreToolUse, fresh heartbeat, tail, cpu', () => {
    const noTail = (): null => null;
    const idleTail = () => ({ state: 'idle' as const, mtime: NOW - 7000 });
    expect(classify(liveOf({ event: 'Stop', at: iso(NOW - 3000) }), noTail, 50, NOW)).toEqual({
      state: 'idle',
      tool: null,
      since_ms: NOW - 3000,
      bound: true,
    });
    expect(
      classify(liveOf({ event: 'PreToolUse', tool: 'Bash', at: iso(NOW - 12_000) }), noTail, 0, NOW)
    ).toMatchObject({ state: 'busy', tool: 'Bash', since_ms: NOW - 12_000 });
    expect(
      classify(
        liveOf({ event: 'UserPromptSubmit', turn_at: iso(NOW - 60_000), at: iso(NOW - 60_000) }),
        noTail,
        0,
        NOW
      )
    ).toMatchObject({ state: 'busy', since_ms: NOW - 60_000, bound: true });
    // 过期心跳 → 尾部
    expect(classify(liveOf({ at: iso(NOW - 600_000) }), idleTail, 0, NOW)).toMatchObject({
      state: 'idle',
      since_ms: NOW - 7000,
    });
    expect(classify(null, noTail, 3.5, NOW)).toMatchObject({ state: 'busy', bound: false });
    expect(classify(null, noTail, 0.5, NOW)).toMatchObject({ state: 'unknown', bound: false });
  });
});

describe('heartbeat files', () => {
  const KEYS = [
    'client',
    'session_id',
    'pid',
    'tty',
    'cwd',
    'transcript_path',
    'event',
    'tool',
    'turn_at',
    'at',
    'derived',
  ];
  const files = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')) : [];
  const read = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, files(dir)[0]), 'utf8')) as Record<string, unknown>;

  test('writes exactly the whitelisted keys and never prompt/tool input/output', () => {
    const home = tmp();
    const dir = join(home, 'live');
    live.beat(
      'claude',
      {
        session_id: 'sess-1',
        hook_event_name: 'UserPromptSubmit',
        prompt: SECRET,
        cwd: '/w/x',
        transcript_path: '/t/x.jsonl',
      },
      () => null,
      { SUPERAGENT_HOME: home }
    );
    expect(files(dir)).toHaveLength(1);
    expect(files(dir)[0]).toMatch(/^claude-[0-9a-f]{16}\.json$/);
    const a = read(dir);
    expect(Object.keys(a).sort()).toEqual([...KEYS].sort());
    expect(a).toMatchObject({ event: 'UserPromptSubmit', tool: null, derived: false });
    expect(a.turn_at).toBe(a.at);
    live.beat(
      'claude',
      {
        session_id: 'sess-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: SECRET },
      },
      () => 'commander',
      { SUPERAGENT_HOME: home }
    );
    const b = read(dir);
    expect(b).toMatchObject({ event: 'PreToolUse', tool: 'Bash', derived: true });
    expect(b.turn_at).toBe(a.turn_at); // 回合开始时间沿用
    expect(readFileSync(join(dir, files(dir)[0]), 'utf8')).not.toContain(SECRET);
    // 子代理事件带父会话的 session_id，不覆盖；无 session_id 不写
    live.beat(
      'claude',
      { session_id: 'sess-1', hook_event_name: 'Stop', agent_type: 'x', agent_id: 'y' },
      () => null,
      { SUPERAGENT_HOME: home }
    );
    live.beat('claude', { hook_event_name: 'Stop' }, () => null, { SUPERAGENT_HOME: home });
    expect(read(dir).event).toBe('PreToolUse');
    expect(files(dir)).toHaveLength(1);
  });

  test('tool events are throttled to one write per 2s; Stop always writes; codex turn starts after Stop', () => {
    const home = tmp();
    const dir = join(home, 'live');
    const beat = (o: object): void =>
      live.beat('codex', { session_id: 's', ...o }, () => null, { SUPERAGENT_HOME: home });
    beat({ hook_event_name: 'SessionStart' });
    beat({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' }); // 回合开始，不节流
    const t0 = read(dir);
    expect(t0.turn_at).toBe(t0.at);
    beat({ hook_event_name: 'PostToolUse', tool_name: 'exec_command' });
    expect(read(dir).event).toBe('PreToolUse'); // 2s 内被节流
    const f = join(dir, files(dir)[0]);
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(f, old, old);
    beat({ hook_event_name: 'PostToolUse', tool_name: 'exec_command' });
    expect(read(dir).event).toBe('PostToolUse');
    beat({ hook_event_name: 'Stop' });
    expect(read(dir)).toMatchObject({ event: 'Stop', tool: null });
    beat({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch' });
    const t1 = read(dir);
    expect(t1).toMatchObject({ event: 'PreToolUse', tool: 'apply_patch' });
    expect(t1.turn_at).toBe(t1.at);
    expect(live.THROTTLE_MS).toBe(2000);
  });

  test('unwritable home: no throw, no output, no file', () => {
    const home = tmp();
    chmodSync(home, 0o555);
    try {
      expect(() =>
        live.beat('claude', { session_id: 's', hook_event_name: 'Stop' }, () => null, {
          SUPERAGENT_HOME: home,
        })
      ).not.toThrow();
      expect(files(join(home, 'live'))).toEqual([]);
      // 子进程：stdout/stderr 均为空、退出码 0
      const p = Bun.spawnSync(
        [
          'node',
          '-e',
          `require(${JSON.stringify(
            join(HOOKS, 'live.cjs')
          )}).beat('claude',{session_id:'s',hook_event_name:'PreToolUse',tool_name:'Bash'},()=>{throw new Error('x')})`,
        ],
        { env: { ...process.env, SUPERAGENT_HOME: home }, stdout: 'pipe', stderr: 'pipe' }
      );
      expect([p.exitCode, p.stdout.toString(), p.stderr.toString()]).toEqual([0, '', '']);
    } finally {
      chmodSync(home, 0o755);
    }
  });

  test('readLive skips bad files and GCs dead heartbeats older than 24h', () => {
    const dir = join(tmp(), 'live');
    mkdirSync(dir);
    const put = (n: string, o: object | string): string => {
      const f = join(dir, n);
      writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o));
      return f;
    };
    const dead = put('claude-old.json', {
      pid: 999_999_99,
      event: 'Stop',
      at: iso(NOW - 90_000_000),
    });
    const mine = put('claude-mine.json', {
      pid: process.pid,
      event: 'Stop',
      at: iso(NOW - 90_000_000),
    });
    put('codex-new.json', { pid: 5, event: 'PreToolUse', tool: 'Bash', at: iso(NOW), extra: 1 });
    put('bad.json', '{');
    put('codex-x.json.1.tmp', '{}');
    const got = readLive(dir, NOW);
    expect(
      got.map(l => [l.pid, l.event, l.tool]).sort((a, b) => Number(a[0]) - Number(b[0]))
    ).toEqual([
      [5, 'PreToolUse', 'Bash'],
      [process.pid, 'Stop', null],
    ]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(readLive(join(dir, 'nope'), NOW)).toEqual([]);
  });
});

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
import { attach, psRows, rankOf } from '../src/board/activity';
import { loadTiers } from '../src/config';
import type { Job } from '../src/jobs';
import { shortRemoteId } from '../src/board/App';
import {
  bindLive,
  classify,
  findSessions,
  interactiveKind,
  matchRollout,
  parseRollouts,
  readLive,
  readTail,
  settle,
  tailState,
  type Live,
  type Session,
} from '../src/board/terminals';
import { tmp } from './helpers';

const HOOKS = join(import.meta.dir, '..', 'hooks');
const live = createRequire(import.meta.url)(join(HOOKS, 'live.cjs')) as {
  beat: (
    client: string,
    input: object,
    roleOf?: () => unknown,
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
  role: null,
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

  const anchors = (s: Session[]): Map<number, object> =>
    new Map(s.flatMap(x => x.pids.map(p => [p, x] as const)));

  test('a heartbeat binds through descendants; the newest heartbeat wins', () => {
    const s = findSessions(ROWS);
    expect(s[0].etime).toBe(600); // leader 的 etime
    const b = bindLive(
      anchors(s),
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

  // 回归（BT3 会话间歇消失）：元帅会话里登记作业跑的无头 AI 也发心跳；它曾因“取最新”顶替元帅自己的心跳，
  // 再被当作派生会话整行跳过。作业是更近的锚点，派生心跳归作业，元帅行始终在。
  test('a derived heartbeat under a job binds to the job, never replacing the session it descends from', () => {
    const rows = psRows(
      [
        '  700     1 ttys009  0.0    01:00:00 -zsh',
        '  710   700 ttys009  0.5       50:00 claude',
        '  720   710 ttys009  0.0       01:00 /bin/zsh -c x',
        '  730   720 ttys009  0.0       01:00 bun /w/src/cli.ts job exec --title t',
        `  740   730 ttys009 30.0       01:00 claude -p ${SECRET}`,
      ].join('\n')
    );
    const s = findSessions(rows);
    const job = {
      wrapper_pid: 730,
      pid: 740,
      model: 'claude-opus-5',
      role: undefined,
    } as unknown as Job;
    const mine = liveOf({ pid: 710, event: 'Stop', at: iso(NOW - 60_000), role: 'commander' });
    const derived = liveOf({ pid: 740, event: 'PreToolUse', tool: 'Bash', role: 'general' });
    const pools = loadTiers().tiers;
    const own = attach(rows, s, [job], [], [mine, derived], pools);
    expect(own.bound.get(s[0])).toBe(mine);
    expect(own.jobs[0]).toMatchObject({ tier: 'general', guess: false, owner: 710 }); // 角色来自心跳
    const terms = settle(s, own.bound, new Map(), new Map(), NOW, tmp());
    expect(terms.map(t => [t.tier, t.state, t.pid])).toEqual([['commander', 'idle', 710]]);
    // 显式 --role 优先于心跳；会话外的作业无主
    const out = { ...job, wrapper_pid: 9, pid: 8, role: 'strategist' } as Job;
    expect(attach(rows, s, [out], [], [], pools).jobs[0]).toMatchObject({
      tier: 'strategist',
      owner: null,
    });
  });

  test('rankOf: explicit role wins; otherwise a model in exactly one of general/strategist pools is a guess', () => {
    const pools = loadTiers().tiers;
    expect(rankOf('commander', 'gpt-6-sol', pools)).toEqual({ tier: 'commander', guess: false });
    expect(rankOf(null, 'gpt-6-sol', pools)).toEqual({ tier: 'general', guess: true });
    expect(rankOf(undefined, 'claude-opus-5-5', pools)).toEqual({
      tier: 'strategist',
      guess: true,
    });
    expect(rankOf(null, 'gpt-6.1-sol', pools)).toEqual({ tier: null, guess: false }); // 两池都有
    expect(rankOf(null, null, pools)).toEqual({ tier: null, guess: false });
    expect(rankOf(null, 'gpt-6-sol', null)).toEqual({ tier: null, guess: false });
  });

  test('settle: busy first, tier from heartbeat else commander, cwd from heartbeat or lsof, no argv in output', () => {
    const s = findSessions(ROWS);
    const bound = new Map([
      [s[1], liveOf({ pid: 210, event: 'PreToolUse', tool: 'Bash', cwd: '/w/superagent_v2' })],
      [s[2], liveOf({ pid: 300, event: 'Stop', role: 'general' })],
    ]);
    const terms = settle(s, bound, new Map([[111, '/w/proposal']]), new Map(), NOW, tmp());
    expect(terms.map(t => [t.kind, t.tier, t.state, t.tool, t.cwd, t.bound])).toEqual([
      ['claude', 'commander', 'busy', 'Bash', '/w/superagent_v2', true],
      ['codex', 'commander', 'busy', null, '/w/proposal', false], // 无心跳/rollout，CPU 5.5% 粗判
      ['opencode', 'general', 'idle', null, null, true],
    ]);
    expect(JSON.stringify(terms)).not.toContain('gpt-6-astra');
  });

  test('codex without heartbeat or open rollout: newest cli rollout with the same cwd started after the process', () => {
    const root = tmp();
    const day = join(root, '2026', '10', '10');
    mkdirSync(day, { recursive: true });
    const meta = (cwd: string, source: string): string =>
      JSON.stringify({ type: 'session_meta', payload: { cwd, source, timestamp: 'x' } }) + '\n';
    const ev = (type: string): string =>
      JSON.stringify({ type: 'event_msg', payload: { type } }) + '\n';
    const at = (h: number, m: number): string => {
      const d = new Date(2026, 9, 10, h, m, 0);
      const p2 = (n: number): string => String(n).padStart(2, '0');
      return `rollout-2026-10-10T${p2(d.getHours())}-${p2(d.getMinutes())}-00-u${String(h)}${String(m)}.jsonl`;
    };
    const now = new Date(2026, 9, 10, 12, 0, 0).getTime();
    const start = new Date(2026, 9, 10, 10, 0, 0).getTime();
    writeFileSync(join(day, at(9, 0)), meta('/w/p', 'cli') + ev('task_started')); // 进程启动前
    writeFileSync(join(day, at(10, 30)), meta('/w/p', 'cli') + ev('task_complete'));
    writeFileSync(join(day, at(11, 0)), meta('/w/other', 'cli') + ev('task_started')); // cwd 不同
    writeFileSync(join(day, at(11, 30)), meta('/w/p', 'exec') + ev('task_started')); // 非交互
    expect(matchRollout(root, '/w/p', start, now)).toBe(join(day, at(10, 30)));
    expect(matchRollout(root, '/w/none', start, now)).toBeNull();
    expect(matchRollout(join(root, 'missing'), '/w/p', start, now)).toBeNull();
    // settle 用它判状态；匹配不上保持 CPU 粗判（未知?）
    const rows = psRows(
      `  800     1 ttys005  0.0       02:00:00 codex\n  801   800 ttys005  0.0       02:00:00 codex`
    );
    const s = findSessions(rows);
    const t = (cwd: string) => settle(s, new Map(), new Map([[800, cwd]]), new Map(), now, root)[0];
    expect(t('/w/p')).toMatchObject({ state: 'idle', bound: true });
    expect(t('/w/none')).toMatchObject({ state: 'unknown', bound: false });
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
    // Esc 中断：没有 Stop，尾部是一条带中断标记的 user 文本块
    const stop = (text: string): object => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    expect(
      tailState(j(user, asst('tool_use'), stop('[Request interrupted by user]')), 'claude')
    ).toBe('idle');
    expect(
      tailState(j(asst('tool_use'), stop('[Request interrupted by user for tool use]')), 'claude')
    ).toBe('idle');
    expect(tailState(j(asst('end_turn'), stop('fixture')), 'claude')).toBe('busy');
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
    // PreToolUse 后没有 Post：尾部在心跳之后判为结束（被中断）→ 等待输入；尾部更早则仍在执行
    const pre = liveOf({ event: 'PreToolUse', tool: 'Bash', at: iso(NOW - 12_000) });
    expect(classify(pre, idleTail, 0, NOW)).toMatchObject({ state: 'idle', since_ms: NOW - 7000 });
    const early = () => ({ state: 'idle' as const, mtime: NOW - 20_000 });
    expect(classify(pre, early, 0, NOW)).toMatchObject({ state: 'busy', tool: 'Bash' });
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
    'role',
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
    expect(a).toMatchObject({ event: 'UserPromptSubmit', tool: null, role: null });
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
    expect(b).toMatchObject({ event: 'PreToolUse', tool: 'Bash', role: 'commander' });
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
    // role 只认三档，其余（含抛错）一律 null
    const bad = [
      (): unknown => 'admin',
      (): unknown => true,
      (): unknown => {
        throw new Error('x');
      },
    ];
    for (const roleOf of bad) {
      const h = tmp();
      live.beat('claude', { session_id: 's', hook_event_name: 'Stop' }, roleOf, {
        SUPERAGENT_HOME: h,
      });
      expect(read(join(h, 'live')).role).toBeNull();
    }
  });

  test('only repeats of the same tool event are throttled (2s); Post right after Pre lands; Stop always writes; codex turn starts after Stop', () => {
    const home = tmp();
    const dir = join(home, 'live');
    const beat = (o: object): void =>
      live.beat('codex', { session_id: 's', ...o }, () => null, { SUPERAGENT_HOME: home });
    beat({ hook_event_name: 'SessionStart' });
    beat({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' }); // 回合开始，不节流
    const t0 = read(dir);
    expect(t0.turn_at).toBe(t0.at);
    beat({ hook_event_name: 'PostToolUse', tool_name: 'exec_command' });
    expect(read(dir).event).toBe('PostToolUse'); // 紧跟 Pre 的 Post 不被节流
    beat({ hook_event_name: 'PostToolUse', tool_name: 'exec_command' });
    beat({ hook_event_name: 'PreToolUse', tool_name: 'write_stdin' });
    expect(read(dir)).toMatchObject({ event: 'PreToolUse', tool: 'write_stdin' });
    beat({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch' });
    expect(read(dir).tool).toBe('write_stdin'); // 同一事件 2s 内连发被节流
    const f = join(dir, files(dir)[0]);
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(f, old, old);
    beat({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' });
    expect(read(dir)).toMatchObject({ event: 'PreToolUse', tool: 'exec_command' });
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

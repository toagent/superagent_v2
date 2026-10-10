import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { etimeS, parseLsof, parsePs, parseQueue } from '../src/board/activity';
import { modelOf, readJobs, type Job } from '../src/jobs';
import { tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
const ENV_KEYS = ['SUPERAGENT_HOME', 'ARCHON_HOME'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
let jobsDir = '';
beforeEach(() => {
  const root = tmp();
  Object.assign(process.env, {
    SUPERAGENT_HOME: join(root, 'home'),
    ARCHON_HOME: join(root, 'home', 'archon'),
  });
  jobsDir = join(root, 'home', 'jobs');
});

const SECRET = 'PROMPT-SECRET-do-not-leak';

describe('ps parsing', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z');
  // pid ppid etime command
  const PS = [
    '    1     0 10-02:00:00 /sbin/launchd',
    '  100     1    01:00:00 -zsh',
    `  200   100       05:00 claude -p --model claude-opus-5-5 ${SECRET}`,
    '  300   100       02:00 bun /x/superagent_v2/packages/cli/src/cli.ts workflow run wf',
    `  301   300       01:59 claude --print ${SECRET}`,
    `  400   100       00:30 node /opt/bin/codex exec -m gpt-6.1-sol ${SECRET}`,
    `  401   400       00:29 /opt/lib/codex/codex exec -m gpt-6.1-sol ${SECRET}`,
    '  500   100       00:10 bun /w/wetamp/src/cli.ts job exec --title t -- claude -p x',
    `  501   500       00:09 claude -p ${SECRET}`,
    `  600   100       00:05 opencode run --model=qwen ${SECRET}`,
    '  700   100       00:04 claude --model claude-opus-5-5', // 交互式，不算
    '  800   100       00:03 codex -c x', // archon 的 codex 不带 exec
  ].join('\n');

  test('finds headless claude/codex/opencode; skips archon children, wrapper children and launcher dups', () => {
    const procs = parsePs(PS, NOW, new Set([500]));
    expect(procs.map(p => [p.pid, p.kind, p.model])).toEqual([
      [600, 'opencode', 'qwen'],
      [400, 'codex', 'gpt-6.1-sol'],
      [200, 'claude', 'claude-opus-5-5'],
    ]);
    expect(procs[2].started_ms).toBe(NOW - 300_000);
    expect(JSON.stringify(procs)).not.toContain(SECRET);
  });

  test('etime, lsof and queue formats', () => {
    expect(etimeS('05')).toBe(5);
    expect(etimeS('01:02')).toBe(62);
    expect(etimeS('01:00:00')).toBe(3600);
    expect(etimeS('2-00:00:01')).toBe(172_801);
    expect(parseLsof('p200\nfcwd\nn/Users/y/wt-caps\np400\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [200, '/Users/y/wt-caps'],
        [400, '/tmp'],
      ])
    );
    const q = [
      'job-aaaaaaaaaaaa\trunning\tdev codex read_only isolated /Users/y/repo',
      'job-bbbb\tfinished\tdev claude read_only isolated /r',
      'job-cccc\tqueued',
      'job-dddd\tabandoned\tdev codex x y /r',
      '',
    ].join('\n');
    expect(parseQueue(q)).toEqual([
      { id: 'job-aaaaaaaaaaaa', state: 'running', host: 'dev', agent: 'codex' },
      { id: 'job-cccc', state: 'queued', host: '?', agent: '?' },
    ]);
  });

  test('model is read only from --model/-m', () => {
    expect(modelOf(['-p', 'hello -m x'])).toBeNull();
    expect(modelOf(['exec', '-m', 'sol', 'p'])).toBe('sol');
    expect(modelOf(['--model=a'])).toBe('a');
  });
});

describe('job registry', () => {
  const deadPid = async (): Promise<number> => {
    const p = Bun.spawn(['true']);
    await p.exited;
    return p.pid;
  };
  const put = (j: Partial<Job> & { id: string }): string => {
    mkdirSync(jobsDir, { recursive: true });
    const f = join(jobsDir, `${j.id}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        title: 't',
        card: null,
        log: null,
        cwd: '/',
        kind: 'other',
        model: null,
        wrapper_pid: process.pid,
        pid: process.pid,
        started_at: '2026-10-10T10:00:00.000Z',
        state: 'running',
        ...j,
      })
    );
    return f;
  };
  const NOW = Date.parse('2026-10-10T12:00:00Z');

  test('GC removes jobs ended over 24h ago; dead running jobs become lost; bad files are reported', async () => {
    expect(readJobs(NOW)).toEqual({ jobs: [], bad: [] }); // 目录还不存在
    const dead = await deadPid();
    const old = put({ id: 'a-old', state: 'done', exit_code: 0, ended_at: '2026-10-09T11:00:00Z' });
    put({ id: 'b-live', started_at: '2026-10-10T11:00:00.000Z' });
    const lost = put({ id: 'c-lost', pid: dead, wrapper_pid: dead });
    writeFileSync(join(jobsDir, 'd-bad.json'), '{');
    const r = readJobs(NOW);
    expect(existsSync(old)).toBe(false);
    expect(r.jobs.map(j => [j.id, j.state])).toEqual([
      ['b-live', 'running'],
      ['c-lost', 'lost'],
    ]);
    expect((JSON.parse(readFileSync(lost, 'utf8')) as Job).state).toBe('lost');
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0]).toStartWith('d-bad.json');
  });
});

describe('job exec', () => {
  const run = (args: string[]): ReturnType<typeof Bun.spawn> =>
    Bun.spawn(['bun', 'src/cli.ts', ...args], {
      cwd: WETAMP,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const only = (): Job => {
    const files = readdirSync(jobsDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf8')) as Job;
  };

  test('passes the child exit code through and records it without argv', async () => {
    const p = run(['job', 'exec', '--title', 'three', '--', 'sh', '-c', `exit 3 # ${SECRET}`]);
    expect(await p.exited).toBe(3);
    const j = only();
    expect(j.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect([j.state, j.exit_code, j.kind, j.title]).toEqual(['failed', 3, 'other', 'three']);
    expect(JSON.stringify(j)).not.toContain(SECRET);
    const ls = run(['jobs', '--json']);
    expect(await ls.exited).toBe(0);
    const out = JSON.parse(await new Response(ls.stdout as ReadableStream).text()) as {
      jobs: Job[];
    };
    expect(out.jobs.map(x => x.id)).toEqual([j.id]);
  });

  test('forwards SIGTERM to the child and exits 128+15', async () => {
    const p = run(['job', 'exec', '--title', 'sleepy', '--', 'sleep', '20']);
    let j: Job | undefined;
    for (let i = 0; i < 100 && !j; i++) {
      await Bun.sleep(50);
      if (existsSync(jobsDir) && readdirSync(jobsDir).some(f => f.endsWith('.json'))) j = only();
    }
    expect(j?.state).toBe('running');
    p.kill('SIGTERM');
    expect(await p.exited).toBe(143);
    const end = only();
    expect([end.state, end.signal, end.exit_code]).toEqual(['failed', 'SIGTERM', undefined]);
    expect(() => process.kill(end.pid, 0)).toThrow();
  });

  test('usage errors exit 64', async () => {
    expect(await run(['job', 'exec', '--', 'true']).exited).toBe(64); // 缺 --title
    expect(await run(['job', 'exec', '--title', 't']).exited).toBe(64); // 缺命令
  });
});

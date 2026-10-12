import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
// prettier-ignore
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { etimeS, parseLsof, parsePs, parseQueue, psRows } from '../src/board/activity';
import { modelOf, projectJob, readJobs, recent, roleOf, type Job } from '../src/jobs';
import { loadTiers } from '../src/config';
import { gitRepo, sh, tmp } from './helpers';

const WETAMP = join(import.meta.dir, '..');
// prettier-ignore
const ENV_KEYS = ['SUPERAGENT_HOME', 'ARCHON_HOME', 'SUPERAGENT_RELAY_QUOTA_URL', 'SUPERAGENT_RELAY_QUOTA'] as const;
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
    SUPERAGENT_RELAY_QUOTA_URL: '',
    SUPERAGENT_RELAY_QUOTA: '',
  });
  jobsDir = join(root, 'home', 'jobs');
});

const SECRET = 'PROMPT-SECRET-do-not-leak';

describe('ps parsing', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z');
  // pid ppid tty %cpu etime command
  const PS = [
    '    1     0 ??       0.0 10-02:00:00 /sbin/launchd',
    '  100     1 ttys001  0.0    01:00:00 -zsh',
    `  200   100 ttys001  0.0       05:00 claude -p --model claude-opus-5-5 ${SECRET}`,
    '  300   100 ttys001  0.0       02:00 bun /x/superagent_v2/packages/cli/src/cli.ts workflow run wf',
    `  301   300 ttys001  0.0       01:59 claude --print ${SECRET}`,
    `  400   100 ttys001  0.0       00:30 node /opt/bin/codex exec -m gpt-6.1-sol ${SECRET}`,
    `  401   400 ttys001  0.0       00:29 /opt/lib/codex/codex exec -m gpt-6.1-sol ${SECRET}`,
    '  500   100 ttys001  0.0       00:10 bun /w/wetamp/src/cli.ts job exec --title t -- claude -p x',
    `  501   500 ttys001  0.0       00:09 claude -p ${SECRET}`,
    `  600   100 ttys001  0.0       00:05 opencode run --model=qwen ${SECRET}`,
    '  700   100 ttys001  0.0       00:04 claude --model claude-opus-5-5', // 交互式，不算
    '  800   100 ??       0.0       00:03 codex -c x', // archon 的 codex 不带 exec
    'garbage line',
  ].join('\n');

  test('finds headless claude/codex/opencode; skips archon children, wrapper children and launcher dups', () => {
    const rows = psRows(PS);
    expect(rows.size).toBe(12);
    expect(rows.get(400)).toMatchObject({ ppid: 100, tty: 'ttys001', cpu: 0, etime: 30 });
    const procs = parsePs(rows, NOW, new Set([500]));
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
    expect(parseLsof('p200\nfcwd\nn/Users/y/wt-caps\nf3\nn/dev/null\np400\nfcwd\nn/tmp\n')).toEqual(
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

  // prettier-ignore
  test('stalled and ETA are read-only projections using role and kind history', () => {
    const log = join(tmp(), 'output'); writeFileSync(log, ''); utimesSync(log, NOW / 1000 - 601, NOW / 1000 - 601);
    const file = put({ id: 'live', log, role: 'general', started_at: new Date(NOW - 700_000).toISOString() });
    const bytes = readFileSync(file, 'utf8'), j = readJobs(NOW, true).jobs[0];
    const history = [100, 300, 900].map(s => ({ ...j, log: null, state: 'done' as const, ended_at: new Date(Date.parse(j.started_at) + s * 1000).toISOString() }));
    expect(projectJob(j, [...history, { ...history[2], kind: 'codex' }], NOW)).toMatchObject({ state: 'running', stalled: true, eta: new Date(NOW - 400_000).toISOString() });
    utimesSync(log, NOW / 1000, NOW / 1000);
    expect(projectJob(j, [], NOW)).toMatchObject({ stalled: false });
    expect(projectJob(j, [], NOW).eta).toBeUndefined(); expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  test('read-only reads expose lost state without rewriting or deleting records', () => {
    const old = put({ id: 'old-readonly', state: 'done', ended_at: '2026-10-09T11:00:00Z' });
    const lost = put({ id: 'lost-readonly', pid: 99999999, wrapper_pid: 99999999 });
    const bytes = readFileSync(lost, 'utf8');
    expect(
      readJobs(NOW, true)
        .jobs.map(j => j.state)
        .sort()
    ).toEqual(['done', 'lost']);
    expect(existsSync(old)).toBe(true);
    expect(readFileSync(lost, 'utf8')).toBe(bytes);
  });

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

  test('queued remains active while its wrapper lives; only a dead owner becomes lost', () => {
    put({ id: 'queued', state: 'queued', pid: 0, reason: 'memory' });
    put({ id: 'orphan', state: 'queued', pid: 0, wrapper_pid: 99999999 });
    const jobs = readJobs(NOW).jobs;
    expect(jobs.find(j => j.id === 'queued')?.state).toBe('queued');
    expect(recent(jobs.find(j => j.id === 'queued')!, NOW)).toBe(true);
    expect(jobs.find(j => j.id === 'orphan')?.state).toBe('lost');
  });
});

describe('job exec', () => {
  // prettier-ignore
  const run = (args: string[], role = '', cwd = WETAMP, extraEnv = {}): ReturnType<typeof Bun.spawn> =>
    Bun.spawn(['bun', join(WETAMP, 'src/cli.ts'), ...args], {
      cwd,
      env: { ...process.env, SUPERAGENT_ROLE: role, SA_ADMIT: 'off', ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const only = (): Job => {
    const files = readdirSync(jobsDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(jobsDir, files[0]), 'utf8')) as Job;
  };
  const running = async (): Promise<Job | undefined> => {
    let j: Job | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(jobsDir) && readdirSync(jobsDir).some(f => f.endsWith('.json'))) {
        j = only();
        if (j.state === 'running') return j;
      }
      await Bun.sleep(50);
    }
    return j;
  };
  // prettier-ignore
  test('budget-refresh: stale jobs and missing models cache refresh; failures do not block dispatch', async () => {
    const root = tmp(), cache = join(process.env.SUPERAGENT_HOME!, 'relay-quota.json'); let calls = 0, status = 200;
    for (const name of ['security', 'codex']) { const path = join(root, name); writeFileSync(path, `#!/bin/sh\nprintf '%s' '${name === 'security' ? 'synthetic' : 'dispatched'}'\n`); chmodSync(path, 0o755); }
    const server = Bun.serve({ port: 0, fetch() { calls++; return Response.json({ platforms: { anthropic: { today: { cost: loadTiers().routing.budget.claude_daily_usd } } } }, { status }); } });
    const env = { PATH: `${root}:${process.env.PATH!}`, SUPERAGENT_RELAY_QUOTA_URL: server.url.origin, SUPERAGENT_RELAY_QUOTA: '' }; mkdirSync(process.env.SUPERAGENT_HOME!, { recursive: true });
    try {
      writeFileSync(cache, JSON.stringify({ at: Date.now() - 3600e3 - 1, claude_daily_usd: 0 }));
      const job = run(['job', 'exec', '--title', 'refresh', '--role', 'commander', '--', join(root, 'codex'), 'exec'], '', WETAMP, env); expect(await job.exited).toBe(0); expect(await new Response(job.stdout as ReadableStream).text()).toBe('dispatched'); expect(calls, await new Response(job.stderr as ReadableStream).text()).toBe(1);
      unlinkSync(cache); const models = run(['models', '--json'], '', WETAMP, env); expect(await models.exited).toBe(0); expect(JSON.parse(await new Response(models.stdout as ReadableStream).text()).budget.degraded).toBe(true); expect(calls).toBe(2);
      expect(await run(['models', '--json'], '', WETAMP, env).exited).toBe(0); expect(calls).toBe(2);
      status = 503; unlinkSync(cache); const failed = run(['job', 'exec', '--title', 'advisory', '--', 'true'], '', WETAMP, env); expect(await failed.exited).toBe(0); expect(await new Response(failed.stderr as ReadableStream).text()).toContain('预算状态未知'); expect(calls).toBe(3);
    } finally { server.stop(true); }
  });
  // prettier-ignore
  test('explicit role injects the models route and rejects mismatched or empty vendor routes', async () => {
    const root = tmp(), codex = join(root, 'codex'), claude = join(root, 'claude');
    for (const path of [codex, claude]) { writeFileSync(path, '#!/usr/bin/env bun\nimport { parseArgs } from "node:util";\nconst args = process.argv.slice(2); if (process.argv[1].endsWith("/claude")) parseArgs({ args, options: { model: { type: "string" }, print: { type: "boolean", short: "p" } } });\nconsole.log(JSON.stringify(args));\n'); chmodSync(path, 0o755); } // R1-2: enforce Claude option syntax.
    const models = run(['models', '--json']); expect(await models.exited).toBe(0);
    const routes = JSON.parse(await new Response(models.stdout as ReadableStream).text());
    for (const role of ['general', 'strategist']) {
      const p = run(['job', 'exec', '--title', role, '--role', role, '--', codex, 'exec', 'prompt']);
      expect(await p.exited).toBe(0); const args = JSON.parse(await new Response(p.stdout as ReadableStream).text());
      expect(args[args.indexOf('--model') + 1]).toBe(routes.claude[role].find((m: string) => m.startsWith('gpt-')));
      expect(routes.codex[role]).toContain(args[args.indexOf('--model') + 1]);
    }
    for (const cmd of [[codex, 'exec', '-m', 'unconfigured'], [claude, '-p']]) {
      const p = run(['job', 'exec', '--title', 'bad', '--role', 'general', '--', ...cmd]);
      expect(await p.exited).not.toBe(0); expect(await new Response(p.stderr as ReadableStream).text()).toContain('candidates:');
    }
    const p = run(['job', 'exec', '--title', 'explicit', '--role', 'general', '--mode', 'single:claude', '--', claude, '-p']);
    expect(await p.exited).toBe(0); expect(await new Response(p.stdout as ReadableStream).text()).toContain(loadTiers().routing.coder.models.find(m => m.startsWith('claude-'))!);
    writeFileSync(join(process.env.SUPERAGENT_HOME!, 'relay-quota.json'), JSON.stringify({ at: Date.now(), claude_daily_usd: loadTiers().routing.budget.claude_daily_usd }));
    const downgraded = run(['job', 'exec', '--title', 'budget', '--role', 'strategist', '--', claude, '-p']);
    expect(await downgraded.exited).not.toBe(0); expect(await new Response(downgraded.stderr as ReadableStream).text()).toContain('candidates:');
  });
  // prettier-ignore
  test('clean refuses dirty or unintegrated worktrees and removes only integrated registered work', async () => {
    const repo = gitRepo(tmp()); expect(await run(['job', 'exec', '--title', 'tree', '--worktree', 'task/entry', '--base', 'main', '--', 'pwd'], '', repo).exited).toBe(0);
    const j = only(), w = j.worktree!, clean = () => run(['job', 'clean', j.id]); expect(j.cwd).toBe(w.path); expect(existsSync(w.path)).toBe(true);
    writeFileSync(join(w.path, 'new'), 'patch'); expect(await clean().exited).not.toBe(0);
    sh('git add new && git -c user.name=t -c user.email=t@l commit -qm patch', w.path);
    expect(await clean().exited).not.toBe(0); expect(existsSync(w.path)).toBe(true);
    writeFileSync(join(repo, 'other'), 'base'); sh('git add other && git -c user.name=t -c user.email=t@l commit -qm base && git -c user.name=t -c user.email=t@l cherry-pick task/entry', repo);
    writeFileSync(join(w.path, 'dirty'), 'dirty'); expect(await clean().exited).not.toBe(0); unlinkSync(join(w.path, 'dirty'));
    sh('git -c user.name=t -c user.email=t@l merge --no-ff --no-edit task/entry', repo); sh('git -c user.name=t -c user.email=t@l merge --no-ff --no-commit main', w.path); writeFileSync(join(w.path, 'merge-only'), 'unique'); sh('git add merge-only && git -c user.name=t -c user.email=t@l commit -qm merge', w.path); // R1-1
    expect(sh('git cherry main task/entry', repo).trim()).toBe(''); expect(await clean().exited).not.toBe(0); expect(existsSync(w.path)).toBe(true); expect(only().worktree).toEqual(w);
    sh('git merge --ff-only task/entry', repo);
    expect(await clean().exited).toBe(0); expect(existsSync(w.path)).toBe(false);
    expect(sh('git branch --list task/entry', repo).trim()).toBe(''); expect(only().worktree).toBeUndefined();
  });

  test('passes the child exit code through and records it without argv', async () => {
    const p = run(['job', 'exec', '--title', 'three', '--', 'sh', '-c', `exit 3 # ${SECRET}`]);
    expect(await p.exited).toBe(3);
    const j = only();
    expect(j.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect([j.state, j.exit_code, j.kind, j.title, j.role]).toEqual([
      'failed',
      3,
      'other',
      'three',
      null,
    ]);
    expect(JSON.stringify(j)).not.toContain(SECRET);
    const ls = run(['jobs', '--json']);
    expect(await ls.exited).toBe(0);
    const out = JSON.parse(await new Response(ls.stdout as ReadableStream).text()) as {
      jobs: Job[];
    };
    expect(out.jobs.map(x => x.id)).toEqual([j.id]);
  });

  test('the child never inherits stdin, so a headless agent cannot block reading it', async () => {
    const p = Bun.spawn(['bun', 'src/cli.ts', 'job', 'exec', '--title', 'stdin', '--', 'cat'], {
      cwd: WETAMP,
      env: { ...process.env, SUPERAGENT_ROLE: '', SA_ADMIT: 'off' },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await p.exited).toBe(0);
  });

  test('forwards SIGTERM to the child and exits 128+15', async () => {
    const p = run(['job', 'exec', '--title', 'sleepy', '--', 'sleep', '20']);
    try {
      expect((await running())?.state).toBe('running');
      p.kill('SIGTERM');
      expect(await p.exited).toBe(143);
      const end = only();
      expect([end.state, end.signal, end.exit_code]).toEqual(['failed', 'SIGTERM', undefined]);
      expect(() => process.kill(end.pid, 0)).toThrow();
    } finally {
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  });

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGINT', 130],
  ] as const) {
    test(`wrapper ${signal} is failed even when the child traps it and exits 0`, async () => {
      const ready = join(jobsDir, '..', 'ready');
      const p = run([
        'job',
        'exec',
        '--title',
        'trap',
        '--',
        'bash',
        '-c',
        'trap \'kill "$worker"; wait "$worker"; exit 0\' TERM HUP INT; sleep 30 & worker=$!; touch "$1"; wait "$worker"',
        '_',
        ready,
      ]);
      try {
        expect((await running())?.state).toBe('running');
        for (const deadline = Date.now() + 5000; !existsSync(ready) && Date.now() < deadline; )
          await Bun.sleep(25);
        expect(existsSync(ready)).toBe(true); // The trap is installed before signalling the wrapper.
        p.kill(signal);
        expect(await p.exited).toBe(code);
        expect(only()).toMatchObject({ state: 'failed', signal, exit_code: code });
        expect(only().ended_at).toBeDefined();
        expect(() => process.kill(only().pid, 0)).toThrow();
      } finally {
        if (p.exitCode === null) {
          p.kill('SIGTERM');
          await p.exited;
        }
      }
    });
  }

  test('a signal sent only to the child preserves its existing signal exit semantics', async () => {
    const p = run(['job', 'exec', '--title', 'child-only', '--', 'sleep', '20']);
    try {
      const j = await running();
      expect(j?.state).toBe('running');
      process.kill(j!.pid, 'SIGTERM');
      expect(await p.exited).toBe(143);
      expect([only().state, only().signal, only().exit_code]).toEqual([
        'failed',
        'SIGTERM',
        undefined,
      ]);
    } finally {
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  });

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGINT', 130],
  ] as const) {
    for (const window of ['spawn-return', 'child-exited'] as const) {
      test(`HF8b short child: pending ${signal} during ${window} fails before terminal save`, async () => {
        // A separate wrapper receives real OS signals while synchronous work prevents delivery.
        const script = `
          import { jobCli } from './src/jobs';
          const spawn = Bun.spawn;
          let delivered = false;
          process.on('${signal}', () => { delivered = true; });
          const interrupt = () => {
            process.kill(process.pid, '${signal}');
            // Hold delivery until the 30ms child has surely exited; at 80ms a loaded host still had it running,
            // so the forwarded signal killed it and the run took the (correct) signal-only path instead.
            const until = Date.now() + 500;
            while (Date.now() < until) {}
          };
          Bun.spawn = (...args) => {
            const child = spawn(...args);
            if (args[0][0] !== '/bin/sleep') return child;
            if ('${window}' === 'spawn-return') { interrupt(); return child; }
            const exited = child.exited.then(code => { interrupt(); return code; });
            return new Proxy(child, { get(target, key) {
              if (key === 'exited') return exited;
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }});
          };
          const code = await jobCli(['job', 'exec', '--title', 'short', '--', '/bin/sleep', '0.03']);
          console.log(JSON.stringify({ delivered }));
          process.exit(code);
        `;
        const p = Bun.spawn(['bun', '-e', script], {
          cwd: WETAMP,
          env: { ...process.env, SA_ADMIT: 'off' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        try {
          expect(await p.exited).toBe(code);
          expect(JSON.parse(await new Response(p.stdout).text())).toEqual({ delivered: true });
          expect(only()).toMatchObject({ state: 'failed', signal, exit_code: code });
          expect(only().ended_at).toBeDefined();
          expect(() => process.kill(only().pid, 0)).toThrow();
        } finally {
          if (p.exitCode === null) {
            p.kill('SIGTERM');
            await p.exited;
          }
        }
      });
    }
  }

  test('HF8b signals delivered after the commit boundary leave done/0 unchanged', async () => {
    const p = Bun.spawn(
      [
        'bun',
        '-e',
        `
      import { readFileSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { jobCli } from './src/jobs';
      const code = await jobCli(['job', 'exec', '--title', 'normal', '--', '/bin/sleep', '0.03']);
      const dir = join(process.env.SUPERAGENT_HOME, 'jobs');
      const file = join(dir, readdirSync(dir)[0]);
      const before = readFileSync(file, 'utf8');
      const listeners = process.listenerCount('SIGTERM');
      process.on('SIGTERM', () => {});
      process.kill(process.pid, 'SIGTERM');
      await Bun.sleep(25);
      console.log(JSON.stringify({ code, listeners, unchanged: before === readFileSync(file, 'utf8') }));
    `,
      ],
      { cwd: WETAMP, env: { ...process.env, SA_ADMIT: 'off' }, stdout: 'pipe', stderr: 'pipe' }
    );
    try {
      expect(await p.exited).toBe(0);
      expect(JSON.parse(await new Response(p.stdout).text())).toEqual({
        code: 0,
        listeners: 0,
        unchanged: true,
      });
      expect(only()).toMatchObject({ state: 'done', exit_code: 0 });
      expect(only().signal).toBeUndefined();
    } finally {
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  });

  for (const outcome of ['done', 'catch'] as const) {
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ] as const) {
      for (const phase of ['before-write', 'before-rename', 'after-rename'] as const) {
        test(`HF8c commit boundary: ${outcome} ${phase} ${signal}`, async () => {
          // Mock fs only in this subprocess; every write/rename and OS signal remains real.
          const p = Bun.spawn(
            [
              'bun',
              '-e',
              `
            import { mock } from 'bun:test';
            import * as fs from 'node:fs';
            const original = { ...fs };
            let injected = false, delivered = false, terminalPath = '', stateAtSignal = '';
            process.on('${signal}', () => { delivered = true; });
            function interrupt() {
              injected = true;
              stateAtSignal = JSON.parse(original.readFileSync(terminalPath, 'utf8')).state;
              process.kill(process.pid, '${signal}');
              const until = Date.now() + 80;
              while (Date.now() < until) {}
            }
            mock.module('node:fs', () => ({ ...original,
              writeFileSync: (...args) => {
                if (!injected && typeof args[1] === 'string' && JSON.parse(args[1]).ended_at) {
                  terminalPath = String(args[0]).replace(/\\.\\d+\\.tmp$/, '');
                  if ('${phase}' === 'before-write') interrupt();
                }
                return original.writeFileSync(...args);
              },
              renameSync: (from, to) => {
                const terminal = terminalPath === String(to);
                if (terminal && !injected && '${phase}' === 'before-rename') interrupt();
                const result = original.renameSync(from, to);
                if (terminal && !injected && '${phase}' === 'after-rename') interrupt();
                return result;
              }
            }));
            const { jobCli } = await import('./src/jobs');
            const code = await jobCli(['job', 'exec', '--title', 'commit-window', '--', '/bin/sleep', '0.03']);
            console.log(JSON.stringify({ code, injected, delivered, stateAtSignal,
              listeners: ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s)) }));
            process.exit(code);
          `,
            ],
            {
              cwd: WETAMP,
              env: {
                ...process.env,
                SA_ADMIT: outcome === 'catch' ? 'on' : 'off',
                SA_ADMIT_MIN_FREE: outcome === 'catch' ? 'invalid' : '',
              },
              stdout: 'pipe',
              stderr: 'pipe',
            }
          );
          try {
            expect(await p.exited).toBe(code);
            expect(JSON.parse(await new Response(p.stdout).text())).toEqual({
              code,
              injected: true,
              delivered: true,
              stateAtSignal:
                phase === 'after-rename'
                  ? outcome === 'catch'
                    ? 'failed'
                    : 'done'
                  : outcome === 'catch'
                    ? 'queued'
                    : 'running',
              listeners:
                signal === 'SIGINT' ? [1, 0, 0] : signal === 'SIGTERM' ? [0, 1, 0] : [0, 0, 1],
            });
            expect(only()).toMatchObject({ state: 'failed', signal, exit_code: code });
            expect(only().ended_at).toBeDefined();
            if (outcome === 'catch') expect(only().pid).toBe(0);
            else expect(() => process.kill(only().pid, 0)).toThrow();
          } finally {
            if (p.exitCode === null) {
              p.kill('SIGTERM');
              await p.exited;
            }
          }
        });
      }
    }
  }

  test('HF8c commit boundary: no signal keeps a short child done/0', async () => {
    expect(await run(['job', 'exec', '--title', 'short', '--', '/bin/sleep', '0.03']).exited).toBe(
      0
    );
    expect(only()).toMatchObject({ state: 'done', exit_code: 0 });
    expect(only().signal).toBeUndefined();
  });

  test('HF8c commit boundary: post-return SIGTERM uses default termination and preserves done/0', async () => {
    const p = Bun.spawn(
      [
        'bun',
        '-e',
        `
      import { readFileSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { jobCli } from './src/jobs';
      const code = await jobCli(['job', 'exec', '--title', 'short', '--', '/bin/sleep', '0.03']);
      const dir = join(process.env.SUPERAGENT_HOME, 'jobs');
      const bytes = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
      console.log(JSON.stringify({ code, bytes,
        listeners: ['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => process.listenerCount(s)) }));
      process.kill(process.pid, 'SIGTERM');
      await Bun.sleep(5000);
      process.exit(99);
    `,
      ],
      { cwd: WETAMP, env: { ...process.env, SA_ADMIT: 'off' }, stdout: 'pipe', stderr: 'pipe' }
    );
    try {
      expect(await p.exited).toBe(143);
      expect(p.signalCode).toBe('SIGTERM');
      const result = JSON.parse(await new Response(p.stdout).text()) as {
        code: number;
        bytes: string;
        listeners: number[];
      };
      expect(result.code).toBe(0);
      expect(result.listeners).toEqual([0, 0, 0]);
      expect(readFileSync(join(jobsDir, `${only().id}.json`), 'utf8')).toBe(result.bytes);
      expect(only()).toMatchObject({ state: 'done', exit_code: 0 });
      expect(only().signal).toBeUndefined();
    } finally {
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        await p.exited;
      }
    }
  });

  test('role: --role wins, else SUPERAGENT_ROLE general/reviewer; shown in `jobs`; old records without it still list', async () => {
    expect(roleOf(undefined, { SUPERAGENT_ROLE: 'general' })).toBe('general');
    expect(roleOf(undefined, { SUPERAGENT_ROLE: 'reviewer' })).toBe('strategist');
    expect(roleOf(undefined, { SUPERAGENT_ROLE: 'coder' })).toBeNull();
    expect(roleOf('commander', { SUPERAGENT_ROLE: 'reviewer' })).toBe('commander');
    expect(await run(['job', 'exec', '--title', 'r', '--', 'true'], 'reviewer').exited).toBe(0);
    expect(only().role).toBe('strategist');
    const old = { ...only(), id: '20261010-000000-0000', role: undefined };
    writeFileSync(join(jobsDir, `${old.id}.json`), JSON.stringify(old));
    const ls = run(['jobs', '--all']);
    expect(await ls.exited).toBe(0);
    const lines = (await new Response(ls.stdout as ReadableStream).text()).trim().split('\n');
    expect(lines.find(l => l.includes(old.id))).toMatch(/ other - - r$/);
    expect(lines.find(l => !l.includes(old.id))).toMatch(/ other - strategist r$/);
    expect(await run(['job', 'exec', '--title', 't', '--role', 'admin', '--', 'true']).exited).toBe(
      64
    );
  });

  test('usage errors exit 64', async () => {
    expect(await run(['job', 'exec', '--', 'true']).exited).toBe(64); // 缺 --title
    expect(await run(['job', 'exec', '--title', 't']).exited).toBe(64); // 缺命令
  });
});

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmp } from './helpers';

const modulePath = join(import.meta.dir, '../hooks/heartbeat-panel.cjs');
const panel = createRequire(import.meta.url)(modulePath) as {
  ensurePanel: (payload: object, env: Record<string, string>) => boolean;
};

function fixture(mode: 'record' | 'nested' | 'empty' | 'fail' = 'empty') {
  const root = tmp(),
    repo = join(root, 'repo'),
    home = join(root, 'home'),
    bin = join(root, 'bin'),
    calls = join(root, 'calls.jsonl');
  const gitDir = join(root, 'superagent_v2/.git/worktrees/repo');
  mkdirSync(repo, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(repo, '.git'), `gitdir: ${gitDir}\n`);
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'orca'),
    `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),mode=process.env.FAKE_MODE;
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(a)+'\\n');
if(mode==='fail'){process.stderr.write('orca failed');process.exit(2)}
if(a[1]==='list'){
 const handle=mode==='record'?'saved':mode==='nested'?'adopted':null;
 const terminal=handle?[{handle,connected:true,orphaned:false}]:[];
 const visualLayouts=mode==='nested'?[{root:{groups:[{tabs:[{title:'心跳·repo',panes:[{handle:'adopted'}]}]}]}}]:[];
 console.log(JSON.stringify({result:{terminals:terminal,visualLayouts}}));
}else console.log(JSON.stringify({result:{terminal:{handle:'created'}}}));
`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    SUPERAGENT_HOME: home,
    ORCA_CLI_BIN_DIR: bin,
    FAKE_CALLS: calls,
    FAKE_MODE: mode,
  } as Record<string, string>;
  return { repo, home, calls, env };
}

const run = (f: ReturnType<typeof fixture>) =>
  Bun.spawnSync([process.execPath, modulePath, 'ensure', f.repo], {
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
const invocations = (file: string): string[][] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
const record = (home: string, repo: string) =>
  join(home, 'panels', `${createHash('sha256').update(repo).digest('hex')}.json`);

test('ensurePanel only detaches inside Orca and a git worktree', () => {
  const root = tmp();
  expect(panel.ensurePanel({ cwd: root }, {})).toBe(false);
  expect(panel.ensurePanel({ cwd: root }, { ORCA_AGENT_SESSION_ID: 's' })).toBe(false);
});

test('recorded live handles are reused and nested heartbeat tabs are adopted', () => {
  const saved = fixture('record');
  mkdirSync(join(saved.home, 'panels'), { recursive: true });
  writeFileSync(record(saved.home, saved.repo), JSON.stringify({ handle: 'saved' }));
  expect(run(saved).exitCode).toBe(0);
  expect(invocations(saved.calls).map(call => call[1])).toEqual(['list']);

  const nested = fixture('nested');
  expect(run(nested).exitCode).toBe(0);
  expect(invocations(nested.calls).map(call => call[1])).toEqual(['list']);
  expect(JSON.parse(readFileSync(record(nested.home, nested.repo), 'utf8')).handle).toBe('adopted');
});

test('concurrent ensures create once with the right command and failures stay contained', async () => {
  const fresh = fixture();
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, modulePath, 'ensure', fresh.repo], {
      env: fresh.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  );
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
  const calls = invocations(fresh.calls),
    creates = calls.filter(call => call[1] === 'create');
  expect(creates).toHaveLength(1);
  expect(creates[0]).toContain(`path:${fresh.repo}`);
  expect(creates[0]).toContain(`心跳·superagent_v2`);
  expect(creates[0].join(' ')).toContain(`'heartbeat' '--watch' '--cwd' '${fresh.repo}'`);
  expect(creates[0].join(' ')).toContain(`bin/superagent-shim' 'heartbeat'`);
  const generated = creates[0][creates[0].indexOf('--command') + 1]!;
  expect(generated).toContain('case $? in 75) continue;; esac');
  expect(generated).toContain("echo '心跳面板暂不可用，60 秒后重试'; sleep 60");
  const fake = join(fresh.home, 'fake'),
    marker = join(fresh.home, 'restarted');
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf x >> '${marker}'\n[ "$(wc -c < '${marker}')" -eq 1 ] && exit 75\nexit 0\n`,
    { mode: 0o755 }
  );
  const proof = generated
    .replace(/'[^']*superagent-shim'/, `'${fake}'`)
    .replace('sleep 60', 'break');
  const shells = ['/bin/sh', 'bash', ...(existsSync('/bin/zsh') ? ['/bin/zsh'] : [])];
  for (const shell of shells) {
    writeFileSync(marker, '');
    const args = shell === '/bin/zsh' ? [shell, '-f', '-i', '-c', proof] : [shell, '-c', proof],
      result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('xx');
    expect(result.stderr.toString()).not.toMatch(/read-only/i);
  }

  const failed = fixture('fail');
  expect(run(failed).exitCode).toBe(0);
  expect(readFileSync(join(failed.home, 'logs/heartbeat-panel.log'), 'utf8')).toContain(
    'orca failed'
  );
});

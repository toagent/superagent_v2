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

function fixture(
  mode:
    | 'restored'
    | 'lateConnect'
    | 'latePinned'
    | 'connecting'
    | 'live'
    | 'empty'
    | 'codeFail' = 'empty'
) {
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
if(a[1]==='close'&&(((mode==='restored'||mode==='lateConnect')&&a[3]==='restored')||(mode==='latePinned'&&a[3]==='late'))){console.log(JSON.stringify({ok:false,error:{code:'terminal_tab_pinned'}}));process.exit(1)}
if(a[1]==='close'&&mode==='codeFail'){console.log(JSON.stringify({ok:false,error:{code:'terminal_close_failed'}}));process.exit(2)}
if(a[1]==='list'){
 const calls=fs.readFileSync(process.env.FAKE_CALLS,'utf8').trim().split('\\n').map(JSON.parse),n=calls.filter(x=>x[1]==='list').length;
 const handles=mode==='live'?['saved','duplicate','other']:(mode==='restored'||mode==='lateConnect')?['restored']:mode==='latePinned'?(n===1?[]:n===2?['created']:['created','late']):mode==='connecting'?(n===1?[]:n===2?['created']:['created','late']):mode==='codeFail'?['duplicate']:(n===1?[]:['created']);
 const incarnationId=h=>h==='saved'?'current':h==='restored'?'old':h+'-incarnation';
 const terminals=handles.map(handle=>({handle,incarnationId:incarnationId(handle),connected:(mode!=='connecting'||handle!=='created')&&(mode!=='lateConnect'||n>1),orphaned:false}));
 const visualLayouts=[{root:{groups:[{tabs:handles.map(handle=>({title:handle==='other'?'心跳·other':'心跳·superagent_v2',panes:[{handle}]}))}]}}];
 console.log(JSON.stringify({result:{terminals,visualLayouts}}));
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
  Bun.spawnSync([process.execPath, modulePath, 'ensure', f.repo, '0'], {
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

test('pinned restored panel is re-armed in place', () => {
  const restored = fixture('restored');
  mkdirSync(join(restored.home, 'panels'), { recursive: true });
  writeFileSync(
    record(restored.home, restored.repo),
    JSON.stringify({ handle: 'restored', incarnationId: 'previous' })
  );
  expect(run(restored).exitCode).toBe(0);
  const calls = invocations(restored.calls);
  expect(calls.map(call => call[1])).toEqual(['list', 'close', 'send']);
  expect(calls[2]).toContain('--enter');
  expect(JSON.parse(readFileSync(record(restored.home, restored.repo), 'utf8'))).toEqual({
    handle: 'restored',
    incarnationId: 'old',
  });
});

test('pinned panel that connects late is re-armed after waiting', () => {
  const restored = fixture('lateConnect');
  expect(run(restored).exitCode).toBe(0);
  const calls = invocations(restored.calls);
  expect(calls.map(call => call[1])).toEqual(['list', 'close', 'list', 'close', 'send']);
  expect(calls.some(call => call[1] === 'create')).toBe(false);
  const saved = JSON.parse(readFileSync(record(restored.home, restored.repo), 'utf8'));
  expect(saved).toEqual({ handle: 'restored', incarnationId: 'old' });
});

test('late pinned panel replaces the created one on rescan', () => {
  const restored = fixture('latePinned');
  expect(run(restored).exitCode).toBe(0);
  const calls = invocations(restored.calls);
  expect(calls.map(call => call[1])).toEqual([
    'list',
    'create',
    'list',
    'list',
    'close',
    'send',
    'close',
  ]);
  expect(calls[5]).toContain('--enter');
  expect(calls[6]).toContain('created');
  expect(JSON.parse(readFileSync(record(restored.home, restored.repo), 'utf8'))).toEqual({
    handle: 'late',
    incarnationId: 'late-incarnation',
  });
});

test('live recorded panel closes duplicates without creating', () => {
  const current = fixture('live');
  mkdirSync(join(current.home, 'panels'), { recursive: true });
  writeFileSync(
    record(current.home, current.repo),
    JSON.stringify({ handle: 'saved', incarnationId: 'current' })
  );
  expect(run(current).exitCode).toBe(0);
  const calls = invocations(current.calls);
  expect(calls.map(call => call[1])).toEqual(['list', 'close']);
  expect(calls[1]).toContain('duplicate');
  expect(calls[1]).toContain('--tab');
});

test('rescan keeps the created panel even before it connects', () => {
  const connecting = fixture('connecting');
  expect(run(connecting).exitCode).toBe(0);
  const closes = invocations(connecting.calls).filter(call => call[1] === 'close');
  expect(closes.map(call => call[3])).toEqual(['late']);
  expect(JSON.parse(readFileSync(record(connecting.home, connecting.repo), 'utf8'))).toEqual({
    handle: 'created',
    incarnationId: 'created-incarnation',
  });
});

test('concurrent ensures create once with the right command and failures stay contained', async () => {
  const fresh = fixture();
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, modulePath, 'ensure', fresh.repo, '0'], {
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

  const failed = fixture('codeFail');
  expect(run(failed).exitCode).toBe(0);
  expect(readFileSync(join(failed.home, 'logs/heartbeat-panel.log'), 'utf8')).toContain(
    'terminal_close_failed'
  );
});

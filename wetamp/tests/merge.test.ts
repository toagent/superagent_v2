import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot } from '@archon/paths';
import { gitRepo, sh, tmp } from './helpers';
import type { Ledger } from '../src/ledger';

const token = () => 'ghp_' + '1234567890abcdef'.repeat(3).slice(0, 36);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// prettier-ignore
function fixture() {
  const root = tmp(), p = gitRepo(root), s = join(root, 'task'), remote = join(root, 'origin.git');
  const home = join(root, 'state'), messageFile = join(root, 'message');
  const git = (cwd: string, args: string) => sh('git ' + args, cwd).trim();
  const head = (cwd: string) => git(cwd, 'rev-parse HEAD');
  const base = head(p);
  git(p, 'branch --set-upstream-to=origin/main');
  git(p, `config core.hooksPath ${quote(join(p, '.git/hooks'))}`);
  git(p, `worktree add -qb task/demo ${quote(s)}`);
  function commit(cwd: string, file: string, message = 'change') {
    fs.writeFileSync(join(cwd, file), message);
    git(cwd, `add -- ${quote(file)} && git commit -qm ${quote(message)}`);
    return head(cwd);
  }
  function advance(file = 'upstream') {
    const clone = join(root, 'sender');
    git(root, `clone -q ${quote(remote)} ${quote(clone)}`);
    git(clone, 'config user.name t && git config user.email t@l');
    const tip = commit(clone, file);
    git(clone, 'push -q origin main');
    return tip;
  }
  fs.mkdirSync(home);
  fs.writeFileSync(messageFile, '合并任务说明\n');
  const ledgers: Ledger[] = [], calls: string[] = [];
  let state = 'completed';
  const t0 = commit(s, 'task', '只在历史中保留的夹具叙述');
  const run = async (options: { dryRun?: boolean; accept?: string[] } = {}) => {
    const { mergeTask } = await import('../src/merge');
    return mergeTask(s, { messageFile, accept: ['true'], ...options }, {
      home, ledgers: () => { calls.push('ledger'); return ledgers; },
      state: () => { if (state === 'unreadable') throw new Error('unavailable'); return state; },
      receipts: () => [join(getRunArtifactsDirForRoot(join(root, 'workspace'), 'native'), 'publish-m1.json')],
      plan: ledger => ledger.plan,
      canMerge: () => true, orca: async () => { calls.push('orca'); },
    });
  };
  function covered(from = base, to = t0) {
    const dir = getRunArtifactsDirForRoot(join(root, 'workspace'), 'native');
    fs.mkdirSync(dir, { recursive: true });
    const plan = join(root, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ packages: [{ accept: [{ cmd: 'false', timeout_s: 30 }] }] }));
    ledgers.push({ run_id: 'r', archon_run_id: 'native', repo: p, plan, delivery: { checkout: s, branch: 'task/demo', head: from } } as Ledger);
    fs.writeFileSync(join(dir, 'publish-m1.json'), JSON.stringify({
      status: 'published', task: 'r', target: { checkout: s, branch: 'task/demo' }, target_tip: from, integrated: to,
    }));
  }
  const intent = (noRun = false) => {
    fs.mkdirSync(join(home, 'intents'));
    const path = join(home, 'intents/r.json');
    fs.writeFileSync(path, JSON.stringify({
      ledger: { run_id: 'r', delivery: { checkout: s }, started_at: '2026-01-01' },
      host: 'fixture', pid: 1, ...(noRun ? { no_run_at: '2026-01-02' } : {}),
    }));
    return path;
  };
  function check(parent = base, task = t0, upstream = base, dirty: string[] = []) {
    expect([head(p), head(s), head(remote)]).toEqual([parent, task, upstream]);
    expect([p, s].filter(path => git(path, 'status --porcelain') !== '')).toEqual(dirty);
  }
  const hook = (name: string, body: string) =>
    fs.writeFileSync(join(p, '.git/hooks', name), '#!/bin/sh\n' + body + '\n', { mode: 0o700 });
  return { root, p, s, remote, home, messageFile, git, head, base, t0, commit, advance, run,
    covered, intent, check, hook, calls, setState: (value: string) => { state = value; } };
}
// prettier-ignore
test('1 远端领先，先对齐再生成双亲合并和说明', async () => {
  const f = fixture(), u = f.advance(), r = await f.run(), c = f.head(f.p);
  expect(r.exit).toBe(0);
  expect(f.git(f.p, 'show -s --format=%P HEAD')).toBe(`${u} ${f.t0}`);
  expect(f.git(f.p, 'show -s --format=%B HEAD')).toBe('合并任务说明');
  f.check(c, c, u);
});
test('2 分叉拒绝；3 父与任务检出有未提交文件时拒绝', async () => {
  const f = fixture(),
    u = f.advance();
  for (const path of [f.p, f.s]) {
    fs.writeFileSync(join(path, 'dirty'), '');
    expect((await f.run()).exit).toBe(3);
    f.check(f.base, f.t0, u, [path]);
    fs.unlinkSync(join(path, 'dirty'));
  }
  const x = f.commit(f.p, 'local');
  expect((await f.run()).exit).toBe(3);
  f.check(x, f.t0, u);
});
test('4 冲突列出文件，父检出只对齐远端', async () => {
  const f = fixture(),
    u = f.advance('task'),
    r = await f.run();
  expect(r.exit).toBe(3);
  expect(JSON.stringify(r.value)).toContain('task');
  expect(f.git(f.p, 'worktree list').split('\n')).toHaveLength(2);
  f.check(u, f.t0, u);
});
test('5 held、paused、状态不可读均拒绝', async () => {
  const f = fixture();
  f.covered();
  for (const state of ['held:human', 'paused', 'unreadable']) {
    f.setState(state);
    expect((await f.run()).exit).toBe(3);
    f.check();
  }
});
test('6 验收失败归档并移除保活 ref，重跑重新组合', async () => {
  const f = fixture(),
    u = f.advance(),
    rejected = await f.run({ accept: ['false'] });
  expect(rejected.exit).toBe(1);
  f.check(u, f.t0, u);
  expect(f.git(f.p, 'for-each-ref refs/superagent/merge')).toBe('');
  const dir = join(f.home, 'merges', fs.readdirSync(join(f.home, 'merges'))[0]);
  const archive = fs.readdirSync(dir).find(x => x.startsWith('failed-'))!;
  const state = JSON.parse(fs.readFileSync(join(dir, archive), 'utf8'));
  expect(state.stage).toBe('rejected');
  expect(f.git(f.p, `branch --contains ${state.C}`)).toBe('');
  fs.writeFileSync(f.messageFile, '重新验收\n');
  expect((await f.run()).exit).toBe(0);
  expect(f.head(f.p)).not.toBe(state.C);
  f.check(f.head(f.p), f.head(f.p), u);
});
// prettier-ignore
test('7 同树且全覆盖跳过验收；8、17 人工提交逐个拦截', async () => {
  const f = fixture(),
    next = f.commit(f.s, 'by-run');
  expect((await f.run({ accept: [] })).exit).toBe(3);
  f.covered(f.t0, next);
  const partial = await f.run({ accept: [] });
  expect(partial.exit).toBe(3);
  expect(JSON.stringify(partial.value)).toContain(f.t0);
  f.check(f.base, next);
  const single = fixture();
  single.covered();
  expect((await single.run({ accept: [] })).exit).toBe(0);
  expect(single.git(single.p, 'show -s --format=%B HEAD')).toBe('合并任务说明');
  single.check(single.head(single.p), single.head(single.p));
});
test('9 拒绝说明中的秘密；18 拒绝 hook 追加的暂存内容', async () => {
  const f = fixture();
  fs.writeFileSync(f.messageFile, token());
  expect((await f.run()).exit).toBe(3);
  f.check();
  fs.writeFileSync(f.messageFile, '合并说明\n');
  f.hook('pre-commit', 'echo changed >README.md && git add README.md');
  expect((await f.run()).exit).toBe(3);
  f.check();
});
// prettier-ignore
test('10 hook 按远端名或 URL 执行 Git 推送均失败', async () => {
  const f = fixture(), second = join(f.root, 'second.git'), marker = join(f.root, 'pushed');
  f.git(f.root, `clone -q --bare ${quote(f.remote)} ${quote(second)}`);
  for (const remote of [f.remote, second]) f.git(f.p, `remote set-url --add --push origin ${quote(remote)}`);
  f.hook('pre-push', `touch ${quote(marker)}`);
  const attempt = join(f.root, 'attempt');
  f.hook('post-commit', `touch ${quote(attempt)}\ngit push origin HEAD:main || :\ngit push ${quote(second)} HEAD:main || :`);
  expect((await f.run()).exit).toBe(0);
  expect(fs.existsSync(attempt)).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
  expect(f.head(second)).toBe(f.base);
  f.check(f.head(f.p), f.head(f.p));
});
// prettier-ignore
test('11 父 CAS、15 父切分支、13 任务检出推进与 12 回滚', async () => {
  for (const change of ['parent', 'switch', 'task'] as const) {
    const f = fixture();
    f.git(f.p, 'branch other');
    const target = change === 'task' ? f.s : f.p;
    const command = change === 'switch' ? 'switch other' : 'commit --allow-empty -qm concurrent';
    const r = await f.run({ accept: [`git -C ${quote(target)} ${command}`] });
    expect(r.exit).toBe(change === 'task' ? 0 : 3);
    if (change === 'switch') {
      expect(JSON.stringify(r.value)).toContain('target_switched');
      expect(f.git(f.p, 'rev-parse main')).toBe(f.base);
      f.check();
    } else if (change === 'parent') {
      expect(f.git(f.p, 'show -s --format=%s HEAD')).toBe('concurrent');
      f.check(f.head(f.p));
    } else {
      expect(JSON.stringify(r.value)).toContain('warnings');
      expect(f.git(f.s, 'show -s --format=%s HEAD')).toBe('concurrent');
      f.check(f.head(f.p), f.head(f.s));
      const rollback = (r.value.rollback as { local?: string }).local!;
      sh(rollback, f.root);
      f.check(f.base, f.head(f.s));
    }
  }
});
test('14 dry-run 脱敏且保留所有 refs、工作区和 Orca', async () => {
  const f = fixture(),
    u = f.advance(token());
  const refs = f.git(f.p, 'show-ref');
  const r = await f.run({ dryRun: true, accept: [`echo ${token()}`] });
  expect(r.exit).toBe(0);
  expect(JSON.stringify(r.value)).not.toContain(token());
  expect(JSON.stringify(r.value)).not.toContain('只在历史中保留的夹具叙述');
  expect(f.calls).not.toContain('orca');
  expect(f.git(f.p, 'show-ref')).toBe(refs);
  f.check(f.base, f.t0, u);
});
// prettier-ignore
test('16 ff 回执异常及 S 已同步异常，恢复不产生第二个 C', async () => {
  for (const phase of ['publish-parent.json', 'active.json']) {
    const f = fixture();
    const rename = fs.renameSync;
    const fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(phase) && f.head(f.p) !== f.base &&
          (phase !== 'active.json' || f.head(f.s) === f.head(f.p))) throw new Error('fixture interruption');
      rename(from, to);
    });
    try { expect((await f.run()).value.status).toBe('published_pending'); }
    finally { fault.mockRestore(); }
    const c = f.head(f.p);
    expect(c).not.toBe(f.base);
    const replay = await f.run();
    expect(replay.exit).toBe(0);
    expect(replay.value.status).not.toBe('noop');
    f.check(c, c);
  }
});
// prettier-ignore
test('19 残留 intent 先于 ledger 短路，含 no_run_at 证据且保留文件', async () => {
  const f = fixture(), path = f.intent(true);
  const r = await f.run();
  expect(r.exit).toBe(3);
  expect(r.value).toMatchObject({ intent: path, run_id: 'r', host: 'fixture', pid: 1, started_at: '2026-01-01', no_run_at: '2026-01-02' });
  expect(f.calls).toEqual([]);
  expect(fs.existsSync(path)).toBe(true);
  f.check();
});
// prettier-ignore
test('20 composed 中断后重验，未通过则保持父检出只对齐远端', async () => {
  const f = fixture(), u = f.advance();
  const spawn = Bun.spawnSync;
  const fault = spyOn(Bun, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (Array.isArray(args[0]) && args[0].includes('true') && args[0].includes('-c'))
      throw new Error('fixture interruption');
    return spawn(...args);
  }) as typeof spawn);
  try { expect((await f.run()).exit).not.toBe(0); }
  finally { fault.mockRestore(); }
  f.check(u, f.t0, u);
  expect((await f.run({ accept: ['false'] })).exit).toBe(1);
  f.check(u, f.t0, u);
});

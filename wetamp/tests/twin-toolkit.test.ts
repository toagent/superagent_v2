import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sh, tmp } from './helpers';

// twin-toolkit 不在本仓库：它是本机 ~/.lan-dev-machine 的双机对齐脚本，superagent 维度
// 消费 verify-local.sh 的结果。这里只做函数级测试——从脚本里抽出函数，远端操作全换成桩，
// 不连任何远端。机器上没有该脚本时整组跳过。
const TOOLKIT = process.env.TWIN_TOOLKIT ?? join(homedir(), '.lan-dev-machine', 'bin', 'twin-toolkit');
const present = existsSync(TOOLKIT);
const source = present ? readFileSync(TOOLKIT, 'utf8') : '';

function slice(start: string, end: string): string {
  const i = source.indexOf(start);
  const j = source.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`twin-toolkit: ${start} not found`);
  return source.slice(i, j);
}

/** 两个提交的临时仓库：old 当远端现有提交，head 当本机待投送提交。 */
function repo() {
  const root = tmp();
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (cmd: string): string => sh(`git -c user.name=t -c user.email=t@l ${cmd}`, dir).trim();
  sh('git init -q -b main', dir);
  writeFileSync(join(dir, 'f'), '1\n');
  git('add f');
  git('commit -qm old');
  const old = git('rev-parse HEAD');
  writeFileSync(join(dir, 'f'), '2\n');
  git('commit -qam head');
  return { root, dir, old, head: git('rev-parse HEAD'), git };
}

describe.skipIf(!present)('twin-toolkit superagent 投送闸', () => {
  function align(opts: { remote: string; receipt?: string; verify: string | null }) {
    const r = repo();
    const calls = join(r.root, 'calls.log');
    writeFileSync(calls, '');
    const verify = join(r.root, 'verify-local.sh');
    if (opts.verify !== null) writeFileSync(verify, opts.verify);
    const fn = slice('align_superagent() {', '\n# ── opencode');
    const script = `set -euo pipefail
REMOTE_HOST=stub REMOTE_HOME=/nowhere REMOTE_BACKUP_ROOT=/nowhere _TMPDIR="$ROOT"
SUPERAGENT_RECEIPT_REL=r SUPERAGENT_LOCK_REL=l SUPERAGENT_MANAGED_CONFIG=c SUPERAGENT_MANAGED_MARKER=m SUPERAGENT_MIRROR_REF=x SUPERAGENT_EXPECTED_ORIGIN=o
superagent_state_script() { :; }; superagent_sync_script() { :; }; superagent_remote_cmd() { :; }
readonly_ssh() { printf 'kind=repo\\nhead=%s\\ndirty=0\\ninstalled=1\\ninstaller=i1\\nreceipt_status=ok\\nreceipt_commit=%s\\nreceipt_installer=i1\\n' "$RHEAD" "$RECEIPT"; }
scp() { echo scp >> "$CALLS"; }
ssh() { echo ssh >> "$CALLS"; printf 'head=%s\\ndirty=0\\n' "$(git -C "$SUPERAGENT_DIR" rev-parse HEAD)"; }
superagent_install() { echo "install $2" >> "$CALLS"; }
${fn}
align_superagent`;
    writeFileSync(join(r.root, 'run.sh'), script);
    const p = Bun.spawnSync(['bash', join(r.root, 'run.sh')], {
      env: {
        ...process.env,
        ROOT: r.root,
        CALLS: calls,
        SUPERAGENT_DIR: r.dir,
        TWIN_SUPERAGENT_VERIFY: verify,
        RHEAD: opts.remote === 'old' ? r.old : r.head,
        RECEIPT: opts.receipt ?? (opts.remote === 'old' ? r.old : r.head),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { ...r, code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls: readFileSync(calls, 'utf8') };
  }

  test('未通过：打印规定文案、rc=0、不投送不安装', () => {
    const a = align({
      remote: 'old',
      verify: 'echo "verify $*" >> "$CALLS"; echo "verify-local: x FAIL (log /v/x.log)"; exit 1\n',
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain(`superagent: 本机未通过 ${a.head.slice(0, 12)}（日志 /v/x.log），暂不投送；远端保持 ${a.old.slice(0, 12)}`);
    expect(a.calls).toBe(`verify --commit ${a.head} --timeout 600\n`);
  });

  test('通过：投送并安装刚验证的提交', () => {
    const a = align({ remote: 'old', verify: 'echo "verify-local: x ok (cached; log /v/x.log)"\n' });
    expect(a.code).toBe(0);
    expect(a.out).toContain(`superagent: verified=${a.head.slice(0, 12)}（日志 /v/x.log）`);
    expect(a.calls).toBe(`scp\nssh\ninstall ${a.head}\n`);
  });

  test('验证期间 HEAD 前移：新提交未验证，不投送', () => {
    const a = align({
      remote: 'old',
      verify: 'git -C "$SUPERAGENT_DIR" -c user.name=t -c user.email=t@l commit -q --allow-empty -m moved; echo "verify-local: x ok (log /v/x.log)"\n',
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain('（未验证），暂不投送；远端保持');
    expect(a.calls).toBe('');
  });

  test('远端已一致：零写入，也不跑验证', () => {
    const a = align({ remote: 'head', verify: 'echo verify >> "$CALLS"; exit 1\n' });
    expect(a.code).toBe(0);
    expect(a.out).toContain('已一致');
    expect(a.calls).toBe('');
  });

  test('缺 verify-local.sh：rc=1 且不投送', () => {
    const a = align({ remote: 'old', verify: null });
    expect(a.code).toBe(1);
    expect(a.out).toContain('无法验证');
    expect(a.calls).toBe('');
  });
});

describe.skipIf(!present)('twin-toolkit superagent 探针与比对段', () => {
  /** 抽出 python 探针 superagent()，在临时 home 下按给定 verify.json 运行。 */
  function probe(verify: (head: string) => object | null) {
    const r = repo();
    const sa = join(r.root, 'sa');
    mkdirSync(sa);
    const v = verify(r.head);
    if (v) writeFileSync(join(sa, 'verify.json'), JSON.stringify(v));
    const fn = slice('def superagent():', '\ndef npm_global');
    const py = `import json, os, subprocess\nhome = ${JSON.stringify(r.root)}\n${fn}\nprint(json.dumps(superagent()))\n`;
    const p = Bun.spawnSync(['python3', '-I', '-c', py], {
      env: { ...process.env, SUPERAGENT_DIR: r.dir, SUPERAGENT_HOME: sa },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return { ...r, s: JSON.parse(p.stdout.toString()) as Record<string, unknown> };
  }

  test('探针：verified 只认通过且等于 HEAD 的结果', () => {
    const a = probe(() => null);
    expect(a.s).toMatchObject({ head: a.head, verified: null, last_ok: null });
    const b = probe(() => ({ commit: 'x', ok: true, last_ok_commit: 'x' }));
    expect(b.s).toMatchObject({ verified: null, last_ok: 'x' });
    const c = probe(head => ({ commit: head, ok: false, last_ok_commit: 'y' }));
    expect(c.s).toMatchObject({ verified: null, last_ok: 'y' });
    const d = probe(head => ({ commit: head, ok: true, last_ok_commit: head }));
    expect(d.s).toMatchObject({ verified: d.head, last_ok: d.head });
  }, 30000);

  /** 抽出比对段，给定本机/远端探针结果，返回输出行与漂移维度。 */
  function compare(L: object, R: object) {
    const block = slice('if "superagent" in DIMS:', '\n# 三端受管协议区块');
    const py = `import json, sys\nL, R = json.loads(sys.argv[1]), json.loads(sys.argv[2])\nDIMS = {"superagent"}\nLABEL = "开发机"\nSUPERAGENT_RECEIPT_REL = "r"\nlines, drift = [], []\n${block}\nprint(json.dumps({"lines": lines, "drift": drift}))\n`;
    const p = Bun.spawnSync(['python3', '-I', '-c', py, JSON.stringify({ superagent: L }), JSON.stringify({ superagent: R })]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    const o = JSON.parse(p.stdout.toString()) as { lines: string[]; drift: string[] };
    return { text: o.lines.join('\n'), drift: o.drift };
  }
  const H = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const remote = (head: string) => ({ head, dirty: 0, installed: true, receipt: { status: 'ok', commit: head } });

  test('比对：HEAD 已验证且远端一致 → 无漂移并报 verified=', () => {
    const c = compare({ head: H, dirty: 0, verified: H, last_ok: H }, remote(H));
    expect(c.drift).toEqual([]);
    expect(c.text).toContain(`✓ HEAD verified=${H.slice(0, 12)} 一致`);
    expect(c.text).not.toContain('待本机验证');
  });

  test('比对：HEAD 未验证 → 以上次通过的提交为基准并标「待本机验证」', () => {
    const c = compare({ head: H, dirty: 0, verified: null, last_ok: OLD }, remote(OLD));
    expect(c.drift).toEqual([]);
    expect(c.text).toContain(`verified=${OLD.slice(0, 12)}：本机 HEAD ${H.slice(0, 12)} 待本机验证`);
    const d = compare({ head: H, dirty: 0, verified: null, last_ok: null }, remote(OLD));
    expect(d.drift).toEqual(['superagent']);
    expect(d.text).toContain('verified=无');
  });
});

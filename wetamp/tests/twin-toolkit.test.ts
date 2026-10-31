import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sh, tmp } from './helpers';

// twin-toolkit 不在本仓库：它是本机 ~/.lan-dev-machine 的双机对齐脚本。这里只做
// 函数级测试——从脚本里抽出函数，远端操作全换成桩，不连任何远端。机器上没有该脚本
// 时整组跳过。
const TOOLKIT =
  process.env.TWIN_TOOLKIT ?? join(homedir(), '.lan-dev-machine', 'bin', 'twin-toolkit');
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
  const git = (cmd: string): string =>
    sh(`git -c user.name=t -c user.email=t@l ${cmd}`, dir).trim();
  sh('git init -q -b main', dir);
  writeFileSync(join(dir, 'f'), '1\n');
  git('add f');
  git('commit -qm old');
  const old = git('rev-parse HEAD');
  writeFileSync(join(dir, 'f'), '2\n');
  git('commit -qam head');
  return { root, dir, old, head: git('rev-parse HEAD'), git };
}

describe.skipIf(!present)('twin-toolkit superagent 同步', () => {
  function align(opts: {
    remote: string;
    receipt?: string;
    verify: string | null;
    moveOnBundle?: boolean;
  }) {
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
git() {
  if [[ "\${MOVE_ON_BUNDLE:-0}" == 1 && "$*" == *' bundle create '* ]]; then
    MOVE_ON_BUNDLE=0
    command git -C "$SUPERAGENT_DIR" -c user.name=t -c user.email=t@l commit -q --allow-empty -m moved
  fi
  command git "$@"
}
${fn}
align_superagent`;
    writeFileSync(join(r.root, 'run.sh'), script);
    const p = Bun.spawnSync(['bash', join(r.root, 'run.sh')], {
      env: {
        ...process.env,
        ROOT: r.root,
        CALLS: calls,
        SUPERAGENT_DIR: r.dir,
        SUPERAGENT_HOME: r.root,
        TWIN_SUPERAGENT_VERIFY: verify,
        RHEAD: opts.remote === 'old' ? r.old : r.head,
        RECEIPT: opts.receipt ?? (opts.remote === 'old' ? r.old : r.head),
        MOVE_ON_BUNDLE: opts.moveOnBundle ? '1' : '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      ...r,
      code: p.exitCode,
      out: p.stdout.toString() + p.stderr.toString(),
      calls: readFileSync(calls, 'utf8'),
    };
  }

  test('verify 失败也不调用：按本机 HEAD 同步并安装', () => {
    const a = align({
      remote: 'old',
      verify: 'echo "verify $*" >> "$CALLS"; echo "verify-local: x FAIL (log /v/x.log)"; exit 1\n',
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain(`superagent: 已对齐到本机提交 ${a.head.slice(0, 12)}`);
    expect(a.calls).toBe(`scp\nssh\ninstall ${a.head}\n`);
  });

  test('verify 脚本缺失也按本机 HEAD 同步并安装', () => {
    const a = align({ remote: 'old', verify: null });
    expect(a.code).toBe(0);
    expect(a.out).toContain(`superagent: 已对齐到本机提交 ${a.head.slice(0, 12)}`);
    expect(a.calls).toBe(`scp\nssh\ninstall ${a.head}\n`);
  });

  test('打包期间 HEAD 前移：竞态被检出且不投送', () => {
    const a = align({
      remote: 'old',
      verify: 'echo verify >> "$CALLS"; exit 1\n',
      moveOnBundle: true,
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain('HEAD 在捕获后变为');
    expect(a.calls).toBe('');
  });

  test('远端已一致：零写入，也不跑验证', () => {
    const a = align({ remote: 'head', verify: 'echo verify >> "$CALLS"; exit 1\n' });
    expect(a.code).toBe(0);
    expect(a.out).toContain('已一致');
    expect(a.calls).toBe('');
  });

  test('完成回执不匹配：HEAD 已一致仍重新安装', () => {
    const a = align({ remote: 'head', receipt: 'wrong', verify: null });
    expect(a.code).toBe(0);
    expect(a.out).toContain('完成回执不可用');
    expect(a.calls).toBe(`install ${a.head}\n`);
  });
});

describe.skipIf(!present)('twin-toolkit superagent 探针与比对段', () => {
  /** 抽出 python 探针 superagent()，在临时 home 下按给定旧 verify.json 运行。 */
  function probe(legacyVerify: object | null) {
    const r = repo();
    const sa = join(r.root, 'sa');
    mkdirSync(sa);
    if (legacyVerify) writeFileSync(join(sa, 'verify.json'), JSON.stringify(legacyVerify));
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

  test('探针：只报告 HEAD，不返回 verified / last_ok', () => {
    const a = probe({ commit: 'stale', ok: true, last_ok_commit: 'stale' });
    expect(a.s.head).toBe(a.head);
    expect(a.s).not.toHaveProperty('verified');
    expect(a.s).not.toHaveProperty('last_ok');
  }, 30000);

  /** 抽出比对段，给定本机/远端探针结果，返回输出行与漂移维度。 */
  function compare(L: object, R: object) {
    const block = slice('if "superagent" in DIMS:', '\n# 三端受管协议区块');
    const py = `import json, sys\nL, R = json.loads(sys.argv[1]), json.loads(sys.argv[2])\nDIMS = {"superagent"}\nLABEL = "开发机"\nSUPERAGENT_RECEIPT_REL = "r"\nlines, drift = [], []\n${block}\nprint(json.dumps({"lines": lines, "drift": drift}))\n`;
    const p = Bun.spawnSync([
      'python3',
      '-I',
      '-c',
      py,
      JSON.stringify({ superagent: L }),
      JSON.stringify({ superagent: R }),
    ]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    const o = JSON.parse(p.stdout.toString()) as { lines: string[]; drift: string[] };
    return { text: o.lines.join('\n'), drift: o.drift };
  }
  const H = 'a'.repeat(40);
  const remote = (head: string) => ({
    head,
    dirty: 0,
    installed: true,
    receipt: { status: 'ok', commit: head },
  });

  test('比对：忽略旧 verified / last_ok 字段，以 HEAD 判定一致', () => {
    const c = compare({ head: H, dirty: 0, verified: 'old', last_ok: 'old' }, remote(H));
    expect(c.drift).toEqual([]);
    expect(c.text).toContain(`✓ HEAD=${H.slice(0, 12)} 一致`);
    expect(c.text).not.toContain('verified');
  });

  test('比对：HEAD 不同即漂移，不以旧验证历史为基准', () => {
    const old = 'b'.repeat(40);
    const c = compare({ head: H, dirty: 0, verified: old, last_ok: old }, remote(old));
    expect(c.drift).toEqual(['superagent']);
    expect(c.text).toContain(`HEAD 本机=${H.slice(0, 12)}  开发机=${old.slice(0, 12)}`);
  });
});

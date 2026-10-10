import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { archon, archonDetached } from '../src/archon';
import { tmp } from './helpers';

const WORKER = join(import.meta.dir, '..', 'bin', 'codex-worker');

function stub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

describe('bin/codex-worker', () => {
  test('prepends exec_profiles -c and disables declared MCP servers outside the sandbox list', () => {
    const root = tmp();
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      ['claude', 'twin-agent', 'searxng'].map(n => `[mcp_servers.${n}]\ncommand = "x"\n`).join('\n')
    );
    const real = stub(
      root,
      'codex',
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n'
    );
    const p = Bun.spawnSync([WORKER, 'exec', '-s', 'read-only', 'x'], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: '',
        SA_CODEX_REAL: real,
        SA_CODEX_WORKER_TRACE: '',
        SA_CODEX_HOOK_TRUST: 'unchecked',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    const argv = JSON.parse(p.stdout.toString()) as string[];
    expect(argv.slice(0, 2)).toEqual(['-c', 'features.multi_agent=false']);
    expect(argv).toContain('mcp_servers.claude.enabled=false');
    expect(argv).toContain('mcp_servers.twin-agent.enabled=false');
    expect(argv.join(' ')).not.toContain('searxng');
    expect(argv.slice(-4)).toEqual(['exec', '-s', 'read-only', 'x']);
  });

  function worker(
    toml: string,
    env: Record<string, string> = {},
    args: string[] = ['exec', 'x']
  ): { code: number | null; argv: string[]; err: string } {
    const root = tmp();
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), toml);
    const real = stub(
      root,
      'codex',
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n'
    );
    const p = Bun.spawnSync([WORKER, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: '',
        SUPERAGENT_ROLE: '',
        SA_CODEX_REAL: real,
        SA_CODEX_WORKER_TRACE: '',
        SA_CODEX_HOOK_TRUST: 'unchecked',
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = p.stdout.toString();
    return {
      code: p.exitCode,
      argv: out ? (JSON.parse(out) as string[]) : [],
      err: p.stderr.toString(),
    };
  }
  const disabled = (argv: string[]): string[] =>
    argv.filter(a => a.endsWith('.enabled=false')).map(a => a.split('.')[1]);

  test('MCP names come from TOML keys in every table/dotted/inline form; unsafe names are skipped', () => {
    const r = worker(
      [
        'mcp_servers.e.command = "x"',
        'mcp_servers.f = { command = "x" }',
        '[mcp_servers."b"]\ncommand = "x"',
        '[mcp_servers.\'c\']\ncommand = "x"',
        '[mcp_servers . d]\ncommand = "x"',
        '[mcp_servers.a]\ncommand = "x"',
        '[mcp_servers."we\\"ird"]\ncommand = "x"',
        '[mcp_servers.searxng]\ncommand = "x"',
      ].join('\n')
    );
    expect(r.code).toBe(0);
    expect(disabled(r.argv).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(r.err).toContain('skipped MCP server with unsafe name');
  });

  test('a real codex resolving to codex-worker itself or not executable exits 2', () => {
    const root = tmp();
    const link = join(root, 'codex');
    symlinkSync(WORKER, link);
    expect(worker('', { SA_CODEX_REAL: link }).code).toBe(2);
    expect(worker('', { SA_CODEX_REAL: WORKER }).err).toContain('codex-worker itself');
    writeFileSync(join(root, 'plain'), '');
    expect(worker('', { SA_CODEX_REAL: join(root, 'plain') }).code).toBe(2);
  });

  // codex-rs hooks discovery：NormalizedHookIdentity 的键排序紧凑 JSON 的 sha256。
  const hookHash = (command: string, timeout: number): string => {
    const identity = { event_name: 'pre_tool_use', hooks: [{ async: false, command, timeout, type: 'command' }] };
    return `sha256:${new Bun.CryptoHasher('sha256').update(JSON.stringify(identity)).digest('hex')}`;
  };
  const TRUST = join(import.meta.dir, '..', 'scripts', 'codex-trust.cjs');
  const verify = (env: Record<string, string>): { trusted: number; match: number } =>
    JSON.parse(Bun.spawnSync(['bun', TRUST, 'verify'], { env: { ...process.env, ...env } }).stdout.toString());
  test('scripts/codex-trust.cjs reproduces trusted_hash values written by Codex /hooks', () => {
    // 本机 ~/.codex/config.toml 里 Codex 为 git-guardrail（timeout 10）记下的值（2026-10-10 实测）。
    const command = 'bash /Users/yong/.wetamp/bin/git-guardrail.sh';
    const want = 'sha256:4e71123e2967f6c83d07b6b042e8c7b6f17948d33d904874c64a8e1c6600f109';
    expect(hookHash(command, 10)).toBe(want);
    const codexHome = tmp();
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] } }));
    writeFileSync(join(codexHome, 'config.toml'), `[hooks.state."${join(codexHome, 'hooks.json')}:pre_tool_use:0:0"]\ntrusted_hash = "${want}"\n`);
    expect(verify({ CODEX_HOME: codexHome })).toEqual({ trusted: 1, match: 1 });
  });
  // 只读核对本机真实 ~/.codex：只取两个计数。条目改过而未重新信任时 match 会少于 trusted（Codex 也会跳过它们），
  // 故只要求至少一条吻合。
  const real = join(process.env.HOME ?? '', '.codex');
  test.skipIf(!existsSync(join(real, 'hooks.json')) || !existsSync(join(real, 'config.toml')))(
    'hash matches entries Codex trusted on this machine (read-only, counts only)',
    () => {
      const r = verify({ CODEX_HOME: real });
      if (r.trusted) expect(r.match).toBeGreaterThan(0);
    }
  );

  test('fails closed unless the guard PreToolUse hook is trusted and enabled', () => {
    const guard = "node '/x/wetamp/hooks/guard.cjs' codex";
    const run = (trusted: string | null, extra = '', env: Record<string, string> = {}, args = ['exec', 'x']) => {
      const root = tmp();
      const codexHome = join(root, 'codex-home');
      mkdirSync(codexHome);
      const hooks = join(codexHome, 'hooks.json');
      const group = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 30 }] });
      writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [group('bash /x/other.sh'), group(guard)] } }));
      const state = trusted === null ? '' : `[hooks.state."${hooks}:pre_tool_use:1:0"]\ntrusted_hash = "${trusted}"\n${extra}`;
      writeFileSync(join(codexHome, 'config.toml'), state);
      const real = stub(root, 'codex', '#!/usr/bin/env node\nconsole.log("ran");\n');
      const p = Bun.spawnSync([WORKER, ...args], {
        env: { ...process.env, CODEX_HOME: codexHome, SUPERAGENT_ROLE: '', SA_CODEX_REAL: real, SA_CODEX_HOOK_TRUST: '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    expect(run(hookHash(guard, 30))).toMatchObject({ code: 0, out: 'ran\n' });
    // 定义改过（hash 不符）、从未信任、被禁用：Codex 都不会执行它。
    for (const r of [run(hookHash(guard, 10)), run(null), run(hookHash(guard, 30), 'enabled = false\n')]) {
      expect(r.code).toBe(3);
      expect(r.out).toBe('');
      expect(r.err).toContain('/hooks');
    }
    const r = run(null, '', { SA_CODEX_HOOK_TRUST: 'unchecked' });
    expect(r).toMatchObject({ code: 0, out: 'ran\n' });
    expect(r.err).toContain('not verified');
    // archon doctor 只探测版本：不跑模型，不受信任闸约束；带其它参数的 --version 仍要过闸。
    expect(run(null, '', {}, ['--version'])).toMatchObject({ code: 0, out: 'ran\n', err: '' });
    expect(run(null, '', {}, ['--version', 'exec']).code).toBe(3);
    // python3 没有 tomllib（mini 的 3.9）不影响判定；bun 不在 PATH 时无法判定 → 失败关闭
    const bin = tmp();
    stub(bin, 'python3', '#!/bin/sh\nexit 1\n');
    const node = dirname(Bun.which('node') ?? '');
    const bun = dirname(Bun.which('bun') ?? '');
    expect(run(hookHash(guard, 30), '', { PATH: `${bin}:${bun}:${node}:/usr/bin:/bin` })).toMatchObject({ code: 0, out: 'ran\n' });
    if (node !== bun) expect(run(hookHash(guard, 30), '', { PATH: `${node}:/usr/bin:/bin` }).code).toBe(3);
  });

  test('reviewer role adds a read-only sandbox; TRACE prints policy and redacted caller argv only', () => {
    expect(worker('', { SUPERAGENT_ROLE: 'reviewer' }).argv).toContain('sandbox_mode="read-only"');
    expect(worker('').argv.join(' ')).not.toContain('sandbox_mode');
    const r = worker('', { SA_CODEX_WORKER_TRACE: '1' }, [
      'exec',
      '-c',
      'mcp_servers.x.env.API_KEY="sk-1"',
      '--header',
      'Authorization: Bearer abc',
      '--token',
      'abc',
      'y'.repeat(300),
    ]);
    const trace = JSON.parse(r.err.trim().split('\n').at(-1) ?? '') as {
      policy: string[];
      argv: string[];
    };
    expect(trace.policy).toEqual(['-c', 'features.multi_agent=false']);
    expect(trace.argv.slice(0, 7)).toEqual([
      'exec',
      '-c',
      'mcp_servers.x.env.API_KEY=***',
      '--header',
      'Authorization: ***',
      '--token',
      '***',
    ]);
    expect(trace.argv[7].length).toBeLessThanOrEqual(201);
    expect(r.err).not.toContain('abc');
    expect(r.err).not.toContain('sk-1');
  });
});

describe('codex-readonly-proxy (app-server via codex-worker)', () => {
  const PROXY = join(import.meta.dir, '..', 'bin', 'codex-readonly-proxy.cjs');
  const TIERS = join(import.meta.dir, '..', 'tiers.json');
  const MARKER = 'superagent-reviewer-readonly';
  /** 真 codex 桩：把收到的 stdin 原字节写进文件，回一行响应。 */
  function appServer(
    input: string,
    env: Record<string, string> = {},
    argv: string[] = [WORKER, 'app-server', '--listen', 'stdio://']
  ): { code: number | null; received: string; out: string; err: string } {
    const root = tmp();
    const rec = join(root, 'stdin.bin');
    const real = stub(
      root,
      'codex',
      `#!/usr/bin/env node
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(rec)}, Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
});
`
    );
    const p = Bun.spawnSync(argv, {
      env: {
        ...process.env,
        HOME: root,
        CODEX_HOME: '',
        SUPERAGENT_ROLE: '',
        SA_CODEX_REAL: real,
        SA_CODEX_WORKER_TRACE: '',
        SA_CODEX_HOOK_TRUST: 'unchecked',
        ...env,
      },
      stdin: Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: p.exitCode,
      received: existsSync(rec) ? readFileSync(rec, 'utf8') : '',
      out: p.stdout.toString(),
      err: p.stderr.toString(),
    };
  }
  const lines = (s: string): Record<string, unknown>[] =>
    s
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  const start = (servers: Record<string, unknown>, method = 'thread/start'): string =>
    JSON.stringify({
      id: 2,
      method,
      params: {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        config: { mcp_servers: servers },
      },
    });
  const turn = '{"id":3,"method":"turn/start","params":{"threadId":"t","input":[]}}';
  const init = '{ "id": 1,  "method":"initialize","params":{"clientInfo":{"name":"é"}} }';

  test('non-reviewer bytes pass verbatim; a marker thread turns the connection read-only', () => {
    const plain = [init, start({ searxng: { command: 'x' } }), turn, '{"id":9,"result":{}}'].join(
      '\n'
    );
    const a = appServer(plain + '\n');
    expect(a.code).toBe(0);
    expect(a.received).toBe(plain + '\n');
    // 服务端 stdout 直通；-c 策略仍在 app-server 之前
    expect((JSON.parse(a.out) as { argv: string[] }).argv).toEqual([
      '-c',
      'features.multi_agent=false',
      'app-server',
      '--listen',
      'stdio://',
    ]);

    const b = appServer(
      [
        init,
        start({ [MARKER]: { command: 'false', required: true }, searxng: { command: 'x' } }),
        turn,
        start({}, 'thread/resume'),
      ].join('\n')
    );
    expect(b.code).toBe(0);
    const [i, s, t, r] = lines(b.received);
    expect(b.received.split('\n')[0]).toBe(init);
    expect(i.method).toBe('initialize');
    expect(s.params).toMatchObject({
      sandbox: 'read-only',
      config: { mcp_servers: { searxng: { command: 'x' } } },
    });
    expect(b.received).not.toContain(MARKER);
    expect(t.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: true } });
    expect(r.params).toMatchObject({ sandbox: 'read-only' });
  });

  test('SUPERAGENT_ROLE=reviewer makes every thread and turn read-only without a marker', () => {
    const r = appServer([start({}), turn].join('\n') + '\n', { SUPERAGENT_ROLE: 'reviewer' });
    const [s, t] = lines(r.received);
    expect(s.params).toMatchObject({ sandbox: 'read-only' });
    expect(t.params).toMatchObject({ sandboxPolicy: { type: 'readOnly' } });
  });

  test('fails closed: unparsable reviewer input, a stray marker, unreadable policy', () => {
    const marked = start({ [MARKER]: { command: 'false' } });
    const bad = appServer([marked, '{"id":3,"method":"turn/start",'].join('\n') + '\n');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('codex-readonly-proxy: unparsable request');
    expect(bad.received).not.toContain('turn/start');

    const stray = appServer(`{"id":4,"method":"config/read","params":{"x":"${MARKER}"}}\n`);
    expect(stray.code).toBe(1);
    expect(stray.err).toContain('marker outside thread params');

    const root = tmp();
    writeFileSync(join(root, 'tiers.json'), '{"policy":{"exec_profiles":{"reviewer":{}}}}');
    const noPolicy = appServer('', {}, ['node', PROXY, join(root, 'tiers.json'), 'true']);
    expect(noPolicy.code).toBe(1);
    expect(noPolicy.err).toContain('cannot read policy');
    expect(readFileSync(TIERS, 'utf8')).toContain(`"codex_readonly_marker": "${MARKER}"`);
  });
});

describe('archon worker env', () => {
  test('run/resume --detach and detached spawns carry SUPERAGENT_ROLE=worker; queries do not', async () => {
    const root = tmp();
    const out = join(root, 'env.log');
    const saved = { ...process.env };
    Object.assign(process.env, {
      SA_ARCHON_BIN: stub(
        root,
        'archon',
        `#!/bin/sh\necho "$2 \${SUPERAGENT_ROLE:-none} $SUPERAGENT_HOME" >> '${out}'\n`
      ),
      SUPERAGENT_HOME: join(root, 'sa'),
      ARCHON_HOME: join(root, 'archon'),
      SUPERAGENT_ROLE: '',
    });
    try {
      archon(['workflow', 'run', 'wf', '--detach']);
      archon(['workflow', 'resume', 'id', '--detach']);
      archon(['workflow', 'status', '--json']);
      archonDetached(['workflow', 'wake'], join(root, 'wake.log'));
      for (let i = 0; i < 100 && !readFileSync(out, 'utf8').includes('wake'); i++)
        await Bun.sleep(20);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(existsSync(out)).toBe(true);
    const sa = join(root, 'sa');
    expect(readFileSync(out, 'utf8').trim().split('\n').sort()).toEqual(
      [`resume worker ${sa}`, `run worker ${sa}`, `status none ${sa}`, `wake worker ${sa}`].sort()
    );
  });

  test('an inherited reviewer/general role is kept instead of being widened to worker', () => {
    const root = tmp();
    const out = join(root, 'env.log');
    const saved = { ...process.env };
    Object.assign(process.env, {
      SA_ARCHON_BIN: stub(root, 'archon', `#!/bin/sh\necho "$SUPERAGENT_ROLE" >> '${out}'\n`),
      SUPERAGENT_HOME: join(root, 'sa'),
      ARCHON_HOME: join(root, 'archon'),
    });
    try {
      for (const role of ['reviewer', 'general', 'commander']) {
        process.env.SUPERAGENT_ROLE = role;
        archon(['workflow', 'run', 'wf', '--detach']);
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['reviewer', 'general', 'worker']);
  });
});

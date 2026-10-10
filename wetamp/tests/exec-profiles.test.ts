import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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

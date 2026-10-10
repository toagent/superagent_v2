import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
});

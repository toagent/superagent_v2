import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './helpers';
import {
  attribute,
  parseUsage,
  refreshUsage,
  usageCommand,
  usageEvidence,
  type UsageSession,
} from '../src/usage';
import type { Ledger } from '../src/cli';
import type { RunView } from '../src/archon';
import { archonJson } from '../src/archon';
import { etaInput } from '../src/board/eta';
import type { WorkflowEventRow } from '../../packages/workflows/src/schemas/workflow-event';

const keys = [
  'SUPERAGENT_HOME',
  'ARCHON_HOME',
  'SA_ARCHON_BIN',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'TZ',
] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const at = '2026-10-10T04:00:00Z';
const session = (id: string, total = 40): UsageSession => ({
  id,
  client: 'codex',
  model: 'gpt-6.1-sol',
  at,
  cost: null,
  input: total,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  sessions: 1,
});
const metadata = (id: string) => ({
  node: { id, kind: 'agent', source: { kind: 'inline' } },
  invocation: { id: 'v', startedAt: at, loopPath: [] },
  attempt: { id: 'a', startedAt: at },
  timing: { startedAt: at },
  accounting: 'node',
  spend: Object.fromEntries(
    ['tokens', 'costUsd', 'stopReason', 'numTurns'].map(k => [
      k,
      { source: 'unavailable', reason: 'not_reported' },
    ])
  ),
});
function setup() {
  const root = tmp();
  Object.assign(process.env, {
    SUPERAGENT_HOME: root,
    ARCHON_HOME: join(root, 'archon'),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    TZ: 'Asia/Taipei',
  });
  for (const d of ['runs', 'jobs', 'live', '.archon/workflows/w'])
    mkdirSync(join(root, d), { recursive: true });
  writeFileSync(
    join(root, '.archon/workflows/w/w.yaml'),
    Bun.YAML.stringify({
      nodes: [
        { id: 'code-a', model: '@sa-coder' },
        { id: 'review-a', model: '@sa-reviewer' },
      ],
    })
  );
  const ledger: Ledger = {
    run_id: 'r',
    archon_run_id: 'new',
    repo: root,
    gen_dir: root,
    workflow: 'w',
    plan: '',
    branch: 'b',
    console: 'codex',
    started_at: at,
    transcript: '',
    log: '',
    recoveries: [],
    adoptions: [
      { at, from: 'old', to: 'new', engine_from: null, engine_to: 'h', reason: 'upgrade' },
      { at, from: 'missing', to: 'new', engine_from: null, engine_to: 'h', reason: 'upgrade' },
    ],
  };
  writeFileSync(join(root, 'runs/r.json'), JSON.stringify(ledger));
  const binding = (model: string) => ({
    provider: 'codex',
    model: { requested: '@sa-coder', resolved: { source: 'provider', value: model } },
  });
  const event = (step_name: string, session_id: string, model: string) => ({
    event_type: 'node_completed',
    step_name,
    data: { ...metadata(step_name), session_id, binding: binding(model) },
  });
  writeFileSync(
    join(root, 'new.json'),
    JSON.stringify({
      id: 'new',
      status: 'completed',
      working_path: root,
      events: [event('review-a', 'review-session', 'gpt-6-astra')],
    })
  );
  writeFileSync(
    join(root, 'old.json'),
    JSON.stringify({
      id: 'old',
      status: 'completed',
      working_path: root,
      events: [event('code-a', 'code-session', 'gpt-6.1-sol')],
    })
  );
  writeFileSync(
    join(root, 'jobs/j.json'),
    JSON.stringify({
      id: 'j',
      cwd: root,
      kind: 'codex',
      started_at: at,
      session_id: 'job-session',
      role: 'strategist',
      model: 'gpt-6-astra',
      state: 'done',
    })
  );
  writeFileSync(
    join(root, 'live/i.json'),
    JSON.stringify({
      session_id: 'interactive',
      client: 'codex',
      cwd: '/other',
      model: 'gpt-6-astra',
      at,
    })
  );
  const stub = join(root, 'query');
  writeFileSync(stub, `#!/bin/sh\ncat '${root}/'"$3"'.json'\n`, { mode: 0o755 });
  process.env.SA_ARCHON_BIN = stub;
  return { root, ledger, binding };
}
test('explicit client collector avoids unified duplicates and accepts Claude 20 sessions shape', () => {
  for (const client of ['claude', 'codex'] as const)
    expect(usageCommand(client, 'session', '20261010')).toEqual([
      'nice',
      '-n',
      '10',
      'bunx',
      'ccusage@20.0.28',
      client,
      'session',
      '--json',
      '--since',
      '20261010',
    ]);
  expect(
    parseUsage(
      {
        sessions: [
          {
            sessionId: 'claude-only',
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            modelsUsed: ['claude-opus-5'],
            lastActivity: at,
          },
        ],
      },
      'claude'
    )[0]
  ).toMatchObject({ id: 'claude-only', client: 'claude', model: 'claude-opus-5', total: 3 });
});
test('current and adopted Archon, explicit job and interactive ownership survive a missing history run', async () => {
  const { root, ledger } = setup();
  const sessions = ['code-session', 'review-session', 'job-session', 'interactive'].map(id =>
    session(id)
  );
  const queried = archonJson(['workflow', 'get', 'new', '--verbose', '--events'], root);
  expect(
    etaInput(ledger, queried as unknown as RunView, queried.events as WorkflowEventRow[]).run.nodes
  ).toHaveLength(1);
  attribute(sessions, usageEvidence().claims);
  expect(sessions.map(s => [s.owner?.kind, s.owner?.role, s.owner?.model])).toEqual([
    ['run', 'general', 'gpt-6.1-sol'],
    ['run', 'strategist', 'gpt-6-astra'],
    ['inferred', 'strategist', 'gpt-6-astra'],
    ['interactive', null, 'gpt-6-astra'],
  ]);
  const c = await refreshUsage('20261010', (client, mode) =>
    Promise.resolve(
      mode === 'daily'
        ? { daily: [{ date: '2026-10-10', totalTokens: 160 }] }
        : {
            sessions:
              client === 'claude'
                ? []
                : sessions.map(s => ({
                    sessionId: s.id,
                    inputTokens: 40,
                    outputTokens: 0,
                    totalTokens: 40,
                  })),
          }
    )
  );
  expect(c.status).toBe('ok');
  expect(c.sessions.map(s => s.owner?.role)).toEqual(['general', 'strategist', 'strategist', null]);
});
test('active node matches unique exact worktree/start metadata, terminal and ambiguous launches do not guess', () => {
  const { root, binding } = setup(),
    dir = join(root, 'codex/sessions/2026/10/10');
  mkdirSync(dir, { recursive: true });
  const meta = (id: string, cwd = root) =>
    JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd, timestamp: '2026-10-10T04:00:01Z' },
    });
  writeFileSync(join(dir, 'a.jsonl'), meta('inflight') + '\nPRIVATE');
  writeFileSync(join(dir, 'other.jsonl'), meta('other', '/other'));
  const run = {
    id: 'new',
    status: 'running',
    working_path: root,
    events: [
      {
        step_name: 'code-a',
        event_type: 'node_started',
        created_at: at,
        data: { ...metadata('code-a'), binding: binding('gpt-6.1-sol') },
      },
    ],
  };
  const file = join(root, 'new.json');
  writeFileSync(file, JSON.stringify(run));
  expect(usageEvidence().claims.find(c => c.id === 'inflight')?.owner).toMatchObject({
    kind: 'inferred',
    role: 'general',
    model: 'gpt-6.1-sol',
    cwd: root,
  });
  writeFileSync(join(dir, 'b.jsonl'), meta('ambiguous'));
  expect(usageEvidence().claims.some(c => c.id === 'inflight')).toBe(false);
  run.status = 'completed';
  writeFileSync(file, JSON.stringify(run));
  expect(usageEvidence().claims.some(c => c.id === 'inflight')).toBe(false);
});

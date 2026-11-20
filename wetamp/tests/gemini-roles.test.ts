import { expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeProvider, CodexProvider } from '@archon/providers/in-process';
import { getRegistration, parseProviderRunModel } from '@archon/providers';
import { loadWorkflowRunConfigFile } from '../../packages/core/src/config/run-config';
import { buildWorkflow, generate } from '../src/generate';
import * as archon from '../src/archon';
import { loadTiers, snapshotPolicy } from '../src/config';
import * as coord from '../src/coord';
import { draftPlan } from '../src/gemini-plan';
import { milestones, validatePlan, type Plan } from '../src/plan';
import { installPolicyExecutor, wrapPolicyProvider } from '../src/policy-executor';
import { geminiTurn } from '../src/gemini-role';
import { freezeContext } from '../templates/.archon/scripts/sa-context';
import * as ledger from '../templates/.archon/scripts/policy-attempts';
import { gitRepo, tmp, trackTestChild } from './helpers';
// prettier-ignore
function gatewayEnv(dir: string, url: string) {
  const env = { ARCHON_HOME: dir, SUPERAGENT_HOME: dir, SUPERAGENT_WRITE_ROOTS: dir, AGY_LLM_GATEWAY_URL: url, AGY_LLM_GATEWAY_API_KEY: 'test-fixture' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  return () => { for (const key of Object.keys(env)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; };
}
// prettier-ignore
const planFor = (repo: string): Plan => ({
  repo, base_ref: 'main', budget: { weighted_tokens: 0, unlimited_tokens: true },
  packages: [{ id: 'core', title: 'core', goal: 'core', scope: { write: ['src/**'] }, size: 'S', accept: [{ cmd: 'true', timeout_s: 10 }], risk: 'G1' }],
});
const geminiReply = (value: unknown, model = 'gemini-fixture', finishReason = 'STOP') => ({
  modelVersion: model || undefined,
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }],
});

test('Gemini registration validates models and assistant defaults', async () => {
  installPolicyExecutor();
  const { parseConfig, capabilities, factory } = getRegistration('gemini');
  const models = loadTiers().routing.gemini!.review;
  for (const model of models) expect(parseProviderRunModel('gemini', model)).toBe(model);
  expect(() => parseProviderRunModel('gemini', 'claude-sonnet')).toThrow();
  expect(parseConfig({}, 'run')).toEqual({});
  expect(parseConfig({}, 'snapshot')).toEqual({});
  expect(parseConfig({ model: models[0] }, 'snapshot')).toEqual({ model: models[0] });
  for (const raw of [{ model: '' }, { model: undefined }, { model: models[0], extra: true }])
    expect(() => parseConfig(raw, 'run')).toThrow();
  const provider = factory();
  expect(capabilities).toMatchObject({ sessionResume: false, structuredOutput: 'enforced' });
  const status = await provider.checkCredential({ env: {}, signal: new AbortController().signal });
  expect(status).toEqual({ state: 'not_checked', source: 'native' });
  expect(() => provider.sendQuery('review', '.')).toThrow('opted-in review nodes');
});

test('generated Gemini review alias passes Archon run-config validation', async () => {
  installPolicyExecutor();
  const repo = gitRepo(tmp());
  const clean = coord.cleanEngine;
  const engine = spyOn(coord, 'cleanEngine').mockImplementation(() => clean(repo));
  const validation = spyOn(archon, 'archon').mockReturnValue({ code: 0, out: '', err: '' });
  try {
    const plan = planFor(repo);
    const native = await loadWorkflowRunConfigFile(generate(plan, 'native-review').config);
    const { layer } = await loadWorkflowRunConfigFile(
      generate({ ...plan, gemini_review: true }, 'gemini-review').config
    );
    expect(native.layer.aliases).not.toHaveProperty('@sa-gemini-review');
    expect(layer.aliases?.['@sa-gemini-review']?.model).toBe(loadTiers().routing.gemini!.review[0]);
  } finally {
    validation.mockRestore();
    engine.mockRestore();
  }
});

test('single:gemini pins a separate agy alias and generates fresh coder and repair nodes', async () => {
  installPolicyExecutor();
  const dir = tmp(),
    repo = gitRepo(dir);
  const restore = gatewayEnv(dir, 'https://example.invalid');
  const engine = spyOn(coord, 'cleanEngine').mockReturnValue('fixture');
  const validation = spyOn(archon, 'archon').mockReturnValue({ code: 0, out: '', err: '' });
  try {
    const baseline = planFor(repo);
    const plan = validatePlan({ ...baseline, mode: 'single:gemini' }, [dir]);
    const { config, dir: generated, workflow } = generate(plan, 'agy-general');
    const { layer } = await loadWorkflowRunConfigFile(config);
    expect(layer.aliases?.['@sa-agy-coder']).toMatchObject({
      provider: 'agy',
      model: 'gemini-4-neon-%78high',
    });
    expect(layer.aliases?.['@sa-coder']?.provider).toBe('codex');
    expect(layer.envVars?.SA_POLICY_PATH).toBe(join(generated, 'policy.json'));
    const path = join(generated, '.archon/workflows', workflow, `${workflow}.yaml`);
    const { nodes } = Bun.YAML.parse(readFileSync(path, 'utf8')) as { nodes: { id: string }[] };
    const native = buildWorkflow(baseline, milestones(baseline), 'agy-general', generated)
      .nodes as typeof nodes;
    for (const id of ['code-core', 'repair-core', 'fix-m1-r2']) {
      expect(nodes.find(node => node.id === id)).toMatchObject({
        model: '@sa-agy-coder',
        context: 'fresh',
        output_format: (native.find(node => node.id === id) as { output_format?: unknown })
          .output_format,
      });
    }
    expect(() => validatePlan({ ...plan, gemini_review: true }, [dir])).toThrow('gemini_review');
  } finally {
    validation.mockRestore();
    engine.mockRestore();
    restore();
  }
});
// prettier-ignore
test('plan draft switches vendors and publishes nothing on exhaustion', async () => {
  const dir = tmp(), repo = join(dir, 'repo'), brief = join(dir, 'brief');
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(brief, 'neon-brief');
  let expected: string | null = 'gemini', requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const success = ++requests === 2 && expected === 'gemini' && (await request.text()).includes('neon-brief');
    return success ? Response.json(geminiReply(planFor(repo))) : new Response(null, { status: 201 });
  } });
  const restore = gatewayEnv(dir, server.url.href);
  const fakes = [CodexProvider, ClaudeProvider].map(provider => spyOn(provider.prototype, 'sendQuery').mockImplementation(async function* (prompt) {
    yield { type: 'result', isError: expected !== 'codex' || !prompt.includes('neon-brief'), structuredOutput: planFor(repo) };
    yield { type: 'settled' };
  }));
  try {
    for (expected of ['gemini', 'codex', null]) {
      const out = join(dir, `plan-${expected}.json`);
      const { ok, execution } = await draftPlan(brief, out);
      expect([ok, existsSync(out)]).toEqual([Boolean(expected), Boolean(expected)]);
      expect(execution.at(-1)).toMatchObject(expected ? { provider: expected, status: 'completed' } : { provider: 'claude', status: 'failed' });
      expect(execution.filter(a => a.provider === 'gemini').map(a => a.status)).toEqual(['failed', expected === 'gemini' ? 'completed' : 'failed']);
      if (expected) expect(JSON.parse(readFileSync(out, 'utf8')).gemini_review).toBe(true);
    }
  } finally { fakes.forEach(fake => fake.mockRestore()); restore(); server.stop(true); }
});
// prettier-ignore
test('plan draft CLI returns one JSON receipt when native fallback logs', async () => {
  const dir = tmp(), repo = join(dir, 'repo'), brief = join(dir, 'brief'), out = join(dir, 'plan.json');
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(brief, '规划回执测试');
  const plan = planFor(repo), preload = join(dir, 'native-fixture.ts');
  const providers = join(import.meta.dir, '../../packages/providers/src');
  const sdk = JSON.stringify(Bun.resolveSync('@anthropic-ai/claude-agent-sdk', providers));
  writeFileSync(preload, `
    import { AppServerConnection } from ${JSON.stringify(join(providers, 'codex/app-server.ts'))};
    import { createFakeAppServer } from ${JSON.stringify(join(providers, 'test/codex-app-server-fake.ts'))};
    import { mock } from 'bun:test';
    const sdk = await import(${sdk});
    mock.module(${sdk}, () => ({ ...sdk, async *query() {
      yield { type: 'result', subtype: 'success', session_id: 'fixture', is_error: false, result: ${JSON.stringify(JSON.stringify(plan))} };
    } }));
    const spawner = createFakeAppServer(() => ({ completion: { status: 'failed' } }));
    const start = AppServerConnection.start.bind(AppServerConnection);
    AppServerConnection.start = (binary, args, env, _, keys) => start(binary, args, env, spawner, keys);
  `);
  let requests = 0;
  const fetch = () => new Response(null, { status: ++requests === 1 ? 429 : 503 });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  try {
    const proc = trackTestChild(Bun.spawn([process.execPath, '--preload', preload, 'src/cli.ts', 'plan', 'draft', brief, out], {
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, SUPERAGENT_HOME: dir,
        ARCHON_HOME: dir, SUPERAGENT_WRITE_ROOTS: dir, DATABASE_URL: '', LOG_LEVEL: 'info',
        AGY_LLM_GATEWAY_URL: server.url.href, AGY_LLM_GATEWAY_API_KEY: 'test-fixture' },
      stdout: 'pipe', stderr: 'pipe',
    }));
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ receipt: JSON.parse(stdout), exit }).toMatchObject({ exit: 0, receipt: { ok: true, path: out, execution: [
      { provider: 'gemini', status: 'failed', error: 'gateway HTTP 429' },
      { provider: 'gemini', status: 'failed', error: 'gateway HTTP 503' },
      { provider: 'codex', status: 'failed' }, { provider: 'codex', status: 'failed' }, { provider: 'claude', status: 'completed' },
    ] } });
    expect(stderr).toContain('codex.turn_ended_without_completion');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ ...plan, gemini_review: true });
  } finally { server.stop(true); }
});
// prettier-ignore
test('formal review consumes frozen evidence, records Gemini and switches on failure', async () => {
  const dir = tmp(), node = 'review-m1-r1', artifacts = join(dir, 'artifacts/runs/run');
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.org', ...args]).stdout.toString().trim();
  git('init', '-q'); git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'candidate.txt'), 'candidate marker\n');
  git('add', 'candidate.txt'); git('commit', '-qm', 'candidate');
  mkdirSync(artifacts, { recursive: true });
  const diff = join(artifacts, 'change.patch'), log = join(artifacts, 'accept.log');
  writeFileSync(diff, git('diff', base, 'HEAD')); writeFileSync(log, 'acceptance marker');
  writeFileSync(join(artifacts, `${node}.context.json`), JSON.stringify({ path: freezeContext(artifacts, {
    node, execution: { role: 'review', round: 1 }, refs: { base, head: git('rev-parse', 'HEAD'), delta_base: base }, diff,
    acceptance: { log }, carry_over: null, tasks: [{ goal: 'task marker' }],
  }) }));
  const policy = join(dir, 'policy.json'), tiers = loadTiers(), models = tiers.routing.gemini!.review;
  const [author, alternate] = tiers.routing.reviewer.by_console.codex;
  writeFileSync(policy, JSON.stringify(snapshotPolicy(tiers)));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ ...planFor(dir), console: 'codex', gemini_review: true }));
  writeFileSync(join(artifacts, 'diff-m1-r1.json'), '{"risk":"G1"}');
  using db = new Database(join(dir, 'archon.db'));
  db.exec(`CREATE TABLE remote_agent_workflow_runs (id, working_path, status, output_root, metadata, codebase_id, adopted_from_run_id);
    CREATE TABLE remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, event_order);`);
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, NULL)', ['run', dir, 'running', dir, JSON.stringify({ execution_owner: { pid: process.pid } }), 'repo']);
  const verdict = { status: 'PASS', notes: '', findings: [], debt: [], fixture_confirmations: [] };
  let code = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const evidence = await req.text();
    if (code === 200 && !['candidate marker', 'acceptance marker', 'task marker'].every(marker => evidence.includes(marker)))
      return new Response(null, { status: 400 });
    if (code === 204 || code === 302) return new Response(null, { status: code, headers: { location: '/redirect' } });
    if (code === -1) { await Bun.sleep(100); return new Response(); }
    if (code === -2) return new Response('{"candidates":[', { headers: { 'content-length': '200' } });
    if (code === -4) return new Response(new ReadableStream({
      start: stream => stream.enqueue(new TextEncoder().encode(' '.repeat(1_000_001))),
    }));
    return Response.json(geminiReply(verdict, code === -3 ? '' : undefined, code === 0 ? 'MAX_TOKENS' : 'STOP'), { status: code > 0 ? code : 200 });
  } });
  const restore = gatewayEnv(dir, server.url.href);
  try {
    installPolicyExecutor();
    const provider = wrapPolicyProvider(getRegistration('gemini').factory(), 'gemini', () => async function* () {
      yield { type: 'result', ...(code === 500 ? { isError: true } : { structuredOutput: verdict }) };
      yield { type: 'settled' };
    });
    const check = () => Array.fromAsync(provider.sendQuery('review', dir, undefined, { model: models[0], env: { SA_POLICY_PATH: policy }, nodeConfig: { nodeId: node } }));
    const authorAttempt = { id: 'author', node: 'code-core', model: author, provider: 'codex', status: 'completed' } as const;
    for (code of [200, -3, 500]) {
      ledger.writePolicyAttempts(artifacts, [authorAttempt]);
      expect((await check()).at(-2)).toMatchObject(code === 500 ? { isError: true } : { structuredOutput: verdict });
      expect(ledger.readPolicyAttempts(artifacts).slice(1).map(a => [a.model, a.status, a.resolved])).toEqual(code === 200
        ? [[models[0], 'completed', 'gemini-fixture']] : [...models.map(model => [model, 'failed', undefined]), [alternate, code === 500 ? 'failed' : 'completed', undefined]]);
    }
    for (code of [201, 204, 302, 400, 401, 404, 429, 500, 503])
      await expect(geminiTurn(models[0], 'matrix')).rejects.toThrow(`HTTP ${code}`);
    for (code of [0, -1, -2]) await expect(geminiTurn(models[0], 'matrix', undefined, 25)).rejects.toThrow();
    code = -4;
    await expect(geminiTurn(models[0], 'matrix', undefined, 1_000)).rejects.toThrow('gateway response exceeds limit');
    ledger.writePolicyAttempts(artifacts, [authorAttempt]);
    code = 200; rmSync(log);
    expect((await check()).at(-2)).toMatchObject({ structuredOutput: { status: 'INCOMPLETE' } });
    expect(ledger.readPolicyAttempts(artifacts)).toEqual([authorAttempt]);
  } finally { restore(); server.stop(true); }
});
// prettier-ignore
test('Gemini opt-in preserves the coder and default review', () => {
  const plan = planFor(tmp());
  const nodes = (input: Plan) => buildWorkflow(input, milestones(input), '', plan.repo).nodes as { id: string; model?: string; when: string }[];
  const [native, optIn] = [nodes(plan), nodes({ ...plan, gemini_review: true })].map(list => Object.fromEntries(list.map(node => [node.id, node])));
  expect(native['review-m1-r1'].model).toBe('@sa-reviewer'); expect(optIn['review-m1-r1']).toMatchObject({ model: '@sa-gemini-review', mutates_checkout: false });
  expect(optIn['code-core']).toEqual(native['code-core']); expect(optIn['review-m1-r1'].when).not.toContain('review_required');
});

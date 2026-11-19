import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistration } from '@archon/providers';
import { buildWorkflow } from '../src/generate';
import { loadTiers, snapshotPolicy } from '../src/config';
import { milestones, type Plan } from '../src/plan';
import { installPolicyExecutor, wrapPolicyProvider } from '../src/policy-executor';
import { geminiTurn } from '../src/gemini-role';
import { freezeContext } from '../templates/.archon/scripts/sa-context';
import * as ledger from '../templates/.archon/scripts/policy-attempts';
import { tmp, trackTestChild } from './helpers';
// prettier-ignore
const planFor = (repo: string): Plan => ({
  repo, base_ref: 'main', budget: { weighted_tokens: 0, unlimited_tokens: true },
  packages: [{
    id: 'core', title: 'core', goal: 'core', scope: { write: ['src/**'] }, size: 'S',
    accept: [{ cmd: 'true', timeout_s: 10 }], risk: 'G1',
  }],
});
// prettier-ignore
test('plan draft CLI consumes the brief and writes a Gemini opt-in plan', async () => {
  const dir = tmp(), repo = join(dir, 'repo'), brief = join(dir, 'brief'), out = join(dir, 'plan.json');
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(brief, '计划验收标记 neon-brief');
  let received = '';
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0, async fetch(request) {
      paths.push(new URL(request.url).pathname);
      received = await request.text();
      return Response.json({ candidates: [{ finishReason: 'STOP',
        content: { parts: [{ text: JSON.stringify(planFor(repo)) }] } }] }, { status: paths.length === 1 ? 201 : 200 });
    },
  });
  try {
    const proc = trackTestChild(Bun.spawn([process.execPath, 'src/cli.ts', 'plan', 'draft', brief, out], {
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, SUPERAGENT_HOME: dir,
        ARCHON_HOME: dir, SUPERAGENT_WRITE_ROOTS: dir, DATABASE_URL: '',
        AGY_LLM_GATEWAY_URL: server.url.href, AGY_LLM_GATEWAY_API_KEY: 'test-fixture' },
      stdout: 'pipe', stderr: 'pipe',
    }));
    const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(received).toContain('neon-brief'); expect(paths).toEqual(loadTiers().routing.gemini!.command.map(model => `/v1beta/models/${model}:generateContent`));
    expect(JSON.parse(stdout).execution.map((a: { status: string }) => a.status)).toEqual(['failed', 'completed']);
    expect(JSON.parse(readFileSync(out, 'utf8')).gemini_review).toBe(true);
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
  const head = git('rev-parse', 'HEAD'), diff = join(artifacts, 'change.patch'), log = join(artifacts, 'accept.log');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(diff, git('diff', base, head)); writeFileSync(log, 'acceptance marker');
  writeFileSync(join(artifacts, `${node}.context.json`), JSON.stringify({ path: freezeContext(artifacts, {
    node, execution: { role: 'review', round: 1 }, refs: { base, head, delta_base: base }, diff,
    acceptance: { log }, carry_over: null, tasks: [{ goal: 'task marker' }],
  }) }));
  const plan = { ...planFor(dir), console: 'codex', gemini_review: true };
  const policy = join(dir, 'policy.json'), tiers = loadTiers(), models = tiers.routing.gemini!.review;
  const [author, alternate] = tiers.routing.reviewer.by_console.codex;
  writeFileSync(policy, JSON.stringify(snapshotPolicy(tiers))); writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(artifacts, 'diff-m1-r1.json'), '{"risk":"G1"}');
  const db = new Database(join(dir, 'archon.db'));
  db.run('CREATE TABLE remote_agent_workflow_runs (id, working_path, status, output_root, metadata, codebase_id, adopted_from_run_id)');
  db.run('CREATE TABLE remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, event_order)');
  db.run('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?, NULL)', ['run', dir, 'running', dir, JSON.stringify({ execution_owner: { pid: process.pid } }), 'repo']);
  db.close();
  const verdict = { status: 'PASS', notes: '', findings: [], debt: [], fixture_confirmations: [] };
  let code = 200, received = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    received = await req.text();
    if (code === 204 || code === 302) return new Response(null, { status: code, headers: { location: '/redirect' } });
    if (code === -1) { await Bun.sleep(100); return new Response(); }
    if (code === -2) return new Response('{"candidates":[', { headers: { 'content-length': '200' } });
    return Response.json({ candidates: [{ finishReason: code === 0 ? 'MAX_TOKENS' : 'STOP',
      content: { parts: [{ text: JSON.stringify(verdict) }] } }] }, { status: code || 200 });
  } });
  const env = { ARCHON_HOME: dir, AGY_LLM_GATEWAY_URL: server.url.href, AGY_LLM_GATEWAY_API_KEY: 'test-fixture' };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    installPolicyExecutor();
    const provider = wrapPolicyProvider(getRegistration('gemini').factory(), 'gemini', candidate => async function* (_p, _cwd, resume) {
      expect(candidate).toMatchObject({ provider: 'codex', model: alternate }); expect(resume).toBeUndefined();
      yield { type: 'result', ...(code === 500 ? { isError: true } : { structuredOutput: verdict }) };
      yield { type: 'settled' };
    });
    for (code of [200, 401, 500]) {
      ledger.writePolicyAttempts(artifacts, [{ id: 'author', node: 'code-core', model: author, provider: 'codex', status: 'completed' }]);
      const out = await Array.fromAsync(provider.sendQuery('review', dir, undefined, { model: models[0], env: { SA_POLICY_PATH: policy }, nodeConfig: { nodeId: node } }));
      expect(out.at(-2)).toMatchObject(code === 500 ? { isError: true } : { structuredOutput: verdict });
      expect(ledger.readPolicyAttempts(artifacts).slice(1).map(a => [a.provider, a.status])).toEqual(code === 200
        ? [['gemini', 'completed']] : [['gemini', 'failed'], ['gemini', 'failed'], ['codex', code === 401 ? 'completed' : 'failed']]);
    }
    for (const marker of ['candidate marker', 'acceptance marker', 'task marker']) expect(received).toContain(marker);
    for (code of [201, 204, 302, 400, 401, 404, 429, 500, 503])
      await expect(geminiTurn(models[0], 'matrix')).rejects.toThrow(`HTTP ${code}`);
    for (code of [0, -1, -2]) await expect(geminiTurn(models[0], 'matrix', undefined, 25)).rejects.toThrow();
  } finally {
    server.stop(true);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
// prettier-ignore
test('Gemini opt-in preserves the coder and default review', () => {
  const plan = planFor(tmp());
  const nodes = (input: Plan) => buildWorkflow(input, milestones(input), '', plan.repo).nodes as { id: string; model?: string; when: string }[];
  const [native, optIn] = [nodes(plan), nodes({ ...plan, gemini_review: true })].map(list => Object.fromEntries(list.map(node => [node.id, node])));
  expect(native['review-m1-r1'].model).toBe('@sa-reviewer'); expect(optIn['review-m1-r1']).toMatchObject({ model: '@sa-gemini-review', mutates_checkout: false });
  expect(optIn['code-core']).toEqual(native['code-core']); expect(optIn['review-m1-r1'].when).not.toContain('review_required');
});

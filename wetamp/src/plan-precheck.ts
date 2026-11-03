import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { GENERATED_OUTPUT_PATHS, type Plan } from './plan';
import { reasonOf } from './reasons';

const REPEAT_FAILURE_REASONS = new Set([
  'scope_violation',
  'repair_exhausted:scope_violation',
  'acceptance_failed',
  'repair_exhausted:acceptance_failed',
  'ruler_invalid',
  'vacuous_test',
]);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'lost']);

const slash = (path: string): string => path.replaceAll('\\', '/');
export const covered = (path: string, write: string[]): boolean =>
  write.some(
    w => path === w || path.startsWith(w.replace(/\/*$/, '/')) || new Bun.Glob(w).match(path)
  );
const parents = (text: string): string[] =>
  [...text.matchAll(/['"`](\.\.\/[^'"`]+)['"`]/g)].map(match => match[1]);
const git = (repo: string, ...args: string[]): string | undefined => {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 10_000,
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};
const commandTests = (cmd: string): string[] =>
  [...cmd.matchAll(/['"]?([^'"\s;&|]+\.test\.ts)['"]?/g)].flatMap(match => {
    if (/[*?[]/.test(match[1])) return [];
    const before = cmd.slice(0, match.index),
      dirs = [...before.matchAll(/(?:^|&&)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&/g)];
    return [slash(normalize(join(dirs.at(-1)?.slice(1).find(Boolean) ?? '', match[1])))];
  });
const moduleKey = (path: string): string =>
  path.replace(/\.(?:cjs|js|ts)$/, '').replace(/\/index$/, '');
const importedModules = (test: string, text: string): string[] => {
  const aliases = [
    ...text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*createRequire\s*\(/g),
  ].map(match => match[1]);
  const calls = ['import', 'require', ...aliases]
    .map(name => name.replaceAll('$', '\\$'))
    .join('|');
  const literals = [
    ...text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^;'"`]+?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...text.matchAll(new RegExp(`\\b(?:${calls})\\s*\\(\\s*['"]([^'"]+)['"]`, 'g')),
  ];
  return [
    ...new Set(
      literals
        .map(match => match[1])
        .filter(path => path.startsWith('.'))
        .map(path => moduleKey(slash(normalize(join(dirname(test), path)))))
    ),
  ];
};

export interface PlanPrecheck {
  blocking: string[];
  info: string[];
}

const staticAcceptance = (cmd: string): boolean => {
  const staticNames = new Set([
    'type-check',
    'typecheck',
    'tsc',
    'lint',
    'eslint',
    'format',
    'fmt',
    'prettier',
  ]);
  return cmd
    .split(/&&|\|\||[;|]/)
    .map(part => part.trim())
    .filter(Boolean)
    .every(part => {
      const words = part.split(/\s+/).filter(Boolean);
      if (words[0] === 'cd' || words[0] === 'export') return true;
      while (words[0]?.includes('=') && !words[0].startsWith('-')) words.shift();
      if (words[0] === 'env') words.shift();
      const names = words
        .filter(word => !word.startsWith('-'))
        .map(word => word.replace(/^.*\//, ''));
      return names.some(name => staticNames.has(name));
    });
};

// prettier-ignore
const repeatFailures = (plan: Plan, override?: string): PlanPrecheck => {
  if (process.env.SUPERAGENT_MEMORY === 'off')
    return { blocking: [], info: ['重复失败检查已跳过：memory 关闭'] };
  const home = process.env.SUPERAGENT_HOME ?? join(homedir(), '.superagent'), dir = join(home, 'memory/episodes');
  if (!existsSync(dir)) return { blocking: [], info: ['重复失败检查已跳过：episodes 目录不存在'] };
  const now = Date.now(), cutoff = now - 7 * 86400_000,
    counts = new Map<string, { id: string; at: number }[]>(), completedOverruns: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const episode = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { id?: unknown; at?: unknown; project?: unknown; reasons?: unknown; signature?: unknown; status?: unknown };
    const at = typeof episode.at === 'string' ? Date.parse(episode.at) : NaN;
    if (episode.project !== plan.repo || !Number.isFinite(at) || at < cutoff || at > now ||
        !Array.isArray(episode.reasons) || typeof episode.id !== 'string' ||
        typeof episode.signature !== 'string' || !episode.signature) continue;
    if (episode.status === 'completed' && episode.signature === 'duration_overrun') completedOverruns.push(episode.id);
    if (typeof episode.status === 'string' && FAILURE_STATUSES.has(episode.status) &&
        (episode.signature === 'duration_overrun' || episode.reasons.some(reason => typeof reason === 'string' && reasonOf(reason) && REPEAT_FAILURE_REASONS.has(reason))))
      counts.set(episode.signature, [...(counts.get(episode.signature) ?? []), { id: episode.id, at }]);
  }
  const promotionDir = join(home, 'engine/promotions'), passedAfter = (last: number): boolean =>
    existsSync(promotionDir) && readdirSync(promotionDir).filter(name => name.endsWith('.verify.json')).some(name => {
      try {
        const verify = JSON.parse(readFileSync(join(promotionDir, name), 'utf8')) as { sha?: unknown; status?: unknown; at?: unknown },
          verifiedAt = typeof verify.at === 'string' ? Date.parse(verify.at) : NaN;
        if (verify.status !== 'passed' || typeof verify.sha !== 'string' || !Number.isFinite(verifiedAt) || verifiedAt <= last) return false;
        const marker = JSON.parse(readFileSync(join(promotionDir, `${verify.sha}.json`), 'utf8')) as { sha?: unknown; status?: unknown; at?: unknown },
          promotedAt = typeof marker.at === 'string' ? Date.parse(marker.at) : NaN;
        return marker.sha === verify.sha && marker.status === 'promoted' && Number.isFinite(promotedAt) && promotedAt > last;
      } catch { return false; }
    });
  const blocking: string[] = [], info = completedOverruns.length ? [`近 7 天 ${String(completedOverruns.length)} 个已完成 run 超时长，见 superagent report`] : [];
  for (const [signature, occurrences] of counts) {
    if (occurrences.length < 3) continue;
    const latest = occurrences.sort((a, b) => b.at - a.at)[0];
    if (passedAfter(latest.at)) info.push(`近 7 天机制签名 ${signature} ${String(occurrences.length)} 次，PV1 通过后已解除`);
    else blocking.push(`近 7 天机制签名 ${signature} ${String(occurrences.length)} 次（最近 run id: ${latest.id}）；先落地拦截机制，或用 --lint-override 写明已落地机制`);
  }
  // This gate alone is overrideable: the override records the mechanism for audit.
  return override?.trim() ? { blocking: [], info: [...info, ...blocking] } : { blocking, info };
};

export function checkSyntaxErrors(plan: Plan): string[] {
  const groups = [
    { id: 'plan.environment', checks: plan.environment ?? [] },
    ...plan.packages.flatMap(pkg => [
      { id: pkg.id, checks: pkg.accept },
      { id: `${pkg.id}.environment`, checks: pkg.environment ?? [] },
    ]),
  ];
  return groups.flatMap(({ id, checks }) =>
    checks.flatMap((check, index) =>
      [check.cmd, ...(check.report?.collect ? [check.report.collect] : [])].flatMap((cmd, part) => {
        const result = Bun.spawnSync(['bash', '-n', '-c', cmd], {
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: 1_000,
        });
        if (result.exitCode === 0 && !result.signalCode) return [];
        const detail =
          result.stderr.toString().trim().split(/\r?\n/, 1)[0] ||
          `bash exit ${String(result.exitCode)}`;
        return [`${id}#${String(index + 1)}${part ? '.collect' : ''}: ${detail}`];
      })
    )
  );
}

// Keep these checks together: dispatch must have one non-bypassable source of truth.
// prettier-ignore
export function planPrecheck(plan: Plan, repo: string, override?: string): PlanPrecheck {
  const scriptsDir = join(repo, 'wetamp/scripts');
  const engineRepo = existsSync(join(scriptsDir, 'generate-plan-schema.ts'));
  const blocking: string[] = [], info: string[] = [], tree = new Set((git(repo, 'ls-tree', '-r', '--name-only', plan.base_ref) ?? '').split(/\r?\n/).filter(Boolean));
  const tests = [...tree].filter(path => /^wetamp\/(?:scripts|tests)\/[^/]+\.test\.ts$/.test(path) && existsSync(join(repo, path)));
  const consumers = new Map<string, string[]>();
  for (const test of tests) for (const imported of importedModules(test, readFileSync(join(repo, test), 'utf8')))
    consumers.set(imported, [...(consumers.get(imported) ?? []), test]);
  const generators = engineRepo ? readdirSync(scriptsDir).filter(name => /^generate-.*\.ts$/.test(name)).flatMap(name => {
    const script = `wetamp/scripts/${name}`, text = readFileSync(join(repo, script), 'utf8');
    const body = text.replace(/GENERATED_OUTPUT_PATHS\s*=\s*\[[\s\S]*?\]/, '');
    const outputs = GENERATED_OUTPUT_PATHS.filter(output => body.includes(output.slice(7)));
    if (!outputs.length) return [];
    const inputs = parents(text).flatMap(literal => {
      const templated = literal.includes('${');
      const base = templated ? literal.split('${', 1)[0].replace(/[^/]*$/, '') : literal;
      const path = slash(normalize(join('wetamp/scripts', base)));
      if (templated || (existsSync(join(repo, path)) && statSync(join(repo, path)).isDirectory()))
        return [path.replace(/\/*$/, '/')];
      return [path, `${path}.ts`, `${path}.json`, `${path}/index.ts`].filter(candidate => existsSync(join(repo, candidate)));
    });
    return [{ script, inputs: [...new Set(inputs)].filter(input => !(outputs as readonly string[]).includes(input)), outputs }];
  }) : [];
  for (const pkg of plan.packages) {
    const write = pkg.scope.write, commands = pkg.accept.map(check => check.cmd);
    const prefix = `[${pkg.id}] `;
    if (pkg.review === true && !pkg.review_reason?.trim())
      info.push(`${prefix}review:true 已忽略：评审只由白名单命中或用户原话触发`);
    if (pkg.risk !== 'G0' && pkg.accept.every(check => staticAcceptance(check.cmd)))
      (override?.trim() ? info : blocking).push(`${prefix}G1/G2 包至少需要一条非纯静态的冒烟/行为测试；可用 --lint-override 覆盖`);
    for (const cmd of commands) for (const test of commandTests(cmd))
      if (!tree.has(test) && !covered(test, write)) blocking.push(`${prefix}修正验收命令 ${cmd}（base_ref 不存在 ${test}）或把 ${test} 加入 scope.write`);
    const sources = [...tree].filter(path => (/^wetamp\/src\/.+\.ts$/.test(path) || /^wetamp\/hooks\/[^/]+\.cjs$/.test(path)) && covered(path, write));
    for (const source of sources) {
      const callers = consumers.get(moduleKey(source)) ?? [];
      const missing = callers.filter(test => !covered(test, write) && !covered(test, pkg.scope.read_hint ?? []));
      if (!missing.length) continue;
      const message = `${prefix}${source} 的直接单元测试调用方：${missing.join(', ')}；加入 scope.write，或写入 scope.read_hint 说明无需修改`;
      if (callers.length > 15) info.push(`${message}（枢纽模块，共 ${String(callers.length)} 个测试，仅提示）`);
      else blocking.push(message);
    }
    for (const generator of generators) {
      const touched = generator.inputs.some(input => covered(input, write) ||
        (input.endsWith('/') && write.some(path => path.startsWith(input))));
      const missing = generator.outputs.filter(output => !covered(output, write));
      if (touched && missing.length)
        blocking.push(`${prefix}${generator.script} 输入在 scope，缺产出：${missing.join(', ')}；把产出加入 scope.write`);
    }
  }
  const repeated = repeatFailures(plan, override);
  return { blocking: [...blocking, ...repeated.blocking], info: [...info, ...repeated.info] };
}

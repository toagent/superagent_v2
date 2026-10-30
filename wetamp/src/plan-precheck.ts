import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import { GENERATED_OUTPUT_PATHS, type Plan } from './plan';
import { reasonOf } from './reasons';

const REPEAT_FAILURE_CATEGORIES = {
  scope: ['scope_violation', 'repair_exhausted:scope_violation'],
  acceptance: [
    'acceptance_failed',
    'repair_exhausted:acceptance_failed',
    'ruler_invalid',
    'vacuous_test',
  ],
} as const;

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

export interface PlanPrecheck {
  blocking: string[];
  info: string[];
}

// prettier-ignore
const repeatFailures = (plan: Plan, override?: string): PlanPrecheck => {
  if (process.env.SUPERAGENT_MEMORY === 'off')
    return { blocking: [], info: ['重复失败检查已跳过：memory 关闭'] };
  const dir = join(process.env.SUPERAGENT_HOME ?? join(homedir(), '.superagent'), 'memory/episodes');
  if (!existsSync(dir)) return { blocking: [], info: ['重复失败检查已跳过：episodes 目录不存在'] };
  const now = Date.now(), cutoff = now - 7 * 86400_000,
    counts = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const episode = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { id?: unknown; at?: unknown; project?: unknown; reasons?: unknown };
    const at = typeof episode.at === 'string' ? Date.parse(episode.at) : NaN;
    if (episode.project !== plan.repo || !Number.isFinite(at) || at < cutoff || at > now ||
        !Array.isArray(episode.reasons) || typeof episode.id !== 'string') continue;
    for (const [category, reasons] of Object.entries(REPEAT_FAILURE_CATEGORIES))
      if (episode.reasons.some(reason => typeof reason === 'string' && reasonOf(reason) &&
          (reasons as readonly string[]).includes(reason)))
        counts.set(category, [...(counts.get(category) ?? []), episode.id]);
  }
  const messages = [...counts].filter(([, ids]) => ids.length >= 3).map(([category, ids]) =>
    `近 7 天同类失败 ${category} ${String(ids.length)} 次（run ids: ${ids.join(', ')}）；先落地拦截机制，或用 --lint-override 写明已落地机制`);
  // This gate alone is overrideable: the override records the mechanism for audit.
  return override?.trim() ? { blocking: [], info: messages } : { blocking: messages, info: [] };
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
    for (const cmd of commands) for (const test of commandTests(cmd))
      if (!tree.has(test) && !covered(test, write)) blocking.push(`${prefix}修正验收命令 ${cmd}（base_ref 不存在 ${test}）或把 ${test} 加入 scope.write`);
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

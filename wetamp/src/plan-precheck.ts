import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import { GENERATED_OUTPUT_PATHS, type Plan } from './plan';

const slash = (path: string): string => path.replaceAll('\\', '/');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const covered = (path: string, write: string[]): boolean =>
  write.some(
    w => path === w || path.startsWith(w.replace(/\/*$/, '/')) || new Bun.Glob(w).match(path)
  );
const parents = (text: string): string[] =>
  [...text.matchAll(/['"`](\.\.\/[^'"`]+)['"`]/g)].map(match => match[1]);

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

// Keep the four checks together: they intentionally mirror the dispatch-time scope precheck.
// prettier-ignore
export function planPrecheck(plan: Plan, repo: string): string[] {
  const scenarioDir = join(repo, 'wetamp/tests/scenarios'), scriptsDir = join(repo, 'wetamp/scripts');
  if (!existsSync(scenarioDir) || !existsSync(join(scriptsDir, 'generate-plan-schema.ts'))) return [];
  const warnings: string[] = [], scenarios = files(scenarioDir).map(path => ({
    path: slash(relative(repo, path)), text: readFileSync(path, 'utf8'),
  }));
  const generators = readdirSync(scriptsDir).filter(name => /^generate-.*\.ts$/.test(name)).flatMap(name => {
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
  });
  for (const pkg of plan.packages) {
    const write = pkg.scope.write, commands = pkg.accept.map(check => check.cmd);
    const joined = commands.join(' '), prefix = `[${pkg.id}] `;
    if (write.some(path => path.startsWith('wetamp/') && /\.(ts|cjs|js|sh)$/.test(path)) &&
        !commands[0]?.includes('bun run type-check'))
      warnings.push(prefix + 'accept[0] 须含 bun run type-check');
    const engine = ['wetamp/src/engine/', 'wetamp/src/gc.ts', 'wetamp/scripts/engine-', 'wetamp/bin/'];
    if (write.some(path => engine.some(owner => path.startsWith(owner))) && !joined.includes('engine-*') &&
        !['engine-channel', 'engine-promote', 'engine-shim'].every(test => joined.includes(test)))
      warnings.push(prefix + '写引擎/gc/shim 须跑 engine-channel、engine-promote、engine-shim 三组测试');
    for (const source of write.filter(path => path.startsWith('wetamp/src/') && path.endsWith('.ts'))) {
      const module = source.slice(7, -3), names = [module, ...(module.endsWith('/index') ? [module.slice(0, -6)] : [])];
      const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const pattern = new RegExp(`['"](?:\\.\\.\\/)+(?:${escaped})(?:\\.ts)?['"]`);
      const users = scenarios.filter(file => pattern.test(file.text) && !covered(file.path, write));
      if (users.length) warnings.push(
        `${prefix}${users.length >= 3 ? '枢纽模块提示' : 'scope 缺场景调用方'}：${source} -> ${users.map(file => file.path).join(', ')}`
      );
    }
    for (const generator of generators) {
      const touched = generator.inputs.some(input => covered(input, write) ||
        (input.endsWith('/') && write.some(path => path.startsWith(input))));
      const missing = generator.outputs.filter(output => !covered(output, write));
      if (touched && missing.length)
        warnings.push(`${prefix}${generator.script} 输入在 scope，缺产出：${missing.join(', ')}`);
    }
  }
  return warnings;
}

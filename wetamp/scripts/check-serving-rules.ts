import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

interface Validator {
  (data: unknown): boolean;
  errors?: unknown[] | null;
}
type AjvCtor = new (options: Record<string, unknown>) => {
  addSchema(schema: unknown, key: string): void;
  compile(schema: unknown): Validator;
};

const hint = '先落地并晋升引擎对新字段的支持，再在后续包里修改规则';
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function main(): void {
  const rulesPath = join(process.cwd(), '.superagent', 'rules.json');
  if (!existsSync(rulesPath)) return;
  const configured =
    process.env.SUPERAGENT_SERVING_ENGINE_DIR ??
    join(process.env.SUPERAGENT_HOME ?? join(homedir(), '.superagent'), 'engine', 'current');
  let engine: string;
  try {
    engine = realpathSync(configured);
  } catch (error) {
    throw new Error(`serving engine unavailable at ${configured}: ${String(error)}`);
  }
  const schemas = join(engine, 'wetamp', 'schemas');
  const require = createRequire(join(engine, 'packages', 'workflows', 'package.json'));
  const ajvModule = require('ajv/dist/2020') as { default: AjvCtor };
  const ajv = new ajvModule.default({ allErrors: true, validateFormats: false });
  ajv.addSchema(json(join(schemas, 'plan.schema.json')), 'plan.schema.json');
  const validate = ajv.compile(json(join(schemas, 'rules.schema.json')));
  if (!validate(json(rulesPath))) {
    throw new Error(
      `rules rejected by serving engine ${basename(engine)}: ${JSON.stringify(validate.errors)}\n${hint}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `serving rules check failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}

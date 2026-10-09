// 上游 eslint 配置不覆盖 wetamp/（类型化规则缺 parserOptions 会崩）。沿用上游规则集，只补 wetamp 的 tsconfig 项目；
// 测试与上游 packages 一样不做类型化 lint。
// ESLint 以 cwd 解析 files/ignores：lint-staged 在 wetamp/ 下运行（嵌套配置），手动 lint 在仓库根运行，前缀按 cwd 计算。
import { relative } from 'node:path';
import upstream from '../eslint.config.mjs';

const here = relative(process.cwd(), import.meta.dirname);
const at = p => (here ? `${here}/${p}` : p);

export default [
  ...upstream,
  { ignores: [at('tests/**')] },
  {
    files: [at('**/*.ts')],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
];

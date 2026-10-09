// 上游 eslint 配置不覆盖 wetamp/（类型化规则缺 parserOptions 会崩）。沿用上游规则集，只补 wetamp 的 tsconfig 项目；
// 测试与上游 packages 一样不做类型化 lint。
import upstream from '../eslint.config.mjs';

export default [
  ...upstream,
  { ignores: ['wetamp/tests/**'] },
  {
    files: ['wetamp/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
];

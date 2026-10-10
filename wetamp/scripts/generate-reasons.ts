// 镜像只供模板独立执行；注册表真源在 src/reasons.ts。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASONS } from '../src/reasons';
writeFileSync(
  join(import.meta.dir, '../templates/.archon/scripts/reasons.json'),
  JSON.stringify(REASONS, null, 2) + '\n'
);

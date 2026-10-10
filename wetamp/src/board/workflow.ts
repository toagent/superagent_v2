import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { home } from '../config';
import type { Ledger } from '../cli';

export const OUTSIDE = '（路径越界，已跳过）';

/**
 * ledger 里的路径（plan、gen_dir、transcript、evidence 及其下文件）解析 realpath 后只允许落在 ledger.repo 或
 * $SUPERAGENT_HOME 之内：ledger 是本地可写文件，不能让它把看板引去读任意文件。不存在返回 null；越界抛错，调用方只丢该项。
 */
export function confined(l: Ledger, p: string): string | null {
  if (!existsSync(p)) return null;
  const real = realpathSync(p);
  const inside = [l.repo, home().sa].some(r => {
    if (!existsSync(r)) return false;
    const root = realpathSync(r);
    return real === root || real.startsWith(root + sep);
  });
  if (!inside) throw new Error(`${p}${OUTSIDE}`);
  return real;
}

export type Role = 'coder' | 'reviewer' | 'human' | 'script';

/**
 * 生成的工作流里每个节点的角色（按节点定义：@sa-coder/@sa-reviewer 别名、wait 事件门，其余为脚本）；节点总数也取自这里，
 * 因为 run 的 nodes 只列已调度的节点。gen 目录缺失或解析失败返回 undefined：表格退回 run 的节点数、角色显示 `?`。
 */
export function workflowRoles(l: Ledger): Map<string, Role> | undefined {
  try {
    const file = confined(
      l,
      join(l.gen_dir, '.archon', 'workflows', l.workflow, `${l.workflow}.yaml`)
    );
    if (!file) return undefined;
    const wf = Bun.YAML.parse(readFileSync(file, 'utf8')) as {
      nodes?: { id: string; model?: string; wait?: unknown }[];
    };
    return new Map(
      (wf.nodes ?? []).map(n => [
        n.id,
        n.model === '@sa-coder'
          ? 'coder'
          : n.model === '@sa-reviewer'
            ? 'reviewer'
            : n.wait
              ? 'human'
              : 'script',
      ])
    );
  } catch {
    return undefined;
  }
}

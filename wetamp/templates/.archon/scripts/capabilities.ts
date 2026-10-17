import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Provider = 'claude' | 'codex';
interface Capability {
  id: string;
  when: { role: string[]; failure_class?: string; risk?: string; scope?: string[] };
  use: Record<Provider, string>;
  purpose: string;
}
export interface CapabilityInput {
  role: string;
  failure_classes: string[];
  risk: string;
  scope: string[];
}

export const loadCapabilities = (path: string): Capability[] => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error('capabilities: expected an array');
  return value as Capability[];
};

const matches = (capability: Capability, input: CapabilityInput): boolean => {
  const when = capability.when;
  const pathMatch = (pattern: string, path: string) =>
    (pattern.startsWith('*.') && path.endsWith(pattern.slice(1))) ||
    new Bun.Glob(pattern).match(path);
  return (
    when.role.includes(input.role) &&
    (!when.failure_class || input.failure_classes.includes(when.failure_class)) &&
    (!when.risk || input.risk === when.risk) &&
    (!when.scope || when.scope.some(pattern => input.scope.some(path => pathMatch(pattern, path))))
  );
};

export function capabilityDrift(path: string, home: string) {
  return loadCapabilities(path).flatMap(capability =>
    (Object.entries(capability.use) as [Provider, string][]).flatMap(([provider, skill]) =>
      existsSync(join(home, `.${provider}`, 'skills', skill, 'SKILL.md'))
        ? []
        : [{ id: capability.id, provider, skill }]
    )
  );
}

export const capabilityGuidance = (path: string, ids: string[]) =>
  loadCapabilities(path)
    .filter(capability => ids.includes(capability.id))
    .map(
      capability =>
        `可用技能 Claude: ${capability.use.claude}；Codex: ${capability.use.codex}：${capability.purpose}；本节点最多调用一次，不调用其编排/发布类子流程`
    );

export function resolveCapabilities(path: string, home: string, input: CapabilityInput) {
  const drift = capabilityDrift(path, home);
  const matched = loadCapabilities(path).filter(capability => matches(capability, input));
  const unavailable = matched.filter(capability => drift.some(item => item.id === capability.id));
  const injected = matched.filter(capability => !unavailable.includes(capability));
  return {
    evidence: { injected: injected.map(c => c.id), unavailable: unavailable.map(c => c.id) },
    guidance: capabilityGuidance(
      path,
      injected.map(c => c.id)
    ),
  };
}

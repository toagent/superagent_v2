import { setLogDestination } from '@archon/paths';
import {
  foldDagResumeSnapshot,
  type DagResumeEvent,
} from '../../packages/workflows/src/dag-resume-snapshot';
import {
  resolveNodeBindings,
  type ShellInputContext,
} from '../../packages/workflows/src/dag-executor';
import { canonicalValueText } from '../../packages/workflows/src/output-ref';
import { freezeContext } from '../templates/.archon/scripts/sa-context';

/** One authoritative event snapshot owns all acceptance refs and permission evidence. */
export async function resolveAcceptanceContext(
  run: ShellInputContext['workflowRun'] & { events?: DagResumeEvent[] },
  contracts: Record<string, string>[],
  art: string
) {
  if (!Array.isArray(run.events)) throw new Error('accept: missing authoritative run events');
  const snapshot = await foldDagResumeSnapshot(run.events, run.id);
  const ctx: ShellInputContext = {
    workflowRun: run,
    artifactsDir: art,
    stateDir: '',
    baseBranch: '',
    docsDir: '',
    nodeOutputs: new Map(
      [...snapshot.completedNodeOutputs].map(([id, out]) => [
        id,
        { ...out, state: 'completed' as const },
      ])
    ),
  };
  const inputs = contracts.map(input =>
    Object.fromEntries(
      Object.entries(resolveNodeBindings(input.tag!, input, ctx, undefined)).map(([key, value]) => [
        key,
        canonicalValueText(value),
      ])
    )
  );
  return { inputs, events_file: freezeContext(art, { id: run.id, events: run.events }) };
}

if (import.meta.main) {
  // Canonical hydration can log diagnostics; stdout is exclusively the JSON protocol.
  setLogDestination('stderr');
  const { run, contracts, art } = await Bun.stdin.json();
  const result = await resolveAcceptanceContext(run, contracts, art);
  process.stdout.write(JSON.stringify(result) + '\n');
}

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Intake, intakeRoot } from './intake';

const advisory = (event: string) => ({
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext:
      'SUPERAGENT intake advisory: capture/restore unavailable; use explicit intake. Original prompt remains allowed.',
  },
});

/** No transcript reads, model calls, lifecycle decisions, or native configuration writes. */
export function nativeIntake(raw: unknown, client: string, env = process.env): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return advisory('UserPromptSubmit');
  const p = raw as Record<string, unknown>;
  const event = p.hook_event_name;
  if (event !== 'UserPromptSubmit' && event !== 'SessionStart') return;
  if (!['claude', 'codex'].includes(client)) return advisory(event);
  if (
    ['general', 'strategist', 'reviewer', 'worker'].includes(env.SUPERAGENT_ROLE ?? '') ||
    env.AI_DISPATCH_ROLE === 'general' ||
    env.TWIN_AGENT_REMOTE === '1' ||
    (typeof p.agent_type === 'string' &&
      p.agent_type.trim() &&
      typeof p.agent_id === 'string' &&
      p.agent_id.trim())
  )
    return;
  try {
    if (typeof p.cwd !== 'string') return advisory(event);
    const git = (...args: string[]): string | undefined => {
      const r = Bun.spawnSync(['git', '-C', p.cwd as string, 'rev-parse', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
      });
      return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
    };
    const top = git('--show-toplevel');
    if (!top) return;
    const repo = realpathSync(top);
    const dir = git('--absolute-git-dir'),
      common = git('--path-format=absolute', '--git-common-dir');
    if (!dir || !common) return advisory(event);
    if (realpathSync(dir) !== realpathSync(common)) return;
    const root = intakeRoot(env.SUPERAGENT_HOME || join(homedir(), '.superagent'), repo);
    if (!existsSync(join(root, 'state.json'))) return;
    const store = new Intake(root);
    if (!store.list().some(t => t.repo === repo)) return;
    if (typeof p.session_id !== 'string' || !p.session_id.trim()) return advisory(event);
    const identity = store.nativeIdentity(repo, client, p.session_id);
    if (!identity && event === 'UserPromptSubmit') return advisory(event);
    let inputKey: string | undefined;
    if (event === 'UserPromptSubmit') {
      if (!identity) return advisory(event);
      const message = client === 'codex' ? p.turn_id : randomUUID();
      if (
        typeof message !== 'string' ||
        !message.trim() ||
        typeof p.prompt !== 'string' ||
        !p.prompt.trim()
      )
        return advisory(event);
      const input = {
        source: client,
        session: p.session_id,
        message,
        text: p.prompt,
        repo,
        ...identity,
      };
      store.receive(input);
      inputKey = JSON.stringify([client, p.session_id, message]);
    }
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: JSON.stringify({
          intake: store.context(repo, 4096),
          inputKey,
          instruction:
            'Interpret with typed intake apply; status-only uses actions: []. Preserve old Tasks unless explicitly cancelled; after answering/amending continue original work. Cross-owner changes require handoff. Read intake context 4096 <next> until next is null before judging scope or reporting progress; later items need a new traversal. Use intake backlog as the progress source and intake show/input for full bodies.',
          ...(client === 'claude'
            ? {
                transport:
                  'Random invocation ID: retransmissions across invocations cannot be precisely deduplicated.',
              }
            : {}),
        }),
      },
    };
  } catch {
    return advisory(event);
  } // Never expose a payload or persistence error's contents.
}

if (import.meta.main) {
  let result: unknown;
  try {
    result = nativeIntake(JSON.parse(await Bun.stdin.text()), process.argv[2] ?? '');
  } catch {
    result = advisory('UserPromptSubmit');
  }
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

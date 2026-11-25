#!/usr/bin/env node
'use strict';
// Advisory only: malformed input, missing usage and unavailable state are no-ops.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const LIMIT = 256 * 1024;
// Neon agy statusLine reports context_window.context_window_size:
// https://antigravity.google/docs/cli/statusline
const AGY_WINDOW = 1048576;
function recentUsage(file, client = 'claude') {
  let fd;
  try {
    if (client === 'agy' && path.extname(file) === '.db') {
      const conversations = path.dirname(file),
        id = path.basename(file, '.db');
      if (path.basename(conversations) !== 'conversations' || !id || id === '.' || id === '..')
        return null;
      file = path.join(
        path.dirname(conversations), 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'
      );
    }
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size,
      start = Math.max(0, size - LIMIT);
    const buffer = Buffer.alloc(Math.min(size, LIMIT));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let event;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (client === 'agy') {
        if (event?.type !== 'PLANNER_RESPONSE') continue;
        const { input_tokens, cache_read_tokens } = event;
        const tokens = input_tokens + cache_read_tokens;
        return [input_tokens, cache_read_tokens, tokens].every(n => Number.isSafeInteger(n) && n >= 0)
          ? { tokens, window: AGY_WINDOW }
          : null;
      }
      if (client === 'codex') {
        const info = event.payload?.type === 'token_count' ? event.payload.info : null,
          u = info?.last_token_usage;
        // Codex input_tokens already includes cached_input_tokens.
        if (Number.isSafeInteger(u?.input_tokens) && u.input_tokens >= 0)
          return {
            tokens: u.input_tokens,
            window:
              Number.isSafeInteger(info.model_context_window) && info.model_context_window > 0
                ? info.model_context_window
                : null,
          };
        continue;
      }
      const u = event.message?.usage || event.usage;
      if (!u || typeof u !== 'object') continue;
      const values = [
        u.input_tokens,
        u.cache_read_input_tokens ?? 0,
        u.cache_creation_input_tokens ?? 0,
      ];
      if (values.every(v => Number.isSafeInteger(v) && v >= 0))
        return { tokens: values.reduce((a, b) => a + b, 0), window: null };
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}
// role: commander | general | strategist (guard.sessionRole); advisory thresholds from policy.context.
function contextPolicy(policy) {
  if (policy === undefined) {
    try {
      policy = require('../tiers.json').policy;
    } catch {}
  }
  return policy?.context || {};
}
function roleLimit(role, policy) {
  const value = contextPolicy(policy).advisory_tokens?.[role];
  return Number.isSafeInteger(value) && value > 0 ? value : 160000;
}
function contextLimits(role, client, reportedWindow, env = process.env, policy) {
  const context = contextPolicy(policy),
    oldRollover = context.rollover_tokens?.[role],
    fallback = {
      threshold: roleLimit(role, policy),
      rollover: Number.isSafeInteger(oldRollover) && oldRollover > 0 ? oldRollover : null,
      window: null,
    };
  let window = client === 'agy' ? AGY_WINDOW : reportedWindow;
  if (client === 'claude') window = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || 200000);
  if (!Number.isSafeInteger(window) || window <= 0)
    return { ...fallback, advisoryStep: 40000, rolloverStep: 100000 };
  let compact = window * 0.7;
  if (client === 'agy') {
    compact = window;
  } else if (client === 'claude') {
    const percent = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE || 95);
    compact = window * (Number.isFinite(percent) && percent > 0 ? percent / 100 : 0.95);
  } else
    try {
      const home = env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex'),
        root = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split(/^\s*\[/m, 1)[0],
        match = root.match(/^\s*model_auto_compact_token_limit\s*=\s*(\d+)\s*(?:#.*)?$/m);
      if (match) compact = Number(match[1]);
    } catch {}
  const ratio = context.advisory_ratio?.[role],
    rolloverRatio = context.rollover_ratio?.[role];
  return {
    threshold:
      Number.isFinite(ratio) && ratio > 0 ? Math.floor(window * ratio) : fallback.threshold,
    rollover:
      Number.isFinite(rolloverRatio) && rolloverRatio > 0
        ? Math.max(1, Math.floor(Math.min(window * rolloverRatio, compact - window * 0.1)))
        : fallback.rollover,
    window,
    advisoryStep: Math.floor(window * 0.05),
    rolloverStep: Math.floor(window * 0.1),
  };
}
function advise(
  _input,
  tokens,
  prior = {},
  _active = false,
  threshold = roleLimit('commander'),
  rollover = contextLimits('commander', 'codex', null).rollover,
  env = process.env,
  advisoryStep = 40000,
  rolloverStep = 100000,
  window = null
) {
  if (tokens === null) return { state: prior, messages: [] };
  const state = { ...prior },
    messages = [];
  if (Number.isFinite(state.warned_at) && tokens < state.warned_at) delete state.warned_at;
  if (Number.isFinite(state.rollover_at) && tokens < state.rollover_at) delete state.rollover_at;
  const usage =
      Number.isSafeInteger(window) && window > 0
        ? `（${Math.round((tokens / window) * 100)}%）`
        : '',
    line =
      Number.isSafeInteger(window) && window > 0 && rollover !== null
        ? `（${Math.round((rollover / window) * 100)}%）`
        : '';
  if (
    rollover !== null &&
    tokens > rollover &&
    (!Number.isFinite(state.rollover_at) || tokens >= state.rollover_at + rolloverStep)
  ) {
    messages.push(
      env.ORCA_AGENT_SESSION_ID
        ? `上下文约 ${tokens} token${usage}，已过换会话线 ${rollover}${line}：在任务栈写好断点并补齐「接手必读」「在途」「已核实与更正」三节（无内容写「无」），然后执行 superagent rollover start，按输出在后台运行 superagent rollover wait 后结束本轮。`
        : `上下文约 ${tokens} token${usage}，已过换会话线 ${rollover}${line}：在任务栈写好断点并把状态改为「被中断」（没有任务栈先 tasks.sh new <slug>），然后新开会话执行 tasks.sh list，再 tasks.sh adopt <列表中的会话目录名> 接手。`
    );
    state.rollover_at = state.warned_at = tokens;
  } else if (rollover !== null && tokens > rollover) {
    return { state, messages };
  } else if (
    tokens > threshold &&
    (!Number.isFinite(state.warned_at) || tokens >= state.warned_at + advisoryStep)
  ) {
    messages.push(
      `上下文约 ${tokens} token${usage}（advisory），换会话线 ${rollover ?? 'unknown'}${line}；advisory 只是提醒，未收到换会话指令前不要换会话。把读文件、跑测试、长输出交给 superagent 或将军，只读 ≤20 行结果。`
    );
    state.warned_at = tokens;
  }
  return { state, messages };
}
function rolloverNotice(input, client, env = process.env) {
  try {
    const home = env.SUPERAGENT_HOME || path.join(require('node:os').homedir(), '.superagent'),
      dir = path.join(home, 'coord', 'rollovers');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (
        record?.state === 'accepted' &&
        record.from?.session_id === input?.session_id &&
        record.from?.client === client
      )
        return `本会话已于 ${record.accepted_at} 交接给 ${record.to?.client} ${String(record.to?.session_id).slice(0, 8)}（rollover ${String(record.token).slice(0, 8)}）：立即停止写入，不再改文件、派单或提交；用户在此发言时请其到新标签继续。`;
    }
  } catch {}
  return null;
}
function advisoryFile(input, env) {
  const home = env.SUPERAGENT_HOME || path.join(require('node:os').homedir(), '.superagent'),
    key = crypto
      .createHash('sha256')
      .update(String(input.session_id || input.transcript_path))
      .digest('hex');
  return path.join(home, 'hooks', 'context-advisory', `${key}.json`);
}
function agyRollover(input, env) {
  const notice = rolloverNotice(input, 'agy', env);
  if (notice) return notice;
  const usage = recentUsage(input.transcript_path, 'agy');
  if (!usage) return null;
  const { rollover, rolloverStep, window } = contextLimits('commander', 'agy', usage.window, env);
  if (rollover === null) return null;
  return require('./hook-state.cjs').withState(advisoryFile(input, env), state => {
    if (usage.tokens <= rollover) {
      delete state.rollover_at;
      return null;
    }
    // Keep the last reminder while usage fluctuates above the line.
    if (Number.isSafeInteger(state.rollover_at) && usage.tokens < state.rollover_at + rolloverStep)
      return null;
    // agy has no non-interrupting advisory channel. PreToolUse can only deliver a denial reason.
    const result = advise(input, usage.tokens, state, false, Infinity, rollover, env, 0, rolloverStep, window);
    state.rollover_at = result.state.rollover_at;
    return result.messages[0] ?? null;
  });
}
function main(input, client = 'claude') {
  let inbox = [];
  try {
    inbox =
      require('./live.cjs').beat(client, input, () =>
        require('./guard.cjs').sessionRole(input, client)
      ) || [];
  } catch {}
  const context = require('./coord.cjs').notifications(inbox),
    rollover = ['UserPromptSubmit', 'PreToolUse'].includes(input?.hook_event_name)
      ? rolloverNotice(input, client)
      : null;
  let advisory = null;
  if (['UserPromptSubmit', 'PreToolUse'].includes(input?.hook_event_name))
    try {
      const usage = recentUsage(input.transcript_path, client),
        file = advisoryFile(input, process.env),
        role = require('./guard.cjs').sessionRole(input, client);
      if (usage !== null)
        advisory = require('./hook-state.cjs').withState(file, state =>
          require('./hook-state.cjs').once(
            state,
            'context',
            input,
            () => {
              const limits = contextLimits(role, client, usage.window),
                result = advise(
                  input,
                  usage.tokens,
                  state,
                  false,
                  limits.threshold,
                  limits.rollover,
                  process.env,
                  limits.advisoryStep,
                  limits.rolloverStep,
                  limits.window
                );
              Object.assign(state, result.state);
              return result.messages.join('\n') || null;
            },
            false
          )
        );
    } catch {} // Advisory cannot deny; failed transactions never reset usage state.
  const additionalContext = [rollover, context, advisory].filter(Boolean).join('\n');
  return additionalContext
    ? { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext } }
    : null;
}
if (require.main === module) {
  try {
    const result = main(JSON.parse(fs.readFileSync(0, 'utf8')), process.argv[2] || 'claude');
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch {}
  // Never emit a denial or a nonzero status, even if state/transcript I/O fails.
}
module.exports = { recentUsage, advise, main, roleLimit, contextLimits, rolloverNotice, agyRollover, LIMIT };

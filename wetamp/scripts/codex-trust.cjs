#!/usr/bin/env node
// Codex hook 信任（~/.codex/config.toml 的 [hooks.state."<hooks.json>:<event_snake>:<gi>:<hi>"] trusted_hash）。
// Codex 跳过定义改过但未重新信任的 hook；guard.cjs 是 worker 执行层红线与 N-1 的唯一载体，故安装时为本 wetamp/hooks/
// 的条目写信任，codex-worker 启动前核验。hash 按 codex-rs hooks discovery 的 NormalizedHookIdentity：键排序紧凑 JSON 的 sha256。
// 纯 node（--remote-hooks 只要 node）；check/verify 读 TOML 需要 Bun.TOML（bun 运行），node 下失败关闭。
//   write [--dry-run]   为 CODEX_HOME/hooks.json 里本 wetamp/hooks/ 的条目写 trusted_hash：只动这些键，其余文本（含注释）原样；
//                       改动前备份到 $SUPERAGENT_HOME/backups/codex-trust-<UTC>/，同目录临时文件 + rename 原子替换
//   check               codex-worker 闸：有受信任且启用的 guard.cjs PreToolUse 条目 → 0，否则 1
//   verify              只读：hooks.json 全部条目里有 trusted_hash 的数目与算出值相符的数目（只输出两个计数）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const envOr = (k, d) => (process.env[k] ? process.env[k] : d);
const codexHome = envOr('CODEX_HOME', path.join(os.homedir(), '.codex'));
const hooksFile = path.join(codexHome, 'hooks.json');
const configFile = path.join(codexHome, 'config.toml');
const OURS = path.join(fs.realpathSync(path.join(__dirname, '..')), 'hooks') + '/';

const snake = e => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const sorted = v =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]))
  : v;

/** hooks.json 每个 command 条目：state 键与 Codex 会核对的 trusted_hash。 */
function entries() {
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks || {};
  const out = [];
  for (const [event, groups] of Object.entries(hooks))
    (groups || []).forEach((g, gi) =>
      (g.hooks || []).forEach((h, hi) => {
        if (h.type !== 'command' || typeof h.command !== 'string') return;
        const hook = { type: 'command', command: h.command, timeout: Math.max(1, h.timeout ?? 600), async: Boolean(h.async ?? false) };
        if (h.statusMessage != null) hook.statusMessage = h.statusMessage;
        const ident = { event_name: snake(event), hooks: [hook] };
        if (g.matcher != null) ident.matcher = g.matcher;
        const hash = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sorted(ident))).digest('hex');
        out.push({ key: `${hooksFile}:${snake(event)}:${gi}:${hi}`, event, command: h.command, hash });
      })
    );
  return out;
}

const tomlStr = s => JSON.stringify(s); // 路径不含控制字符时 JSON 字符串即合法 TOML 基本字符串
const lit = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文本级改写：已有 [hooks.state."key"] 表则替换/补 trusted_hash，没有则末尾追加；键以其他写法出现时拒绝（不制造重复键）。 */
function setTrust(text, key, hash) {
  const lines = text.split('\n');
  const header = new RegExp(`^\\s*\\[\\s*hooks\\s*\\.\\s*state\\s*\\.\\s*${lit(tomlStr(key))}\\s*\\]\\s*(#.*)?$`);
  const at = lines.flatMap((l, i) => (header.test(l) ? [i] : []));
  const mentions = text.split(tomlStr(key)).length - 1;
  if (at.length > 1 || mentions !== at.length) throw new Error(`${configFile}: ${key} is written in a form this installer does not edit; trust it with /hooks in Codex`);
  const want = `trusted_hash = ${tomlStr(hash)}`;
  if (!at.length) return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[hooks.state.${tomlStr(key)}]\n${want}\n`;
  let end = at[0] + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const i = lines.slice(at[0] + 1, end).findIndex(l => /^\s*trusted_hash\s*=/.test(l));
  if (i < 0) lines.splice(at[0] + 1, 0, want);
  else lines[at[0] + 1 + i] = want;
  return lines.join('\n');
}

function write(dry) {
  if (!fs.existsSync(hooksFile)) return `codex trust: no ${hooksFile}\n`;
  const raw = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  let text = raw;
  const mine = entries().filter(e => e.command.includes(OURS));
  for (const e of mine) text = setTrust(text, e.key, e.hash);
  if (text === raw) return `codex trust: ${mine.length} entries already trusted\n`;
  if (dry) return `codex trust: would trust ${mine.length} entries in ${configFile}\n`;
  if (raw) {
    const dir = path.join(envOr('SUPERAGENT_HOME', path.join(os.homedir(), '.superagent')), 'backups',
      `codex-trust-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(configFile, path.join(dir, 'config.toml'));
  }
  const mode = raw ? fs.statSync(configFile).mode & 0o777 : 0o600;
  const tmp = `${configFile}.sa-tmp-${process.pid}`;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, configFile);
  return `codex trust: trusted ${mine.length} entries in ${configFile}\n`;
}

/** Bun.TOML 解析出的 hooks.state；node 下没有 TOML 解析器 → 抛错，调用方失败关闭。 */
function state() {
  if (typeof Bun === 'undefined') throw new Error('reading config.toml needs bun (Bun.TOML)');
  const doc = Bun.TOML.parse(fs.readFileSync(configFile, 'utf8'));
  return (doc.hooks && doc.hooks.state) || {};
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'write') process.stdout.write(write(rest.includes('--dry-run')));
  else if (cmd === 'check') {
    const s = state();
    const ok = entries().some(e => e.event === 'PreToolUse' && e.command.includes('hooks/guard.cjs')
      && s[e.key]?.enabled !== false && s[e.key]?.trusted_hash === e.hash);
    process.exit(ok ? 0 : 1);
  } else if (cmd === 'verify') {
    const s = state();
    const had = entries().filter(e => s[e.key]?.trusted_hash);
    console.log(JSON.stringify({ trusted: had.length, match: had.filter(e => s[e.key].trusted_hash === e.hash).length }));
  } else {
    console.error('usage: codex-trust.cjs write [--dry-run] | check | verify');
    process.exit(64);
  }
} catch (e) {
  console.error(`codex-trust ${cmd}: ${e.message}`);
  process.exit(cmd === 'write' ? 1 : 2);
}

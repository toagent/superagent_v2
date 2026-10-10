// 错误/输出文本的值脱敏：cli 的 failed 原因用这里。board/detail.ts 仍有同一份（并行包 WP-BT3 在改 board/），
// tests/cli.test.ts 的一致性测试逐例比对两份；BT3 合并后 detail.ts 改为从这里导入并删掉副本。
// 带引号的值（支持 \" 转义；被上游截断、没有收尾引号时到行尾）
const QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`;
const SECRETS: RegExp[] = [
  // Authorization 的整个值（ApiKey x、Bearer x、Basic x…）：到行尾或到所在 JSON 字符串的收尾引号
  new RegExp(String.raw`\b(authorization)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:[^"\\\n]|\\.)*)`, 'gi'),
  new RegExp(
    String.raw`\b([\w-]*(?:token|key|secret|password)[\w-]*)(["']?\s*[:=]\s*)(?:${QUOTED}|(?:bearer\s+)?[^\s"',;}]+)`,
    'gi'
  ),
  /\b(bearer)(\s+)[^\s"',;}]+/gi,
];

/**
 * 值脱敏（与 codex-worker M-03 同一组键名）：`token=…`、`password="a b"`、`"api_key":"…"`、`Authorization: …`、
 * `Bearer …` 的值整体换成 ***。调用方先对整段脱敏再截尾：先截尾可能把键名截掉、只剩裸值。
 */
export const redact = (s: string): string => SECRETS.reduce((t, re) => t.replace(re, '$1$2***'), s);

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {policy} = require('../tiers.json');
const limit = policy.micro_edit;
if (!Number.isInteger(limit.max_lines) || limit.max_lines < 0 || !Number.isInteger(limit.max_files) || limit.max_files < 0 || typeof limit.allow_new_code_files !== 'boolean')
  throw new Error('Invalid micro_edit policy');
function glob(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i,i+3) === '**/') { source += '(?:.*/)?'; i += 2; }
    else if (pattern.slice(i,i+2) === '**') { source += '.*'; i++; }
    else if (pattern[i] === '*') source += '[^/]*';
    else if (pattern[i] === '?') source += '[^/]';
    else source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp('^' + source + '$','i');
}
const patterns = list => list.map(value => ({basename: !value.includes('/'), regex: glob(value)}));
const risks = patterns(policy.risk_paths), exemptions = patterns(policy.exempt_paths);
const matches = (file, list) => list.some(item => item.regex.test(item.basename ? path.posix.basename(file) : file));
const riskPath = file => matches(file,risks);
// Risk paths take precedence over documentation/scratch exemptions.
const guardedPath = file => riskPath(file) || !matches(file,exemptions);
const lines = text => text === '' ? [] : text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
function changedLines(oldText, newText) {
  let before = lines(oldText), after = lines(newText);
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd-1] === after[newEnd-1]) { oldEnd--; newEnd--; }
  before = before.slice(start,oldEnd); after = after.slice(start,newEnd);
  // Replacements count max(added, removed); unchanged lines don't consume quota.
  // Large inputs use a conservative bound instead of quadratic work.
  if (before.length * after.length > 1000000) return Math.max(before.length,after.length);
  const row = new Uint32Array(after.length + 1);
  for (const value of before) {
    let diagonal = 0;
    for (let j = 1; j <= after.length; j++) {
      const previous = row[j];
      row[j] = value === after[j-1] ? diagonal + 1 : Math.max(row[j],row[j-1]);
      diagonal = previous;
    }
  }
  return Math.max(before.length,after.length) - row[after.length];
}
function patchEdits(input) {
  const patch = typeof input === 'string' ? input : input.command || input.input || input.patch || '';
  const rows = patch.trim().split('\n');
  if (rows.shift() !== '*** Begin Patch' || rows.pop() !== '*** End Patch') throw new Error('无法确认 patch 写入范围');
  const edits = []; let edit;
  for (const row of rows) {
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(row);
    if (header) {
      edit = {file:header[2], kind:header[1], added:0, removed:0}; edits.push(edit);
    } else if (edit && row.startsWith('*** Move to: ') && edit.kind === 'Update File') {
      edits.push({file:row.slice(13),kind:'Move',added:0,removed:0});
    } else if (edit && row.startsWith('+')) edit.added++;
    else if (edit && edit.kind === 'Update File' && row.startsWith('-')) edit.removed++;
    else if (!(edit && edit.kind === 'Update File' && /^(?: |@@|\*\*\* End of File)/.test(row))) throw new Error('无法解析 patch 改动行数');
  }
  if (!edits.length) throw new Error('patch 没有目标文件');
  return edits;
}
function isEdit(client, name) {
  return client === 'claude' ? ['Edit','Write','MultiEdit','NotebookEdit'].includes(name) : name === 'apply_patch';
}
function plan(client, payload, root, resolvePath, repo) {
  const input = payload.tool_input || {}, cwd = payload.cwd || process.cwd();
  const edits = client === 'codex' ? patchEdits(input) : [{file:input.file_path || input.notebook_path,kind:payload.tool_name}];
  const result = {lines:0,files:[],risk:[],newCode:[]};
  for (const edit of edits) {
    if (typeof edit.file !== 'string' || !edit.file) throw new Error('缺少编辑目标路径');
    const target = resolvePath(path.resolve(cwd,edit.file));
    const relative = path.relative(root,target).split(path.sep).join('/');
    const lexicalTarget = path.resolve(cwd,edit.file);
    // Resolve the cwd alias, retaining lexical target segments inside it so
    // an auth symlink cannot hide its policy name. Checkout alias ancestors
    // are not repository paths either (H1DE-01/07).
    const lexicalRoot = path.resolve(cwd,path.relative(resolvePath(cwd),root));
    const lexical = path.relative(lexicalRoot,lexicalTarget).split(path.sep).join('/');
    // H1DE-01: git policy is repository-relative; checkout ancestors must not
    // exempt code or turn ordinary files into risk paths. Only non-git roots
    // retain full ancestry for scratch exemptions and risk matching.
    // Keep the existing non-git .context scratch ancestry exemption; risks
    // inside the scratch target still take precedence via relative/lexical.
    const scratch = file => file.includes('/.context/');
    const ancestry = repo === null ? [target,lexicalTarget].filter(file => !scratch(file)) : [];
    const risky = [relative,lexical,...ancestry].some(riskPath);
    // Exempt only the resolved target: a .md/.context symlink must not exempt
    // a guarded code file. Lexical names remain additional risk evidence.
    const candidates = repo === null ? [relative,target] : [relative];
    if (risky) result.risk.push(relative);
    if (candidates.some(file => matches(file,exemptions)) && !risky) continue;
    result.files.push(relative);
    if (!fs.existsSync(target) && policy.code_extensions.includes(path.extname(target).toLowerCase())) result.newCode.push(relative);
    if (client === 'codex') {
      result.lines += edit.kind === 'Delete File' ? lines(fs.readFileSync(target,'utf8')).length : Math.max(edit.added,edit.removed);
    } else if (edit.kind === 'Write') {
      if (typeof input.content !== 'string') throw new Error('Write 缺少 content');
      result.lines += lines(input.content).length;
    } else if (['Edit','MultiEdit'].includes(edit.kind)) {
      let content = fs.existsSync(target) ? fs.readFileSync(target,'utf8') : '';
      for (const change of edit.kind === 'Edit' ? [input] : input.edits || []) {
        if (typeof change.old_string !== 'string' || typeof change.new_string !== 'string') throw new Error('Edit 缺少 old/new 文本');
        const occurrences = change.old_string ? content.split(change.old_string).length - 1 : 1;
        result.lines += changedLines(change.old_string,change.new_string) * (change.replace_all ? Math.max(1,occurrences) : 1);
        content = change.replace_all ? content.split(change.old_string).join(change.new_string) : content.replace(change.old_string,change.new_string);
      }
    } else throw new Error('该工具无法可靠计量微改');
  }
  result.files = [...new Set(result.files)];
  return result;
}
function violations(micro) {
  const reasons = [];
  if (micro.lines > limit.max_lines) reasons.push(`累计 ${micro.lines} 行 > ${limit.max_lines} 行`);
  if (micro.files.length > limit.max_files) reasons.push(`累计 ${micro.files.length} 文件 > ${limit.max_files} 文件`);
  if (!limit.allow_new_code_files && micro.newCode.length) reasons.push(`禁止新建代码文件：${micro.newCode.join(', ')}`);
  if (micro.risk.length) reasons.push(`命中 risk_paths：${micro.risk.join(', ')}`);
  return reasons;
}
function accumulate(micro, edit) {
  return {...micro,lines:micro.lines+edit.lines,...Object.fromEntries(['files','risk','newCode'].map(key => [key,[...new Set([...micro[key],...edit[key]])]]))};
}
// F1: reuse patch target parsing when discovering repositories before writing.
module.exports = {guardedPath,plan,isEdit,violations,accumulate,patchEdits};

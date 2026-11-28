import { assert, mountWorker, test } from 'orca/testing';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('启动与点击合并，显示三家结构化用量，失败后恢复', async t => {
  const home = await mkdtemp(join(tmpdir(), 'toagent-quota-'));
  const reply = join(home, 'reply.json');
  const originalEnv = process.env;
  t.after(() => { process.env = originalEnv; });
  t.after(() => rm(home, { recursive: true, force: true }));
  process.env = { HOME: home, SUPERAGENT_HOME: home, PATH: '/usr/bin:/bin' };
  await mkdir(join(home, '.local/bin'), { recursive: true });
  await writeFile(join(home, '.local/bin/superagent'), `#!${process.execPath}
const fs = require('node:fs'), root = process.env.SUPERAGENT_HOME;
if (process.argv.slice(2).join() !== 'quota' || process.env.SUPERAGENT_RELAY_QUOTA_URL !== 'https://api.toagent.io' ||
    !process.env.PATH.split(':').includes(process.env.HOME + '/.bun/bin')) process.exit(2);
fs.appendFileSync(root + '/calls', 'x');
const data = JSON.parse(fs.readFileSync(root + '/reply.json'));
if (data) fs.writeFileSync(root + '/relay-quota.json', JSON.stringify({ ...data, at: Date.now() }));
`, { mode: 0o700 });
  await writeFile(reply, JSON.stringify({
    claude: { today: { cost: 0 }, five_hour: { remaining_pct: 15 }, accounts_available: 1, accounts_total: 3, level: 'low' },
    codex: { seven_day: { remaining_pct: 0 }, accounts_available: 0, accounts_total: 2 },
  }));
  const worker = await mountWorker(await import('./worker.mjs'));
  t.after(() => worker.deactivate());
  const items = () => worker.host.callsOf('statusBar.update').slice(-3);
  await Promise.all([worker.command('refresh'), worker.command('refresh')]);
  assert.equal(await readFile(join(home, 'calls'), 'utf8'), 'x');
  assert.deepEqual(items().map(p => [p.text, p.tone]), [
    ['Claude $0.00 5h 15% 1/3', 'warning'], ['Codex 7d 0% 0/2', 'danger'], ['Gemini —', 'neutral']]);
  assert.match(items()[0].tooltip, /更新于/);
  await writeFile(reply, 'null');
  await worker.command('refresh');
  assert.deepEqual(items().map(p => p.text), ['Claude —', 'Codex —', 'Gemini —']);
  await writeFile(reply, JSON.stringify({ gemini: { today: { cost: 2 }, level: 'exhausted' } }));
  await worker.command('refresh');
  assert.deepEqual([items()[2].text, items()[2].tone], ['Gemini $2.00', 'danger']);
  assert.deepEqual([worker.refusals, worker.logs], [[], []]);
});

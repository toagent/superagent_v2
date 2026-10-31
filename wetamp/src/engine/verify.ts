import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { caller, coord, repoScope } from '../coord';
import { WETAMP, home, writeAtomic } from '../config';
import { inspectProcess } from '../launcher';
import { queueNtfyAlert } from '../ntfy';

export interface EngineVerifyRecord {
  sha: string;
  base: string;
  status: 'running' | 'passed' | 'failed';
  files: string[];
  failed_files: string[];
  log: string;
  at: string;
  pid?: number;
  pid_start?: string;
  host?: string;
  token?: string;
  error?: string;
  reported?: boolean;
}

const engineRoot = (): string => join(home().sa, 'engine');
const promotionDir = (): string => join(engineRoot(), 'promotions');
const verifyRoot = (): string => join(engineRoot(), 'verify');
const sourceRoot = (): string =>
  resolve(
    process.env.SA_ENGINE_SOURCE !== undefined && process.env.SA_ENGINE_SOURCE !== ''
      ? process.env.SA_ENGINE_SOURCE
      : join(WETAMP, '..')
  );
const recordPath = (sha: string): string => join(promotionDir(), `${sha}.verify.json`);
const writeRecord = (record: EngineVerifyRecord): void => {
  mkdirSync(promotionDir(), { recursive: true });
  writeAtomic(recordPath(record.sha), JSON.stringify(record, null, 2) + '\n');
};

export function verifyRecord(sha: string): EngineVerifyRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(sha), 'utf8')) as EngineVerifyRecord;
  } catch {
    return undefined;
  }
}

const verifyRecords = (): EngineVerifyRecord[] =>
  (existsSync(promotionDir())
    ? readdirSync(promotionDir()).filter(file => file.endsWith('.verify.json'))
    : []
  ).flatMap(file => {
    try {
      return [JSON.parse(readFileSync(join(promotionDir(), file), 'utf8')) as EngineVerifyRecord];
    } catch {
      return [];
    }
  });

const git = (args: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', sourceRoot(), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
};
const canonicalSha = (value: string): string => git(['rev-parse', '--verify', `${value}^{commit}`]);
const isAncestor = (older: string, newer: string): boolean =>
  Bun.spawnSync(['git', '-C', sourceRoot(), 'merge-base', '--is-ancestor', older, newer])
    .exitCode === 0;

interface TestReport {
  files: string[];
  failed: string[];
}

const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap(objects)
    : value && typeof value === 'object'
      ? [value as Record<string, unknown>]
      : [];

function parseJUnit(path: string): TestReport {
  const xml = (Bun as unknown as { XML: { parse(value: string): unknown } }).XML;
  const parsed = xml.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const root = parsed.testsuites as Record<string, unknown> | undefined;
  if (!root) throw new Error('verify junit: missing testsuites');
  const suites = objects(root.testsuite);
  const files = suites.flatMap(suite =>
    typeof suite['@file'] === 'string' ? [suite['@file']] : []
  );
  const failed = suites.flatMap(suite => {
    const file = typeof suite['@file'] === 'string' ? suite['@file'] : undefined;
    if (!file) return [];
    const cases = objects(suite.testcase);
    const caseFailed = cases.some(test => test.failure !== undefined || test.error !== undefined);
    const suiteFailed = Number(suite['@failures'] ?? 0) > 0 || Number(suite['@errors'] ?? 0) > 0;
    return caseFailed || suiteFailed ? [file] : [];
  });
  return { files: [...new Set(files)], failed: [...new Set(failed)] };
}

const timedRunner = `
  const timeout = Number(process.argv[1]);
  const child = Bun.spawn(process.argv.slice(2), {
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', detached: true,
  });
  const result = await Promise.race([child.exited, Bun.sleep(timeout).then(() => null)]);
  if (result !== null) process.exit(result);
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Bun.sleep(2000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await child.exited;
  process.exit(124);
`;

function executeTests(
  worktree: string,
  args: string[],
  report: string,
  log: string,
  timeoutMs: number
): number {
  const output = openSync(log, 'a');
  try {
    const heavy = join(worktree, 'wetamp', 'scripts', 'heavy-slot.sh');
    return Bun.spawnSync(
      [
        process.execPath,
        '-e',
        timedRunner,
        String(timeoutMs),
        'bash',
        '-c',
        '. "$1"; shift; heavy_exec "$@"',
        'verify',
        heavy,
        process.execPath,
        'test',
        ...args,
        '--timeout',
        '120000',
        '--reporter=junit',
        `--reporter-outfile=${report}`,
      ],
      { cwd: join(worktree, 'wetamp'), stdout: output, stderr: output }
    ).exitCode;
  } finally {
    closeSync(output);
  }
}

export interface VerifyDependencies {
  prepare?: (worktree: string, sha: string, log: string, timeoutMs: number) => void;
  execute?: typeof executeTests;
  cleanup?: (worktree: string) => void;
  now?: () => number;
}

function beginVerify(sha: string, base: string, log: string): EngineVerifyRecord {
  const expected = process.env.SA_ENGINE_VERIFY_TOKEN;
  if (expected) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const record = verifyRecord(sha),
        identity = inspectProcess(process.pid);
      if (
        record?.status === 'running' &&
        record.base === base &&
        record.token === expected &&
        record.pid === process.pid &&
        identity.state === 'online' &&
        identity.start === record.pid_start
      )
        return record;
      Bun.sleepSync(10);
    }
    throw new Error('engine verify: process identity mismatch');
  }
  const identity = inspectProcess(process.pid);
  if (identity.state !== 'online') throw new Error('engine verify: process identity unavailable');
  const record: EngineVerifyRecord = {
    sha,
    base,
    status: 'running',
    files: [],
    failed_files: [],
    log,
    at: new Date().toISOString(),
    pid: process.pid,
    pid_start: identity.start,
    host: hostname(),
  };
  writeRecord(record);
  return record;
}

export function runVerify(
  inputSha: string,
  inputBase: string,
  dependencies: VerifyDependencies = {}
): EngineVerifyRecord {
  if (!/^[0-9a-f]{7,40}$/i.test(inputSha) || !/^[0-9a-f]{7,40}$/i.test(inputBase))
    throw new Error('usage: superagent engine verify <sha> --base <base-sha>');
  const sha = canonicalSha(inputSha),
    base = canonicalSha(inputBase);
  if (!isAncestor(base, sha)) throw new Error('engine verify: base is not an ancestor');
  const worktree = join(verifyRoot(), sha),
    log = join(promotionDir(), `${sha}.verify.log`),
    started = (dependencies.now ?? Date.now)(),
    deadline = started + 60 * 60_000,
    initialReport = join(promotionDir(), `${sha}.verify.junit.xml`),
    running = beginVerify(sha, base, log);
  const remaining = (): number => Math.max(1, deadline - (dependencies.now ?? Date.now)());
  const execute = dependencies.execute ?? executeTests;
  let result = running;
  let prepared = false;
  try {
    mkdirSync(verifyRoot(), { recursive: true });
    if (dependencies.prepare) {
      dependencies.prepare(worktree, sha, log, remaining());
      prepared = true;
    } else {
      git(['worktree', 'add', '--detach', worktree, sha]);
      prepared = true;
      const output = openSync(log, 'a');
      try {
        const install = Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], {
          cwd: worktree,
          stdout: output,
          stderr: output,
          timeout: remaining(),
        });
        if (install.exitCode !== 0)
          throw new Error(`bun install failed (${String(install.exitCode)})`);
      } finally {
        closeSync(output);
      }
    }
    const initialExit = execute(worktree, [`--changed=${base}`], initialReport, log, remaining()),
      initial = parseJUnit(initialReport);
    const failed: string[] = [];
    if (initialExit !== 0) {
      if (!initial.failed.length) failed.push(...initial.files);
      for (const [index, file] of initial.failed.entries()) {
        const report = join(promotionDir(), `${sha}.verify.rerun-${String(index)}.xml`),
          exit = execute(worktree, [file], report, log, remaining());
        try {
          if (exit !== 0 || parseJUnit(report).failed.length) failed.push(file);
        } catch {
          failed.push(file);
        }
      }
    }
    result = {
      ...running,
      status:
        initialExit === 0 || (initial.failed.length > 0 && failed.length === 0)
          ? 'passed'
          : 'failed',
      files: initial.files,
      failed_files: [...new Set(failed)],
      at: new Date().toISOString(),
    };
  } catch (error) {
    result = {
      ...running,
      status: 'failed',
      files: [],
      failed_files: [],
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
  } finally {
    try {
      if (prepared && dependencies.cleanup) dependencies.cleanup(worktree);
      else if (prepared || existsSync(worktree)) {
        git(['worktree', 'remove', '--force', worktree]);
        if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
      }
    } catch (error) {
      result.status = 'failed';
      result.error = `cleanup: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  writeRecord(result);
  return result;
}

interface Receipt {
  sha: string;
  at: string;
}

const receipts = (): Receipt[] =>
  (existsSync(join(engineRoot(), 'receipts'))
    ? readdirSync(join(engineRoot(), 'receipts')).filter(file => file.endsWith('.json'))
    : []
  )
    .flatMap(file => {
      try {
        return [JSON.parse(readFileSync(join(engineRoot(), 'receipts', file), 'utf8')) as Receipt];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at));

export interface AutoVerifyDependencies {
  spawn?: (
    command: string[],
    env: Record<string, string | undefined>
  ) => { pid: number; unref(): void };
  inspect?: typeof inspectProcess;
  handoff?: (record: EngineVerifyRecord) => void;
  alert?: (record: EngineVerifyRecord) => void;
}

function reportFailure(record: EngineVerifyRecord, dependencies: AutoVerifyDependencies): void {
  (
    dependencies.alert ??
    (item => {
      queueNtfyAlert(
        `engine-verify-${item.sha}`,
        `base: ${item.base}\nfailed_files: ${item.failed_files.join(', ') || 'unknown'}\nlog: ${item.log}`,
        {},
        `post-promotion regression: ${item.sha}`
      );
    })
  )(record);
  (
    dependencies.handoff ??
    (item => {
      coord().handoff(
        repoScope(WETAMP),
        caller(true),
        {
          kind: 'bug',
          title: `post-promotion regression: ${item.sha}`,
          body: `base: ${item.base}\nfailed_files: ${item.failed_files.join(', ') || 'unknown'}\nlog: ${item.log}`,
          evidence: [item.log],
          severity: 'normal',
        },
        0,
        false
      );
    })
  )(record);
  writeRecord({ ...record, reported: true });
}

export function autoVerify(
  currentSnapshot: string | undefined,
  dependencies: AutoVerifyDependencies = {}
): { sha: string; base?: string; started: boolean; error?: string } | undefined {
  if (!currentSnapshot) return undefined;
  const inspect = dependencies.inspect ?? inspectProcess;
  try {
    let records = verifyRecords();
    for (const record of records.filter(item => item.status === 'failed' && !item.reported))
      reportFailure(record, dependencies);
    records = verifyRecords();
    const running = records.filter(record => record.status === 'running');
    for (const record of running) {
      if (!record.pid || !record.pid_start || !record.host)
        return { sha: record.sha, started: false };
      if (record.host !== hostname()) return { sha: record.sha, started: false };
      const identity = inspect(record.pid);
      if (identity.state === 'unknown') return { sha: record.sha, started: false };
      if (identity.state === 'online' && identity.start === record.pid_start)
        return { sha: record.sha, started: false };
      writeRecord({
        ...record,
        status: 'failed',
        error: 'verify_process_lost',
        at: new Date().toISOString(),
      });
    }
    const sha = basename(currentSnapshot);
    if (verifyRecord(sha)) return { sha, started: false };
    const passed = records
        .filter(record => record.status === 'passed' && isAncestor(record.sha, sha))
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1),
      base =
        passed?.sha ??
        receipts()
          .filter(item => item.sha !== sha && isAncestor(item.sha, sha))
          .at(-1)?.sha;
    if (!base) return { sha, started: false };
    const token = crypto.randomUUID(),
      command = [
        process.execPath,
        join(currentSnapshot, 'wetamp', 'src', 'cli.ts'),
        'engine',
        'verify',
        sha,
        '--base',
        base,
      ],
      spawned = dependencies.spawn
        ? dependencies.spawn(command, { ...process.env, SA_ENGINE_VERIFY_TOKEN: token })
        : Bun.spawn(command, {
            cwd: currentSnapshot,
            env: { ...process.env, SA_ENGINE_VERIFY_TOKEN: token },
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
            detached: true,
          }),
      identity = inspect(spawned.pid);
    if (identity.state !== 'online')
      throw new Error('engine auto-verify: process identity unavailable');
    writeRecord({
      sha,
      base,
      status: 'running',
      files: [],
      failed_files: [],
      log: join(promotionDir(), `${sha}.verify.log`),
      at: new Date().toISOString(),
      pid: spawned.pid,
      pid_start: identity.start,
      host: hostname(),
      token,
    });
    spawned.unref();
    return { sha, base, started: true };
  } catch (error) {
    return {
      sha: basename(currentSnapshot),
      started: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

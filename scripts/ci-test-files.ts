// The local full-suite test step. A timer inside Bun cannot interrupt a synchronous test loop,
// so each file runs in a child with a wall-clock bound enforced by this parent. The existing
// split units keep their TEAM_EXIT_PART selector, as they do in the shard runner.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { units } from './ci-shard-tests.ts';

const ROOT = resolve(import.meta.dir, '..');
export const TEST_FILE_TIMEOUT_MS = 5 * 60_000;

export function runTestFiles(testUnits: readonly string[], options: {
  root?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
  log?: (line: string) => void;
} = {}): number {
  const timeoutMs = options.timeoutMs ?? TEST_FILE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('the test-file timeout must be a positive integer in milliseconds');
  }
  const log = options.log ?? console.error;
  let status = 0;
  for (const unit of testUnits) {
    const [file, part] = unit.split('#') as [string, string | undefined];
    const env = { ...(options.env ?? process.env) };
    delete env.TEAM_EXIT_PART;
    if (part !== undefined) env.TEAM_EXIT_PART = part;
    log(`Test file: ${unit}`);
    const ran = spawnSync(process.execPath, ['test', resolve(options.root ?? ROOT, file)], {
      cwd: options.root ?? ROOT,
      env,
      stdio: options.stdio ?? 'inherit',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      log(`Test file timed out after ${timeoutMs} ms: ${unit}`);
      status = 1;
    } else if (ran.error !== undefined || ran.status !== 0) {
      log(`Test file failed: ${unit} (${ran.error?.message ?? ran.signal ?? ran.status})`);
      status = 1;
    }
  }
  return status;
}

if (import.meta.main) {
  const tracked = spawnSync('git', ['ls-files', '-z', '--', '*.test.ts', '*.spec.ts'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (tracked.error !== undefined || tracked.status !== 0) {
    console.error('ci tests: the tracked test-file list could not be read');
    process.exit(1);
  }
  const timeout = process.env.TEAM_TEST_FILE_TIMEOUT_MS;
  try {
    process.exit(runTestFiles(units(tracked.stdout.split('\0').filter(Boolean)), {
      timeoutMs: timeout === undefined ? TEST_FILE_TIMEOUT_MS : Number(timeout),
    }));
  } catch (error) {
    console.error(`ci tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

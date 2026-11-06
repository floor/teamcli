// Runs one withLock acquisition against a fixture and prints how it ended and how long it took.
// The scene in withlock-deadline.test.ts spawns this, so a lock that spins past its deadline is
// killed by the parent's watchdog and reported as the hang it is, rather than hanging the suite.
import { withLock } from '../src/state.ts';

const [dir, waitMs] = process.argv.slice(2);
if (dir === undefined || waitMs === undefined) {
  throw new Error('usage: withlock-deadline-run.ts <lock_dir> <wait_ms>');
}

const started = Date.now();
try {
  withLock(dir, () => 'ran', { waitMs: Number(waitMs) });
  console.log(`ran ${String(Date.now() - started)}`);
} catch (error) {
  console.log(`${(error as Error).name} ${String(Date.now() - started)} ${(error as Error).message}`);
  process.exitCode = 1;
}

// Holds the event-store lock for a fixed span, for the scene in bus-log.test.ts that proves the
// standalone prune pass takes the same lock as appendEvent. It writes its ready file from inside
// the lock, then waits without spinning.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../src/state.ts';

const [storeDir, readyPath, holdMs] = process.argv.slice(2);
if (storeDir === undefined || readyPath === undefined || holdMs === undefined) {
  throw new Error('usage: bus-log-hold-lock-run.ts <store_dir> <ready_path> <hold_ms>');
}

withLock(join(storeDir, 'locks', 'events'), () => {
  writeFileSync(readyPath, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
});

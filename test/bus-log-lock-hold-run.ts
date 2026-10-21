// Holds <store>/locks/events so the append busy path can be observed from another process.
// Usage: bun test/bus-log-lock-hold-run.ts <storeDir> <holdMs>
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from '../src/state.ts';

const [storeDir = '', holdMsRaw = '6500'] = process.argv.slice(2);
withLock(join(storeDir, 'locks', 'events'), () => {
  writeSync(1, 'held\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMsRaw));
});

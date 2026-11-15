// Holds an exclusive flock on one file until its input closes: a start that has taken the
// daemon lock and not yet written its pid, or any holder whose file names a pid that is gone.
// Prints `held` once it holds the lock.
import { openSync, constants } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';

const [path] = process.argv.slice(2) as [string];
const lib = dlopen(process.platform === 'linux' ? 'libc.so.6' : 'libSystem.B.dylib', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
if (lib.symbols.flock(fd, 2 | 4) !== 0) {
  process.stdout.write('busy\n');
  process.exit(1);
}
process.stdout.write('held\n');
process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once('end', () => resolve()));
process.exit(0);

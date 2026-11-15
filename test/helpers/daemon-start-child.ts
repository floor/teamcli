// One machine daemon start in its own process, for the single-instance tests. Arguments: the
// home, then a barrier file every child waits for so the starts race. It prints one JSON line
// with its outcome; a start that serves keeps serving until it is killed or its input closes.
import { existsSync } from 'node:fs';
import { startMachineDaemon } from '../../src/daemon/host.ts';

const [home, barrier] = process.argv.slice(2) as [string, string];
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
const started = await startMachineDaemon({ home, roots: [], startedBy: 'manual', version: 'test' });
process.stdout.write(`${JSON.stringify({ kind: started.kind, pid: process.pid })}\n`);
if (started.kind === 'serving') {
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('end', () => resolve()));
  await started.daemon.close();
}
process.exit(0);

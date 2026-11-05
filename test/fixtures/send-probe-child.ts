// A send-socket health probe in its own process for `daemon-loop-send-probe.test.ts`. It
// announces readiness by creating the given file, then probes the send endpoint at the product's
// own budget (the 2,000 ms the machine daemon gives `probeDaemonSocket`, src/daemon/host.ts:455)
// until the stop file appears or the window ends. The parent sends one real request over the same
// socket and holds its own event loop to account, so a probe that goes unanswered here names a
// loop the parent can attribute. One JSON line per probe, prefixed `PROBE `, each carrying the
// send's epoch so the two processes' clocks line up. Never collected by the runner: its name
// matches no test pattern.
import { existsSync, writeFileSync } from 'node:fs';
import { probeDaemonSocket } from '../../src/send/daemon.ts';

const socketPath = process.argv[2];
const readyPath = process.argv[3];
const budgetMs = Number(process.argv[4] ?? '2000');
const stopPath = process.argv[5];
if (socketPath === undefined || readyPath === undefined || stopPath === undefined) {
  throw new Error('the socket path, ready path and stop path are required');
}
writeFileSync(readyPath, '');

const started = performance.now();
let seq = 0;
while (!existsSync(stopPath)) {
  const at = Math.round(performance.now() - started);
  const sent = performance.now();
  const epoch = Math.round(performance.timeOrigin + sent);
  const answered = await probeDaemonSocket(socketPath, budgetMs);
  const ms = Math.round(performance.now() - sent);
  console.log(`PROBE ${JSON.stringify({ at, epoch, kind: answered ? 'answered' : 'unanswered', ms })}`);
  seq += 1;
  await new Promise((tick) => setTimeout(tick, 100));
}
console.log(`PROBE ${JSON.stringify({ done: seq })}`);

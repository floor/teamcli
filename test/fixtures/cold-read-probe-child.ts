// A health probe client in its own process for the cold-start scene in
// `bus-cold-read-slice.test.ts`. It announces readiness by creating the given file, then probes
// the machine socket at the product's own budget (the 500 ms default in `health.ts`) until the
// window ends or the parent creates the stop file. Before the socket is bound a dial fails at
// once, which is "not serving yet"; a dial that connects and then waits the whole budget means
// the socket was serving but no answer came within it, which the scene attributes to the
// daemon's own loop intervals before judging it. Each line also carries the send's epoch, so
// both processes' clocks line up. One JSON line per probe, prefixed `PROBE `; the process exits
// when the window ends. Never collected by the runner: its name matches no test pattern.
import { existsSync, writeFileSync } from 'node:fs';
import { probeDaemonHealth } from '../../src/daemon/health.ts';

const socketPath = process.argv[2];
const readyPath = process.argv[3];
const durationMs = Number(process.argv[4] ?? '3500');
const stopPath = process.argv[5];
if (socketPath === undefined || readyPath === undefined) {
  throw new Error('the socket path and the ready path are required');
}
writeFileSync(readyPath, '');

const started = performance.now();
let seq = 0;
while (performance.now() - started < durationMs) {
  if (stopPath !== undefined && existsSync(stopPath)) break;
  const at = Math.round(performance.now() - started);
  const sent = performance.now();
  const epoch = Math.round(performance.timeOrigin + sent);
  const answer = await probeDaemonHealth(socketPath, { timeoutMs: 500, id: `cold-probe-${String(seq)}` });
  seq += 1;
  const ms = Math.round(performance.now() - sent);
  const reason = answer.kind === 'unanswered' ? answer.reason : answer.kind === 'refused' ? answer.error.code : null;
  console.log(`PROBE ${JSON.stringify({ at, epoch, kind: answer.kind, reason, ms })}`);
  await new Promise((tick) => setTimeout(tick, 100));
}
console.log(`PROBE ${JSON.stringify({ done: seq })}`);

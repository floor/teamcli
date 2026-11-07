// The wake child's program entry. The daemon's per-root send server starts it as a second
// process with a one-use token's nonce; it reads the token, runs the one wake it carries, writes
// its outcome, and leaves.
//
// This file exists so a child loads the typed walk and nothing else. It imports the wake
// server, the token reader, the live-seat guards and the one module that types
// (`src/send/typed-wake.ts`); the child binds no pane writer of its own.
import { livePaneProcesses, liveSeatAgents } from '../seat-live.ts';
import { deliverTypedWake, herdrTypedWakeHost } from '../../send/typed-wake.ts';
import { serveWakeChild } from './child.ts';
import { readWakeInherit } from './token.ts';

const home = process.env.HOME ?? '';
const at = process.argv.indexOf('--inherited');
const nonce = at === -1 ? '' : process.argv[at + 1] ?? '';
const read = home === ''
  ? { kind: 'refused' as const, why: 'the wake child was started without a home' }
  : readWakeInherit(home, nonce);

if (read.kind === 'refused') {
  process.stderr.write(`team daemon: ${read.why}\n`);
  // exit: team.wake-entry-refused
  process.exitCode = 2;
} else {
  // The child leaves when the walk ends: its outcome is written, and only the walk's own bound
  // or the daemon's kill budget can keep it here longer.
  await serveWakeChild(read.request, {
    agents: liveSeatAgents,
    processes: livePaneProcesses,
    walk: deliverTypedWake,
    wakeHost: herdrTypedWakeHost,
    now: () => new Date(),
  });
}

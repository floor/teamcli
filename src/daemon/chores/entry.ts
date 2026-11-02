// The chores child's program entry. The machine daemon starts it as a second process with a
// one-use token's nonce; it reads the token, serves the configuration until its host ends its
// input, and leaves.
//
// This file exists so a child loads the chores and nothing else. The same work is reachable
// through the hidden `team daemon chores` verb, but that path loads the whole command table and
// every adapter with it; a child costs a process, and its heap should carry only its own work.
// It imports the child loop and the token reader, and no other module.
import { serveChoresChild } from './child.ts';
import { readChoresInherit } from './token.ts';

const home = process.env.HOME ?? '';
const at = process.argv.indexOf('--inherited');
const nonce = at === -1 ? '' : process.argv[at + 1] ?? '';
const read = home === ''
  ? { kind: 'refused' as const, why: 'the chores child was started without a home' }
  : readChoresInherit(home, nonce);

if (read.kind === 'refused') {
  process.stderr.write(`team daemon: ${read.why}\n`);
  // exit: team.chores-entry-refused
  process.exitCode = 2;
} else {
  // The child leaves with 0 when its host ends its input; serveChoresChild has cleared its
  // timers and closed the input by then, so the process ends on its own. A terminate signal is
  // the supervisor's own stop: the same path ends each hosted watch at its seam and releases
  // the authority it holds before the process leaves.
  await serveChoresChild({ config: read.config, stdin: process.stdin, stdout: process.stdout, signals: true });
}

// Registering a seat's team inbox with its CLI, at launch.
//
// A route that lives on the launch line needs no file: the profile names the values, and
// the launch carries them. The client is told this install's own runner — the executable
// and its entry script — so the inbox server starts whether or not `team` is on the PATH.
// The seat is the only binding the launch states; the session is the team file's in the
// seat's folder, read the way the server itself reads it, so the drop folder the server
// serves is the sender's.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The arguments the inbox server is started with, after the entry script. */
export function inboxServeArgs(seat: string, session: string): string[] {
  return ['mcp', 'serve', '--seat', seat, '--session', session];
}

/** This install's runner: the executable and the entry script it runs. Resolved from this
 *  module, so a checkout runs its `cli.ts` and an installed build its `cli.js`. */
export function selfRunner(): { command: string; entry: string } {
  const here = fileURLToPath(import.meta.url);
  return { command: process.execPath, entry: join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js') };
}

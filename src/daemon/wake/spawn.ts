// Starting one wake child.
//
// A wake is a second process running the entry beside this module, so the walk's synchronous
// terminal-host reads and its seconds-long poll hold that process alone: the daemon's socket,
// its heartbeat and every other route never wait on a screen. The child proves it was started
// from here with a one-use token under the machine folder (./token.ts); a command line without
// one is refused before any pane is read.
//
// The daemon does not wait for the walk: this spawner returns as soon as the process exists, and
// the child writes its own outcome (history, trace, log). The child's streams are ignored, so
// nothing it prints can hold the daemon's loop, and the handle is unref'd so the daemon is never
// kept alive by a wake it handed off. The kill budget is this spawner's own, sized above the
// walk's verify bound rather than the chores beat clock: a healthy wake is legitimately silent
// for seconds.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discardWakeInherit, writeWakeInherit, type WakeChildRequest } from './token.ts';

/** How long one wake may run before it is ended. Above the walk's own 10 s verify bound: a child
 *  still walking at this point is not going to deliver, and its reservation stays as it was. */
export const WAKE_KILL_MS = 15_000;

/** How long a terminated child gets before it is forced. */
const KILL_GRACE_MS = 2_000;

export type SpawnWakeInput = {
  request: WakeChildRequest;
  /** The program entry the child runs. The default is the child entry beside this module; a test
   *  names a fixture entry so a scene drives the spawn itself. */
  entry?: string;
  /** The whole-walk bound. Past it the child is ended and its reservation is left as it was, so
   *  the message keeps its one wake. */
  killMs?: number;
};

/** The child's program entry: the `entry.ts` (source) or `entry.js` (installed build) beside this
 *  module. It loads the wake server and the token reader only. */
export function wakeEntryOf(here: string = fileURLToPath(import.meta.url)): string | null {
  const name = here.endsWith('.ts') ? 'entry.ts' : 'entry.js';
  const candidate = join(dirname(here), name);
  return existsSync(candidate) ? candidate : null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts one wake from a freshly written token and returns its pid. Throws when the token cannot
 * be written or the process cannot be started; the caller (`src/daemon/host.ts`) answers the
 * handoff with its refusal, and the daemon's typed branch releases the reservation.
 */
export function spawnWakeChild(input: SpawnWakeInput): number | null {
  const entry = input.entry ?? wakeEntryOf();
  if (entry === null) throw new Error('the program entry for a wake child was not found');

  let nonce: string;
  try {
    nonce = writeWakeInherit(input.request);
  } catch (error) {
    throw new Error(`the wake token could not be written: ${reasonOf(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry, '--inherited', nonce], {
      cwd: input.request.root,
      stdio: 'ignore',
      env: { ...process.env, HOME: input.request.home },
    });
  } catch (error) {
    discardWakeInherit(input.request.home, nonce);
    throw new Error(`the wake child could not be started: ${reasonOf(error)}`);
  }

  // A child that never produced a process leaves without `exit`; `error` is its whole story.
  child.on('error', () => {
    discardWakeInherit(input.request.home, nonce);
  });
  const budget = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    const forced = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    forced.unref();
  }, input.killMs ?? WAKE_KILL_MS);
  budget.unref();
  child.on('exit', () => clearTimeout(budget));
  // The daemon hands the walk off and keeps its loop: the child is its own process, and the
  // daemon must never be held open by one.
  child.unref();
  return child.pid ?? null;
}

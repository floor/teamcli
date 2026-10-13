import type { PaneProcesses } from '../herdr.ts';

// The process identity `team` records for a seat it launched: the pane's own shell process and
// the pids of the foreground processes that are not the shell — the CLI, and any helper herdr
// lists beside it. Read from `herdr pane process-info` after the idle prompt appears. Pids only:
// a command line, an argument or an environment can hold secrets, and none is ever stored,
// logged or printed.
//
// One recorded shell pid tells the two failures apart: a pane whose shell is still the recorded
// one but whose CLI is gone was restarted in place; a pane whose shell is another process was
// restored by something that started both again. Several CLI pids cover a CLI that shows a
// helper process beside it: the seat is the seat while any one of them is still in front.
export type LaunchedIdentity = { shell: number; cli: number[] };

// What the recorded identity says of the pane today.
// - `same`: the pane's shell is the recorded one and a recorded CLI pid is in front.
// - `gone`: the pane's own shell is in front and no CLI is: the seat is not running.
// - `replaced`: a process is in front that the record does not name: not the one team launched.
// - `unknown`: herdr can't tell — no record, no reading, no foreground process. Treated exactly
//   as a seat without a record (today's behaviour): a relaunch would record nothing either, so
//   there is no repair to make.
export type SeatProcessVerdict = 'same' | 'gone' | 'replaced' | 'unknown';

/** The pane's own shell is in front and no CLI is. Knowable without a recorded identity: the
 *  same reading `gone` uses once an identity exists. An empty foreground, or no reading, is
 *  not a shell — herdr could not say. */
export function paneHoldsShell(pane: PaneProcesses | null | undefined): boolean {
  if (!pane || pane.foreground.length === 0) return false;
  return pane.foreground.includes(pane.shell);
}

export function seatProcessVerdict(recorded: LaunchedIdentity | undefined, pane: PaneProcesses | null | undefined): SeatProcessVerdict {
  if (!recorded || !pane || pane.foreground.length === 0) return 'unknown';
  if (recorded.shell === pane.shell && recorded.cli.some((pid) => pane.foreground.includes(pid))) return 'same';
  // No CLI in front: the pane is back at its own shell. This is the bare-shell restore whether
  // or not the shell pid is still the recorded one.
  if (paneHoldsShell(pane)) return 'gone';
  return 'replaced';
}

/** The identity to record from a pane reading, or null when herdr can't give one: no shell pid,
 *  or no foreground process beside it. A seat with no record keeps today's behaviour. */
export function launchedIdentity(pane: PaneProcesses | null | undefined): LaunchedIdentity | null {
  if (!pane) return null;
  const cli = pane.foreground.filter((pid) => pid !== pane.shell);
  if (cli.length === 0) return null;
  return { shell: pane.shell, cli };
}

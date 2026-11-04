// The stall proof for one seat. All four have to hold for the whole wait: the reconciled
// state is working, the plain screen is unchanged, no tool is in use, and the screen is not
// a dialog. A colour-only repaint is the same plain text. A live child under the pane fails
// the proof whatever the screen says.

import { stripSgr } from '../ansi.ts';

/** How long the plain screen and the presence clock have to stay still. The owner's number,
 *  and it supersedes the 20 minutes in the never-stall table. */
export const WATCHDOG_AFTER_MS = 15 * 60 * 1000;

/** One automatic restart in a window. Zero is the tighter setting: the step tells the lead
 *  and starts nothing. */
export const WATCHDOG_AUTO_RESTART = 1;

/** The three classes the lead hears about at once. Every other classified dialog is also
 *  not a restart; the attention check already raises those. */
export const DIALOG_LEAD = ['permission', 'trust', 'login'] as const;

export const DIALOG_HOLD = [
  'question',
  'exit question',
  'plan approval',
  'confirmation',
  'vendor notice',
  'rate limit',
  'guard',
] as const;

export type ProcessRow = { pid: number; argv0: string; shell: boolean; cli: boolean };

export type ProofSeat = {
  reconciled: string;
  /** The plain screen, styling removed by the caller or still carrying it. Null when the pane
   *  could not be read. */
  plain: string | null;
  screenKind: string | null;
  presenceAt: string | null;
  /** Null when the host cannot name the pane's processes. */
  processes: readonly ProcessRow[] | null;
};

export type ProofReading =
  | { holds: false; why: 'unreadable' | 'unlisted' | 'idle' | 'dialog' | 'child' | 'short' }
  | { holds: true; digest: string; presenceAt: string | null };

/** The plain text the stillness clock compares. Styling is not a change. */
export function screenDigest(plain: string): string {
  return stripSgr(plain);
}

/** A live process that is neither the seat's CLI nor the pane's own shell. */
export function liveChild(processes: readonly ProcessRow[]): boolean {
  return processes.some((row) => !row.shell && !row.cli);
}

export function isDialogKind(kind: string | null): boolean {
  if (kind === null) return false;
  return (DIALOG_LEAD as readonly string[]).includes(kind) || (DIALOG_HOLD as readonly string[]).includes(kind);
}

/** Whether the four conditions hold at this instant. The wait is the pass's clock: this
 *  reading does not know how long they have held. */
export function proofNow(seat: ProofSeat): ProofReading {
  if (seat.plain === null || seat.screenKind === null) return { holds: false, why: 'unreadable' };
  if (seat.processes === null) return { holds: false, why: 'unlisted' };
  if (isDialogKind(seat.screenKind)) return { holds: false, why: 'dialog' };
  if (seat.reconciled !== 'working') return { holds: false, why: 'idle' };
  if (liveChild(seat.processes)) return { holds: false, why: 'child' };
  return { holds: true, digest: screenDigest(seat.plain), presenceAt: seat.presenceAt };
}

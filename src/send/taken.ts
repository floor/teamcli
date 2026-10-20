// The record a taken delivery leaves beside its drop, and the bounds on confirming it.
//
// A send whose box cleared before herdr's status or the transcript showed the seat act is
// `sent (unconfirmed)` with the note `trigger taken, no read receipt yet`: the seat took the line,
// and the sign that it acted on it comes later. The marker `<id>.taken` beside the drop is what a
// running watch reads on its later passes: it confirms the take from the transcript or the status,
// and says the one thing left to say when no sign ever comes. The marker is never a retry — a
// taken line is never typed again, whatever the later look finds.
//
// Like the retry's marker, this one is a convenience, never the message: the drop file is the
// message, and a marker that cannot be written or read costs a confirmation, not a byte of the
// body.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dropMessage } from './native.ts';

/** How long after a taken delivery the watch keeps looking for the sign the seat acted on it. */
export const TAKEN_MAX_AGE_MS = 30 * 60_000;

/** How long a seat must sit free after a taken delivery before a missing sign means it never acted:
 *  a CLI can start the line a moment after its box clears. */
export const TAKEN_IDLE_GRACE_MS = 60_000;

/** The words the watch files when the window passes with no sign: taken, and never acted on. The
 *  line is the history's note, and it is never a retype. */
export const NEVER_ACTED_ON = 'taken but never acted on';

/** The record kept beside a drop whose send was delivered as taken. */
export type TakenDrop = {
  id: string;
  /** The sender, as the send recorded it. */
  from: string;
  /** The seat, as the send recorded it. */
  to: string;
  /** The drop's whole body, which is what a later history line carries. */
  body: string;
  /** When the line was taken, ISO; the bounds are measured from it. */
  ts: string;
  /** The status herdr read before Enter: a status that moved from it is one sign the seat acted.
   *  `unknown` when the send could not say, which only the transcript can then confirm. */
  before: string;
};

/** The marker's path: the drop's own name with `.taken` after it. */
export function takenDropPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.taken`);
}

/** Writes the record whole, mode 0600 by rename of a temporary file in the drop's directory —
 *  the write shape and modes the drop itself gets (`dropMessage`). */
function writeTaken(dropDir: string, drop: TakenDrop): void {
  try {
    dropMessage(dropDir, `${drop.id}.taken`, JSON.stringify(drop));
  } catch {
    // The drop is the message; this record only carries the later confirmation.
  }
}

/** Records a taken delivery for the watch's later look. Best-effort and silent. */
export function markTaken(dropDir: string, drop: TakenDrop): void {
  writeTaken(dropDir, drop);
}

/** Forgets a taken drop: confirmed, or reported as never acted on. */
export function clearTaken(dropDir: string, id: string): void {
  try {
    unlinkSync(takenDropPath(dropDir, id));
  } catch {
    // Already gone, or never written: nothing stands in the way of the next send.
  }
}

/** The taken drops in one seat's directory, oldest first. A marker that cannot be read, or whose
 *  name does not match the id it holds, is not a record: it is skipped, never guessed at. */
export function readTaken(dropDir: string): TakenDrop[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const drops: TakenDrop[] = [];
  for (const name of names) {
    if (!name.endsWith('.taken')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dropDir, name), 'utf8')) as Partial<TakenDrop>;
      if (typeof parsed.id !== 'string' || typeof parsed.from !== 'string' || typeof parsed.to !== 'string'
        || typeof parsed.body !== 'string' || typeof parsed.ts !== 'string') continue;
      if (name !== `${parsed.id}.taken`) continue;
      drops.push({
        id: parsed.id,
        from: parsed.from,
        to: parsed.to,
        body: parsed.body,
        ts: parsed.ts,
        before: typeof parsed.before === 'string' && parsed.before !== '' ? parsed.before : 'unknown',
      });
    } catch {
      continue;
    }
  }
  return drops.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

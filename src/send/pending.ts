// The record a held send leaves beside its drop, and the bound on retrying it.
//
// `team send` writes the drop before it types the trigger. When the composer already holds a
// person's unsent text — or the seat never takes the trigger — the send exits `held` or
// `not-submitted` with the drop still on disk and its words never read, and until this record
// existed nothing ever tried again: four such drops sat unread in one orchestrator's pane while
// the owner's own draft held the composer. A marker `<id>.pending` beside the drop is the retry's
// record: the watch delivers it once the seat is free, gives up after a fixed number of typed
// tries or a fixed age, and says the drop's path so the message can be sent again.
//
// The marker is a convenience, never the message: the drop file is the message, and a marker that
// cannot be written or read costs a retry, not a byte of the body.
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dropMessage } from './native.ts';

/** How many typed retries one held send is given, after the send's own attempt. */
export const PENDING_MAX_TRIES = 3;

/** How long after the held send a retry is still made, however free the seat was. */
export const PENDING_MAX_AGE_MS = 30 * 60_000;

/** The record kept beside a drop whose send was held or not submitted. */
export type PendingDrop = {
  id: string;
  /** The sender, as the send recorded it. */
  from: string;
  to: string;
  /** The drop's whole body, which is what a retry's own history line carries. */
  body: string;
  /** When the send was held, ISO; a retry's age is measured from it. */
  ts: string;
  /** Typed retries made since the send. */
  tries: number;
};

/** The marker's path: the drop's own name with `.pending` after it. */
export function pendingDropPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.pending`);
}

/** Writes the record whole, mode 0600 by rename of a temporary file in the drop's directory —
 *  the write shape and modes the drop itself gets (`dropMessage`). */
function writePending(dropDir: string, drop: PendingDrop): void {
  try {
    dropMessage(dropDir, `${drop.id}.pending`, JSON.stringify(drop));
  } catch {
    // The drop is the message; this record only saves a retry.
  }
}

/** Records a held drop for a later retry. Best-effort and silent. */
export function markPending(dropDir: string, drop: Omit<PendingDrop, 'tries'>): void {
  writePending(dropDir, { ...drop, tries: 0 });
}

/** Writes a failed retry back, so the next pass knows how many tries are left. */
export function recordPendingTry(dropDir: string, drop: PendingDrop): void {
  writePending(dropDir, { ...drop, tries: drop.tries + 1 });
}

/** Forgets a drop: delivered, or given up on. */
export function clearPending(dropDir: string, id: string): void {
  try {
    unlinkSync(pendingDropPath(dropDir, id));
  } catch {
    // Already gone, or never written: nothing stands in the way of the next send.
  }
}

/** The held drops in one seat's directory, oldest first. A marker that cannot be read, or whose
 *  name does not match the id it holds, is not a retry: it is skipped, never guessed at. */
export function readPending(dropDir: string): PendingDrop[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const drops: PendingDrop[] = [];
  for (const name of names) {
    if (!name.endsWith('.pending')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dropDir, name), 'utf8')) as Partial<PendingDrop>;
      if (typeof parsed.id !== 'string' || typeof parsed.from !== 'string' || typeof parsed.to !== 'string'
        || typeof parsed.body !== 'string' || typeof parsed.ts !== 'string') continue;
      if (name !== `${parsed.id}.pending`) continue;
      drops.push({
        id: parsed.id,
        from: parsed.from,
        to: parsed.to,
        body: parsed.body,
        ts: parsed.ts,
        tries: typeof parsed.tries === 'number' && Number.isInteger(parsed.tries) && parsed.tries >= 0 ? parsed.tries : 0,
      });
    } catch {
      continue;
    }
  }
  return drops.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

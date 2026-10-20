// The display's read of the daemon's presence projection. The daemon owns the log and the
// atomic `current.json`; this module only asks one question per seat at display time: does a
// projection stand for the binding this seat's state records, and what does it say?
//
// The binding fence is the whole point: a session and seat are reused across launches, so a
// projection a predecessor wrote (or one left from before a fresh launch rotated the binding)
// is not this seat's reading, however fresh its timestamp. A missing, unreadable or malformed
// projection is no reading at all — the caller falls back to the screen and the labels already
// in use, never to a guessed state.
import { readFileSync } from 'node:fs';
import { isPresenceBinding, readPresenceReading } from '../daemon/presence/contract.ts';
import { presencePaths } from '../daemon/presence/spool.ts';
import type { PresenceObservation } from './state.ts';

/**
 * One seat's presence projection, fenced by the binding its state record names. `binding` is
 * taken as `unknown`: the state file is hand-editable, and a value that is not a binding is
 * simply no fence to open. Every filesystem and parse fault is no reading.
 */
export function readPresenceForSeat(
  stateDir: string,
  session: string,
  seat: string,
  binding: unknown,
): PresenceObservation | null {
  if (!isPresenceBinding(binding)) return null;
  const paths = presencePaths(stateDir, session, seat);
  if (paths === null) return null;
  let text: string;
  try {
    text = readFileSync(paths.current, 'utf8');
  } catch {
    return null;
  }
  const read = readPresenceReading(text);
  if (read.kind !== 'ok') return null;
  if (read.reading.binding !== binding) return null;
  return { state: read.reading.state, since: read.reading.since };
}

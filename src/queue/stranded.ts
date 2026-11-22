// Stranded seats on an active root: the safety net under the restart rebind.
//
// On an E7b-active root a Claude seat whose channel is unproven is reached by the typed pointer,
// and the pointer is typed only after the pane ownership proof passes before every key. A seat
// whose records a restart left behind (a new shell and CLI the rebind could not tie) fails that
// proof on every pass: its mail is kept, but nothing reaches it. Dark delivery still reaches such
// a seat, so a root whose seat stays stranded is rolled back to dark rather than left silent.
//
// The evidence is the watch's own: a pointer the proof refused, noted per seat with the first and
// the latest refusal of one unbroken streak on one activation. A pointer the proof let through
// clears the seat. A root is rolled back when one of its seats has been refused for at least
// STRANDED_ROLLBACK_MS, with no gap longer than STRANDED_FRESH_MS (mail is still owed: the
// scheduler asks again each pass while it is). The notes live in the watch's process: a restarted
// daemon starts the clock again, which only delays a rollback. Nothing here types, reads a pane
// or writes a record.

/** How long a seat's pointer must keep being refused before its root goes dark. */
export const STRANDED_ROLLBACK_MS = 5 * 60_000;
/** The latest refusal must be this recent: a seat no longer asked for is not stranded. */
export const STRANDED_FRESH_MS = 3 * 60_000;

type Note = { first: number; last: number; why: string; activation: string };
const notes = new Map<string, Map<string, Note>>();

/** A pointer for `seat` was refused by the pane ownership proof at `nowMs`, on the activation
 *  stamped `activation`. A refusal after a gap longer than the freshness bound, or on another
 *  activation, starts a new streak: separate failures never add up to a stranded seat. */
export function noteStrandedPointer(root: string, seat: string, nowMs: number, why: string, activation: string): void {
  const seats = notes.get(root) ?? new Map<string, Note>();
  notes.set(root, seats);
  const held = seats.get(seat);
  const streak = held !== undefined && held.activation === activation && nowMs - held.last <= STRANDED_FRESH_MS;
  seats.set(seat, { first: streak ? held.first : nowMs, last: nowMs, why, activation });
}

/** A pointer for `seat` passed the proof: the seat is reachable. */
export function noteReachedPointer(root: string, seat: string): void {
  notes.get(root)?.delete(seat);
}

/** The seats of `root` stranded on `activation` long enough to roll it back, with the reason. */
export function strandedSeats(root: string, nowMs: number, activation: string): { seat: string; since: number; why: string }[] {
  const out: { seat: string; since: number; why: string }[] = [];
  for (const [seat, note] of notes.get(root) ?? []) {
    if (note.activation !== activation) continue;
    if (nowMs - note.first >= STRANDED_ROLLBACK_MS && nowMs - note.last <= STRANDED_FRESH_MS) out.push({ seat, since: note.first, why: note.why });
  }
  return out;
}

/** Forgets a root's notes (it is dark: no pointer is asked of it any more). */
export function clearStranded(root: string): void {
  notes.delete(root);
}

// The daemon's held-frame step: the one place a socket frame that sat at a held-message dialog
// is seen, and the only writer of the `held` line a socket delivery can now get.
//
// The sender does not read the receiver's pane. A frame it handed to the socket comes back as
// `delivered (socket)` at once — the frame was taken — and whether the receiving session then
// put it behind a dialog is asked here, on the presence beat, never on a person's send. The
// sender's line is the trigger: a `delivered` history line with `via: 'socket'`, written no more
// than a few seconds ago, for a seat of this route.
//
// A candidate is bound to its signed record before any pane is read: the drop file must parse,
// verify under this checkout's message key, and name this id, seat, session and checkout. A
// record that carries a read receipt is not watched — a seat that read the message did not leave
// it in a dialog. The pane look is then scheduled over a short window (a first look about 150 ms
// after the line, then every ~300 ms to about 1.5 s), because a runtime may draw the dialog a
// beat after it takes the frame. One look per seat per pass, and only for a seat the pane host
// lists exactly once under its own name: a seat that is gone, renamed or listed twice has no
// pane this step may read.
//
// On the dialog, two writes: the history line (`outcome: 'held'`, `via: 'socket'`, the sender's
// own fields taken from the signed record) and the socket mark beside the drop queue, bound to
// the declaration in force. The mark is the retry guard the sender reads: the socket stays out
// until the seat's declaration is re-confirmed. `held` is raised once per id: a `held` line
// already in the retained log, this epoch's own raises, and the live watch all suppress it, so a
// restart never double-marks a message that is still unread.
//
// The step never writes a receipt and never marks a message read: the seat's own receipt is the
// only reading a message has. A `--wait` run writes no `delivered` line at the frame (its one
// line is written when the wait ends), so a frame taken by such a run is not watched here; the
// watch's unread retry is what reports it.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { agentListAsync, paneReadAsync } from '../../herdr.ts';
import { EVENT_RECORD_ID } from '../../bus/log.ts';
import { showsHeldFrameDialog } from '../../send/deliver.ts';
import { appendHistory, historyPath, readHistory, type HistoryEntry } from '../../send/history.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../../send/inbound.ts';
import { isReadOrCleared, readRecord, sameFolder, verifyRecord } from '../../send/record.ts';
import { messageKeyState } from '../../store/keys.ts';
import type { Seat } from '../../file/types.ts';

/** How far back a delivered line is watched. A line older than this has had its whole look
 *  schedule; a frame still unread then is the watch's unread retry to report, not a dialog. */
export const HELD_WATCH_MS = 5000;
/** The look schedule after a delivered line: the first look, the gap between looks, and the
 *  last look. A runtime may draw the dialog a beat after it takes the frame. */
export const HELD_FIRST_LOOK_MS = 150;
export const HELD_LOOK_EVERY_MS = 300;
export const HELD_LAST_LOOK_MS = 1500;
/** The screen rows read (the sender's own window before the check moved here) and the read's
 *  own bound, so a pane that stops answering holds one look, not the route's beat. */
export const HELD_SCREEN_LINES = 40;
export const HELD_READ_TIMEOUT_MS = 1200;
/** An entry stamped this far ahead of the pass is not a delivery yet: the sender and the daemon
 *  are separate processes, and a small lead is clock skew, not the future. */
const CLOCK_LEAD_MS = 1000;

export type PresenceHeldResult = {
  /** Message ids this pass raised `held` for. */
  raised: string[];
  /** Message ids a look has not decided yet. */
  watching: number;
  /** Why the step could not finish part of its work, for the route's log; null when it did. */
  failed: string | null;
};

export type PresenceHeldStep = (at: Date) => Promise<PresenceHeldResult>;

export type PresenceHeldInput = {
  /** The team file's folder (the folder holding the team file), never the checkout root. */
  stateDir: string;
  project: string;
  /** The checkout the watched messages are bound to. */
  root: string;
  session: string;
  home: string;
  /** This route's seats. A line addressed to another seat is not this route's to watch, and a
   *  seat's launch line binds the mark to the declaration the retry guard compares. */
  seats: ReadonlyArray<Pick<Seat, 'name' | 'launch'>>;
  /** The team's lead seat: a clearance signed by it settles a watched record without the seat
   *  ever reading it. Absent, only the owner's clearances do. */
  lead?: string;
  /** Test seam: the pane read. The real one goes through the pane host with the step's bound. */
  screen?: (pane: string, session: string) => Promise<string | null>;
  /** Test seam: the session's live agents, as the pane host lists them. */
  agents?: (session: string) => Promise<ReadonlyArray<{ name: string | null; pane: string }> | null>;
};

/** One delivered frame whose seat's pane is being looked at. */
type Watched = {
  id: string;
  seat: string;
  from: string;
  body: string;
  thread: string;
  nextLookAt: number;
  lastLookAt: number;
};

/** A verified record's own fields, before the look schedule is bound to the line's instant. */
type Bound = Pick<Watched, 'id' | 'seat' | 'from' | 'body' | 'thread'>;

export function createPresenceHeld(input: PresenceHeldInput): PresenceHeldStep {
  const seats = new Map(input.seats.map((seat) => [seat.name, seat]));
  const history = historyPath(input.project, input.root, input.home);
  const screen = input.screen
    ?? ((pane: string, session: string) => paneReadAsync(pane, HELD_SCREEN_LINES, session, { timeoutMs: HELD_READ_TIMEOUT_MS }));
  const agents = input.agents
    ?? ((session: string) => agentListAsync(session, { timeoutMs: HELD_READ_TIMEOUT_MS }));
  const watching = new Map<string, Watched>();
  /** Ids already raised, with the instant, pruned with the watch window. */
  const raised = new Map<string, number>();
  /** The last history stat this step read, so an unchanged log is not parsed again. */
  let stamp: string | null = null;

  const changeOf = (): string | null => {
    try {
      const info = statSync(history);
      return `${String(info.mtimeMs)}:${String(info.size)}`;
    } catch {
      // No log means no delivered line to watch; the next pass stats again.
      return null;
    }
  };

  const prune = (atMs: number): void => {
    for (const [id, ms] of raised) {
      if (ms < atMs - HELD_WATCH_MS) raised.delete(id);
    }
  };

  /** The candidate's signed record, or null when it does not verify, is addressed elsewhere, is
   *  another checkout's, or carries the seat's read receipt — or a lead's clearance, which
   *  settles it without the seat ever reading it. */
  const bound = (id: string, seat: string, key: KeyObject): Bound | null => {
    const dropDir = join(input.stateDir, 'send-drops', input.session, seat);
    const read = readRecord(join(dropDir, id), id);
    if (!read.ok || read.record === null) return null;
    if (!verifyRecord(read.record, key)) return null;
    const payload = read.record.payload;
    if (payload.to !== seat || payload.session !== input.session) return null;
    if (!sameFolder(payload.root, input.root)) return null;
    if (!isReadOrCleared(
      dropDir,
      id,
      { to: seat, root: input.root, session: input.session, ...(input.lead === undefined ? {} : { lead: input.lead }) },
      key,
    )) return { id, seat, from: payload.from, body: payload.body, thread: payload.thread };
    return null;
  };

  /** Finds the delivered lines written since the watch window opened and schedules their looks. */
  const scan = (entries: readonly HistoryEntry[], atMs: number, result: PresenceHeldResult): void => {
    const key = messageKeyState(input.home);
    if (key.kind !== 'key') return;
    // An id with a held line anywhere in the retained log is already raised: the log rotates,
    // but a message's mark must not be written twice by a daemon that started after the fact.
    const held = new Set<string>();
    for (const entry of entries) {
      if (entry.outcome === 'held') held.add(entry.id);
    }
    for (const entry of entries) {
      const ms = Date.parse(entry.ts);
      if (!Number.isFinite(ms)) continue;
      if (ms < atMs - HELD_WATCH_MS) continue;
      if (ms > atMs + CLOCK_LEAD_MS) continue;
      if (entry.outcome !== 'delivered' || entry.via !== 'socket') continue;
      if (!seats.has(entry.to)) continue;
      if (held.has(entry.id) || raised.has(entry.id) || watching.has(entry.id)) continue;
      // The id names the record's file, so a line that is not a generated token is never a path.
      if (!EVENT_RECORD_ID.test(entry.id)) continue;
      const record = bound(entry.id, entry.to, key.key);
      if (record === null) continue;
      watching.set(entry.id, {
        ...record,
        nextLookAt: ms + HELD_FIRST_LOOK_MS,
        lastLookAt: ms + HELD_LAST_LOOK_MS,
      });
    }
  };

  /** The one live pane of this seat, or null when the session lists none, several, or cannot be
   *  read: a pane that is not certainly the seat's is never looked at. */
  const paneOf = (live: ReadonlyArray<{ name: string | null; pane: string }>, seat: string): string | null => {
    const named = live.filter((agent) => agent.name === seat);
    return named.length === 1 ? named[0]!.pane : null;
  };

  const advance = (one: Watched, atMs: number): void => {
    if (atMs >= one.lastLookAt) {
      // The window closed with no dialog seen: the frame is delivered, and the unread retry is
      // what reports a seat that still has not read it.
      watching.delete(one.id);
      return;
    }
    one.nextLookAt = atMs + HELD_LOOK_EVERY_MS;
  };

  const raise = (one: Watched, at: Date, result: PresenceHeldResult): void => {
    watching.delete(one.id);
    raised.set(one.id, at.getTime());
    const seat = seats.get(one.seat);
    if (seat === undefined) return;
    // The line's fields are the signed record's own; only the outcome and the instant are this
    // step's. The instant is when the dialog was seen, not when the frame was taken.
    const written = appendHistory(input.project, input.root, input.home, {
      ts: at.toISOString(),
      from: one.from,
      to: one.seat,
      body: one.body,
      id: one.id,
      outcome: 'held',
      via: 'socket',
      thread: one.thread,
    });
    if (!written.ok) result.failed ??= `the held line for ${one.id} could not be written: ${written.reason}`;
    recordHeldSocket(
      heldSocketPath(input.stateDir, input.session, one.seat),
      declaredInboundOf({ dir: input.stateDir, root: input.root, session: input.session, seat: one.seat, launch: seat.launch }),
      at,
    );
    result.raised.push(one.id);
  };

  const lookAt = async (
    pane: string,
    batch: readonly Watched[],
    atMs: number,
    at: Date,
    result: PresenceHeldResult,
  ): Promise<void> => {
    const text = await screen(pane, input.session);
    if (text === null) {
      // A pane that did not answer is not a dialog; the schedule moves on and a later look asks
      // again, so a slow runtime is retried rather than read as clear.
      result.failed ??= `the pane of ${batch[0]!.seat} could not be read`;
      for (const one of batch) advance(one, atMs);
      return;
    }
    if (!showsHeldFrameDialog(text)) {
      for (const one of batch) advance(one, atMs);
      return;
    }
    // The dialog holds the box, so every frame this seat took and has not read is behind it.
    for (const one of batch) raise(one, at, result);
  };

  /** One look per seat with a due candidate this pass. */
  const look = async (atMs: number, at: Date, result: PresenceHeldResult): Promise<void> => {
    const due = [...watching.values()].filter((one) => one.nextLookAt <= atMs);
    if (due.length === 0) return;
    const live = await agents(input.session);
    if (live === null) {
      // The session itself could not be read: nothing is looked at, and the schedule waits for
      // the next pass rather than reading a pane this step cannot attribute to a seat.
      result.failed ??= 'the session could not be read, so no pane was looked at';
      return;
    }
    const bySeat = new Map<string, Watched[]>();
    for (const one of due) {
      const batch = bySeat.get(one.seat);
      if (batch === undefined) bySeat.set(one.seat, [one]);
      else batch.push(one);
    }
    const looks: Promise<void>[] = [];
    for (const [seat, batch] of bySeat) {
      const pane = paneOf(live, seat);
      if (pane === null) {
        for (const one of batch) advance(one, atMs);
        continue;
      }
      looks.push(lookAt(pane, batch, atMs, at, result));
    }
    await Promise.all(looks);
  };

  return async (at: Date): Promise<PresenceHeldResult> => {
    const atMs = at.getTime();
    const result: PresenceHeldResult = { raised: [], watching: 0, failed: null };
    try {
      prune(atMs);
      const change = changeOf();
      if (change !== null && change !== stamp) {
        stamp = change;
        const read = readHistory(input.project, input.root, input.home);
        if (read.ok) scan(read.entries, atMs, result);
        else result.failed = `the send history could not be read: ${read.reason}`;
      }
    } catch (error) {
      result.failed = `the held scan failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await look(atMs, at, result);
    } catch (error) {
      result.failed ??= `the held look failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    result.watching = watching.size;
    return result;
  };
}

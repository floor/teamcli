// The read a seat's own answer writes (ADR `message-path`, D3).
//
// A seat answers in two ways: `team reply <id>` joins the message's thread and writes the read
// beside its `replied` receipt (`src/commands/reply.ts`), and the common case — a plain
// `team send` back to the sender — writes only its own new record. This module covers the second:
// the sending seat's own signed act settles the NEWEST message that the send's recipient delivered
// to it before the send's own instant, and nothing else. Only that sender's, only to this seat,
// only a delivery the sender's own history line names as socket, channel or native, and only one:
// a sender that sent three messages and is answered once keeps the other two unread, each with its
// own wake, so one answer never silently swallows unread work. The receipt is the seat's, never the
// original sender's.
//
// The newest message is found from the seat's own folder: the records with no read or replied
// receipt beside them, read and verified as `team messages` reads them, newest first, until one is
// a delivery the rule counts. A record that does not verify, is not this seat's from this sender,
// is already read or was delivered after the send settles nothing, and when none holds nothing
// is marked. Only the seat's own folder is listed, never the session's transport tree.
import { readdirSync } from 'node:fs';
import { recordDir, samePath } from '../commands/messages.ts';
import { messageKeyState } from '../store/keys.ts';
import { readHistory, type HistoryEntry } from './history.ts';
import { publishRecordRead } from './read-receipt.ts';
import { carrierLegOf, recordAuthOfSealed, isReadOrCleared, readRecord, readVerifiedReceipt, receiptFile, sealedOfRecord, RECORD_STEM, type RecordPayload } from './record.ts';
import { stampedListing } from '../queue/mail-tree.ts';
import { liveRecordPath } from './drop-folder.ts';

/** The legs whose delivery is evidence enough to answer: a frame the receiver's session took, a
 *  push its channel carried, or its own native handoff. A typed wake is that leg's own act and a
 *  webhook post is the sender's; neither is answered by this sweep. */
const DELIVERED_VIAS: readonly string[] = ['socket', 'channel', 'native'];

export type AnsweredBySendInput = {
  /** The seat making the send: its own folder holds the record and its own key signs the read. */
  seat: string;
  /** The seat this send addresses; only messages FROM it are settled. */
  sender: string;
  /** The registry id the address resolved to, when it resolved. A message whose signed `from_id`
   *  names a different agent is another person under the same seat name, and is left unread. */
  senderId: string | null;
  root: string;
  session: string;
  /** The project whose history carries the delivery lines: the receiving team's own store. */
  project: string;
  home: string;
  /** The send's own signed instant. A delivery after it is not answered by it. */
  at: string;
  /** The team's lead seat: a clearance signed by it settles in the scans here; absent, only the
   *  owner's clearances do. */
  lead?: string;
};

/** What the sweep did. `none` is the ordinary case: nothing from this sender was waiting. */
export type AnsweredBySendOutcome =
  | { kind: 'marked'; id: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: 'key' | 'history' };

/** The first history line each message id has: the sender's own walk, which names the leg that
 *  carried it. Later lines about the same message are retries and promotions, not deliveries. */
function firstLinesOf(project: string, root: string, home: string, ids: ReadonlySet<string>): Map<string, HistoryEntry> | null {
  // Only the hinted ids are looked up, so only their lines are parsed; each id's first line is
  // the same one a full read finds.
  const read = readHistory(project, root, home, ids);
  if (!read.ok) return null;
  const lines = new Map<string, HistoryEntry>();
  for (const entry of read.entries) {
    if (!lines.has(entry.id)) lines.set(entry.id, entry);
  }
  return lines;
}

/** The record names in the seat's folder and its stamped twin with no read or replied receipt
 *  file beside them. Only names are listed; a folder that cannot be listed names nothing. */
function waitingIds(dropDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const stamped = stampedListing(dropDir);
  const ids: string[] = [];
  for (const folder of [names, stamped !== null && stamped !== 'unreadable' ? stamped.names : []]) {
    const all = new Set(folder);
    for (const name of folder) {
      if (RECORD_STEM.test(name) && !all.has(`${name}.read.json`) && !all.has(`${name}.replied.json`)) ids.push(name);
    }
  }
  return ids;
}

/**
 * Publishes the seat-signed `read` receipt for the newest message the send's recipient delivered
 * to this seat before the send, when one waits unread. Returns the id it settled; a receipt that
 * cannot be written is reported as `none` with the reason on the caller's log, never an error of
 * the send.
 */
export function markAnsweredBySend(input: AnsweredBySendInput): AnsweredBySendOutcome {
  const { seat, sender, senderId, root, session, project, home, at, lead } = input;
  const state = messageKeyState(home);
  if (state.kind !== 'key') return { kind: 'unavailable', reason: 'key' };
  const dropDir = recordDir(root, session, seat);
  const context = { to: seat, root, session, ...(lead === undefined ? {} : { lead }) };
  const sentAt = Date.parse(at);
  if (Number.isNaN(sentAt)) return { kind: 'none' };
  // Every record still waiting here from this sender, read and authenticated as `team messages`
  // reads it, newest first (an equal instant keeps the greater id first).
  const waiting: RecordPayload[] = [];
  for (const id of waitingIds(dropDir)) {
    const read = readRecord(liveRecordPath(dropDir, id), id);
    if (!read.ok || read.record === null) continue;
    const auth = recordAuthOfSealed(sealedOfRecord(read.record), state.key);
    if (auth.kind !== 'ok') continue;
    const payload = auth.value.payload;
    if (payload.id !== id || payload.to !== seat || payload.session !== session) continue;
    if (!samePath(payload.root, root)) continue;
    if (payload.from !== sender) continue;
    // A registry id that disagrees names another agent under the same seat name; without one on
    // either side the name is all the evidence there is.
    if (senderId !== null && payload.from_id !== null && payload.from_id !== senderId) continue;
    if (Number.isNaN(Date.parse(payload.at))) continue;
    waiting.push(payload);
  }
  if (waiting.length === 0) return { kind: 'none' };
  waiting.sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const lines = firstLinesOf(project, root, home, new Set(waiting.map((payload) => payload.id)));
  if (lines === null) return { kind: 'unavailable', reason: 'history' };
  // The first that holds is the newest delivered-unread message this send answers; anything that
  // does not hold is passed over, and when nothing holds the send settles nothing.
  for (const payload of waiting) {
    // The delivery instant. A carrier's own signed delivered receipt, written at hand-over and
    // naming an eligible leg (socket, channel, native), is preferred: a `--wait` send writes its
    // history line only when the wait ends, so that line's time can be later than the hand-over
    // and than this send. Transport acceptance by that leg, never a read. A record without such a
    // receipt keeps the first history line's instant and its leg. A message delivered after this
    // send is not answered by it; an equal instant is not later — the frame was already there.
    const carried = readVerifiedReceipt(receiptFile(dropDir, payload.id, 'delivered'), payload.id, 'delivered', context, state.key);
    const carriedLeg = carried === null ? null : carrierLegOf(carried.payload.read_by);
    let deliveredAt = Number.NaN;
    if (carried !== null && carriedLeg !== null && DELIVERED_VIAS.includes(carriedLeg)) {
      deliveredAt = Date.parse(carried.payload.at);
    } else {
      const line = lines.get(payload.id);
      if (line !== undefined && line.via !== undefined && DELIVERED_VIAS.includes(line.via)) deliveredAt = Date.parse(line.ts);
    }
    if (Number.isNaN(deliveredAt) || deliveredAt > sentAt) continue;
    // A message a lead cleared, or one read under a receipt the listing did not show, is not
    // this send's to settle: the clearance is the lead's, never the seat's own read.
    if (isReadOrCleared(dropDir, payload.id, context, state.key)) continue;
    const outcome = publishRecordRead({
      dropDir,
      id: payload.id,
      to: seat,
      root,
      session,
      home,
      key: state.key,
      at,
      readBy: 'answered-by-send',
      ...(lead === undefined ? {} : { lead }),
    });
    if (outcome.kind === 'published' || outcome.kind === 'served') return { kind: 'marked', id: payload.id };
    // A receipt this run could not write is not a hint to try an older message: that message is
    // not the newest the rule names, and settling it instead would swallow a newer unread one.
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

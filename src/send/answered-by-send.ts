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
// The newest message is found through the recipient folder's unread index (`src/send/unread-hint.ts`),
// never by walking the session's transport tree: one small file names the sender's newest few
// staged records, and this sweep reads and verifies them newest first until one is a delivery the
// rule counts. The index is a hint — an entry that does not verify, is not this seat's from this
// sender, is already read or was delivered after the send settles nothing, the next entry is
// tried, and when none holds nothing is marked. None of it falls back to a scan.
import { join } from 'node:path';
import { recordDir, samePath } from '../commands/messages.ts';
import { messageKeyState } from '../store/keys.ts';
import { readHistory, type HistoryEntry } from './history.ts';
import { publishRecordRead } from './read-receipt.ts';
import { recordAuthOfSealed, isReadOrCleared, readRecord, sealedOfRecord } from './record.ts';
import { readUnreadHint } from './unread-hint.ts';

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
function firstLinesOf(project: string, root: string, home: string): Map<string, HistoryEntry> | null {
  const read = readHistory(project, root, home);
  if (!read.ok) return null;
  const lines = new Map<string, HistoryEntry>();
  for (const entry of read.entries) {
    if (!lines.has(entry.id)) lines.set(entry.id, entry);
  }
  return lines;
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
  // The one index read: the sender's newest staged records, or nothing. No tree is listed.
  const hints = readUnreadHint(dropDir, sender);
  if (hints.length === 0) return { kind: 'none' };
  const lines = firstLinesOf(project, root, home);
  if (lines === null) return { kind: 'unavailable', reason: 'history' };
  const sentAt = Date.parse(at);
  if (Number.isNaN(sentAt)) return { kind: 'none' };
  // Each entry the index names, newest first, read and authenticated as `team messages` reads it.
  // The first that holds is the newest delivered-unread message this send answers; anything that
  // does not hold is passed over, and when nothing holds the send settles nothing rather than
  // searching the tree.
  const context = { to: seat, root, session, ...(lead === undefined ? {} : { lead }) };
  for (const hint of hints) {
    const read = readRecord(join(dropDir, hint.id), hint.id);
    if (!read.ok || read.record === null) continue;
    const sealed = sealedOfRecord(read.record);
    const auth = recordAuthOfSealed(sealed, state.key);
    if (auth.kind !== 'ok') continue;
    const payload = auth.value.payload;
    if (payload.id !== hint.id || payload.to !== seat || payload.session !== session) continue;
    if (!samePath(payload.root, root)) continue;
    if (payload.from !== sender) continue;
    // A registry id that disagrees names another agent under the same seat name; without one on
    // either side the name is all the evidence there is.
    if (senderId !== null && payload.from_id !== null && payload.from_id !== senderId) continue;
    const line = lines.get(payload.id);
    if (line === undefined || line.via === undefined || !DELIVERED_VIAS.includes(line.via)) continue;
    // The delivery is the first history line's instant: a message delivered after this send is
    // not answered by it. An equal instant is not later — the frame was already there.
    const deliveredAt = Date.parse(line.ts);
    if (Number.isNaN(deliveredAt) || deliveredAt > sentAt) continue;
    if (Number.isNaN(Date.parse(payload.at))) continue;
    // The index may still name a message that is already read or that a lead cleared — a clear
    // that was lost, or another reader that won after this hint was written. It is not this
    // send's to settle: the clearance is the lead's, never the seat's own read.
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

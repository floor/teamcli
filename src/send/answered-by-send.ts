// The read a seat's own answer writes (ADR `zeus-message-path`, D3).
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
import { listUnackedMessages, recordDir } from '../commands/messages.ts';
import { messageKeyState } from '../store/keys.ts';
import { readHistory, type HistoryEntry } from './history.ts';
import { publishRecordRead } from './read-receipt.ts';

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
  const { seat, sender, senderId, root, session, project, home, at } = input;
  const state = messageKeyState(home);
  if (state.kind !== 'key') return { kind: 'unavailable', reason: 'key' };
  const lines = firstLinesOf(project, root, home);
  if (lines === null) return { kind: 'unavailable', reason: 'history' };
  const sentAt = Date.parse(at);
  if (Number.isNaN(sentAt)) return { kind: 'none' };
  let newest: { id: string; at: number } | null = null;
  for (const message of listUnackedMessages(root, session, home)) {
    if (message.to !== seat) continue;
    if (message.from !== sender) continue;
    // A registry id that disagrees names another agent under the same seat name; without one on
    // either side the name is all the evidence there is.
    if (senderId !== null && message.from_id !== null && message.from_id !== senderId) continue;
    const line = lines.get(message.id);
    if (line === undefined || line.via === undefined || !DELIVERED_VIAS.includes(line.via)) continue;
    // The delivery is the first history line's instant: a message delivered after this send is
    // not answered by it. An equal instant is not later — the frame was already there.
    const deliveredAt = Date.parse(line.ts);
    if (Number.isNaN(deliveredAt) || deliveredAt > sentAt) continue;
    const messageAt = Date.parse(message.at);
    if (Number.isNaN(messageAt)) continue;
    // The newest message this sender delivered, not merely the last one the scan met.
    if (newest === null || messageAt > newest.at || (messageAt === newest.at && message.id > newest.id)) {
      newest = { id: message.id, at: messageAt };
    }
  }
  if (newest === null) return { kind: 'none' };
  const outcome = publishRecordRead({
    dropDir: recordDir(root, session, seat),
    id: newest.id,
    to: seat,
    root,
    session,
    home,
    key: state.key,
    at,
    readBy: 'answered-by-send',
  });
  return outcome.kind === 'published' || outcome.kind === 'served' ? { kind: 'marked', id: newest.id } : { kind: 'none' };
}

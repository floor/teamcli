// One watch pass's mail reads, taken once.
//
// A pass asks three readers the same question about the same folders: `mailboxWaiting` lists the
// unacked records and, for each seat with one, the seat's unread drops; `wakeUnreadDrops` lists
// every seat's unread drops; `reportUnreadDrops` lists them again. Each listing reads the folder
// and every waiting record, so a pass without a shared reading scans the same folders three times
// and reads each record two or three times over. A MailPass is made once per pass and handed to
// all three: the unacked list and each seat's unread list are computed once, and every record file
// is read once, through one cached verified read.
//
// Only the pass's own reading is kept. A record is write-once, so its verified payload stands for
// the pass. The wake's typing leg still reads names and receipts afresh under the seat's lock,
// before anything is typed; what it reuses is this pass's record reads, so only a record that
// landed after the scan is opened there. Nothing here delays or narrows that look.
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { listUnackedMessages, type UnackedMessage } from '../commands/messages.ts';
import { listUnread, type InboxMessage } from '../mcp/inbox.ts';
import { verifiedRecordAt, type RecordPayload, type RecordReader } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

/** What every reader of one pass names: the checkout's `.agents` directory, the checkout, the
 *  session whose drops are read, the home whose message key verifies them, and the team's resolved
 *  lead, when the caller loaded the team. A reader with no lead sees only the owner's clearances. */
export type MailPassInput = { dir: string; root: string; session: string; home: string; lead?: string };

/** The stuck-episode marker beside a seat's drop folder. Dot-named, so no inbox scan takes it
 *  for mail; its presence is read from the folder listing, its contents only when it is there. */
export const STUCK_MARKER = '.stuck';

/** One pass's mail: each drop folder listed once, each record read once, shared by every reader
 *  the pass runs. */
export class MailPass {
  readonly input: MailPassInput;
  /** The message key read at the pass's start; null when this home has none, in which case no
   *  record can be verified and every reader answers as it does without a key. */
  private readonly key: KeyObject | null;
  private readonly records = new Map<string, RecordPayload | null>();
  private readonly unreadBySeat = new Map<string, InboxMessage[]>();
  /** The raw folder listing each seat's unread was taken from, kept for the pass's readers. */
  private readonly listedBySeat = new Map<string, readonly string[]>();
  private unackedOnce: UnackedMessage[] | null = null;

  constructor(input: MailPassInput) {
    this.input = input;
    const state = messageKeyState(input.home);
    this.key = state.kind === 'key' ? state.key : null;
  }

  /** The record's verified payload, read the first time the pass asks for it and kept. */
  readonly recordAt: RecordReader = (path, id) => {
    const at = `${path}\u0000${id}`;
    const held = this.records.get(at);
    if (held !== undefined) return held;
    const payload = this.key === null ? null : verifiedRecordAt(path, id, this.key);
    this.records.set(at, payload);
    return payload;
  };

  /** One seat's drop folder. */
  dropDir(seat: string): string {
    return join(this.input.dir, 'send-drops', this.input.session, seat);
  }

  /** Every message still waiting in `seat`'s own folder, listed once for the pass. */
  unread(seat: string): InboxMessage[] {
    const held = this.unreadBySeat.get(seat);
    if (held !== undefined) return held;
    const listed = listUnread(
      this.dropDir(seat),
      {
        to: seat,
        root: this.input.root,
        session: this.input.session,
        ...(this.input.lead === undefined ? {} : { lead: this.input.lead }),
      },
      this.input.home,
      this.recordAt,
      (names) => {
        this.listedBySeat.set(seat, names);
      },
    );
    this.unreadBySeat.set(seat, listed);
    return listed;
  }

  /** Whether this pass's listing of `seat`'s folder showed the stuck-episode marker. The folder
   *  is the one `unread` already lists: a marker the listing does not show is never opened, and
   *  a folder that could not be listed shows none. The caller reads the marker itself, once. */
  hasStuckMarker(seat: string): boolean {
    if (!this.unreadBySeat.has(seat)) this.unread(seat);
    return this.listedBySeat.get(seat)?.includes(STUCK_MARKER) ?? false;
  }

  /** Every record in the session's drops with no verifying read receipt, listed once for the
   *  pass. */
  unacked(): UnackedMessage[] {
    if (this.unackedOnce === null) {
      this.unackedOnce = listUnackedMessages(this.input.root, this.input.session, this.input.home, this.recordAt, this.input.lead);
    }
    return this.unackedOnce;
  }
}

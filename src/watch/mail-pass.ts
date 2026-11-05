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
// the pass. Receipts are checked when a folder is listed — once per pass, as the shared set the
// brief asks for — so a receipt that lands later is seen by the next pass, and the wake's typing
// leg keeps its own under-lock re-look before anything is typed. Nothing here delays that look.
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { listUnackedMessages, type UnackedMessage } from '../commands/messages.ts';
import { listUnread, type InboxMessage } from '../mcp/inbox.ts';
import { verifiedRecordAt, type RecordPayload, type RecordReader } from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

/** What every reader of one pass names: the checkout's `.agents` directory, the checkout, the
 *  session whose drops are read, and the home whose message key verifies them. */
export type MailPassInput = { dir: string; root: string; session: string; home: string };

/** One pass's mail: each drop folder listed once, each record read once, shared by every reader
 *  the pass runs. */
export class MailPass {
  readonly input: MailPassInput;
  /** The message key read at the pass's start; null when this home has none, in which case no
   *  record can be verified and every reader answers as it does without a key. */
  private readonly key: KeyObject | null;
  private readonly records = new Map<string, RecordPayload | null>();
  private readonly unreadBySeat = new Map<string, InboxMessage[]>();
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
      { to: seat, root: this.input.root, session: this.input.session },
      this.input.home,
      this.recordAt,
    );
    this.unreadBySeat.set(seat, listed);
    return listed;
  }

  /** Every record in the session's drops with no verifying read receipt, listed once for the
   *  pass. */
  unacked(): UnackedMessage[] {
    if (this.unackedOnce === null) {
      this.unackedOnce = listUnackedMessages(this.input.root, this.input.session, this.input.home, this.recordAt);
    }
    return this.unackedOnce;
  }
}

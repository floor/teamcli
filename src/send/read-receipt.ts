// Publishing the signed `read` receipt for one message record, without printing it.
//
// The receipt is the per-id gate every reader shares — `team messages`, `team drops --read`,
// `inbox_read`, and `team ack`, which marks a message read without serving its body. It is
// published with `link` — exclusive and no-clobber — and flushed before any body is shown, so at
// most one reader wins the name and the receipt that proves the exposure survives a crash that
// follows it. This module holds only that ordered act and returns what happened, in words the
// callers turn into their own refusals: `team messages` says a body was not shown, `team ack` says
// the message was not marked read. A `replied` receipt is the read that came before an answer and
// serves the id exactly as a `read` receipt does.
import { type KeyObject } from 'node:crypto';
import { heldAt, type Held } from '../launch/rules-file.ts';
import { flushReceipt, publishReadReceipt } from '../mcp/inbox-admission.ts';
import { isRead, receiptFile, signReceiptPayload, type ReceiptPayload } from './record.ts';

/** The message whose read is being recorded: its folder, its id, the seat it was addressed to,
 *  and the binding the receipt carries. `root` and `session` are the record's own — a message a
 *  client wrote lives in this checkout but names the session it was bound to. */
export type RecordReadInput = {
  dropDir: string;
  id: string;
  to: string;
  root: string;
  session: string;
  home: string;
  key: KeyObject;
  at: string;
  /** How the message was read, when the reader names it: `channel` for the acknowledgement a
   *  channel notification's handling turn makes. Absent, the receipt says only that it was read. */
  readBy?: string;
};

/** What the act found or did. `held` names the entry at a receipt name this run will not touch;
 *  `unwritten` says the receipt this run published could not be confirmed. */
export type RecordReadOutcome =
  | { kind: 'published' }
  | { kind: 'served' }
  | { kind: 'held'; status: 'read' | 'replied'; entry: Exclude<Held['kind'], 'missing'> }
  | { kind: 'unwritten'; reason: 'changed' | 'write' | 'durable' };

export function publishRecordRead(input: RecordReadInput): RecordReadOutcome {
  const { dropDir, id, to, root, session, home, key, at, readBy } = input;
  const context = { to, root, session };
  const servedNow = (): boolean => isRead(dropDir, id, context, key);
  // The caller's own filter may already have asked `isRead`; this re-check is the race with every
  // other reader.
  if (servedNow()) return { kind: 'served' };
  const readName = receiptFile(dropDir, id, 'read');
  const atRead = heldAt(readName);
  if (atRead.kind === 'file') return servedNow() ? { kind: 'served' } : { kind: 'held', status: 'read', entry: 'file' };
  if (atRead.kind !== 'missing') return { kind: 'held', status: 'read', entry: atRead.kind };
  const atReplied = heldAt(receiptFile(dropDir, id, 'replied'));
  if (atReplied.kind === 'file') {
    // A replied receipt is the read that came before the answer: a valid one serves this id, and
    // one that does not verify may still be evidence of an earlier exposure, so it stays.
    return servedNow() ? { kind: 'served' } : { kind: 'held', status: 'replied', entry: 'file' };
  }
  if (atReplied.kind !== 'missing') return { kind: 'held', status: 'replied', entry: atReplied.kind };
  const receipt: ReceiptPayload = {
    kind: 'receipt',
    status: 'read',
    id,
    to,
    root,
    session,
    at,
    ...(readBy === undefined ? {} : { read_by: readBy }),
  };
  const published = publishReadReceipt(readName, `${JSON.stringify(signReceiptPayload(receipt, home), null, 2)}\n`);
  if (published === 'exists') {
    // A rival won the name between the checks and this link. Its entry is the one serving of this
    // id: verify it, and leave it exactly as it is either way.
    if (servedNow()) return { kind: 'served' };
    const atName = heldAt(readName);
    if (atName.kind === 'missing') return { kind: 'unwritten', reason: 'changed' };
    return { kind: 'held', status: 'read', entry: atName.kind };
  }
  if (published === 'failed') return { kind: 'unwritten', reason: 'write' };
  // The receipt must survive a crash before any body is shown. A receipt that cannot be flushed is
  // not proof: the id stays spent, and the caller shows nothing.
  if (!flushReceipt(readName, dropDir)) return { kind: 'unwritten', reason: 'durable' };
  return { kind: 'published' };
}

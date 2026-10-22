// The signed message record: the one file a send writes for a message, and the receipts beside
// it that give the message its status.
//
// Draft 3 (§3.1): one signed record per message, written whole into the recipient's folder,
// carrying both registry ids and the admitting rule on it. The id is the record's name; a second
// record of one id is dropped by the receiver. The transport tree stays
// `<root>/.agents/send-drops/<session>/<seat>` and the file at `<id>` is the record — the raw drop
// body it replaced is gone. The signature is the checkout's message key, over `MESSAGE_DOMAIN`
// and the canonical payload, so a record rewritten without the key is refused. Every process on
// this machine runs as the owner-user: the signature is evidence of who wrote a record, not a
// wall against the process that runs it.
//
// Status is derived, never edited (§3.3). Each status is a receipt record beside the message,
// signed with `RECEIPT_DOMAIN` and written only by the receiving side; `statusOf` reads them in
// the one order the status moves — `held`, `delivered`, `read`, `replied` — and a late receipt
// changes nothing. The attempt outcomes (`not-submitted`, `timeout`, `unreachable`, `refused`)
// are outcomes, never statuses, and are not read here.
//
// A thread's close is a third file, beside the record it answers: `<id>.closed.json`, written by
// `team reply --close` and signed with `RECEIPT_DOMAIN` like a receipt, since it is derived state
// beside a message. It is not a message and carries no body: it names the record, the thread and
// the side that closed it, and `team reply` reads it before a reply is admitted.
import { type KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isBriefEpoch, isBriefIncarnation, type BriefBinding } from '../launch/brief-id.ts';
import { heldAt } from '../launch/rules-file.ts';
import { messageKeyOf, messageKeyState, MESSAGE_DOMAIN, RECEIPT_DOMAIN, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { readNoFollow, type MessageStatus } from './history.ts';
import { dropMessage } from './native.ts';

/** The `kind` a message record's payload carries. A receipt carries `receipt`, a thread's close
 *  `thread-close`. */
export const RECORD_KIND = 'message';

/** The delivered body's digest, as a brief's record and receipt carry it. */
const BRIEF_SHA256 = /^[0-9a-f]{64}$/;

/** The `kind` a thread's close carries. A close is not a message and never carries a body. */
export const CLOSE_KIND = 'thread-close';

/** The rule line a seat's reply onto a client thread carries: evidence text, not authority. */
export const CLIENT_REPLY_RULE = 'a reply on a client thread, to the client that opened it';

/**
 * One message record's signed payload. The two registry ids are `null` only where the registry
 * holds none — the owner, or a seat the store has no record for yet; the rule that admitted the
 * pair is always named.
 */
export type RecordPayload = {
  kind: typeof RECORD_KIND;
  /** The record's name, minted by the sender and never reused. */
  id: string;
  /** The recipient seat's name, and the registry id it resolved to, when it has one. */
  to: string;
  to_id: string | null;
  /** The receiving checkout and team session the record is bound to. */
  root: string;
  session: string;
  /** When the sender wrote it, ISO. */
  at: string;
  /** The whole message, sender header included — what every transport carries and every history line keeps. */
  body: string;
  /** The sender: a seat's name, or `owner`. */
  from: string;
  from_id: string | null;
  /** The rule that admitted the pair, as the send judged it. */
  rule: string;
  /** The first message's id; a first message is its own thread's id. */
  thread: string;
  /** The id of the record this one answers, on a reply only. */
  in_reply_to?: string;
  /** A general seat brief's delivery: the delivered body's sha256 and the lifetime it belongs
   *  to. Ordinary messages carry neither; a brief's record carries both. */
  brief_sha256?: string;
  incarnation?: string;
  /** The external client principal that wrote the record, when one did: its client id and the
   *  grant id that admitted it. A record from a seat or the owner carries none. */
  from_client?: { client_id: string; grant_id: string };
  /** The external client principal a record is written to, on a reply onto a client thread: the
   *  immutable client id and the grant that opened the thread. A record carries `from_client` or
   *  `to_client`, never both. */
  to_client?: { client_id: string; grant_id: string };
};

export type SignedRecord = { payload: RecordPayload; signature: string };

/** The statuses a receipt can record. `sent` is the absence of a receipt, never written. */
export type ReceiptStatus = Exclude<MessageStatus, 'sent'>;

/** The statuses in the one order they move; a later receipt is the one that stands. */
export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['held', 'delivered', 'read', 'replied'];

export type ReceiptPayload = {
  kind: 'receipt';
  status: ReceiptStatus;
  id: string;
  to: string;
  root: string;
  session: string;
  at: string;
  /** A brief read's binding: the claim it was served under. An ordinary message's receipt has
   *  none. The epoch is the one field the receipt comparison makes, so a receipt written by a
   *  process started under another epoch does not count for the current claim. */
  brief_sha256?: string;
  incarnation?: string;
  brief_epoch?: string;
  /** Diagnostics the read copied from the seat's record, when it had them. */
  brief_seat_handle?: string;
  brief_pane_root_pid?: number;
  /** What took the record when it was read without a reader: the socket delivery writes the read
   *  receipt itself, and this names it. A receipt written by a reader carries none. Signed with
   *  the rest of the payload, so a receipt that names another taker than the one written does
   *  not verify. */
  read_by?: string;
};

export type SignedReceipt = { payload: ReceiptPayload; signature: string };

/**
 * One thread's close: the record it answers (`id`), the thread it ends, and the side that closed
 * it. A close is a claim `team reply` reads before admitting a reply, so it is signed like a
 * receipt — the two sides here differ from a receipt's: `to` is the folder the close sits in and
 * `root`/`session` bind it to one checkout, exactly as a record's do.
 */
export type ClosePayload = {
  kind: typeof CLOSE_KIND;
  /** The id of the record this close answers; the close is written beside it. */
  id: string;
  /** The thread's id — the first record's id. */
  thread: string;
  /** The side that closed it: a seat's name, or `owner`. */
  by: string;
  root: string;
  session: string;
  at: string;
};

export type SignedClose = { payload: ClosePayload; signature: string };

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** An id that can name one file in a folder: no separator, no traversal, no NUL. */
export function recordNameOk(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\') && !id.includes('\0');
}

/**
 * The payload a message record carries, or null when the value is not one this version writes.
 * `thread` and the admitting rule are required: every record carries them, and a file without
 * them is not the record a send of this version wrote.
 */
export function recordPayloadOf(value: unknown): RecordPayload | null {
  if (!isRecordValue(value)) return null;
  if (value.kind !== RECORD_KIND) return null;
  for (const field of ['id', 'to', 'root', 'session', 'at', 'body', 'from', 'rule', 'thread'] as const) {
    if (!nonEmpty(value[field])) return null;
  }
  if (!recordNameOk(value.id as string)) return null;
  if (!Number.isFinite(Date.parse(value.at as string))) return null;
  for (const field of ['from_id', 'to_id'] as const) {
    if (value[field] !== null && !nonEmpty(value[field])) return null;
  }
  if (value.from_id === undefined || value.to_id === undefined) return null;
  if (value.in_reply_to !== undefined && !nonEmpty(value.in_reply_to)) return null;
  // A brief's record carries both binding fields or neither: a record with only one is not one
  // this version wrote, and an ordinary message carries neither.
  const brief = value.brief_sha256 !== undefined || value.incarnation !== undefined;
  if (brief) {
    if (typeof value.brief_sha256 !== 'string' || !BRIEF_SHA256.test(value.brief_sha256)) return null;
    if (!isBriefIncarnation(value.incarnation)) return null;
  }
  const payload: RecordPayload = {
    kind: RECORD_KIND,
    id: value.id as string,
    to: value.to as string,
    to_id: value.to_id as string | null,
    root: value.root as string,
    session: value.session as string,
    at: value.at as string,
    body: value.body as string,
    from: value.from as string,
    from_id: value.from_id as string | null,
    rule: value.rule as string,
    thread: value.thread as string,
  };
  if (value.in_reply_to !== undefined) payload.in_reply_to = value.in_reply_to as string;
  // A record is one side of a client exchange, never both: the writer and the addressee are
  // different principals, and a payload claiming both is not one this version writes. The two
  // maps have exactly the same strict shape.
  if (value.from_client !== undefined && value.to_client !== undefined) return null;
  if (brief) {
    payload.brief_sha256 = value.brief_sha256 as string;
    payload.incarnation = value.incarnation as string;
  }
  if (value.from_client !== undefined) {
    const fromClient = clientMapOf(value.from_client);
    if (fromClient === null) return null;
    // The only principal shape a client record has: the client address and no agent id. A
    // payload with `from: owner` or a non-null `from_id` beside `from_client` is not one this
    // version writes, and is refused whole rather than read as a client record.
    if (payload.from !== `client:${fromClient.client_id}` || payload.from_id !== null) return null;
    payload.from_client = fromClient;
  }
  if (value.to_client !== undefined) {
    const toClient = clientMapOf(value.to_client);
    if (toClient === null) return null;
    // A reply onto a client thread is always addressed to the client address with no seat id.
    if (payload.to !== `client:${toClient.client_id}` || payload.to_id !== null) return null;
    payload.to_client = toClient;
  }
  return payload;
}

/** The `{client_id, grant_id}` map a client record carries, or null when it is not exactly one. */
function clientMapOf(value: unknown): { client_id: string; grant_id: string } | null {
  if (!isRecordValue(value)) return null;
  if (typeof value.client_id !== 'string' || !nonEmpty(value.client_id)) return null;
  if (typeof value.grant_id !== 'string' || !nonEmpty(value.grant_id)) return null;
  if (Object.keys(value).some((key) => key !== 'client_id' && key !== 'grant_id')) return null;
  return { client_id: value.client_id, grant_id: value.grant_id };
}

/** The whole signed envelope: `{payload, signature}` and nothing else. */
export function signedRecordOf(value: unknown): SignedRecord | null {
  if (!isRecordValue(value)) return null;
  if (!nonEmpty(value.signature)) return null;
  const payload = recordPayloadOf(value.payload);
  if (payload === null) return null;
  return { payload, signature: value.signature };
}

/** The receipt payload, or null when the value is not one this version writes. */
export function receiptPayloadOf(value: unknown): ReceiptPayload | null {
  if (!isRecordValue(value)) return null;
  if (value.kind !== 'receipt') return null;
  if (typeof value.status !== 'string' || !RECEIPT_STATUSES.includes(value.status as ReceiptStatus)) return null;
  for (const field of ['id', 'to', 'root', 'session', 'at'] as const) {
    if (!nonEmpty(value[field])) return null;
  }
  if (!Number.isFinite(Date.parse(value.at as string))) return null;
  // A brief read's binding is all three fields or none: the receipt the inbox writes for a brief
  // carries them, and no ordinary receipt does.
  const hasBrief = value.brief_sha256 !== undefined || value.incarnation !== undefined || value.brief_epoch !== undefined;
  if (hasBrief) {
    if (typeof value.brief_sha256 !== 'string' || !BRIEF_SHA256.test(value.brief_sha256)) return null;
    if (!isBriefIncarnation(value.incarnation)) return null;
    if (!isBriefEpoch(value.brief_epoch)) return null;
  }
  if (value.brief_seat_handle !== undefined && !nonEmpty(value.brief_seat_handle)) return null;
  if (value.brief_pane_root_pid !== undefined
    && (typeof value.brief_pane_root_pid !== 'number' || !Number.isInteger(value.brief_pane_root_pid) || value.brief_pane_root_pid <= 0)) {
    return null;
  }
  // The taker an unread record was read by, when no reader did: the socket delivery's own read.
  // The field is signed with the payload, so it is carried into the reconstructed payload — a
  // receipt whose `read_by` was dropped or rewritten stops verifying.
  if (value.read_by !== undefined && !nonEmpty(value.read_by)) return null;
  const payload: ReceiptPayload = {
    kind: 'receipt',
    status: value.status as ReceiptStatus,
    id: value.id as string,
    to: value.to as string,
    root: value.root as string,
    session: value.session as string,
    at: value.at as string,
  };
  if (hasBrief) {
    payload.brief_sha256 = value.brief_sha256 as string;
    payload.incarnation = value.incarnation as string;
    payload.brief_epoch = value.brief_epoch as string;
  }
  if (value.brief_seat_handle !== undefined) payload.brief_seat_handle = value.brief_seat_handle as string;
  if (value.brief_pane_root_pid !== undefined) payload.brief_pane_root_pid = value.brief_pane_root_pid as number;
  if (value.read_by !== undefined) payload.read_by = value.read_by as string;
  return payload;
}

export function signedReceiptOf(value: unknown): SignedReceipt | null {
  if (!isRecordValue(value)) return null;
  if (!nonEmpty(value.signature)) return null;
  const payload = receiptPayloadOf(value.payload);
  if (payload === null) return null;
  return { payload, signature: value.signature };
}

/** The close payload, or null when the value is not one this version writes. */
export function closePayloadOf(value: unknown): ClosePayload | null {
  if (!isRecordValue(value)) return null;
  if (value.kind !== CLOSE_KIND) return null;
  for (const field of ['id', 'thread', 'by', 'root', 'session', 'at'] as const) {
    if (!nonEmpty(value[field])) return null;
  }
  if (!recordNameOk(value.id as string) || !recordNameOk(value.thread as string)) return null;
  if (!Number.isFinite(Date.parse(value.at as string))) return null;
  return {
    kind: CLOSE_KIND,
    id: value.id as string,
    thread: value.thread as string,
    by: value.by as string,
    root: value.root as string,
    session: value.session as string,
    at: value.at as string,
  };
}

export function signedCloseOf(value: unknown): SignedClose | null {
  if (!isRecordValue(value)) return null;
  if (!nonEmpty(value.signature)) return null;
  const payload = closePayloadOf(value.payload);
  if (payload === null) return null;
  return { payload, signature: value.signature };
}

/** The record's path: the folder `team send` writes to, and the id as the file's name. */
export function recordFile(dropDir: string, id: string): string {
  return join(dropDir, id);
}

/** A receipt's path beside its message: `<id>.<status>.json`. */
export function receiptFile(dropDir: string, id: string, status: ReceiptStatus): string {
  return join(dropDir, `${id}.${status}.json`);
}

/** A close's path beside the record it answers: `<id>.closed.json`. */
export function closeFile(dropDir: string, id: string): string {
  return join(dropDir, `${id}.closed.json`);
}

/** Signs a payload with the checkout's message key. The key is created on the first sign. */
export function signRecord(payload: RecordPayload, home: string): SignedRecord {
  const key = messageKeyOf(home);
  return { payload, signature: signDomain(MESSAGE_DOMAIN, payload as unknown as Json, key) };
}

export function verifyRecord(record: SignedRecord, key: KeyObject): boolean {
  return verifyDomain(MESSAGE_DOMAIN, record.payload as unknown as Json, record.signature, key);
}

export function signReceiptPayload(payload: ReceiptPayload, home: string): SignedReceipt {
  const key = messageKeyOf(home);
  return { payload, signature: signDomain(RECEIPT_DOMAIN, payload as unknown as Json, key) };
}

export function verifyReceipt(receipt: SignedReceipt, key: KeyObject): boolean {
  return verifyDomain(RECEIPT_DOMAIN, receipt.payload as unknown as Json, receipt.signature, key);
}

/** Signs a close with the checkout's message key, under the receipt domain: a close is derived
 *  state beside a message, not a message. */
export function signClose(payload: ClosePayload, home: string): SignedClose {
  const key = messageKeyOf(home);
  return { payload, signature: signDomain(RECEIPT_DOMAIN, payload as unknown as Json, key) };
}

export function verifyClose(close: SignedClose, key: KeyObject): boolean {
  return verifyDomain(RECEIPT_DOMAIN, close.payload as unknown as Json, close.signature, key);
}

export type RecordWrite = { ok: true; path: string; existing?: true } | { ok: false; reason: string };

/**
 * Writes the record whole — a temporary file at mode 0600 in the record's own folder, renamed
 * onto the id's name — and never replaces a file already at that name: an id names one record,
 * and a second write is the receiver's duplicate to drop, not the sender's to overwrite.
 */
export function writeRecord(dropDir: string, record: SignedRecord): RecordWrite {
  const id = record.payload.id;
  if (!recordNameOk(id)) return { ok: false, reason: 'the record id cannot be a file name' };
  const path = recordFile(dropDir, id);
  if (heldAt(path).kind !== 'missing') return { ok: false, reason: 'a record already holds that id' };
  try {
    dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    return { ok: false, reason: 'the record could not be written' };
  }
  return { ok: true, path };
}

/**
 * Writes the record unless its id already names a record in this folder; a record already there
 * is the message the id names and is left untouched. Any other file at that name is a refusal:
 * the id would name two different things.
 */
export function ensureRecord(dropDir: string, record: SignedRecord): RecordWrite {
  const path = recordFile(dropDir, record.payload.id);
  const held = heldAt(path);
  if (held.kind === 'missing') return writeRecord(dropDir, record);
  if (held.kind !== 'file') return { ok: false, reason: 'a file that is not a record already holds that id' };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: 'a file that is not a record already holds that id' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'a file that is not a record already holds that id' };
  }
  const found = signedRecordOf(parsed);
  if (found === null || found.payload.id !== record.payload.id) {
    return { ok: false, reason: 'a file that is not a record already holds that id' };
  }
  return { ok: true, path, existing: true };
}

export type RecordRead = { ok: true; record: SignedRecord | null } | { ok: false; reason: string };

/**
 * Writes the record whole, replacing a regular file already at its name. This is the writer for
 * a record whose name is derived from its content (the general seat brief): a file there that is
 * not that record would otherwise keep the seat from ever receiving it. A name held by a link, a
 * folder or a FIFO is refused and never replaced — writing there would either follow it or take a
 * name this key does not own.
 */
export function writeRecordOver(dropDir: string, record: SignedRecord): RecordWrite {
  const id = record.payload.id;
  if (!recordNameOk(id)) return { ok: false, reason: 'the record id cannot be a file name' };
  const path = recordFile(dropDir, id);
  const held = heldAt(path);
  if (held.kind === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
  if (held.kind === 'fifo') return { ok: false, reason: 'a FIFO was found and not followed' };
  if (held.kind === 'folder') return { ok: false, reason: 'the record path is a folder' };
  if (held.kind === 'other') return { ok: false, reason: 'the record path is not a regular file' };
  try {
    dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    return { ok: false, reason: 'the record could not be written' };
  }
  return { ok: true, path };
}

/**
 * Whether the record at `path` is the one `expected` names: every field but `at` is the same —
 * `at` is the record's own time, so a re-run at a later clock leaves a delivered record as it
 * is — the checkout folders resolve to one, and this checkout's message key signed it. A link,
 * a folder or another user's file is not a record and never verifies. `body: false` leaves the
 * body out of the comparison: a seat the launch replaced receives the brief with a handover
 * sentence the reader of the claim cannot know, so the delivered body is pinned by the claim's
 * id instead — the id hashes exactly the text that was written. `to_id: false` leaves the
 * registry's id out: a record delivered before the seat's agent was registered is still that
 * seat's brief after the launch registers it, and the signature is what proves who wrote it.
 */
export function recordHolds(path: string, expected: RecordPayload, home: string, options?: { body?: false; to_id?: false }): boolean {
  const key = messageKeyState(home);
  if (key.kind !== 'key') return false;
  const read = readRecord(path, expected.id);
  if (!read.ok || read.record === null) return false;
  const held = read.record.payload;
  const fields = ['kind', 'id', 'to', 'to_id', 'session', 'body', 'from', 'from_id', 'rule', 'thread', 'in_reply_to', 'brief_sha256', 'incarnation'] as const;
  for (const field of fields) {
    if (field === 'body' && options?.body === false) continue;
    if (field === 'to_id' && options?.to_id === false) continue;
    if (held[field] !== expected[field]) return false;
  }
  if (JSON.stringify(held.from_client) !== JSON.stringify(expected.from_client)) return false;
  if (JSON.stringify(held.to_client) !== JSON.stringify(expected.to_client)) return false;
  if (!sameFolder(held.root, expected.root)) return false;
  return verifyRecord(read.record, key.key);
}

/** One record by path, or why it cannot be read. A missing file is `record: null`. */
export function readRecord(path: string, expectedId?: string): RecordRead {
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: true, record: null };
  if (held.kind === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
  if (held.kind === 'fifo') return { ok: false, reason: 'a FIFO was found and not followed' };
  if (held.kind !== 'file') return { ok: false, reason: 'the record is not a regular file' };
  if (process.getuid !== undefined && held.uid !== process.getuid()) return { ok: false, reason: "another user's file" };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: 'the record could not be read' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the record is not JSON' };
  }
  const record = signedRecordOf(parsed);
  if (record === null) return { ok: false, reason: 'the record is not one this version wrote' };
  if (expectedId !== undefined && record.payload.id !== expectedId) {
    return { ok: false, reason: `the record's id is ${record.payload.id}, not ${expectedId}` };
  }
  return { ok: true, record };
}

export type StatusContext = { to: string; root: string; session: string };

/** Whether two folder paths name one folder once links are resolved; a path that cannot be
 *  resolved is compared as written. A receipt and the message it belongs to are written by
 *  different commands, so their `root` strings need not be spelled the same way. The same rule
 *  binds a delivery record to the checkout it was delivered for. */
export function sameFolder(left: string, right: string): boolean {
  const real = (at: string): string => {
    try {
      return realpathSync(at);
    } catch {
      return at;
    }
  };
  return real(left) === real(right);
}

export type CloseRead = { ok: true; close: SignedClose | null } | { ok: false; reason: string };

/** One close by path, or why it cannot be read. A missing file is `close: null`; the checks are
 *  `readRecord`'s, since a close is a JSON envelope signed by the message key. */
export function readClose(path: string, expectedId?: string): CloseRead {
  const held = heldAt(path);
  if (held.kind === 'missing') return { ok: true, close: null };
  if (held.kind === 'link') return { ok: false, reason: 'a symbolic link was found and not followed' };
  if (held.kind === 'fifo') return { ok: false, reason: 'a FIFO was found and not followed' };
  if (held.kind !== 'file') return { ok: false, reason: 'the close is not a regular file' };
  if (process.getuid !== undefined && held.uid !== process.getuid()) return { ok: false, reason: "another user's file" };
  const text = readNoFollow(path);
  if (text === null) return { ok: false, reason: 'the close could not be read' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the close is not JSON' };
  }
  const close = signedCloseOf(parsed);
  if (close === null) return { ok: false, reason: 'the close is not one this version wrote' };
  if (expectedId !== undefined && close.payload.id !== expectedId) {
    return { ok: false, reason: `the close's id is ${close.payload.id}, not ${expectedId}` };
  }
  return { ok: true, close };
}

/**
 * Whether the receipt at `path` is this message's `status` receipt: the id, seat, checkout and
 * session on it match, and the message key signed it. A receipt for another message or checkout
 * is not counted, and an unreadable one changes nothing. For a brief's read, `brief` names the
 * claim it must have been served under: the incarnation and delivered body's digest must be the
 * claim's, and so must the runtime epoch — the one field a brief receipt is compared on, so a
 * receipt written by a process started under the old claim does not count for the new one.
 */
export function receiptHolds(
  path: string,
  id: string,
  status: ReceiptStatus,
  context: StatusContext,
  key: KeyObject,
  brief?: BriefBinding,
): boolean {
  const held = heldAt(path);
  if (held.kind !== 'file') return false;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return false;
  const text = readNoFollow(path);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const receipt = signedReceiptOf(parsed);
  if (receipt === null) return false;
  const payload = receipt.payload;
  if (payload.id !== id || payload.status !== status) return false;
  if (payload.to !== context.to || payload.session !== context.session) return false;
  if (!sameFolder(payload.root, context.root)) return false;
  if (brief !== undefined) {
    if (payload.incarnation !== brief.incarnation) return false;
    if (payload.brief_sha256 !== brief.sha256) return false;
    if (payload.brief_epoch !== brief.epoch) return false;
  }
  return verifyReceipt(receipt, key);
}

/**
 * The message's status, derived from the receipts beside it and moving forward only: the highest
 * receipt that verifies stands, and no file present is `sent`. A status is never edited onto the
 * record itself. `brief` narrows a brief's receipt to the claim it was served under.
 */
export function statusOf(dropDir: string, id: string, context: StatusContext, key: KeyObject, brief?: BriefBinding): MessageStatus {
  let status: MessageStatus = 'sent';
  for (const candidate of RECEIPT_STATUSES) {
    if (receiptHolds(receiptFile(dropDir, id, candidate), id, candidate, context, key, brief)) status = candidate;
  }
  return status;
}

/**
 * Whether a message has been read: a signed `read` or `replied` receipt verifies for it. Statuses
 * move forward only, so a reply counts as the read that came before it. This is the one answer the
 * inbox, `team drops` and the watch give — a file at a receipt's name that the message key did not
 * sign, or one that names another message, seat, checkout or session, proves nothing.
 */
export function isRead(dropDir: string, id: string, context: StatusContext, key: KeyObject, brief?: BriefBinding): boolean {
  const status = statusOf(dropDir, id, context, key, brief);
  return status === 'read' || status === 'replied';
}

/**
 * Writes one status receipt beside its message. Receipts are write-once: a signed receipt that
 * verifies for this message and its context — id, status, seat, checkout and session, the same
 * test `receiptHolds` makes — is left as the read that happened first, and is never rewritten.
 * A regular file at the name that does not verify for this message proves nothing — unsigned,
 * unreadable, another message's, another seat's, session's or checkout's — so the signed receipt
 * replaces it; otherwise a planted or stale file could keep the status at `sent` forever. A name
 * held by a link, a folder or a FIFO is refused and never replaced: writing there would either
 * follow it or take a name this key does not own, and the inbox refuses the same path before it
 * calls here. Every status has its own name, so a later writer can never overwrite a receipt with
 * a lower status: a second reader of a message that was already read, or answered, adds nothing
 * and the derived status never moves backward. `brief` is passed only for a brief's read: the
 * receipt then counts only when it was written under the same claim, and a regular file at the
 * name that verifies for the message but not for this claim is refused rather than replaced —
 * the name is occupied by a read of another delivery, and only the rollout's recovery may move
 * past it.
 */
export function writeReceipt(dropDir: string, receipt: SignedReceipt, home: string, brief?: BriefBinding): RecordWrite {
  const id = receipt.payload.id;
  const status = receipt.payload.status;
  if (!recordNameOk(id)) return { ok: false, reason: 'the receipt id cannot be a file name' };
  const path = receiptFile(dropDir, id, status);
  const held = heldAt(path);
  if (held.kind !== 'missing' && held.kind !== 'file') {
    return { ok: false, reason: 'the receipt path is held by something that is not a file' };
  }
  if (receivedAt(path, receipt, home, brief)) return { ok: true, path, existing: true };
  if (brief !== undefined && held.kind === 'file') {
    return { ok: false, reason: 'the read receipt name is held by a file that does not verify for this brief' };
  }
  try {
    dropMessage(dropDir, `${id}.${status}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch {
    return { ok: false, reason: 'the receipt could not be written' };
  }
  return { ok: true, path };
}

/** Whether the file at a receipt's name already is the receipt about to be written: it verifies
 *  with this checkout's message key for this message, status, seat, checkout and session — and,
 *  for a brief, for this claim. A link is not a file and never verifies; a regular file naming
 *  anything else proves nothing for this receipt and is replaced, except where a brief's claim
 *  makes the name occupied. */
function receivedAt(path: string, receipt: SignedReceipt, home: string, brief?: BriefBinding): boolean {
  const key = messageKeyState(home);
  if (key.kind !== 'key') return false;
  const { id, status, to, root, session } = receipt.payload;
  return receiptHolds(path, id, status, { to, root, session }, key.key, brief);
}

/**
 * Writes a thread's close beside the record it answers. Also write-once: a close already at the
 * path is left untouched, and a second close is not a new fact — the first side that closed the
 * thread is the one that stands.
 */
export function writeClose(dropDir: string, close: SignedClose): RecordWrite {
  const id = close.payload.id;
  if (!recordNameOk(id)) return { ok: false, reason: 'the close id cannot be a file name' };
  const path = closeFile(dropDir, id);
  if (heldAt(path).kind !== 'missing') return { ok: true, path, existing: true };
  try {
    dropMessage(dropDir, `${id}.closed.json`, `${JSON.stringify(close, null, 2)}\n`);
  } catch {
    return { ok: false, reason: 'the close could not be written' };
  }
  return { ok: true, path };
}

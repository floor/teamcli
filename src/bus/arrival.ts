// The bus's verified record reads: a signed record is read through one rule before any event is
// appended on its word. The bus's nudge and publish operations use the arrival rule for one
// record the caller names; the reconcile pass uses the same rule for every record its walk finds,
// and the mailbox rule for the records a previous build wrote into `.agents/messages/<seat>`.
//
// A record is checked in this order: it is a regular file this user owns, reached through folders
// this checkout names (a linked file or ancestor is refused, not followed); its signature covers
// the payload as parsed; and its signed id, addressee, session and checkout answer the claim.
// Only then does the event carry anything, and every field it carries is the one the signature
// covered.
import type { KeyObject } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  readSealedRecord,
  recordAuthOfSealed,
  sameFolder,
  verifySealedReceipt,
  verifySealedRecord,
  type SealedRead,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';
import type { EventAppendInput } from './log.ts';
import { readSealedRelative } from './relative-read.ts';

/** One seat folder or record name: the names this pass and the bus's nudge both admit. */
export const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** What a caller says a record is: never a field the event repeats, only where to look. */
export type ArrivalClaim = { session: string; seat: string; record_id: string };

/** The one session and checkout a bus serves; a record bound to another is not its to raise. */
export type ArrivalScope = { root: string; session: string };

export type ArrivalRead =
  | { ok: true; event: EventAppendInput }
  | { ok: false; reason: string; missing?: true };

/** A mailbox message's signed fields, as far as its arrival needs them. */
export type MailboxRecordRead =
  | { ok: true; at: string | undefined; from: string | undefined }
  | { ok: false; reason: string; missing?: true };

/** A mailbox read receipt's signed time. */
export type MailboxReceiptRead =
  | { ok: true; at: string | undefined }
  | { ok: false; reason: string; missing?: true };

/** `dir` is the folder the root names, once links resolve. A linked ancestor could lead into
 *  another checkout, and the record it holds there is not this checkout's to raise. */
export function folderUnderRoot(dir: string, root: string, ...parts: string[]): boolean {
  try {
    return realpathSync(dir) === join(realpathSync(root), ...parts);
  } catch {
    return false;
  }
}

export function dropFolderIsReal(root: string, session: string, seat: string): boolean {
  return folderUnderRoot(join(root, '.agents', 'send-drops', session, seat), root, '.agents', 'send-drops', session, seat);
}

export function mailboxFolderIsReal(root: string, seat: string): boolean {
  return folderUnderRoot(join(root, '.agents', 'messages', seat), root, '.agents', 'messages', seat);
}

/** A missing file is named as such; every other refusal keeps the reader's own sentence. */
type Refused = { ok: false; reason: string; missing?: true };

function notReadable(read: SealedRead, what: string): Refused {
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: false, reason: `${what} is missing`, missing: true };
}

/**
 * One signed drop record, checked before its `message.arrived` exists. A record that is linked,
 * not signed by this checkout's message key, not a message this version reads, or addressed to
 * another id, seat, session or checkout raises nothing.
 */
function dropFromSealed(read: SealedRead, claim: ArrivalClaim, scope: ArrivalScope, key: KeyObject): ArrivalRead {
  if (!read.ok || read.sealed === null) return notReadable(read, 'the record');
  const auth = recordAuthOfSealed(read.sealed, key);
  if (auth.kind !== 'ok') {
    // A tampered or unsupported envelope is refused on its own ground; the signature over the
    // parsed payload is the first test in either case.
    return {
      ok: false,
      reason: auth.kind === 'unsupported' ? auth.reason : 'the record is not signed with this checkout\'s message key',
    };
  }
  const record = auth.value.payload;
  if (record.id !== claim.record_id) return { ok: false, reason: 'the signed record names another id' };
  if (record.to !== claim.seat || record.session !== claim.session) {
    return { ok: false, reason: 'the signed record is addressed to another seat or session' };
  }
  if (!sameFolder(record.root, scope.root)) {
    return { ok: false, reason: 'the signed record belongs to another checkout' };
  }
  return {
    ok: true,
    event: {
      ts: record.at,
      kind: 'message.arrived',
      session: claim.session,
      record_id: claim.record_id,
      from: record.from,
      to: record.to,
      ...(record.thread === undefined ? {} : { thread: record.thread }),
    },
  };
}

export function checkedDropRecord(
  path: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): ArrivalRead {
  return dropFromSealed(readSealedRecord(path), claim, scope, key);
}

/** The drop record opened from the checkout's folder chain. A link is not followed. */
export function checkedDropRelative(
  root: string,
  session: string,
  seat: string,
  name: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): ArrivalRead {
  return dropFromSealed(
    readSealedRelative(root, ['.agents', 'send-drops', session, seat], name),
    claim,
    scope,
    key,
  );
}

/**
 * One message in the mailbox a previous build wrote. Its records carry the older minimal payload
 * (`kind`, `id`, `to`, `root`, `session`, `at`, `body`, `from`), so the rule here is the signed
 * envelope and the addressing, not this version's projection; the event is still built only from
 * the fields the signature covered.
 */
function mailboxFromSealed(read: SealedRead, claim: ArrivalClaim, scope: ArrivalScope, key: KeyObject): MailboxRecordRead {
  if (!read.ok || read.sealed === null) return notReadable(read, 'the record');
  if (!verifySealedRecord(read.sealed, key)) {
    return { ok: false, reason: 'the record is not signed with this checkout\'s message key' };
  }
  const payload = read.sealed.payload;
  if (payload.kind !== 'message') return { ok: false, reason: 'the signed record is not a message' };
  if (payload.id !== claim.record_id) return { ok: false, reason: 'the signed record names another id' };
  if (payload.to !== claim.seat || payload.session !== claim.session) {
    return { ok: false, reason: 'the signed record is addressed to another seat or session' };
  }
  if (typeof payload.root !== 'string' || !sameFolder(payload.root, scope.root)) {
    return { ok: false, reason: 'the signed record belongs to another checkout' };
  }
  return {
    ok: true,
    at: typeof payload.at === 'string' && payload.at !== '' ? payload.at : undefined,
    from: typeof payload.from === 'string' && payload.from !== '' ? payload.from : undefined,
  };
}

export function checkedMailboxRecord(
  path: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): MailboxRecordRead {
  return mailboxFromSealed(readSealedRecord(path), claim, scope, key);
}

/** The mailbox record opened from the checkout's folder chain. A link is not followed. */
export function checkedMailboxRelative(
  root: string,
  seat: string,
  name: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): MailboxRecordRead {
  return mailboxFromSealed(readSealedRelative(root, ['.agents', 'messages', seat], name), claim, scope, key);
}

/** One read receipt beside a mailbox message. The older receipt carries no status; the envelope,
 *  signature and addressing are the rule either shape answers to. */
function receiptFromSealed(read: SealedRead, claim: ArrivalClaim, scope: ArrivalScope, key: KeyObject): MailboxReceiptRead {
  if (!read.ok || read.sealed === null) return notReadable(read, 'the receipt');
  if (!verifySealedReceipt(read.sealed, key)) {
    return { ok: false, reason: 'the receipt is not signed with this checkout\'s message key' };
  }
  const payload = read.sealed.payload;
  if (payload.kind !== 'receipt') return { ok: false, reason: 'the signed record is not a receipt' };
  if (payload.id !== claim.record_id) return { ok: false, reason: 'the signed receipt names another id' };
  if (payload.to !== claim.seat || payload.session !== claim.session) {
    return { ok: false, reason: 'the signed receipt is addressed to another seat or session' };
  }
  if (typeof payload.root !== 'string' || !sameFolder(payload.root, scope.root)) {
    return { ok: false, reason: 'the signed receipt belongs to another checkout' };
  }
  return { ok: true, at: typeof payload.at === 'string' && payload.at !== '' ? payload.at : undefined };
}

export function checkedMailboxReceipt(
  path: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): MailboxReceiptRead {
  return receiptFromSealed(readSealedRecord(path), claim, scope, key);
}

/** The mailbox receipt opened from the checkout's folder chain. A link is not followed. */
export function checkedMailboxReceiptRelative(
  root: string,
  seat: string,
  name: string,
  claim: ArrivalClaim,
  scope: ArrivalScope,
  key: KeyObject,
): MailboxReceiptRead {
  return receiptFromSealed(readSealedRelative(root, ['.agents', 'messages', seat], name), claim, scope, key);
}

/**
 * The arrival a nudge, or a published `message.arrived`, may raise: built only after the bus has
 * read and verified the signed record the claim names. The claim carries no field the event
 * repeats, and the bus resolves the drop folder itself, so a caller can neither point at another
 * seat's record nor invent a sender: what the event says is what the signed file says. A record
 * that is missing, not a message, or not addressed to this seat, session and root raises nothing.
 */
export function verifiedArrival(claim: ArrivalClaim, scope: ArrivalScope, home: string): EventAppendInput | null {
  // The names become one path; the folder rule every record name obeys is the same here.
  if (!RECORD_NAME.test(claim.session) || !RECORD_NAME.test(claim.seat) || !RECORD_NAME.test(claim.record_id)) {
    return null;
  }
  // This bus scans one session's drop folders; a session it does not serve is not its record.
  if (claim.session !== scope.session) return null;
  const key = messageKeyState(home);
  if (key.kind !== 'key') return null;
  const checked = checkedDropRelative(scope.root, claim.session, claim.seat, claim.record_id, claim, scope, key.key);
  return checked.ok ? checked.event : null;
}

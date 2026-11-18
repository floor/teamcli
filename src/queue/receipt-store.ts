// The per-seat receipt store (rfc-event-comms §2, step E6).
//
// Receipts stay signed records; E6 writes them in shadow beside today's file receipts and the
// event log, which the readers still use. One file per receipt, created exclusively and never
// replaced, so concurrent writers cannot roll each other back:
//   .agents/receipts/<session>/<seat>/<generation>/<seq>.<kind>
// The binding: root, session, recipient seat, queue generation, seq and msg_id. A receipt copied
// to another seat, root, generation or seq fails its binding and is ignored.
//
// The actor matrix: each kind names the actors that may write it; any other actor is refused at
// write and ignored at read. Progress is derived, never stored as a number: the contiguous prefix
// is the largest seq such that every seq up to it has a verifying terminal receipt.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { createExclusive, ensureFolder, fsyncFolder, readFence, removeDurable, type DurableFaults } from './durable.ts';
import { renameSync } from '../host/guarded-fs.ts';
import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { queueBaseOf, verifiedQueuePlaceOf } from './append.ts';

export const QUEUE_RECEIPT_DOMAIN = 'team-queue-receipt-v1\n';

export type ReceiptActorKind = 'adapter' | 'recipient' | 'relay' | 'reply-op' | 'owner' | 'client' | 'lead' | 'daemon' | 'recovery';

export type QueueReceiptKind = 'offered' | 'transport-accepted' | 'read' | 'reshown' | 'cleared' | 'expired' | 'void' | 'corrupt' | `answered.${string}`;

const MATRIX: Record<string, readonly ReceiptActorKind[]> = {
  offered: ['adapter'],
  'transport-accepted': ['adapter'],
  read: ['recipient', 'relay'],
  reshown: ['recipient'],
  cleared: ['owner', 'client', 'lead'],
  expired: ['daemon'],
  void: ['recovery'],
  corrupt: ['recovery'],
  answered: ['reply-op'],
};

/** The kinds that settle a seq (advance the prefix). `cleared` settles but is never a read. */
const TERMINAL = new Set(['read', 'cleared', 'expired', 'void', 'corrupt', 'answered']);

const OP_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATION = /^g[0-9a-f]{16}$/;

function family(kind: string): string | null {
  if (kind.startsWith('answered.')) return OP_KEY.test(kind.slice('answered.'.length)) ? 'answered' : null;
  return Object.hasOwn(MATRIX, kind) ? kind : null;
}

/** Whether `actor` may write a receipt of `kind`. */
export function actorMay(kind: string, actor: ReceiptActorKind): boolean {
  const name = family(kind);
  return name !== null && (MATRIX[name] ?? []).includes(actor);
}

export type QueueReceiptBinding = { root: string; session: string; seat: string; generation: string; seq: number; msg_id: string };

export type QueueReceiptPayload = QueueReceiptBinding & {
  v: 1;
  kind: 'queue-receipt';
  receipt: string;
  actor: { kind: ReceiptActorKind; name: string };
  at: string;
};

export function receiptFolder(binding: Pick<QueueReceiptBinding, 'root' | 'session' | 'seat' | 'generation'>): string {
  return join(binding.root, '.agents', 'receipts', binding.session, binding.seat, binding.generation);
}

function fileName(seq: number, kind: string): string {
  return `${String(seq).padStart(12, '0')}.${kind}`;
}

export type WriteReceiptOutcome = 'written' | 'exists' | 'refused' | 'failed';

/**
 * Writes one receipt, exclusively and durably. `refused`: the actor matrix or the binding forbids
 * it, and nothing was written. `exists`: a receipt of that kind for that seq already stands.
 */
export function writeQueueReceipt(
  binding: QueueReceiptBinding,
  kind: QueueReceiptKind,
  actor: { kind: ReceiptActorKind; name: string },
  home: string,
  options: { now?: () => Date; faults?: DurableFaults } = {},
): WriteReceiptOutcome {
  if (!actorMay(kind, actor.kind)) return 'refused';
  if (!NAME.test(binding.session) || !NAME.test(binding.seat) || !NAME.test(binding.msg_id)) return 'refused';
  if (!GENERATION.test(binding.generation) || !Number.isSafeInteger(binding.seq) || binding.seq < 1) return 'refused';
  const payload: QueueReceiptPayload = {
    v: 1,
    kind: 'queue-receipt',
    root: binding.root,
    session: binding.session,
    seat: binding.seat,
    generation: binding.generation,
    seq: binding.seq,
    msg_id: binding.msg_id,
    receipt: kind,
    actor,
    at: (options.now?.() ?? new Date()).toISOString(),
  };
  let signature: string;
  try {
    signature = signDomain(QUEUE_RECEIPT_DOMAIN, payload as unknown as Json, messageKeyOf(home));
  } catch {
    return 'failed';
  }
  const outcome = createExclusive(join(receiptFolder(binding), fileName(binding.seq, kind)), `${JSON.stringify({ payload, signature })}\n`, options.faults);
  return outcome === 'created' ? 'written' : outcome;
}

export type VerifiedReceipt = { seq: number; kind: string; msg_id: string; actor: ReceiptActorKind };

/**
 * The verifying receipts of one seat generation. A file that does not verify, is bound elsewhere,
 * or names an actor the matrix refuses for its kind is ignored. `null` when the folder or the key
 * cannot be read (unknown, never "none").
 */
export function readQueueReceipts(
  binding: Pick<QueueReceiptBinding, 'root' | 'session' | 'seat' | 'generation'>,
  home: string,
  /** The committed entry's msg_id at a seq (`entryMsgIdAt`): a receipt whose msg_id differs from
   *  its seq's committed entry, or whose seq holds none, is ignored and never counted. */
  entryAt: (seq: number) => string | null,
): VerifiedReceipt[] | null {
  const key = messageKeyState(home);
  if (key.kind !== 'key') return null;
  const folder = receiptFolder(binding);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const out: VerifiedReceipt[] = [];
  for (const name of names) {
    const match = /^(\d{12})\.(.+)$/.exec(name);
    if (!match) continue;
    const text = readFence(join(folder, name));
    if (text === null || text === '') continue;
    let record: { payload?: QueueReceiptPayload; signature?: unknown };
    try {
      record = JSON.parse(text) as typeof record;
    } catch {
      continue;
    }
    const payload = record.payload;
    if (!payload || typeof record.signature !== 'string' || payload.kind !== 'queue-receipt' || payload.v !== 1) continue;
    const seq = Number(match[1]);
    if (payload.seq !== seq || payload.receipt !== match[2]) continue;
    if (payload.root !== binding.root || payload.session !== binding.session || payload.seat !== binding.seat || payload.generation !== binding.generation) continue;
    if (!actorMay(payload.receipt, payload.actor?.kind)) continue;
    if (!verifyDomain(QUEUE_RECEIPT_DOMAIN, payload as unknown as Json, record.signature, key.key)) continue;
    if (entryAt(seq) !== payload.msg_id) continue;
    out.push({ seq, kind: payload.receipt, msg_id: payload.msg_id, actor: payload.actor.kind });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The contiguous prefix and the sparse completions above it, derived from verifying receipts. */
export function derivedProgress(receipts: VerifiedReceipt[]): { prefix: number; sparse: number[] } {
  const settled = new Set<number>();
  for (const receipt of receipts) {
    const name = family(receipt.kind);
    if (name !== null && TERMINAL.has(name)) settled.add(receipt.seq);
  }
  let prefix = 0;
  while (settled.has(prefix + 1)) prefix += 1;
  const sparse = [...settled].filter(seq => seq > prefix).sort((a, b) => a - b);
  return { prefix, sparse };
}

/**
 * The E6 dual write: once a legacy receipt is durable, the same decision is written to the
 * per-seat store, bound to the message's queue place. Shadow only: no reader uses the store yet,
 * and a message with no queue place, or any fault, changes nothing about the legacy receipt.
 */
export function shadowQueueReceipt(input: {
  dropDir: string;
  root: string;
  session: string;
  seat: string;
  msgId: string;
  kind: QueueReceiptKind;
  actor: { kind: ReceiptActorKind; name: string };
  home: string;
  /** Fault seam: runs before the reuse path's folder flush (a throw is a failed flush). */
  faults?: { reuseFlush?: () => void };
}): WriteReceiptOutcome | 'unplaced' | 'pending' {
  try {
    const written = placeAndWrite(input);
    if (written !== 'unplaced') return written;
    // The placement cannot be proved right now: the queue lock is held, the journal is not yet
    // proved durable, or the record is published but not yet indexed (the append's record-to-index
    // window). The decision is never skipped: a signed, durable pending marker keyed by the record
    // id records it, and the next holder of the lock (or the reconcile pass) drains it once the
    // entry is placed, writing the receipt exactly once (`drainPendingReceipts`). A seat with no
    // queue at all has nothing to dual-write to.
    if (pendingFolder(input.dropDir) === null || !queueExists(input.dropDir)) return 'unplaced';
    return writePending(input) ? 'pending' : 'failed';
  } catch {
    return 'failed';
  }
}

type PendingInput = Parameters<typeof shadowQueueReceipt>[0];

function placeAndWrite(input: PendingInput): WriteReceiptOutcome | 'unplaced' {
  // Only a proved placement is signed: a committed, verifying entry holding this msg_id.
  const place = verifiedQueuePlaceOf(input.dropDir, input.msgId, { root: input.root, session: input.session, seat: input.seat }, input.home);
  if (place === null) return 'unplaced';
  return writeQueueReceipt(
    { root: input.root, session: input.session, seat: input.seat, generation: place.generation, seq: place.seq, msg_id: input.msgId },
    input.kind,
    input.actor,
    input.home,
  );
}

const PENDING = 'pending-receipts';
const PENDING_NAME = /^\d{13}\.[0-9a-f]{12}\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

function pendingFolder(dropDir: string): string | null {
  const base = queueBaseOf(dropDir);
  return base === null ? null : join(base, PENDING);
}

export const QUEUE_PENDING_DOMAIN = 'team-queue-pending-v1\n';

type PendingPayload = {
  v: 1;
  kind: 'queue-pending';
  root: string;
  session: string;
  seat: string;
  msg_id: string;
  receipt: QueueReceiptKind;
  actor: { kind: ReceiptActorKind; name: string };
};

function queueExists(dropDir: string): boolean {
  const base = queueBaseOf(dropDir);
  if (base === null) return false;
  try {
    return lstatSync(base).isDirectory();
  } catch {
    return false;
  }
}

/** The pending decision, signed with the home's message key (the same key a receipt is signed
 *  with) and bound to the recipient, message, kind and actor. Nothing unsigned is ever replayed. */
function writePending(input: PendingInput): boolean {
  const folder = pendingFolder(input.dropDir);
  if (folder === null || !NAME.test(input.msgId) || !NAME.test(input.session) || !NAME.test(input.seat)) return false;
  if (!actorMay(input.kind, input.actor.kind)) return false;
  // One marker per decision: a second contention finds the same decision standing. The check reads
  // each marker's verified signed content (record id, kind and actor, signed with this home's
  // key), never its file name, so an unverifiable file can never stand in for a real decision.
  const key = messageKeyState(input.home);
  // E7b (R6 parity gate): an unlistable pending folder dedupes against nothing and the exclusive
  // write is still tried, exactly as E6 did (a folder can deny enumeration and permit creation).
  // The strict listing (null is never empty) stays in the completeness check (`pendingMarkers`).
  const standingNames = listPending(folder) ?? [];
  if (key.kind === 'key' && standingNames.some((name) => {
    const text = readFence(join(folder, name));
    const standing = text === null ? null : verifiedPending(text, name, key.key);
    return standing !== null && standing.msg_id === input.msgId && standing.receipt === input.kind
      && standing.actor.kind === input.actor.kind && standing.actor.name === input.actor.name
      && standing.root === input.root && standing.session === input.session && standing.seat === input.seat;
  })) {
    // A matching marker proves the decision stands, not that it is durable: its creator may be
    // between link and folder fsync, or its fsync may have failed. Re-flush the folder now; only a
    // flush that succeeds lets this call report the decision as durably pending (E7 gate 1).
    try {
      input.faults?.reuseFlush?.();
      fsyncFolder(folder);
      return true;
    } catch {
      return false;
    }
  }
  const payload: PendingPayload = {
    v: 1, kind: 'queue-pending', root: input.root, session: input.session, seat: input.seat,
    msg_id: input.msgId, receipt: input.kind, actor: input.actor,
  };
  let signature: string;
  try {
    signature = signDomain(QUEUE_PENDING_DOMAIN, payload as unknown as Json, messageKeyOf(input.home));
  } catch {
    return false;
  }
  // A fresh name (time, then a random nonce): only this call's own exclusive create counts. A name
  // that already stood (`exists`) proves nothing about this decision, so it is not success.
  const name = `${String(Date.now()).padStart(13, '0')}.${randomBytes(6).toString('hex')}.${input.msgId}.${input.kind}.json`;
  return createExclusive(join(folder, name), `${JSON.stringify({ payload, signature })}\n`) === 'created';
}

/** The pending markers, oldest first. `null` when the folder cannot be listed: an unreadable
 *  folder is never read as an empty one (absent is the only empty). */
function listPending(folder: string): string[] | null {
  try {
    return readdirSync(folder).filter(name => PENDING_NAME.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return null;
  }
}

/** How many pending markers stand, read-only; null when the folder cannot be listed. */
export function pendingMarkers(dropDir: string): number | null {
  const folder = pendingFolder(dropDir);
  if (folder === null) return 0;
  const names = listPending(folder);
  return names === null ? null : names.length;
}

/** Every quarantined marker, or `null` when the quarantine cannot be listed. */
export function quarantinedPending(dropDir: string): string[] | null {
  const folder = pendingFolder(dropDir);
  if (folder === null) return [];
  try {
    return readdirSync(join(folder, QUARANTINE)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return null;
  }
}

/**
 * Drains a seat's pending dual writes in order (oldest first). Each marker is retried: a proved
 * placement writes the receipt (one file per receipt, never replaced, so a repeat finds it and
 * answers `exists`), then the marker is removed durably. A marker whose placement still cannot be
 * proved, or whose write or removal fails, stays for the next pass. Called with no queue lock held.
 */
export function drainPendingReceipts(dropDir: string, home: string, log?: (line: string) => void): { written: number; left: number; dropped: number } {
  const { unknown, ...counts } = drainPendingReceiptsChecked(dropDir, home, log);
  // E6's shape and behaviour exactly (E7a changes nothing live); an unlistable folder reads as
  // nothing drained here, and only the E7 completeness check asks for `unknown`.
  void unknown;
  return counts;
}

/** The drain, saying whether the pending folder could be listed at all (E7 completeness): a failed
 *  listing is `unknown: true`, never zero. */
export function drainPendingReceiptsChecked(dropDir: string, home: string, log?: (line: string) => void): { written: number; left: number; dropped: number; unknown: boolean } {
  const folder = pendingFolder(dropDir);
  if (folder === null) return { written: 0, left: 0, dropped: 0, unknown: false };
  const names = listPending(folder);
  // A listing that failed is unknown, never zero: completeness cannot be claimed from it.
  if (names === null) return { written: 0, left: 0, dropped: 0, unknown: true };
  const key = messageKeyState(home);
  if (key.kind !== 'key') return { written: 0, left: names.length, dropped: 0, unknown: false };
  let written = 0;
  let left = 0;
  let dropped = 0;
  for (const name of names) {
    try {
      const step = drainOne(folder, name, dropDir, home, key.key, log);
      if (step === 'written') written += 1;
      else if (step === 'dropped') dropped += 1;
      else if (step === 'left') left += 1;
    } catch (error) {
      // One marker never stops the drain: the rest of the seat's decisions still settle this pass.
      log?.(`queue: a pending receipt marker could not be drained (${name}: ${(error as Error).message})`);
      left += 1;
    }
  }
  return { written, left, dropped, unknown: false };
}

function drainOne(folder: string, name: string, dropDir: string, home: string, key: Parameters<typeof verifyDomain>[3], log?: (line: string) => void): 'written' | 'settled' | 'dropped' | 'left' {
  {
    const path = join(folder, name);
    const text = readFence(path);
    if (text === null) return 'left';
    const marker = verifiedPending(text, name, key);
    if (marker === null) {
      // A marker that does not parse or verify is never replayed. It is moved aside into the
      // quarantine folder (kept as evidence, out of the drain's way) and the drain moves on.
      if (quarantine(folder, name)) {
        log?.(`queue: quarantined a pending receipt marker that does not verify (${name})`);
        return 'dropped';
      }
      log?.(`queue: a pending receipt marker that does not verify could not be quarantined (${name})`);
      return 'left';
    }
    // An unindexed marker (the record-to-index window) stays until the entry is placed.
    const outcome = placeAndWrite({
      dropDir, root: marker.root, session: marker.session, seat: marker.seat, msgId: marker.msg_id,
      kind: marker.receipt, actor: marker.actor, home,
    });
    if ((outcome === 'written' || outcome === 'exists') && removeDurable(path) === 'removed') {
      return outcome === 'written' ? 'written' : 'settled';
    }
    return 'left';
  }
}

const QUARANTINE = 'quarantine';

/** Moves a marker that does not verify into `pending-receipts/quarantine/`, durably (both folders
 *  fsynced). False when it could not be moved; the marker then stays and is counted as left. */
function quarantine(folder: string, name: string): boolean {
  const aside = join(folder, QUARANTINE);
  if (!ensureFolder(aside)) return false;
  try {
    renameSync(join(folder, name), join(aside, name));
    fsyncFolder(aside);
    fsyncFolder(folder);
    return true;
  } catch {
    return false;
  }
}

function verifiedPending(text: string, name: string, key: Parameters<typeof verifyDomain>[3]): PendingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { payload?: PendingPayload; signature?: unknown };
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!payload || typeof record.signature !== 'string' || payload.kind !== 'queue-pending' || payload.v !== 1) return null;
  if (typeof payload.msg_id !== 'string' || typeof payload.receipt !== 'string' || typeof payload.actor?.kind !== 'string' || typeof payload.actor?.name !== 'string') return null;
  // The file name must name the same message and kind the signed payload does.
  if (!name.endsWith(`.${payload.msg_id}.${payload.receipt}.json`)) return null;
  if (!actorMay(payload.receipt, payload.actor.kind)) return null;
  if (!verifyDomain(QUEUE_PENDING_DOMAIN, payload as unknown as Json, record.signature, key)) return null;
  return payload;
}

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
import { createExclusive, readFence, removeDurable, type DurableFaults } from './durable.ts';
import { queueBaseOf, queuePlaceOf, verifiedQueuePlaceOf } from './append.ts';

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
}): WriteReceiptOutcome | 'unplaced' | 'pending' {
  try {
    const written = placeAndWrite(input);
    if (written !== 'unplaced') return written;
    // The id is indexed but its placement cannot be proved right now (the queue lock is held, or
    // the journal is not yet proved durable): the decision is never skipped. A durable pending
    // marker beside the queue records it, and the next holder of the lock (or the reconcile pass)
    // drains it in order, writing the receipt exactly once (`drainPendingReceipts`).
    if (queuePlaceOf(input.dropDir, input.msgId) === null) return 'unplaced';
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
const PENDING_NAME = /^\d{13}\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

function pendingFolder(dropDir: string): string | null {
  const base = queueBaseOf(dropDir);
  return base === null ? null : join(base, PENDING);
}

function writePending(input: PendingInput): boolean {
  const folder = pendingFolder(input.dropDir);
  if (folder === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.msgId)) return false;
  const marker = { msg_id: input.msgId, kind: input.kind, actor: input.actor, root: input.root, session: input.session, seat: input.seat };
  // One marker per (message, kind): a second contention for the same decision finds it standing.
  const existing = listPending(folder).find(name => name.slice(14) === `${input.msgId}.${input.kind}.json`);
  if (existing !== undefined) return true;
  const outcome = createExclusive(join(folder, `${String(Date.now()).padStart(13, '0')}.${input.msgId}.${input.kind}.json`), `${JSON.stringify(marker)}\n`);
  return outcome === 'created' || outcome === 'exists';
}

function listPending(folder: string): string[] {
  try {
    return readdirSync(folder).filter(name => PENDING_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Drains a seat's pending dual writes in order (oldest first). Each marker is retried: a proved
 * placement writes the receipt (one file per receipt, never replaced, so a repeat finds it and
 * answers `exists`), then the marker is removed durably. A marker whose placement still cannot be
 * proved, or whose write or removal fails, stays for the next pass. Called with no queue lock held.
 */
export function drainPendingReceipts(dropDir: string, home: string): { written: number; left: number } {
  const folder = pendingFolder(dropDir);
  if (folder === null) return { written: 0, left: 0 };
  let written = 0;
  let left = 0;
  for (const name of listPending(folder)) {
    const path = join(folder, name);
    const text = readFence(path);
    let marker: { msg_id?: unknown; kind?: unknown; actor?: { kind?: unknown; name?: unknown }; root?: unknown; session?: unknown; seat?: unknown } | null = null;
    try {
      marker = text === null || text === '' ? null : JSON.parse(text);
    } catch {
      marker = null;
    }
    if (marker === null || typeof marker.msg_id !== 'string' || typeof marker.kind !== 'string' || typeof marker.root !== 'string'
      || typeof marker.session !== 'string' || typeof marker.seat !== 'string' || typeof marker.actor?.kind !== 'string' || typeof marker.actor?.name !== 'string') {
      left += 1;
      continue;
    }
    const outcome = placeAndWrite({
      dropDir, root: marker.root, session: marker.session, seat: marker.seat, msgId: marker.msg_id,
      kind: marker.kind as QueueReceiptKind, actor: { kind: marker.actor.kind as ReceiptActorKind, name: marker.actor.name }, home,
    });
    if ((outcome === 'written' || outcome === 'exists') && removeDurable(path) === 'removed') {
      if (outcome === 'written') written += 1;
      continue;
    }
    left += 1;
  }
  return { written, left };
}

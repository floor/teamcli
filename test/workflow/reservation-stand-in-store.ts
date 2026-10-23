// A stand-in for the store lane's reservation surface, written from the settled contract
// (builder-1's answers: one store-wide synchronous transaction, holds in the index with the
// reasons in the order item-key, run-live, terminal, hold-live, receiver-busy, expired pending
// holds non-blocking, holders never sweepable). It is STAND-IN evidence for the adapter lane
// only: it proves which decisions `src/workflow/reservation` makes and which calls it passes
// through, never that the real store behaves this way. Real-store evidence waits for the
// committed store head and is kept in the reservation race suite beside this file.
//
// The key encoding here mirrors the settled rule (percent-encode each segment, join with '.')
// solely so the stand-in can address entries; the real key formatter is the store's own.

import type {
  ConvertHoldInput,
  ConvertHoldResult,
  HoldRecord,
  IndexEntry,
  ItemIdentity,
  ReleaseHoldResult,
  RenewHoldResult,
  ReservationStore,
  ReservationTx,
  TryHoldInput,
  TryHoldResult,
} from '../../src/workflow/reservation/index.ts';

const PLAIN = /^[A-Za-z0-9_-]$/;

function encodeSegment(segment: string): string {
  let out = '';
  for (const char of segment) {
    if (PLAIN.test(char)) {
      out += char;
    } else {
      for (const byte of new TextEncoder().encode(char)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** The stand-in's key formatter: four non-empty segments, each percent-encoded, joined by '.'. */
export function standInKeyText(item: ItemIdentity): string | null {
  const parts = [item.source, item.project, item.team, item.id];
  if (parts.some((part) => part.length === 0)) return null;
  return parts.map(encodeSegment).join('.');
}

/** A hold blocks while it is a holder, while it has no deadline, or until its deadline passes.
 *  An unreadable deadline counts as past; the deadline instant itself is past. */
function live(hold: HoldRecord, now: number): boolean {
  if (hold.phase === 'holder') return true;
  if (hold.expiresAt === undefined) return true;
  const until = Date.parse(hold.expiresAt);
  return Number.isFinite(until) && until > now;
}

export type StandInCall = {
  op: 'tryHold' | 'convertHold' | 'releaseHold' | 'renewHold';
  input: unknown;
};

/** An in-memory index with the store's hold rules, and a log of every transaction call. */
export class StandInStore implements ReservationStore {
  readonly index = new Map<string, IndexEntry>();
  readonly calls: StandInCall[] = [];
  /** A scene can make the lock-free read return nothing, as an out-of-date snapshot would. */
  staleReads = false;
  transactions = 0;

  keyText(item: ItemIdentity): string | null {
    return standInKeyText(item);
  }

  entry(keyText: string): IndexEntry | null {
    if (this.staleReads) return null;
    return this.index.get(keyText) ?? null;
  }

  transact<T>(work: (tx: ReservationTx) => T): T {
    this.transactions += 1;
    return work(this.tx());
  }

  /** Seeds one item slot, creating it when it does not exist. */
  seed(item: ItemIdentity, patch: Partial<IndexEntry> = {}): string {
    const key = standInKeyText(item);
    if (key === null) throw new Error('the seed item is unkeyable');
    const entry = this.index.get(key) ?? { item, key, lastGeneration: 0 };
    this.index.set(key, { ...entry, ...patch });
    return key;
  }

  /** The transaction's view: `items()` hands out the live slots and a release clears the hold
   *  in place, exactly as the store lane's own transaction does (builder-2's combined run caught
   *  a sweep that read a hold a second time after releasing it). A stand-in that replaced the
   *  slot would hide that class of bug, so it does not. */
  private tx(): ReservationTx {
    return {
      entry: (keyText) => this.index.get(keyText) ?? null,
      items: () => [...this.index.values()],
      tryHold: (input) => this.tryHold(input),
      convertHold: (input) => this.convertHold(input),
      releaseHold: (input) => this.releaseHold(input),
      renewHold: (input) => this.renewHold(input),
    };
  }

  private tryHold(input: TryHoldInput): TryHoldResult {
    this.calls.push({ op: 'tryHold', input });
    const key = standInKeyText(input.item);
    if (key === null) return { ok: false, reason: 'item-key' };
    const now = Date.parse(input.at);
    const entry = this.index.get(key);
    if (entry?.live !== undefined) return { ok: false, reason: 'run-live', run: entry.live };
    if (entry?.terminal !== undefined && entry.reopened === undefined) {
      return { ok: false, reason: 'terminal', run: entry.terminal.run, item: key };
    }
    if (entry?.hold !== undefined && live(entry.hold, now)) return { ok: false, reason: 'hold-live', hold: entry.hold };
    for (const [otherKey, other] of this.index) {
      if (otherKey === key || other.hold === undefined) continue;
      if (other.hold.seat !== input.seat || !live(other.hold, now)) continue;
      return { ok: false, reason: 'receiver-busy', hold: other.hold, item: otherKey };
    }
    const hold: HoldRecord = {
      kind: input.kind,
      item: key,
      owner: input.owner,
      seat: input.seat,
      phase: 'pending',
      at: input.at,
      expiresAt: input.expiresAt,
      ...(input.run === undefined ? {} : { run: input.run }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.thread === undefined ? {} : { thread: input.thread }),
      ...(input.receiver === undefined ? {} : { receiver: input.receiver }),
      ...(input.pane === undefined ? {} : { pane: input.pane }),
    };
    const base: IndexEntry = entry ?? { item: input.item, key, lastGeneration: 0 };
    base.hold = hold;
    this.index.set(key, base);
    return { ok: true, hold: { ...hold } };
  }

  private convertHold(input: ConvertHoldInput): ConvertHoldResult {
    this.calls.push({ op: 'convertHold', input });
    const key = standInKeyText(input.item);
    if (key === null) return { ok: false, reason: 'no-hold' };
    const entry = this.index.get(key);
    const hold = entry?.hold;
    if (entry === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch' };
    if (hold.kind !== 'reservation') return { ok: false, reason: 'not-reservation' };
    if (hold.phase === 'holder') return { ok: false, reason: 'already-holder' };
    if (input.expect?.attempt !== undefined && hold.attempt !== input.expect.attempt) {
      return { ok: false, reason: 'stale-attempt' };
    }
    if (input.expect?.receiver !== undefined && hold.receiver !== input.expect.receiver) {
      return { ok: false, reason: 'wrong-receiver' };
    }
    if (input.expect?.thread !== undefined && hold.thread !== input.expect.thread) {
      return { ok: false, reason: 'wrong-thread' };
    }
    const converted: HoldRecord = {
      ...hold,
      phase: 'holder',
      holder: input.holder,
      messageId: input.messageId,
      at: input.at,
    };
    delete converted.expiresAt;
    entry.hold = converted;
    return { ok: true, hold: { ...converted } };
  }

  private releaseHold(input: { item: ItemIdentity; owner: string; at: string }): ReleaseHoldResult {
    this.calls.push({ op: 'releaseHold', input });
    const key = standInKeyText(input.item);
    if (key === null) return { ok: false, reason: 'no-hold' };
    const entry = this.index.get(key);
    const hold = entry?.hold;
    if (entry === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch' };
    // In place: a caller still holding the slot sees the hold gone after this returns.
    delete entry.hold;
    return { ok: true, hold: { ...hold } };
  }

  private renewHold(input: { item: ItemIdentity; owner: string; expiresAt: string; at: string }): RenewHoldResult {
    this.calls.push({ op: 'renewHold', input });
    const key = standInKeyText(input.item);
    if (key === null) return { ok: false, reason: 'no-hold' };
    const entry = this.index.get(key);
    const hold = entry?.hold;
    if (entry === undefined || hold === undefined) return { ok: false, reason: 'no-hold' };
    if (hold.owner !== input.owner) return { ok: false, reason: 'owner-mismatch' };
    if (hold.phase === 'holder') return { ok: false, reason: 'holder' };
    hold.expiresAt = input.expiresAt;
    hold.at = input.at;
    return { ok: true, hold: { ...hold } };
  }
}

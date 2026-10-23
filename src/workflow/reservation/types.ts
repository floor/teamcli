// WF-MVP reservation types (spec draft 4 §2.2, §2.3, §2.4) over the store lane's settled surface:
// one store-wide `store.transact(tx)` serializes every mutation, `tx.tryHold` reserves item and
// receiver together, `tx.convertHold` writes the holder on acknowledgement, and `tx.releaseHold`
// or `tx.renewHold` move a hold's life. This module owns the reservation decisions and the
// exclusion both `team next` claims and the dispatch read; the store owns durability, the index,
// run creation, generations and the journal.
//
// The shapes below mirror builder-1's settled RunStore subset (feat/workflow-mvp-store). They are
// declared here, not imported, because that lane has no committed module yet; at integration the
// store satisfies them structurally and the daemon passes it unchanged. `keyText` is the store's
// one item-key formatter, injected so this module never invents a second encoding.

/** The namespaced identity of one task (§2.3): source, project, team and task id. */
export type ItemIdentity = {
  source: string;
  project: string;
  team: string;
  id: string;
};

export type HoldKind = 'reservation' | 'next-claim';

/** `pending` until a valid acknowledgement converts it; `holder` never expires and never renews. */
export type HoldPhase = 'pending' | 'holder';

export type HoldRecord = {
  kind: HoldKind;
  /** The item's key text, as the store writes it (the index entry carries the parts). */
  item: string;
  /** Opaque: `<runId>/<attempt>` for a reservation, `next:<seat>:<pane>` for a next claim. */
  owner: string;
  /** The seat this hold excludes from selection, of either kind. */
  seat: string;
  phase: HoldPhase;
  at: string;
  /** Absolute; absent on a converted holder, which ends only by release. */
  expiresAt?: string;
  run?: string;
  attempt?: number;
  thread?: string;
  /** The reserved receiver's seat, and the pane it was reserved for. */
  receiver?: string;
  pane?: string;
  holder?: { seat: string; pane: string };
  messageId?: string;
};

export type IndexTerminal = { run: string; generation: number; outcome: string; at: string };

/** One item's index entry: the exclusion truth. Journals are the audit and the folded state. */
export type IndexEntry = {
  item: ItemIdentity;
  key: string;
  lastGeneration: number;
  /** The live run id, when one exists. */
  live?: string;
  terminal?: IndexTerminal;
  reopened?: { by: string; at: string; reason?: string };
  hold?: HoldRecord;
};

export type TryHoldInput = {
  item: ItemIdentity;
  kind: HoldKind;
  owner: string;
  seat: string;
  expiresAt: string;
  at: string;
  run?: string;
  attempt?: number;
  thread?: string;
  /** The receiver's seat; `pane` is the pane it was reserved for. */
  receiver?: string;
  pane?: string;
};

/** Reasons in the store's own order: 'item-key', 'run-live', 'terminal', 'hold-live',
 *  'receiver-busy'. The literal is carried through unchanged; this module never re-spells it. */
export type TryHoldResult =
  | { ok: true; hold: HoldRecord }
  | { ok: false; reason: string; hold?: HoldRecord; run?: string; item?: string };

export type ConvertHoldInput = {
  item: ItemIdentity;
  owner: string;
  holder: { seat: string; pane: string };
  /** The store re-checks these against the hold inside the same transaction. */
  expect?: { attempt?: number; receiver?: string; thread?: string };
  messageId: string;
  at: string;
};

export type ConvertHoldResult =
  | { ok: true; hold: HoldRecord }
  | {
      ok: false;
      reason: 'no-hold' | 'owner-mismatch' | 'not-reservation' | 'already-holder' | 'stale-attempt' | 'wrong-receiver' | 'wrong-thread';
    };

export type ReleaseHoldResult = { ok: true; hold: HoldRecord } | { ok: false; reason: string };

export type RenewHoldResult = { ok: true; hold: HoldRecord } | { ok: false; reason: 'no-hold' | 'owner-mismatch' | 'holder' };

export type ReserveInput = {
  item: ItemIdentity;
  runId: string;
  attempt: number;
  thread: string;
  receiver: { seat: string; pane?: string };
  /** Absolute deadline of the acknowledgement timer, in milliseconds. */
  expiresAt: number;
  at: number;
};

export type ReserveResult =
  | { kind: 'reserved'; hold: HoldRecord }
  | { kind: 'refused'; reason: string; hold?: HoldRecord; run?: string };

export type ClaimNextInput = {
  item: ItemIdentity;
  seat: string;
  pane: string;
  now: number;
  /** Absolute; the local lease's `until`, in milliseconds. */
  expiresAt: number;
};

export type ClaimNextResult =
  | { kind: 'claimed'; hold: HoldRecord }
  | { kind: 'refused'; reason: string; hold?: HoldRecord; run?: string }
  /** The store refused the item key itself, so no run can exist for it; the caller may claim
   *  locally with no hold rather than refusing every claim on an odd team or project name. */
  | { kind: 'unrecorded'; reason: string };

export type AckInput = {
  item: ItemIdentity;
  runId: string;
  attempt: number;
  thread: string;
  seat: string;
  /** The pane the reply surfaced in; the holder records it. */
  pane: string;
  /** The dispatch message's id, recorded on the holder by the store. */
  messageId: string;
  at: number;
};

export type AckIgnored =
  | 'no-reservation'
  | 'stale-attempt'
  | 'wrong-receiver'
  | 'wrong-thread'
  | 'wrong-run'
  | 'owner-mismatch'
  | 'already-holder'
  | 'expired';

/** A reply that is not the live reservation's is recorded by the caller and moves nothing. */
export type AckResult =
  | { kind: 'acknowledged'; hold: HoldRecord }
  | { kind: 'ignored'; why: AckIgnored; hold?: HoldRecord };

/** A hold the sweep cleared because its absolute deadline passed. Holders are never swept. */
export type Expired =
  | { kind: 'reservation'; item: ItemIdentity; owner: string; run?: string; attempt?: number; thread?: string; seat: string; receiver?: string; pane?: string }
  | { kind: 'next-claim'; item: ItemIdentity; owner: string; seat: string; pane?: string };

/** The transaction the store runs. Every read and write below is inside `store.transact`. */
export type ReservationTx = {
  entry(keyText: string): IndexEntry | null;
  /** Every item slot; the expiry sweep reads the holds with their key parts, never a bare key. */
  items(): IndexEntry[];
  tryHold(input: TryHoldInput): TryHoldResult;
  convertHold(input: ConvertHoldInput): ConvertHoldResult;
  releaseHold(input: { item: ItemIdentity; owner: string; at: string }): ReleaseHoldResult;
  renewHold(input: { item: ItemIdentity; owner: string; expiresAt: string; at: string }): RenewHoldResult;
};

/** What this module needs from the run store. builder-1's RunStore satisfies it as it stands,
 *  except for the one `keyText` method this lane asked it to expose (the thin wrapper over
 *  `validateItemKey`); `entry` is the lock-free read. */
export type ReservationStore = {
  /** Serialized, in-process and across processes. `work` must be synchronous. */
  transact<T>(work: (tx: ReservationTx) => T): T;
  /** Lock-free and advisory: a filter or status read, never the authority for a write. */
  entry(keyText: string): IndexEntry | null;
  /** The store's one item-key formatter; null when a segment cannot be encoded. */
  keyText(item: ItemIdentity): string | null;
};

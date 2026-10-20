// The daemon's own answer to "is this route's presence channel healthy right now?".
//
// Nothing in the store can answer it: `status.json` records what a writer said last, and its
// `serving` word must never be believed on its own. The only truthful source is the process that
// owns the route and runs its ingester: it knows whether a pass has finished recently, and a pass
// that hung ages the answer to unknown instead of claiming the channel still serves. This module
// is that fixed liveness, kept in memory and never persisted.
//
// A route can also carry read-only runtime sources (one per seat, built by the Codex source
// adapter). Their continuity is a second, per-seat truth: a source answers for one seat's
// runtime channel only, and its last measured bound-thread evidence is a moment, not a standing
// proof. A source's own persisted record is never health — only the in-memory sample this
// process took, tagged with this daemon epoch and fenced on the seat's current binding, can
// answer. One seat's unproven source never changes a sibling's answer.
import { isPresenceTime, presenceFutureBeyond } from './contract.ts';

// Continuity is the source's own live transport state, sampled fresh every pass — never an
// event-age timer. A quiet subscription must not expire because native events are old: only a
// disconnect, error, closed/finished stream or an incarnation change takes continuity away.
// Baseline evidence taken at connect is a point-in-time observation, so the source reports it as
// unproven until measured notification delivery (or measured stream semantics) proves the
// channel serves; the host never invents a second, event-age horizon on top.

/** One seat's runtime-source reading, in the source's own measured words: `channel` is the
 *  transport's liveness, `stream` is whether the subscription initialized, `baseline` is whether
 *  the bound thread's initial state was read, and `evidenceAt` is the instant of the latest
 *  measured bound-thread evidence. None is a wall-clock guess, and the host adds no event-age
 *  horizon of its own. */
export type PresenceSourceStatus = {
  seat: string;
  /** The runtime incarnation the source was started for; compared whole against current state. */
  binding: string;
  threadId: string;
  channel: 'connecting' | 'connected' | 'unknown' | 'gone' | 'stopped';
  stream: 'uninitialized' | 'initialized' | 'lost';
  baseline: 'pending' | 'read' | 'failed';
  evidenceAt: string | null;
  /** The spool identity (`<record stem>`) of the newest record the source successfully staged,
   *  or null before the first stage. This is the durable event identity the host reconciles
   *  against its canonical projection and applied fence: a receipt instant proves delivery, not
   *  application, so no seat is qualified on `evidenceAt` alone. A duplicate live notification
   *  keeps the same id; a failed stage never advances it. */
  stagedEventId?: string | null;
  /** Display detail when the source has one; never a verdict and never persisted. */
  why?: string | null;
  /** The producer's own spelling for the same display detail as `why`. */
  reason?: string | null;
};

/** The read-only runtime source a route owns for one seat. `step` is the bounded stream pump
 *  the host drives once per pass; `status` is a synchronous read of the source's own measured
 *  words; `close` (or its `cancel` alias) resolves `{ quiesced: true }` only once the drain
 *  actually finished, and a rejection retains ownership. */
export type PresenceSource = {
  seat: string;
  step(at: Date): Promise<unknown>;
  status(at: Date): PresenceSourceStatus;
  close(): Promise<{ quiesced: true }>;
};

/**
 * A source as a producer hands it over. The transport adapter may expose its alias spellings:
 * `state` for `status`, `cancel` for `close`, and the seat either on the source or only on its
 * status reading. The host adopts it once at registration, so an adapter is never required to
 * carry a second, host-only field.
 */
export type PresenceSourceRuntime = {
  seat?: string;
  step(at: Date): Promise<unknown>;
  status?(at: Date): PresenceSourceStatus;
  state?(at: Date): PresenceSourceStatus;
  close?(): Promise<{ quiesced: true }>;
  cancel?(): Promise<{ quiesced: true }>;
};

export type PresenceSourceAdoption =
  | { source: PresenceSource }
  | { seat: string | null; why: string };

/**
 * Adopts one producer source into the host's registered shape, reading its seat before the first
 * pump and accepting the adapter's aliases. A source that cannot say which seat it serves, or
 * cannot be drained, is not adopted: the caller turns a named seat into an explicit unproven
 * source and an unnamed failure into an unresolved route, never into a silent fallback.
 */
export function adoptPresenceSource(
  runtime: PresenceSourceRuntime,
  at: Date,
): PresenceSourceAdoption {
  const named = typeof runtime.seat === 'string' && runtime.seat !== '' ? runtime.seat : null;
  const read = typeof runtime.status === 'function' ? runtime.status : runtime.state;
  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  if (typeof read !== 'function') {
    return { seat: named, why: 'the runtime source has no status reader' };
  }
  let first: PresenceSourceStatus;
  try {
    first = read.call(runtime, at);
  } catch (error) {
    return { seat: named, why: `the runtime source status failed: ${errorText(error)}` };
  }
  const reported = first !== null && typeof first === 'object' && typeof first.seat === 'string'
    ? first.seat
    : '';
  const seat = named ?? (reported !== '' ? reported : null);
  if (seat === null) return { seat: null, why: 'the runtime source does not name its seat' };
  if (named !== null && reported !== '' && reported !== named) {
    return { seat: named, why: 'the runtime source answered for another seat' };
  }
  const closer = runtime.close ?? runtime.cancel;
  if (typeof closer !== 'function') return { seat, why: 'the runtime source cannot be closed' };
  return {
    source: {
      seat,
      step: (when) => runtime.step(when),
      status: (when) => read.call(runtime, when),
      close: () => closer.call(runtime),
    },
  };
}


/**
 * An explicit source for a seat that expects a managed native runtime channel but whose target
 * resolution or start failed. It answers unproven forever, so the seat can never silently fall
 * back to the route's hook health as if no native attachment had been expected.
 */
export function unprovenSource(seat: string, why: string): PresenceSource {
  return {
    seat,
    async step(_at: Date): Promise<void> {},
    status(_at: Date): PresenceSourceStatus {
      return {
        seat,
        binding: '',
        threadId: '',
        channel: 'unknown',
        stream: 'uninitialized',
        baseline: 'pending',
        evidenceAt: null,
        why,
      };
    },
    async close(): Promise<{ quiesced: true }> {
      return { quiesced: true };
    },
  };
}

/** Whether a source's reading establishes a serving channel this pass. Only a connected,
 *  initialized stream with a read baseline on the current incarnation qualifies; `gone` never
 *  renders continuity (its non-idle verdict comes from the canonical projection), and every
 *  other last-known word is unproven. Event age is deliberately not consulted — a quiet channel
 *  stays serving. */
export function sourceContinuity(
  source: PresenceSourceStatus,
  currentBinding: string | null,
  at: Date,
): { continuous: boolean; why: string | null } {
  if (source.channel === 'gone') {
    return { continuous: false, why: source.why ?? source.reason ?? 'the runtime reports the session ended' };
  }
  if (source.channel !== 'connected') {
    return { continuous: false, why: source.why ?? source.reason ?? `the runtime channel is ${source.channel}` };
  }
  if (source.stream !== 'initialized') {
    return { continuous: false, why: source.why ?? source.reason ?? 'the runtime stream is not initialized' };
  }
  if (source.baseline !== 'read') {
    return { continuous: false, why: source.why ?? source.reason ?? 'the bound thread baseline is not read' };
  }
  if (currentBinding === null || source.binding !== currentBinding) {
    return { continuous: false, why: 'the runtime channel belongs to another incarnation' };
  }
  if (!isPresenceTime(source.evidenceAt)) {
    return { continuous: false, why: 'the runtime channel has no measured bound-thread evidence' };
  }
  if (presenceFutureBeyond(source.evidenceAt, at)) {
    return { continuous: false, why: 'the runtime channel evidence is in the future' };
  }
  return { continuous: true, why: null };
}

/** The exact canonical position a staged runtime record must have reached: the applied
 *  projection (`current.json`) and the activity reconciler's applied fence on the same seat
 *  record. Either alone can be observed between the two writes, so both are required. */
export type PresenceCanonicalPosition = {
  id: string;
  binding: string;
  seq: number;
  seatId: string;
  fence: { seat_id: string; binding: string; seq: number } | null;
};

/** A proof that one staged event identity was seen applied at the canonical position. It is not
 *  evidence by itself: every reader re-checks it against a fresh source reading, so a newer
 *  stage makes it stale at once rather than at the next sample. `epoch` fences it to the daemon
 *  process that reconciled it. */
export type PresenceReconciledProof = {
  id: string;
  binding: string;
  epoch: string;
};

function stagedIdOf(source: PresenceSourceStatus): string | null {
  return typeof source.stagedEventId === 'string' && source.stagedEventId !== ''
    ? source.stagedEventId
    : null;
}

/**
 * Reconciles one source's newest staged identity against the canonical projection and the
 * applied fence after an activity step. Application is the only proof: a connected channel with
 * a receipt instant says the event reached the spool, not that the projection moved, and the
 * host must not enforce the projection's older word while the source is already ahead.
 */
export function reconcilePresenceProof(input: {
  source: PresenceSourceStatus;
  canonical: PresenceCanonicalPosition | null;
  /** Why the canonical position is absent, when it is. */
  canonicalWhy: string | null;
  currentBinding: string | null;
  at: Date;
}): { ok: true; proof: { id: string; binding: string } } | { ok: false; why: string } {
  const staged = stagedIdOf(input.source);
  if (staged === null) return { ok: false, why: 'the runtime source has staged no event yet' };
  if (input.canonical === null) {
    return { ok: false, why: input.canonicalWhy ?? 'the seat has no canonical presence projection yet' };
  }
  if (input.currentBinding === null) {
    return { ok: false, why: 'the seat records no current presence binding' };
  }
  if (input.canonical.binding !== input.currentBinding) {
    return { ok: false, why: 'the canonical projection belongs to another incarnation' };
  }
  const continuity = sourceContinuity(input.source, input.currentBinding, input.at);
  if (!continuity.continuous) {
    return { ok: false, why: continuity.why ?? 'the runtime channel is not serving' };
  }
  if (input.canonical.id !== staged) {
    return { ok: false, why: 'the canonical projection has not applied the runtime event' };
  }
  const fence = input.canonical.fence;
  if (fence === null) return { ok: false, why: 'the seat records no applied presence fence' };
  if (fence.seat_id !== input.canonical.seatId) {
    return { ok: false, why: 'the applied fence names another seat record' };
  }
  if (fence.binding !== input.canonical.binding) {
    return { ok: false, why: 'the applied fence belongs to another incarnation' };
  }
  if (fence.seq !== input.canonical.seq) {
    return { ok: false, why: 'the applied fence has not reached the canonical projection' };
  }
  return { ok: true, proof: { id: staged, binding: input.canonical.binding } };
}

/**
 * Whether a cached reconciliation still holds right now. The source reading is re-read by the
 * caller at the instant of use, so an event staged after the last pass is refused immediately:
 * the identity must be exactly the proven one, the incarnation must still be the current one,
 * and the channel must still be continuous. A quiet duplicate state keeps its identity and
 * therefore stays qualified; no wall-clock age is consulted.
 */
export function reconciledProofHolds(input: {
  proof: PresenceReconciledProof | undefined;
  source: PresenceSourceStatus;
  currentBinding: string | null;
  epoch: string;
  at: Date;
}): { qualified: boolean; why: string | null } {
  if (input.proof === undefined) {
    return { qualified: false, why: 'the runtime event has not been reconciled' };
  }
  if (input.proof.epoch !== input.epoch) {
    return { qualified: false, why: 'the reconciled proof is from another daemon epoch' };
  }
  const staged = stagedIdOf(input.source);
  if (staged === null) {
    return { qualified: false, why: 'the runtime source has staged no event yet' };
  }
  if (staged !== input.proof.id) {
    return { qualified: false, why: 'the runtime staged an event the canonical projection has not applied' };
  }
  if (input.currentBinding === null || input.currentBinding !== input.proof.binding) {
    return { qualified: false, why: 'the runtime channel belongs to another incarnation' };
  }
  const continuity = sourceContinuity(input.source, input.currentBinding, input.at);
  if (!continuity.continuous) {
    return { qualified: false, why: continuity.why ?? 'the runtime channel is not serving' };
  }
  return { qualified: true, why: null };
}

/**
 * How long a finished pass vouches for the channel. The production pass runs every 250 ms; eight
 * missed passes mean a step is hung or the loop is not running, and the honest answer is no.
 */
export const PRESENCE_HEALTH_GRACE_MS = 2_000;

/**
 * The ingester's own typed answer for one finished step. Completion is never success: a step can
 * resolve while the log is faulted, the index is unreadable or an append is unrecovered, and the
 * ingester reports failures through its result rather than by throwing. Until the ingester module
 * carries `healthy`, an absent answer is not healthy, so a faulted log can never keep an old
 * projection trusted. A step that still has known backlog pending is not current either: the
 * consumer must see false until the channel has caught up.
 */
export function presenceStepHealth(result: { healthy?: unknown; pending?: unknown }): boolean {
  return result.healthy === true && result.pending === false;
}

export type PresenceChannelHealth = {
  /** Records one finished step's typed channel answer at the instant it finished. The answer is
   *  the ingester's own (`presenceStepHealth`), never inferred from the step merely resolving.
   *  `why` is display detail for a false answer; it never participates in the verdict. */
  stepped(ok: boolean, at: Date, why?: string | null): void;
  /** Whether a successful step finished inside the grace window and nothing failed since. */
  healthy(at: Date): boolean;
  /** Why the answer at `at` is not healthy, for display; null when it is healthy. Never a
   *  substitute for `healthy`: no step, a false step and an aged-out step all answer false. */
  reason(at: Date): string | null;
  /** Records this pass's in-memory sample of one seat's runtime source, fenced on the seat's
   *  current binding and tagged with the daemon epoch that took it. A persisted source record is
   *  never passed here; the caller runs `source.step(at)` then samples `source.status(at)`. */
  seatObserved(input: {
    source: PresenceSourceStatus;
    currentBinding: string | null;
    epoch: string;
  }, at: Date): void;
  /** Registers a seat whose route expects a managed runtime source, before the first sample. An
   *  expected seat that has not been sampled yet is not healthy, so the window before the first
   *  pass can never inherit the route's ingest answer. */
  seatExpected(seat: string): void;
  /** Marks the route's managed-runtime classification unresolved: a factory that builds sources
   *  or resolution failures threw, so no seat can be told apart from one that expected native.
   *  No route-level or seat-level answer may claim health while this stands. It is sticky for
   *  the process: classification happens at start, and a later read cannot repair it. */
  unresolved(why: string): void;
  /** The sticky classification failure, or null when every declared seat was classified. A
   *  reader uses it to say `unknown` rather than inferring a missing source means a hook seat. */
  unresolvedWhy(): string | null;
  /** The current managed binding captured with this seat's last sample, for a reader's own fence;
   *  null before the first sample or when the seat record named no valid binding. */
  seatBinding(seat: string): string | null;
  /** Whether this seat's runtime channel is serving now: the route's ingest is healthy and, when
   *  the seat has a source, its last sample inside this grace window was continuous under this
   *  epoch. A seat with no source keeps the route's answer; siblings never affect each other. */
  seatHealthy(seat: string, at: Date): boolean;
  /** Why this seat's answer at `at` is false, for display; null when it is true. */
  seatReason(seat: string, at: Date): string | null;
};

export function createPresenceChannelHealth(
  graceMs = PRESENCE_HEALTH_GRACE_MS,
  epoch = '',
): PresenceChannelHealth {
  let lastOkAt: number | null = null;
  let lastStepOk = false;
  let lastWhy: string | null = null;
  let unresolvedState: string | null = null;
  const seats = new Map<
    string,
    { epoch: string; continuous: boolean; why: string | null; atMs: number; binding: string | null }
  >();
  const expected = new Set<string>();
  const healthy = (at: Date): boolean => {
    if (unresolvedState !== null) return false;
    if (!lastStepOk || lastOkAt === null) return false;
    const age = at.getTime() - lastOkAt;
    return age >= 0 && age <= graceMs;
  };
  const reason = (at: Date): string | null => {
    if (unresolvedState !== null) return unresolvedState;
    if (healthy(at)) return null;
    if (!lastStepOk) return lastWhy ?? 'the presence channel did not answer healthy';
    return 'no presence step finished inside the liveness window';
  };
  return {
    stepped(ok, at, why = null) {
      lastStepOk = ok;
      lastWhy = ok ? null : why;
      if (ok) lastOkAt = at.getTime();
    },
    healthy,
    reason,
    seatObserved(input, at) {
      const verdict = sourceContinuity(input.source, input.currentBinding, at);
      seats.set(input.source.seat, {
        epoch: input.epoch,
        continuous: verdict.continuous,
        why: verdict.why,
        atMs: at.getTime(),
        binding: input.currentBinding,
      });
    },
    seatExpected(seat) {
      expected.add(seat);
    },
    unresolved(why) {
      // The first failure is the root cause a reader needs; later ones cannot classify better.
      if (unresolvedState === null) unresolvedState = why;
    },
    unresolvedWhy() {
      return unresolvedState;
    },
    seatBinding(seat) {
      return seats.get(seat)?.binding ?? null;
    },
    seatHealthy(seat, at) {
      if (!healthy(at)) return false;
      const record = seats.get(seat);
      if (record === undefined) return !expected.has(seat);
      if (record.epoch !== epoch) return false;
      const age = at.getTime() - record.atMs;
      return record.continuous && age >= 0 && age <= graceMs;
    },
    seatReason(seat, at) {
      if (!healthy(at)) return reason(at);
      const record = seats.get(seat);
      if (record === undefined) {
        return expected.has(seat) ? 'the runtime channel has not been sampled yet' : null;
      }
      if (record.epoch !== epoch) return 'the runtime channel answer is from another daemon epoch';
      if (!record.continuous) return record.why ?? 'the runtime channel is not serving';
      const age = at.getTime() - record.atMs;
      if (age < 0) return 'the runtime channel answer is stamped in the future';
      if (age > graceMs) return 'no runtime-channel answer from the seat inside the liveness window';
      return null;
    },
  };
}

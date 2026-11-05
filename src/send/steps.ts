// Signed step events for one message id.
//
// A send walks legs, posts an adapter, and leaves a record; the bus announces the arrival, the
// seat writes a read receipt, and the watch retries a wake that did not land. Each of those steps
// appends one signed event carrying the message id, so `team trace <id>` can print the whole
// story in order with the deltas between the steps.
//
// The step is always the record id's tail: `message.arrived` names the message id itself, every
// step is `<id>:<step>` (`message.staged` → `<id>:staged`, `leg.tried` → `<id>:leg.tried:<leg>`,
// `wake.retried` → `<id>:wake.retried:<try>`). Each (kind, record id, session) is appended once:
// a retried step is a duplicate, not a second step. A leg tried twice in one walk is two routes.
//
// These events are records, not notifications: they carry no routing default (the kinds are in
// the closed table and absent from the routing table, like `message.arrived`), so no seat is told
// and no subscriber receives them. The event log is the receiving team's — the same store the
// bus appends `message.arrived` to — so a trace run inside that checkout finds every step.
//
// The append is bounded: a writer on a send's own path passes `lockWaitMs` (100 ms for the
// sender) so a live event-lock holder can never hold the send's line for the lock's whole budget.
// A step that cannot be appended is dropped with its reason; it never fails the step it records.
import { appendEvent, type EventAppendInput } from '../bus/log.ts';

/** Where the step is filed: the receiving team's project store, the checkout the record was
 *  written into, and the home that holds the store. */
export type StepStore = { project: string; root: string; home: string };

export type StepResult = { ok: true; duplicate: boolean } | { ok: false; reason: string };

/** How long a step append may wait on the event lock. The send's target is a 300 ms p95 for its
 *  whole path; one contended append costs at most this, and the trace is a record, never a
 *  delivery fact that could fail the send. */
export const STEP_APPEND_MS = 100;

export function stepRecordId(id: string, step: string, tail?: string): string {
  return tail === undefined ? `${id}:${step}` : `${id}:${step}:${tail}`;
}

/** One step, appended under the message id's own record id. Never throws. */
export function appendStep(
  store: StepStore,
  input: EventAppendInput,
  lockWaitMs = STEP_APPEND_MS,
  options: { maxBytes?: number; kept?: number; maxTotalBytes?: number; retentionSeconds?: number } = {},
): StepResult {
  try {
    const result = appendEvent(store.project, store.root, store.home, input, {
      ...options,
      lockWaitMs,
      deduplicate: true,
      retain: 'cap',
    });
    return result.ok ? { ok: true, duplicate: result.duplicate } : { ok: false, reason: result.reason };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The fields every step of one message carries: the id, the receiving session, the pair and the
 *  thread. The sender's certificate is never repeated here — `team trace` reads the record for
 *  that, and the event log carries facts, not copies of the message. */
export type StepFields = {
  store: StepStore;
  id: string;
  session: string;
  from: string;
  to: string;
  thread?: string;
  ts: string;
};

function base(fields: StepFields): Omit<EventAppendInput, 'kind' | 'record_id'> {
  return {
    ts: fields.ts,
    session: fields.session,
    from: fields.from,
    to: fields.to,
    ...(fields.thread === undefined ? {} : { thread: fields.thread }),
  };
}

/** The record is on disk: the send's staging step (the bus's re-read of the same record raises
 *  `message.arrived` separately, after its own verification). */
export function stagedStep(fields: StepFields): StepResult {
  return appendStep(fields.store, {
    ...base(fields),
    kind: 'message.staged',
    record_id: stepRecordId(fields.id, 'staged'),
  });
}

/** The send's own webhook post ended: `posted` with its cost, or `failed`/`unknown` with the
 *  reason. The bus's later post, when the send's attempt released its claim, is the bus's own
 *  step; a trace shows both posts by their own outcome words. A late answer uses the `late`
 *  tail, so its record id is `<id>:webhook.posted:late` and the deadline's own step stays. */
export function webhookStep(fields: StepFields, outcome: { kind: 'posted' | 'failed' | 'unknown'; ms?: number; reason?: string }, tail?: string): StepResult {
  return appendStep(fields.store, {
    ...base(fields),
    kind: 'webhook.posted',
    record_id: stepRecordId(fields.id, 'webhook.posted', tail),
    via: 'webhook',
    outcome: outcome.kind,
    ...(outcome.ms === undefined ? {} : { ms: outcome.ms }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
}

/** One leg of the walk was attempted: the leg's name, the walk's outcome word and the
 *  milliseconds from the run's start to the attempt's end. */
export function legStep(fields: StepFields, attempt: { route: string; outcome: string; ms: number; reason?: string }, lockWaitMs?: number): StepResult {
  return appendStep(
    fields.store,
    {
      ...base(fields),
      kind: 'leg.tried',
      record_id: stepRecordId(fields.id, 'leg.tried', attempt.route),
      via: attempt.route,
      outcome: attempt.outcome,
      ms: Math.max(0, Math.round(attempt.ms)),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    },
    lockWaitMs,
  );
}

/** The watch woke a seat for a message it had already left behind: the try number names the step,
 *  so each retry is its own event and a replayed pass is a duplicate. */
export function wakeStep(fields: StepFields, attempt: { via: string; try: number; outcome: string; ms: number; reason?: string }, lockWaitMs?: number): StepResult {
  return appendStep(
    fields.store,
    {
      ...base(fields),
      kind: 'wake.retried',
      record_id: stepRecordId(fields.id, 'wake.retried', `${String(Math.max(1, attempt.try))}:${attempt.via}`),
      via: attempt.via,
      outcome: attempt.outcome,
      ms: Math.max(0, Math.round(attempt.ms)),
      ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    },
    lockWaitMs,
  );
}

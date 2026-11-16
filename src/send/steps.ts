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
// A step the lock keeps out past a short bounded retry is deferred to the store's own folder and
// flushed by a later append; it never fails the step it records.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent, type EventAppendInput, type EventAppendResult } from '../bus/log.ts';
import { storePath } from '../store/store.ts';

/** Where the step is filed: the receiving team's project store, the checkout the record was
 *  written into, and the home that holds the store. */
export type StepStore = { project: string; root: string; home: string };

export type StepResult = { ok: true; duplicate: boolean } | { ok: false; reason: string; deferred?: true };

/** How long a step append may wait on the event lock. The send's target is a 300 ms p95 for its
 *  whole path; one contended append costs at most this, and the trace is a record, never a
 *  delivery fact that could fail the send. */
export const STEP_APPEND_MS = 100;

export function stepRecordId(id: string, step: string, tail?: string): string {
  return tail === undefined ? `${id}:${step}` : `${id}:${step}:${tail}`;
}

/** The whole wait a busy event lock gets before the step is deferred: the first attempt's bound
 *  and one longer retry share it. */
export const STEP_RETRY_BUDGET_MS = 2_000;

/** The most deferred steps one successful append flushes behind itself. */
const DEFERRED_FLUSH_PER_APPEND = 20;

/** The folder of steps the event lock kept out: one file per record id, in the store's own
 *  folder, flushed by a later append. */
export function deferredStepsFolder(store: StepStore): string {
  return join(storePath(store.project, store.root, store.home), 'deferred-steps');
}

type AppendOptions = { maxBytes?: number; kept?: number; maxTotalBytes?: number; retentionSeconds?: number };

function appendOnce(store: StepStore, input: EventAppendInput, lockWaitMs: number, options: AppendOptions): EventAppendResult {
  return appendEvent(store.project, store.root, store.home, input, {
    ...options,
    lockWaitMs,
    deduplicate: true,
    retain: 'cap',
  });
}

/** A step the lock kept out, written whole under its record id so a repeat defers nothing twice.
 *  The name is the record id hashed, since an id carries `:` and the leg's own words. */
export function deferStep(store: StepStore, input: EventAppendInput): boolean {
  try {
    const folder = deferredStepsFolder(store);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const name = `${createHash('sha256').update(`${input.kind}\0${input.record_id}\0${input.session}`).digest('hex').slice(0, 32)}.json`;
    const path = join(folder, name);
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, input })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Appends the steps an earlier busy lock deferred, oldest first, bounded per call. The append
 *  deduplicates by record id, so a step flushed twice (two flushers, a crash before the unlink) is
 *  one event. A file that does not read is left for the owner to see, never guessed at. */
export function flushDeferredSteps(store: StepStore, lockWaitMs = STEP_APPEND_MS, limit = DEFERRED_FLUSH_PER_APPEND): number {
  let flushed = 0;
  let names: string[];
  try {
    names = readdirSync(deferredStepsFolder(store)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return 0;
  }
  for (const name of names.slice(0, limit)) {
    const path = join(deferredStepsFolder(store), name);
    let input: EventAppendInput;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; input?: EventAppendInput };
      if (parsed.v !== 1 || parsed.input === undefined) continue;
      input = parsed.input;
    } catch {
      continue;
    }
    try {
      const result = appendOnce(store, input, lockWaitMs, {});
      if (!result.ok) break;
      unlinkSync(path);
      flushed += 1;
    } catch {
      break;
    }
  }
  return flushed;
}

/**
 * One step, appended under the message id's own record id. Never throws. A busy event lock gets
 * one longer retry inside `STEP_RETRY_BUDGET_MS`; still busy, the step is written to the store's
 * deferred folder and the result says so, and the next append that lands flushes it. A step is
 * never dropped silently: its reason names the deferral, or why even that could not be written.
 */
export function appendStep(
  store: StepStore,
  input: EventAppendInput,
  lockWaitMs = STEP_APPEND_MS,
  options: AppendOptions = {},
): StepResult {
  try {
    let result = appendOnce(store, input, lockWaitMs, options);
    if (!result.ok && result.busy === true && lockWaitMs < STEP_RETRY_BUDGET_MS) {
      result = appendOnce(store, input, STEP_RETRY_BUDGET_MS - lockWaitMs, options);
    }
    if (result.ok) {
      flushDeferredSteps(store, lockWaitMs);
      return { ok: true, duplicate: result.duplicate };
    }
    if (result.busy === true) {
      return deferStep(store, input)
        ? { ok: false, reason: `${result.reason}; trace record deferred: a later append flushes it`, deferred: true }
        : { ok: false, reason: `${result.reason}; the trace record could not be deferred either` };
    }
    return { ok: false, reason: result.reason };
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
  rule?: string;
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
    ...(fields.rule === undefined ? {} : { rule: fields.rule }),
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
 *  milliseconds from the run's start to the attempt's end. A typed wake that knows them adds the
 *  two measurements the delivery bound is read from, both counted from the message's staging:
 *  `submitMs` to the first read that showed its line gone after Enter, `workingMs` to the
 *  profile's working screen. */
export function legStep(
  fields: StepFields,
  attempt: { route: string; outcome: string; ms: number; submitMs?: number; workingMs?: number; reason?: string },
  lockWaitMs?: number,
): StepResult {
  return appendStep(
    fields.store,
    {
      ...base(fields),
      kind: 'leg.tried',
      record_id: stepRecordId(fields.id, 'leg.tried', attempt.route),
      via: attempt.route,
      outcome: attempt.outcome,
      ms: Math.max(0, Math.round(attempt.ms)),
      ...(attempt.submitMs === undefined ? {} : { submit_ms: Math.max(0, Math.round(attempt.submitMs)) }),
      ...(attempt.workingMs === undefined ? {} : { working_ms: Math.max(0, Math.round(attempt.workingMs)) }),
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

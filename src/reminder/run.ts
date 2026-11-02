// One beat of the reminder chore: for every configured reminder, decide whether an instant is
// due, record what happened, and — when it is time — send it under the machine daemon's own
// identity. The host calls the tick from its beat and never awaits it; a send that walks does not
// hold the beat.
//
// The rules are the design's: only the most recent instant, a catch-up window of half the gap
// capped at six hours, a first run remembered without firing, a missed instant recorded and
// skipped, a clock stepped back named and never refired, and a failed transport retried on a
// later beat under the message id it already staged, until the window closes. A refusal — the
// config, admission, or a record that could not be taken — is final and is not retried.
import { readRemindersState, recordReminder, settleReminder, type ReminderDelivery, type ReminderRecord } from './state.ts';
import { catchUpWindow, decideDue, latestDue, type ReminderStored, type ReminderTimes } from './schedule.ts';
import { sendDaemonDirect, type DaemonDirectContext, type DaemonDirectRequest, type DaemonDirectResult } from './direct-send.ts';
import { realHost, type DaemonRecipient } from '../commands/send.ts';

/** One seat a reminder addresses and the text that seat receives: the parser has already
 *  resolved the address to a declared seat of a hosted checkout and filled the placeholders. */
export type ReminderTarget = { recipient: DaemonRecipient; text: string };

/** One configured reminder as the daemon runs it. The config file's own shape is the parser's
 *  business; this is the runtime's. */
export type ReminderSpec = {
  name: string;
  /** Local wall-clock times, `HH:MM`, as validated. */
  at: ReminderTimes;
  /** The zone the wall-clock keys are read in. */
  zone: string;
  /** Whether a late instant may be caught up; default on. */
  catchUp?: boolean;
  targets: readonly ReminderTarget[];
};

/** The transport seam: the verified daemon sender in the daemon, a scripted answer in tests. */
export type ReminderSend = (context: DaemonDirectContext, request: DaemonDirectRequest) => Promise<DaemonDirectResult>;

export type ReminderLog = (line: string) => void;

export type ReminderTickInput = {
  /** The daemon's home: where the reminder state record lives. */
  home: string;
  /** The beat's instant. */
  now: Date;
  specs: readonly ReminderSpec[];
  send?: ReminderSend;
  log?: ReminderLog;
};

/** What one tick did, for tests and for the status surface. */
export type ReminderEvent =
  | { kind: 'unreadable'; why: string }
  | { kind: 'busy'; name: string }
  | { kind: 'refused'; name: string; why: string }
  | { kind: 'first-run'; name: string; key: string }
  | { kind: 'missed'; name: string; key: string; lateMs: number }
  | { kind: 'clock-back'; name: string; stored: number; now: number }
  | { kind: 'fired'; name: string; key: string; lateMs: number; sent: number; refused: number }
  | { kind: 'retried'; name: string; key: string; sent: number; refused: number };

/** Reminders with a send walking right now, by name. A tick that finds one skips it, so two
 *  overlapping beats can never walk the same reminder's due instant twice. */
const inFlight = new Set<string>();

/**
 * Runs one beat. Each reminder is decided alone: one that refuses to record or whose send is
 * still walking never stops another. Resolves when every started walk has settled; a host that
 * must not wait calls it without awaiting.
 */
export async function reminderTick(input: ReminderTickInput): Promise<ReminderEvent[]> {
  const { home, now, specs } = input;
  // The default transport is the verified daemon sender, bound to this tick's home: the state
  // record, lock and heartbeat it proves are the ones this daemon process holds, whatever home
  // the daemon was started with.
  const send: ReminderSend =
    input.send ?? ((context, request) => sendDaemonDirect(context, request, { ...realHost, home }));
  const log: ReminderLog = input.log ?? (() => {});
  const events: ReminderEvent[] = [];
  for (const spec of specs) {
    if (inFlight.has(spec.name)) {
      events.push({ kind: 'busy', name: spec.name });
      continue;
    }
    inFlight.add(spec.name);
    try {
      events.push(...(await stepReminder(home, now, spec, send, log)));
    } finally {
      inFlight.delete(spec.name);
    }
  }
  return events;
}

async function stepReminder(
  home: string,
  now: Date,
  spec: ReminderSpec,
  send: ReminderSend,
  log: ReminderLog,
): Promise<ReminderEvent[]> {
  const latest = latestDue(spec.at, now, spec.zone);
  if (latest === null) return [];
  const read = readRemindersState(home);
  if (read.kind === 'unreadable') {
    log(`reminder state unreadable — ${read.why}; no reminder fires this beat`);
    return [{ kind: 'unreadable', why: read.why }];
  }
  const stored = read.kind === 'ok' && Object.hasOwn(read.state.reminders, spec.name) ? (read.state.reminders[spec.name] as ReminderRecord) : null;

  // The key's own record stands first: a walk that was interrupted is retried, still inside the
  // window, under the message ids it already staged.
  if (stored !== null && stored.key === latest.key && stored.firedAt !== null) {
    return retryReminder(home, now, spec, stored, latest, send, log);
  }

  const decision = decideDue({
    at: spec.at,
    now,
    zone: spec.zone,
    stored,
    ...(spec.catchUp === undefined ? {} : { catchUp: spec.catchUp }),
  });
  switch (decision.kind) {
    case 'none':
      return [];
    case 'clock-back': {
      log(
        `reminder ${spec.name}: clock moved back — the record stands at ${new Date(decision.stored).toISOString()}, the clock says ${new Date(decision.now).toISOString()}; nothing fires`,
      );
      return [{ kind: 'clock-back', name: spec.name, stored: decision.stored, now: decision.now }];
    }
    case 'first-run': {
      const wrote = recordReminder(home, spec.name, {
        key: decision.due.key,
        instant: decision.due.instant,
        firedAt: null,
        lateMs: null,
        finishedAt: now.toISOString(),
        deliveries: [],
      });
      if (!wrote.ok) return refuse(spec.name, wrote.why, log);
      log(`reminder ${spec.name} ${decision.due.key}: first run — remembered without firing`);
      return [{ kind: 'first-run', name: spec.name, key: decision.due.key }];
    }
    case 'missed': {
      const wrote = recordReminder(home, spec.name, {
        key: decision.due.key,
        instant: decision.due.instant,
        firedAt: null,
        lateMs: decision.lateMs,
        finishedAt: now.toISOString(),
        deliveries: [],
      });
      if (!wrote.ok) return refuse(spec.name, wrote.why, log);
      log(`reminder ${spec.name} ${decision.due.key}: missed by ${span(decision.lateMs)}; skipped`);
      return [{ kind: 'missed', name: spec.name, key: decision.due.key, lateMs: decision.lateMs }];
    }
    case 'fire': {
      // The key is recorded before the first byte is sent: a crash mid-walk loses results, never
      // repeats an instant.
      const reserved = recordReminder(home, spec.name, {
        key: decision.due.key,
        instant: decision.due.instant,
        firedAt: now.toISOString(),
        lateMs: decision.lateMs,
        finishedAt: null,
        deliveries: [],
      });
      if (!reserved.ok) return refuse(spec.name, reserved.why, log);
      const outcome = await walk(contextOf(spec, decision.due.key), now, spec, new Map(), new Map(), send);
      settle(home, spec.name, decision.due.key, outcome.deliveries, now, log);
      log(
        `reminder ${spec.name} ${decision.due.key}: sent ${String(outcome.sent)}, refused ${String(outcome.refused)}; late ${span(decision.lateMs)}`,
      );
      return [{ kind: 'fired', name: spec.name, key: decision.due.key, lateMs: decision.lateMs, sent: outcome.sent, refused: outcome.refused }];
    }
  }
}

async function retryReminder(
  home: string,
  now: Date,
  spec: ReminderSpec,
  stored: ReminderRecord,
  latest: ReminderStored,
  send: ReminderSend,
  log: ReminderLog,
): Promise<ReminderEvent[]> {
  const prior = new Map(stored.deliveries.map((delivery) => [targetKey(delivery.root, delivery.seat), delivery]));
  const retry = spec.targets.filter((target) => {
    const held = prior.get(targetKey(target.recipient.root, target.recipient.seat));
    // A recipient never reached was not attempted; either way, a staged record with no transport
    // is what a retry exists for. A refusal (no id, nothing staged) stands as it is.
    return held === undefined || (!held.ok && held.id !== null);
  });
  if (retry.length === 0) return [];
  if (now.getTime() - latest.instant > catchUpWindow(spec.at, latest, spec.zone, spec.catchUp ?? true)) {
    return [];
  }
  const ids = new Map<string, string>();
  for (const target of spec.targets) {
    const held = prior.get(targetKey(target.recipient.root, target.recipient.seat));
    if (held !== undefined && held.id !== null) ids.set(targetKey(target.recipient.root, target.recipient.seat), held.id);
  }
  const outcome = await walk(contextOf(spec, latest.key), now, spec, ids, prior, send);
  const merged = mergeDeliveries(spec, prior, outcome.deliveries);
  settle(home, spec.name, latest.key, merged, now, log);
  const sent = merged.filter((delivery) => delivery.ok).length;
  const refused = merged.length - sent;
  log(`reminder ${spec.name} ${latest.key}: retried; sent ${String(sent)}, refused ${String(refused)}`);
  return [{ kind: 'retried', name: spec.name, key: latest.key, sent, refused }];
}

function contextOf(spec: ReminderSpec, due: string): DaemonDirectContext {
  return { reminder: spec.name, due, recipients: spec.targets.map((target) => target.recipient) };
}

/**
 * Sends to every target that still has no delivered result, in the reminder's own order. A target
 * with a recorded id keeps it; a target never attempted gets none and the sender mints one. A
 * transport that throws is recorded as a refusal with no id, so it is never retried behind a
 * record that does not exist.
 */
async function walk(
  context: DaemonDirectContext,
  now: Date,
  spec: ReminderSpec,
  ids: ReadonlyMap<string, string>,
  prior: ReadonlyMap<string, ReminderDelivery>,
  send: ReminderSend,
): Promise<{ deliveries: ReminderDelivery[]; sent: number; refused: number }> {
  const deliveries: ReminderDelivery[] = [];
  for (const target of spec.targets) {
    const key = targetKey(target.recipient.root, target.recipient.seat);
    const held = prior.get(key);
    const stands = held !== undefined && (held.ok || held.id === null);
    if (stands) continue;
    const id = ids.get(key);
    const result = await attempt(send, context, {
      root: target.recipient.root,
      seat: target.recipient.seat,
      body: target.text,
      ...(id === undefined ? {} : { id }),
    });
    deliveries.push({
      seat: target.recipient.seat,
      root: target.recipient.root,
      ok: result.ok,
      id: result.id,
      why: result.ok ? null : firstLine(result.text),
      at: now.toISOString(),
    });
  }
  const sent = deliveries.filter((delivery) => delivery.ok).length;
  return { deliveries, sent, refused: deliveries.length - sent };
}

async function attempt(send: ReminderSend, context: DaemonDirectContext, request: DaemonDirectRequest): Promise<DaemonDirectResult> {
  try {
    return await send(context, request);
  } catch (error) {
    return { ok: false, code: 1, id: null, staged: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/** The record after a retry: every target's latest known result, in the reminder's own order. */
function mergeDeliveries(
  spec: ReminderSpec,
  prior: ReadonlyMap<string, ReminderDelivery>,
  fresh: readonly ReminderDelivery[],
): ReminderDelivery[] {
  const merged = new Map(prior);
  for (const delivery of fresh) merged.set(targetKey(delivery.root, delivery.seat), delivery);
  return spec.targets
    .map((target) => merged.get(targetKey(target.recipient.root, target.recipient.seat)))
    .filter((delivery): delivery is ReminderDelivery => delivery !== undefined);
}

function settle(
  home: string,
  name: string,
  key: string,
  deliveries: ReminderDelivery[],
  now: Date,
  log: ReminderLog,
): void {
  const wrote = settleReminder(home, name, { key, deliveries, finishedAt: now.toISOString() });
  if (!wrote.ok) log(`reminder ${name} ${key}: the results were not recorded — ${wrote.why}`);
}

function refuse(name: string, why: string, log: ReminderLog): ReminderEvent[] {
  log(`reminder ${name}: ${why}; nothing was sent`);
  return [{ kind: 'refused', name, why }];
}

function targetKey(root: string, seat: string): string {
  return `${root}\u0000${seat}`;
}

function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '');
  const said = line ?? 'the send failed and said nothing';
  return said.length > 200 ? `${said.slice(0, 197)}...` : said;
}

/** A span of time as the log line says it: `42s`, `9m 12s`, `3h 4m`, `2d 5h`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

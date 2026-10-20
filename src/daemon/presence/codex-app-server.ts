// The Codex app-server half of the runtime adapter: maps one measured notification shape onto a
// canonical presence event and stages it as `runtime-event`. The caller owns the connection to
// the app-server; this module only reads a notification it is handed, so no live daemon is
// started, polled or inspected here.
//
// The shapes below were generated on this machine, not recalled: `codex app-server generate-ts
// --out <scratch>` on codex-cli 0.161.0 wrote
//   ServerNotification.ts: export type ServerNotification = { "method": ... } | ...
//     { "method": "thread/status/changed", "params": ThreadStatusChangedNotification } |
//     { "method": "turn/started", "params": TurnStartedNotification } | ...
//     { "method": "turn/completed", "params": TurnCompletedNotification } | ...
//   v2/ThreadStatus.ts: export type ThreadStatus = { "type": "notLoaded" } | { "type": "idle" }
//     | { "type": "systemError" } | { "type": "active", activeFlags: Array<ThreadActiveFlag> };
//   v2/ThreadActiveFlag.ts: export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
//   v2/TurnStartedNotification.ts / TurnCompletedNotification.ts: { threadId: string, turn: Turn };
//   v2/ThreadStatusChangedNotification.ts: { threadId: string, status: ThreadStatus };
//
// The mapping is deliberately narrower than the event list. `thread/closed`, `thread/archived`
// and `thread/deleted` produce no presence word here: a thread leaving the app-server is not a
// measured session end, and a guessed `gone` would outlive the evidence. `notLoaded` and
// `systemError` produce nothing for the same reason. A notification for another thread is set
// aside whole, exactly as a predecessor's binding is: it is not this seat's reading.
//
// A staged `human-wait` stays the seat's last observed state until a measured later event
// (turn started or completed, or a status that is neither waiting flag) stages its own record;
// this module infers no resume from a permission dialog closing.
import { isPresenceBinding, type PresenceEvent } from './contract.ts';
import { stagePresenceRecord } from './spool.ts';

/** The seat's bound Codex thread and the folder its records are staged under. */
export type CodexPresenceInput = {
  stateDir: string;
  session: string;
  seat: string;
  binding: string;
  /** The thread id the seat's recorded session names; every mapped notification must carry it. */
  threadId: string;
};

export type CodexNotificationReading =
  | { kind: 'event'; event: PresenceEvent; raw: string }
  | { kind: 'other-thread' }
  | { kind: 'ignored'; why: string };

export type CodexPresenceOutcome =
  | { kind: 'staged'; event: PresenceEvent; raw: string; path: string }
  | { kind: 'other-thread' }
  | { kind: 'ignored'; why: string }
  | { kind: 'refused'; why: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ignored = (why: string): CodexNotificationReading => ({ kind: 'ignored', why });

/** The status words `ThreadStatus` actually generated, mapped one to one. An unknown `type` is
 *  ignored rather than treated as working. */
function readingOfStatus(status: unknown): CodexNotificationReading {
  if (!isObject(status) || typeof status.type !== 'string') return ignored('the status is not an object with a type');
  if (status.type === 'idle') return { kind: 'event', event: 'turn-end', raw: 'idle' };
  if (status.type === 'notLoaded' || status.type === 'systemError') {
    return ignored(`the status ${status.type} is not a measured presence event`);
  }
  if (status.type !== 'active') return ignored(`the status ${status.type} is not a generated ThreadStatus`);
  const flags = status.activeFlags;
  // The generated type requires the array on every active status. A malformed one is not a
  // working seat by default: it is a reading this build cannot mean.
  if (!Array.isArray(flags) || !flags.every((flag) => typeof flag === 'string')) {
    return ignored('an active status carries no measured activeFlags array');
  }
  if (flags.includes('waitingOnApproval')) {
    return { kind: 'event', event: 'human-wait', raw: 'waitingOnApproval' };
  }
  if (flags.includes('waitingOnUserInput')) {
    return { kind: 'event', event: 'human-wait', raw: 'waitingOnUserInput' };
  }
  return { kind: 'event', event: 'turn-start', raw: 'active' };
}

/**
 * Reads one app-server notification for the seat's bound thread. Anything whose shape was not
 * generated for 0.161.0, or whose thread id is not the bound one, yields no event; the outcome
 * says which so a caller's log keeps the distinction between "not this seat" and "not a
 * presence word".
 */
export function presenceFromCodexNotification(
  notification: unknown,
  threadId: string,
): CodexNotificationReading {
  if (typeof threadId !== 'string' || threadId === '') return ignored('the seat records no thread id to fence on');
  if (!isObject(notification)) return ignored('the notification is not an object');
  const method = notification.method;
  if (typeof method !== 'string') return ignored('the notification names no method');
  if (method !== 'turn/started' && method !== 'turn/completed' && method !== 'thread/status/changed') {
    return ignored(`the notification ${method} is not a measured presence event`);
  }
  const params = notification.params;
  if (!isObject(params)) return ignored(`the notification ${method} carries no params object`);
  if (typeof params.threadId !== 'string') return ignored(`the notification ${method} names no thread`);
  if (params.threadId !== threadId) return { kind: 'other-thread' };
  if (method === 'turn/started') return { kind: 'event', event: 'turn-start', raw: 'turn/started' };
  if (method === 'turn/completed') return { kind: 'event', event: 'turn-end', raw: 'turn/completed' };
  return readingOfStatus(params.status);
}

/** Maps and stages in one call. A refusal from the writer is reported, never repaired; an ignored
 *  notification stages nothing, so the last measured state stands. */
export function stageCodexPresence(input: CodexPresenceInput, notification: unknown): CodexPresenceOutcome {
  if (!isPresenceBinding(input.binding)) return { kind: 'refused', why: 'the seat records no launch binding' };
  const reading = presenceFromCodexNotification(notification, input.threadId);
  if (reading.kind !== 'event') return reading;
  const staged = stagePresenceRecord(input.stateDir, {
    session: input.session,
    seat: input.seat,
    binding: input.binding,
    source: 'runtime-event',
    event: reading.event,
    raw: reading.raw,
  });
  if (staged.kind === 'refused') return staged;
  return { kind: 'staged', event: reading.event, raw: reading.raw, path: staged.path };
}

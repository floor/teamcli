// The recorded app-server endpoint, read by every consumer through one strict, pure door.
//
// A managed Codex launch starts an app-server it owns on an explicit unix socket under the team
// state folder and records it on the seat's state record (`codex_endpoint`). Presence hosting,
// direct send and anything else that has to reach this seat's thread must use the same exact URL,
// so they share this reader rather than each inventing a validator: the record is usable only
// while its `binding` equals the seat's current `presence_binding`, its URL is an absolute
// `unix:///…` endpoint, and its pid and start instant are ones this build could have written.
// Anything else is unknown — never repaired, never replaced by a guessed `~/.codex` path.
//
// A consumer that reports what it found asks the classifying door (`inspectRecordedCodexEndpoint`)
// and is told absent from invalid; one that only needs the endpoint uses the strict reader
// (`readRecordedCodexEndpoint`). Both apply the same checks.
import { isPresenceBinding, isPresenceTime } from './contract.ts';

export type CodexEndpointRecord = {
  url: string;
  binding: string;
  pid: number;
  started_at: string;
};

/** The absolute socket path a record's URL names, when it names one this build can use. */
export function codexEndpointPath(record: CodexEndpointRecord): string | null {
  if (!record.url.startsWith('unix:///')) return null;
  const path = record.url.slice('unix://'.length);
  if (!path.startsWith('/')) return null;
  // A control character would split the path in a launch line or a process listing; no path this
  // build writes contains one.
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path;
}

/** One record exactly as a managed launch writes it, without judging the binding it names: the
 *  launch's own predecessor cleanup reads this shape, because a predecessor's binding is by
 *  definition not the current one. Consumers use `readRecordedCodexEndpoint` instead. */
export function readCodexEndpointRecord(value: unknown): CodexEndpointRecord | null {
  const checked = checkCodexEndpointRecord(value);
  return checked.ok ? checked.record : null;
}

/** Why a record is not one this build could have written, for a caller that reports what it
 *  found rather than only whether it found one. */
type RecordCheck = { ok: true; record: CodexEndpointRecord } | { ok: false; why: string };

function checkCodexEndpointRecord(value: unknown): RecordCheck {
  // An array is an object; it is not a record. Neither is anything a launch did not write.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, why: 'the endpoint record is not an object' };
  }
  const one = value as Partial<CodexEndpointRecord>;
  if (typeof one.binding !== 'string' || !isPresenceBinding(one.binding)) {
    return { ok: false, why: 'the endpoint record names no valid presence binding' };
  }
  if (typeof one.url !== 'string') return { ok: false, why: 'the endpoint record has no URL' };
  // A pid this build could have written is a positive safe integer; anything else cannot name
  // a process, and a value past the safe range would silently become another number.
  if (typeof one.pid !== 'number' || !Number.isSafeInteger(one.pid) || one.pid <= 0) {
    return { ok: false, why: 'the endpoint record names no positive integer process' };
  }
  if (typeof one.started_at !== 'string' || !isPresenceTime(one.started_at)) {
    return { ok: false, why: 'the endpoint record’s start instant is not a contract timestamp' };
  }
  const record: CodexEndpointRecord = {
    url: one.url,
    binding: one.binding,
    pid: one.pid,
    started_at: one.started_at,
  };
  if (codexEndpointPath(record) === null) {
    return { ok: false, why: 'the endpoint record’s URL is not an absolute unix endpoint' };
  }
  return { ok: true, record };
}

/** What a consumer found when it looked for a seat's recorded endpoint. `absent` is a seat no
 *  managed launch has recorded one for — its native presence is unproven, and no shared daemon
 *  endpoint is guessed in its place. `invalid` is a record this build cannot use: the seat's
 *  current binding is not one, the record names another binding, or the record itself is not
 *  one a launch could have written. Both are unproven; the two are told apart so a caller can
 *  say which it saw. */
export type RecordedCodexEndpoint =
  | { kind: 'absent' }
  | { kind: 'invalid'; why: string }
  | { kind: 'ok'; record: CodexEndpointRecord };

/** The classifying door: the same strict checks as `readRecordedCodexEndpoint`, with the reason
 *  an unusable record is unusable. */
export function inspectRecordedCodexEndpoint(
  value: unknown,
  binding: unknown,
): RecordedCodexEndpoint {
  if (value === undefined || value === null) return { kind: 'absent' };
  const checked = checkCodexEndpointRecord(value);
  if (!checked.ok) return { kind: 'invalid', why: checked.why };
  if (!isPresenceBinding(binding)) {
    return { kind: 'invalid', why: 'the seat records no valid current presence binding' };
  }
  if (checked.record.binding !== binding) {
    return { kind: 'invalid', why: 'the endpoint record names another presence binding' };
  }
  return { kind: 'ok', record: checked.record };
}

/** One record exactly as a managed launch writes it, for the seat's current binding, or null. */
export function readRecordedCodexEndpoint(
  value: unknown,
  binding: unknown,
): CodexEndpointRecord | null {
  const read = inspectRecordedCodexEndpoint(value, binding);
  return read.kind === 'ok' ? read.record : null;
}

// The presence contract: the four words a seat's status can carry, the sources a word can come
// from, and the runtime events that establish them. The vocabulary is deliberately small and
// literal — a settings-file hook, an app-server/ACP adapter and the daemon's own launch record
// all write the same record shape, so one projection can answer for every runtime without a
// screen read. `terminal-host` is a source a *reader* may label a fallback reading with; no
// writer accepts it, and this module never produces one.
//
// The words here are their own namespace, separate from the seat-state words a terminal shows
// (`src/labels/state.ts`); a reader that maps one onto the other does so in the display layer,
// not in the record a runtime writes.
//
// Every record also carries `binding`: the runtime incarnation it was emitted by, minted by the
// managing launch and stored in that seat's state record (`presence_binding`). A session+seat
// pair is reused across launches, so it is never enough to identify one process: a late Stop from
// a predecessor must not flip a successor working seat to idle. The binding is internal state,
// not a credential or a public identity; it is compared whole.
import { randomBytes } from 'node:crypto';

/** The four presence words, exactly these bytes. */
export const PRESENCE_STATES = ['working', 'idle', 'waiting-for-a-person', 'gone'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Where a reading came from. `terminal-host` is the labelled fallback only. */
export const PRESENCE_SOURCES = ['runtime-hook', 'runtime-event', 'daemon-launch', 'terminal-host'] as const;
export type PresenceSource = (typeof PRESENCE_SOURCES)[number];

/** A source a writer may put in a record. A terminal classification is never evidence a runtime
 *  wrote, so it is not in this list and a spool record naming it is rejected. */
export const PRESENCE_WRITER_SOURCES = ['runtime-hook', 'runtime-event', 'daemon-launch'] as const;
export type PresenceWriterSource = (typeof PRESENCE_WRITER_SOURCES)[number];

/** The canonical events. A runtime adapter maps its own word onto one of these before writing;
 *  the raw word is carried alongside for the log. */
export const PRESENCE_EVENTS = ['turn-start', 'turn-end', 'human-wait', 'session-end'] as const;
export type PresenceEvent = (typeof PRESENCE_EVENTS)[number];

/** The one mapping from an event to the state it establishes. */
export const PRESENCE_STATE_OF: Readonly<Record<PresenceEvent, PresenceState>> = {
  'turn-start': 'working',
  'turn-end': 'idle',
  'human-wait': 'waiting-for-a-person',
  'session-end': 'gone',
};

/** The record format. A future shape is a new number, never a reinterpreted field. */
export const PRESENCE_FORMAT = 1;

/** An id is also the spool file's stem: `<event time>-<8 lowercase hex>`. It is chosen by the
 *  writer, never derived from anything a reader controls, and it is what a replay is deduped by. */
export const PRESENCE_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z-[0-9a-f]{8}$/;

/** A runtime incarnation minted by the managing launch: `prs_<12 lowercase hex>`. It is compared
 *  whole against the seat's current `presence_binding`; a mismatch means the emitter is a
 *  predecessor, not a spoof to be repaired. */
export const PRESENCE_BINDING = /^prs_[0-9a-f]{12}$/;

/** A future event is accepted only this far ahead of the daemon's clock — the same tolerance the
 *  CLI-hook reading uses. A far-future timestamp would otherwise pin a projection until the wall
 *  clock caught up. */
export const PRESENCE_FUTURE_SKEW_MS = 60_000;

/** The timestamp form both writers and adapters use: UTC, one `T`, a trailing `Z`, and at most
 *  milliseconds. The parts are captured so the calendar can be checked without trusting a
 *  runtime's lenient parser (`2026-02-30` is accepted and rolled over by some engines). */
const PRESENCE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/** A record a hook or adapter stages in the spool. */
export type PresenceRecord = {
  v: typeof PRESENCE_FORMAT;
  id: string;
  ts: string;
  session: string;
  seat: string;
  /** The runtime incarnation the emitting process belongs to. */
  binding: string;
  source: PresenceWriterSource;
  event: PresenceEvent;
  /** The runtime's own word, kept for the daemon log; the contract never keys on it. */
  raw?: string;
};

/** One line of the daemon-owned `events.jsonl`. `state` is the mapping of `event`; `observedAt`
 *  is the daemon's ingest instant, so ingest lag is visible beside the runtime's own `ts`.
 *  `applied` is true only for the line that became the projection when it was appended: an older
 *  event that arrived late is kept for the audit with `applied: false`, and a consumer walking
 *  transitions must advance activity only on applied lines, exactly as the projection did. */
export type PresenceLogLine = PresenceRecord & {
  seq: number;
  observedAt: string;
  state: PresenceState;
  applied: boolean;
};

/** The projection the daemon replaces atomically in `current.json`, and the shape a reader gets. */
export type PresenceReading = {
  v: typeof PRESENCE_FORMAT;
  seq: number;
  id: string;
  state: PresenceState;
  source: PresenceWriterSource;
  event: PresenceEvent;
  raw?: string;
  binding: string;
  /** The winning event's own instant, never the ingest instant. */
  since: string;
  observedAt: string;
};

export function isPresenceState(value: unknown): value is PresenceState {
  return typeof value === 'string' && (PRESENCE_STATES as readonly string[]).includes(value);
}

export function isPresenceWriterSource(value: unknown): value is PresenceWriterSource {
  return typeof value === 'string' && (PRESENCE_WRITER_SOURCES as readonly string[]).includes(value);
}

export function isPresenceEvent(value: unknown): value is PresenceEvent {
  return typeof value === 'string' && (PRESENCE_EVENTS as readonly string[]).includes(value);
}

export function isPresenceBinding(value: unknown): value is string {
  return typeof value === 'string' && PRESENCE_BINDING.test(value);
}

/** Whether a string is a timestamp this contract accepts: the UTC form above and a real
 *  calendar instant, checked part by part rather than through `Date.parse`. */
export function isPresenceTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = PRESENCE_TIME.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/** Whether an event instant is too far ahead of `now` to be trusted. A value that is not a
 *  contract timestamp at all is also a refusal. */
export function presenceFutureBeyond(ts: unknown, now: Date): boolean {
  if (!isPresenceTime(ts)) return true;
  return Date.parse(ts) - now.getTime() > PRESENCE_FUTURE_SKEW_MS;
}

/** A fresh runtime incarnation binding. */
export function mintPresenceBinding(): string {
  return `prs_${randomBytes(6).toString('hex')}`;
}

/** A fresh id for an event instant: `<ts>-<8 lowercase hex>`. `nonce` is injectable so a test can
 *  pin the bytes; production callers leave it out. */
export function presenceId(ts: string, nonce?: string): string | null {
  if (!isPresenceTime(ts)) return null;
  const bytes = nonce ?? randomBytes(4).toString('hex');
  if (!/^[0-9a-f]{8}$/.test(bytes)) return null;
  return `${ts}-${bytes}`;
}

/** Builds a record, filling `v` and `id`. A caller that already has an id (a replay, or a hook
 *  that made its own) passes it to keep the bytes stable. Returns null for input the contract
 *  does not allow, so a writer cannot stage a record the ingester would have to repair. */
export function presenceRecordOf(input: {
  ts: string;
  session: string;
  seat: string;
  binding: string;
  source: PresenceWriterSource;
  event: PresenceEvent;
  raw?: string;
  id?: string;
}): PresenceRecord | null {
  const id = input.id ?? presenceId(input.ts);
  if (id === null || !PRESENCE_ID.test(id)) return null;
  if (!isPresenceTime(input.ts)) return null;
  if (typeof input.session !== 'string' || input.session === '') return null;
  if (typeof input.seat !== 'string' || input.seat === '') return null;
  if (!isPresenceBinding(input.binding)) return null;
  if (!isPresenceWriterSource(input.source)) return null;
  if (!isPresenceEvent(input.event)) return null;
  const record: PresenceRecord = {
    v: PRESENCE_FORMAT,
    id,
    ts: input.ts,
    session: input.session,
    seat: input.seat,
    binding: input.binding,
    source: input.source,
    event: input.event,
  };
  if (input.raw !== undefined) {
    if (typeof input.raw !== 'string' || input.raw === '' || input.raw.length > 80) return null;
    record.raw = input.raw;
  }
  return record;
}

export type PresenceRecordRead =
  | { kind: 'ok'; record: PresenceRecord }
  | { kind: 'bad'; why: string };

/** Seeds the fields common to a spool record, a log line and a projection. Each reader then
 *  checks its own extra fields, so a shape this build cannot mean is refused whole. */
function commonOf(value: Record<string, unknown>): PresenceRecord | string {
  if (value.v !== PRESENCE_FORMAT) return 'the record format is not 1';
  if (typeof value.id !== 'string' || !PRESENCE_ID.test(value.id)) {
    return 'the record id is not <event time>-<8 lowercase hex>';
  }
  if (!isPresenceTime(value.ts)) return 'the record ts is not a UTC instant';
  if (typeof value.session !== 'string' || value.session === '') return 'the record names no session';
  if (typeof value.seat !== 'string' || value.seat === '') return 'the record names no seat';
  if (!isPresenceBinding(value.binding)) return 'the record binding is not prs_<12 lowercase hex>';
  if (!isPresenceWriterSource(value.source)) {
    return 'the record source is not a runtime or daemon source';
  }
  if (!isPresenceEvent(value.event)) return 'the record names no contract event';
  if (value.raw !== undefined) {
    if (typeof value.raw !== 'string' || value.raw === '' || value.raw.length > 80) {
      return 'the record raw word is not a short non-empty string';
    }
  }
  const record: PresenceRecord = {
    v: PRESENCE_FORMAT,
    id: value.id,
    ts: value.ts,
    session: value.session,
    seat: value.seat,
    binding: value.binding,
    source: value.source,
    event: value.event,
  };
  if (value.raw !== undefined) record.raw = value.raw;
  return record;
}

function objectOf(text: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'the record is not JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'the record is not a JSON object';
  }
  return parsed as Record<string, unknown>;
}

/** Reads one spool file's text as a record. Every field is checked; anything this build cannot
 *  mean is `bad`, with a reason the ingester can log before moving the file aside. */
export function readPresenceRecord(text: string): PresenceRecordRead {
  const value = objectOf(text);
  if (typeof value === 'string') return { kind: 'bad', why: value };
  const common = commonOf(value);
  if (typeof common === 'string') return { kind: 'bad', why: common };
  return { kind: 'ok', record: common };
}

/** Reads one `events.jsonl` line. The line's `state` must be the mapping of its own event, so a
 *  hand-edited state can never be served as a runtime reading. */
export function readPresenceLogLine(text: string): PresenceLogLine | { why: string } {
  const value = objectOf(text);
  if (typeof value === 'string') return { why: value };
  const common = commonOf(value);
  if (typeof common === 'string') return { why: common };
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 1) {
    return { why: 'the line seq is not a positive integer' };
  }
  if (!isPresenceTime(value.observedAt)) return { why: 'the line observedAt is not a UTC instant' };
  if (!isPresenceState(value.state)) return { why: 'the line state is not a presence word' };
  if (PRESENCE_STATE_OF[common.event] !== value.state) {
    return { why: 'the line state does not match its event' };
  }
  if (typeof value.applied !== 'boolean') return { why: 'the line applied flag is not a boolean' };
  return {
    ...common, seq: value.seq, observedAt: value.observedAt, state: value.state, applied: value.applied,
  };
}

export type PresenceReadingRead =
  | { kind: 'ok'; reading: PresenceReading }
  | { kind: 'bad'; why: string };

/** Reads `current.json`. A projection this build cannot mean is refused whole rather than
 *  repaired: a reader showing a guessed state is worse than a labelled fallback. The projection
 *  is not a log line: it carries `since` (the event's own instant) instead of the record's `ts`
 *  and names no session or seat, because the reader already addressed both. */
export function readPresenceReading(text: string): PresenceReadingRead {
  const value = objectOf(text);
  if (typeof value === 'string') return { kind: 'bad', why: value };
  if (value.v !== PRESENCE_FORMAT) return { kind: 'bad', why: 'the projection format is not 1' };
  if (typeof value.id !== 'string' || !PRESENCE_ID.test(value.id)) {
    return { kind: 'bad', why: 'the projection id is not <event time>-<8 lowercase hex>' };
  }
  if (!isPresenceBinding(value.binding)) {
    return { kind: 'bad', why: 'the projection binding is not prs_<12 lowercase hex>' };
  }
  if (!isPresenceWriterSource(value.source)) {
    return { kind: 'bad', why: 'the projection source is not a runtime or daemon source' };
  }
  if (!isPresenceEvent(value.event)) return { kind: 'bad', why: 'the projection names no contract event' };
  if (value.raw !== undefined) {
    if (typeof value.raw !== 'string' || value.raw === '' || value.raw.length > 80) {
      return { kind: 'bad', why: 'the projection raw word is not a short non-empty string' };
    }
  }
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 1) {
    return { kind: 'bad', why: 'the projection seq is not a positive integer' };
  }
  if (!isPresenceTime(value.observedAt)) return { kind: 'bad', why: 'the projection observedAt is not a UTC instant' };
  if (!isPresenceState(value.state)) return { kind: 'bad', why: 'the projection state is not a presence word' };
  if (PRESENCE_STATE_OF[value.event] !== value.state) {
    return { kind: 'bad', why: 'the projection state does not match its event' };
  }
  if (!isPresenceTime(value.since)) return { kind: 'bad', why: 'the projection since is not a UTC instant' };
  const reading: PresenceReading = {
    v: PRESENCE_FORMAT,
    seq: value.seq,
    id: value.id,
    state: value.state,
    source: value.source,
    event: value.event,
    binding: value.binding,
    since: value.since,
    observedAt: value.observedAt,
  };
  if (value.raw !== undefined) reading.raw = value.raw;
  return { kind: 'ok', reading };
}

/** `a` is newer than `b`, or the same instant with a later id. ISO strings are not compared
 *  lexically: `…:00Z` and `…:00.500Z` order wrongly as text. Equal `(ts, id)` is not newer, so a
 *  replay never replaces its own projection. */
export function presenceNewer(a: { ts: string; id: string }, b: { ts: string; id: string }): boolean {
  const at = Date.parse(a.ts);
  const bt = Date.parse(b.ts);
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

/** The route ingester's channel words. This is liveness of the *reader's* channel, never a TTL
 *  for a native state: a reading stands at `idle` for as long as no newer event arrives, whether
 *  the channel is serving or not. */
export const PRESENCE_CHANNEL_STATES = ['starting', 'serving', 'failed', 'stopped'] as const;
export type PresenceChannelState = (typeof PRESENCE_CHANNEL_STATES)[number];

/** `status.json` under the session folder. `pid` names the daemon process that wrote it, and
 *  `heartbeatAt` is this file's own last write: a reader qualifies `serving` with the daemon's
 *  current ownership or a live RPC answer, never with this file alone. */
export type PresenceStatus = {
  v: typeof PRESENCE_FORMAT;
  session: string;
  state: PresenceChannelState;
  pid: number;
  startedAt: string;
  lastStepAt: string;
  lastSuccessAt: string | null;
  heartbeatAt: string;
  error: string | null;
  stoppedAt: string | null;
};

export type PresenceStatusRead =
  | { kind: 'ok'; status: PresenceStatus }
  | { kind: 'bad'; why: string };

/** Reads `status.json`. A malformed channel record is refused whole; health is never guessed. */
export function readPresenceStatus(text: string): PresenceStatusRead {
  const value = objectOf(text);
  if (typeof value === 'string') return { kind: 'bad', why: value };
  if (value.v !== PRESENCE_FORMAT) return { kind: 'bad', why: 'the status format is not 1' };
  if (typeof value.session !== 'string' || value.session === '') return { kind: 'bad', why: 'the status names no session' };
  if (!(PRESENCE_CHANNEL_STATES as readonly unknown[]).includes(value.state)) {
    return { kind: 'bad', why: 'the status channel word is not a contract word' };
  }
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) {
    return { kind: 'bad', why: 'the status pid is not a positive integer' };
  }
  for (const key of ['startedAt', 'lastStepAt', 'heartbeatAt'] as const) {
    if (!isPresenceTime(value[key])) return { kind: 'bad', why: `the status ${key} is not a UTC instant` };
  }
  for (const key of ['lastSuccessAt', 'stoppedAt'] as const) {
    if (value[key] !== null && !isPresenceTime(value[key])) {
      return { kind: 'bad', why: `the status ${key} is neither null nor a UTC instant` };
    }
  }
  if (value.error !== null && (typeof value.error !== 'string' || value.error === '' || value.error.length > 500)) {
    return { kind: 'bad', why: 'the status error is neither null nor a short non-empty string' };
  }
  return {
    kind: 'ok',
    status: {
      v: PRESENCE_FORMAT,
      session: value.session,
      state: value.state as PresenceChannelState,
      pid: value.pid,
      startedAt: value.startedAt as string,
      lastStepAt: value.lastStepAt as string,
      lastSuccessAt: value.lastSuccessAt as string | null,
      heartbeatAt: value.heartbeatAt as string,
      error: value.error as string | null,
      stoppedAt: value.stoppedAt as string | null,
    },
  };
}

/** Whether a reading may be shown as live. The caller supplies `channelHealthy` from the daemon's
 *  current ownership, fixed heartbeat or a live RPC answer — never from `status.json` alone — and
 *  the seat's current `presence_binding`. A false answer means *last known*, not stale-by-age:
 *  `state` never expires, and a reader must not change it by elapsed time. */
export function presenceLive(
  reading: PresenceReading,
  currentBinding: string | null,
  channelHealthy: boolean,
): boolean {
  return channelHealthy && currentBinding !== null && reading.binding === currentBinding;
}

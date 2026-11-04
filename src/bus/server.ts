// The event bus service over `.agents/bus.sock` (RFC 002 Amendment 01 §4.2, §4.4).
//
// A dedicated process beside the broker with its own Unix domain socket (`.agents/bus.sock`,
// mode 0600), start lock (`.agents/bus.sock.lock`), and stale-socket recovery. Supports three
// operations:
// - `publish`: appends a signed event record to `events.jsonl` and fans it out to matching
//   live subscribers with bounded per-subscriber buffers. A `message.arrived` is the one kind
//   that names a delivery, so it is verified against its signed drop record before it is
//   appended and fanned out; the other kinds are appended as published.
// - `nudge`: names one record in a seat's drop folder; the bus re-reads and verifies the signed
//   record itself, then appends its `message.arrived` and fans it out. A missing, unsigned or
//   misaddressed record delivers nothing, and the nudge carries no authority of its own.
// - `subscribe`: validates the subscriber and any self-subscribed `kinds` against the
//   privileged-kind ban (`privileged-self-subscription`, raising `team.policy-refused` on
//   violation), reads unseen events from `cursor`, answers `gap` with `oldest_seq` when the
//   cursor was rotated out or the subscriber's buffer overflowed, and either returns the batch
//   (`follow: false`) or streams live events (`follow: true`).
// Runs an initial `reconcilePass` on startup and every `reconcileIntervalMs` thereafter.
import {
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalTeam } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { logLine } from '../log.ts';
import { findAgent, getAgent, isAgentId } from '../registry/agents.ts';
import { readStoredTeamConfig } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';
import { approvalStanding, approvedRecordOf } from '../store/store.ts';
import {
  checkPrivilegedSelfSubscription,
  DEFAULT_RECONCILE_INTERVAL_SECONDS,
  DEFAULT_SUBSCRIBER_BUFFER_LIMIT,
  isEventKind,
  leadSeatsOf,
  policyRefusedEvent,
  PRIVILEGED_SELF_SUBSCRIPTION_RULE,
  recipientsForEvent,
  refusalRecord,
  type EventKind,
  type TeamRoutingRoles,
} from './kinds.ts';
import {
  appendEvent,
  parseEventPayload,
  parseSignedEventLine,
  pruneEventLog,
  readEventsFromCursorSliced,
  verifyEventLogSeals,
  type CursorReadResult,
  type EventAppendInput,
  type SignedEventRecord,
} from './log.ts';
import { eventLogSettingsFor } from './log-settings.ts';
import { createReconcileState, reconcilePassAsync } from './reconcile.ts';
import { readEntityOrchestrator, readSeatResolver } from './seats.ts';
import { makeWebhookDelivery, type WebhookFacts } from './webhook.ts';
import { recordWebhookDelivery } from './webhook-record.ts';
import type { SeatRecipientResolver } from './kinds.ts';
import { RECORD_NAME, verifiedArrival } from './arrival.ts';

/** The serving bus's process marker, beside its socket. */
export function busMarkerPath(root: string): string {
  return join(root, '.agents', 'bus.pid');
}

export type BusMarker = { pid: number; started: string };

function writeBusMarker(root: string, at: Date): void {
  try {
    writeFileSync(busMarkerPath(root), `${JSON.stringify({ pid: process.pid, started: at.toISOString() })}\n`, { mode: 0o600 });
  } catch {
    // A marker that cannot be written leaves status unable to name the bus; the bus still serves.
  }
}

function clearBusMarker(root: string): void {
  try {
    const held = readBusMarker(root);
    if (held !== null && held.pid === process.pid) unlinkSync(busMarkerPath(root));
  } catch {
    // Already gone.
  }
}

export function readBusMarker(root: string): BusMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(busMarkerPath(root), 'utf8')) as Partial<BusMarker>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || typeof parsed.started !== 'string') return null;
    return { pid: parsed.pid, started: parsed.started };
  } catch {
    return null;
  }
}

/** The bus as status and check read it: serving (its marker's pid lives), dead (a marker whose
 *  pid is gone), or absent (no marker). */
export function busHealth(root: string, alive: (pid: number) => boolean): { kind: 'running'; pid: number } | { kind: 'dead'; pid: number } | { kind: 'absent' } {
  const marker = readBusMarker(root);
  if (marker === null) return { kind: 'absent' };
  return alive(marker.pid) ? { kind: 'running', pid: marker.pid } : { kind: 'dead', pid: marker.pid };
}

export function busSocket(root: string): string {
  return join(root, '.agents', 'bus.sock');
}

export const MAX_BUS_REQUEST_BYTES = 128 * 1024;
export const MAX_BUS_ANSWER_BYTES = 4 * 1024 * 1024;
export const BUS_DEADLINE_MS = 5000;

export const BUS_NOT_RUNNING = 'the event bus is not running; the owner starts it with `team bus`';

export type BusPublishRequest = {
  op: 'publish';
  event: EventAppendInput;
};

/** The one thing a nudge may name: a record the bus re-reads and verifies itself. */
export type BusNudgeRequest = {
  op: 'nudge';
  session: string;
  seat: string;
  record_id: string;
};

export type BusSubscribeRequest = {
  op: 'subscribe';
  seat: string;
  pane?: string;
  cursor: number;
  kinds?: EventKind[];
  follow?: boolean;
};

export type BusRequest = BusPublishRequest | BusNudgeRequest | BusSubscribeRequest;

export type BusAnswer =
  | { ok: true; kind: 'published'; event: SignedEventRecord; duplicate: boolean }
  | { ok: true; kind: 'nudged'; event: SignedEventRecord | null; duplicate: boolean }
  | { ok: true; kind: 'events'; events: SignedEventRecord[]; cursor: number }
  | { ok: true; kind: 'event'; event: SignedEventRecord }
  | {
      ok: true;
      kind: 'gap';
      oldest_seq: number;
      newest_seq: number;
      /** Set when retained drop records cover the missing window: the hole is retention. */
      reason?: 'retention';
      dropped_oldest_seq?: number;
      dropped_newest_seq?: number;
    }
  | {
      ok: false;
      at: 'caller' | 'policy' | 'write';
      message: string;
      rule?: string;
      kind?: EventKind;
    };

export type StartBusInput = {
  root: string;
  team: TeamFile;
  home?: string;
  stderr: (text: string) => void;
  reconcileIntervalMs?: number;
  /** The owner's held threshold (`event-held-threshold-seconds`); the release default when absent. */
  heldThresholdSeconds?: number;
  bufferLimit?: number;
  maxLogBytes?: number;
  keptLogFiles?: number;
  maxTotalLogBytes?: number;
  retentionSeconds?: number;
  extraPrivilegedKinds?: readonly EventKind[];
  additiveRouting?: Partial<Record<EventKind, readonly string[]>>;
  now?: () => Date;
  /** The folder of the team file: the state beside it records each seat's last webhook delivery,
   *  which `team check` and `team status` note. Absent, a delivery's facts go to `stderr` alone. */
  stateDir?: string;
  /** The webhook delivery every fanned-out record passes through: the built-in adapter reads
   *  each seat's configured adapter row and re-reads it when the root's registry record changes;
   *  a caller may inject its own for a scene, and that one is the caller's to refresh. */
  deliver?: (record: SignedEventRecord) => void;
  /**
   * What the start does with the first reconcile pass. `await` (the default) runs it before the
   * start resolves, so a bus a command started itself is caught up when it reports serving.
   * `background` starts the same pass once the listener is bound and resolves without waiting
   * for it: a host that brings up several roots does not serialize them behind one store's scan.
   * The pass stays joinable through `reconcileNow` and every caller owns it until `close`, which
   * aborts and drains it. `firstPass` says how far it has got in either mode.
   */
  initialReconcile?: 'await' | 'background';
};

/**
 * How far the bus's first reconcile pass has got. While it runs, `scanned` is live: the files
 * the pass has read or reused so far. Once it settles, `scanned` is the pass's total and
 * `doneAt` is the instant it settled; `errors` says whether the walk finished or stopped on a
 * failure, so a reader never prints a partial pass as a clean finish. A reader prints this beside
 * a serving bus so that "serving" (bound and answering) is never read as "the store is caught up".
 * A pass `close` aborted settles nothing: it is never reported as done.
 */
export type BusFirstPass =
  | { running: true; scanned: number; doneAt: null }
  | { running: false; scanned: number; doneAt: string; errors: boolean };

export type BusHandle = {
  close(): Promise<void>;
  /** The pass in flight, or a new one started now; the pass yields between slices, so a caller
   *  that does not await it does not stop the bus's own answers. */
  reconcileNow(): Promise<SignedEventRecord[]>;
  /** The first pass's progress. A second pass never rewrites it: the first pass's total and its
   *  settle instant stay, so a reader is not sent back to "running" by a later scan. */
  firstPass(): BusFirstPass;
};

export type StartBusResult =
  | { kind: 'serving'; cleared: boolean; handle: BusHandle }
  | { kind: 'busy' }
  | { kind: 'bind-failed'; code?: string }
  | { kind: 'locked' };

const REQUEST_IDLE_MS = 5000;
const START_WALKS = 8;
const STALE_CONFIRM_MS = 50;
/** How long a liveness probe waits for a unix-socket connect. A path that neither connects nor
 *  refuses within the bound is unreachable: the probe answers so, and a start walk that reaches
 *  one attempts its own bind, which fails while a listener still holds the path. */
const PROBE_TIMEOUT_MS = 400;
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;
const LOCK_YOUNG_MS = 1000;
const UNKNOWN_REQUEST = 'the request is not one this bus knows';
/** A published arrival is refused with fixed words when the record it names does not verify. */
const UNVERIFIED_ARRIVAL = 'the message.arrived it publishes names no signed drop record for its seat';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(path: string): number {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : NaN;
  } catch {
    return NaN;
  }
}

function young(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < LOCK_YOUNG_MS;
  } catch {
    return false;
  }
}

function stillJudged(path: string, dev: number, ino: number, seen: number): boolean {
  const now = lstatSync(path, { throwIfNoEntry: false });
  if (now === undefined || now.dev !== dev || now.ino !== ino) return false;
  const pid = readPid(path);
  return Number.isNaN(seen) ? Number.isNaN(pid) : pid === seen;
}

function sweepTemps(lockPath: string): void {
  let names: string[];
  try {
    names = readdirSync(dirname(lockPath));
  } catch {
    return;
  }
  const prefix = `${basename(lockPath)}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.new')) continue;
    const pid = Number(name.slice(prefix.length, -'.new'.length).split('.').pop());
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try {
      unlinkSync(join(dirname(lockPath), name));
    } catch {}
  }
}

function createOwned(path: string): { dev: number; ino: number } {
  const tmp = `${path}.${process.pid}.new`;
  try {
    unlinkSync(tmp);
  } catch {}
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${process.pid}\n`);
    const held = fstatSync(fd);
    linkSync(tmp, path);
    return { dev: held.dev, ino: held.ino };
  } finally {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

async function takeOver(path: string): Promise<void> {
  const claim = `${path}.takeover`;
  for (let tries = 0; tries < 8; tries++) {
    let claimed: { dev: number; ino: number };
    try {
      claimed = createOwned(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const judged = lstatSync(claim, { throwIfNoEntry: false });
      if (judged !== undefined) {
        const taker = readPid(claim);
        if (!Number.isNaN(taker) && alive(taker)) {
          await new Promise((tick) => setTimeout(tick, 20));
          return;
        }
        if (Number.isNaN(taker) && young(claim)) {
          await new Promise((tick) => setTimeout(tick, 20));
          return;
        }
        if (stillJudged(claim, judged.dev, judged.ino, taker)) {
          try {
            unlinkSync(claim);
          } catch {}
        }
      }
      continue;
    }
    if (readPid(claim) !== process.pid) {
      await new Promise((tick) => setTimeout(tick, 20));
      return;
    }
    const judged = lstatSync(path, { throwIfNoEntry: false });
    if (judged !== undefined) {
      const holder = readPid(path);
      const live = !Number.isNaN(holder) && alive(holder);
      const landing = Number.isNaN(holder) && young(path);
      if (!live && !landing) {
        if (readPid(claim) === process.pid && stillJudged(path, judged.dev, judged.ino, holder)) {
          try {
            unlinkSync(path);
          } catch {}
        }
      }
    }
    const held = lstatSync(claim, { throwIfNoEntry: false });
    if (held !== undefined && held.dev === claimed.dev && held.ino === claimed.ino && readPid(claim) === process.pid) {
      try {
        unlinkSync(claim);
      } catch {}
    }
    return;
  }
}

async function acquireStartLock(path: string): Promise<{ kind: 'held'; release: () => void } | { kind: 'timeout' }> {
  mkdirSync(dirname(path), { recursive: true });
  sweepTemps(path);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (Date.now() > deadline) return { kind: 'timeout' };
    try {
      const held = createOwned(path);
      return {
        kind: 'held',
        release: () => {
          try {
            const current = lstatSync(path, { throwIfNoEntry: false });
            if (!current || current.dev !== held.dev || current.ino !== held.ino) return;
            if (readPid(path) !== process.pid) return;
            unlinkSync(path);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readPid(path);
      if (!Number.isNaN(holder) && alive(holder)) {
        await new Promise((tick) => setTimeout(tick, LOCK_POLL_MS));
        continue;
      }
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (Number.isNaN(holder) && age < LOCK_YOUNG_MS) {
        await new Promise((tick) => setTimeout(tick, 20));
        continue;
      }
      await takeOver(path);
    }
  }
}

type Probe = 'live' | 'stale' | 'none';

function probeSocket(path: string): Promise<Probe> {
  return new Promise((done) => {
    const socket = connect(path);
    let settled = false;
    const settle = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(probe);
    };
    // A connect that neither completes nor errors would otherwise wait forever, and `busListening`
    // and the start walk both await it. The bound answers unreachable instead.
    const timer = setTimeout(() => {
      socket.destroy();
      settle('none');
    }, PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      settle('live');
    });
    socket.once('error', (error) => {
      socket.destroy();
      settle((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'none');
    });
  });
}

/** Whether a bus is accepting connections on this checkout's socket. A stale or missing file is not. */
export async function busListening(root: string): Promise<boolean> {
  return (await probeSocket(busSocket(root))) === 'live';
}

export function encodeBusLine(value: BusRequest | BusAnswer): string {
  return `${JSON.stringify(value)}\n`;
}

function safeName(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 200) return null;
  if (value.includes('\n') || value.includes('\r') || value.includes('\0')) return null;
  return value;
}

export function parseBusRequest(line: string): BusRequest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.op === 'publish') {
    const keys = Object.keys(obj);
    if (keys.length !== 2 || !keys.every((k) => k === 'op' || k === 'event')) return null;
    if (!obj.event || typeof obj.event !== 'object' || Array.isArray(obj.event)) return null;
    const candidate = { v: 1, seq: 1, ...(obj.event as Record<string, unknown>) };
    const parsed = parseEventPayload(candidate);
    if (parsed === null) return null;
    const { v: _v, seq: _seq, ...rest } = parsed;
    return { op: 'publish', event: rest };
  }

  if (obj.op === 'nudge') {
    const keys = Object.keys(obj);
    if (keys.length !== 4 || !keys.every((k) => k === 'op' || k === 'session' || k === 'seat' || k === 'record_id')) return null;
    const session = obj.session;
    const seat = obj.seat;
    const recordId = obj.record_id;
    if (typeof session !== 'string' || !RECORD_NAME.test(session)) return null;
    if (typeof seat !== 'string' || !RECORD_NAME.test(seat)) return null;
    if (typeof recordId !== 'string' || !RECORD_NAME.test(recordId)) return null;
    return { op: 'nudge', session, seat, record_id: recordId };
  }

  if (obj.op === 'subscribe') {
    const allowed = new Set(['op', 'seat', 'pane', 'cursor', 'kinds', 'follow']);
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) return null;
    }
    const seat = safeName(obj.seat);
    if (seat === null) return null;
    if (typeof obj.cursor !== 'number' || !Number.isInteger(obj.cursor) || obj.cursor < 0) return null;
    let pane: string | undefined;
    if ('pane' in obj && obj.pane !== undefined) {
      const p = safeName(obj.pane);
      if (p === null) return null;
      pane = p;
    }
    let kinds: EventKind[] | undefined;
    if ('kinds' in obj && obj.kinds !== undefined) {
      if (!Array.isArray(obj.kinds) || obj.kinds.some((k) => !isEventKind(k))) return null;
      kinds = [...(obj.kinds as EventKind[])];
    }
    let follow: boolean | undefined;
    if ('follow' in obj && obj.follow !== undefined) {
      if (typeof obj.follow !== 'boolean') return null;
      follow = obj.follow;
    }
    return {
      op: 'subscribe',
      seat,
      cursor: obj.cursor,
      ...(pane !== undefined ? { pane } : {}),
      ...(kinds !== undefined ? { kinds } : {}),
      ...(follow !== undefined ? { follow } : {}),
    };
  }

  return null;
}

export function parseBusAnswer(line: string): BusAnswer | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.ok === true) {
    if (obj.kind === 'published') {
      const rec = parseSignedEventLine(JSON.stringify(obj.event));
      if (!rec || typeof obj.duplicate !== 'boolean') return null;
      return { ok: true, kind: 'published', event: rec, duplicate: obj.duplicate };
    }
    if (obj.kind === 'nudged') {
      if (typeof obj.duplicate !== 'boolean') return null;
      if (obj.event === null) return { ok: true, kind: 'nudged', event: null, duplicate: obj.duplicate };
      const rec = parseSignedEventLine(JSON.stringify(obj.event));
      if (!rec) return null;
      return { ok: true, kind: 'nudged', event: rec, duplicate: obj.duplicate };
    }
    if (obj.kind === 'events') {
      if (!Array.isArray(obj.events) || typeof obj.cursor !== 'number' || !Number.isInteger(obj.cursor) || obj.cursor < 0) {
        return null;
      }
      const events: SignedEventRecord[] = [];
      for (const item of obj.events) {
        const rec = parseSignedEventLine(JSON.stringify(item));
        if (!rec) return null;
        events.push(rec);
      }
      return { ok: true, kind: 'events', events, cursor: obj.cursor };
    }
    if (obj.kind === 'event') {
      const rec = parseSignedEventLine(JSON.stringify(obj.event));
      if (!rec) return null;
      return { ok: true, kind: 'event', event: rec };
    }
    if (obj.kind === 'gap') {
      if (
        typeof obj.oldest_seq !== 'number' ||
        !Number.isInteger(obj.oldest_seq) ||
        typeof obj.newest_seq !== 'number' ||
        !Number.isInteger(obj.newest_seq)
      ) {
        return null;
      }
      const gap: Extract<BusAnswer, { kind: 'gap' }> = {
        ok: true,
        kind: 'gap',
        oldest_seq: obj.oldest_seq,
        newest_seq: obj.newest_seq,
      };
      if (obj.reason !== undefined) {
        const droppedOldest = obj.dropped_oldest_seq;
        const droppedNewest = obj.dropped_newest_seq;
        if (
          obj.reason !== 'retention' ||
          typeof droppedOldest !== 'number' ||
          !Number.isInteger(droppedOldest) ||
          typeof droppedNewest !== 'number' ||
          !Number.isInteger(droppedNewest)
        ) {
          return null;
        }
        gap.reason = 'retention';
        gap.dropped_oldest_seq = droppedOldest;
        gap.dropped_newest_seq = droppedNewest;
      }
      return gap;
    }
    return null;
  }
  if (obj.ok === false) {
    if (obj.at !== 'caller' && obj.at !== 'policy' && obj.at !== 'write') return null;
    if (typeof obj.message !== 'string' || obj.message === '') return null;
    const out: BusAnswer = { ok: false, at: obj.at, message: obj.message };
    if (typeof obj.rule === 'string' && obj.rule !== '') out.rule = obj.rule;
    if (isEventKind(obj.kind)) out.kind = obj.kind;
    return out;
  }
  return null;
}

type LiveSubscriber = {
  socket: Socket;
  seat: string;
  kinds: Set<EventKind> | null;
  queue: string[];
  flushing: boolean;
  bufferLimit: number;
  /** Records fanned out while this subscriber's catch-up read runs, before its answer is built:
   *  the subscription is registered before the read so nothing appended during it can slip
   *  between the answer snapshot and the live feed. Null once the answer is built, when fanOut
   *  goes back to the queue. The list is capped at `bufferLimit`; past it the read's answer is a
   *  `gap`, exactly as a full queue's is. */
  holding: { seq: number; line: string }[] | null;
  /** The sequence of the record that overflowed the holding list, if one did. */
  heldOverflowAt: number | null;
};

type SubscriberClaim = { kind: 'seat'; seat: string } | { kind: 'refused'; message: string };

/** The seat a subscribe request claims. A registry id resolves to the seat that agent holds in
 *  this team, so a caller that knows its agent id subscribes by it; a plain seat name stands as
 *  written. A request that names a pane must name the pane the registry holds for that agent, so
 *  a stale or borrowed pane cannot subscribe under a live seat. */
function resolveSubscriber(request: BusSubscribeRequest, home: string, root: string): SubscriberClaim {
  const teamId = teamIdOf(root);
  if (isAgentId(request.seat)) {
    const agent = getAgent(home, request.seat);
    if (agent === null || agent.lifecycle === 'retired' || agent.reach.team !== teamId) {
      return {
        kind: 'refused',
        message:
          'no agent of this team holds that id; subscribe with the agent id the registry holds or with the seat name',
      };
    }
    if (!paneAgrees(request.pane, agent.reach.pane)) {
      return {
        kind: 'refused',
        message: `the registry holds pane ${agent.reach.pane} for ${agent.reach.seat}, not ${request.pane}`,
      };
    }
    return { kind: 'seat', seat: agent.reach.seat };
  }
  if (request.pane !== undefined) {
    const agent = findAgent(home, { team: teamId, seat: request.seat });
    if (agent !== null && !paneAgrees(request.pane, agent.reach.pane)) {
      return {
        kind: 'refused',
        message: `the registry holds pane ${agent.reach.pane} for ${request.seat}, not ${request.pane}`,
      };
    }
  }
  return { kind: 'seat', seat: request.seat };
}

/** An agent with no pane on record does not contradict a claimed one; a pane on record must match. */
function paneAgrees(claimed: string | undefined, held: string | null): boolean {
  return claimed === undefined || held === null || claimed === held;
}

function matchesSubscriber(
  record: SignedEventRecord,
  seat: string,
  selfKinds: ReadonlySet<EventKind> | null,
  team: TeamRoutingRoles,
  additiveRouting?: Partial<Record<EventKind, readonly string[]>>,
  resolveSeat?: SeatRecipientResolver,
): boolean {
  const { payload } = record;
  // A kind filter narrows what a subscription reads; it never widens who receives a record.
  if (selfKinds !== null && !selfKinds.has(payload.kind)) return false;
  // An event addressed to a seat by the raising side reaches that seat. The owner is addressed
  // this way for a report the policy's routing does not name him in (§4.5).
  if (payload.to !== undefined && payload.to !== '' && payload.to === seat) return true;
  const recipients = recipientsForEvent(payload, team, additiveRouting, [], resolveSeat);
  return recipients.has(seat);
}

export async function startBus(input: StartBusInput): Promise<StartBusResult> {
  const path = busSocket(input.root);
  // A live socket is a bus already serving, answered before the start lock is read: a starting
  // bus holds that lock through its whole first pass while its listener already answers, so
  // waiting the lock out would report a serving bus as still starting.
  if ((await probeSocket(path)) === 'live') return { kind: 'busy' };
  const lock = await acquireStartLock(`${path}.lock`);
  if (lock.kind === 'timeout') return { kind: 'locked' };
  try {
    return await startBusWalk(input, path);
  } finally {
    lock.release();
  }
}

/** The registry record's canonical digest when it reads, or `''` when it is absent or cannot be
 *  read yet: the bus already has its team, so a missing baseline is not a failure. */
function storedRecordDigest(home: string, id: string): string {
  try {
    return readStoredTeamConfig(home, id)?.record_sha256 ?? '';
  } catch {
    return '';
  }
}

/** One line per distinct reload failure: a record that stays broken is not repeated on every
 *  pass, and a different failure is still said. */
function reportReloadProblem(stderr: (text: string) => void, previous: string | null, why: string): string {
  const line = `team bus: the seat webhook rows were not reloaded: ${why}\n`;
  if (line !== previous) stderr(line);
  return line;
}

async function startBusWalk(input: StartBusInput, path: string): Promise<StartBusResult> {
  const home = input.home ?? homedir();
  const now = input.now ?? (() => new Date());
  // The log's size bound and age window are the team's policy words: read once for this bus's
  // lifetime, like the daemon's other knobs, so a publish, a read and the reconcile pass all use
  // the same values. A caller that named one keeps it.
  const logSettings = eventLogSettingsFor(input.root, home, now());
  input = {
    ...input,
    maxLogBytes: input.maxLogBytes ?? logSettings.segmentBytes,
    keptLogFiles: input.keptLogFiles ?? logSettings.kept,
    retentionSeconds: input.retentionSeconds ?? logSettings.retentionSeconds,
  };
  const registryTeamId = teamIdOf(input.root);
  // A routing word may name a seat by its registry id; resolve it against the registry on disk so
  // that `{ seat: agt_… }` reaches the seat that holds it, while plain names stand as written.
  const resolveSeat = readSeatResolver(home, registryTeamId);
  // The entity's own lead, for the `entity` routing position: a lead's prompt and a climbed
  // `seat.prompt-escalated` name it. Read once at start; the watch resolves the mailbox target
  // fresh on every climb, so a reregistered entity team is reached without a bus restart.
  const entityOrchestrator = readEntityOrchestrator(home, teamIdOf(input.root));
  const routingTeam: TeamRoutingRoles = {
    ...input.team,
    ...(entityOrchestrator === null ? {} : { entityOrchestrator: entityOrchestrator.seat }),
  };
  const bufferLimit = input.bufferLimit ?? DEFAULT_SUBSCRIBER_BUFFER_LIMIT;
  const reconcileIntervalMs = input.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_SECONDS * 1000;
  // Retention before the first event: a team back after an idle month drops its old segments now.
  pruneEventLog(input.team.project, input.root, home, {
    kept: input.keptLogFiles,
    maxTotalBytes: input.maxTotalLogBytes,
    retentionSeconds: input.retentionSeconds,
  });
  // The sealed set is verified once at start, without reading a sealed segment: a sidecar that
  // does not match its segment is reported in the team log, and the segment is read and verified
  // in full by the ordinary path instead. A tampered sidecar never keeps the bus from serving.
  try {
    const seals = verifyEventLogSeals(input.team.project, input.root, home, {
      kept: input.keptLogFiles,
    });
    if (seals.ok) {
      for (const problem of seals.problems) {
        logLine(join(input.root, '.agents'), 'bus', 'event-log', `seal ${problem}`, now());
      }
    }
  } catch {
    // Verification is a report at start; the read path verifies every byte it serves anyway.
  }

  let confirmed: { dev: number; ino: number } | undefined;
  for (let walk = 0; walk < START_WALKS; walk++) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isSocket()) return { kind: 'bind-failed' };
    const probe = await probeSocket(path);
    if (probe === 'live') return { kind: 'busy' };
    let cleared = false;
    if (probe === 'stale') {
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (!entry || !current || current.dev !== entry.dev || current.ino !== entry.ino) {
        confirmed = undefined;
        continue;
      }
      if (!confirmed || confirmed.dev !== entry.dev || confirmed.ino !== entry.ino) {
        confirmed = { dev: entry.dev, ino: entry.ino };
        await new Promise<void>((done) => setTimeout(done, STALE_CONFIRM_MS));
        continue;
      }
      confirmed = undefined;
      try {
        unlinkSync(path);
        cleared = true;
      } catch {
        continue;
      }
    } else {
      confirmed = undefined;
    }

    const sockets = new Set<Socket>();
    const subscribers = new Set<LiveSubscriber>();

    // Every fanned-out record also reaches the seat's webhook adapter; it never throws and never
    // awaits, so a pass or a publish is never failed by a routine.
    const stateDir = input.stateDir;
    const builtIn = input.deliver === undefined
      ? makeWebhookDelivery({
          team: input.team,
          stderr: input.stderr,
          root: input.root,
          ...(stateDir === undefined ? {} : {
            onResult: (seat: string, record: SignedEventRecord, facts: WebhookFacts) =>
              recordWebhookDelivery(stateDir, input.team.session, seat, record, facts),
          }),
        })
      : null;
    const deliver = input.deliver ?? builtIn!;

    // A row changed in the root's registry record applies to this running bus: each pass re-reads
    // the record and rebuilds the routes only when its canonical digest moved. The team the bus
    // routes and subscribes with stays as it started — this reload touches the webhook rows alone.
    // A delivery already scheduled captured its row, so nothing in flight is cancelled or moved.
    let seenRecord = storedRecordDigest(home, registryTeamId);
    let reloadProblem: string | null = null;
    const reloadWebhookRoutes = (): void => {
      if (builtIn === null) return;
      let stored: ReturnType<typeof readStoredTeamConfig>;
      try {
        stored = readStoredTeamConfig(home, registryTeamId);
      } catch {
        // The store's refusal can name the file and the fault, but a diagnostic that forwards
        // it could one day carry the record's own text (a parser quotes what it refused). The
        // line says only that the read failed, and never what the record held.
        reloadProblem = reportReloadProblem(input.stderr, reloadProblem, 'the registry record could not be read');
        return;
      }
      if (stored === null) {
        // A record that was here when the bus started and is now gone is a change outside the
        // approval chain: say it once and keep the rows that run.
        if (seenRecord !== '') {
          reloadProblem = reportReloadProblem(input.stderr, reloadProblem, 'the registry holds no record of this team');
        }
        return;
      }
      if (stored.record_sha256 === seenRecord) {
        reloadProblem = null;
        return;
      }
      const parsed = validateTeamFile(stored.text, { home, root: input.root });
      if (!parsed.ok) {
        reloadProblem = reportReloadProblem(input.stderr, reloadProblem, 'the registry\'s record of this team does not validate');
        return;
      }
      // Only the copy the owner approved may move a route. The approval's signature binds the
      // canonical record, the root and the generation (src/store/store.ts), so a record rewritten
      // outside that chain — even with its unkeyed digests recomputed — is a miss: the running
      // rows stay, and the line is said once.
      const standing = approvalStanding(input.root, home);
      const approved = standing.kind === 'verified' ? approvedRecordOf(standing.record.file) : null;
      if (approved === null || approved !== canonicalTeam(parsed.team)) {
        reloadProblem = reportReloadProblem(input.stderr, reloadProblem, 'the registry\'s record of this team is not the copy the owner approved');
        return;
      }
      seenRecord = stored.record_sha256;
      builtIn.reload(parsed.team);
      reloadProblem = null;
    };

    const fanOut = (record: SignedEventRecord): void => {
      deliver(record);
      for (const sub of subscribers) {
        if (!matchesSubscriber(record, sub.seat, sub.kinds, routingTeam, input.additiveRouting, resolveSeat)) continue;
        if (sub.holding !== null) {
          // The subscriber's catch-up read is still running. Hold the record for the answer
          // instead of writing it first: the answer carries everything up to its cursor, and the
          // held records past that cursor follow it in order. Overflow is remembered, not
          // answered here, because the read's own answer is what the subscriber is waiting for.
          if (sub.heldOverflowAt !== null) continue;
          if (sub.holding.length >= sub.bufferLimit) {
            sub.heldOverflowAt = record.payload.seq;
            continue;
          }
          sub.holding.push({ seq: record.payload.seq, line: encodeBusLine({ ok: true, kind: 'event', event: record }) });
          continue;
        }
        if (sub.queue.length >= sub.bufferLimit) {
          // Bounded per-subscriber buffer overflow: send `gap` so the subscriber resyncs from
          // durable records rather than dropping an event silently (Amendment 01 §4.2).
          subscribers.delete(sub);
          try {
            sub.socket.end(
              encodeBusLine({
                ok: true,
                kind: 'gap',
                oldest_seq: record.payload.seq,
                newest_seq: record.payload.seq,
              }),
            );
          } catch {
            sub.socket.destroy();
          }
          continue;
        }
        sub.queue.push(encodeBusLine({ ok: true, kind: 'event', event: record }));
        flushSubscriber(sub, subscribers);
      }
    };

    // One cache across this bus's passes. The pass runs in slices and yields between them, so a
    // large store never blocks the bus's event loop; `reconcileNow` joins a pass already in
    // flight instead of starting a second one over the same records.
    const reconcileState = createReconcileState();
    // The first pass's own record, kept for a reader that must not be told the bus is caught up
    // while the scan still runs. The state's counters reset at the start of every later pass, so
    // the total is captured when the first pass settles; `doneAt` is the settle marker, and the
    // handle answers `running` from its absence, never from a second pass's state.
    const firstPass: { scanned: number; doneAt: string | null; errors: boolean } = {
      scanned: 0, doneAt: null, errors: false,
    };
    // The pass answers its own failures and resolves empty, so this is the only local trace that
    // the walk stopped on one instead of finishing it. Only the first pass's settle reads it.
    let firstPassError = false;
    const settleFirstPass = (): void => {
      firstPass.scanned = reconcileState.stats.filesRead + reconcileState.stats.filesReused;
      firstPass.errors = firstPassError;
      firstPass.doneAt = now().toISOString();
    };
    // Aborted by close. A pass in flight stops between slices and before its next append, and
    // every start path refuses once it is aborted, so the closing bus writes no event after
    // close resolves. The records it did not reach are not lost: no cursor advanced past them,
    // and the next bus process's first pass finds them again.
    const closing = new AbortController();
    let reconcileRun: Promise<SignedEventRecord[]> | null = null;
    const runReconcile = (): Promise<SignedEventRecord[]> => {
      if (closing.signal.aborted) return Promise.resolve([]);
      reloadWebhookRoutes();
      if (reconcileRun !== null) return reconcileRun;
      const run = reconcilePassAsync({
        project: input.team.project,
        root: input.root,
        session: input.team.session,
        home,
        now: now(),
        maxBytes: input.maxLogBytes,
        kept: input.keptLogFiles,
        retentionSeconds: input.retentionSeconds,
        ...(input.heldThresholdSeconds !== undefined ? { heldThresholdSeconds: input.heldThresholdSeconds } : {}),
        onEvent: fanOut,
        // A record the pass will not raise is named once: a linked file or folder, an unsigned
        // record or one addressed elsewhere. The refusal says where and why, never what the
        // record said.
        onRefused: (refusal) => {
          input.stderr(`team bus: ${refusal.where} was not raised: ${refusal.reason}\n`);
        },
        state: reconcileState,
        signal: closing.signal,
      }).then(
        (res) => {
          // A cancelled pass is the closing bus's own abort, not a failure: the walk stopped
          // between slices and left every unread record for the next pass. Only a result that
          // failed for its own reason marks the walk as stopped on an error.
          if (!res.ok && res.cancelled !== true) firstPassError = true;
          return res.ok ? res.raised : [];
        },
        (error: unknown) => {
          firstPassError = true;
          input.stderr(`team bus: reconcile failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return [];
        },
      );
      reconcileRun = run;
      void run.finally(() => {
        if (reconcileRun === run) reconcileRun = null;
      });
      return run;
    };

    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      serveBusConnection(socket, input, home, now, bufferLimit, subscribers, fanOut, resolveSeat, routingTeam);
    });

    const failure = await new Promise<{ code?: string } | null>((done) => {
      server.once('error', (error) => done({ code: (error as NodeJS.ErrnoException).code }));
      server.listen(path, () => done(null));
    });
    if (failure) return { kind: 'bind-failed', code: failure.code };

    try {
      chmodSync(path, 0o600);
    } catch {}

    server.on('error', (error) => input.stderr(`team bus: ${error.message}\n`));

    // The process marker `team status` and `team check` read without dialling the socket: this
    // pid, while it serves. A marker whose pid is gone is a bus that died; `team up` starts one.
    writeBusMarker(input.root, now());

    // Initial reconcile pass at bus start (Amendment 01 §4.2). The listener is already bound, so
    // the pass's own yields let a liveness probe and a subscriber connect while it runs. A host
    // bringing up many roots starts it in the background and keeps ownership of it through the
    // handle: `reconcileNow` joins it and `close` aborts and drains it.
    const initialRun = runReconcile();
    if ((input.initialReconcile ?? 'await') === 'await') {
      await initialRun;
      settleFirstPass();
    } else {
      void initialRun.then(() => {
        // close aborted the walk: it never finished, so nothing may stamp it as done.
        if (closing.signal.aborted) return;
        settleFirstPass();
      });
    }

    const timer =
      reconcileIntervalMs > 0
        ? setInterval(() => {
            // The pass answers its own failures; an interval tick never starts a second pass.
            void runReconcile();
          }, reconcileIntervalMs)
        : undefined;
    timer?.unref?.();

    let closingPromise: Promise<void> | null = null;
    const handle: BusHandle = {
      reconcileNow: runReconcile,
      firstPass: () => {
        const doneAt = firstPass.doneAt;
        if (doneAt === null) {
          // Live: the pass's counters reset at the start of every pass, but this is the first,
          // so they are the scan's own progress until `settleFirstPass` captures the total.
          return {
            running: true,
            scanned: reconcileState.stats.filesRead + reconcileState.stats.filesReused,
            doneAt: null,
          };
        }
        return { running: false, scanned: firstPass.scanned, doneAt, errors: firstPass.errors };
      },
      close: () => {
        if (closingPromise !== null) return closingPromise;
        // Cancel before waiting: the pass in flight stops at its next boundary, and every later
        // start answers empty. Close resolves only after the pass has stopped, so no record is
        // appended after it — the endpoint it owns is released with its last write behind it.
        closing.abort();
        closingPromise = (async () => {
          const running = reconcileRun;
          if (running !== null) {
            try {
              await running;
            } catch {
              // The pass answers its own failures; close has nothing to add.
            }
          }
          if (timer !== undefined) clearInterval(timer);
          subscribers.clear();
          for (const socket of sockets) socket.destroy();
          clearBusMarker(input.root);
          await new Promise<void>((done) => server.close(() => done()));
        })();
        return closingPromise;
      },
    };
    return { kind: 'serving', cleared, handle };
  }
  return { kind: 'bind-failed' };
}

function flushSubscriber(sub: LiveSubscriber, subscribers: Set<LiveSubscriber>): void {
  if (sub.flushing) return;
  sub.flushing = true;
  while (sub.queue.length > 0) {
    const next = sub.queue.shift()!;
    if (sub.socket.destroyed) {
      subscribers.delete(sub);
      sub.flushing = false;
      return;
    }
    const ok = sub.socket.write(next);
    if (!ok) {
      sub.socket.once('drain', () => {
        sub.flushing = false;
        flushSubscriber(sub, subscribers);
      });
      return;
    }
  }
  sub.flushing = false;
}

function serveBusConnection(
  socket: Socket,
  input: StartBusInput,
  home: string,
  now: () => Date,
  bufferLimit: number,
  subscribers: Set<LiveSubscriber>,
  fanOut: (record: SignedEventRecord) => void,
  resolveSeat: SeatRecipientResolver,
  routingTeam: TeamRoutingRoles,
): void {
  socket.on('error', () => socket.destroy());
  socket.setTimeout(REQUEST_IDLE_MS, () => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = '';
  let handled = false;
  socket.on('data', (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    const at = buffer.indexOf('\n');
    if (at < 0) {
      if (buffer.length > MAX_BUS_REQUEST_BYTES) {
        handled = true;
        answerOnce(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
      }
      return;
    }
    handled = true;
    const line = buffer.slice(0, at);
    buffer = '';
    socket.setTimeout(0);
    dispatchBusRequest(socket, line, input, home, now, bufferLimit, subscribers, fanOut, resolveSeat, routingTeam).catch(
      (error: unknown) => {
        input.stderr(`team bus: the request failed: ${error instanceof Error ? error.message : String(error)}\n`);
        socket.destroy();
      },
    );
  });
}

/** Serves one request. Synchronous except for a subscribe's catch-up read, which is sliced: the
 *  read gives the event loop a turn, so a follower's first answer never holds the bus for a large
 *  retained log, and the holding list the subscription registers with keeps the window between
 *  that read and the live feed exact. */
async function dispatchBusRequest(
  socket: Socket,
  line: string,
  input: StartBusInput,
  home: string,
  now: () => Date,
  bufferLimit: number,
  subscribers: Set<LiveSubscriber>,
  fanOut: (record: SignedEventRecord) => void,
  resolveSeat: SeatRecipientResolver,
  routingTeam: TeamRoutingRoles,
): Promise<void> {
  const request = parseBusRequest(line);
  if (!request) {
    answerOnce(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
    return;
  }

  if (request.op === 'publish') {
    // A published arrival names a delivery, so it is held to the record that delivery carries.
    // The verified event is built from the signed record, never from the caller's fields.
    let event = request.event;
    if (event.kind === 'message.arrived') {
      const verified = verifiedArrival(
        { session: event.session, seat: event.to ?? '', record_id: event.record_id },
        { root: input.root, session: input.team.session },
        home,
      );
      if (verified === null) {
        answerOnce(socket, { ok: false, at: 'caller', message: UNVERIFIED_ARRIVAL });
        return;
      }
      event = verified;
    }
    const appended = appendEvent(input.team.project, input.root, home, event, {
      maxBytes: input.maxLogBytes,
      kept: input.keptLogFiles,
      maxTotalBytes: input.maxTotalLogBytes,
      retentionSeconds: input.retentionSeconds,
      deduplicate: true,
    });
    if (!appended.ok) {
      answerOnce(socket, { ok: false, at: 'write', message: appended.reason });
      return;
    }
    if (!appended.duplicate) {
      fanOut(appended.record);
    }
    answerOnce(socket, {
      ok: true,
      kind: 'published',
      event: appended.record,
      duplicate: appended.duplicate,
    });
    return;
  }

  if (request.op === 'nudge') {
    const event = verifiedArrival(request, { root: input.root, session: input.team.session }, home);
    if (event === null) {
      // Nothing verified, so nothing is appended and no adapter is posted. The send's own record
      // may still be landing; its reader's poll and the next pass both find it if it does.
      answerOnce(socket, { ok: true, kind: 'nudged', event: null, duplicate: false });
      return;
    }
    const appended = appendEvent(input.team.project, input.root, home, event, {
      maxBytes: input.maxLogBytes,
      kept: input.keptLogFiles,
      maxTotalBytes: input.maxTotalLogBytes,
      retentionSeconds: input.retentionSeconds,
      deduplicate: true,
    });
    if (!appended.ok) {
      answerOnce(socket, { ok: false, at: 'write', message: appended.reason });
      return;
    }
    if (!appended.duplicate) {
      fanOut(appended.record);
    }
    answerOnce(socket, { ok: true, kind: 'nudged', event: appended.record, duplicate: appended.duplicate });
    return;
  }

  // `subscribe`: resolve the claimed identity against the registry, then validate the seat and
  // check the privileged self-subscription ban (§4.4).
  const claimed = resolveSubscriber(request, home, input.root);
  if (claimed.kind === 'refused') {
    answerOnce(socket, { ok: false, at: 'caller', message: claimed.message });
    return;
  }
  const seat = claimed.seat;
  const leads = leadSeatsOf(input.team);
  // The owner's own identity: `owner` is the delivery target §4.5 defines, and no seat name
  // carries it. The watch process subscribes as `owner` only when its own caller check admits it.
  const isOwner = seat === 'owner';
  const isLead = leads.has(seat);
  const isOperator = input.team.operator === seat;
  const declaredSeat = isOwner || input.team.seats.some((s) => s.name === seat);
  if (!declaredSeat) {
    answerOnce(socket, {
      ok: false,
      at: 'caller',
      message: `only a seat of this team may subscribe to its bus; this request names ${seat}`,
    });
    return;
  }

  if (request.kinds !== undefined && request.kinds.length > 0) {
    const check = checkPrivilegedSelfSubscription(seat, request.kinds, {
      isOwner,
      isLead,
      isOperator,
      extraPrivileged: input.extraPrivilegedKinds,
    });
    if (!check.ok) {
      const moment = now();
      const record = refusalRecord(check.refusal, moment);
      const shaped = policyRefusedEvent(check.refusal, moment);
      // Operational log refusal + visible `team.policy-refused` event to owner (§4.4).
      logLine(join(input.root, '.agents'), 'bus', seat, `${record.rule}: ${record.detail}`, moment);
      const refusalEvent = appendEvent(
        input.team.project,
        input.root,
        home,
        {
          ts: shaped.at,
          kind: shaped.kind,
          session: input.team.session,
          record_id: `policy-refused:${shaped.requester}:${shaped.refusedKind}:${shaped.at}`,
          subject: shaped.requester,
          seat: shaped.requester,
          rule: shaped.rule,
          reason: shaped.refusedKind,
        },
        {
          maxBytes: input.maxLogBytes,
          kept: input.keptLogFiles,
          deduplicate: false,
        },
      );
      if (refusalEvent.ok) {
        fanOut(refusalEvent.record);
      }
      answerOnce(socket, {
        ok: false,
        at: 'policy',
        rule: check.rule,
        kind: check.kind,
        message: check.message,
      });
      return;
    }
  }

  // The subscription is registered before the read, with a holding list: an append that lands
  // while the sliced read gives the loop a turn is held for the answer instead of fanning out
  // first, so no record inside the answer's window is written twice and none past its cursor is
  // lost between the answer snapshot and the live feed.
  const follow = request.follow === true;
  const selfKinds = request.kinds !== undefined ? new Set<EventKind>(request.kinds) : null;
  const sub: LiveSubscriber | null = follow
    ? {
        socket,
        seat,
        kinds: selfKinds,
        queue: [],
        flushing: false,
        bufferLimit,
        holding: [],
        heldOverflowAt: null,
      }
    : null;
  if (sub !== null) {
    subscribers.add(sub);
    socket.once('close', () => subscribers.delete(sub));
  }
  const dropSub = (): void => {
    if (sub !== null) subscribers.delete(sub);
  };

  let fromCursor: CursorReadResult;
  try {
    fromCursor = await readEventsFromCursorSliced(input.team.project, input.root, home, request.cursor, {
      kept: input.keptLogFiles,
    });
  } catch {
    dropSub();
    answerOnce(socket, { ok: false, at: 'write', message: 'the event log could not be read' });
    return;
  }
  // The socket may have closed while the read gave the loop a turn; its close listener has
  // removed the subscriber, and this deletes it if the listener has not run yet.
  if (socket.destroyed) {
    dropSub();
    return;
  }
  if (sub !== null && !subscribers.has(sub)) return;
  if (!fromCursor.ok) {
    dropSub();
    answerOnce(socket, { ok: false, at: 'write', message: fromCursor.reason });
    return;
  }
  if (fromCursor.kind === 'gap') {
    dropSub();
    answerOnce(socket, {
      ok: true,
      kind: 'gap',
      oldest_seq: fromCursor.oldest_seq,
      newest_seq: fromCursor.newest_seq,
      ...(fromCursor.reason !== undefined
        ? {
            reason: fromCursor.reason,
            dropped_oldest_seq: fromCursor.dropped_oldest_seq,
            dropped_newest_seq: fromCursor.dropped_newest_seq,
          }
        : {}),
    });
    return;
  }

  const matching = fromCursor.events.filter((rec) =>
    matchesSubscriber(rec, seat, selfKinds, routingTeam, input.additiveRouting, resolveSeat),
  );

  if (matching.length > bufferLimit) {
    // The window names the records it covers: the oldest this subscriber still needs, and the
    // newest one read — not merely the newest one it matched. The reset cursor has to step past
    // the records of other kinds at the end of the window too.
    dropSub();
    const oldest = matching[0]!.payload.seq;
    const newest = fromCursor.events[fromCursor.events.length - 1]!.payload.seq;
    answerOnce(socket, {
      ok: true,
      kind: 'gap',
      oldest_seq: oldest,
      newest_seq: newest,
    });
    return;
  }

  if (sub !== null && sub.heldOverflowAt !== null) {
    // More records were held during the read than a subscription may carry: answer the same
    // `gap` a full queue answers, so the subscriber resyncs instead of losing one silently.
    dropSub();
    answerOnce(socket, { ok: true, kind: 'gap', oldest_seq: sub.heldOverflowAt, newest_seq: sub.heldOverflowAt });
    return;
  }

  if (sub === null) {
    answerOnce(socket, {
      ok: true,
      kind: 'events',
      events: matching,
      cursor: fromCursor.cursor,
    });
    return;
  }

  // Seed the answer, then the records held past its cursor, then hand the subscriber back to the
  // live queue — all in one turn, so nothing this read did not cover can be fanned out between
  // the last held record and the first queued one.
  sub.queue.push(
    encodeBusLine({
      ok: true,
      kind: 'events',
      events: matching,
      cursor: fromCursor.cursor,
    }),
  );
  for (const entry of sub.holding ?? []) {
    if (entry.seq > fromCursor.cursor) sub.queue.push(entry.line);
  }
  sub.holding = null;
  flushSubscriber(sub, subscribers);
}

function answerOnce(socket: Socket, value: BusAnswer): void {
  const line = encodeBusLine(value);
  if (line.length > MAX_BUS_ANSWER_BYTES) {
    socket.end(encodeBusLine({ ok: false, at: 'write', message: 'the bus answer exceeded the maximum frame size' }));
    return;
  }
  socket.end(line);
}

export type BusPublishOutcome =
  | { kind: 'published'; event: SignedEventRecord; duplicate: boolean }
  | { kind: 'refused'; at: 'caller' | 'policy' | 'write'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

/** What a nudge heard back. `event: null` is the bus saying the record did not verify: nothing
 *  was appended and no adapter was posted. */
export type BusNudgeOutcome =
  | { kind: 'nudged'; event: SignedEventRecord | null; duplicate: boolean }
  | { kind: 'refused'; at: 'caller' | 'policy' | 'write'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

type BusAsk =
  | { kind: 'answer'; answer: BusAnswer }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

/** One request to a running bus, bounded by `deadlineMs`. The socket is the bus's own: a bus
 *  that is not serving refuses the connection, and the caller hears `unavailable`. */
function askBus(root: string, request: BusRequest, deadlineMs: number): Promise<BusAsk> {
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = connect(busSocket(root));
    const finish = (outcome: BusAsk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(outcome);
    };
    const timer = setTimeout(() => finish(connected ? { kind: 'deadline' } : { kind: 'unavailable' }), deadlineMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(encodeBusLine(request));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) {
        if (buffer.length > MAX_BUS_ANSWER_BYTES) finish({ kind: 'wrong' });
        return;
      }
      const parsed = parseBusAnswer(buffer.slice(0, at));
      if (!parsed) {
        finish({ kind: 'wrong' });
        return;
      }
      finish({ kind: 'answer', answer: parsed });
    });
    socket.once('error', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
    socket.on('close', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
  });
}

export async function publishToBus(
  root: string,
  event: EventAppendInput,
  options: { deadlineMs?: number } = {},
): Promise<BusPublishOutcome> {
  const asked = await askBus(root, { op: 'publish', event }, options.deadlineMs ?? BUS_DEADLINE_MS);
  if (asked.kind !== 'answer') return asked;
  const answer = asked.answer;
  if (!answer.ok) return { kind: 'refused', at: answer.at, message: answer.message };
  if (answer.kind !== 'published') return { kind: 'wrong' };
  return { kind: 'published', event: answer.event, duplicate: answer.duplicate };
}

/**
 * Tells the bus serving `root` that a signed record has landed, naming it and nothing else. The
 * bus resolves the drop folder, re-reads the file and verifies its signature before it appends
 * anything, so the nudge grants no authority the record does not already carry. Best effort: a
 * bus that is not running, refuses or answers slowly leaves the caller as it was.
 */
export async function nudgeBus(
  root: string,
  record: { session: string; seat: string; record_id: string },
  options: { deadlineMs?: number } = {},
): Promise<BusNudgeOutcome> {
  const asked = await askBus(
    root,
    { op: 'nudge', session: record.session, seat: record.seat, record_id: record.record_id },
    options.deadlineMs ?? BUS_DEADLINE_MS,
  );
  if (asked.kind !== 'answer') return asked;
  const answer = asked.answer;
  if (!answer.ok) return { kind: 'refused', at: answer.at, message: answer.message };
  if (answer.kind !== 'nudged') return { kind: 'wrong' };
  return { kind: 'nudged', event: answer.event, duplicate: answer.duplicate };
}

export type BusSubscribeOutcome =
  | { kind: 'events'; events: SignedEventRecord[]; cursor: number }
  | {
      kind: 'gap';
      oldest_seq: number;
      newest_seq: number;
      reason?: 'retention';
      dropped_oldest_seq?: number;
      dropped_newest_seq?: number;
    }
  | { kind: 'refused'; at: 'caller' | 'policy' | 'write'; message: string; rule?: string; eventKind?: EventKind }
  | { kind: 'unavailable' }
  | { kind: 'wrong' }
  | { kind: 'deadline' };

export function subscribeBusOnce(
  root: string,
  request: Omit<BusSubscribeRequest, 'op' | 'follow'>,
  options: { deadlineMs?: number } = {},
): Promise<BusSubscribeOutcome> {
  const deadlineMs = options.deadlineMs ?? BUS_DEADLINE_MS;
  const full: BusSubscribeRequest = { op: 'subscribe', ...request, follow: false };
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = connect(busSocket(root));
    const finish = (outcome: BusSubscribeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(outcome);
    };
    const timer = setTimeout(() => finish(connected ? { kind: 'deadline' } : { kind: 'unavailable' }), deadlineMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(encodeBusLine(full));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) {
        if (buffer.length > MAX_BUS_ANSWER_BYTES) finish({ kind: 'wrong' });
        return;
      }
      const parsed = parseBusAnswer(buffer.slice(0, at));
      if (!parsed) {
        finish({ kind: 'wrong' });
        return;
      }
      if (!parsed.ok) {
        finish({
          kind: 'refused',
          at: parsed.at,
          message: parsed.message,
          ...(parsed.rule !== undefined ? { rule: parsed.rule } : {}),
          ...(parsed.kind !== undefined ? { eventKind: parsed.kind } : {}),
        });
        return;
      }
      if (parsed.kind === 'gap') {
        finish({
          kind: 'gap',
          oldest_seq: parsed.oldest_seq,
          newest_seq: parsed.newest_seq,
          ...(parsed.reason !== undefined
            ? {
                reason: parsed.reason,
                dropped_oldest_seq: parsed.dropped_oldest_seq,
                dropped_newest_seq: parsed.dropped_newest_seq,
              }
            : {}),
        });
        return;
      }
      if (parsed.kind === 'events') {
        finish({ kind: 'events', events: parsed.events, cursor: parsed.cursor });
        return;
      }
      finish({ kind: 'wrong' });
    });
    socket.once('error', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
    socket.on('close', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
  });
}

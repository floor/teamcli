// The event bus service over `.agents/bus.sock` (RFC 002 Amendment 01 §4.2, §4.4).
//
// A dedicated process beside the broker with its own Unix domain socket (`.agents/bus.sock`,
// mode 0600), start lock (`.agents/bus.sock.lock`), and stale-socket recovery. Supports two
// operations:
// - `publish`: appends a signed event record to `events.jsonl` and fans it out to matching
//   live subscribers with bounded per-subscriber buffers.
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
import type { TeamFile } from '../file/types.ts';
import { logLine } from '../log.ts';
import { findAgent, getAgent, isAgentId } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
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
  readEventsFromCursor,
  type EventAppendInput,
  type SignedEventRecord,
} from './log.ts';
import { reconcilePass } from './reconcile.ts';
import { readEntityOrchestrator, readSeatResolver } from './seats.ts';
import type { SeatRecipientResolver } from './kinds.ts';

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

export type BusSubscribeRequest = {
  op: 'subscribe';
  seat: string;
  pane?: string;
  cursor: number;
  kinds?: EventKind[];
  follow?: boolean;
};

export type BusRequest = BusPublishRequest | BusSubscribeRequest;

export type BusAnswer =
  | { ok: true; kind: 'published'; event: SignedEventRecord; duplicate: boolean }
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
};

export type BusHandle = {
  close(): Promise<void>;
  reconcileNow(): SignedEventRecord[];
};

export type StartBusResult =
  | { kind: 'serving'; cleared: boolean; handle: BusHandle }
  | { kind: 'busy' }
  | { kind: 'bind-failed'; code?: string }
  | { kind: 'locked' };

const REQUEST_IDLE_MS = 5000;
const START_WALKS = 8;
const STALE_CONFIRM_MS = 50;
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 50;
const LOCK_YOUNG_MS = 1000;
const UNKNOWN_REQUEST = 'the request is not one this bus knows';

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
    socket.once('connect', () => {
      socket.destroy();
      done('live');
    });
    socket.once('error', (error) => {
      socket.destroy();
      done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'none');
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
  const lock = await acquireStartLock(`${path}.lock`);
  if (lock.kind === 'timeout') return { kind: 'locked' };
  try {
    return await startBusWalk(input, path);
  } finally {
    lock.release();
  }
}

async function startBusWalk(input: StartBusInput, path: string): Promise<StartBusResult> {
  const home = input.home ?? homedir();
  const now = input.now ?? (() => new Date());
  // A routing word may name a seat by its registry id; resolve it against the registry on disk so
  // that `{ seat: agt_… }` reaches the seat that holds it, while plain names stand as written.
  const resolveSeat = readSeatResolver(home, teamIdOf(input.root));
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

    const fanOut = (record: SignedEventRecord): void => {
      for (const sub of subscribers) {
        if (!matchesSubscriber(record, sub.seat, sub.kinds, routingTeam, input.additiveRouting, resolveSeat)) continue;
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

    const runReconcile = (): SignedEventRecord[] => {
      const res = reconcilePass({
        project: input.team.project,
        root: input.root,
        session: input.team.session,
        home,
        now: now(),
        maxBytes: input.maxLogBytes,
        kept: input.keptLogFiles,
        ...(input.heldThresholdSeconds !== undefined ? { heldThresholdSeconds: input.heldThresholdSeconds } : {}),
        onEvent: fanOut,
      });
      return res.ok ? res.raised : [];
    };

    // Initial reconcile pass at bus start (Amendment 01 §4.2).
    runReconcile();

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

    const timer =
      reconcileIntervalMs > 0
        ? setInterval(() => {
            try {
              runReconcile();
            } catch (error) {
              input.stderr(`team bus: reconcile failed: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }, reconcileIntervalMs)
        : undefined;
    timer?.unref?.();

    const handle: BusHandle = {
      reconcileNow: runReconcile,
      close: () =>
        new Promise<void>((done) => {
          if (timer !== undefined) clearInterval(timer);
          subscribers.clear();
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
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
    dispatchBusRequest(socket, line, input, home, now, bufferLimit, subscribers, fanOut, resolveSeat, routingTeam);
  });
}

function dispatchBusRequest(
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
): void {
  const request = parseBusRequest(line);
  if (!request) {
    answerOnce(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
    return;
  }

  if (request.op === 'publish') {
    const appended = appendEvent(input.team.project, input.root, home, request.event, {
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

  const fromCursor = readEventsFromCursor(input.team.project, input.root, home, request.cursor, {
    kept: input.keptLogFiles,
  });
  if (!fromCursor.ok) {
    answerOnce(socket, { ok: false, at: 'write', message: fromCursor.reason });
    return;
  }
  if (fromCursor.kind === 'gap') {
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

  const selfKinds = request.kinds !== undefined ? new Set<EventKind>(request.kinds) : null;
  const matching = fromCursor.events.filter((rec) =>
    matchesSubscriber(rec, seat, selfKinds, routingTeam, input.additiveRouting, resolveSeat),
  );

  if (matching.length > bufferLimit) {
    // The window names the records it covers: the oldest this subscriber still needs, and the
    // newest one read — not merely the newest one it matched. The reset cursor has to step past
    // the records of other kinds at the end of the window too.
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

  if (request.follow !== true) {
    answerOnce(socket, {
      ok: true,
      kind: 'events',
      events: matching,
      cursor: fromCursor.cursor,
    });
    return;
  }

  const sub: LiveSubscriber = {
    socket,
    seat,
    kinds: selfKinds,
    queue: [
      encodeBusLine({
        ok: true,
        kind: 'events',
        events: matching,
        cursor: fromCursor.cursor,
      }),
    ],
    flushing: false,
    bufferLimit,
  };
  subscribers.add(sub);
  socket.once('close', () => subscribers.delete(sub));
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

export function publishToBus(
  root: string,
  event: EventAppendInput,
  options: { deadlineMs?: number } = {},
): Promise<BusPublishOutcome> {
  const deadlineMs = options.deadlineMs ?? BUS_DEADLINE_MS;
  const request: BusPublishRequest = { op: 'publish', event };
  return new Promise((done) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = connect(busSocket(root));
    const finish = (outcome: BusPublishOutcome) => {
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
      if (!parsed.ok) {
        finish({ kind: 'refused', at: parsed.at, message: parsed.message });
        return;
      }
      if (parsed.kind !== 'published') {
        finish({ kind: 'wrong' });
        return;
      }
      finish({ kind: 'published', event: parsed.event, duplicate: parsed.duplicate });
    });
    socket.once('error', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
    socket.on('close', () => finish(connected ? { kind: 'wrong' } : { kind: 'unavailable' }));
  });
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

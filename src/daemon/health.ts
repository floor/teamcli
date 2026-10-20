// One health reading of the machine-wide TeamCLI daemon, for `team status`, `team check` and
// every other reader (B4's consumer contract: running, pid, since, startedBy, a probe that just
// answered, the heartbeat time, and any stuck request). A crash is the system service manager's
// job; a hang is not,
// so a process that exists but does not answer the probe is reported as running with an
// unanswered probe, never as healthy and never as not running. An unreadable state record or an
// unreadable socket is `unknown` — cannot tell — never `not-running`.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { daemonSocketPath } from './paths.ts';
import { DAEMON_PROTOCOL_VERSION, type DaemonHealthSnapshot } from './protocol.ts';
import {
  daemonStateAlive,
  readDaemonState,
  type DaemonFeatures,
  type DaemonRootPresenceHealth,
  type DaemonRootSeatPresenceHealth,
  type DaemonRootState,
  type DaemonState,
  type DaemonStuckRequest,
} from './state.ts';
import { PRESENCE_ID, isPresenceBinding } from './presence/contract.ts';

export type DaemonProbe =
  | { state: 'answered'; at: string }
  | { state: 'refused'; at: string; code: string; message: string }
  | { state: 'unanswered'; at: string; reason: 'timeout' | 'closed' }
  | { state: 'unknown'; at: string; reason: string };

/** The one reading every consumer uses. `running` is null when the reading cannot tell. */
export type DaemonHealth = {
  daemon: 'teamcli';
  socket: string;
  state: 'running' | 'not-running' | 'unknown';
  running: boolean | null;
  pid: number | null;
  uid: number | null;
  since: string | null;
  startedBy: string | null;
  version: string | null;
  heartbeatAt: string | null;
  features: DaemonFeatures | null;
  stuck: DaemonStuckRequest[];
  /**
   * The checkouts the running daemon recorded hosting, with any failure reason. When the daemon
   * answered the probe, a root it names in the same answer gains that answer's fresh presence
   * record — `state: 'serving', healthy: true` only for a current, owned, healthy channel. A root
   * with no presence record means no health is known, and a reader must hold its last projection.
   * Empty when nothing was hosted or when the reading cannot tell.
   */
  roots: DaemonRootState[];
  probe: DaemonProbe;
  /** Why the reading is unknown, when it is. */
  why: string | null;
};

export type DaemonHealthOptions = {
  /** How long the probe waits for the health answer. 500 ms is plenty on a local socket. */
  timeoutMs?: number;
  /** Injected clock, for tests. */
  now?: () => Date;
  /** Injected request id, for tests. */
  id?: string;
};

function stamp(now: () => Date): string {
  return now().toISOString();
}

/**
 * Reads the daemon's state record and probes its socket. Never throws: an unreadable state
 * record or socket comes back as `unknown`, and a live pid whose socket does not answer comes
 * back as `running` with an unanswered probe.
 */
export async function daemonHealth(home: string = homedir(), options: DaemonHealthOptions = {}): Promise<DaemonHealth> {
  const now = options.now ?? (() => new Date());
  const socket = daemonSocketPath(home);
  const read = readDaemonState(home);
  if (read.kind === 'unreadable') return unknown(socket, 'the daemon state record cannot be read', now);
  if (read.kind === 'missing') {
    if (existsSync(socket)) return unknown(socket, 'a daemon socket exists but no state record does', now);
    return {
      daemon: 'teamcli',
      socket,
      state: 'not-running',
      running: false,
      pid: null,
      uid: null,
      since: null,
      startedBy: null,
      version: null,
      heartbeatAt: null,
      features: null,
      stuck: [],
      roots: [],
      probe: { state: 'unanswered', at: stamp(now), reason: 'closed' },
      why: null,
    };
  }
  if (!daemonStateAlive(read.state)) {
    return {
      daemon: 'teamcli',
      socket,
      state: 'not-running',
      running: false,
      pid: null,
      uid: null,
      since: null,
      startedBy: null,
      version: null,
      heartbeatAt: null,
      features: null,
      stuck: [],
      roots: [],
      probe: { state: 'unanswered', at: stamp(now), reason: 'closed' },
      why: null,
    };
  }
  const answer = await probeDaemonHealth(socket, { timeoutMs: options.timeoutMs ?? 500, id: options.id ?? randomUUID() });
  if (answer.kind === 'answered') {
    const health = answer.health;
    return {
      daemon: 'teamcli',
      socket,
      state: 'running',
      running: true,
      pid: health.pid,
      uid: health.uid,
      since: health.since,
      startedBy: health.startedBy,
      version: health.version,
      heartbeatAt: health.heartbeatAt,
      features: health.features,
      stuck: health.stuck,
      roots: mergedRoots(read.state, health),
      probe: { state: 'answered', at: stamp(now) },
      why: null,
    };
  }
  if (answer.kind === 'refused') {
    return runningFromState(read.state, socket, {
      state: 'refused',
      at: stamp(now),
      code: answer.error.code,
      message: answer.error.message,
    });
  }
  return runningFromState(read.state, socket, {
    state: 'unanswered',
    at: stamp(now),
    reason: answer.reason,
  });
}

/**
 * The state record's roots, with the answering daemon's fresh presence answers merged by canonical
 * root. The answer is used only when the answer and the record name the same daemon epoch: a
 * process that restarted between the two reads must not have its answers pasted onto another
 * incarnation's record. A malformed or self-contradicting answer is dropped, never repaired; a
 * fresh root the record does not carry is not invented into it. Nothing here resolves a spelling:
 * the daemon names the canonical root, and that exact string is the key.
 */
function mergedRoots(state: DaemonState, answer: DaemonHealthSnapshot): DaemonRootState[] {
  if (answer.pid !== state.pid || answer.since !== state.since) return state.roots;
  if (!Array.isArray(answer.roots)) return state.roots;
  const fresh = new Map<string, DaemonRootPresenceHealth>();
  for (const item of answer.roots) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.root !== 'string' || entry.root === '') continue;
    const presence = freshPresenceOf(entry.presence);
    if (presence !== null) fresh.set(entry.root, presence);
  }
  if (fresh.size === 0) return state.roots;
  return state.roots.map((root) => {
    const presence = fresh.get(root.root);
    return presence === undefined ? root : { ...root, presence };
  });
}

/**
 * One fresh presence record, or null when it is not the exact shape the daemon promises. `serving`
 * and `healthy: true` are one fact: a record that says one without the other is not known, and a
 * pending record without a non-empty why cannot say what it is waiting for. A seat entry is held
 * to the same rule and must name the binding it was sampled for when it claims to serve; a
 * malformed seat list drops the whole record rather than serving a partial one.
 */
function freshPresenceOf(raw: unknown): DaemonRootPresenceHealth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.session !== 'string' || entry.session === '') return null;
  if (entry.state !== 'serving' && entry.state !== 'pending') return null;
  if (typeof entry.healthy !== 'boolean') return null;
  if ((entry.state === 'serving') !== entry.healthy) return null;
  if (typeof entry.checkedAt !== 'string' || entry.checkedAt === '') return null;
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  if (entry.state === 'pending' && (typeof entry.why !== 'string' || entry.why === '')) return null;
  const seats = freshSeatsOf(entry.seats);
  if (seats === INVALID_SEATS) return null;
  return {
    session: entry.session,
    state: entry.state,
    healthy: entry.healthy,
    checkedAt: entry.checkedAt,
    why: entry.why as string | null,
    ...(seats === undefined ? {} : { seats }),
  };
}

const INVALID_SEATS = Symbol('invalid seats');

/**
 * The fresh per-seat answers, or `undefined` when the route carries none. The list is either
 * absent or complete: an empty list, a repeated seat, a missing source class or an unknown class
 * that claims to serve all make the record unreadable whole. A serving seat must carry a valid
 * binding, because that is the incarnation a reader fences; a serving runtime seat must also
 * carry the exact applied event id, so a reader can compare it with the canonical event it
 * is about to enforce. A pending seat may have no binding, and its event id is at most a
 * last-known diagnostic one — never proof.
 */
function freshSeatsOf(
  raw: unknown,
): DaemonRootSeatPresenceHealth[] | undefined | typeof INVALID_SEATS {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return INVALID_SEATS;
  const seats: DaemonRootSeatPresenceHealth[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return INVALID_SEATS;
    const entry = item as Record<string, unknown>;
    if (typeof entry.seat !== 'string' || entry.seat === '') return INVALID_SEATS;
    if (seen.has(entry.seat)) return INVALID_SEATS;
    if (entry.state !== 'serving' && entry.state !== 'pending') return INVALID_SEATS;
    if (typeof entry.healthy !== 'boolean') return INVALID_SEATS;
    if ((entry.state === 'serving') !== entry.healthy) return INVALID_SEATS;
    if (entry.source !== 'runtime' && entry.source !== 'hook' && entry.source !== 'unknown') {
      return INVALID_SEATS;
    }
    if (!(entry.binding === null || isPresenceBinding(entry.binding))) return INVALID_SEATS;
    if (!(entry.appliedEventId === null
      || (typeof entry.appliedEventId === 'string' && PRESENCE_ID.test(entry.appliedEventId)))) {
      return INVALID_SEATS;
    }
    if (!(entry.why === null || typeof entry.why === 'string')) return INVALID_SEATS;
    if (entry.state === 'pending' && (typeof entry.why !== 'string' || entry.why === '')) {
      return INVALID_SEATS;
    }
    if (entry.state === 'serving' && entry.binding === null) return INVALID_SEATS;
    if (entry.state === 'serving' && entry.source === 'unknown') return INVALID_SEATS;
    if (entry.state === 'serving' && entry.source === 'runtime' && entry.appliedEventId === null) {
      return INVALID_SEATS;
    }
    seen.add(entry.seat);
    seats.push({
      seat: entry.seat,
      state: entry.state,
      healthy: entry.healthy,
      source: entry.source,
      binding: entry.binding as string | null,
      appliedEventId: entry.appliedEventId as string | null,
      why: entry.why as string | null,
    });
  }
  return seats;
}

function runningFromState(state: DaemonState, socket: string, probe: DaemonProbe): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket,
    state: 'running',
    running: true,
    pid: state.pid,
    uid: state.uid,
    since: state.since,
    startedBy: state.startedBy,
    version: state.version,
    heartbeatAt: state.heartbeatAt,
    features: state.features,
    stuck: state.stuck,
    roots: state.roots,
    probe,
    why: null,
  };
}

function unknown(socket: string, why: string, now: () => Date): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket,
    state: 'unknown',
    running: null,
    pid: null,
    uid: null,
    since: null,
    startedBy: null,
    version: null,
    heartbeatAt: null,
    features: null,
    stuck: [],
    roots: [],
    probe: { state: 'unknown', at: stamp(now), reason: why },
    why,
  };
}

type HealthAnswer =
  | { kind: 'answered'; health: DaemonHealthSnapshot }
  | { kind: 'refused'; error: { code: string; message: string } }
  | { kind: 'unanswered'; reason: 'timeout' | 'closed' };

/** One health probe against a live socket. Exported so a starting daemon can tell a live
 *  predecessor (already running) from a stale socket before it binds. Never throws. */
export function probeDaemonHealth(
  socketPath: string,
  options: { timeoutMs?: number; id?: string } = {},
): Promise<HealthAnswer> {
  return requestHealth(socketPath, options.timeoutMs ?? 500, options.id ?? randomUUID());
}

function requestHealth(socketPath: string, timeoutMs: number, id: string): Promise<HealthAnswer> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    let settled = false;
    const finish = (answer: HealthAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ kind: 'unanswered', reason: 'timeout' }), timeoutMs);
    socket.on('error', () => finish({ kind: 'unanswered', reason: 'closed' }));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, id, op: 'health' })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, nl));
      } catch {
        finish({ kind: 'unanswered', reason: 'closed' });
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({ kind: 'unanswered', reason: 'closed' });
        return;
      }
      const response = parsed as Record<string, unknown>;
      if (response.v !== DAEMON_PROTOCOL_VERSION || response.id !== id || typeof response.ok !== 'boolean') {
        finish({ kind: 'unanswered', reason: 'closed' });
        return;
      }
      if (response.ok === true) {
        const health = response.health;
        if (!health || typeof health !== 'object' || Array.isArray(health)) {
          finish({ kind: 'unanswered', reason: 'closed' });
          return;
        }
        finish({ kind: 'answered', health: health as DaemonHealthSnapshot });
        return;
      }
      const error = response.error;
      if (error && typeof error === 'object' && !Array.isArray(error)) {
        const record = error as Record<string, unknown>;
        if (typeof record.code === 'string' && typeof record.message === 'string') {
          finish({ kind: 'refused', error: { code: record.code, message: record.message } });
          return;
        }
      }
      finish({ kind: 'unanswered', reason: 'closed' });
    });
    socket.on('close', () => finish({ kind: 'unanswered', reason: 'closed' }));
  });
}

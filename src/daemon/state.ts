// The one machine daemon's state record (`<home>/.config/team/daemon.state.json`, mode 0600).
// The daemon writes it at start and refreshes `heartbeatAt` while it serves; `team status`,
// `team check` and the daemon's own health answer read it through this module.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pidAlive } from '../state.ts';
import { DAEMON_HEARTBEAT_SECONDS } from '../policy/index.ts';
import type { HostedWatchState } from '../watch/hosted.ts';
import { daemonStatePath, machineConfigDir } from './paths.ts';

/** Which features the running build actually carries. `absent` means the handler is not built;
 *  it is not the policy value `off`. */
export type DaemonFeatures = { broker: 'on' | 'off' | 'absent' };

/** A request the daemon has been working on longer than its stuck threshold. */
export type DaemonStuckRequest = { id: string; op: string; since: string; ageMs: number };

/**
 * One seat's fresh runtime-continuity answer inside a route's presence health. It is additive to
 * the route's ingest answer and never replaces it: a seat with no managed runtime source keeps
 * the route's own answer, and a route whose ingest is healthy can still carry a pending seat.
 * `serving` with `healthy: true` is the only combination a reader may treat as proof for that
 * seat; every other combination names why.
 */
export type DaemonRootSeatPresenceHealth = {
  seat: string;
  state: 'serving' | 'pending';
  healthy: boolean;
  /**
   * What this seat's route expects, stated rather than inferred: `runtime` is a managed native
   * channel whose health needs an applied-event proof, `hook` is the route's own hook channel
   * qualified by the fresh ingest answer, and `unknown` means source classification itself
   * failed — a reader must never read a missing list entry or a missing source as `hook`.
   */
  source: 'runtime' | 'hook' | 'unknown';
  /** The seat's current managed binding at the sampled instant, so a reader can name the
   *  incarnation this answer fences; null when no sample or no valid binding was read. */
  binding: string | null;
  /** For a serving `runtime` seat, the exact staged event identity proven applied in both the
   *  canonical projection and the applied fence; a pending seat may carry the last-known
   *  canonical event id for diagnosis, or null — but never as proof. A reader compares this to
   *  the canonical event it is about to enforce, never to a receipt instant. */
  appliedEventId: string | null;
  why: string | null;
};

/**
 * One route's fresh presence answer, computed for the health request that carries it and never
 * persisted. `session` is the session of the team file this daemon actually loaded for the route;
 * `checkedAt` is the request's snapshot instant, not an age of the native event. `serving` with
 * `healthy: true` is the only combination a reader may treat as proof: a gap, a fault, a known
 * backlog, a closing daemon or a route this process does not own answer `pending` with
 * `healthy: false` and a non-empty why. `seats` carries the per-seat runtime answer when the route
 * owns managed sources; it is absent for a hook-only route, never an empty serving claim.
 */
export type DaemonRootPresenceHealth = {
  session: string;
  state: 'serving' | 'pending';
  healthy: boolean;
  checkedAt: string;
  why: string | null;
  /** One entry for every declared seat of the route, each with its own explicit source class.
   *  The list is complete whenever it is present: a reader never infers a missing entry's
   *  classification, and a mixed route's hook seat qualifies on fresh ingest while an expected
   *  native seat still holds. */
  seats?: DaemonRootSeatPresenceHealth[];
};

/**
 * A route's presence record as a reading carries it: the close record a daemon persisted when its
 * drain was not truthful (`state: 'pending'`, why non-empty), or the fresh health answer merged
 * from a same-epoch health response. Only the fresh answer can carry `healthy`; the close record
 * never does, so it can never be mistaken for proof.
 */
export type DaemonRootPresence = { state: 'pending'; why: string } | DaemonRootPresenceHealth;

/**
 * How far the route's bus first reconcile pass has got. A daemon-hosted bus serves as soon as its
 * listener is bound and answering, while the first pass over the store still runs; this is what
 * keeps a reader from reading "serving" as "caught up". While the pass runs, `scanned` is live;
 * once it settles, `scanned` is the pass total and `doneAt` is the instant it settled, and
 * `errors` says whether the walk finished or stopped on a failure. A pass a closing bus aborted
 * settles nothing and is never recorded here.
 */
export type DaemonRootFirstPass =
  | { running: true; scanned: number; doneAt: null }
  | { running: false; scanned: number; doneAt: string; errors: boolean };

/** One checkout this process hosts, recorded so a later `team daemon status` can tell a running
 *  daemon from a running daemon that silently hosts nothing for a checkout. */
export type DaemonRootState = {
  root: string;
  team: string | null;
  /** `starting` is written while the daemon is still bringing this root's endpoint up, so a
   *  reader can see the root registered before its first attempt finishes. */
  send: 'starting' | 'serving' | 'already-running' | 'failed';
  bus: 'starting' | 'serving' | 'failed';
  /** A row-level reason, for a failure that kept the whole route from being hosted (a team file
   *  that cannot be read, a send start that threw). An endpoint's own failure reason lives in
   *  `sendWhy` or `busWhy`, so one endpoint's recovery never erases the other's reason; a reader
   *  falls back to this field, so records written before the split still show their reason. */
  why: string | null;
  /** Why the send endpoint last failed. Cleared when it serves again; absent in older records. */
  sendWhy?: string | null;
  /** Why the bus endpoint last failed. Cleared when it serves again; absent in older records. */
  busWhy?: string | null;
  /** When the endpoint was last marked failed. The age a reader prints is measured from this
   *  instant; an answer clears it. */
  sendFailedAt?: string | null;
  busFailedAt?: string | null;
  /**
   * The route's hosted watch, present only when the daemon was started to carry one. A reader
   * may treat a stopped or failed phase as a check failure only when this field exists and
   * says `required`; a route without it was never started to carry a watch.
   */
  watch?: HostedWatchState;
  /**
   * The route's presence record. On the persisted path it is present only when the daemon was
   * started to ingest presence and could not finish a truthful drain at close: `pending` means
   * the daemon kept its lock, socket and state record rather than claim a closure it had not
   * reached, and names why. On a live health reading the same key carries the request-fresh
   * answer, whose only proof is `state: 'serving'` with `healthy: true`.
   */
  presence?: DaemonRootPresence;
  /**
   * The bus's first pass over the route's store, present once this daemon started a bus that has
   * one to report. A reader prints it beside `bus: serving` so "bound and answering" is never
   * read as "caught up". Display data, not a hosting fact: a malformed one is left out.
   */
  firstPass?: DaemonRootFirstPass;
  /**
   * Where the route's heavy chores run, and how the child that runs them is doing. Present only
   * when the daemon was started with a chores seam; a route without the field was never started
   * with one, and its silence is not a failed child. `inline` is the rollback: the work runs on
   * the daemon's own loop exactly as before the isolation.
   */
  chores?: DaemonChoresState;
};

/**
 * One route's chores record: the mode in force, what the supervised child is doing, the resident
 * size its own heartbeat reported, and the last completed pass. `missed` counts heartbeats the
 * daemon has not heard, capped at the policy's own kill threshold; a record at that cap is about
 * to be ended and restarted. This is display evidence for an operator, never a hosting fact.
 */
export type DaemonChoresState = {
  mode: 'per-root' | 'shared' | 'inline';
  state: 'starting' | 'ok' | 'late' | 'restarting' | 'inline' | 'stopped';
  pid: number | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  rssBytes: number | null;
  /** What the child's last heartbeat said it was doing; null when it said nothing. */
  busy: string | null;
  /** How many times the supervisor has replaced this child since the daemon started. */
  restarts: number;
  missed: number;
  /** The last completed pass's own clock, and the notes it carried. */
  lastPassAt: string | null;
  lastPass: string[] | null;
  /** The last chore this root's child finished: the name its own frame carried, the instant it
   *  reported, and how long it took. Null until the child reports one and after a replacement
   *  starts, because a cold process has run nothing for the root yet. */
  lastChore: { name: string; at: string; ms: number | null } | null;
  /** The last presence pass this root's child answered: when, how long it took, and how many
   *  declared seats it proved or missed. Null when no accepted pass has been answered. */
  presence: { at: string; ms: number | null; proved: number; missed: number } | null;
  /** The child's own marker-cache reading at its latest heartbeat: files read afresh, stamps
   *  reused, and stamps held now. A shared child keeps one cache, so its roots' rows carry the
   *  same reading. Null when the child has not reported one. */
  markerCache: { read: number; reused: number; cached: number } | null;
  /** While `state` says `restarting`, when the next start is due. */
  nextStartAt: string | null;
  why: string | null;
};

export type DaemonState = {
  format: 1;
  pid: number;
  uid: number;
  since: string;
  /** `service-manager`, `manual` or `team-up`: the kind of thing that started it, never the
   *  platform's own name for its service manager. */
  startedBy: string;
  version: string;
  /** The commit the running build was packaged from; null in a source checkout. It is written
   *  beside the version, so a reader can tell an install that changed either one from one that
   *  changed neither. Older records carry no field and read as null. */
  gitHead?: string | null;
  heartbeatAt: string;
  /** The whole seconds the `daemon.heartbeat` word resolved to when this record was written:
   *  the beat the loop actually runs. A daemon on an injected test beat, and every older record,
   *  carry no field and read as null. */
  heartbeatSeconds?: number | null;
  socket: string;
  features: DaemonFeatures;
  stuck: DaemonStuckRequest[];
  roots: DaemonRootState[];
};

export type DaemonStateRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'ok'; state: DaemonState };

/** The machine folder, created 0700 when a daemon writes its record. */
export function ensureMachineDir(home: string): string {
  const dir = machineConfigDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function readDaemonState(home: string): DaemonStateRead {
  const path = daemonStatePath(home);
  if (!existsSync(path)) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'unreadable', why: 'the daemon state record is not readable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', why: 'the daemon state record is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const state = stateOf(record);
  if (state === null) return { kind: 'unreadable', why: 'the daemon state record is missing required fields' };
  return { kind: 'ok', state };
}

function stateOf(record: Record<string, unknown>): DaemonState | null {
  if (record.format !== 1) return null;
  if (!positiveInt(record.pid)) return null;
  if (typeof record.uid !== 'number' || !Number.isInteger(record.uid)) return null;
  for (const key of ['since', 'startedBy', 'version', 'heartbeatAt', 'socket'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') return null;
  }
  const features = record.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  if (!['on', 'off', 'absent'].includes((features as Record<string, unknown>).broker as string)) return null;
  const stuck = record.stuck;
  if (!Array.isArray(stuck)) return null;
  const requests: DaemonStuckRequest[] = [];
  for (const item of stuck) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.op !== 'string') return null;
    if (typeof entry.since !== 'string' || typeof entry.ageMs !== 'number') return null;
    requests.push({ id: entry.id, op: entry.op, since: entry.since, ageMs: entry.ageMs });
  }
  const roots = rootsOf(record.roots);
  if (roots === null) return null;
  return {
    format: 1,
    pid: record.pid as number,
    uid: record.uid,
    since: record.since as string,
    startedBy: record.startedBy as string,
    version: record.version as string,
    gitHead: typeof record.gitHead === 'string' && record.gitHead !== '' ? record.gitHead : null,
    heartbeatAt: record.heartbeatAt as string,
    heartbeatSeconds:
      typeof record.heartbeatSeconds === 'number'
        && Number.isInteger(record.heartbeatSeconds)
        && record.heartbeatSeconds >= DAEMON_HEARTBEAT_SECONDS.min
        && record.heartbeatSeconds <= DAEMON_HEARTBEAT_SECONDS.max
        ? record.heartbeatSeconds
        : null,
    socket: record.socket as string,
    features: { broker: (features as Record<string, unknown>).broker as DaemonFeatures['broker'] },
    stuck: requests,
    roots,
  };
}

/** `roots` was added after the first state records were written: a record without it reads as
 *  "no checkout recorded", while a malformed one makes the whole record unreadable rather than
 *  inventing hosting facts. */
function rootsOf(raw: unknown): DaemonRootState[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const roots: DaemonRootState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.root !== 'string' || entry.root === '') return null;
    if (!(entry.team === null || typeof entry.team === 'string')) return null;
    if (!['starting', 'serving', 'already-running', 'failed'].includes(entry.send as string)) return null;
    if (!['starting', 'serving', 'failed'].includes(entry.bus as string)) return null;
    if (!(entry.why === null || typeof entry.why === 'string')) return null;
    for (const key of ['sendWhy', 'busWhy'] as const) {
      const value = entry[key];
      if (!(value === undefined || value === null || typeof value === 'string')) return null;
    }
    for (const key of ['sendFailedAt', 'busFailedAt'] as const) {
      const value = entry[key];
      if (!(value === undefined || value === null || typeof value === 'string')) return null;
    }
    const watch = watchOf(entry.watch);
    const presence = presenceOf(entry.presence);
    const firstPass = firstPassOf(entry.firstPass);
    const chores = choresOf(entry.chores);
    roots.push({
      root: entry.root,
      team: entry.team as string | null,
      send: entry.send as DaemonRootState['send'],
      bus: entry.bus as DaemonRootState['bus'],
      why: entry.why as string | null,
      ...(entry.sendWhy === undefined ? {} : { sendWhy: entry.sendWhy as string | null }),
      ...(entry.busWhy === undefined ? {} : { busWhy: entry.busWhy as string | null }),
      ...(entry.sendFailedAt === undefined ? {} : { sendFailedAt: entry.sendFailedAt as string | null }),
      ...(entry.busFailedAt === undefined ? {} : { busFailedAt: entry.busFailedAt as string | null }),
      ...(watch === null ? {} : { watch }),
      ...(presence === null ? {} : { presence }),
      ...(firstPass === null ? {} : { firstPass }),
      ...(chores === null ? {} : { chores }),
    });
  }
  return roots;
}

/**
 * A watch record is display data, not a hosting fact: a malformed one is left out rather than
 * making the whole daemon record unreadable, and an absent one means the route was not started
 * to carry a hosted watch.
 */
function watchOf(raw: unknown): HostedWatchState | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.routeId !== 'string' || entry.routeId === '') return null;
  if (typeof entry.root !== 'string' || entry.root === '') return null;
  if (typeof entry.team !== 'string' || typeof entry.session !== 'string') return null;
  if (!['starting', 'running', 'standby', 'stopping', 'stopped', 'failed'].includes(entry.phase as string)) return null;
  if (typeof entry.startedAt !== 'string') return null;
  if (!(entry.lastCycleAt === null || typeof entry.lastCycleAt === 'string')) return null;
  if (![null, 'pass', 'failed'].includes(entry.lastCycleOutcome as string | null)) return null;
  if (!Number.isInteger(entry.cycles) || (entry.cycles as number) < 0) return null;
  if (!Number.isInteger(entry.failures) || (entry.failures as number) < 0) return null;
  if (!['blocked', 'open'].includes(entry.effects as string)) return null;
  if (typeof entry.required !== 'boolean') return null;
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  return {
    routeId: entry.routeId,
    root: entry.root,
    team: entry.team,
    session: entry.session,
    phase: entry.phase as HostedWatchState['phase'],
    startedAt: entry.startedAt,
    lastCycleAt: entry.lastCycleAt as string | null,
    lastCycleOutcome: entry.lastCycleOutcome as HostedWatchState['lastCycleOutcome'],
    cycles: entry.cycles as number,
    failures: entry.failures as number,
    effects: entry.effects as HostedWatchState['effects'],
    required: entry.required,
    why: entry.why as string | null,
  };
}

function positiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** A bus first-pass record is display data, not a hosting fact: a malformed one is left out
 *  rather than making the whole daemon record unreadable. A running record carries no settle
 *  instant, and a settled one must name it and say whether the walk finished or stopped on a
 *  failure — a "done" without either could not be printed honestly, so it is left out too. */
function firstPassOf(raw: unknown): DaemonRootFirstPass | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.running !== 'boolean') return null;
  if (!Number.isInteger(entry.scanned) || (entry.scanned as number) < 0) return null;
  if (entry.running) {
    // A running pass carries no settle instant; one that names a time is self-contradicting.
    if (!(entry.doneAt === null || entry.doneAt === undefined)) return null;
    return { running: true, scanned: entry.scanned as number, doneAt: null };
  }
  if (typeof entry.doneAt !== 'string' || entry.doneAt === '') return null;
  if (typeof entry.errors !== 'boolean') return null;
  return { running: false, scanned: entry.scanned as number, doneAt: entry.doneAt, errors: entry.errors };
}

/** A presence lifecycle record is display evidence for an operator, not a hosting fact: a
 *  malformed one is left out rather than making the whole daemon record unreadable. */
function presenceOf(raw: unknown): DaemonRootState['presence'] | null {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.state !== 'pending') return null;
  if (typeof entry.why !== 'string' || entry.why === '') return null;
  return { state: 'pending', why: entry.why };
}

/** A field a chores row must not carry in a form this reader cannot trust. */
const INVALID_CHORES_FIELD = Symbol('invalid chores field');

/**
 * One chores row's last-chore reading, or null when the record predates the field. A present
 * field with a name, an instant and a whole non-negative duration is read whole; anything else
 * makes the row unreadable rather than shown as a guess.
 */
function choreOf(raw: unknown): DaemonChoresState['lastChore'] | typeof INVALID_CHORES_FIELD {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INVALID_CHORES_FIELD;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.name !== 'string' || entry.name === '') return INVALID_CHORES_FIELD;
  if (typeof entry.at !== 'string' || entry.at === '') return INVALID_CHORES_FIELD;
  if (!(entry.ms === null || (typeof entry.ms === 'number' && Number.isFinite(entry.ms) && entry.ms >= 0))) {
    return INVALID_CHORES_FIELD;
  }
  return { name: entry.name, at: entry.at, ms: entry.ms as number | null };
}

/** One chores row's last presence answer, or null when the record predates the field. The seat
 *  counts are whole numbers, and a row that claims more proved than were declared is unreadable. */
function chorePresenceOf(raw: unknown): DaemonChoresState['presence'] | typeof INVALID_CHORES_FIELD {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INVALID_CHORES_FIELD;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.at !== 'string' || entry.at === '') return INVALID_CHORES_FIELD;
  if (!(entry.ms === null || (typeof entry.ms === 'number' && Number.isFinite(entry.ms) && entry.ms >= 0))) {
    return INVALID_CHORES_FIELD;
  }
  if (!Number.isInteger(entry.proved) || (entry.proved as number) < 0) return INVALID_CHORES_FIELD;
  if (!Number.isInteger(entry.missed) || (entry.missed as number) < 0) return INVALID_CHORES_FIELD;
  return {
    at: entry.at,
    ms: entry.ms as number | null,
    proved: entry.proved as number,
    missed: entry.missed as number,
  };
}

/** One chores row's marker-cache reading, or null when the child has not reported one. Every
 *  count is a whole number that cannot be negative; a present malformed reading drops the row. */
function choreCacheOf(raw: unknown): DaemonChoresState['markerCache'] | typeof INVALID_CHORES_FIELD {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INVALID_CHORES_FIELD;
  const entry = raw as Record<string, unknown>;
  for (const key of ['read', 'reused', 'cached'] as const) {
    if (!Number.isInteger(entry[key]) || (entry[key] as number) < 0) return INVALID_CHORES_FIELD;
  }
  return {
    read: entry.read as number,
    reused: entry.reused as number,
    cached: entry.cached as number,
  };
}

/**
 * A chores record is display data, not a hosting fact: a malformed one is left out rather than
 * making the whole daemon record unreadable, and an absent one means the route was not started
 * with a chores seam.
 */
function choresOf(raw: unknown): DaemonChoresState | null {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!['per-root', 'shared', 'inline'].includes(entry.mode as string)) return null;
  if (!['starting', 'ok', 'late', 'restarting', 'inline', 'stopped'].includes(entry.state as string)) return null;
  if (!(entry.pid === null || positiveInt(entry.pid))) return null;
  for (const key of ['startedAt', 'heartbeatAt', 'nextStartAt'] as const) {
    if (!(entry[key] === null || typeof entry[key] === 'string')) return null;
  }
  if (!(entry.rssBytes === null || (typeof entry.rssBytes === 'number' && Number.isFinite(entry.rssBytes) && entry.rssBytes >= 0))) {
    return null;
  }
  if (!(entry.busy === null || typeof entry.busy === 'string')) return null;
  if (!Number.isInteger(entry.restarts) || (entry.restarts as number) < 0) return null;
  if (!Number.isInteger(entry.missed) || (entry.missed as number) < 0) return null;
  if (!(entry.lastPassAt === null || typeof entry.lastPassAt === 'string')) return null;
  if (!(entry.lastPass === null || (Array.isArray(entry.lastPass) && entry.lastPass.every((note) => typeof note === 'string')))) {
    return null;
  }
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  // The step-5 readings are absent from a record written before them, which reads as "none
  // reported"; a present field in a form this reader cannot trust drops the row.
  const lastChore = choreOf(entry.lastChore);
  const presence = chorePresenceOf(entry.presence);
  const markerCache = choreCacheOf(entry.markerCache);
  if (lastChore === INVALID_CHORES_FIELD || presence === INVALID_CHORES_FIELD || markerCache === INVALID_CHORES_FIELD) {
    return null;
  }
  return {
    mode: entry.mode as DaemonChoresState['mode'],
    state: entry.state as DaemonChoresState['state'],
    pid: entry.pid as number | null,
    startedAt: entry.startedAt as string | null,
    heartbeatAt: entry.heartbeatAt as string | null,
    rssBytes: entry.rssBytes as number | null,
    busy: entry.busy as string | null,
    restarts: entry.restarts as number,
    missed: entry.missed as number,
    lastPassAt: entry.lastPassAt as string | null,
    lastPass: entry.lastPass === null ? null : (entry.lastPass as string[]),
    lastChore,
    presence,
    markerCache,
    nextStartAt: entry.nextStartAt as string | null,
    why: entry.why as string | null,
  };
}

/** Writes the state record atomically, 0600, in a 0700 machine folder. */
export function writeDaemonState(home: string, state: DaemonState): void {
  ensureMachineDir(home);
  const path = daemonStatePath(home);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Whether the recorded process still exists. A dead pid makes the record stale. */
export function daemonStateAlive(state: DaemonState): boolean {
  return pidAlive(state.pid);
}

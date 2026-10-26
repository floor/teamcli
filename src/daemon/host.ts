// The one machine-wide daemon process: it serves the machine socket (protocol v1, health only
// until the verified-principal binding lands) and hosts the existing per-clone send and bus
// servers in this one process, so no second or third daemon process is started beside it.
//
// The daemon reads no credential store. The broker feature stays absent until its handler and
// its owner-authorized credential path land; the catalogue's `daemon.broker` policy is off by
// default, and a machine with no handler never falls back to the old per-clone broker.
//
// A crash is the service manager's job (the unit restarts a failed process). A hang is not, so
// the daemon refreshes a heartbeat and records any request it has held too long; a probe that
// gets no answer is reported as running with an unanswered probe, never as healthy.
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { busSocket, startBus, type BusHandle } from '../bus/server.ts';
import { freshBusWatch, nextBackoffMs, reviveBus, type BusWatch } from '../bus/supervise.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { paneProcesses } from '../herdr.ts';
import { eventThresholdsInForce } from '../policy/index.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { runRestoreSweepForRoute, type RestoreSweepResult } from '../launch/restore-sweep.ts';
import { isSeatId, pidAlive, readState } from '../state.ts';
import { probeDaemonSocket, startSendDaemon, realDaemonHost, type DaemonHost, type SendDaemonHandle } from '../send/daemon.ts';
import { formatDaemonResponse, parseDaemonRequest, answerDaemonRequest, DAEMON_FRAME_LIMIT, DAEMON_PROTOCOL_VERSION, type DaemonErrorCode, type DaemonHealthSnapshot, type DaemonRequest, type DaemonResponse, type DaemonRootHealthSnapshot } from './protocol.ts';
import { probeDaemonHealth } from './health.ts';
import { sweepFallbackEscalations, type SweepRoot } from './fallback-sweep.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath } from './paths.ts';
import { createHostServer } from '../../packages/relay/host/server.js';
import { canonicalRoot, duplicateRoute, resolveScope, routeOf, type HostedRoute } from './routes.ts';
import type { NextAnswer, NextClaim, NextHandlerInput } from './next.ts';
import { createFaultInbox } from './fault.ts';
import { createHostedWatch, type HostedEffects, type HostedWatch } from './watch.ts';
import { hostedWatchAuthority } from './watch-authority.ts';
import { createPresenceIngester, type PresenceIngester } from './presence/ingest.ts';
import { createPresenceActivity, type PresenceActivityStep } from './presence/activity.ts';
import { createPresencePublisher, type PresencePublisherStep } from './presence/publish.ts';
import { isPresenceBinding, readPresenceReading } from './presence/contract.ts';
import { presencePaths } from './presence/spool.ts';
import { codexPresenceFor, codexPresenceTarget } from './presence/codex-source.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, adoptPresenceSource, createPresenceChannelHealth, presenceStepHealth,
  reconcilePresenceProof, reconciledProofHolds, unprovenSource, type PresenceCanonicalPosition,
  type PresenceChannelHealth, type PresenceReconciledProof, type PresenceSource,
  type PresenceSourceRuntime, type PresenceSourceStatus,
} from './presence/health.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../watch/authority.ts';
import type { BrokerWorkSource } from '../idle_work.ts';
import { sendWatchDirect } from '../watch/direct-send.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import {
  ensureMachineDir,
  writeDaemonState,
  type DaemonFeatures,
  type DaemonRootState,
  type DaemonStuckRequest,
} from './state.ts';

/** One checkout as hosted by this process; the state record keeps the same shape. */
export type MachineRootStatus = DaemonRootState;

export type MachineDaemon = {
  socketPath: string;
  roots: MachineRootStatus[];
  /** The routing table a later machine-socket handler resolves a scope against. */
  routes: readonly HostedRoute[];
  health(): DaemonHealthSnapshot;
  close(): Promise<void>;
};

/** What a route's watch is built from. The host owns the tick and the cancellation; the run
 *  is the shared watch loop, or a test's stand-in for it. */
export type HostedWatchBuild = {
  run(loop: HostedLoop): Promise<number>;
  /** `open` only while the route's own gate admits effects; a getter keeps the recorded state
   *  truthful as that gate closes and opens. */
  effects?: HostedEffects | (() => HostedEffects);
  /** Defaults to true: a host is created only when the route was started to carry a watch. */
  required?: boolean;
  /** The route cannot host a watch: the watch starts standing down with this reason. */
  standby?: string;
  /** Runs on every daemon heartbeat tick for this route, before due waits are settled.
   *  `false` closes effects: the host then resolves every outstanding wait false. */
  tick?: (at: Date) => boolean | void;
};

/** What the daemon resolved for one route besides the route itself and its log. `brokerWork` is
 *  present only when this daemon hosts the broker and a reader was built for the route; it is
 *  the watch's only way to count a tracker team's takeable work. */
export type HostedWatchExtras = { brokerWork?: BrokerWorkSource };

/** The caller one `next` request is proved to be. The pane is what the verifier proved, never
 *  the frame's claim; the host dispatches only when the two agree. */
export type NextPrincipalVerdict =
  | { kind: 'verified'; seat: string; pane: string }
  | { kind: 'refused'; why: string };

/**
 * Proves who a `next` request's caller is from evidence the daemon owns, given the untrusted
 * claim the frame carried. The frame's `scope` is an argument, never a proof: an honest check
 * consults the route's state, placement or pane evidence and returns the identity it proved.
 * The host runs a handler only when this verdict names exactly the claimed (seat, pane), so a
 * verifier that cannot bind the caller must refuse instead of echoing the claim back.
 */
export type NextPrincipalCheck = (input: {
  route: HostedRoute;
  team: TeamFile;
  claim: NextClaim;
  now: Date;
}) => NextPrincipalVerdict | Promise<NextPrincipalVerdict>;

/** Serves one proved `next` request. `handleNext` is this shape; a caller that needs its own
 *  broker proxy or deadline binds it and passes the bound function. */
export type NextDispatchHandler = (input: NextHandlerInput) => Promise<NextAnswer>;

export type StartMachineDaemonInput = {
  home?: string;
  /** The checkouts whose send and bus endpoints this one process hosts. */
  roots: string[];
  startedBy?: string;
  version: string;
  now?: () => Date;
  /** How often the state record's heartbeat is refreshed. */
  heartbeatMs?: number;
  /** How long a request may be in flight before it is reported as stuck. */
  stuckMs?: number;
  /** `absent` until the broker handler lands; never `on` without the owner's go. */
  features?: DaemonFeatures;
  /** Injected for a test that must not touch the real terminal host's pane sources. */
  sendHost?: DaemonHost;
  /** Starts one root's per-project send server. The default starts the real server; a test
   *  injects its own to read the start input without binding a socket. */
  sendStart?: typeof startSendDaemon;
  /**
   * Whether each hosted route carries a watch on the daemon's heartbeat. Off by default: the
   * quiet foundation lands before any activation, and a daemon started only to host endpoints
   * carries none. A route with a watch records one; a route without was never started with
   * one, and a reader must not treat its silence as a failed watch.
   */
  watchHosting?: boolean;
  /** Builds one route's watch. The default runs the shared watch loop over the real read
   *  sources with mutating sources closed and outbound effects blocked; a test injects its
   *  own run and clock and, only with a verified admitted sender, `open` effects. The third
   *  argument carries what the daemon resolved for this route besides the route itself. */
  hostedWatch?: (route: HostedRoute, log: (text: string) => void, extras: HostedWatchExtras) => HostedWatchBuild;
  /**
   * The broker reading the hosted watches may count for a tracker team, built per route. Only a
   * daemon that hosts the broker resolves one (`features.broker === 'on'`); otherwise the
   * builder is never called and a tracker team's idle reading stays explicitly unknown. The
   * reader is the caller's: this daemon never opens the broker's socket or reads a credential
   * itself. Absent even with the broker hosted, the same explicit unknown stands.
   */
  brokerWork?: (route: HostedRoute) => BrokerWorkSource | undefined;
  /**
   * Whether each hosted route also runs the presence ingester, the activity reconciler and the
   * publisher that copies applied transitions to the bus event log on the daemon's own 250 ms
   * pass. Off by default: the integration lands closed, and a daemon started only to host
   * endpoints ingests nothing. Internal, like `watchHosting`; not a setting and not printed.
   */
  presenceHosting?: boolean;
  /** Builds one canonical route's ingester. The default builds the real module; a test injects
   *  its own handle to observe steps, coalescing and close. */
  presenceIngest?: (route: HostedRoute, stateDir: string) => PresenceIngester;
  /** Builds one route's activity reconciler step. The default walks the transition reader. */
  presenceActivity?: (route: HostedRoute, stateDir: string) => PresenceActivityStep;
  /** Builds one route's presence publisher step. The default appends through the bus event log;
   *  a test injects its own to observe what is published and when. */
  presencePublish?: (route: HostedRoute, stateDir: string) => PresencePublisherStep;
  /**
   * Builds one canonical route's subscribed per-seat read-only runtime sources. The default is
   * the production wiring: for every declared seat it resolves an explicit Codex target under the
   * signed `codex-daemon` policy and the endpoint the machine recorded, starts a source only for a
   * resolved target, and registers every seat whose expected attachment could not be resolved or
   * started as an explicit unproven source. It never discovers or guesses an endpoint, and a
   * non-Codex seat is a skip. An injected builder replaces that wiring wholly. A resolution or
   * start failure is not a skip: it becomes unproven, so the seat is explicitly unhealthy.
   * A producer may name the seat on the source or only on its status reading, and `state` /
   * `cancel` are accepted as aliases; the host adopts the first reading at registration. The
   * wiring resolves targets under the existing policy; the host only fences, samples and closes
   * what it is given. A factory that throws leaves the route's classification unresolved, which
   * holds every seat rather than letting an expected native attachment inherit hook health.
   */
  presenceSubscriptions?: (route: HostedRoute, stateDir: string) => PresenceSourceRuntime[];
  /**
   * The explicit Codex app-server endpoint for one seat, when the machine's launch recorded one.
   * The production wiring never discovers or guesses an endpoint: an absent answer leaves the
   * target resolver's answer `unproven`, so the seat is held instead of attached to a socket the
   * machine was not told about. Ignored when `presenceSubscriptions` is injected.
   */
  presenceCodexEndpoint?: (route: HostedRoute, stateDir: string, seat: string) => string | null | undefined;
  /**
   * Seats this route expected to carry a managed native channel but whose target resolution or
   * start did not succeed, with the truthful why. Each becomes an explicit unproven source, so a
   * failed expected attachment can never fall back to the route's hook answer. A factory that
   * throws is unresolved classification and holds the whole route.
   */
  presenceUnproven?: (route: HostedRoute, stateDir: string) => Array<{ seat: string; why: string }>;
  /**
   * Proves one `next` request's caller. Absent in production until a verified principal binding
   * lands, and then every `next` request is refused with `daemon.auth-unsupported` and nothing
   * runs; no frame's own claim ever stands in for it. The host only calls the handler when this
   * check names exactly the claimed (seat, pane).
   */
  nextPrincipal?: NextPrincipalCheck;
  /**
   * Serves one proved `next` request. It is the caller's wiring, including any broker proxy: this
   * daemon opens no tracker socket itself. Absent, every `next` request is refused exactly as
   * with no verifier, so the two seams are only ever open together.
   */
  nextHandler?: NextDispatchHandler;
  /** The presence pass interval; 250 ms in production. A test shortens it. */
  presenceEveryMs?: number;
  /**
   * The daemon-start restore sweep: after the sockets, routes, state record and
   * shutdown machinery are wired, one guarded pass per canonical route repairs the seats its
   * recorded session lost. On by default, because a host restart is exactly when it is needed;
   * `false` turns it off, and a function replaces the runner for a test that must observe the
   * schedule without launching. A route with no recorded seats, or whose session is not running,
   * is skipped, and the sweep never cold-starts a team.
   */
  restoreSweep?: boolean | ((root: string, teamFile: string) => Promise<RestoreSweepResult>);
};

export type StartMachineDaemonResult =
  | { kind: 'serving'; daemon: MachineDaemon }
  | { kind: 'already-running'; pid: number | null }
  | { kind: 'locked'; pid: number | null }
  | { kind: 'bind-failed'; reason: string };

const HEARTBEAT_MS = 5_000;
const STUCK_MS = 10_000;
const PRESENCE_EVERY_MS = 250;

type InFlight = { op: string; since: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LockResult = { ok: true } | { ok: false; holder: number | null };

function readLockPid(path: string): number | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const pid = Number.parseInt(text, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** One lock file, 0600. A live holder is returned; a dead holder's file is removed once. */
function acquireLock(path: string, pid: number): LockResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${String(pid)}\n`, { flag: 'wx', mode: 0o600 });
      chmodSync(path, 0o600);
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return { ok: false, holder: null };
    }
    const holder = readLockPid(path);
    if (holder !== null && pidAlive(holder)) return { ok: false, holder };
    try {
      unlinkSync(path);
    } catch {
      return { ok: false, holder };
    }
  }
  return { ok: false, holder: readLockPid(path) };
}

/** One line in the daemon's one log, cleaned the same way every command's log line is. */
export function appendDaemonLog(home: string, line: string, now: Date = new Date()): void {
  try {
    ensureMachineDir(home);
    const path = daemonLogPath(home);
    appendFileSync(path, `${now.toISOString()} ${plainLine(line).replace(/\s+/g, ' ')}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Dropped on purpose: the daemon's answers never depend on its log being writable.
  }
}

function snapshotOf(fields: {
  pid: number;
  uid: number;
  since: string;
  startedBy: string;
  version: string;
  heartbeatAt: string;
  features: DaemonFeatures;
  stuck: DaemonStuckRequest[];
  roots?: DaemonRootHealthSnapshot[];
}): DaemonHealthSnapshot {
  return {
    pid: fields.pid,
    uid: fields.uid,
    since: fields.since,
    startedBy: fields.startedBy,
    version: fields.version,
    heartbeatAt: fields.heartbeatAt,
    stuck: fields.stuck,
    features: fields.features,
    ...(fields.roots === undefined ? {} : { roots: fields.roots }),
  };
}

/** One hosted endpoint pair and the status record its liveness is written into. */
type EndpointWatch = {
  status: MachineRootStatus;
  sendSocket: string | null;
  busSocket: string | null;
  /** The checkout whose bus this heartbeat may restart. Null until the team file loads. */
  busRoot: string | null;
  busState: BusWatch;
};

/** A bus socket has no ping op, so one successful connect is the whole liveness answer. */
function probeBusSocket(socketPath: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('close', () => finish(false));
  });
}

/**
 * Starts the one machine daemon. It binds the machine socket first, then hosts send and bus for
 * every root it was given. A root that cannot be read or hosted is named in the returned status
 * and in the daemon log; it never stops the health endpoint or another root from serving.
 */
export async function startMachineDaemon(input: StartMachineDaemonInput): Promise<StartMachineDaemonResult> {
  const home = input.home ?? homedir();
  const now = input.now ?? (() => new Date());
  const startedBy = input.startedBy ?? 'manual';
  const features: DaemonFeatures = input.features ?? { broker: 'absent' };
  const heartbeatMs = input.heartbeatMs ?? HEARTBEAT_MS;
  const stuckMs = input.stuckMs ?? STUCK_MS;
  const pid = process.pid;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const socketPath = daemonSocketPath(home);
  const lockPath = daemonLockPath(home);
  const since = now().toISOString();

  ensureMachineDir(home);
  const lock = acquireLock(lockPath, pid);
  if (!lock.ok) {
    if (lock.holder !== null && pidAlive(lock.holder)) {
      const answer = await probeDaemonHealth(socketPath, { id: `start-${randomUUID()}` });
      if (answer.kind === 'answered') return { kind: 'already-running', pid: answer.health.pid };
      return { kind: 'locked', pid: lock.holder };
    }
    return { kind: 'bind-failed', reason: 'the daemon single-instance lock could not be taken' };
  }

  const releaseLock = (): void => {
    if (readLockPid(lockPath) === pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  };

  const entry = lstatSync(socketPath, { throwIfNoEntry: false });
  if (entry && !entry.isSocket()) {
    releaseLock();
    return { kind: 'bind-failed', reason: 'the daemon socket path holds an entry that is not a socket' };
  }
  if (entry) {
    const answer = await probeDaemonHealth(socketPath, { id: `start-${randomUUID()}` });
    if (answer.kind === 'answered') {
      releaseLock();
      return { kind: 'already-running', pid: answer.health.pid };
    }
    try {
      unlinkSync(socketPath);
    } catch {
      releaseLock();
      return { kind: 'bind-failed', reason: 'a stale daemon socket could not be removed' };
    }
  }

  const inFlight = new Map<string, InFlight>();
  const roots: MachineRootStatus[] = [];
  const routes: HostedRoute[] = [];
  /** The team file each route was actually loaded from, by canonical root. */
  const teamFiles = new Map<string, string>();
  // Filled once the roots loop has resolved every route; a status entry gains its `watch`
  // record on each state write, and only entries that actually got a host ever have one.
  const hostedWatches: { status: MachineRootStatus; watch: HostedWatch }[] = [];
  /** The presence work per accepted route, and this process's one in-flight run per route. */
  const presenceWork: {
    route: HostedRoute;
    /** The team file's folder; the seat's current binding is read from its state record. */
    stateDir: string;
    ingester: PresenceIngester;
    activity: PresenceActivityStep;
    publisher: PresencePublisherStep;
    /** One read-only runtime source per managed seat; empty for a hook-only route. */
    sources: PresenceSource[];
    /** One in-flight pump per source, so a slow source holds only its own seat's answer. */
    sourceRuns: (Promise<void> | null)[];
    /** This route's fixed liveness, answered per seat to its hosted watch's dispatcher. */
    health: PresenceChannelHealth;
    /** The last proof, per seat, that the source's staged event identity reached both the
     *  canonical projection and the applied fence. A reader re-checks it against a fresh source
     *  reading, so a later stage holds at once rather than at the next pass. */
    proofs: Map<string, PresenceReconciledProof>;
    /** Why the last reconciliation for a seat did not prove application, for display. */
    proofMiss: Map<string, string>;
  }[] = [];
  const presenceRuns = new Map<string, Promise<void>>();
  const presenceLogged = new Set<string>();
  /** The one-flight daemon-start restore sweep. `closeOnce` drains it beside the presence
   *  passes; the sweep reads the daemon's closing flag to stop between seat steps. */
  let restoreSweepRun: Promise<void> | null = null;
  // The hosted send server may take a delivery while this start is still wiring the presence
  // answers. Until the verdict helper below exists the per-seat answer is false, which holds
  // typing instead of reading a helper that is not initialised yet.
  let seatReady = false;
  let heartbeatAt = since;
  let closed = false;

  const stuckNow = (): DaemonStuckRequest[] => {
    const at = now().getTime();
    const stuck: DaemonStuckRequest[] = [];
    for (const [id, request] of inFlight) {
      const ageMs = at - request.since;
      if (ageMs < stuckMs) continue;
      stuck.push({ id, op: request.op, since: new Date(request.since).toISOString(), ageMs });
    }
    return stuck;
  };

  /**
   * The canonical routes for this request, derived from the in-memory route table rather than
   * copied from the five-second state record. A route carries a presence answer only when this
   * process owns a presence pass for it; with presence hosting off the field is omitted, which
   * a reader must treat as unknown, never as healthy.
   *
   * The answer is never a stored word: `serving` with `healthy: true` only while this process
   * owns the route, is not closing, and the route's last finished step answered the producer's
   * own `healthy: true` with no known backlog inside the fixed grace window. A gap, a failed
   * step, a known backlog and a closing daemon all answer `pending` with `healthy: false`.
   */
  const rootsSnapshot = (at: Date): DaemonRootHealthSnapshot[] => {
    const checkedAt = at.toISOString();
    return routes.map((route) => {
      const presence = presenceWork.find((one) => one.route.root === route.root);
      if (presence === undefined) return { root: route.root };
      const healthy = !closed && presence.health.healthy(at);
      const why = healthy
        ? null
        : closed
          ? 'the daemon is closing'
          : presence.health.reason(at) ?? 'the presence channel is not current';
      // The route's answer stays the ingest answer. Every declared seat carries its own explicit
      // classification, so a mixed route's hook seat qualifies on fresh ingest while an expected
      // native seat holds, and one seat's unproven channel never marks a sibling pending.
      const seats = route.seats.map((seat) => {
        // Sampled and reconciled at this reading's own instant: an event staged since the last
        // pass holds the seat now, not after the next pump.
        const verdict = seatVerdict(presence, seat, at);
        const serving = verdict.why === null;
        return {
          seat,
          state: serving ? 'serving' as const : 'pending' as const,
          healthy: serving,
          source: verdict.source,
          binding: verdict.binding,
          appliedEventId: verdict.appliedEventId,
          why: verdict.why,
        };
      });
      return {
        root: route.root,
        presence: {
          session: route.session,
          state: healthy ? 'serving' : 'pending',
          healthy,
          checkedAt,
          why,
          ...(seats.length === 0 ? {} : { seats }),
        },
      };
    });
  };

  const health = (): DaemonHealthSnapshot => {
    const at = now();
    return snapshotOf({
      pid,
      uid,
      since,
      startedBy,
      version: input.version,
      heartbeatAt,
      features,
      stuck: stuckNow(),
      ...(routes.length > 0 ? { roots: rootsSnapshot(at) } : {}),
    });
  };

  const writeState = (afterClose = false): void => {
    if (closed && !afterClose) return;
    for (const one of hostedWatches) one.status.watch = one.watch.state();
    try {
      writeDaemonState(home, {
        format: 1,
        pid,
        uid,
        since,
        startedBy,
        version: input.version,
        heartbeatAt,
        socket: socketPath,
        features,
        stuck: stuckNow(),
        roots: [...roots],
      });
    } catch {
      // The next heartbeat tries again; an unwritable record is reported as unknown, never healthy.
    }
  };

  /**
   * One v2 `op=next` frame, from the frame to the handler's answer. The route is resolved and its
   * file reloaded first, so the handler serves the checkout the daemon hosts now, not the one it
   * hosted at start. Everything after that fails closed: a missing claim, verifier or handler, a
   * refused or mismatched proof, or a handler failure leaves the request refused with nothing
   * dispatched. Without a verifier and a handler the answer is the pinned default refusal.
   */
  const answerNext = async (request: DaemonRequest): Promise<DaemonResponse> => {
    const nextRefusal = (message: string): DaemonResponse => ({
      v: request.v,
      id: request.id,
      ok: false,
      error: { code: 'daemon.auth-unsupported', message },
    });
    const nextInternal = (message: string): DaemonResponse => ({
      v: request.v,
      id: request.id,
      ok: false,
      error: { code: 'daemon.internal', message },
    });
    const scope = request.scope ?? {};
    const resolved = resolveScope(routes, scope);
    if (resolved.kind !== 'one') {
      return {
        v: request.v,
        id: request.id,
        ok: false,
        error: { code: 'daemon.scope-mismatch', message: resolved.why },
      };
    }
    const route = resolved.route;
    const teamFile = teamFiles.get(route.root);
    if (teamFile === undefined) {
      return nextInternal('the resolved route has no recorded team file');
    }
    let loaded;
    try {
      loaded = readTeamConfig(dirname(teamFile), { file: teamFile, home });
    } catch (error) {
      return nextInternal(`the route's team file could not be read: ${plainText(error instanceof Error ? error.message : String(error))}`);
    }
    if (!loaded.ok) {
      return nextInternal(`the route's team file could not be read: ${loaded.errors[0]?.message ?? 'unknown error'}`);
    }
    const seat = scope.seat;
    const pane = scope.pane;
    const principal = input.nextPrincipal;
    const handler = input.nextHandler;
    if (seat === undefined || pane === undefined || principal === undefined || handler === undefined) {
      // No claim, no verifier or no handler: the same refusal the default dispatcher gives, so
      // the seam being closed is indistinguishable from the op never being served here.
      return answerDaemonRequest(request, health());
    }
    const at = now();
    let verdict: NextPrincipalVerdict;
    try {
      verdict = await principal({ route, team: loaded.team, claim: { seat, pane }, now: at });
    } catch (error) {
      return nextRefusal(
        `next: the caller could not be verified (${plainText(error instanceof Error ? error.message : String(error))}); nothing was done`,
      );
    }
    if (verdict.kind !== 'verified') {
      return nextRefusal(`next: ${verdict.why}; nothing was done`);
    }
    if (verdict.seat !== seat || verdict.pane !== pane) {
      return nextRefusal('next: the verified principal does not match the seat and pane the request claimed; nothing was done');
    }
    try {
      const answer = await handler({
        route,
        team: loaded.team,
        caller: { seat: verdict.seat, pane: verdict.pane },
        action: request.action ?? 'claim',
        mine: request.mine ?? false,
        now: at.getTime(),
      });
      return { v: request.v, id: request.id, ok: true, next: answer };
    } catch (error) {
      return nextInternal(
        `next: the handler failed (${plainText(error instanceof Error ? error.message : String(error))}); the state it reached is unknown`,
      );
    }
  };

  // The accept, frame and close mechanics live in the relay package's framing host; this process
  // keeps the protocol: the same line parser and refusal bytes, the same health answer and
  // in-flight tracking, and the same socket file, permission and stale-path ownership below.
  const host = createHostServer({
    socketPath,
    frameLimit: DAEMON_FRAME_LIMIT,
    onError: (error) => {
      // A listener error after the bind is recorded; the service manager still owns restarts.
      appendDaemonLog(home, `machine socket: ${error.message}`, now());
    },
    // The daemon's parser owns validation and takes the exact framed line; the decoded value the
    // host also offers is never a principal and is not needed here.
    onRequest: async (_input, line) => {
      const parsed = parseDaemonRequest(line);
      if (!parsed.ok) {
        return formatDaemonResponse({ v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false, error: parsed.error });
      }
      const request = parsed.request;
      if (closed) {
        // Admission is closed while the presence drain runs: the endpoint still owns its socket
        // and refuses work until the drain is truthful and the release below unlinks it.
        return formatDaemonResponse({
          v: request.v,
          id: request.id,
          ok: false,
          error: { code: 'daemon.internal', message: 'the daemon is closing' },
        });
      }
      const started = now().getTime();
      inFlight.set(request.id, { op: request.op, since: started });
      try {
        // Only a v2 frame can reach the next boundary; a v1 `next` keeps the default refusal.
        if (request.op === 'next' && request.v === 2) {
          return formatDaemonResponse(await answerNext(request));
        }
        return formatDaemonResponse(answerDaemonRequest(request, health()));
      } finally {
        inFlight.delete(request.id);
      }
    },
    onRefused: (reason) => {
      const error: { code: DaemonErrorCode; message: string } =
        reason === 'frame-limit'
          ? { code: 'daemon.bad-frame', message: 'the request line exceeds the frame limit' }
          : reason === 'malformed'
            ? { code: 'daemon.bad-frame', message: 'the request line is not JSON' }
            : { code: 'daemon.internal', message: 'the request could not be answered' };
      return formatDaemonResponse({ v: DAEMON_PROTOCOL_VERSION, id: '', ok: false, error });
    },
  });

  const listening = await host.listen();
  if (!listening.ok) {
    releaseLock();
    return {
      kind: 'bind-failed',
      reason: `the daemon socket could not be bound: ${listening.code ?? 'unknown error'}`,
    };
  }
  chmodSync(socketPath, 0o600);
  writeState();

  const sendHandles: SendDaemonHandle[] = [];
  const busHandles: BusHandle[] = [];
  const watched: EndpointWatch[] = [];
  /** The roots whose team files validated: the only ones the heartbeat's fallback sweep reads. */
  const sweepRoots: SweepRoot[] = [];

  // Staged limitation, and the exact block the extraction replaces: the machine protocol
  // socket is the daemon's own endpoint, but send and bus still have no machine route, so this
  // one process hosts each checkout's existing send and bus listeners beside it. N checkouts
  // therefore mean 2N+1 endpoints in one process until the machine endpoint serves route
  // delivery and a shared per-seat queue behind the relay package boundary.
  for (const rootArg of input.roots) {
    const status: MachineRootStatus = { root: rootArg, team: null, send: 'failed', bus: 'failed', why: null };
    // A root with no hosted endpoint keeps both sockets null and the refresh skips it.
    const watch: EndpointWatch = { status, sendSocket: null, busSocket: null, busRoot: null, busState: freshBusWatch() };
    watched.push(watch);
    const loaded = readTeamConfig(rootArg, { home });
    if (!loaded.ok) {
      status.why = loaded.errors[0]?.message ?? 'the team file cannot be read';
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: ${status.why}`, now());
      continue;
    }
    // Routed by what the loader actually opened, never by the spelling of the argument: two
    // spellings of one checkout are one route, or every scope naming it would be ambiguous.
    const canonical = canonicalRoot(loaded.root);
    if (canonical === null) {
      status.why = 'the checkout root cannot be resolved to a folder';
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: ${status.why}`, now());
      continue;
    }
    if (duplicateRoute(routes, canonical) !== null) {
      status.root = canonical;
      status.why = 'this checkout is already hosted by this daemon';
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: ${status.why}`, now());
      continue;
    }
    status.root = canonical;
    status.team = loaded.team.project;
    watch.busRoot = canonical;
    sweepRoots.push({ root: loaded.root, team: loaded.team });
    const route = routeOf(
      canonical,
      loaded.team.project,
      loaded.team.session,
      loaded.team.seats.map((seat) => seat.name),
    );
    routes.push(route);
    teamFiles.set(canonical, loaded.path);
    if (input.presenceHosting === true) {
      // One ingester per canonical route, created only after the duplicate check above accepted
      // the route: the daemon's single-instance lock is what makes this process the only writer.
      // A root with no readable team file or a second spelling of a hosted checkout got no route,
      // so it gets no ingester.
      const stateDir = dirname(loaded.path);
      const health = createPresenceChannelHealth(PRESENCE_HEALTH_GRACE_MS, since);
      // Every expected seat is registered before the first pass, so an unsampled seat can never
      // inherit the route's answer. A resolution or start failure is registered as an explicit
      // unproven source; only a resolver's `skip` leaves a seat on the route's hook answer. A
      // factory that throws is an integration fault: nothing was started, and the call is logged
      // rather than hidden.
      const sources: PresenceSource[] = [];
      const register = (source: PresenceSource): void => {
        health.seatExpected(source.seat);
        sources.push(source);
      };
      /** The production wiring: resolve each declared seat's explicit Codex target under the
       *  signed `codex-daemon` policy, and start a source only for a resolved target. A `skip`
       *  is a seat with no managed native channel, whose route hook answer is its own; an
       *  `unproven` target is an expected attachment that could not be made, never a skip. No
       *  endpoint is guessed: without one the resolver itself answers `unproven`. */
      const productionSources = (): {
        runtimes: PresenceSourceRuntime[];
        unproven: Array<{ seat: string; why: string }>;
      } => {
        const runtimes: PresenceSourceRuntime[] = [];
        const unproven: Array<{ seat: string; why: string }> = [];
        for (const seat of loaded.team.seats) {
          const read = codexPresenceTarget({
            enabled: true,
            home,
            stateDir,
            root: canonical,
            herdrSession: loaded.team.session,
            session: loaded.team.session,
            seat: { name: seat.name, cli: seat.cli },
            endpoint: input.presenceCodexEndpoint?.(route, stateDir, seat.name) ?? null,
            now: now(),
          });
          if (read.kind === 'skip') continue;
          if (read.kind === 'unproven') {
            unproven.push({ seat: seat.name, why: read.why });
            continue;
          }
          // The target resolver only returns a target under an `on` policy, so the start gate
          // is already verified; a start refusal is still an explicit unproven attachment.
          const started = codexPresenceFor({
            target: read.target,
            policy: 'on',
            feature: true,
            now,
          });
          if (started.kind === 'subscribed') runtimes.push(started.source);
          else unproven.push({ seat: seat.name, why: started.why });
        }
        return { runtimes, unproven };
      };
      let unresolvedTargets: Array<{ seat: string; why: string }> = [];
      try {
        const runtimes = input.presenceSubscriptions === undefined
          ? (() => {
              const built = productionSources();
              unresolvedTargets = built.unproven;
              return built.runtimes;
            })()
          : input.presenceSubscriptions(route, stateDir);
        for (const runtime of runtimes) {
          const adopted = adoptPresenceSource(runtime, now());
          if ('source' in adopted) {
            register(adopted.source);
          } else if (adopted.seat !== null) {
            // A named seat whose source could not be adopted expected a native channel: it is
            // explicitly unproven rather than silently inheriting the route's hook answer.
            register(unprovenSource(adopted.seat, adopted.why));
          } else {
            // Without a seat the failure cannot be attributed; the route itself must not claim
            // health, or an expected attachment could still hide behind hook health.
            health.unresolved(`the runtime subscriptions were not classified: ${adopted.why}`);
          }
        }
      } catch (error) {
        const why = `the runtime subscriptions were not built: ${messageOf(error)}`;
        health.unresolved(why);
        appendDaemonLog(home, `presence ${route.root}: ${why}`, now());
      }
      try {
        for (const failed of [...unresolvedTargets, ...(input.presenceUnproven?.(route, stateDir) ?? [])]) {
          register(unprovenSource(failed.seat, failed.why));
        }
      } catch (error) {
        const why = `the runtime resolutions were not built: ${messageOf(error)}`;
        health.unresolved(why);
        appendDaemonLog(home, `presence ${route.root}: ${why}`, now());
      }
      presenceWork.push({
        route,
        stateDir,
        ingester: input.presenceIngest?.(route, stateDir)
          ?? createPresenceIngester({ stateDir, session: loaded.team.session }),
        activity: input.presenceActivity?.(route, stateDir)
          ?? createPresenceActivity({ stateDir, session: loaded.team.session }),
        publisher: input.presencePublish?.(route, stateDir)
          ?? createPresencePublisher({
            stateDir,
            session: loaded.team.session,
            project: loaded.team.project,
            root: canonical,
            home,
          }),
        sources,
        sourceRuns: sources.map(() => null),
        health,
        proofs: new Map(),
        proofMiss: new Map(),
      });
    }
    const sendHost: DaemonHost = input.sendHost ?? { ...realDaemonHost, home };
    // The route's presence work holds the same per-seat verdict the hosted watch consults: the
    // send server's last mile only types when this answer is true. Without presence hosting no
    // work entry exists, so the send start keeps its pre-opt-in input exactly.
    const presence = presenceWork.find((one) => one.route.root === canonical);
    let send: Awaited<ReturnType<typeof startSendDaemon>>;
    try {
      send = await (input.sendStart ?? startSendDaemon)({
        root: canonical, dir: canonical, team: loaded.team, host: sendHost,
        ...(presence === undefined ? {} : {
          presenceStateDir: presence.stateDir,
          presenceChannelHealthy: (seat: string) => seatReady && seatQualified(presence, seat, now()),
        }),
      });
    } catch (error) {
      status.why = `the send server could not start: ${error instanceof Error ? error.message : 'unknown error'}`;
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: ${status.why}`, now());
      continue;
    }
    if (send.kind === 'serving') {
      sendHandles.push(send.handle);
      status.send = 'serving';
      watch.sendSocket = send.handle.socketPath;
    } else if (send.kind === 'already-running') {
      status.send = 'already-running';
      watch.sendSocket = send.socketPath;
    } else {
      status.send = 'failed';
      status.why = send.kind === 'locked' ? 'another send server holds the project socket' : send.reason;
    }

    const thresholds = eventThresholdsInForce({
      home,
      entity: loaded.team.entity,
      projectId: projectIdOfTeam(home, loaded.team, loaded.root),
      root: loaded.root,
      team: loaded.team,
      upToLevel: 'team',
      now: now(),
    });
    if (!thresholds.ok) {
      status.bus = 'failed';
      if (status.why === null) status.why = thresholds.refusals.map((refusal) => refusal.message).join('; ');
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: bus not hosted: ${status.why}`, now());
      continue;
    }
    let bus: Awaited<ReturnType<typeof startBus>>;
    try {
      bus = await startBus({
        root: canonical,
        team: loaded.team,
        home,
        stderr: (text) => appendDaemonLog(home, text, now()),
        heldThresholdSeconds: thresholds.thresholds.held_threshold_seconds,
        now,
      });
    } catch (error) {
      status.bus = 'failed';
      if (status.why === null) status.why = `the bus server could not start: ${error instanceof Error ? error.message : 'unknown error'}`;
      roots.push(status);
      appendDaemonLog(home, `root ${rootArg}: ${status.why}`, now());
      continue;
    }
    if (bus.kind === 'serving') {
      busHandles.push(bus.handle);
      status.bus = 'serving';
      watch.busSocket = busSocket(canonical);
    } else {
      status.bus = 'failed';
      if (status.why === null) {
        status.why =
          bus.kind === 'busy'
            ? 'another bus server holds the project socket'
            : bus.kind === 'locked'
              ? 'another bus server is starting'
              : 'the bus socket could not be bound';
      }
    }
    roots.push(status);
    appendDaemonLog(home, `root ${rootArg}: send ${status.send}, bus ${status.bus}`, now());
  }

  /** The seat's current managed binding, read at the moment of use. A missing seat record, an
   *  absent binding or an unreadable team state means no continuity may be granted: the source's
   *  own binding is then fenced against nothing. */
  const currentBindingOf = (stateDir: string, session: string, seat: string): string | null => {
    try {
      const record = readState(stateDir).sessions[session]?.seats?.[seat];
      return record !== undefined && isPresenceBinding(record.presence_binding)
        ? record.presence_binding
        : null;
    } catch {
      return null;
    }
  };

  /** The exact canonical position for one seat: the applied projection (`current.json`) and the
   *  activity reconciler's applied fence, read together from the same state door. Both must name
   *  the same applied line; a projection the ingester wrote but activity has not fenced yet is
   *  deliberately not enough. */
  const canonicalSeatOf = (
    stateDir: string,
    session: string,
    seat: string,
  ): { canonical: PresenceCanonicalPosition | null; why: string | null } => {
    let record;
    try {
      record = readState(stateDir).sessions[session]?.seats?.[seat];
    } catch {
      return { canonical: null, why: 'the team state could not be read' };
    }
    if (record === undefined) return { canonical: null, why: 'the seat has no state record' };
    if (!isSeatId(record.id)) return { canonical: null, why: 'the seat record names no seat id' };
    if (!isPresenceBinding(record.presence_binding)) {
      return { canonical: null, why: 'the seat records no valid presence binding' };
    }
    const fence = record.presence_applied;
    if (fence === undefined) return { canonical: null, why: 'the seat records no applied presence fence' };
    if (fence.seat_id !== record.id || !isPresenceBinding(fence.binding)
      || !Number.isInteger(fence.seq) || fence.seq < 1) {
      return { canonical: null, why: 'the applied presence fence is not readable' };
    }
    const paths = presencePaths(stateDir, session, seat);
    if (paths === null) return { canonical: null, why: 'the seat cannot name a presence folder' };
    let text: string;
    try {
      text = readFileSync(paths.current, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        canonical: null,
        why: code === 'ENOENT'
          ? 'the seat has no canonical presence projection yet'
          : 'the canonical presence projection could not be read',
      };
    }
    const read = readPresenceReading(text);
    if (read.kind !== 'ok') return { canonical: null, why: read.why };
    return {
      canonical: {
        id: read.reading.id,
        binding: read.reading.binding,
        seq: read.reading.seq,
        seatId: record.id,
        fence: { seat_id: fence.seat_id, binding: fence.binding, seq: fence.seq },
      },
      why: null,
    };
  };

  /** The exact per-seat runtime answer a fresh health snapshot and a hosted watch's dispatcher
   *  both use. A seat with a source is qualified only while its cached reconciled proof still
   *  matches a fresh source reading and the current binding, so an event staged after the last
   *  pass holds the seat immediately. */
  const seatQualification = (
    one: (typeof presenceWork)[number],
    seat: string,
    at: Date,
  ): string | null => {
    if (closed) return 'the daemon is closing';
    if (!one.health.seatHealthy(seat, at)) {
      return one.health.seatReason(seat, at) ?? 'the runtime channel is not serving';
    }
    const source = one.sources.find((candidate) => candidate.seat === seat);
    if (source === undefined) return null;
    let reading: PresenceSourceStatus;
    try {
      reading = source.status(at);
    } catch (error) {
      return `the runtime source status failed: ${messageOf(error)}`;
    }
    const verdict = reconciledProofHolds({
      proof: one.proofs.get(seat),
      source: reading,
      currentBinding: currentBindingOf(one.stateDir, one.route.session, seat),
      epoch: since,
      at,
    });
    if (verdict.qualified) return null;
    if (!one.proofs.has(seat)) {
      return one.proofMiss.get(seat) ?? verdict.why ?? 'the runtime event has not been reconciled';
    }
    return verdict.why ?? 'the runtime channel is not serving';
  };

  /** The complete per-seat answer: an explicit source class, the current binding and, for a
   *  serving runtime seat, the reconciled staged identity. A seat with no source can be called a
   *  hook seat only when classification succeeded; a route whose source factory failed answers
   *  `unknown` for every seat, so a missing expected native attachment is never inferred away. */
  const seatVerdict = (
    one: (typeof presenceWork)[number],
    seat: string,
    at: Date,
  ): {
    source: 'runtime' | 'hook' | 'unknown';
    binding: string | null;
    appliedEventId: string | null;
    why: string | null;
  } => {
    const source = one.sources.find((candidate) => candidate.seat === seat);
    const unresolved = one.health.unresolvedWhy();
    const kind = unresolved !== null ? 'unknown' as const : source === undefined ? 'hook' as const : 'runtime' as const;
    // A runtime seat's binding is the one its sample was fenced on (never a newer state read
    // standing in for an answer that was never sampled); a hook seat has no sample, so its
    // current state binding is the only incarnation to show.
    const binding = source === undefined
      ? currentBindingOf(one.stateDir, one.route.session, seat)
      : one.health.seatBinding(seat);
    if (closed) return { source: kind, binding, appliedEventId: null, why: 'the daemon is closing' };
    if (source === undefined) {
      if (unresolved !== null) return { source: kind, binding, appliedEventId: null, why: unresolved };
      if (binding === null) {
        return {
          source: kind, binding: null, appliedEventId: null,
          why: 'the seat records no presence binding',
        };
      }
      const why = one.health.healthy(at)
        ? null
        : one.health.reason(at) ?? 'the presence channel is not current';
      return { source: kind, binding, appliedEventId: null, why };
    }
    const why = seatQualification(one, seat, at);
    return {
      source: kind,
      binding,
      appliedEventId: why === null ? one.proofs.get(seat)?.id ?? null : null,
      why,
    };
  };

  /** The watch dispatcher's boolean: only a null verdict qualifies. */
  const seatQualified = (
    one: (typeof presenceWork)[number],
    seat: string,
    at: Date,
  ): boolean => seatVerdict(one, seat, at).why === null;
  // From here the per-seat answer a hosted send server may ask is the real one.
  seatReady = true;

  // One watch per hosted route, on the daemon's existing heartbeat. The run starts at once and
  // performs its first pass; no second timer exists, and a pass that hangs holds nothing the
  // heartbeat needs. A root that failed to load, or that duplicates a checkout already hosted,
  // has no route and gets no watch; its status entry has no `watch` record either.
  if (input.watchHosting === true) {
    const log = (text: string): void => appendDaemonLog(home, text, now());
    for (const status of roots) {
      const route = routes.find((candidate) => candidate.root === status.root);
      if (route === undefined) continue;
      if (hostedWatches.some((one) => one.watch.route === route)) continue;
      const teamFile = teamFiles.get(route.root);
      if (teamFile === undefined) continue;
      // The route's channel health comes from this daemon's own fixed liveness, never from the
      // store's last word: with presence hosting off there is no pass, so the answer is absent
      // and the dispatcher holds a native projection rather than believing it.
      const presence = presenceWork.find((one) => one.route.root === route.root);
      // The route's broker reading is a daemon capability: only a daemon that hosts the broker
      // resolves one, and only through the injected builder. Otherwise this daemon opens no
      // socket and a tracker team's idle reading stays explicitly unknown.
      const brokerWork = features.broker === 'on' ? input.brokerWork?.(route) : undefined;
      const extras: HostedWatchExtras = brokerWork === undefined ? {} : { brokerWork };
      const build = input.hostedWatch?.(route, log, extras)
        ?? hostedWatchAuthority({
          route,
          teamFile,
          log,
          // Proving a recorded pane watch is the process in its own pane needs this route's
          // session; a pane the terminal host cannot read stays `unproven` and is never asked
          // to hand over.
          processInfo: (pane) => paneProcesses(pane, route.session),
          ...(presence === undefined
            ? {}
            : {
                // The consumer's contract is per seat and only `=== true` qualifies: a seat with
                // no source keeps the route's fresh ingest answer, an expected native seat needs
                // its own current sample, and a missing or false answer holds the projection.
                presenceChannelHealthy: (seat: string) =>
                  seatQualified(presence, seat, now()),
              }),
          ...(brokerWork === undefined ? {} : { brokerWork }),
          // The shared verifier judges the captured identity against the record under its own
          // lock immediately before every effect; a lifecycle report is never a substitute.
          verifyAuthority: (check) => verifyWatchAuthority({ ...check, purpose: WATCH_DIRECT_WORK }),
          // The watch's one outbound effect: the send command's own direct-wake legs, entered as
          // the watch principal the shared verifier proves. The closure binds the acquisition
          // this host captured; `sendWatchDirect` asks the verifier again before preparation and
          // at every actual transport.
          sender: (captured) => (request) => sendWatchDirect(
            { root: route.root, session: route.session, capturedEpoch: captured.epoch },
            request,
          ),
        });
      hostedWatches.push({
        status,
        watch: createHostedWatch({
          route,
          run: build.run,
          effects: build.effects,
          required: build.required,
          standby: build.standby,
          ...(build.tick === undefined ? {} : { onTick: build.tick }),
          now,
        }),
      });
    }
  }

  /** One distinct presence failure per route is logged once: a broken spool must not turn the
   *  daemon log into a 250 ms stream. The set is bounded so a pathological spool cannot grow it. */
  const logPresenceOnce = (route: HostedRoute, text: string): void => {
    if (text === '') return;
    const key = `${route.root}\n${text}`;
    if (presenceLogged.has(key)) return;
    if (presenceLogged.size >= 64) return;
    presenceLogged.add(key);
    appendDaemonLog(home, `presence ${route.root}: ${text}`, now());
  };

  /** One failed reading for a source that could not be sampled: never healthy, and never the
   *  source's last word, which may still claim a connection that is no longer measured. */
  const failedReading = (source: PresenceSource, why: string): PresenceSourceStatus => ({
    seat: source.seat,
    binding: '',
    threadId: '',
    channel: 'unknown',
    stream: 'uninitialized',
    baseline: 'pending',
    evidenceAt: null,
    why,
  });

  /** Records one in-memory sample, forced to answer for the source's own seat and fenced on the
   *  seat's current managed binding at this instant. Only the sample taken here counts; a
   *  persisted source record is never read for health. */
  const sampleSource = (
    one: (typeof presenceWork)[number],
    source: PresenceSource,
    reading: PresenceSourceStatus,
    at: Date,
  ): void => {
    const sampled = reading.seat === source.seat
      ? reading
      : {
          ...failedReading(source, 'the runtime source answered for another seat'),
          binding: reading.binding,
          threadId: reading.threadId,
          stream: reading.stream,
          baseline: reading.baseline,
        };
    one.health.seatObserved({
      source: sampled,
      currentBinding: currentBindingOf(one.stateDir, one.route.session, source.seat),
      epoch: since,
    }, at);
    if (!one.health.seatHealthy(source.seat, at)) {
      logPresenceOnce(
        one.route,
        `${source.seat}: ${one.health.seatReason(source.seat, at) ?? 'the runtime channel is not serving'}`,
      );
    }
  };

  /** One bounded, independent pump per source: at most one step is in flight for a source, so a
   *  source whose step is slow or hung holds only its own seat's answer — never the route's
   *  ingest, activity or publication, and never a sibling's sample. The sample is stamped when
   *  the reading actually arrives, not when the pass began. */
  const pumpSource = (one: (typeof presenceWork)[number], index: number): void => {
    if (closed) return;
    const source = one.sources[index];
    if (source === undefined || one.sourceRuns[index] !== null) return;
    const run = (async () => {
      try {
        await source.step(now());
      } catch (error) {
        sampleSource(one, source, failedReading(source, `the runtime source step failed: ${messageOf(error)}`), now());
        return;
      }
      let reading: PresenceSourceStatus;
      try {
        reading = source.status(now());
      } catch (error) {
        sampleSource(one, source, failedReading(source, `the runtime source status failed: ${messageOf(error)}`), now());
        return;
      }
      sampleSource(one, source, reading, now());
    })().catch(() => undefined);
    one.sourceRuns[index] = run;
    void run.then(() => {
      if (one.sourceRuns[index] === run) one.sourceRuns[index] = null;
    });
  };

  /** Reconciles each source's newest staged identity against the canonical projection and the
   *  applied fence, after this pass's activity step. The resulting proof is cached per seat; a
   *  reader re-checks it against a fresh source reading, so an event staged after this instant
   *  holds the seat immediately rather than at the next pass. */
  const reconcileSeats = (one: (typeof presenceWork)[number]): void => {
    const at = now();
    for (const source of one.sources) {
      if (closed) return;
      let reading: PresenceSourceStatus;
      try {
        reading = source.status(at);
      } catch (error) {
        one.proofs.delete(source.seat);
        one.proofMiss.set(source.seat, `the runtime source status failed: ${messageOf(error)}`);
        continue;
      }
      if (reading.seat !== source.seat) {
        one.proofs.delete(source.seat);
        one.proofMiss.set(source.seat, 'the runtime source answered for another seat');
        continue;
      }
      const canonical = canonicalSeatOf(one.stateDir, one.route.session, source.seat);
      const verdict = reconcilePresenceProof({
        source: reading,
        canonical: canonical.canonical,
        canonicalWhy: canonical.why,
        currentBinding: currentBindingOf(one.stateDir, one.route.session, source.seat),
        at,
      });
      if (verdict.ok) {
        one.proofs.set(source.seat, {
          id: verdict.proof.id,
          binding: verdict.proof.binding,
          epoch: since,
        });
        one.proofMiss.delete(source.seat);
      } else {
        one.proofs.delete(source.seat);
        one.proofMiss.set(source.seat, verdict.why);
        logPresenceOnce(one.route, `${source.seat}: ${verdict.why}`);
      }
    }
  };

  /**
   * One presence pass for one route: the ingester's bounded step, then each source's own
   * independent sample, the activity reconciler over what the step appended, the per-seat
   * reconciliation that proves a source's staged identity reached both the projection and the
   * applied fence, and the publisher that copies applied current-binding transitions to the
   * route's bus event log. Its log reads are asynchronous and bounded; its state write is the
   * same synchronous read-modify-write under the zero-wait lock every state writer uses. A slow
   * or broken spool therefore holds only its own route, and the beat that starts it never awaits
   * it.
   */
  const runPresence = (one: (typeof presenceWork)[number]): Promise<void> => {
    let run: Promise<void>;
    run = (async () => {
      let healthy = false;
      let why: string | null = null;
      try {
        const step = await one.ingester.step();
        // A resolved step is not a healthy channel: faults are reported in the step's own typed
        // outcome, and an absent or unconvincing answer is not known, which is not healthy.
        healthy = presenceStepHealth(step);
        // Display detail for the health answer only; the verdict above never reads this text.
        why = step.errors[0]?.why
          ?? (step.pending === true ? 'the presence channel still has a backlog' : null);
        logPresenceOnce(one.route, step.errors[0]?.why ?? '');
      } catch (error) {
        why = `the presence step failed: ${error instanceof Error ? error.message : String(error)}`;
        logPresenceOnce(one.route, why);
      }
      // The channel's fixed liveness is that typed outcome: only a step that finished with no
      // persistent fault and no known backlog vouches for the grace window.
      one.health.stepped(healthy, now(), why);
      // Each managed seat's runtime evidence is sampled from memory and fenced at the instant it
      // arrives: this daemon epoch, the seat's current managed binding. Each source runs in its
      // own one-flight pump, so the route's ingest, activity and publication below, and every
      // sibling source, never wait for one source's step. A seat's answer never changes the
      // route's ingest answer.
      for (let index = 0; index < one.sources.length; index += 1) pumpSource(one, index);
      try {
        // The transitions are consumed under the state lock only after the step that appended
        // them resolved, so the projection is at least as new as the lines read.
        const applied = await one.activity(now());
        if (applied.failed !== null) logPresenceOnce(one.route, `the activity step failed: ${applied.failed}`);
        const bad = applied.seats.find((seat) => seat.bad !== null)?.bad;
        if (typeof bad === 'string') logPresenceOnce(one.route, bad);
      } catch (error) {
        logPresenceOnce(one.route, `the activity step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Only after the activity step may a source's staged identity be proven applied: the
      // ingester wrote the projection and the activity reconciler fenced it in this pass.
      reconcileSeats(one);
      try {
        // Publication is a separate concern from the native channel's health: a bus append that
        // fails is reported and retried by a later pass, and never marks presence unhealthy.
        const published = await one.publisher(now());
        if (published.failed !== null) logPresenceOnce(one.route, `the publish step failed: ${published.failed}`);
        const failed = published.seats.find((seat) => seat.failure !== null)
          ?? published.seats.find((seat) => seat.bad !== null);
        if (failed !== undefined) {
          logPresenceOnce(one.route, `the publish step failed: ${failed.failure ?? failed.bad ?? ''}`);
        }
      } catch (error) {
        logPresenceOnce(one.route, `the publish step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => {
      if (presenceRuns.get(one.route.root) === run) presenceRuns.delete(one.route.root);
    });
    return run;
  };

  // One presence timer for every hosted route, beside the 5 s heartbeat and never merged with it.
  // A beat starts each idle route's pass without awaiting any: independent routes run together,
  // and a route whose previous pass is still in flight is skipped, never queued.
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  if (input.presenceHosting === true && presenceWork.length > 0) {
    presenceTimer = setInterval(() => {
      if (closed) return;
      for (const one of presenceWork) {
        if (presenceRuns.has(one.route.root)) continue;
        presenceRuns.set(one.route.root, runPresence(one));
      }
    }, input.presenceEveryMs ?? PRESENCE_EVERY_MS);
    presenceTimer.unref();
  }

  // A socket file that stays behind after a crash, or a listener that stops answering, is not a
  // hosted endpoint. The heartbeat asks each hosted socket. A send endpoint that stopped answering
  // is marked failed and left; a bus that is not answering is started again, with backoff, so a
  // killed bus does not stay dead.
  let refreshing = false;
  const reviveHostedBus = async (watch: EndpointWatch): Promise<void> => {
    const root = watch.busRoot;
    if (root === null || closed) return;
    const at = now().getTime();
    if (at < watch.busState.nextAt || watch.busState.starting) return;
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) {
      watch.busState.failures += 1;
      watch.busState.nextAt = at + nextBackoffMs(watch.busState.failures);
      return;
    }
    const thresholds = eventThresholdsInForce({
      home,
      entity: loaded.team.entity,
      projectId: projectIdOfTeam(home, loaded.team, loaded.root),
      root: loaded.root,
      team: loaded.team,
      upToLevel: 'team',
      now: now(),
    });
    if (!thresholds.ok) {
      watch.busState.failures += 1;
      watch.busState.nextAt = at + nextBackoffMs(watch.busState.failures);
      appendDaemonLog(home, `root ${root}: bus not restarted: ${thresholds.refusals.map((refusal) => refusal.message).join('; ')}`, now());
      return;
    }
    const revived = await reviveBus({
      root: loaded.root,
      team: loaded.team,
      home,
      stderr: (text) => appendDaemonLog(home, text, now()),
      heldThresholdSeconds: thresholds.thresholds.held_threshold_seconds,
      now,
    }, watch.busState, at);
    if (revived.kind === 'serving') {
      busHandles.push(revived.handle);
      watch.status.bus = 'serving';
      watch.busSocket = busSocket(loaded.root);
      if (watch.status.why === 'the hosted bus endpoint stopped answering') watch.status.why = null;
      appendDaemonLog(home, `root ${root}: bus restarted`, now());
    } else if (revived.kind === 'busy' || revived.kind === 'listening') {
      watch.status.bus = 'serving';
      watch.busSocket = busSocket(loaded.root);
      if (watch.status.why === 'the hosted bus endpoint stopped answering') watch.status.why = null;
    } else if (revived.kind === 'failed') {
      appendDaemonLog(home, `root ${root}: bus restart failed (${revived.why})`, now());
    }
  };
  const refreshHostedEndpoints = async (): Promise<void> => {
    if (closed || refreshing) return;
    refreshing = true;
    try {
      await Promise.all(
        watched.map(async (watch) => {
          const { status } = watch;
          if ((status.send === 'serving' || status.send === 'already-running') && watch.sendSocket !== null) {
            if (!(await probeDaemonSocket(watch.sendSocket))) {
              status.why ??=
                status.send === 'serving'
                  ? 'the hosted send endpoint stopped answering'
                  : 'the send server that was already running stopped answering';
              status.send = 'failed';
              appendDaemonLog(home, `root ${status.root}: send endpoint stopped answering`, now());
            }
          }
          if (watch.busRoot !== null) {
            const socket = busSocket(watch.busRoot);
            const up = await probeBusSocket(socket);
            if (up) {
              watch.busState.failures = 0;
              watch.busState.nextAt = 0;
              if (status.bus === 'serving') watch.busSocket = socket;
            } else {
              if (status.bus === 'serving') {
                status.why ??= 'the hosted bus endpoint stopped answering';
                status.bus = 'failed';
                appendDaemonLog(home, `root ${status.root}: bus endpoint stopped answering`, now());
              }
              await reviveHostedBus(watch);
            }
          }
        }),
      );
    } finally {
      refreshing = false;
      writeState();
    }
  };

  // The one scoped fault diagnostic rides this same heartbeat: at most one request per beat,
  // consumed before the beat's ticks, and only the route it names exactly can be faulted. The
  // request must name this daemon's resolved home, pid and start instant; a pending fault is
  // answered `not reached` at close, never left to a later incarnation.
  const faultTargets: readonly HostedWatch[] = hostedWatches.map((one) => one.watch);
  const faultInbox = createFaultInbox({
    home,
    pid,
    since,
    now,
    log: (text) => appendDaemonLog(home, text, now()),
  });

  // The first state write happened before hosting so a reader never finds a bound socket with no
  // record; this one records what each checkout actually got, failures and reasons included, and
  // every heartbeat refreshes it after asking the hosted sockets whether they still answer.
  writeState();

  const timer = setInterval(() => {
    heartbeatAt = now().toISOString();
    try {
      faultInbox.consume(faultTargets);
    } catch (error) {
      appendDaemonLog(home, `fault request: ${(error as Error).message}`, now());
    }
    // A tick releases only the waits whose own due instant has passed and returns at once: a
    // pass that is still running is never awaited here, so one slow or hanging route cannot
    // stop the daemon's liveness or another route's cycles. Each route is isolated.
    for (const one of hostedWatches) {
      try {
        one.watch.tick(now());
      } catch (error) {
        appendDaemonLog(home, `root ${one.watch.route.root}: the hosted watch tick failed: ${(error as Error).message}`, now());
      }
    }
    writeState();
    void refreshHostedEndpoints();
    // One fallback sweep rides the existing heartbeat: no second timer, process or socket. Each
    // hosted root reads its own validated team file and its markers' durable due instants; the
    // pass keeps no state of its own, and close stops it with this timer.
    if (closed) return;
    const swept = sweepFallbackEscalations({ home, roots: sweepRoots, now });
    for (const entry of swept.roots) {
      if (entry.why !== null) {
        appendDaemonLog(home, `fallback sweep ${entry.root}: ${entry.why}`, now());
        continue;
      }
      const report = entry.report;
      if (report === null) continue;
      if (report.escalated.length === 0 && report.refused.length === 0 && report.unreadable.length === 0) continue;
      appendDaemonLog(
        home,
        `fallback sweep ${entry.root}: escalated ${String(report.escalated.length)}, refused ${String(report.refused.length)}, unreadable ${String(report.unreadable.length)}`,
        now(),
      );
    }
  }, heartbeatMs);
  timer.unref();

  let admissionClosed = false;
  let ownershipReleased = false;
  /** One close attempt at a time: a second caller joins the run in flight, so the release below
   *  can never happen twice. When the run settles, the next caller may try again. */
  let closeRun: Promise<void> | null = null;
  /**
   * Per-ingester close state. Only a truthful quiescence is cached: a false or rejected answer
   * clears the in-flight slot, so a later close retries that handle once the writer may have
   * recovered. At most one close call per handle is ever in flight.
   */
  const presenceCloses = presenceWork.map(() => ({
    attempt: null as Promise<unknown> | null,
    closed: false,
  }));
  /** Per-source close state, under the same rule: a resolved close is quiescence, a rejection
   *  clears the in-flight slot and names why, so a later close retries only what did not quiesce. */
  const presenceSourceCloses = presenceWork.map((one) => one.sources.map(() => ({
    attempt: null as Promise<unknown> | null,
    closed: false,
    why: null as string | null,
  })));

  const closeIngester = (index: number): Promise<unknown> => {
    const slot = presenceCloses[index];
    const one = presenceWork[index];
    if (slot === undefined || one === undefined || slot.closed) return Promise.resolve();
    if (slot.attempt === null) {
      let attempt: Promise<unknown>;
      try {
        attempt = Promise.resolve(one.ingester.close());
      } catch (error) {
        attempt = Promise.reject(error);
      }
      slot.attempt = attempt;
      void attempt.then(
        (value) => {
          if (slot.attempt !== attempt) return;
          const quiesced = value !== null && typeof value === 'object'
            && (value as { quiesced?: unknown }).quiesced === true;
          if (quiesced) slot.closed = true;
          else slot.attempt = null;
        },
        () => {
          if (slot.attempt === attempt) slot.attempt = null;
        },
      );
    }
    return slot.attempt;
  };

  /** Closes one source and maps its answer: `close` resolves to quiescence only once the drain
   *  actually finished; a rejection retains ownership and is retried by a later close. */
  const closeSource = (workIndex: number, sourceIndex: number): Promise<unknown> => {
    const slot = presenceSourceCloses[workIndex]?.[sourceIndex];
    const source = presenceWork[workIndex]?.sources[sourceIndex];
    if (slot === undefined || source === undefined || slot.closed) return Promise.resolve();
    if (slot.attempt === null) {
      let attempt: Promise<unknown>;
      try {
        attempt = Promise.resolve(source.close());
      } catch (error) {
        attempt = Promise.reject(error);
      }
      slot.attempt = attempt;
      slot.why = null;
      void attempt.then(
        (value) => {
          if (slot.attempt !== attempt) return;
          const quiesced = value !== null && typeof value === 'object'
            && (value as { quiesced?: unknown }).quiesced === true;
          if (quiesced) {
            slot.closed = true;
          } else {
            slot.why = 'the runtime source did not quiesce';
            slot.attempt = null;
          }
        },
        (error) => {
          if (slot.attempt !== attempt) return;
          slot.why = messageOf(error);
          slot.attempt = null;
        },
      );
    }
    return slot.attempt;
  };

  /** Starts (or retries) every source cancel on one route. Sources must be quiesced before the
   *  route's ingester closes: a live source must never stage spool behind a claimed closure. */
  const closeSources = (workIndex: number): Promise<unknown> => {
    const one = presenceWork[workIndex];
    if (one === undefined) return Promise.resolve();
    return Promise.all(one.sources.map((_source, sourceIndex) => closeSource(workIndex, sourceIndex)));
  };

  const closeOnce = async (): Promise<void> => {
    if (ownershipReleased) return;
    // A call that joins after the first admission close is a retry: it may retry a source close
    // that did not resolve earlier, while a first attempt already started every close once in
    // the admission block and must not call one twice in the same attempt.
    const resumed = admissionClosed;
    if (!admissionClosed) {
      admissionClosed = true;
      closed = true;
      clearInterval(timer);
      if (presenceTimer !== null) clearInterval(presenceTimer);
      // Admission first, and every stop is started before the first await: a watch pass that is
      // slow to drain must not leave send or bus admitting beside it. The machine endpoint stops
      // answering at once through the `closed` guard; its listener stays bound until release,
      // because closing it unlinks the socket a pending drain must retain.
      const admissions: Promise<unknown>[] = [];
      // Runtime sources stop first, beside the watch and bus admissions and before any drain: an
      // expected-native source must not stage new spool after its route's ingester declares
      // quiescence. A close that has not resolved retains ownership below, exactly as a
      // non-quiesced ingester does.
      for (let index = 0; index < presenceWork.length; index += 1) {
        admissions.push(closeSources(index).catch(() => undefined));
      }
      for (const one of hostedWatches) {
        let stopping: Promise<unknown>;
        try {
          stopping = Promise.resolve(one.watch.stop('the daemon is closing'));
        } catch (error) {
          stopping = Promise.reject(error);
        }
        admissions.push(stopping.catch(() => undefined).then(() => {
          one.status.watch = one.watch.state();
        }));
      }
      for (const handle of busHandles.splice(0)) {
        try {
          admissions.push(Promise.resolve(handle.close()).catch(() => undefined));
        } catch {
          // A synchronous throw is a handle that was already closed.
        }
      }
      for (const handle of sendHandles.splice(0)) {
        try {
          admissions.push(Promise.resolve(handle.close()).catch(() => undefined));
        } catch {
          // A synchronous throw is a handle that was already closed.
        }
      }
      // The record says the daemon is closing before anything unbounded is awaited: a hung
      // presence drain must not leave the old serving record standing behind it. A route that
      // does quiesce is released below and its record is unlinked; one that does not keeps this
      // entry with the drain's own reason.
      for (const one of presenceWork) {
        const status = roots.find((entry) => entry.root === one.route.root);
        if (status !== undefined) {
          status.presence = { state: 'pending', why: 'the daemon is closing' };
        }
      }
      writeState(true);
      await Promise.all(admissions);
      // Every watch stop above has settled, so a fault that had not reached its seam when the
      // close began can never reach one now: its writer is answered `not reached` instead of
      // being left to a later daemon that did not receive the request.
      faultInbox.close();
    }
    // Presence drain: the in-flight pass of each route (an ingester step and the activity write
    // that follows it) finishes, then every ingester's own truthful close. No timeout races the
    // teardown: a write that cannot finish is the honest reason ownership is not released. The
    // restore sweep is part of the same drain: its closing flag stopped it between seat steps
    // (or cut a seat's wait), the stop pass closed what that run made, and ownership is released
    // only after the tracked run settles.
    await Promise.allSettled([
      ...presenceRuns.values(),
      ...(restoreSweepRun === null ? [] : [restoreSweepRun]),
    ]);
    // Source pumps are part of the same drain: their steps were already cancelled in the
    // admission block, and no new pump starts once `closed` is set. A pump that still cannot
    // finish keeps its route unsettled below, exactly as a non-quiesced source close does.
    const sourceDrains: Promise<void>[] = [];
    for (const one of presenceWork) {
      for (const run of one.sourceRuns) if (run !== null) sourceDrains.push(run);
    }
    await Promise.allSettled(sourceDrains);
    // A later attempt retries the sources whose close did not resolve. It runs before any
    // ingester close, and only a resolved drain now counts as quiescence.
    if (resumed) {
      await Promise.all(presenceWork.map((_one, index) => closeSources(index).catch(() => undefined)));
    }
    const unsettled: { route: HostedRoute; why: string }[] = [];
    await Promise.all(presenceWork.map(async (one, index) => {
      const sourceSlots = presenceSourceCloses[index] ?? [];
      const openSource = sourceSlots.findIndex((slot) => !slot.closed);
      if (openSource !== -1) {
        // The ingester stays open on purpose: closing it while its source may still stage spool
        // would claim a quiescence the route has not reached.
        unsettled.push({
          route: one.route,
          why: sourceSlots[openSource]?.why ?? 'the runtime source did not close',
        });
        return;
      }
      try {
        const value = await closeIngester(index);
        if (presenceCloses[index]?.closed === true) return;
        const why = value !== null && typeof value === 'object' && typeof (value as { why?: unknown }).why === 'string'
          ? (value as { why: string }).why
          : 'the ingester did not quiesce';
        unsettled.push({ route: one.route, why });
      } catch (error) {
        unsettled.push({ route: one.route, why: messageOf(error) });
      }
    }));
    if (unsettled.length > 0) {
      // Ownership is retained on purpose: the lock, the socket and the state record stand, so no
      // new daemon can take the routes while an old writer might still append. A later close
      // retries only the handles whose own close did not quiesce; a cached true is never re-run,
      // and only a truthful quiescence releases. A killed process falls to the dead-pid lock path.
      for (const one of unsettled) {
        const status = roots.find((entry) => entry.root === one.route.root);
        if (status !== undefined) status.presence = { state: 'pending', why: one.why };
        appendDaemonLog(home, `presence ${one.route.root}: close pending: ${one.why}`, now());
      }
      writeState(true);
      return;
    }
    await host.close();
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
      // The next start clears a stale socket.
    }
    try {
      if (existsSync(daemonStatePath(home))) unlinkSync(daemonStatePath(home));
    } catch {
      // The state record is refreshed by the next start; a stale dead pid reads not-running.
    }
    releaseLock();
    ownershipReleased = true;
  };

  const close = (): Promise<void> => {
    if (closeRun !== null) return closeRun;
    const run = closeOnce().finally(() => {
      if (closeRun === run) closeRun = null;
    });
    closeRun = run;
    return run;
  };

  // The daemon-start restore sweep: after the sockets, canonical routes, state
  // record and shutdown machinery are wired, one guarded pass per accepted route repairs the
  // seats its recorded session lost. It is never awaited here, so readiness does not wait on a
  // launch; `closeOnce` drains the tracked run, and the run's own `isClosing` stops it between
  // seat steps. Only canonical routes are swept: raw input roots can repeat, name a folder with
  // no accepted route, or differ in spelling from the route's own root.
  if (input.restoreSweep !== false && routes.length > 0) {
    const runner = typeof input.restoreSweep === 'function'
      ? input.restoreSweep
      : (root: string, teamFile: string) =>
          runRestoreSweepForRoute({ home, root, teamFile, now, isClosing: () => closed });
    restoreSweepRun = (async (): Promise<void> => {
      for (const route of routes) {
        if (closed) return;
        const teamFile = teamFiles.get(route.root);
        if (teamFile === undefined) continue;
        try {
          const result = await runner(route.root, teamFile);
          if (result.kind === 'ran') {
            appendDaemonLog(home, `restore ${route.root}: ${result.summary.line}`, now());
          } else if (result.kind === 'lock-held') {
            appendDaemonLog(home, `restore ${route.root}: another session-mutating run holds the session; skipped`, now());
          } else if (result.kind === 'not-running') {
            appendDaemonLog(home, `restore ${route.root}: the session is ${result.state ?? 'unreadable'}; skipped`, now());
          } else if (result.kind === 'unreadable') {
            appendDaemonLog(home, `restore ${route.root}: ${result.reason}`, now());
          } else if (result.kind === 'refused') {
            const detail = result.detail === undefined ? '' : `: ${result.detail}`;
            appendDaemonLog(home, `restore ${route.root}: the run exited ${String(result.exit)} before it planned a seat${detail}`, now());
          }
        } catch (error) {
          appendDaemonLog(home, `restore ${route.root}: ${messageOf(error)}`, now());
        }
      }
    })().catch((error: unknown) => {
      // The loop above already logs each route's failure; this catches the log write itself (or
      // anything outside the loop), so the tracked run never rejects into an unhandled rejection
      // that could bring the daemon down. Serving must not depend on the sweep's bookkeeping.
      try {
        appendDaemonLog(home, `restore: ${messageOf(error)}`, now());
      } catch {
        // The log is unavailable too; there is nowhere left to say it.
      }
    });
  }

  return {
    kind: 'serving',
    daemon: { socketPath, roots, routes: [...routes], health, close },
  };
}

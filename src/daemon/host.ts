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
import { projectIdOfTeam } from '../dev_mode.ts';
import { loadTeamFile } from '../file/load.ts';
import { eventThresholdsInForce } from '../policy/index.ts';
import { plainLine } from '../launch/plain.ts';
import { pidAlive, readState } from '../state.ts';
import { probeDaemonSocket, startSendDaemon, realDaemonHost, type DaemonHost, type SendDaemonHandle } from '../send/daemon.ts';
import { formatDaemonResponse, parseDaemonRequest, answerDaemonRequest, DAEMON_FRAME_LIMIT, DAEMON_PROTOCOL_VERSION, type DaemonErrorCode, type DaemonHealthSnapshot, type DaemonRootHealthSnapshot } from './protocol.ts';
import { probeDaemonHealth } from './health.ts';
import { sweepFallbackEscalations, type SweepRoot } from './fallback-sweep.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath } from './paths.ts';
import { createHostServer } from '../../packages/relay/host/server.js';
import { canonicalRoot, duplicateRoute, routeOf, type HostedRoute } from './routes.ts';
import { createHostedWatch, type HostedEffects, type HostedWatch } from './watch.ts';
import { hostedWatchAuthority } from './watch-authority.ts';
import { createPresenceIngester, type PresenceIngester } from './presence/ingest.ts';
import { createPresenceActivity, type PresenceActivityStep } from './presence/activity.ts';
import { createPresencePublisher, type PresencePublisherStep } from './presence/publish.ts';
import { isPresenceBinding } from './presence/contract.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, createPresenceChannelHealth, presenceStepHealth, unprovenSource,
  type PresenceChannelHealth, type PresenceSource, type PresenceSourceStatus,
} from './presence/health.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../watch/authority.ts';
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
  /** Injected for a test that must not touch the real pane/herdr sources. */
  sendHost?: DaemonHost;
  /**
   * Whether each hosted route carries a watch on the daemon's heartbeat. Off by default: the
   * quiet foundation lands before any activation, and a daemon started only to host endpoints
   * carries none. A route with a watch records one; a route without was never started with
   * one, and a reader must not treat its silence as a failed watch.
   */
  watchHosting?: boolean;
  /** Builds one route's watch. The default runs the shared watch loop over the real read
   *  sources with mutating sources closed and outbound effects blocked; a test injects its
   *  own run and clock and, only with a verified admitted sender, `open` effects. */
  hostedWatch?: (route: HostedRoute, log: (text: string) => void) => HostedWatchBuild;
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
   * none: a seat with no source keeps the route's own hook answer, correct only for a seat that
   * genuinely has no managed native channel (the target resolver's `skip`). A resolution or start
   * failure is not a skip: it belongs in `presenceUnproven`, so the seat is explicitly unhealthy.
   * The wiring resolves targets under the existing policy; the host only fences, samples and
   * closes what it is given.
   */
  presenceSubscriptions?: (route: HostedRoute, stateDir: string) => PresenceSource[];
  /**
   * Seats this route expected to carry a managed native channel but whose target resolution or
   * start did not succeed, with the truthful why. Each becomes an explicit unproven source, so a
   * failed expected attachment can never fall back to the route's hook answer.
   */
  presenceUnproven?: (route: HostedRoute, stateDir: string) => Array<{ seat: string; why: string }>;
  /** The presence pass interval; 250 ms in production. A test shortens it. */
  presenceEveryMs?: number;
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
    /** This route's fixed liveness, answered per seat to its hosted watch's dispatcher. */
    health: PresenceChannelHealth;
  }[] = [];
  const presenceRuns = new Map<string, Promise<void>>();
  const presenceLogged = new Set<string>();
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
      // The route's answer stays the ingest answer. Each managed seat carries its own, so one
      // seat's unproven runtime channel never marks a sibling or the route pending.
      const seats = presence.sources.map((source) => {
        const seatHealthy = !closed && presence.health.seatHealthy(source.seat, at);
        const seatWhy = seatHealthy
          ? null
          : closed
            ? 'the daemon is closing'
            : presence.health.seatReason(source.seat, at) ?? 'the runtime channel is not serving';
        return {
          seat: source.seat,
          state: seatHealthy ? 'serving' as const : 'pending' as const,
          healthy: seatHealthy,
          why: seatWhy,
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
    onRequest: (_input, line) => {
      const parsed = parseDaemonRequest(line);
      if (!parsed.ok) {
        return formatDaemonResponse({ v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false, error: parsed.error });
      }
      if (closed) {
        // Admission is closed while the presence drain runs: the endpoint still owns its socket
        // and refuses work until the drain is truthful and the release below unlinks it.
        return formatDaemonResponse({
          v: DAEMON_PROTOCOL_VERSION,
          id: parsed.request.id,
          ok: false,
          error: { code: 'daemon.internal', message: 'the daemon is closing' },
        });
      }
      const started = now().getTime();
      inFlight.set(parsed.request.id, { op: parsed.request.op, since: started });
      try {
        return formatDaemonResponse(answerDaemonRequest(parsed.request, health()));
      } finally {
        inFlight.delete(parsed.request.id);
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
    const watch: EndpointWatch = { status, sendSocket: null, busSocket: null };
    watched.push(watch);
    const loaded = loadTeamFile(rootArg, { home });
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
      try {
        for (const source of input.presenceSubscriptions?.(route, stateDir) ?? []) register(source);
      } catch (error) {
        appendDaemonLog(home, `presence ${route.root}: runtime subscriptions were not built: ${messageOf(error)}`, now());
      }
      try {
        for (const failed of input.presenceUnproven?.(route, stateDir) ?? []) {
          register(unprovenSource(failed.seat, failed.why));
        }
      } catch (error) {
        appendDaemonLog(home, `presence ${route.root}: runtime resolutions were not built: ${messageOf(error)}`, now());
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
        health,
      });
    }
    const sendHost: DaemonHost = input.sendHost ?? { ...realDaemonHost, home };
    let send: Awaited<ReturnType<typeof startSendDaemon>>;
    try {
      send = await startSendDaemon({ root: canonical, dir: canonical, team: loaded.team, host: sendHost });
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
      const build = input.hostedWatch?.(route, log)
        ?? hostedWatchAuthority({
          route,
          teamFile,
          log,
          ...(presence === undefined
            ? {}
            : {
                // The consumer's contract is per seat and only `=== true` qualifies: a seat with
                // no source keeps the route's fresh ingest answer, an expected native seat needs
                // its own current sample, and a missing or false answer holds the projection.
                presenceChannelHealthy: (seat: string) =>
                  !closed && presence.health.seatHealthy(seat, now()),
              }),
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

  /** One in-memory sample of one source, forced to answer for its own seat and never allowed to
   *  throw into the pass: a source whose bounded step failed is unproven, which is not healthy.
   *  Only the sample taken here counts; a persisted source record is never read for health. */
  const observeSource = async (
    one: (typeof presenceWork)[number],
    source: PresenceSource,
    at: Date,
  ): Promise<void> => {
    let reading: PresenceSourceStatus;
    try {
      // The stream pump is the pass's measured read. A pump that fails leaves no current
      // evidence for this seat even when its last status still said connected.
      await source.step(at);
      reading = source.status(at);
    } catch (error) {
      reading = {
        seat: source.seat,
        binding: '',
        threadId: '',
        channel: 'unknown',
        stream: 'uninitialized',
        baseline: 'pending',
        evidenceAt: null,
        why: `the runtime source step failed: ${messageOf(error)}`,
      };
    }
    if (reading.seat !== source.seat) {
      reading = {
        seat: source.seat,
        binding: reading.binding,
        threadId: reading.threadId,
        channel: 'unknown',
        stream: reading.stream,
        baseline: reading.baseline,
        evidenceAt: null,
        why: 'the runtime source answered for another seat',
      };
    }
    one.health.seatObserved({
      source: reading,
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

  /**
   * One presence pass for one route: the ingester's bounded step, the activity reconciler over
   * what it appended, then the publisher that copies applied current-binding transitions to the
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
      // Each managed seat's runtime evidence is sampled from memory on every pass and fenced
      // now: this daemon epoch, the seat's current managed binding, this instant. A seat's
      // source answer never changes the route's ingest answer or a sibling's.
      for (const source of one.sources) await observeSource(one, source, now());
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
  // hosted endpoint. The heartbeat asks each hosted socket; an endpoint that stopped answering is
  // marked failed with its reason and logged once, and a later heartbeat never resurrects it.
  let refreshing = false;
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
          if (status.bus === 'serving' && watch.busSocket !== null) {
            if (!(await probeBusSocket(watch.busSocket))) {
              status.why ??= 'the hosted bus endpoint stopped answering';
              status.bus = 'failed';
              appendDaemonLog(home, `root ${status.root}: bus endpoint stopped answering`, now());
            }
          }
        }),
      );
    } finally {
      refreshing = false;
      writeState();
    }
  };

  // The first state write happened before hosting so a reader never finds a bound socket with no
  // record; this one records what each checkout actually got, failures and reasons included, and
  // every heartbeat refreshes it after asking the hosted sockets whether they still answer.
  writeState();

  const timer = setInterval(() => {
    heartbeatAt = now().toISOString();
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
    }
    // Presence drain: the in-flight pass of each route (an ingester step and the activity write
    // that follows it) finishes, then every ingester's own truthful close. No timeout races the
    // teardown: a write that cannot finish is the honest reason ownership is not released.
    await Promise.allSettled([...presenceRuns.values()]);
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

  return {
    kind: 'serving',
    daemon: { socketPath, roots, routes: [...routes], health, close },
  };
}

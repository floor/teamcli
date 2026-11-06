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
import { busSocket, startBus, type BusHandle, type StartBusInput, type StartBusResult } from '../bus/server.ts';
import { freshBusWatch, nextBackoffMs, reviveBus, type BusWatch } from '../bus/supervise.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { launchTeamFile } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { paneProcessesAsync, type PaneProcesses } from '../herdr.ts';
import { eventThresholdsInForce, DAEMON_HEARTBEAT_SECONDS } from '../policy/index.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import type { RestoreSweepResult } from '../launch/restore-sweep.ts';
import { runRestoreSweepInChild } from './restore/spawn.ts';
import { pidAlive } from '../state.ts';
import { probeDaemonSocket, startSendDaemon, realDaemonHost, type DaemonHost, type SendDaemonHandle } from '../send/daemon.ts';
import { formatDaemonResponse, parseDaemonRequest, answerDaemonRequest, DAEMON_FRAME_LIMIT, DAEMON_PROTOCOL_VERSION, type DaemonErrorCode, type DaemonHealthSnapshot, type DaemonRequest, type DaemonResponse, type DaemonRootHealthSnapshot } from './protocol.ts';
import { probeDaemonHealth } from './health.ts';
import { choresPolicyFor } from './chores/policy.ts';
import { createChoresFleet, type ChoresFleet } from './chores/supervisor.ts';
import { createMailboxRouter, type MailboxChild, type MailboxRouter } from './mailbox/supervisor.ts';
import type { ChoresChild, SpawnChoresInput } from './chores/spawn.ts';
import type { ChoresPresenceProof, ChoresPresenceReading, ChoresPresenceStatus } from './chores/protocol.ts';
import { FALLBACK_STORE_PASS_LIMIT, FALLBACK_STORE_PASS_MS, storeBacklogLimits, sweepFallbackEscalationsSliced, type FallbackSweepResult, type SweepRoot } from './fallback-sweep.ts';
import { createHeartbeatPolicy } from './heartbeat.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath } from './paths.ts';
import { createHostServer } from '../../packages/relay/host/server.js';
import { canonicalRoot, duplicateRoute, resolveScope, routeOf, type HostedRoute } from './routes.ts';
import type { NextAnswer, NextClaim, NextHandlerInput } from './next.ts';
import { createFaultInbox } from './fault.ts';
import { createHostedBeat, createHostedWatch, type HostedEffects, type HostedWatch } from './watch.ts';
import { hostedWatchAuthority } from './watch-authority.ts';
import { createPresenceIngester, type PresenceIngester } from './presence/ingest.ts';
import { createPresenceActivity, type PresenceActivityStep } from './presence/activity.ts';
import { createPresencePublisher, type PresencePublisherStep } from './presence/publish.ts';
import { createPresenceHeld, type PresenceHeldStep } from './presence/held.ts';
import { canonicalSeatOf, currentPresenceBinding } from './presence/reconcile.ts';
import { codexPresenceFor, codexPresenceTarget } from './presence/codex-source.ts';
import {
  PRESENCE_HEALTH_GRACE_MS, adoptPresenceSource, createPresenceChannelHealth, presenceStepHealth,
  reconcilePresenceProof, reconciledProofHolds, unprovenSource,
  type PresenceChannelHealth, type PresenceReconciledProof, type PresenceSource,
  type PresenceSourceRuntime, type PresenceSourceStatus,
} from './presence/health.ts';
import { WATCH_DIRECT_WORK, verifyWatchAuthority } from '../watch/authority.ts';
import type { BrokerWorkSource } from '../idle_work.ts';
import { sendWatchDirect } from '../watch/direct-send.ts';
import type { HostedLoop } from '../watch/hosted.ts';
import { reminderTick, type ReminderSend, type ReminderSpec } from '../reminder/run.ts';
import {
  ensureMachineDir,
  serializeDaemonState,
  writeDaemonStateText,
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
  /** The packaged commit this build was installed from; null or absent in a source checkout. */
  gitHead?: string | null;
  now?: () => Date;
  /** How often the state record's heartbeat is refreshed. */
  heartbeatMs?: number;
  /** How long a request may be in flight before it is reported as stuck. */
  stuckMs?: number;
  /** How long a close waits for an endpoint refresh sent before its admission; 10 s in
   *  production. Past it the close answers pending and keeps ownership. A test shortens it to
   *  observe that answer without waiting the production bound. */
  refreshCloseBoundMs?: number;
  /** `absent` until the broker handler lands; never `on` without the owner's go. */
  features?: DaemonFeatures;
  /** Injected for a test that must not touch the real terminal host's pane sources. */
  sendHost?: DaemonHost;
  /** Starts one root's per-project send server. The default starts the real server; a test
   *  injects its own to read the start input without binding a socket. */
  sendStart?: typeof startSendDaemon;
  /** Called once when a hosted send endpoint has failed again after its restart budget is spent:
   *  the process should exit non-zero so the system's service manager starts a fresh daemon. A
   *  test injects a recorder to observe the decision without ending the process. */
  onFatal?: (why: string) => void;
  /** The send restart policy. The defaults are the bus policy's capped backoff and five failed
   *  restarts in a row before `onFatal`; a scene shortens both. */
  sendRestart?: { giveUp?: number; backoffMs?: (failures: number) => number };
  /** Starts one root's bus server when the heartbeat finds it stopped. The default starts the
   *  real server; a test injects its own to hold or observe a revive. It is never the start that
   *  hosts the bus beside send: that one is `initialBusStart`'s. */
  busStart?: (input: StartBusInput) => Promise<StartBusResult>;
  /** Starts one root's bus server when the roots loop first hosts it. The default starts the
   *  real server; a test injects its own to read the start input and the first-pass progress
   *  without binding a socket. It never covers a revive; that one is `busStart`'s. */
  initialBusStart?: (input: StartBusInput) => Promise<StartBusResult>;
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
  /** Builds one route's held-frame step, which reads a seat's pane after a socket delivery and
   *  raises `held` when the frame sat at its dialog. The default reads the pane host; a test
   *  injects its own so a scene never reaches a pane. */
  presenceHeld?: (route: HostedRoute, stateDir: string) => PresenceHeldStep;
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
  /**
   * The verified pane's process identity for a `next` request's delivery class: the proof that
   * a recorded socket is the pane's own. The default asks the terminal host, awaited so the
   * read never holds the beat; a test injects its own so a synthetic listener scene makes no
   * terminal-host call. A reader that cannot answer returns null, the conservative rule.
   */
  paneProcesses?: (pane: string, session: string) => PaneProcesses | null | Promise<PaneProcesses | null>;
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
  restoreSweep?: boolean | ((root: string, teamFile: string | undefined) => Promise<RestoreSweepResult>);
  /**
   * The growing-gap retry schedule when a canonical route's session is not yet running in the
   * terminal host at daemon start: `restoreRetryInitialDelayMs` (5 s default) doubles each retry
   * up to `restoreRetryMaxDelayMs` (60 s default) over a total bound of `restoreRetryBudgetMs`
   * (315 s / 5m 15s default). A test shortens these to observe the retry schedule without
   * waiting the production window.
   */
  restoreRetryInitialDelayMs?: number;
  restoreRetryMaxDelayMs?: number;
  restoreRetryBudgetMs?: number;
  /**
   * The reminders this daemon runs on its beat, read fresh on every beat so an edited config is
   * picked up without a restart. Absent, no reminder runs; reading the configured list into
   * these specs is the caller's business, and the reader gets the beat's log so a refused entry
   * is named. A reader that throws is logged and fires nothing on that beat, and a reminder is
   * machine-scoped: the one list serves every hosted root. This is the inline path a daemon
   * without a chores fleet runs; a daemon with one hands the read to a child.
   */
  reminders?: (log: (line: string) => void) => readonly ReminderSpec[];
  /**
   * The canonical checkouts this daemon hosts, handed to the machine chores child so its list
   * read refuses a target outside them exactly as this daemon's own read does. Absent, the
   * fleet's hosted list falls back to the accepted routes' roots.
   */
  reminderHosted?: readonly string[];
  /**
   * The transport a reminder uses. The default is the verified daemon sender, which proves the
   * daemon's state record, lock and heartbeat before every leg; a test injects its own so a
   * synthetic scene reaches no socket. An injected transport is a function that cannot cross a
   * pipe, so a daemon given one delivers inline even when its chores fleet is hosted.
   */
  reminderSend?: ReminderSend;
  /**
   * The state record's physical writer. The default writes the record atomically off the
   * event loop; a test injects a counting or slow writer to prove one write per beat, a
   * write only on change, and a probe that answers while a write is in flight.
   */
  stateWriter?: (home: string, text: string) => Promise<void>;
  /**
   * Whether the daemon isolates the heavy per-root chores in supervised children. Off by
   * default, like the other hosting seams: a daemon started without it runs exactly the inline
   * path, and a test harness that never opted in behaves as it always did. The mode per route is
   * `daemon.chores` (`per-root`, `shared` or `inline`), so this seam only asks whether the daemon
   * may use children at all; a route whose policy says `inline` keeps the inline path either way.
   */
  choresHosting?: boolean;
  /** Starts one chores child. The default writes a one-use token and spawns this program's hidden
   *  child verb; a test injects a fixture child to observe the protocol and the supervision. */
  choresFactory?: (input: SpawnChoresInput) => ChoresChild;
  /**
   * Whether this daemon starts the one mailbox router. Off unless a start asks for it, so a
   * harness that never opted in does not spawn the child. The beat only nudges it.
   */
  mailboxHosting?: boolean;
  /** Starts the mailbox router child. A test injects a fixture child. */
  mailboxFactory?: () => MailboxChild;
};

export type StartMachineDaemonResult =
  | { kind: 'serving'; daemon: MachineDaemon }
  | { kind: 'already-running'; pid: number | null }
  | { kind: 'locked'; pid: number | null }
  | { kind: 'bind-failed'; reason: string };

/** The beat the daemon runs when no injected seam and no policy word names one: the release
 *  default of `daemon.heartbeat` (ADR D6), the beat the daemon ran hard-coded before the word. */
const HEARTBEAT_MS = DAEMON_HEARTBEAT_SECONDS.release * 1000;
const STUCK_MS = 10_000;
/** The longest the beat's fallback pass may hold the event loop before yielding to it: the
 *  product's own health probe answers within 500 ms (health.ts's `options.timeoutMs ?? 500`), and
 *  a probe's request needs a few loop turns of its own (accept, read, answer), so the slice stays
 *  small enough that those turns land every few milliseconds rather than at the budget's edge.
 *  The pass checks the boundary before each item, so a slice is one item long at most past this
 *  mark. */
const FALLBACK_BEAT_SLICE_MS = 10;
const PRESENCE_EVERY_MS = 250;
/** Failed restarts of one send endpoint in a row before the daemon gives up and exits. */
const SEND_RESTART_GIVE_UP = 5;
/** How long a restart waits for an old send handle to close before trying the new listener; a
 *  close that does not settle in this bound is not cancelled, only not awaited. */
const SEND_CLOSE_BOUND_MS = 1_000;
/** The longest a close waits for an endpoint refresh sent before its admission. It sits above
 *  the refresh's own bounds (the send probe, the bus probes and the start lock), so only a start
 *  that never answers reaches it; that close answers pending and keeps ownership. */
const REFRESH_CLOSE_BOUND_MS = 10_000;

type InFlight = { op: string; since: number };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-reads one route's team the way its writers do: a `team-file` route re-reads exactly the
 *  file its launch read opened; a registry route resolves its root through the one seam again.
 *  The handle is never used as a file here — for a registry team it names the conventional path,
 *  and a file left there is not the team. */
function readRouteTeam(
  entry: { root: string; file?: string; handle: string },
  home: string,
): ReturnType<typeof readTeamConfig> {
  return entry.file === undefined
    ? readTeamConfig(entry.root, { home })
    : readTeamConfig(dirname(entry.file), { file: entry.file, home });
}

/** Whether a run settles within `ms`, whether it resolves or rejects. The timer only decides
 *  the close's answer: a run that loses the race is not cancelled, and nothing it owns is
 *  released on the strength of the timer. */
async function settlesWithin(run: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.then(() => true, () => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  gitHead?: string | null;
  heartbeatAt: string;
  /** The whole seconds the loop's policy word runs at; absent while a test seam owns the beat. */
  heartbeatSeconds?: number | null;
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
    ...(fields.gitHead === undefined ? {} : { gitHead: fields.gitHead }),
    heartbeatAt: fields.heartbeatAt,
    ...(fields.heartbeatSeconds === undefined ? {} : { heartbeatSeconds: fields.heartbeatSeconds }),
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
  /** Consecutive send probes that went unanswered (0.5.9). The endpoint runs on this same event
   *  loop, so one probe can miss while a synchronous herdr read holds the loop; only
   *  SEND_PROBE_MISSES misses in a row mark it failed, and an answer afterwards restores it. */
  sendMisses: number;
  /** Starts this root's send endpoint again; null while this daemon never attempted one. The
   *  closure is the exact start the root got, so a restart reads the same team, host and
   *  presence answers. */
  sendStart: (() => Promise<Awaited<ReturnType<typeof startSendDaemon>>>) | null;
  /** The send handle this daemon owns, so a failed endpoint can be closed before a restart. */
  sendHandle: SendDaemonHandle | null;
  /** The bus handle this daemon owns, so a state write can read the first pass's progress. */
  busHandle: BusHandle | null;
  /** The restart's own backoff and single-flight flag. */
  sendState: BusWatch;
  /** Whether this root's send start attempt has returned; a probe waits for it. */
  sendStarted: boolean;
  /** Whether this root's bus start attempt has returned (or was skipped); a bus probe waits. */
  busStarted: boolean;
  /** Set once the endpoint's restart budget is spent and `onFatal` has been called. */
  fatalSent: boolean;
};
const SEND_PROBE_MISSES = 3;
const SEND_PROBE_TIMEOUT_MS = 2_000;

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
  const stuckMs = input.stuckMs ?? STUCK_MS;
  const refreshCloseBoundMs = input.refreshCloseBoundMs ?? REFRESH_CLOSE_BOUND_MS;
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
  /** Each hosted bus whose first pass is still worth reading on a state write: the row carries
   *  how far the scan has got, so a bus that serves while its first pass runs says so. */
  const passRefreshers: (() => void)[] = [];
  const routes: HostedRoute[] = [];
  /** The validated team file per accepted route, by canonical root: the chores policy chain and
   *  the child's own config are read from what the daemon accepted, never from a re-read that
   *  could name another team. */
  const teams = new Map<string, TeamFile>();
  /** The supervised chores children, built after the roots loop; null until then and whenever
   *  the daemon was not started with the isolation seam. The state writer reads it every time,
   *  so a beat's record carries what each child said on this beat. */
  let choresFleet: ChoresFleet | null = null;
  /** The one mailbox router, built once the beat exists. Null when this start did not ask for it. */
  let mailboxRouter: MailboxRouter | null = null;
  /** What each route must re-read, by canonical root. The route remembers the loader's root and
   *  the file a `team-file` route launched from; a registry route names no file, so it is resolved
   *  from its root again the way every writer resolves it. `handle` is the path the loader
   *  reported: state and the watch binding live beside it, but for a registry team it may name no
   *  file at all, and a file standing there is a leftover, never the team. */
  const routeTeams = new Map<string, { root: string; file?: string; handle: string }>();
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
    /** The held-frame step: the one place a socket frame is seen at a held-message dialog. */
    held: PresenceHeldStep;
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
  /** Ends a restore child whose pass is still running when the daemon closes: the child's own
   *  flag stops the pass between seat steps, and the spawner bounds the step it is inside. */
  const restoreAbort = new AbortController();
  // The hosted send server may take a delivery while this start is still wiring the presence
  // answers. Until the verdict helper below exists the per-seat answer is false, which holds
  // typing instead of reading a helper that is not initialised yet.
  let seatReady = false;
  // The per-seat health answer is built after the roots loop (`seatVerdict` below). Until then a
  // probe answers each route's root-level starting record instead of reading a helper that is not
  // initialised yet: the machine socket is bound before any root starts, and a large store's bus
  // start can hold the loop for minutes.
  let seatsReady = false;
  let heartbeatAt = since;
  let closed = false;
  /** The daemon's own log writer. Like its state record, it stops once admission has closed: a
   *  probe or watch pass that settles afterwards must not recreate the machine folder to append
   *  a line. The close's own pending note is written deliberately, as its state record is. */
  const logLine = (line: string, afterClose = false): void => {
    if (closed && !afterClose) return;
    appendDaemonLog(home, line, now());
  };

  // The loop's beat: an injected seam owns it whole (a test that must not wait the release beat),
  // and otherwise the `daemon.heartbeat` word the hosted roots' chains declare — resolved once
  // here at start, then re-read on the housekeeping pass, where a changed word re-arms the timer
  // below. `heartbeatSeconds` is the word the state record and the health answer carry; null
  // while the seam owns the beat.
  const heartbeatPolicy = createHeartbeatPolicy({
    seamMs: input.heartbeatMs ?? null,
    initialRoots: input.roots,
    roots: () => (sweepRoots.length > 0 ? sweepRoots : input.roots),
    home,
    now,
    log: (text) => logLine(text),
  });
  let heartbeatMs = heartbeatPolicy.ms();
  let heartbeatSeconds = heartbeatPolicy.seconds();

  // The beat between hosted routes: the interval owns it, and a hosted pass that holds the event
  // loop carries the due beats it displaces to every other route. It never touches the calling
  // route's state — that pass may hold the state lock — and it writes no daemon record: the
  // interval's own beat does that when it next runs.
  const hostedBeat = createHostedBeat({
    intervalMs: () => heartbeatMs,
    watches: () => hostedWatches.map((one) => one.watch),
    log: (text) => logLine(text),
    now,
  });

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
      if (!seatsReady) {
        // The route is known and its presence work exists, but the per-seat answer is still being
        // wired: answer the root-level starting record. This is an answer, not a refusal, so an
        // install probe sees a running daemon with a starting root instead of an unanswerable
        // socket that its bounded wait reads as "no daemon".
        return {
          root: route.root,
          presence: {
            session: route.session,
            state: 'pending',
            healthy: false,
            checkedAt,
            why: 'the daemon is still starting this root',
          },
        };
      }
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
      gitHead: input.gitHead ?? null,
      heartbeatAt,
      features,
      stuck: stuckNow(),
      ...(heartbeatSeconds === null ? {} : { heartbeatSeconds }),
      ...(routes.length > 0 ? { roots: rootsSnapshot(at) } : {}),
    });
  };

  // The state record's writes, serialized off this loop: at most one physical write in
  // flight, a newer text replacing a queued one, and no write at all when the text is the
  // one already written, writing or queued. The probe answers from memory, so a slow disk
  // delays only the file, never the answer.
  const stateWriter = input.stateWriter ?? writeDaemonStateText;
  let lastWrittenStateText: string | null = null;
  let writingStateText: string | null = null;
  let queuedStateText: string | null = null;
  let stateWriteDrain: Promise<void> | null = null;
  const queueStateWrite = (text: string): Promise<void> => {
    if (text === lastWrittenStateText || text === writingStateText || text === queuedStateText) {
      return stateWriteDrain ?? Promise.resolve();
    }
    queuedStateText = text;
    if (stateWriteDrain === null) {
      stateWriteDrain = (async (): Promise<void> => {
        while (queuedStateText !== null) {
          const current = queuedStateText;
          queuedStateText = null;
          writingStateText = current;
          try {
            await stateWriter(home, current);
            lastWrittenStateText = current;
          } catch {
            // The next beat tries again; an unwritable record is reported as unknown, never healthy.
          } finally {
            writingStateText = null;
          }
        }
        stateWriteDrain = null;
      })();
    }
    return stateWriteDrain;
  };
  const flushStateWrites = async (): Promise<void> => {
    while (stateWriteDrain !== null) await stateWriteDrain;
  };

  const writeState = (afterClose = false): Promise<void> => {
    if (closed && !afterClose) return Promise.resolve();
    for (const one of hostedWatches) one.status.watch = one.watch.state();
    for (const refresh of passRefreshers) refresh();
    // Each route's chores record is this beat's reading, never a stored word: the supervisor
    // reports what its child last said, and a route the fleet does not know keeps no field.
    if (choresFleet !== null) {
      for (const status of roots) {
        const chores = choresFleet.stateFor(status.root);
        if (chores !== undefined) status.chores = chores;
      }
    }
    return queueStateWrite(serializeDaemonState({
      format: 1,
      pid,
      uid,
      since,
      startedBy,
      version: input.version,
      gitHead: input.gitHead ?? null,
      heartbeatAt,
      socket: socketPath,
      features,
      stuck: stuckNow(),
      roots: [...roots],
      ...(heartbeatSeconds === null ? {} : { heartbeatSeconds }),
      ...(mailboxRouter === null ? {} : { mailbox: { heartbeatAt: mailboxRouter.state().heartbeatAt } }),
    }));
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
    const entry = routeTeams.get(route.root);
    if (entry === undefined) {
      return nextInternal('the resolved route has no recorded team');
    }
    let loaded;
    try {
      loaded = readRouteTeam(entry, home);
    } catch (error) {
      return nextInternal(`the route's team could not be read: ${plainText(error instanceof Error ? error.message : String(error))}`);
    }
    if (!loaded.ok) {
      return nextInternal(`the route's team could not be read: ${loaded.errors[0]?.message ?? 'unknown error'}`);
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
      // The verified pane's process identity, read the way this host reads a pane for a watch
      // authority: the handler's class then knows whether the recorded socket is the pane's
      // own. A pane the terminal host cannot answer for reads null, the conservative rule.
      // The read is awaited, never taken on the loop: the daemon's timer keeps beating while
      // a terminal host is slow to answer.
      const readProcesses = input.paneProcesses
        ?? ((pane: string, session: string) => paneProcessesAsync(pane, session, { timeoutMs: 10_000 }));
      const processes = await readProcesses(verdict.pane, route.session);
      const answer = await handler({
        route,
        team: loaded.team,
        caller: { seat: verdict.seat, pane: verdict.pane },
        action: request.action ?? 'claim',
        mine: request.mine ?? false,
        now: at.getTime(),
        // The registry home this daemon was started with: the one the route's team was read in,
        // and the one the handler reads the seat's agent record from.
        home,
        processes,
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
      logLine(`machine socket: ${error.message}`);
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
  await writeState();

  const sendHandles: SendDaemonHandle[] = [];
  const busHandles: BusHandle[] = [];
  const watched: EndpointWatch[] = [];
  /** The roots whose team files validated: the only ones the heartbeat's fallback sweep reads. */
  const sweepRoots: SweepRoot[] = [];

  // The heartbeat starts before any endpoint does, and every tick writes the record even while
  // the roots loop below is still starting endpoints. A root is registered as `starting` before
  // its first start attempt, so a reader finds a live daemon and the checkouts it is bringing up
  // instead of a bound socket with no record. The rest of the beat (fault inbox, hosted-watch
  // ticks, endpoint probes, fallback sweep) is attached once that wiring exists; until then a
  // tick refreshes the heartbeat and the record alone.
  let beat: (() => void) | null = null;
  const beatTick = (): void => {
    heartbeatAt = now().toISOString();
    beat?.();
    // One write per beat, at its end, so the record carries everything the beat itself
    // changed and the disk is never visited twice for one heartbeat.
    void writeState();
  };
  let timer = setInterval(beatTick, heartbeatMs);
  timer.unref();
  /** The reload half of the heartbeat word: the housekeeping pass re-reads it, and a changed
   *  word re-arms the timer here, so the next tick is the first on the new beat. The state
   *  record this tick writes already carries the word. */
  const rearmHeartbeat = (): void => {
    heartbeatPolicy.refresh();
    if (heartbeatPolicy.ms() === heartbeatMs) return;
    heartbeatMs = heartbeatPolicy.ms();
    heartbeatSeconds = heartbeatPolicy.seconds();
    clearInterval(timer);
    timer = setInterval(beatTick, heartbeatMs);
    timer.unref();
  };

  // Staged limitation, and the exact block the extraction replaces: the machine protocol
  // socket is the daemon's own endpoint, but send and bus still have no machine route, so this
  // one process hosts each checkout's existing send and bus listeners beside it. N checkouts
  // therefore mean 2N+1 endpoints in one process until the machine endpoint serves route
  // delivery and a shared per-seat queue behind the relay package boundary.
  for (const rootArg of input.roots) {
    const status: MachineRootStatus = {
      root: rootArg, team: null, send: 'starting', bus: 'starting', why: null, sendWhy: null, busWhy: null,
    };
    // A root with no hosted endpoint keeps both sockets null and the refresh skips it.
    const watch: EndpointWatch = {
      status,
      sendSocket: null,
      busSocket: null,
      busRoot: null,
      busState: freshBusWatch(),
      sendMisses: 0,
      sendStart: null,
      sendHandle: null,
      busHandle: null,
      sendState: freshBusWatch(),
      sendStarted: false,
      busStarted: false,
      fatalSent: false,
    };
    watched.push(watch);
    let registered = false;
    const register = (): void => {
      if (registered) return;
      registered = true;
      roots.push(status);
      void writeState();
    };
    const loaded = readTeamConfig(rootArg, { home });
    if (!loaded.ok) {
      status.why = loaded.errors[0]?.message ?? 'the team file cannot be read';
      status.send = 'failed';
      status.bus = 'failed';
      register();
      logLine(`root ${rootArg}: ${status.why}`);
      continue;
    }
    // Routed by what the loader actually opened, never by the spelling of the argument: two
    // spellings of one checkout are one route, or every scope naming it would be ambiguous.
    const canonical = canonicalRoot(loaded.root);
    if (canonical === null) {
      status.why = 'the checkout root cannot be resolved to a folder';
      status.send = 'failed';
      status.bus = 'failed';
      register();
      logLine(`root ${rootArg}: ${status.why}`);
      continue;
    }
    if (duplicateRoute(routes, canonical) !== null) {
      status.root = canonical;
      status.why = 'this checkout is already hosted by this daemon';
      status.send = 'failed';
      status.bus = 'failed';
      register();
      logLine(`root ${rootArg}: ${status.why}`);
      continue;
    }
    status.root = canonical;
    status.team = loaded.team.project;
    watch.busRoot = canonical;
    sweepRoots.push({ root: loaded.root, team: loaded.team });
    teams.set(canonical, loaded.team);
    // Registered before any endpoint is started: status can name the root, and a heartbeat
    // keeps its record fresh, while a large store or a slow start below is still in progress.
    register();
    const route = routeOf(
      canonical,
      loaded.team.project,
      loaded.team.session,
      loaded.team.seats.map((seat) => seat.name),
    );
    routes.push(route);
    routeTeams.set(canonical, { root: loaded.root, file: launchTeamFile(loaded), handle: loaded.path });
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
        logLine(`presence ${route.root}: ${why}`);
      }
      try {
        for (const failed of [...unresolvedTargets, ...(input.presenceUnproven?.(route, stateDir) ?? [])]) {
          register(unprovenSource(failed.seat, failed.why));
        }
      } catch (error) {
        const why = `the runtime resolutions were not built: ${messageOf(error)}`;
        health.unresolved(why);
        logLine(`presence ${route.root}: ${why}`);
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
        held: input.presenceHeld?.(route, stateDir)
          ?? createPresenceHeld({
            stateDir,
            project: loaded.team.project,
            root: canonical,
            session: loaded.team.session,
            home,
            seats: loaded.team.seats.map((seat) => ({ name: seat.name, launch: seat.launch })),
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
    // The same start is kept for a later restart: a send endpoint that stops answering is
    // started again from here, with the same team, host and live presence answers, on the
    // heartbeat's own schedule.
    const startSend = (): Promise<Awaited<ReturnType<typeof startSendDaemon>>> =>
      (input.sendStart ?? startSendDaemon)({
        root: canonical, dir: canonical, team: loaded.team, host: sendHost,
        ...(presence === undefined ? {} : {
          presenceStateDir: presence.stateDir,
          presenceChannelHealthy: (seat: string) => seatReady && seatQualified(presence, seat, now()),
        }),
      });
    watch.sendStart = startSend;
    let send: Awaited<ReturnType<typeof startSendDaemon>>;
    try {
      send = await startSend();
    } catch (error) {
      watch.sendStarted = true;
      watch.busStarted = true;
      status.send = 'failed';
      status.sendFailedAt = now().toISOString();
      status.bus = 'failed';
      status.busFailedAt = status.sendFailedAt;
      status.why = `the send server could not start: ${error instanceof Error ? error.message : 'unknown error'}`;
      register();
      logLine(`root ${rootArg}: ${status.why}`);
      continue;
    }
    watch.sendStarted = true;
    if (send.kind === 'serving') {
      sendHandles.push(send.handle);
      watch.sendHandle = send.handle;
      status.send = 'serving';
      watch.sendSocket = send.handle.socketPath;
    } else if (send.kind === 'already-running') {
      status.send = 'already-running';
      watch.sendSocket = send.socketPath;
    } else {
      status.send = 'failed';
      status.sendFailedAt = now().toISOString();
      status.sendWhy = send.kind === 'locked' ? 'another send server holds the project socket' : send.reason;
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
      watch.busStarted = true;
      status.bus = 'failed';
      status.busFailedAt = now().toISOString();
      status.busWhy ??= thresholds.refusals.map((refusal) => refusal.message).join('; ');
      register();
      logLine(`root ${rootArg}: bus not hosted: ${status.busWhy}`);
      continue;
    }
    let bus: Awaited<ReturnType<typeof startBus>>;
    try {
      // The first pass runs in the background: the bus serves as soon as its listener is bound,
      // so one store's scan never holds the next root back. The root's row carries the pass's
      // progress until it settles, so serving is not read as caught up.
      bus = await (input.initialBusStart ?? startBus)({
        root: canonical,
        team: loaded.team,
        stateDir: dirname(loaded.path),
        home,
        stderr: (text) => logLine(text),
        heldThresholdSeconds: thresholds.thresholds.held_threshold_seconds,
        now,
        initialReconcile: 'background',
      });
    } catch (error) {
      watch.busStarted = true;
      status.bus = 'failed';
      status.busFailedAt = now().toISOString();
      status.busWhy ??= `the bus server could not start: ${error instanceof Error ? error.message : 'unknown error'}`;
      register();
      logLine(`root ${rootArg}: ${status.busWhy}`);
      continue;
    }
    watch.busStarted = true;
    if (bus.kind === 'serving') {
      const handle = bus.handle;
      busHandles.push(handle);
      watch.busHandle = handle;
      status.bus = 'serving';
      watch.busSocket = busSocket(canonical);
      // Read on every state write, so the row's first-pass progress follows the scan: the start
      // returned once the listener was bound, and this is how a reader knows the store is not
      // caught up yet. A settle instant, once written, is not overwritten by a later pass. The
      // handle is read through the watch: a revive replaces it, and a failure clears it so an
      // endpoint that is gone never keeps the last bus's pass on its row.
      passRefreshers.push(() => {
        const current = watch.busHandle;
        if (current !== null) status.firstPass = current.firstPass();
      });
    } else {
      status.bus = 'failed';
      status.busFailedAt = now().toISOString();
      status.busWhy ??=
        bus.kind === 'busy'
          ? 'another bus server holds the project socket'
          : bus.kind === 'locked'
            ? 'another bus server is starting'
            : 'the bus socket could not be bound';
    }
    register();
    logLine(`root ${rootArg}: send ${status.send}, bus ${status.bus}`);
  }

  // The chores fleet: one supervised child per group of roots, for a daemon started with the
  // isolation seam. Each accepted route reads its own policy chain to the team level; a chain
  // that cannot be read keeps the release defaults and says so in the daemon log. A root that
  // failed to load has no route and no team, so it gets no chores entry: there is no work to
  // isolate and no policy to read.
  //
  // The reminder rides this fleet in a group of its own: its list read touches the registry and
  // every addressed team file, and its send is a whole delivery walk, so both are the main-loop
  // work this isolation exists to remove. An injected transport is a function seam that cannot
  // cross a pipe, so a daemon given one keeps the inline path and this process still delivers.
  const remindersInFleet = input.choresHosting === true && input.reminders !== undefined && input.reminderSend === undefined;
  if (input.choresHosting === true && (routes.length > 0 || remindersInFleet)) {
    choresFleet = createChoresFleet({
      home,
      beatMs: heartbeatMs,
      since,
      now,
      routes: routes.flatMap((route) => {
        const team = teams.get(route.root);
        const entry = routeTeams.get(route.root);
        return team === undefined || entry === undefined
          ? []
          : [{
              route,
              team,
              policy: choresPolicyFor(team, route.root, home, now()),
              // The loader's own handle names the team file; its folder is the state door and
              // the presence spool the child's presence steps read, exactly as this daemon does.
              stateDir: dirname(entry.handle),
              // A watched route runs its watch in the child that serves it: the child is then the
              // process that holds the epoch and performs the sends, and this daemon keeps the
              // record, the diagnostic's request file and the status row. The presence flag says
              // whether this daemon measures the route's seats and relays them with each beat.
              // A route whose policy is inline never reaches a child, so its watch stays here.
              ...(input.watchHosting === true
                ? {
                    watch: {
                      teamFile: entry.handle,
                      presence: presenceWork.some((one) => one.route.root === route.root),
                    },
                  }
                : {}),
            }];
      }),
      ...(remindersInFleet
        ? { machine: { reminders: { hosted: [...(input.reminderHosted ?? routes.map((route) => route.root))] } } }
        : {}),
      log: (text) => logLine(text),
      ...(input.choresFactory === undefined ? {} : { factory: input.choresFactory }),
      // A hosted pass that yields between seats asks for the daemon's cross-route beat. The
      // child's frame names the root; this daemon's own beat machinery decides which other
      // routes the beat renews, exactly as it does for a pass on its own loop.
      watchPulse: (root, at) => {
        const route = routes.find((candidate) => candidate.root === root);
        if (route !== undefined) hostedBeat.midPass(route);
      },
    });
  }

  // The per-seat binding and canonical-position reads live in `presence/reconcile.ts`, shared
  // with the chores child, so the daemon's live re-check and a child's presence pass read the
  // same state door and apply the same rules.

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
      currentBinding: currentPresenceBinding(one.stateDir, one.route.session, seat),
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
      ? currentPresenceBinding(one.stateDir, one.route.session, seat)
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
  seatsReady = true;

  // One watch per hosted route, on the daemon's existing heartbeat. The run starts at once and
  // performs its first pass; no second timer exists, and a pass that hangs holds nothing the
  // heartbeat needs. A root that failed to load, or that duplicates a checkout already hosted,
  // has no route and gets no watch; its status entry has no `watch` record either.
  if (input.watchHosting === true) {
    const log = (text: string): void => logLine(text);
    for (const status of roots) {
      const route = routes.find((candidate) => candidate.root === status.root);
      if (route === undefined) continue;
      if (hostedWatches.some((one) => one.watch.route === route)) continue;
      const entry = routeTeams.get(route.root);
      if (entry === undefined) continue;
      // The route's channel health comes from this daemon's own fixed liveness, never from the
      // store's last word: with presence hosting off there is no pass, so the answer is absent
      // and the dispatcher holds a native projection rather than believing it.
      const presence = presenceWork.find((one) => one.route.root === route.root);
      // The route's broker reading is a daemon capability: only a daemon that hosts the broker
      // resolves one, and only through the injected builder. Otherwise this daemon opens no
      // socket and a tracker team's idle reading stays explicitly unknown.
      const brokerWork = features.broker === 'on' ? input.brokerWork?.(route) : undefined;
      const extras: HostedWatchExtras = brokerWork === undefined ? {} : { brokerWork };
      // A route whose watch this daemon asked a chores child to host answers with the child's
      // remote handle: its state mirrors the child's frames, its tick carries this beat over the
      // pipe, and its fault is the diagnostic's one entry. The daemon then builds no second
      // watch for the route, and no second epoch for it exists. The presence closure is read on
      // every beat the fleet sends, and only when the token told the child to install one.
      const remote = choresFleet === null
        ? null
        : choresFleet.watchFor(route.root, () => (presence === undefined
            ? null
            : route.seats.map((seat) => {
                const verdict = seatVerdict(presence, seat, now());
                return {
                  seat,
                  healthy: verdict.why === null,
                  ...(verdict.why === null ? {} : { reason: verdict.why }),
                };
              })));
      if (remote !== null) {
        hostedWatches.push({ status, watch: remote });
        continue;
      }
      const build = input.hostedWatch?.(route, log, extras)
        ?? hostedWatchAuthority({
          route,
          // State and the binding identity live beside the loader's handle. For a registry team
          // the conventional path may name no file: the binding is the root's identity, and the
          // wrapper tolerates an absent file.
          teamFile: entry.handle,
          log,
          // Proving a recorded pane watch is the process in its own pane needs this route's
          // session; the read is awaited so a slow terminal host holds the watch acquisition,
          // never the daemon's beat. A pane the terminal host cannot read stays `unproven` and
          // is never asked to hand over.
          processInfo: (pane) => paneProcessesAsync(pane, route.session, { timeoutMs: 10_000 }),
          ...(presence === undefined
            ? {}
            : {
                // The consumer's contract is per seat and only `=== true` qualifies: a seat with
                // no source keeps the route's fresh ingest answer, an expected native seat needs
                // its own current sample, and a missing or false answer holds the projection.
                presenceChannelHealthy: (seat: string) =>
                  seatQualified(presence, seat, now()),
                // The measured detail behind a false answer, for the stuck report's notice only.
                presenceChannelReason: (seat: string) =>
                  seatVerdict(presence, seat, now()).why,
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
          // A due beat landing inside this route's pass renews the other routes, never this one:
          // the pass can hold this route's state lock in its fold.
          onBeat: () => hostedBeat.midPass(route),
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
    logLine(`presence ${route.root}: ${text}`);
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
      currentBinding: currentPresenceBinding(one.stateDir, one.route.session, source.seat),
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
        currentBinding: currentPresenceBinding(one.stateDir, one.route.session, source.seat),
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

  /** The JSON-safe fields of one source reading, as the chores child receives them: the source's
   *  own measured words, never a host verdict. */
  const presenceStatusOf = (reading: PresenceSourceStatus): ChoresPresenceStatus => ({
    seat: reading.seat,
    binding: reading.binding,
    threadId: reading.threadId,
    channel: reading.channel,
    stream: reading.stream,
    baseline: reading.baseline,
    evidenceAt: reading.evidenceAt,
    ...(reading.stagedEventId === undefined ? {} : { stagedEventId: reading.stagedEventId }),
    ...(reading.why === undefined ? {} : { why: reading.why }),
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
  });

  /** Mirrors a child's proof rows into the route's cache. A seat the child did not answer for is
   *  held rather than left with an older proof: the child owns the pass's whole answer. */
  const applyPresenceProofs = (
    one: (typeof presenceWork)[number],
    proofs: readonly ChoresPresenceProof[],
  ): void => {
    const answered = new Set<string>();
    for (const proof of proofs) {
      answered.add(proof.seat);
      if ('id' in proof) {
        one.proofs.set(proof.seat, { id: proof.id, binding: proof.binding, epoch: since });
        one.proofMiss.delete(proof.seat);
      } else {
        one.proofs.delete(proof.seat);
        one.proofMiss.set(proof.seat, proof.miss);
      }
    }
    for (const source of one.sources) {
      if (answered.has(source.seat)) continue;
      one.proofs.delete(source.seat);
      one.proofMiss.set(source.seat, 'the presence pass did not answer for this seat');
    }
  };

  /** Holds every source seat with one reason, for a pass the child could not answer: a proof
   *  from an older pass is never kept trusted behind a child that left. */
  const holdPresenceSeats = (one: (typeof presenceWork)[number], why: string): void => {
    for (const source of one.sources) {
      one.proofs.delete(source.seat);
      one.proofMiss.set(source.seat, why);
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
   *
   * The daemon keeps the live half — the ingest step, each source's sample, the channel health
   * answer and the final re-check — and sends the measured readings to the root's chores child,
   * which runs the durable half. A root with no ready child runs both halves here.
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
      // The readings cross to the child exactly as this daemon sampled them. A source that cannot
      // answer, or answers for another seat, is sent as that reason, so the child holds the seat
      // with the same words the inline steps would have used.
      const at = now();
      const readings: ChoresPresenceReading[] = [];
      for (const source of one.sources) {
        try {
          const reading = source.status(at);
          readings.push(reading.seat === source.seat
            ? { seat: source.seat, status: presenceStatusOf(reading) }
            : { seat: source.seat, failed: 'the runtime source answered for another seat' });
        } catch (error) {
          readings.push({ seat: source.seat, failed: `the runtime source status failed: ${messageOf(error)}` });
        }
      }
      const hosted = choresFleet === null
        ? null
        : choresFleet.presence({ root: one.route.root, at, readings });
      if (hosted !== null) {
        const answer = await hosted;
        // A close stopped the child before it answered: the close's own record names this route
        // pending, and no step is run behind the child that may already have advanced a cursor.
        if (closed) return;
        if (answer.kind === 'answered') {
          for (const note of answer.notes) logPresenceOnce(one.route, note);
          applyPresenceProofs(one, answer.proofs);
        } else {
          holdPresenceSeats(one, answer.why);
        }
        return;
      }
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
      try {
        // The held-frame step runs last and belongs to the receiver, never to the sender: it looks
        // at a seat's pane only after a socket delivery of this route's history, and raises `held`
        // when the frame sat at its dialog. A look that cannot answer is retried by a later pass.
        const held = await one.held(now());
        if (held.failed !== null) logPresenceOnce(one.route, `the held step failed: ${held.failed}`);
        for (const id of held.raised) logPresenceOnce(one.route, `a socket frame was held at its seat's dialog: ${id}`);
      } catch (error) {
        logPresenceOnce(one.route, `the held step failed: ${error instanceof Error ? error.message : String(error)}`);
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
  /** The one refresh in flight, if any. Admission joins it before ownership is released, so a
   *  probe sent while the endpoints were still up cannot settle after the close; with the log
   *  guarded, its late answer writes neither the record nor the log. A beat that finds one
   *  running joins it. */
  let refreshRun: Promise<void> | null = null;
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
      logLine(`root ${root}: bus not restarted: ${thresholds.refusals.map((refusal) => refusal.message).join('; ')}`);
      return;
    }
    const revived = await reviveBus({
      root: loaded.root,
      team: loaded.team,
      stateDir: dirname(loaded.path),
      home,
      stderr: (text) => logLine(text),
      heldThresholdSeconds: thresholds.thresholds.held_threshold_seconds,
      now,
    }, watch.busState, at, undefined, input.busStart);
    // A revive started before admission can land after it: the handles admission stopped were
    // already spliced, so a listener bound now would belong to no one. It is closed here instead
    // of adopted. Admission joined this refresh, so the daemon's close waits for this close to
    // settle and cannot answer with the listener still bound.
    if (closed) {
      if (revived.kind === 'serving') {
        try {
          await revived.handle.close();
        } catch {
          // A handle that was already closed has nothing left to stop.
        }
      }
      return;
    }
    if (revived.kind === 'serving') {
      busHandles.push(revived.handle);
      // The revived start is the awaited one, so its first pass has settled by now; the row
      // reads this handle's pass from here on.
      watch.busHandle = revived.handle;
      watch.status.bus = 'serving';
      watch.status.busFailedAt = null;
      watch.busSocket = busSocket(loaded.root);
      watch.status.busWhy = null;
      logLine(`root ${root}: bus restarted`);
    } else if (revived.kind === 'busy' || revived.kind === 'listening') {
      // Another process serves the bus here: this daemon owns no handle and has no pass to report.
      watch.busHandle = null;
      delete watch.status.firstPass;
      watch.status.bus = 'serving';
      watch.status.busFailedAt = null;
      watch.busSocket = busSocket(loaded.root);
      watch.status.busWhy = null;
    } else if (revived.kind === 'failed') {
      logLine(`root ${root}: bus restart failed (${revived.why})`);
    }
  };

  // A send endpoint that stopped answering is closed and started again in this process, on the
  // same capped backoff as a bus revive. The start is the one the root got at daemon start, so
  // the team, host and presence answers are read fresh each time. A restart that keeps failing
  // spends the budget and then stops the daemon: the system's service manager starts a new one.
  const sendGiveUp = input.sendRestart?.giveUp ?? SEND_RESTART_GIVE_UP;
  const sendBackoff = input.sendRestart?.backoffMs ?? nextBackoffMs;
  const fatalSend = (watch: EndpointWatch, reason: string): void => {
    if (watch.fatalSent) return;
    watch.fatalSent = true;
    const why =
      `the send endpoint for ${watch.status.root} failed ${String(watch.sendState.failures)} restarts in a row (${reason}); ` +
      "the daemon stops so the system's service manager starts it again";
    logLine(why);
    input.onFatal?.(why);
  };
  const restartHostedSend = async (watch: EndpointWatch): Promise<void> => {
    const startSend = watch.sendStart;
    if (startSend === null || closed || watch.fatalSent || watch.sendState.starting) return;
    const at = now().getTime();
    if (at < watch.sendState.nextAt) return;
    watch.sendState.starting = true;
    try {
      const old = watch.sendHandle;
      watch.sendHandle = null;
      if (old !== null) {
        // A close that does not settle is bounded, not cancelled: the restart proceeds and the
        // old socket path is cleared by the new start when it is stale.
        await settlesWithin(Promise.resolve(old.close()).catch(() => undefined), SEND_CLOSE_BOUND_MS);
      }
      const send = await startSend();
      if (closed) {
        if (send.kind === 'serving') {
          try {
            await send.handle.close();
          } catch {
            // A handle that never bound has nothing left to stop.
          }
        }
        return;
      }
      if (send.kind === 'serving') {
        sendHandles.push(send.handle);
        watch.sendHandle = send.handle;
        watch.sendSocket = send.handle.socketPath;
        watch.status.send = 'serving';
        watch.status.sendFailedAt = null;
        watch.status.sendWhy = null;
        watch.sendMisses = 0;
        watch.sendState.failures = 0;
        watch.sendState.nextAt = 0;
        logLine(`root ${watch.status.root}: send restarted`);
      } else if (send.kind === 'already-running') {
        watch.sendSocket = send.socketPath;
        watch.status.send = 'already-running';
        watch.status.sendFailedAt = null;
        watch.status.sendWhy = null;
        watch.sendMisses = 0;
        watch.sendState.failures = 0;
        watch.sendState.nextAt = 0;
        logLine(`root ${watch.status.root}: send answering again`);
      } else {
        watch.sendState.failures += 1;
        watch.sendState.nextAt = now().getTime() + sendBackoff(watch.sendState.failures);
        watch.status.sendWhy = send.kind === 'locked' ? 'another send server holds the project socket' : send.reason;
        watch.status.sendFailedAt = watch.status.sendFailedAt ?? now().toISOString();
        logLine(`root ${watch.status.root}: send restart failed (${watch.status.sendWhy})`);
        if (watch.sendState.failures >= sendGiveUp) fatalSend(watch, watch.status.sendWhy);
      }
    } catch (error) {
      watch.sendState.failures += 1;
      watch.sendState.nextAt = now().getTime() + sendBackoff(watch.sendState.failures);
      watch.status.sendWhy = `the send server could not be restarted: ${messageOf(error)}`;
      watch.status.sendFailedAt = watch.status.sendFailedAt ?? now().toISOString();
      logLine(`root ${watch.status.root}: ${watch.status.sendWhy}`);
      if (watch.sendState.failures >= sendGiveUp) fatalSend(watch, watch.status.sendWhy);
    } finally {
      watch.sendState.starting = false;
    }
  };
  const refreshOnce = async (): Promise<void> => {
    try {
      // Every root's task is drained before the refresh counts as finished, and a failure is
      // recorded rather than allowed to settle the run early: a close joins this run before it
      // releases ownership, and a Promise.all rejection would let the other roots' revives
      // outlive that close and bind a listener behind the release.
      const settled = await Promise.allSettled(
        watched.map(async (watch) => {
          const { status } = watch;
          if (watch.sendStarted && watch.sendStart !== null) {
            if (status.send === 'failed') {
              // The record already names the failure and its instant; the restart is the next
              // step, under the same capped backoff a bus revive uses.
              await restartHostedSend(watch);
            } else if (status.send === 'serving' || status.send === 'already-running') {
              if (watch.sendSocket !== null && !(await probeDaemonSocket(watch.sendSocket, SEND_PROBE_TIMEOUT_MS))) {
                watch.sendMisses += 1;
                if (watch.sendMisses >= SEND_PROBE_MISSES) {
                  watch.sendMisses = 0;
                  status.sendWhy ??=
                    status.send === 'serving'
                      ? 'the hosted send endpoint stopped answering'
                      : 'the send server that was already running stopped answering';
                  status.send = 'failed';
                  status.sendFailedAt = now().toISOString();
                  logLine(`root ${status.root}: send endpoint stopped answering (${String(SEND_PROBE_MISSES)} probes in a row)`);
                  await restartHostedSend(watch);
                }
              } else {
                watch.sendMisses = 0;
              }
            }
          }
          if (watch.busStarted && watch.busRoot !== null) {
            const socket = busSocket(watch.busRoot);
            const up = await probeBusSocket(socket);
            if (up) {
              watch.busState.failures = 0;
              watch.busState.nextAt = 0;
              // A live socket is a serving bus whatever the last row said: another process may
              // have started one after this daemon's own start failed (a start still holding
              // its lock answers a live socket too). The row follows the socket, and its reason
              // is cleared with it — the revive path never runs while the socket answers.
              watch.busSocket = socket;
              status.bus = 'serving';
              status.busFailedAt = null;
              status.busWhy = null;
            } else {
              if (status.bus === 'serving') {
                status.busWhy = status.busWhy ?? 'the hosted bus endpoint stopped answering';
                status.bus = 'failed';
                status.busFailedAt = now().toISOString();
                // The bus whose pass this row carried is gone: a later revive sets its own handle,
                // and until then the row must not keep reading a pass nobody is running.
                watch.busHandle = null;
                delete status.firstPass;
                logLine(`root ${status.root}: bus endpoint stopped answering`);
              }
              await reviveHostedBus(watch);
            }
          }
        }),
      );
      for (const [index, one] of settled.entries()) {
        if (one.status !== 'rejected') continue;
        const root = watched[index]?.status.root ?? 'an unknown root';
        logLine(`root ${root}: the endpoint refresh failed: ${messageOf(one.reason)}`);
      }
    } finally {
      void writeState();
    }
  };
  const refreshHostedEndpoints = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (refreshRun !== null) return refreshRun;
    const run = refreshOnce().finally(() => {
      if (refreshRun === run) refreshRun = null;
    });
    refreshRun = run;
    return run;
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
    log: (text) => logLine(text),
  });

  // The first state write happened before hosting so a reader never finds a bound socket with no
  // record; this one records what each checkout actually got, failures and reasons included, and
  // every heartbeat refreshes it after asking the hosted sockets whether they still answer. The
  // timer itself started before the roots loop; this attaches the rest of the beat to it.
  // One router for every root. The beat nudges it and reads the heartbeat; it does not wait
  // on the child, an ask, or a reply.
  if (input.mailboxHosting === true && input.mailboxFactory !== undefined) {
    mailboxRouter = createMailboxRouter({
      beatMs: heartbeatMs,
      now,
      log: (text) => logLine(text),
      factory: input.mailboxFactory,
    });
  }
  // The start does not answer until this write lands: a reader who finds the socket bound
  // must find the record naming the roots it hosts, never the empty startup record.
  await writeState();

  // The first retirement pass waits one full interval after the daemon started: a restart's first
  // ticks never rewrite history a caller may still be reading, and the clock a test pins at a
  // due instant never advances into a store pass.
  let lastStorePassAt = now().getTime();
  /** The fallback pass in flight, if any: one walk at a time, so two beats never read the same
   *  store side by side. A pass reads the durable markers itself, so the beat after it settles
   *  starts the next pass and nothing a skipped beat would have escalated is lost. */
  let sweepRun: Promise<void> | null = null;
  /** Writes the lines a finished pass has to say. A pass stopped by the close reports nothing:
   *  the log is already silent past admission, and the durable markers keep what is left. */
  const logSweep = (swept: FallbackSweepResult): void => {
    for (const entry of swept.roots) {
      if (entry.note !== null) logLine(`fallback sweep ${entry.root}: ${entry.note}`);
      if (entry.why !== null) {
        logLine(`fallback sweep ${entry.root}: ${entry.why}`);
        continue;
      }
      const notes = entry.notes;
      if (notes !== null && (notes.drained.length > 0 || notes.refused.length > 0 || notes.unreadable.length > 0)) {
        logLine(
          `fallback sweep ${entry.root}: notes recorded ${String(notes.drained.length)}, refused ${String(notes.refused.length)}, unreadable ${String(notes.unreadable.length)}`,
        );
      }
      const report = entry.report;
      if (report !== null && (report.escalated.length > 0 || report.refused.length > 0 || report.unreadable.length > 0)) {
        logLine(
          `fallback sweep ${entry.root}: escalated ${String(report.escalated.length)}, refused ${String(report.refused.length)}, unreadable ${String(report.unreadable.length)}`,
        );
      }
      const retired = entry.retirement;
      if (retired === null) continue;
      const reclaimed = entry.reclaim?.reclaimed ?? 0;
      if (retired.retired.length === 0 && retired.refused.length === 0 && retired.unreadable.length === 0 && reclaimed === 0) {
        continue;
      }
      logLine(
        `fallback store ${entry.root}: retired ${String(retired.retired.length)}, reclaimed ${String(reclaimed)}, refused ${String(retired.refused.length)}, unreadable ${String(retired.unreadable.length)}`,
      );
    }
  };
  // Reminders ride this same beat and are machine-scoped: one list for every hosted root,
  // re-read each beat so an edited config runs without a restart. The tick is never awaited — a
  // send that walks does not hold the beat — and a closed daemon starts none; a walk already
  // under way has each later leg refused by the sender's own authority recheck. The module keeps
  // its own per-reminder guard, so a beat that lands mid-walk skips that reminder and runs the
  // others. This is the path a daemon without a fleet runs; with one, the machine child owns it.
  const reminderBeat = (): void => {
    // A daemon whose fleet carries the machine child starts no beat of its own: the child reads
    // the list and walks the sends on its own loop, and this beat only nudges it. Two readers
    // would be two clocks for one machine-scoped list.
    if (closed || input.reminders === undefined || remindersInFleet) return;
    let specs: readonly ReminderSpec[];
    try {
      specs = input.reminders((line) => logLine(line));
    } catch (error) {
      logLine(`reminders: the configured list could not be read — ${messageOf(error)}; nothing fires this beat`);
      return;
    }
    if (specs.length === 0) return;
    void reminderTick({
      home,
      now: now(),
      specs,
      ...(input.reminderSend === undefined ? {} : { send: input.reminderSend }),
      log: (line) => logLine(line),
    }).catch((error: unknown) => {
      logLine(`reminders: the beat failed — ${messageOf(error)}`);
    });
  };
  beat = () => {
    try {
      faultInbox.consume(faultTargets);
    } catch (error) {
      logLine(`fault request: ${(error as Error).message}`);
    }
    // A tick releases only the waits whose own due instant has passed and returns at once: a
    // pass that is still running is never awaited here, so one slow or hanging route cannot
    // stop the daemon's liveness or another route's cycles. Each route is isolated, and the beat
    // is marked so a pass that displaced this one carries the next due beat itself.
    hostedBeat.tick();
    // The chores fleet is a nudge and a check, never a wait: a stuck child is signalled here and
    // its replacement starts on a later beat, so this tick returns at once whatever it is doing.
    choresFleet?.tick(now());
    mailboxRouter?.tick(now());
    void refreshHostedEndpoints();
    // One fallback sweep rides the existing heartbeat: no second timer, process or socket. Each
    // hosted root reads its own validated team file and its markers' durable due instants; the
    // pass keeps no state of its own, and close stops it with this timer. A root a chores fleet
    // hosts is swept in that child instead, so this beat keeps only the roots the fleet leaves
    // inline, plus any root it does not host at all: a root never handed to a child must never
    // go unswept here. With none left, the beat does nothing at this point.
    if (closed) return;
    reminderBeat();
    const fleet = choresFleet;
    const inlineRoots = fleet === null
      ? sweepRoots
      : sweepRoots.filter((entry) => {
          const row = fleet.stateFor(entry.root);
          return row === undefined || row.mode === 'inline';
        });
    if (inlineRoots.length === 0) return;
    if (sweepRun !== null) return;
    const beatAt = now().getTime();
    const housekeeping = beatAt - lastStorePassAt >= FALLBACK_STORE_PASS_MS;
    if (housekeeping) {
      lastStorePassAt = beatAt;
      // The daemon re-reads its own knobs on the housekeeping pass; the heartbeat word re-arms
      // the timer when it changed, beside the sweep's backlog reads below.
      rearmHeartbeat();
    }
    // The pass walks a slice at a time on the daemon's own loop: the health probe answers within
    // its 500 ms budget only when no single turn holds the loop through a store-wide backlog, so
    // the beat yields between markers, retirement candidates and lock folders. The rest of the
    // beat, and the heartbeat itself, keep their cadence while it runs; the close ends the walk
    // at its next slice boundary and drains it before ownership is released.
    const run = sweepFallbackEscalationsSliced({
      home,
      roots: inlineRoots,
      now,
      ...(housekeeping
        ? {
            retire: {
              limit: FALLBACK_STORE_PASS_LIMIT,
              // The backlog knobs are the team's word, read for each hosted root: above the
              // threshold one pass takes the bulk limit instead of the steady one, so a store
              // that was never retired before empties over a few passes. A root whose chain
              // cannot be read keeps the release defaults and says why below.
              backlogLimitsFor: (entry: SweepRoot) => storeBacklogLimits(entry.team, entry.root, home, now()),
              lockWaitMs: 0,
            },
          }
        : {}),
      slices: {
        sliceMs: FALLBACK_BEAT_SLICE_MS,
        stopping: () => closed,
        yield: () => new Promise<boolean>((resolve) => {
          if (closed) {
            resolve(false);
            return;
          }
          setImmediate(() => resolve(!closed));
        }),
      },
    })
      .then(logSweep)
      .catch((error: unknown) => {
        // Each root's own failure is reported inside the pass; this one is the walk itself, and
        // it must never leave an unhandled rejection on the daemon's loop.
        try {
          logLine(`fallback sweep: ${messageOf(error)}`);
        } catch {
          // The log is unavailable too; there is nowhere left to say it.
        }
      })
      .finally(() => {
        if (sweepRun === run) sweepRun = null;
      });
    sweepRun = run;
  };

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
      // A restore child still running is ended with the daemon: its pass stops between seat
      // steps, and the spawner forces the one terminal-host read it may be inside.
      restoreAbort.abort();
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
      // The chores children stop with the endpoints, before any drain: a child that could still
      // run a pass must not write one behind the close. The stop is bounded by its own kill
      // grace, so a child that never leaves cannot hold the daemon's ownership.
      if (choresFleet !== null) {
        admissions.push(choresFleet.stop('the daemon is closing').catch(() => undefined));
      }
      if (mailboxRouter !== null) {
        admissions.push(mailboxRouter.stop('the daemon is closing').catch(() => undefined));
      }
      // The endpoint refresh is joined below, after this admission block, so its wait is bounded
      // and a retry joins a run that outlived the first answer. It is not part of `admissions`:
      // that join is unbounded, and a start that never settles must not keep the lock, the
      // socket and the record held without an answer.
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
      await writeState(true);
      await Promise.all(admissions);
      // Every watch stop above has settled, so a fault that had not reached its seam when the
      // close began can never reach one now: its writer is answered `not reached` instead of
      // being left to a later daemon that did not receive the request.
      faultInbox.close();
    }
    // The refresh sent before admission is joined here, bounded, and outside the admission
    // block so a retry after a pending answer joins it again. Once it has settled, its late
    // answer can neither reach the record nor the log behind the close. A run the bound outlasts
    // is not cancelled and nothing it owns is released: the answer is a pending close that keeps
    // the lock, the socket and the record, so the revive it still holds can bind and close its
    // own listener without another daemon taking the routes beside it.
    const refresh = refreshRun;
    if (refresh !== null && !(await settlesWithin(refresh, refreshCloseBoundMs))) {
      logLine('close pending: the endpoint refresh did not settle', true);
      await writeState(true);
      return;
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
      // A fallback pass mid-walk ends at its next slice boundary once `closed` is set; the
      // drain keeps its durable writes from landing after ownership is released.
      ...(sweepRun === null ? [] : [sweepRun]),
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
        logLine(`presence ${one.route.root}: close pending: ${one.why}`, true);
      }
      await writeState(true);
      return;
    }
    await host.close();
    // No queued state write may land after the record is unlinked below and recreate it.
    await flushStateWrites();
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
  // launch; `closeOnce` drains the tracked run, and the closing signal ends the child's pass
  // between seat steps. Each pass runs in a child of its own (`./restore/spawn.ts`), so the
  // pass's synchronous terminal-host reads hold that process alone and the daemon's heartbeat
  // keeps its cadence while a route restores. Only canonical routes are swept: raw input roots
  // can repeat, name a folder with no accepted route, or differ in spelling from the route's own
  // root.
  if (input.restoreSweep !== false && routes.length > 0) {
    const runner = typeof input.restoreSweep === 'function'
      ? input.restoreSweep
      : (root: string, teamFile: string | undefined) =>
          runRestoreSweepInChild({
            home,
            root,
            ...(teamFile === undefined ? {} : { teamFile }),
            signal: restoreAbort.signal,
          });
    restoreSweepRun = (async (): Promise<void> => {
      let pendingRoutes: HostedRoute[] = [];
      for (const route of routes) {
        if (closed) return;
        const entry = routeTeams.get(route.root);
        if (entry === undefined) continue;
        try {
          const result = await runner(route.root, entry.file);
          if (result.kind === 'ran') {
            logLine(`restore ${route.root}: ${result.summary.line}`);
          } else if (result.kind === 'lock-held') {
            logLine(`restore ${route.root}: another session-mutating run holds the session; skipped`);
          } else if (result.kind === 'not-running') {
            logLine(`restore ${route.root}: the session is ${result.state ?? 'unreadable'}; skipped`);
            pendingRoutes.push(route);
          } else if (result.kind === 'unreadable') {
            logLine(`restore ${route.root}: ${result.reason}`);
          } else if (result.kind === 'refused') {
            const detail = result.detail === undefined ? '' : `: ${result.detail}`;
            logLine(`restore ${route.root}: the run exited ${String(result.exit)} before it planned a seat${detail}`);
          }
        } catch (error) {
          logLine(`restore ${route.root}: ${messageOf(error)}`);
        }
      }
      if (pendingRoutes.length === 0 || closed || restoreAbort.signal.aborted) return;

      const initialDelayMs = Math.max(1, input.restoreRetryInitialDelayMs ?? 5_000);
      const maxDelayMs = Math.max(initialDelayMs, input.restoreRetryMaxDelayMs ?? 60_000);
      const budgetMs = Math.max(0, input.restoreRetryBudgetMs ?? 315_000);
      let currentDelayMs = initialDelayMs;
      let elapsedMs = 0;
      let attempt = 1;

      const formatWait = (ms: number): string =>
        ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000}s` : `${ms}ms`;

      const waitAbortable = (ms: number): Promise<boolean> =>
        new Promise((resolveWait) => {
          if (closed || restoreAbort.signal.aborted) {
            resolveWait(false);
            return;
          }
          const onAbort = (): void => {
            clearTimeout(waitTimer);
            resolveWait(false);
          };
          const waitTimer = setTimeout(() => {
            restoreAbort.signal.removeEventListener('abort', onAbort);
            resolveWait(!closed && !restoreAbort.signal.aborted);
          }, ms);
          restoreAbort.signal.addEventListener('abort', onAbort, { once: true });
        });

      while (pendingRoutes.length > 0 && elapsedMs < budgetMs && !closed && !restoreAbort.signal.aborted) {
        const delayMs = Math.min(currentDelayMs, maxDelayMs, budgetMs - elapsedMs);
        if (delayMs <= 0) break;
        logLine(
          `restore: waiting ${formatWait(delayMs)} for the terminal host to restore ${pendingRoutes.length} session${pendingRoutes.length === 1 ? '' : 's'} (attempt ${attempt}, elapsed ${formatWait(elapsedMs)}/${formatWait(budgetMs)})`,
        );
        const waited = await waitAbortable(delayMs);
        if (!waited || closed || restoreAbort.signal.aborted) return;
        elapsedMs += delayMs;
        currentDelayMs = Math.min(currentDelayMs * 2, maxDelayMs);
        attempt += 1;

        const stillPending: HostedRoute[] = [];
        for (const route of pendingRoutes) {
          if (closed || restoreAbort.signal.aborted) return;
          const entry = routeTeams.get(route.root);
          if (entry === undefined) continue;
          try {
            const result = await runner(route.root, entry.file);
            if (result.kind === 'ran') {
              logLine(`restore ${route.root}: ${result.summary.line}`);
            } else if (result.kind === 'lock-held') {
              logLine(`restore ${route.root}: another session-mutating run holds the session; skipped`);
            } else if (result.kind === 'not-running') {
              stillPending.push(route);
            } else if (result.kind === 'unreadable') {
              logLine(`restore ${route.root}: ${result.reason}`);
            } else if (result.kind === 'refused') {
              const detail = result.detail === undefined ? '' : `: ${result.detail}`;
              logLine(`restore ${route.root}: the run exited ${String(result.exit)} before it planned a seat${detail}`);
            }
          } catch (error) {
            logLine(`restore ${route.root}: ${messageOf(error)}`);
          }
        }
        pendingRoutes = stillPending;
      }

      if (pendingRoutes.length > 0 && !closed && !restoreAbort.signal.aborted) {
        logLine(
          `restore: pending (${pendingRoutes.length} session${pendingRoutes.length === 1 ? '' : 's'} still restoring in the terminal host after ${formatWait(elapsedMs)}; run "team up --all" once the terminal host finishes restoring)`,
        );
      }
    })().catch((error: unknown) => {
      // The loop above already logs each route's failure; this catches the log write itself (or
      // anything outside the loop), so the tracked run never rejects into an unhandled rejection
      // that could bring the daemon down. Serving must not depend on the sweep's bookkeeping.
      try {
        logLine(`restore: ${messageOf(error)}`);
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

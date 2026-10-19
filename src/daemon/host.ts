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
import { busSocket, startBus, type BusHandle } from '../bus/server.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { loadTeamFile } from '../file/load.ts';
import { eventThresholdsInForce } from '../policy/index.ts';
import { plainLine } from '../launch/plain.ts';
import { pidAlive } from '../state.ts';
import { probeDaemonSocket, startSendDaemon, realDaemonHost, type DaemonHost, type SendDaemonHandle } from '../send/daemon.ts';
import { formatDaemonResponse, parseDaemonRequest, answerDaemonRequest, DAEMON_FRAME_LIMIT, DAEMON_PROTOCOL_VERSION, type DaemonErrorCode, type DaemonHealthSnapshot } from './protocol.ts';
import { probeDaemonHealth } from './health.ts';
import { sweepFallbackEscalations, type SweepRoot } from './fallback-sweep.ts';
import { daemonLockPath, daemonLogPath, daemonSocketPath, daemonStatePath } from './paths.ts';
import { createHostServer } from '../../packages/relay/host/server.js';
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
  health(): DaemonHealthSnapshot;
  close(): Promise<void>;
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
};

export type StartMachineDaemonResult =
  | { kind: 'serving'; daemon: MachineDaemon }
  | { kind: 'already-running'; pid: number | null }
  | { kind: 'locked'; pid: number | null }
  | { kind: 'bind-failed'; reason: string };

const HEARTBEAT_MS = 5_000;
const STUCK_MS = 10_000;

type InFlight = { op: string; since: number };

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

  const health = (): DaemonHealthSnapshot =>
    snapshotOf({
      pid,
      uid,
      since,
      startedBy,
      version: input.version,
      heartbeatAt,
      features,
      stuck: stuckNow(),
    });

  const writeState = (): void => {
    if (closed) return;
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
    status.team = loaded.team.project;
    sweepRoots.push({ root: loaded.root, team: loaded.team });
    const sendHost: DaemonHost = input.sendHost ?? { ...realDaemonHost, home };
    let send: Awaited<ReturnType<typeof startSendDaemon>>;
    try {
      send = await startSendDaemon({ root: loaded.root, dir: loaded.root, team: loaded.team, host: sendHost });
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
        root: loaded.root,
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
      watch.busSocket = busSocket(loaded.root);
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

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const handle of busHandles.splice(0)) {
      try {
        await handle.close();
      } catch {
        // Closing is best effort; the process is ending.
      }
    }
    for (const handle of sendHandles.splice(0)) {
      try {
        await handle.close();
      } catch {
        // Closing is best effort; the process is ending.
      }
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
  };

  return {
    kind: 'serving',
    daemon: { socketPath, roots, health, close },
  };
}

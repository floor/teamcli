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
  type DaemonState,
  type DaemonStuckRequest,
} from './state.ts';

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

// The machine daemon's own authority for a reminder send. A reminder is not sent by a seat, a
// pane or the owner: it is sent under the daemon's authority, and the proof is the state record
// the daemon writes at start (`daemon.state.json`), the single-instance lock that names its
// process, and the heartbeat it refreshes while it serves. This module reads those facts; a
// missing, stale, foreign or replaced record is a refusal, and an exception is read the same way,
// never as consent.
//
// The sender is either the daemon process itself or a process the daemon started as a supervised
// child of its own: the reminder beat runs in the machine chores child, beside the daemon's other
// heavy work. That second sender is proved by the process table, not by a record the child could
// write: the record names the daemon, the daemon's own parentage names the child. No other
// process can make itself a child of the daemon, so a seat's CLI — a child of a pane, a shell or
// a test runner — is read and refused exactly as before.
//
// The verifier is asked twice by every reminder send: once to establish the principal, and again
// before each transport the walk could take (`DaemonSendPrincipal.recheck`). `captured` carries
// the identity the principal was established with, so a record rewritten by a replaced daemon —
// even one that can take the same lock — never inherits the earlier send's authority.
import { readFileSync } from 'node:fs';
import { daemonLockPath } from '../daemon/paths.ts';
import { readDaemonState, type DaemonState } from '../daemon/state.ts';
import { pidAlive } from '../state.ts';

/** The daemon refreshes its heartbeat every five seconds while it serves (`HEARTBEAT_MS` in
 *  `src/daemon/host.ts`); a record older than three beats belongs to a process that stopped. */
export const DAEMON_BEAT_MS = 5_000;
export const DAEMON_STALE_BEATS = 3;

/** The identity a reminder send is established on: the record's process, start time and socket.
 *  A later reading must name the same three, or the daemon this send stood on has been replaced. */
export type DaemonIdentity = { pid: number; since: string; socket: string };

export type DaemonActorVerdict =
  | { ok: true; state: DaemonState; identity: DaemonIdentity; roots: readonly string[] }
  | { ok: false; why: string };

/**
 * Whether this process is the machine daemon, read from the state record and the lock. With
 * `captured`, the record must also name the same daemon the caller was established on. `now`
 * is the clock the heartbeat is judged against; tests inject it, the entry passes the beat's.
 */
export function verifyDaemonAuthority(input: { home: string; captured?: DaemonIdentity; now?: Date }): DaemonActorVerdict {
  const read = readDaemonState(input.home);
  if (read.kind === 'missing') return { ok: false, why: 'the daemon state record is missing: no process can prove it is the daemon' };
  if (read.kind === 'unreadable') return { ok: false, why: read.why };
  const state = read.state;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (state.uid !== uid) return { ok: false, why: `the daemon state record names another user's daemon (uid ${String(state.uid)})` };
  // Two senders stand under one identity: the daemon process, and a process the daemon started.
  // The child is read from the process table — its parent is the recorded pid — never from a
  // word the child itself could write: only the daemon can make a process its child.
  if (state.pid !== process.pid && state.pid !== process.ppid) {
    return {
      ok: false,
      why: `the daemon state record names process ${String(state.pid)}, and this process is ${String(process.pid)}, whose parent is ${String(process.ppid)}: neither the daemon nor a process it started`,
    };
  }
  if (!pidAlive(state.pid)) return { ok: false, why: `the daemon state record names process ${String(state.pid)}, which is not running` };
  const stale = staleHeartbeat(state, input.now ?? new Date());
  if (stale !== null) return { ok: false, why: stale };
  const identity: DaemonIdentity = { pid: state.pid, since: state.since, socket: state.socket };
  if (input.captured !== undefined && !sameIdentity(input.captured, identity)) {
    return { ok: false, why: 'the daemon record changed since this send was established: a replaced daemon never inherits an earlier send' };
  }
  const holder = lockPid(input.home);
  if (holder !== state.pid) {
    return {
      ok: false,
      why: `the daemon single-instance lock names ${holder === null ? 'no process' : `process ${String(holder)}`}, not the state record's process ${String(state.pid)}`,
    };
  }
  return { ok: true, state, identity, roots: state.roots.map((root) => root.root) };
}

function sameIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.pid === right.pid && left.since === right.since && left.socket === right.socket;
}

/** The stale-heartbeat refusal, or null while the record is fresh enough to stand. */
function staleHeartbeat(state: DaemonState, now: Date): string | null {
  const at = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(at)) return "the daemon state record's heartbeat is not a time";
  const age = now.getTime() - at;
  if (age > DAEMON_BEAT_MS * DAEMON_STALE_BEATS) {
    return `the daemon heartbeat is stale: ${state.heartbeatAt} is older than ${String(DAEMON_STALE_BEATS)} beats`;
  }
  return null;
}

/** The pid the daemon's single-instance lock names, or null when the lock is absent or does not
 *  hold a pid. The lock is one line, written by the daemon when it takes the machine. */
export function lockPid(home: string): number | null {
  try {
    const text = readFileSync(daemonLockPath(home), 'utf8').trim();
    if (!/^[0-9]+$/.test(text)) return null;
    const pid = Number.parseInt(text, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

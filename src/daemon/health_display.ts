// The one neutral reading `team status` and `team check` print about the machine daemon. It is
// pure: it takes the snapshot `daemonHealth` read and says what it means, so both commands share
// one wording and a scene can pin it without a socket. The record's own words are role words —
// the system's service manager, a manual start, `team up` — never a platform's name; the socket
// path and the process uid stay in the health module, because they are plumbing, not a reading.
import type { DaemonHealth, DaemonProbe } from './health.ts';
import type { DaemonFeatures, DaemonStuckRequest } from './state.ts';

/**
 * The reading as the two commands publish it in `--json`: the socket path, the uid and the
 * constant daemon name are left out, so a document says what the daemon is doing without
 * handing out the machine's layout.
 */
export type DaemonReading = {
  state: DaemonHealth['state'];
  running: boolean | null;
  pid: number | null;
  since: string | null;
  startedBy: string | null;
  version: string | null;
  heartbeatAt: string | null;
  features: DaemonFeatures | null;
  stuck: DaemonStuckRequest[];
  probe: DaemonProbe;
  why: string | null;
};

export function daemonReading(health: DaemonHealth): DaemonReading {
  return {
    state: health.state,
    running: health.running,
    pid: health.pid,
    since: health.since,
    startedBy: health.startedBy,
    version: health.version,
    heartbeatAt: health.heartbeatAt,
    features: health.features,
    stuck: health.stuck,
    probe: health.probe,
    why: health.why,
  };
}

/**
 * Healthy: running, answering the health probe just now, and holding no request past the stuck
 * threshold. Every other reading is something a reader should hear about — a running daemon that
 * does not answer may be hung, and an unreadable record is "cannot tell", never "not running".
 */
export function daemonHealthy(health: DaemonHealth): boolean {
  return health.state === 'running' && health.probe.state === 'answered' && health.stuck.length === 0;
}

/**
 * The one line `team status` prints whenever a reading exists. Status is the reading surface, so
 * the daemon's absence is said there too, with the one command that installs it; the line never
 * carries the socket path or a platform's service-manager name.
 */
export function daemonNotes(health: DaemonHealth | null): string[] {
  return health === null ? [] : [daemonLine(health)];
}

/**
 * The `team check` note. The check is "is anything wrong that someone should act on": a daemon
 * that is simply not installed is the ordinary state and says nothing, while a reading that
 * cannot tell, a process that does not answer, a refusal and a stuck request are named. A note
 * never enters the total and never changes the exit.
 */
export function daemonProblemNotes(health: DaemonHealth | null): string[] {
  if (health === null || daemonHealthy(health) || health.state === 'not-running') return [];
  return [daemonLine(health)];
}

function daemonLine(health: DaemonHealth): string {
  if (health.state === 'not-running') {
    return "machine daemon: not running; `team daemon install` starts it from the system's service manager";
  }
  if (health.state === 'unknown') {
    return `machine daemon: cannot tell whether it is running (${health.why ?? 'the reading could not be read'})`;
  }
  const pid = health.pid === null ? 'unknown pid' : `pid ${String(health.pid)}`;
  const head = health.since === null
    ? `machine daemon: running (${pid}), ${startedPhrase(health.startedBy)}`
    : `machine daemon: running since ${health.since} (${pid}), ${startedPhrase(health.startedBy)}`;
  const parts: string[] = [];
  if (health.probe.state === 'unanswered') {
    parts.push(`it did not answer the health probe (${health.probe.reason}), so it may be hung`);
  } else if (health.probe.state === 'refused') {
    parts.push(`it refused the health probe (${health.probe.code}: ${health.probe.message})`);
  } else if (health.probe.state === 'unknown') {
    parts.push(`the health probe could not tell (${health.probe.reason})`);
  }
  if (health.stuck.length > 0) parts.push(stuckPhrase(health.stuck));
  return parts.length === 0 ? head : `${head}; ${parts.join('; ')}`;
}

/** The record's launcher as the role word it is meant to be, never the platform's own name. */
function startedPhrase(startedBy: string | null): string {
  if (startedBy === 'service-manager') return "started by the system's service manager";
  if (startedBy === 'manual') return 'started manually';
  if (startedBy === 'team-up') return 'started by `team up`';
  if (startedBy === null || startedBy === '') return 'started by an unrecorded launcher';
  return `started by ${startedBy}`;
}

function stuckPhrase(stuck: DaemonStuckRequest[]): string {
  const listed = stuck.map((held) => `${held.op} since ${held.since}`).join(', ');
  return `${String(stuck.length)} request${stuck.length === 1 ? '' : 's'} held past the stuck threshold (${listed})`;
}

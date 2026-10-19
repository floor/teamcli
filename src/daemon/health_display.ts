// The one neutral reading `team status` and `team check` print about the machine daemon. It is
// pure: it takes the snapshot `daemonHealth` read and says what it means, so both commands share
// one wording and a scene can pin it without a socket. The record's own words are role words —
// the system's service manager, a manual start, `team up` — never a platform's name; the socket
// path and the process uid stay in the health module, because they are plumbing, not a reading.
import type { DaemonHealth, DaemonProbe } from './health.ts';
import type { DaemonFeatures, DaemonRootState, DaemonStuckRequest } from './state.ts';

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
  roots: DaemonRootState[];
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
    roots: health.roots,
    probe: health.probe,
    why: health.why,
  };
}

/**
 * Healthy: running, answering the health probe just now, holding no request past the stuck
 * threshold, and with every checkout it tried to host getting its send and bus endpoint — a
 * running daemon whose endpoint failed for a checkout is not full health. Every other reading is
 * something a reader should hear about — a running daemon that does not answer may be hung, and
 * an unreadable record is "cannot tell", never "not running".
 */
export function daemonHealthy(health: DaemonHealth): boolean {
  return health.state === 'running'
    && health.probe.state === 'answered'
    && health.stuck.length === 0
    && health.roots.every((root) => root.send !== 'failed' && root.bus !== 'failed');
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
  const parts: string[] = rootsPhrase(health.roots);
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

/**
 * What the daemon's process got for the checkouts it tried to host. A running daemon with a
 * failed endpoint must never read as full health, so a failure is named with its checkout and
 * reason; an endpoint another process already serves is not a failure, but the counts still say
 * it is not hosted here. A record written before roots were recorded reads as none, and then the
 * line says nothing about hosting rather than inventing it.
 */
function rootsPhrase(roots: DaemonRootState[]): string[] {
  if (roots.length === 0) return [];
  const sendServing = roots.filter((root) => root.send === 'serving').length;
  const busServing = roots.filter((root) => root.bus === 'serving').length;
  const parts = [`roots ${String(roots.length)} (send ${String(sendServing)}, bus ${String(busServing)})`];
  const failed = roots.flatMap((root) => {
    const entries: string[] = [];
    if (root.send === 'failed') entries.push(`send for ${root.root}: ${root.why ?? 'no reason recorded'}`);
    if (root.bus === 'failed') entries.push(`bus for ${root.root}: ${root.why ?? 'no reason recorded'}`);
    return entries;
  });
  if (failed.length > 0) {
    parts.push(
      `${String(failed.length)} endpoint${failed.length === 1 ? '' : 's'} did not start here (${failed.join(', ')})`,
    );
    return parts;
  }
  const notHosted = roots.reduce(
    (count, root) => count + (root.send === 'serving' ? 0 : 1) + (root.bus === 'serving' ? 0 : 1),
    0,
  );
  if (notHosted > 0) {
    parts.push(`${String(notHosted)} endpoint${notHosted === 1 ? '' : 's'} not hosted here`);
  }
  return parts;
}

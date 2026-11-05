// The one neutral reading `team status` and `team check` print about the machine daemon. It is
// pure: it takes the snapshot `daemonHealth` read and says what it means, so both commands share
// one wording and a scene can pin it without a socket. The record's own words are role words —
// the system's service manager, a manual start, `team up` — never a platform's name; the socket
// path and the process uid stay in the health module, because they are plumbing, not a reading.
import type { DaemonHealth, DaemonProbe } from './health.ts';
import type { DaemonChoresState, DaemonFeatures, DaemonRootState, DaemonStuckRequest } from './state.ts';
import { formatRelativeTime } from '../output/text.ts';
import type { Difference } from '../status/compare.ts';

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
  const parts: string[] = rootsPhrase(health.roots, health.probe.at);
  parts.push(...choresPhrase(health.roots, health.probe.at));
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
 * failed endpoint must never read as full health, so a failure is named with its checkout, its
 * reason and — where the record kept the instant — how long it has been failing. An endpoint
 * another process already serves is not a failure, but the counts still say it is not hosted
 * here. A record written before roots were recorded reads as none, and then the line says
 * nothing about hosting rather than inventing it.
 */
function rootsPhrase(roots: DaemonRootState[], at: string): string[] {
  if (roots.length === 0) return [];
  const sendServing = roots.filter((root) => root.send === 'serving').length;
  const busServing = roots.filter((root) => root.bus === 'serving').length;
  const starting = roots.reduce(
    (count, root) => count + (root.send === 'starting' ? 1 : 0) + (root.bus === 'starting' ? 1 : 0),
    0,
  );
  const parts = [`roots ${String(roots.length)} (send ${String(sendServing)}, bus ${String(busServing)})`];
  if (starting > 0) parts.push(`${String(starting)} endpoint${starting === 1 ? '' : 's'} starting`);
  parts.push(...firstPassPhrases(roots));
  const failed = roots.flatMap((root) => {
    const entries: string[] = [];
    // Every failed endpoint is named, with its reason. A record written before this build kept
    // the failure instant has no age to show; losing the failure with the stamp would hide a
    // real one, so only the age is optional.
    if (root.send === 'failed') {
      entries.push(
        `send for ${root.root}: ${root.sendWhy ?? root.why ?? 'no reason recorded'}${failureAge(root.sendFailedAt, at)}`,
      );
    }
    if (root.bus === 'failed') {
      entries.push(
        `bus for ${root.root}: ${root.busWhy ?? root.why ?? 'no reason recorded'}${failureAge(root.busFailedAt, at)}`,
      );
    }
    return entries;
  });
  if (failed.length > 0) {
    parts.push(
      `${String(failed.length)} endpoint${failed.length === 1 ? '' : 's'} did not start here (${failed.join(', ')})`,
    );
    return parts;
  }
  // "Not hosted here" is the endpoint another process already serves. A starting endpoint is
  // already said as starting, and a failed one is named above with its reason; counting either
  // here would name one endpoint twice.
  const notHosted = roots.reduce((count, root) => count + (root.send === 'already-running' ? 1 : 0), 0);
  if (notHosted > 0) {
    parts.push(`${String(notHosted)} endpoint${notHosted === 1 ? '' : 's'} not hosted here`);
  }
  return parts;
}

/**
 * The first-pass progress each hosted route's bus carries, as phrases. A daemon-hosted bus reads
 * serving once its listener is bound and answering, while the first pass over the store still
 * runs; these phrases keep that from being read as caught up. A pass that settled names the
 * instant it did, so "done" is never printed without a time; a pass that stopped on a failure says
 * so and keeps its partial count, so it is never printed as a clean finish.
 */
export function firstPassPhrases(roots: DaemonRootState[]): string[] {
  return roots.flatMap((root) => {
    const pass = root.firstPass;
    if (pass === undefined) return [];
    if (pass.running) {
      return [`first pass running for ${root.root} (${groupedCount(pass.scanned)} files scanned)`];
    }
    if (pass.errors) {
      return [
        `first pass ended with errors at ${pass.doneAt} for ${root.root} (${groupedCount(pass.scanned)} files scanned)`,
      ];
    }
    return [`first pass done at ${pass.doneAt} for ${root.root}`];
  });
}

/** Digits grouped in threes: the same text on every machine, whichever locale it runs in. */
function groupedCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The chores rows as one clause, appended to the daemon line whenever any checkout recorded one.
 * A route without a row says nothing: a daemon started without the chores seam has nothing to
 * report. When every recorded route runs inline the clause says the rollback once, and otherwise
 * it counts the roots whose chores run in children and names each route that is not simply
 * working, with the record's own reason. A late root also names the chore its child last
 * finished and the child's own marker-cache reading — files read afresh, stamps reused, stamps
 * held — which is the evidence for why a sweep is busy: a night of re-reads shows as reads, and
 * a starved chore reads as a late chore, never as a dead endpoint.
 */
export function choresPhrase(roots: DaemonRootState[], at: string): string[] {
  const rows = roots.flatMap((root) => (root.chores === undefined ? [] : [{ root: root.root, chores: root.chores }]));
  if (rows.length === 0) return [];
  const hosted = rows.filter((row) => row.chores.mode !== 'inline');
  const inline = rows.length - hosted.length;
  if (hosted.length === 0) return [inline === 1 ? 'chores inline' : 'chores inline on every root'];
  const counts = new Map<DaemonChoresState['state'], number>();
  for (const row of hosted) counts.set(row.chores.state, (counts.get(row.chores.state) ?? 0) + 1);
  const order: DaemonChoresState['state'][] = ['ok', 'starting', 'late', 'restarting', 'stopped'];
  const states = order.flatMap((state) => {
    const count = counts.get(state) ?? 0;
    return count === 0 ? [] : [`${String(count)} ${state}`];
  });
  const rootsWord = `root${hosted.length === 1 ? '' : 's'}`;
  let clause = `chores ${String(hosted.length)} ${rootsWord} in children (${states.join(', ')}`;
  if (inline > 0) clause += `, ${String(inline)} inline`;
  clause += ')';
  const trouble = hosted.filter(
    (row) => row.chores.state === 'late' || row.chores.state === 'restarting' || row.chores.state === 'stopped',
  );
  if (trouble.length > 0) {
    const named = trouble.map((row) => {
      const details = [row.chores.why === null || row.chores.why === '' ? 'no reason recorded' : row.chores.why];
      const last = row.chores.lastChore;
      if (last !== null) details.push(`last ${last.name}${choreAge(last.at, at)}`);
      const cache = row.chores.markerCache;
      if (row.chores.state === 'late' && cache !== null) {
        details.push(
          `marker cache ${String(cache.read)} read, ${String(cache.reused)} reused, ${String(cache.cached)} held`,
        );
      }
      return `${row.root}: ${row.chores.state} (${details.join('; ')})`;
    });
    clause += `; ${named.join('; ')}`;
  }
  return [clause];
}

/** ` 12s ago` when both instants order, empty when either does not. */
function choreAge(choreAt: string, at: string): string {
  const now = new Date(at);
  if (Number.isNaN(now.getTime()) || Number.isNaN(new Date(choreAt).getTime())) return '';
  return ` ${formatRelativeTime(choreAt, now)}`;
}

/** How long an endpoint has been failing, measured against this reading's own instant. Empty
 *  when the record did not keep the failure instant or the reading cannot order the two. */
export function failureAge(failedAt: string | null | undefined, at: string): string {
  if (typeof failedAt !== 'string' || failedAt === '') return '';
  const ageMs = Date.parse(at) - Date.parse(failedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  return `, failing for ${durationPhrase(ageMs)}`;
}

function durationPhrase(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/**
 * A failed endpoint as the check and status list carry it: one row per failed endpoint, naming
 * the checkout, its reason and its age, with the owner's repair. A daemon that is not running is
 * not this difference — status already says it is absent, and check treats absence as ordinary.
 * The rows are differences, so both commands count them and status exits non-zero for them.
 */
export function daemonDifferences(health: DaemonHealth | null, now: Date): Difference[] {
  if (health === null || health.state !== 'running') return [];
  const at = now.toISOString();
  const rows: Difference[] = [];
  for (const root of health.roots) {
    if (root.send === 'failed') {
      rows.push({
        what: `machine daemon send endpoint for ${root.root}: ${root.sendWhy ?? root.why ?? 'no reason recorded'}${failureAge(root.sendFailedAt, at)}`,
        repair: 'team daemon install',
        owner: true,
      });
    }
    if (root.bus === 'failed') {
      rows.push({
        what: `machine daemon bus endpoint for ${root.root}: ${root.busWhy ?? root.why ?? 'no reason recorded'}${failureAge(root.busFailedAt, at)}`,
        repair: 'team daemon install',
        owner: true,
      });
    }
  }
  return rows;
}

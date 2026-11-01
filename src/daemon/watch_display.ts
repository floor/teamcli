// The hosted watch each daemon route may carry, said in the one place `team status` and
// `team check` both read. Pure: it takes the same snapshot the daemon health reading produced
// and the moment that reading was taken, so a scene can pin every phase without a socket, a
// daemon or a pane. `phase` and `effects` are kept apart on purpose — a watch can be cycling
// while its outbound effects are closed, and no line here may read as fully enforcing while it
// is blocked.
import type { DaemonHealth } from './health.ts';
import type { HostedWatchState } from '../watch/hosted.ts';
import type { WatchSitting } from '../watch/liveness.ts';
import { formatRelativeTime } from '../output/text.ts';
import type { Difference } from '../status/compare.ts';

type Watched = { root: string; watch: HostedWatchState };

/** Every route the daemon recorded a hosted watch for, in the record's own order. A route with
 *  no `watch` was never started to carry one and says nothing — its silence is not a failure. */
function watched(health: DaemonHealth): Watched[] {
  return health.roots.flatMap((entry) =>
    entry.watch === undefined ? [] : [{ root: entry.root, watch: entry.watch }],
  );
}

/**
 * The lines `team status` prints for the watches the daemon carries: one phase line per watched
 * route, plus the effects line when the outbound gate is closed. Status is the reading surface,
 * so every phase is said, including a watch that is simply cycling.
 */
export function hostedWatchNotes(health: DaemonHealth, now: Date): string[] {
  const entries = watched(health);
  return entries.flatMap((entry) => [
    qualify(watchPhaseLine(entry.watch, health.version), entry, entries.length),
    ...(entry.watch.effects === 'blocked' ? [qualify(BLOCKED_LINE, entry, entries.length)] : []),
  ]);
}

/**
 * What `team check` reads as a difference from the same sitting it read the watch with: a watch
 * the route was started to carry that has stopped or failed, and a running watch whose outbound
 * gate is closed. A pane watch, a healthy cycle, the transient phases and a watch the route never
 * required say nothing here; a standing-down watch never reaches this reader, because the sitting
 * hands it to the pane watch's own reading. The repair is the owner's own install — the same
 * roots, with the watch on — so the gate map, not a word in this file, says who runs it.
 */
export function hostedWatchDifferences(sitting: WatchSitting): Difference[] {
  if (sitting.kind !== 'hosted') return [];
  const { watch } = sitting;
  if ((watch.phase === 'stopped' || watch.phase === 'failed') && watch.required) {
    return [{ what: watchPhaseLine(watch, null), repair: WATCH_REPAIR }];
  }
  if (watch.phase === 'running' && watch.effects === 'blocked') {
    return [{ what: BLOCKED_LINE, repair: WATCH_REPAIR }];
  }
  return [];
}

/** What the check reads for the notes beside those differences: the pane watch the check itself
 *  read for this team's route, and the route whose lines the difference already carries. */
export type HostedWatchCheckReading = {
  /**
   * The route root whose watch `hostedWatchDifferences` already reports: the lines the difference
   * carries — the phase line and the blocked gate, implied by a watch that is not running — are
   * not said again as notes. Every other route in the reading keeps its line.
   */
  differing?: string;
  /**
   * The pane watch the check read for this team's route. A standing-by hosted watch was told a
   * live pane watch owns the session; when that pane watch is now dead or stale, the pane note
   * names the repair and this line would claim a live watch that is not there.
   */
  ownPane?: { route: string; live: boolean };
};

/**
 * The same reading for `team check`: notes only, and only something worth acting on. A watch
 * cycling with no failure is the healthy case and says nothing; a stopped or failed watch says
 * so only when the route was started to carry one (the record's `required`), a standing-down
 * watch names the pane watch that owns the session, and a closed outbound gate says it is not
 * enforcing anything. A difference already carries its route's lines; the failed-cycle line is
 * no difference and is always kept.
 */
export function hostedWatchCheckNotes(
  health: DaemonHealth,
  now: Date,
  reading: HostedWatchCheckReading = {},
): string[] {
  const entries = watched(health);
  return entries.flatMap((entry) => {
    const lines: string[] = [];
    const { watch } = entry;
    const differing = reading.differing !== undefined && entry.root === reading.differing;
    if (watch.phase === 'standby') {
      const stoodDownForThisRoute = reading.ownPane !== undefined && entry.root === reading.ownPane.route;
      if (!stoodDownForThisRoute || reading.ownPane!.live) lines.push(watchPhaseLine(watch, health.version));
    } else if ((watch.phase === 'stopped' || watch.phase === 'failed') && watch.required) {
      if (!differing) lines.push(watchPhaseLine(watch, health.version));
    } else if (watch.phase === 'running' && watch.lastCycleOutcome === 'failed') {
      const at = watch.lastCycleAt === null ? '' : ` ${formatRelativeTime(watch.lastCycleAt, now)}`;
      lines.push(`watch: the last cycle failed${at}`);
    }
    if (watch.effects === 'blocked' && !differing) lines.push(BLOCKED_LINE);
    return lines.map((line) => qualify(line, entry, entries.length));
  });
}

/**
 * The check's reading of a pane watch, from the same sitting `up` plans from. Only something
 * worth acting on is said: a healthy watch is silent, as a healthy hosted one is; a dead or
 * stale record names the repair the next `up` makes; and a missing one is named only when the
 * daemon reading proves no hosted watch owns the route. A hosted watch is the hosted lines' own,
 * and a session that is not running has no watch to expect — both stay silent here.
 */
export function paneWatchCheckNotes(
  sitting: WatchSitting,
  options: { known: boolean; running: boolean },
): string[] {
  if (sitting.kind === 'hosted' || !options.running) return [];
  const { health } = sitting;
  if (health.state === 'live') return [];
  // With no daemon reading to prove the route is free, `up` deliberately starts nothing; the
  // note says what is wrong and names that limit rather than promising a repair it will not make.
  const start = options.known ? 'the next team up starts one' : 'the daemon health cannot say whether a hosted watch owns the route';
  const replace = options.known ? 'the next team up replaces it' : 'the daemon health cannot say whether a hosted watch owns the route';
  if (health.state === 'dead') {
    return [`watch: the recorded process ${health.pid} is gone; ${start}`];
  }
  if (health.state === 'stale') {
    if (health.why === 'no-process') {
      return [`watch: recorded with no process or pane; ${start}`];
    }
    const beat = health.why === 'heartbeat-old' ? 'old' : 'unreadable';
    return [
      health.pid === null
        ? `watch: its heartbeat is ${beat}; ${start}`
        : `watch: process ${health.pid} is alive but its heartbeat is ${beat}; ${replace}`,
    ];
  }
  if (!options.known) return [];
  return ['watch: none running; the next team up starts one'];
}

/** One watched route's phase. A running watch names the instant it started in this daemon and
 *  the build the daemon reports: an install that changed the package's version or packaged
 *  commit is a restart of the daemon, and the line says which identity is cycling. A watch that
 *  has not completed a pass yet still says it is running — `starting` is the host's own state
 *  for a loop that has not reached its first pass, and that state is said separately. */
function watchPhaseLine(watch: HostedWatchState, version: string | null): string {
  if (watch.phase === 'standby') {
    const why = watch.why === null || watch.why === '' ? '' : ` (${watch.why})`;
    return `watch: standing by; a live pane watch owns this session${why}`;
  }
  if (watch.phase === 'starting') return 'watch: starting in the daemon, not yet cycled';
  if (watch.phase === 'running') {
    return `watch: running in the daemon since ${watch.startedAt}, version ${version ?? 'unknown'}`;
  }
  if (watch.phase === 'stopping') return 'watch: stopping in the daemon';
  if (watch.phase === 'stopped') return `watch: stopped in the daemon (${reason(watch.why)})`;
  return `watch: failed in the daemon (${reason(watch.why)})`;
}

function reason(why: string | null): string {
  return why === null || why === '' ? 'no reason recorded' : why;
}

/** With more than one watched route a line names its own route, so a failed route still reads
 *  beside a good one; with one, the line stays the plain one the reader expects. */
function qualify(line: string, entry: Watched, count: number): string {
  return count > 1 ? `${line} (${entry.root})` : line;
}

const BLOCKED_LINE = 'watch: outbound effects blocked; it is not enforcing anything';

/** The one repair for a watch that is not enforcing: the owner's own install of the daemon, with
 *  the roots and the watch exactly as they were. The gate map reads `daemon` from it. */
const WATCH_REPAIR = 'team daemon install with the same roots and --watch';

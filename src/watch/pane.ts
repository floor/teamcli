import { paneProcesses, workspaceList, workspacePanes, type PaneProcesses } from '../herdr.ts';
import { emptySession, readState, updateState } from '../state.ts';
import { isWatchEpoch } from './epoch.ts';

export type WatchPlace = { pane: string; workspace: string };

/** The label of the workspace a watch runs in. One per team, so `team status` and the checks can
 *  tell the watch's own workspace from a seat's, which a display label may repeat. */
export function watchLabel(project: string): string {
  return `Watch · ${project}`;
}

/** The event bus's workspace label for a team, beside the watch's. */
export function busLabel(project: string): string {
  return `Bus · ${project}`;
}

/** A recorded watch's health, from the record and the process table alone. `live` carries a
 *  process that is alive with a heartbeat no older than two in-force intervals, or — before its
 *  pane's first pass records a pid — a pane with a fresh beat. `dead` is a recorded pid that is
 *  not alive. `stale` is a live process whose heartbeat is old or unreadable, or a record with
 *  neither a pid nor a pane to say what runs. `missing` is no record at all. */
export type PaneWatchHealth =
  | { state: 'missing' }
  | { state: 'live'; pid: number | null; heartbeat: string; pane?: string; workspace?: string }
  | { state: 'dead'; pid: number; heartbeat: string | null; pane?: string; workspace?: string }
  | {
      state: 'stale';
      why: 'heartbeat-old' | 'unreadable' | 'no-process';
      pid: number | null;
      heartbeat: string | null;
      pane?: string;
      workspace?: string;
    };

export function paneWatchHealth(
  watch: { pid?: number; heartbeat: string; pane?: string; workspace?: string } | undefined,
  options: { alive(pid: number): boolean; now: number; interval: number },
): PaneWatchHealth {
  if (!watch) return { state: 'missing' };
  const beat = Date.parse(watch.heartbeat);
  const fresh = Number.isFinite(beat) && options.now - beat <= 2 * options.interval * 1000;
  const place = {
    ...(watch.pane ? { pane: watch.pane } : {}),
    ...(watch.workspace ? { workspace: watch.workspace } : {}),
  };
  const heartbeat = Number.isFinite(beat) ? watch.heartbeat : null;
  if (watch.pid !== undefined) {
    if (!options.alive(watch.pid)) return { state: 'dead', pid: watch.pid, heartbeat, ...place };
    if (fresh) return { state: 'live', pid: watch.pid, heartbeat: watch.heartbeat, ...place };
    return {
      state: 'stale',
      why: Number.isFinite(beat) ? 'heartbeat-old' : 'unreadable',
      pid: watch.pid,
      heartbeat,
      ...place,
    };
  }
  // Before the pane's first pass records a pid, its place and beat are the only proof a watch
  // was placed. Without a place there is nothing a reader could repair by pid.
  if (!watch.pane) return { state: 'stale', why: 'no-process', pid: null, heartbeat };
  if (fresh) return { state: 'live', pid: null, heartbeat: watch.heartbeat, ...place };
  return {
    state: 'stale',
    why: Number.isFinite(beat) ? 'heartbeat-old' : 'unreadable',
    pid: null,
    heartbeat,
    ...place,
  };
}

/** Whether a recorded pid is still the watch it claims to be: the process in the pane the watch
 *  itself recorded, read through the pane's own process list. A live pid behind an old heartbeat
 *  cannot tell the watch from a reused pid; a record with no pane, a pane that cannot be read, or
 *  a pane whose process is another one is `unproven`, and nothing may be signalled on it. A pid
 *  that is no longer alive is `gone`: there is nothing to stop before its replacement. */
export type WatchIdentity =
  | { kind: 'verified'; pid: number; pane: string }
  | { kind: 'gone' }
  | { kind: 'unproven'; why: string };

export function watchIdentity(
  watch: { pid: number; pane?: string },
  options: { alive(pid: number): boolean; processInfo(pane: string): PaneProcesses | null },
): WatchIdentity {
  if (!options.alive(watch.pid)) return { kind: 'gone' };
  if (!watch.pane) return { kind: 'unproven', why: `pid ${watch.pid} is recorded with no pane` };
  const info = options.processInfo(watch.pane);
  if (info === null) {
    return { kind: 'unproven', why: `pid ${watch.pid} is recorded in pane ${watch.pane}, which cannot be read` };
  }
  if (info.foreground.includes(watch.pid) || info.shell === watch.pid) {
    return { kind: 'verified', pid: watch.pid, pane: watch.pane };
  }
  return { kind: 'unproven', why: `pid ${watch.pid} is not the process in its recorded pane ${watch.pane}` };
}

/** The hand-over guard's question: whether a recorded watch still holds its pane. It stays
 *  deliberate about a pid — a live process counts even when its heartbeat is old, because another
 *  `team watch` must not hand over to a pane that is still writing there. `paneWatchHealth` is
 *  the reading `up` and `check` use when they decide whether to repair. */
export function watchRunning(
  watch: { pid?: number; heartbeat: string; pane?: string } | undefined,
  options: { alive(pid: number): boolean; now: number; interval: number },
): boolean {
  const health = paneWatchHealth(watch, options);
  return health.state === 'live' || (health.state === 'stale' && health.pid !== null);
}

/** The pane this process is running in, from herdr. The shell that `pane run` typed into is
 *  this process's parent; the foreground pid is this process once the command is up. A hand-run
 *  watch matches neither and comes back `'gone'`. Null means herdr could not say, which is not
 *  a missing pane. */
export function ownWatchPane(session: string, pid: number): WatchPlace | 'gone' | null {
  const aim = session === 'default' ? undefined : session;
  const workspaces = workspaceList(aim);
  if (workspaces === null) return null;
  const parent = process.ppid;
  let unreadable = false;
  for (const workspace of workspaces) {
    const panes = workspacePanes(workspace.id, aim);
    if (panes === null) {
      unreadable = true;
      continue;
    }
    for (const pane of panes) {
      const info = paneProcesses(pane, aim);
      if (!info) {
        unreadable = true;
        continue;
      }
      if (info.foreground.includes(pid) || info.shell === pid || info.shell === parent) {
        return { pane, workspace: workspace.id };
      }
    }
  }
  return unreadable ? null : 'gone';
}

/** Where this pass's heartbeat should record the process. `'end'` is a pane this pid already
 *  recorded and herdr no longer has, on this pass alone. The watch ends only when the next pass
 *  says `'end'` again. A watch that never recorded one — started by hand — keeps going, and so
 *  does a pass where herdr cannot say. */
export function placedWatch(
  dir: string,
  session: string,
  pid: number,
  ownPane: ((session: string, pid: number) => WatchPlace | 'gone' | null) | undefined,
): WatchPlace | 'end' | 'keep' {
  if (!ownPane) return 'keep';
  const found = ownPane(session, pid);
  if (!found || found === 'gone') {
    if (found !== 'gone') return 'keep';
    const prior = readState(dir).sessions[session]?.watch;
    return prior?.pid === pid && prior.pane ? 'end' : 'keep';
  }
  return found;
}

/** The heartbeat. A place found this pass is recorded. `'keep'` leaves a pane this same pid
 *  already recorded, and writes none for a watch that has not seen itself in one. A pane beat
 *  carries no epoch, so it leaves any record holding a well-formed epoch untouched — the same
 *  pid included: only `renewWatchAuthority` with the captured epoch and pid writes a fenced
 *  heartbeat. An ordinary epochless pane record beats as before. */
export function beatWatch(
  dir: string,
  session: string,
  pid: number,
  heartbeat: string,
  place: WatchPlace | 'keep',
): void {
  updateState(dir, (state) => {
    const record = (state.sessions[session] ??= emptySession());
    const prior = record.watch;
    if (prior && isWatchEpoch(prior.epoch)) return;
    // `'keep'` preserves the pane this same pid recorded — or, on the first pass, the pane the
    // hand-over recorded with no pid yet: herdr not naming the watch's own pane must not erase
    // where the watch is known to run.
    const kept = place === 'keep'
      ? (prior && (prior.pid === pid || prior.pid === undefined) && prior.pane
        ? { pane: prior.pane, ...(prior.workspace ? { workspace: prior.workspace } : {}) }
        : undefined)
      : place;
    record.watch = {
      pid,
      heartbeat,
      ...(kept?.pane ? { pane: kept.pane } : {}),
      ...(kept?.workspace ? { workspace: kept.workspace } : {}),
    };
  });
}

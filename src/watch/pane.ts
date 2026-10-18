import { paneProcesses, workspaceList, workspacePanes } from '../herdr.ts';
import { emptySession, readState, updateState } from '../state.ts';

export type WatchPlace = { pane: string; workspace: string };

/** The label of the workspace a watch runs in. One per team, so `team status` and the checks can
 *  tell the watch's own workspace from a seat's, which a display label may repeat. */
export function watchLabel(project: string): string {
  return `Watch · ${project}`;
}

/** Whether a recorded watch is still running: the pid while that process lives, or — for the
 *  moment before its pane's first pass records a pid, and for a record whose process is gone — a
 *  pane whose heartbeat is no older than two in-force intervals. A record with neither is no
 *  watch. */
export function watchRunning(
  watch: { pid?: number; heartbeat: string; pane?: string } | undefined,
  options: { alive(pid: number): boolean; now: number; interval: number },
): boolean {
  if (!watch) return false;
  if (watch.pid !== undefined) return options.alive(watch.pid);
  if (!watch.pane) return false;
  const beat = Date.parse(watch.heartbeat);
  return Number.isFinite(beat) && options.now - beat <= 2 * options.interval * 1000;
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
 *  already recorded, and writes none for a watch that has not seen itself in one. */
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

// The hosted watch's arrival wake: a stamped message landing for a Claude Code seat whose channel
// is not proven starts the watch's next pass now, not at the end of its interval.
//
// On an active root an unproven Claude seat is reached by the adapter's typed pointer, which the
// watch's unread pass types (src/watch/unread.ts). That pass ran only on the watch's interval
// (120 s by default), so a message waited up to the whole interval for its pointer. The wake is
// an event: one recursive folder watch on the root's stamped tree for the session. It only ends
// the current wait early; the pass it starts runs every typed-key check it always runs (the pane
// proof before every key, the idle screen, protected panes, the wake gate and its one pointer per
// attempt). Nothing is typed here. A seat whose channel is proven is left to its channel push,
// and a seat of any other CLI keeps its own window: neither wakes the watch.
import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import { seatDropDir, sessionMailDir } from '../queue/mail-tree.ts';
import { channelUnproven } from '../queue/resend.ts';
import { messageKeyState } from '../store/keys.ts';

/** At most one wake in this window; one that lands inside it is carried to its end. */
export const ARRIVAL_WAKE_MIN_MS = 5_000;

/** How often a tree that cannot be watched yet (a root not activated) is tried again. */
export const ARRIVAL_REARM_MS = 30_000;

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ArrivalWakeInput = {
  root: string;
  session: string;
  home: string;
  /** Ends the hosted loop's current wait now (`HostedLoop.nudge`). */
  nudge: () => void;
  now?: () => number;
  /** Test seam: the folder watch. */
  watchFolder?: (folder: string, onName: (name: string) => void, onError: () => void) => { close(): void } | null;
  /** Test seam: how long before an unwatchable tree is tried again. */
  rearmMs?: number;
};

function realWatchFolder(folder: string, onName: (name: string) => void, onError: () => void): { close(): void } | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(folder, { recursive: true }, (_event, name) => {
      if (typeof name === 'string' && name !== '') onName(name);
    });
  } catch {
    return null;
  }
  watcher.on('error', () => {
    try { watcher.close(); } catch { /* already closed */ }
    onError();
  });
  return { close: () => { try { watcher.close(); } catch { /* already closed */ } } };
}

/** Whether a stamped arrival for `seat` should wake the watch: a running Claude Code seat whose
 *  channel is not proven now. Every unknown reads as no wake: the interval pass still runs. */
export function arrivalWakes(root: string, session: string, home: string, seat: string, nowMs: number): boolean {
  try {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok || loaded.team.session !== session) return false;
    const declared = loaded.team.seats.find((one) => one.name === seat);
    if (declared === undefined || declared.cli !== 'claude-code' || declared.stopped || declared.human === true || declared.webhook !== undefined) return false;
    const key = messageKeyState(home);
    if (key.kind !== 'key') return false;
    const lead = loaded.team.orchestrator;
    return channelUnproven({
      dropDir: seatDropDir(loaded.root, session, seat), root: loaded.root, session, seat,
      context: { to: seat, root: loaded.root, session, ...(lead === undefined || lead === null || lead === '' ? {} : { lead }) },
      key: key.key, nowMs,
    }) !== null;
  } catch {
    return false;
  }
}

/**
 * Starts the arrival wake for one hosted route and returns its close. A stamped tree that cannot
 * be watched yet (a dark root has none) is tried again every `ARRIVAL_REARM_MS`; until then the
 * interval pass is the only cadence, as before. A record name under `<seat>/` is the only event
 * read; a sidecar, a marker or a history entry is not an arrival.
 */
export function startArrivalWake(input: ArrivalWakeInput): () => void {
  const now = input.now ?? (() => Date.now());
  const folder = sessionMailDir(input.root, input.session, 'stamped');
  let last = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const fire = (): void => {
    if (closed) return;
    last = now();
    input.nudge();
  };
  const onName = (name: string): void => {
    const parts = name.split(sep).join('/').split('/');
    if (parts.length !== 2) return;
    const [seat, id] = parts as [string, string];
    if (!RECORD_ID.test(id)) return;
    if (!arrivalWakes(input.root, input.session, input.home, seat, now())) return;
    const wait = last + ARRIVAL_WAKE_MIN_MS - now();
    if (wait <= 0) {
      fire();
      return;
    }
    if (trailing === null) trailing = setTimeout(() => { trailing = null; fire(); }, wait);
  };
  let watcher: { close(): void } | null = null;
  let rearm: ReturnType<typeof setInterval> | null = null;
  // Since when an arrival may have gone unseen: the start, or the moment the watch went down.
  let unseenSince = now();
  const startRearm = (): void => {
    if (closed || rearm !== null) return;
    rearm = setInterval(arm, input.rearmMs ?? ARRIVAL_REARM_MS);
    (rearm as { unref?: () => void }).unref?.();
  };
  // A watch that errors is down: it is dropped, and armed again on the retry cadence.
  const onError = (): void => {
    watcher = null;
    unseenSince = Math.min(unseenSince, now());
    startRearm();
  };
  // Records that landed while no watch stood (the tree made by its first record, a watch that
  // errored) are read once on attach, so the first one does not wait for the interval pass.
  const catchUp = (since: number): void => {
    let seats: string[];
    try {
      seats = readdirSync(folder);
    } catch {
      return;
    }
    for (const seat of seats) {
      if (seat.startsWith('.')) continue;
      let names: string[];
      try {
        names = readdirSync(join(folder, seat));
      } catch {
        continue;
      }
      for (const id of names) {
        if (!RECORD_ID.test(id)) continue;
        try {
          if (lstatSync(join(folder, seat, id)).mtimeMs < since - 1_000) continue;
        } catch {
          continue;
        }
        onName(`${seat}/${id}`);
      }
    }
  };
  function arm(): void {
    if (closed || watcher !== null) return;
    const since = unseenSince;
    watcher = (input.watchFolder ?? realWatchFolder)(join(folder), onName, onError);
    if (watcher === null) {
      startRearm();
      return;
    }
    if (rearm !== null) {
      clearInterval(rearm);
      rearm = null;
    }
    unseenSince = Number.POSITIVE_INFINITY;
    catchUp(since);
  }
  arm();
  return () => {
    closed = true;
    if (trailing !== null) clearTimeout(trailing);
    if (rearm !== null) clearInterval(rearm);
    (watcher as { close(): void } | null)?.close();
  };
}

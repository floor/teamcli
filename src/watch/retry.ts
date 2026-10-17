// Delivering the drops a held send left behind, once the seat is free.
//
// The watch is the only long-lived reader with a live view of every seat, so it is where a held
// send's retry belongs: one pass looks again, and a composer that was holding the owner's draft
// is empty a pass later. A retry is the send's own delivery — the same `deliverTrigger`, the same
// verification — with one addition: a box already holding exactly the trigger is submitted, never
// typed over, because the marker beside the drop says whose line it is.
//
// Every retry is bounded (`PENDING_MAX_TRIES` typed tries, `PENDING_MAX_AGE_MS` from the held
// send) and reported when it stops: the word is the drop's path, so the message is never lost
// silently even though the sender's own command has already exited.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TeamFile } from '../file/types.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import {
  clearPending,
  PENDING_MAX_AGE_MS,
  PENDING_MAX_TRIES,
  readPending,
  recordPendingTry,
  type PendingDrop,
} from '../send/pending.ts';
import { deliverTrigger, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { triggerLine } from '../send/native.ts';
import type { Live } from '../status/compare.ts';
import { readScreen } from './screen.ts';

/** What a retry reads and types through: the watch's own sources, narrowed to the pane calls. */
export type RetrySources = {
  screen(pane: string, session: string): string | null;
  status(pane: string, session: string): string | null;
  typeText(pane: string, text: string, session: string): boolean;
  pressEnter(pane: string, session: string): boolean;
  sleep(ms: number): Promise<void>;
};

export type RetryScene = {
  dir: string;
  session: string;
  root: string;
  /** The home whose store holds the history; absent, a retry is still delivered but not filed. */
  home?: string;
  team: TeamFile;
  live: Live;
  /** The watch's own pane: never typed into. */
  ownPane: string | null;
  sources: RetrySources;
  now: Date;
  say(text: string, desktop: boolean): void;
};

/** The drop's words, minus the trigger line: one sentence for the watch's log. */
function heldWords(drop: PendingDrop): string {
  return `a held send from ${drop.from}`;
}

/** The drop is out of retries: forget the marker and say where the message is, so it can be
 *  delivered by hand or sent again. A drop whose file is gone has nothing left to name. */
function giveUp(scene: RetryScene, dropDir: string, drop: PendingDrop, why: string, dropGone = false): void {
  clearPending(dropDir, drop.id);
  const tail = dropGone ? 'send it again' : `the drop file is at ${join(dropDir, drop.id)}; send it again`;
  scene.say(`${drop.to}: ${heldWords(drop)} was not delivered (${why}); ${tail}`, true);
}

/** The watch's sources as the delivery sees one pane. */
function hostOf(scene: RetryScene, pane: string): DeliverHost {
  return {
    typeText: (id, text) => scene.sources.typeText(id, text, scene.session),
    pressEnter: (id) => scene.sources.pressEnter(id, scene.session),
    status: (id) => scene.sources.status(id, scene.session),
    wait: (ms) => scene.sources.sleep(ms),
    readAnsi: (id) => scene.sources.screen(id, scene.session),
  };
}

/**
 * One held drop, when its seat is free. The screen is read first, and a dialog, another's draft,
 * or a status that is not idle/done ends the pass here — the box is never typed blind. The seat
 * lock is taken for the delivery, so a second watch and a `team send` cannot type into one pane
 * at once, then the box is read again by the delivery itself, which is the final guard.
 */
async function retryOne(scene: RetryScene, cli: string, pane: string, dropDir: string, drop: PendingDrop): Promise<void> {
  // The marker is only a convenience; the drop file is the message. A record left behind a drop
  // that was moved or removed has nothing to tell the seat, so it is given up on, not typed.
  if (!existsSync(join(dropDir, drop.id))) {
    giveUp(scene, dropDir, drop, `its drop file is gone from ${dropDir}`, true);
    return;
  }
  const line = triggerLine(join(dropDir, drop.id));
  if (line === null) {
    giveUp(scene, dropDir, drop, 'its trigger line would not fit in a pane');
    return;
  }
  const status = scene.sources.status(pane, scene.session);
  const screen = scene.sources.screen(pane, scene.session);
  // A box that cannot be read is not typed into: a retry exists to avoid the lost message, not to
  // add a second one. The age bound ends a marker left behind a pane that never reads again.
  if (screen === null || (status !== 'idle' && status !== 'done')) return;
  const kind = readScreen(cli, screen).kind;
  const ownLine = kind === 'unsent' && boxHoldsText(cli, line, screen);
  // A dialog, or unsent text that is not the trigger: the seat is not free, and the text is not
  // ours to clear or type over.
  if (kind !== 'idle' && !ownLine) return;

  const lock = acquireSeatLock(scene.dir, scene.session, drop.to);
  if (!('release' in lock)) return;
  try {
    const result = await deliverTrigger(hostOf(scene, pane), pane, line, cli, { submitHeld: true });
    if (result.outcome === 'delivered') {
      clearPending(dropDir, drop.id);
      if (scene.home !== undefined) {
        appendHistory(scene.team.project, scene.root, scene.home, {
          ts: scene.now.toISOString(),
          from: drop.from,
          to: drop.to,
          body: drop.body,
          id: drop.id,
          outcome: 'delivered',
          via: 'typed',
        });
      }
      scene.say(`${drop.to}: ${heldWords(drop)} was delivered on retry`, false);
      return;
    }
    if (result.outcome === 'not-submitted') {
      if (drop.tries + 1 >= PENDING_MAX_TRIES) {
        giveUp(scene, dropDir, drop, `the seat did not take it in ${PENDING_MAX_TRIES} tries`);
        return;
      }
      recordPendingTry(dropDir, drop);
      return;
    }
    // `held` (the box filled between the reads) typed no line of its own, and `unreachable` (a
    // dialog, an unreadable status) reached nothing: neither spends a try. The next pass looks
    // again, and the age bound is what ends a pane that never frees.
  } finally {
    lock.release();
  }
}

/**
 * Retries the held drops of every seat this team has a live pane for: the oldest drop of each
 * seat, at most one per seat per pass, so a seat is never sent two messages at once.
 */
export async function retryHeldDrops(scene: RetryScene): Promise<void> {
  for (const seat of scene.team.seats) {
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    const drops = readPending(dropDir);
    if (drops.length === 0) continue;
    // The age bound is applied before the pane is looked for: a seat that vanished leaves no
    // pane to retry, and its marker must not sit in the store forever.
    const now = scene.now.getTime();
    const live: PendingDrop[] = [];
    for (const drop of drops) {
      if (now - Date.parse(drop.ts) <= PENDING_MAX_AGE_MS) {
        live.push(drop);
        continue;
      }
      giveUp(scene, dropDir, drop, 'the retry window passed');
    }
    const agents = scene.live.agents.filter((agent) => agent.name === seat.name);
    const pane = agents.length === 1 ? agents[0]?.pane : undefined;
    if (pane === undefined || pane === scene.ownPane) continue;
    const drop = live[0];
    if (drop !== undefined) await retryOne(scene, seat.cli, pane, dropDir, drop);
  }
}

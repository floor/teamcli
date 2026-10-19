// Confirming the sends a seat took without showing it, and the one word when it never acted.
//
// A send whose box cleared with no status or transcript evidence is `sent (unconfirmed)` with the
// note `trigger taken, no read receipt yet`, and leaves a marker beside its drop. The watch is the
// one reader with a live view of every seat, so its later passes look for the sign the send's own
// window missed: a transcript row naming the drop, or a status that moved from the one read before
// Enter. The marker goes once either is seen. A seat that sits free past the grace with no sign,
// or a record the age bound runs out on, is the last case: the sender is told the line was taken
// but never acted on, one history line keeps it, and the line is still never typed again.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { showsDrop } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { sawSubmission, triggerLine } from '../send/native.ts';
import {
  clearTaken,
  NEVER_ACTED_ON,
  readTaken,
  TAKEN_IDLE_GRACE_MS,
  TAKEN_MAX_AGE_MS,
  type TakenDrop,
} from '../send/taken.ts';
import type { RetryScene } from './retry.ts';

/** The two statuses a free seat reads: past the grace, a taken line it never showed is gone. */
const FREE = new Set(['idle', 'done']);

/** One taken drop, looked at on this pass. Confirmed on the first sign; reported once the window
 *  passes with none. Nothing here ever types: a taken line is never submitted again. */
function confirmOne(scene: RetryScene, pane: string | undefined, dropDir: string, drop: TakenDrop): void {
  const age = scene.now.getTime() - Date.parse(drop.ts);
  if (pane !== undefined) {
    const screen = scene.sources.screen(pane, scene.session);
    const status = scene.sources.status(pane, scene.session);
    const line = triggerLine(join(dropDir, drop.id));
    // The transcript's sign: a row that names the drop's id and is not the trigger's own echo. The
    // trigger line may be unreadable (a path too long to have been typed); the status still counts.
    if (screen !== null && line !== null && showsDrop(screen, line)) {
      clearTaken(dropDir, drop.id);
      return;
    }
    // herdr's status moving from the one read before Enter is the other sign: the seat is working,
    // or it reached a done/blocked that is not where it stood.
    if (status !== null && sawSubmission(drop.before, [status])) {
      clearTaken(dropDir, drop.id);
      return;
    }
    if (!(FREE.has(status ?? '') && age >= TAKEN_IDLE_GRACE_MS) && age <= TAKEN_MAX_AGE_MS) return;
  } else if (age <= TAKEN_MAX_AGE_MS) {
    // No pane at the seat this pass: there is no sign to read yet, and the record keeps for a
    // later pass — until the age bound runs out, which is the report below, as for a retry.
    return;
  }
  clearTaken(dropDir, drop.id);
  if (scene.home !== undefined) {
    appendHistory(scene.team.project, scene.root, scene.home, {
      ts: scene.now.toISOString(),
      from: drop.from,
      to: drop.to,
      body: drop.body,
      id: drop.id,
      outcome: 'sent (unconfirmed)',
      note: NEVER_ACTED_ON,
    });
  }
  // The drop is still the message: name the record when it is there, so it can be read by hand
  // or sent again — the one thing this pass never does is type the line.
  const path = join(dropDir, drop.id);
  const tail = existsSync(path) ? `; the record is at ${path}` : '';
  scene.say(`${drop.to}: a send from ${drop.from} was ${NEVER_ACTED_ON}${tail}`, true);
}

/**
 * Confirms the taken deliveries of every seat, and reports the ones the window ran out on. A seat
 * with no readable pane is left for a later pass while its record is inside the age bound: with
 * nothing to read there is no sign either way, and a marker is never guessed at. Past the bound
 * the record is reported and goes, as a retry's does — a seat that went away must not keep a
 * marker in the store forever.
 */
export function confirmTakenDrops(scene: RetryScene): void {
  for (const seat of scene.team.seats) {
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    const drops = readTaken(dropDir);
    if (drops.length === 0) continue;
    const agents = scene.live.agents.filter((agent) => agent.name === seat.name);
    const found = agents.length === 1 ? agents[0]?.pane : undefined;
    const pane = found === scene.ownPane ? undefined : found;
    for (const drop of drops) confirmOne(scene, pane, dropDir, drop);
  }
}

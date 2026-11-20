// The lead's one notice when a seat's screen is one its profile cannot place.
//
// A typed wake never types into a screen it cannot read back (src/send/typed-wake.ts): an
// unrecognised frame refuses, and the message stays in the seat's inbox for the next try. That is
// safe, but it was silent: on 2026-11-20 two vlist Cursor seats sat at a new idle layout for
// hours while every send ended "not delivered: no live route". The first refusal of an episode
// now tells the seat's lead which seat and pane need a capture. The notice carries no screen
// content at all: a pane holds a seat's transcript and drafts, which are never copied into
// another seat's mailbox. One notice per episode: the marker beside the seat's mail is reserved
// before the notice; a delivered wake, or a pass that reads the seat's screen again, ends it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { reserveWake as reserveMarker, releaseWake as releaseMarker } from './wake-marker.ts';
import { mkdirSync, unlinkSync } from '../host/guarded-fs.ts';

/** The episode marker beside the seat's mail folder (dot-named: no listing takes it for mail). */
export function unrecognisedScreenPath(dropDir: string): string {
  return join(dropDir, '.unrecognised-screen');
}

export type UnrecognisedScreenInput = {
  dropDir: string;
  root: string;
  session: string;
  home: string;
  seat: string;
  pane: string;
  /** The seat's lead (the team's orchestrator, else its operator); no notice when there is none,
   *  or when the seat is its own lead. */
  lead: string;
  at: Date;
};

/** The team's lead as its own file at `root` names it: the orchestrator, else the operator;
 *  empty when the file cannot be read or names neither. */
export function leadOfRoot(root: string, home: string): string {
  try {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) return '';
    return loaded.team.orchestrator !== '' ? loaded.team.orchestrator : loaded.team.operator;
  } catch {
    return '';
  }
}

/** The notice's whole text: names only, never anything read off the pane. */
export function unrecognisedScreenText(seat: string, pane: string): string {
  return `${seat} (pane ${pane}): screen not recognised, capture needed. A wake found a screen its profile cannot place, so nothing was typed; the seat's mail waits in its inbox for the next try.`;
}

/** Tells the lead once per episode. True when this call wrote the notice. */
export function noteUnrecognisedScreen(input: UnrecognisedScreenInput): boolean {
  if (input.lead === '' || input.lead === input.seat) return false;
  const marker = unrecognisedScreenPath(input.dropDir);
  if (existsSync(marker)) return false;
  try {
    // A seat that never received mail through its folder has none yet: the marker's place is made.
    mkdirSync(input.dropDir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  const at = input.at.toISOString();
  if (!reserveMarker(marker, { at, state: 'reserved', seat: input.seat, pane: input.pane })) return false;
  const wrote = writeRuntimeMailboxRecord({
    root: input.root,
    home: input.home,
    to: input.lead,
    id: `unrecognised-screen-${input.seat}-${String(input.at.getTime())}`,
    text: unrecognisedScreenText(input.seat, input.pane),
    session: input.session,
    at,
    once: true,
  });
  if (!wrote.ok) {
    releaseMarker(marker);
    return false;
  }
  return true;
}

/** Ends the episode: the seat's screen was read (a delivered wake, or a pass that placed it), so
 *  a later unrecognised frame is a new episode and its lead hears of it again. */
export function clearUnrecognisedScreen(dropDir: string): void {
  try {
    if (existsSync(unrecognisedScreenPath(dropDir))) unlinkSync(unrecognisedScreenPath(dropDir));
  } catch {
    // A marker that cannot be removed only keeps the next episode quiet.
  }
}

/** The episode's start, when one is open: for a reader such as `team doctor`. */
export function unrecognisedScreenSince(dropDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(unrecognisedScreenPath(dropDir), 'utf8')) as { at?: unknown };
    return typeof parsed.at === 'string' ? parsed.at : null;
  } catch {
    return null;
  }
}

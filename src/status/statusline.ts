// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
// Where the profile pins the status row's place (`status_below`), the model is read from that
// row alone — the same line the composer reads, so the two cannot disagree — and a screen that
// shows no such row names no model.
import { stripSgr } from '../ansi.ts';
import { profileFor, statusModelRules, statusOnLine } from '../profiles/profile.ts';
import { screenData, statusRow } from '../watch/screen.ts';

export type Running = { model: string; version: string };

/** The screen names a model, and it is not the file's. Unread is never a difference. */
export function modelDiffers(
  running: Running | null,
  declared: { model: string; version: string },
): running is Running {
  return running !== null && (running.model !== declared.model || running.version !== declared.version);
}

export function runningModel(cli: string, screen: string): Running | null {
  const data = screenData(cli);
  const composer = data?.composer;
  if (data && composer && (composer.mode === 'status-last' || composer.mode === 'status-then-one') && composer.statusBelow) {
    // The row the profile pinned, and nothing else on the pane. A grammar-looking line out of
    // place is ordinary text; a screen without the row names no model.
    const row = statusRow(data, screen);
    if (row === null) return null;
    const hit = statusOnLine(cli, row);
    return hit === 'unreadable' || hit === null ? null : hit;
  }
  let found: Running | null = null;
  // The pane's text may keep its ANSI styling; the model is read from the plain form.
  for (const line of stripSgr(screen).split('\n').slice(-6)) {
    const hit = statusOnLine(cli, line);
    if (hit === 'unreadable') found = null;
    else if (hit) found = hit;
  }
  return found;
}

// The model a seat runs, as far as its screen can say. Claude Code names Claude's families only:
// for a seat that runs another maker's model through it, the line says nothing to compare, so
// the seat is unread rather than wrong.
export function seatModel(seat: { cli: string; model: string }, screen: string | undefined): Running | null {
  if (screen === undefined) return null;
  if (seat.cli === 'claude-code' && !seat.model.startsWith('Claude ')) return null;
  return runningModel(seat.cli, screen);
}

/**
 * Whether the seat's declared model could ever be read off its screen: `seatModel`'s question
 * asked of the model the file declares instead of the text the screen shows. The answer is
 * declared, not derived: each `status_model` rule states, in its `yields` list, the exact model
 * names it can spell, and in its `version_like` the version shapes it can spell them with, and a
 * test on the captured fixtures keeps every declared name and version honest against the real
 * reader, in both directions. Yes when some rule of the seat's profile lists exactly the seat's
 * model and, when the seat has a version, that version matches the rule's `version_like` —
 * nothing is built and no reader is run. A model no list names (another maker's, a made-up
 * family) is not readable, and a rule that declares nothing yields nothing. A seat it answers no
 * to is unread for as long as it runs — `status` prints its model `(unread)` with a note, and the
 * watch never reports a drift for it — so no launch-time finding may claim the running seat
 * checks it.
 */
export function canShowModel(seat: { cli: string; model: string; version?: string }): boolean {
  return statusModelRules(seat.cli).some(
    (rule) =>
      rule.yields.includes(seat.model) &&
      (seat.version === undefined || (rule.versionLike !== null && rule.versionLike.test(seat.version))),
  );
}

/**
 * Whether a seat's model column falls back to the launch line's model, labelled, when its
 * screen names none: the profile says so. A question widget replaces grok's box and hides the
 * footer the model rules read, and the launch line's model still stands there — so its column
 * shows it labelled, where a profile without the fallback keeps `(unread)`.
 */
export function launchModelWhenUnread(cli: string): boolean {
  return profileFor(cli)?.unreadModel === 'launch';
}

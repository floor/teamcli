// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
// Where the profile pins the status row's place (`status_below`), the model is read from that
// row alone — the same line the composer reads, so the two cannot disagree — and a screen that
// shows no such row names no model.
import { stripSgr } from '../ansi.ts';
import { usesLauncher } from '../launch/line.ts';
import { profileFor, statusModelRules, statusOnLine } from '../profiles/profile.ts';
import { screenData, statusRow } from '../watch/screen.ts';

export type Running = { model: string; version: string };

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((word) => word !== '');
}

/** The words of a model name, lowercased and in one set: the order a CLI or a file writes the
 *  name in is display, not identity — agy's footer reads `Gemini 4 Argon`, the profile splits it
 *  into model `Gemini Argon`, version `4`, and a file may write either. The side's own version
 *  words are taken out first, because where the version is spelled inside the model name it is
 *  compared as the version, not as a name word. */
function modelWords(model: string, version: string): Set<string> {
  const name = new Set(words(model));
  for (const word of words(version)) name.delete(word);
  return name;
}

/** The version as the comparison reads it: trimmed, case-insensitive. */
function versionOf(version: string): string {
  return version.trim().toLowerCase();
}

/**
 * The screen names a model, and it is not the file's: its words as a set, plus its version — the
 * same name in another order is not a difference, and neither is the version spelled inside one
 * side's model name, but another word or another version is. Unread is never a difference.
 */
export function modelDiffers(
  running: Running | null,
  declared: { model: string; version: string },
): running is Running {
  if (running === null) return false;
  if (versionOf(running.version) !== versionOf(declared.version)) return true;
  const shown = modelWords(running.model, running.version);
  const file = modelWords(declared.model, declared.version);
  return shown.size !== file.size || [...shown].some((word) => !file.has(word));
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

/** A Claude Code seat declaring a model from another maker. The CLI's own status line names its
 *  own families only, so no reading of it is ever this seat's model. */
export function foreignModelOnClaudeCode(seat: { cli: string; model: string }): boolean {
  return seat.cli === 'claude-code' && !seat.model.startsWith('Claude ');
}

/** A provider wrapper in front of Claude Code: another maker's model, and a launch line whose
 *  first word is not the CLI's own (or one the file marks `model_from: launcher`). Claude Code's
 *  status line prints its own families whatever provider the wrapper selected, so the launcher's
 *  declaration — or the provider id on its banner — is the seat's model. A caller that does not
 *  know the launch line cannot rule the wrapper out. */
export function wrapperSeat(seat: { cli: string; model: string; launch?: string; modelFrom?: 'launcher' }): boolean {
  if (!foreignModelOnClaudeCode(seat)) return false;
  if (seat.modelFrom === 'launcher') return true;
  return seat.launch === undefined || usesLauncher({ cli: seat.cli, launch: seat.launch });
}

/** The id on the launch wrapper's banner line, `<id> · API Usage Billing`, where the pane shows
 *  one. This is a reading for a CLI the profile cannot show a model for. */
export function bannerModel(screen: string | undefined): string | null {
  if (screen === undefined) return null;
  for (const line of stripSgr(screen).split('\n')) {
    const match = /([A-Za-z0-9][A-Za-z0-9._-]*)\s*·\s*API Usage Billing/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/** The wrapper's banner id as the file's two fields: the id's leading words are the model and
 *  the numeric run after them is the version — `glm-5.3` is GLM 5.3, `deepseek-v4` is deepseek
 *  v4. An id with no version-shaped part keeps the declaration's version. */
function bannerRunning(id: string, declared: Running): Running {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part !== '');
  const at = parts.findIndex((part) => /^v?[0-9]+$/.test(part));
  if (at <= 0) return { model: id, version: declared.version };
  return { model: parts.slice(0, at).join(' '), version: parts.slice(at).join('.') };
}

// The model a seat runs, as far as its screen can say. Claude Code names Claude's families only:
// for a seat that runs another maker's model through a provider wrapper, its status line prints
// the CLI's own default whatever the launcher selected, so the launcher's declared model is the
// live one — or the provider's own id where the wrapper prints one on its banner. Another
// maker's model on the CLI's own launch line is unread — the line never names it. A seat whose
// version the caller does not know keeps the unread answer, and every other seat is read off its
// screen.
export function seatModel(
  seat: { cli: string; model: string; version?: string; launch?: string; modelFrom?: 'launcher' },
  screen: string | undefined,
): Running | null {
  if (screen === undefined) return null;
  if (!foreignModelOnClaudeCode(seat)) return runningModel(seat.cli, screen);
  if (!wrapperSeat(seat)) return null;
  if (seat.version === undefined || seat.version === '') return null;
  const declared: Running = { model: seat.model, version: seat.version };
  const banner = bannerModel(screen);
  if (banner === null) return declared;
  const shown = bannerRunning(banner, declared);
  return modelDiffers(shown, declared) ? shown : declared;
}

/** The model a seat runs where the caller must compare like with like — a send's drift hold, the
 *  watch's signed observation, `team check`, an `up` registry comparison. A wrapper is read from
 *  the declaration it signs or launches (or the provider id on its banner); every other seat,
 *  a bare Claude Code launch of another maker's model included, is read off its screen, whose
 *  Claude family is then the contradiction the declared model needs. */
export function signedSeatModel(
  seat: { cli: string; model: string; version: string; launch?: string; modelFrom?: 'launcher' },
  screen: string | undefined,
): Running | null {
  if (wrapperSeat(seat)) return seatModel(seat, screen);
  return screen === undefined ? null : runningModel(seat.cli, screen);
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
 * to is unread as a screen reading for as long as it runs: another maker's model through a
 * provider wrapper is shown from the launcher's declaration (`seatModel`), a seat whose
 * declaration the caller does not know prints `<display> (declared, unread)` with a note, and
 * the watch never reports a drift for it — so no launch-time finding may claim the running seat
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
 * shows it labelled, where a profile without the fallback marks it `(declared, unread)`.
 */
export function launchModelWhenUnread(cli: string): boolean {
  return profileFor(cli)?.unreadModel === 'launch';
}

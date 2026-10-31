// Each CLI shows its model in its own words. The profile's status_model rules turn a pane's
// visible text into the file's two fields, `model` and `version`, or null when the text doesn't
// show them: "unread" is never a mismatch. The last six lines are the window. A line the rules
// claim but cannot name clears an earlier match; that is how an unknown Codex footer stays unread.
// Where the profile pins the status row's place (`status_below`), the model is read from that
// row alone — the same line the composer reads, so the two cannot disagree — and a screen that
// shows no such row names no model.
import { stripSgr } from '../ansi.ts';
import { launchProgram } from '../launch/line.ts';
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
 *  own families only, so no reading of it is ever this seat's model. The family test ignores
 *  case: the file's spelling is not its model's identity, and the version comparisons here
 *  already read case as spelling. */
export function foreignModelOnClaudeCode(seat: { cli: string; model: string }): boolean {
  return seat.cli === 'claude-code' && !/^claude\b/i.test(seat.model.trim());
}

/** Whether a launcher's own name names the declared model: a word of the model that is a name —
 *  not a bare number — appearing as a word of the program (`claude-glm.sh` for GLM, `team-deepseek`
 *  for DeepSeek). That is the launcher's provenance: it is named for the provider whose model it
 *  selects. A generic name (`unknown-wrapper`) names no model, so it proves nothing. */
function launcherNamesModel(program: string, model: string): boolean {
  const named = program.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== '');
  return model
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => word.length >= 3 && /[a-z]/.test(word) && named.includes(word));
}

/** What a launch line proves about the model in the seat's pane: `cli` when it starts the CLI's
 *  own binary — however a path, `env`, or a quoted word spells it — so the screen is the CLI's
 *  own and its family is a contradiction against another maker's declaration; `wrapper` when the
 *  file says the launcher chooses the model (`model_from: launcher`) or the launcher's name
 *  names the declared model; `unknown` when the line is absent or this reader cannot follow it.
 *  Unknown is not proof of anything: it is read as unread, never as a measured match. */
function launchProof(seat: { cli: string; model: string; launch?: string; modelFrom?: 'launcher' }): 'cli' | 'wrapper' | 'unknown' {
  if (seat.modelFrom === 'launcher') return 'wrapper';
  if (seat.launch === undefined || seat.launch.trim() === '') return 'unknown';
  const program = launchProgram(seat.launch);
  if (program === null) return 'unknown';
  const binary = profileFor(seat.cli)?.binary;
  if (binary !== undefined && program === binary) return 'cli';
  return launcherNamesModel(program, seat.model) ? 'wrapper' : 'unknown';
}

/** A provider wrapper in front of Claude Code: another maker's model, and a launch line that
 *  proves a launcher selecting it. Claude Code's status line prints its own families whatever
 *  provider the wrapper selected, so the launcher's declaration — or the provider id on its
 *  banner — is the seat's model. A plain CLI launch and a launch this reader cannot follow are
 *  not wrappers. */
export function wrapperSeat(seat: { cli: string; model: string; launch?: string; modelFrom?: 'launcher' }): boolean {
  return foreignModelOnClaudeCode(seat) && launchProof(seat) === 'wrapper';
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

/** A provider id or a declaration as the comparison's words: lowercased, split where the id uses
 *  its own separators, and a leading `v` before a digit dropped — `v4` and `4` are the same
 *  version word, so `deepseek-v4.1-flash` and DeepSeek Flash V4.1 spell the same model. */
function idWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.replace(/^v(?=[0-9])/, ''));
}

/** Whether the banner id names the declared model. A provider writes the same model its own way —
 *  `glm-5.3` for GLM 5 5.3 (the version's number written inside the model name too),
 *  `deepseek-v4.1-flash` for DeepSeek Flash V4.1 (a variant word after the version), `kimi-k2.5`
 *  for Kimi K2.5 (an alphanumeric version family) — so the id's name and variant words are
 *  compared as a set, the declaration's version words taken out of its model's, while its version
 *  words are compared as the order they are written in: `glm-3.5` names 3.5, not 5.3. An id with
 *  no version part names the family alone (`deepseek-flash`), and is compared with the model's
 *  words. */
function bannerNames(id: string, declared: Running): boolean {
  const shown = idWords(id);
  const version = idWords(declared.version);
  const name = idWords(declared.model).filter((word) => !version.includes(word));
  const sorted = (list: string[]): string => [...list].sort().join(' ');
  // The declaration's version, held as one unbroken run in its own order — wherever in the id the
  // provider wrote it. A run out of order (`glm-3.5` for 5.3) names another version.
  const at = version.length === 0
    ? -1
    : shown.findIndex((_word, index) => version.every((word, offset) => shown[index + offset] === word));
  if (at === -1) {
    // An id naming no version at all names the family alone; one naming a version that is not the
    // declaration's names another model.
    if (shown.some((word) => /[0-9]/.test(word))) return false;
    return sorted(shown) === sorted(name);
  }
  const rest = [...shown.slice(0, at), ...shown.slice(at + version.length)];
  return sorted(rest) === sorted(name);
}

/** The wrapper's banner id as the file's two fields, for the column and drift line of an id that
 *  names another model: the id's leading words are the model and the numeric run after them is the
 *  version — `glm-5.3` is GLM 5.3, `deepseek-v4` is deepseek v4. An id with no version-shaped part
 *  keeps the declaration's version. */
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
// maker's model on the CLI's own launch line is unread — the line never names it — and so is one
// whose launch line this reader cannot follow: only a proven wrapper is shown by its declaration.
// A seat whose version the caller does not know keeps the unread answer, and every other seat is
// read off its screen.
export function seatModel(
  seat: { cli: string; model: string; version?: string; launch?: string; modelFrom?: 'launcher' },
  screen: string | undefined,
): Running | null {
  if (screen === undefined) return null;
  if (!foreignModelOnClaudeCode(seat)) return runningModel(seat.cli, screen);
  if (launchProof(seat) !== 'wrapper') return null;
  if (seat.version === undefined || seat.version === '') return null;
  const declared: Running = { model: seat.model, version: seat.version };
  const banner = bannerModel(screen);
  if (banner === null) return declared;
  // The banner's own spelling is compared with the declaration's, like for like: an id naming the
  // declared model confirms it in its own words, and only an id naming another model is read as
  // one — a provider's separator, variant word or version family is not a drift.
  return bannerNames(banner, declared) ? declared : bannerRunning(banner, declared);
}

/** The model a seat runs where the caller must compare like with like — a send's drift hold, the
 *  watch's signed observation, `team check`, an `up` registry comparison. A wrapper is read from
 *  the declaration it signs or launches (or the provider id on its banner); a plain Claude Code
 *  launch of another maker's model is read off its screen, whose Claude family is then the
 *  contradiction the declared model needs; and a launch line this reader cannot follow leaves
 *  the model unread, never a measured match. */
export function signedSeatModel(
  seat: { cli: string; model: string; version: string; launch?: string; modelFrom?: 'launcher' },
  screen: string | undefined,
): Running | null {
  if (screen === undefined) return null;
  if (!foreignModelOnClaudeCode(seat)) return runningModel(seat.cli, screen);
  const proof = launchProof(seat);
  if (proof === 'wrapper') return seatModel(seat, screen);
  if (proof === 'cli') return runningModel(seat.cli, screen);
  // An unreadable launch line: the model is unread, and unread is never a drift.
  return null;
}

/** The model a seat runs, read with a registry record's own provenance: the record's cli and
 *  launch are the ones the running process was started from, and a team file edited after the
 *  launch cannot prove what it started. The file's `model_from` stands only where the recorded
 *  launch is a line this reader cannot follow — a generic launcher's model is the file's
 *  declaration about the launcher the record names, and nothing else there reads a model. */
export function recordSignedModel(
  seat: { cli: string; model: string; version: string; launch?: string; modelFrom?: 'launcher' },
  record: { cli?: string; launch?: string },
  screen: string | undefined,
): Running | null {
  const cli = record.cli === undefined || record.cli === '' ? seat.cli : record.cli;
  const launch = record.launch === undefined || record.launch === '' ? seat.launch : record.launch;
  const unexplained = launchProof({ cli, model: seat.model, launch }) === 'unknown';
  return signedSeatModel(
    {
      cli,
      model: seat.model,
      version: seat.version,
      ...(launch === undefined ? {} : { launch }),
      ...(unexplained && seat.modelFrom === 'launcher' ? { modelFrom: 'launcher' as const } : {}),
    },
    screen,
  );
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

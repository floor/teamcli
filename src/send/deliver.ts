// Verified delivery of one trigger line into a seat's input box.
//
// `delivered` means the seat began processing the line, not that the line was typed: the box was
// read with its ANSI styling after Enter, the trigger had left it, and herdr reported the seat
// working. A review brief once sat typed and never submitted in a Codex reviewer's box for hours;
// a typed line that nobody submitted must never read as a success.
//
// The box is read the way the rest of the program reads a composer (`readScreen`, `readBox`): a
// greyed suggestion or placeholder is faint (SGR 2), the screen reads it `idle`, and so it counts
// as an empty box — it is never text to wait for, never text to clear, and never a reason for an
// Enter. Only text the CLI drew unstyled is in the box.
import { readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { stripSgr } from '../ansi.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { profileFor, type InputBlock } from '../profiles/profile.ts';
import { classify, classifyComposer, readBox, readFoldMark, readScreen } from '../watch/screen.ts';
import { dropMessage, POLL_MS, SETTLE_MS, sawSubmission, type NativePane } from './native.ts';

/** The most Enters one delivery presses. */
export const MAX_TRIES = 3;

/** How long each try waits for the seat to show the submission: 1s, 3s, then 9s. */
export const BACKOFF_MS: readonly number[] = [1000, 3000, 9000];

/** How long in all a seat whose box has cleared is given to show it took the line. herdr's status
 *  can lag or stay idle while a CLI works (agy does), so a cleared box is waited on past the
 *  tries' own windows. */
export const VERIFY_TOTAL_MS = 20_000;

/** The transcript is read once a second, not at every status poll. */
const TRANSCRIPT_EVERY = Math.ceil(1000 / POLL_MS);

/** The words a `taken` delivery wears, in the history, the sender's line and the watch's log: the
 *  line left the box, and nothing in the window showed the seat acting on it yet. */
export const TAKEN_REASON = 'taken, not yet confirmed';

/** What a delivery needs from the pane: one seat's pane, the session already bound. */
export type DeliverHost = {
  typeText(pane: string, text: string): boolean;
  pressEnter(pane: string): boolean;
  /** herdr's status for the pane, or null when it cannot be read. */
  status(pane: string): string | null;
  wait(ms: number): Promise<void>;
  /** The pane's visible text with its ANSI styling, or null when it cannot be read. Absent means
   *  the box is never looked at: the herdr status alone then verifies a submission. */
  readAnsi?(pane: string): string | null;
  /** One key, spelled as herdr spells it. Absent means the box cannot be cleared: a delivery
   *  that finds unsent text is held untouched, exactly as before this surface existed. */
  sendKey?(pane: string, key: string): boolean;
};

/** What a delivery did with the unsent text it found in the box: it is copied beside the drop
 *  file, cleared, the trigger is typed and submitted, and the text is pasted back. */
export type DraftMove = {
  /** Whether the text was pasted back and read back — its rows, or the CLI's own paste-chip
   *  count. False means the copy is still on disk and the receipt names it. */
  restored: boolean;
  /** Where the text's copy is kept. Absent once a verified restore removed it. */
  copy?: string;
  /** One line about the restore, when it needs one: a CLI that folded the paste into a chip, or
   *  a read-back that did not show the text. Absent on a plain restore. */
  note?: string;
};

/** The receipt a delivery earns, and only `delivered` is a success. */
export type DeliverOutcome = 'delivered' | 'not-submitted' | 'held' | 'unreachable';

export type DeliverResult = {
  outcome: DeliverOutcome;
  /** The text the input box holds, not counting faint text: given with `not-submitted` and `held`
   *  whenever the box could be read. Empty means an empty box. */
  box?: string;
  /** How many Enters were pressed. */
  tries: number;
  /** One line saying why, for a log or a receipt. */
  reason?: string;
  /** What showed the seat took the line, with `delivered`: herdr's status or the transcript — or
   *  `taken`, a line that left the box with no status or transcript evidence inside the window:
   *  taken, not yet confirmed. */
  status?: string;
  evidence?: 'status' | 'transcript' | 'taken';
  /** The status herdr read before Enter, with `taken` when the box cleared: a later reader (the
   *  watch) compares a status against it to confirm the seat acted. */
  prior?: string;
  /** The dialog kind the screen showed, when that is why the seat was not reached. */
  dialog?: string;
  /** The unsent text this delivery found, copied and put back, when the box held any. */
  draft?: DraftMove;
};

/** Binds a session to the pane operations a send already has. */
export function bindPane(native: NativePane, session: string): DeliverHost {
  const paneText = native.paneText;
  const sendKey = native.sendKey;
  return {
    typeText: (pane, text) => native.typeText(session, pane, text),
    pressEnter: (pane) => native.pressEnter(session, pane),
    status: (pane) => native.status(session, pane),
    wait: (ms) => native.wait(ms),
    ...(paneText ? { readAnsi: (pane: string) => paneText(session, pane) } : {}),
    ...(sendKey ? { sendKey: (pane: string, key: string) => sendKey(session, pane, key) } : {}),
  };
}

const DIALOGS = new Set(['question', 'permission', 'trust', 'vendor notice', 'provider error', 'rate limit']);

/** What the held-frame screen reports as its dialog kind: a cross-session frame held for a person
 *  blocks the box, but the screen is the CLI's own frame rather than one of `DIALOGS`. */
const HELD_FRAME_KIND = 'held message';

/** The dialog kind a screen shows, or null. A screen that could not be read is not a dialog. */
export function dialogKind(profile: string, screen: string | null): string | null {
  if (screen === null) return null;
  const kind = classify(profile, screen.split('\n')).kind;
  return DIALOGS.has(kind) ? kind : null;
}

/** The dialog a Claude Code session shows when a cross-session frame arrived while it was busy:
 *  the frame is held for a person to let through, and the input box is blocked until then. */
const HELD_FRAME_DIALOG = 'Held message from another session';

/** Whether a pane's text shows the held-frame dialog. SGR styling is stripped and the frame's
 *  borders and pipes flatten to space with every other whitespace run, so the sentence is found
 *  whole whether it sits on one row or wraps inside the dialog's own frame. */
export function showsHeldFrameDialog(screen: string | null): boolean {
  if (screen === null) return false;
  const flat = stripSgr(screen).replace(/[─-╿|]/g, ' ').replace(/\s+/g, ' ');
  return flat.includes(HELD_FRAME_DIALOG);
}

type Look =
  | { state: 'unread' }
  | { state: 'dialog'; kind: string }
  | { state: 'empty'; screen: string }
  | { state: 'trigger' }
  | { state: 'other'; text: string; screen: string };

/** What the input box holds, against the trigger line. `draft`, once a delivery has pasted an
 *  unsent draft back, is the text it pasted: a box holding exactly that draft has taken the
 *  trigger off — as a verdict it reads like an empty box, while the draft is still the owner's
 *  and still in place. */
function look(host: DeliverHost, pane: string, line: string, profile: string, draft?: string): Look {
  const screen = host.readAnsi?.(pane) ?? null;
  if (screen === null) return { state: 'unread' };
  const read = readScreen(profile, screen);
  // The held-frame dialog is drawn in the composer's place, so a screen that shows it and has no
  // live box to read (kind unknown) is stopped at it. A seat whose own transcript quotes the
  // sentence above a live composer is at its box, not at that dialog: the send goes through.
  if (read.kind === 'unknown' && showsHeldFrameDialog(screen)) {
    return { state: 'dialog', kind: HELD_FRAME_KIND };
  }
  const dialog = dialogKind(profile, screen);
  if (dialog !== null) return { state: 'dialog', kind: dialog };
  // A running turn reads `working` whatever the composer below it holds (the caution stages run
  // before the composer stage), so a working screen is read at its composer too: a draft typed
  // during the turn is unsent text, held like one, never typed over. The composer alone decides,
  // and only when it reads `unsent` does the box count as held; an empty or unreadable box on a
  // working screen is still the box this line goes into.
  const unsent = read.kind === 'unsent' || (read.kind === 'working' && classifyComposer(profile, screen.split('\n')).kind === 'unsent');
  if (!unsent) return { state: 'empty', screen };
  if (boxHoldsText(profile, line, screen)) return { state: 'trigger' };
  const text = boxText(profile, screen);
  if (draft !== undefined && text === draft) return { state: 'empty', screen };
  return { state: 'other', text, screen };
}

function boxText(profile: string, screen: string): string {
  const box = readBox(profile, screen);
  if (box === null) return '';
  const pad = ' '.repeat(box.indent);
  return [box.first, ...box.rows.map((row) => (row.startsWith(pad) ? row.slice(pad.length) : row))].join('\n').trimEnd();
}

/** The drop file a trigger line names (`Read <path> and do that.`), or null for any other line. */
export function dropPathOf(line: string): string | null {
  return /^Read (\S+) and do that\.$/.exec(line)?.[1] ?? null;
}

/** The drop file's id: the last segment of the path the trigger line names, or null for a line
 *  that is not `Read <path> and do that.`. */
export function dropIdOf(line: string): string | null {
  const path = dropPathOf(line);
  if (path === null) return null;
  const id = path.slice(path.lastIndexOf('/') + 1);
  return id === '' ? null : id;
}

/** How many clear passes one delivery sends at most. A pass presses the profile's whole sequence
 *  once and reads the box again; the clear ends the moment the box reads empty. Codex took four
 *  passes for three rows; cursor's word-at-a-time ctrl+u took five. */
export const MAX_CLEAR_PASSES = 24;

/** The wait after one clear pass before the box is read again; after Enter, before the box is
 *  read for the trigger's leaving; and between reads of a pasted draft. */
const CLEAR_SETTLE_MS = 250;
const LEAVE_CHECK_MS = 400;
const RESTORE_POLL_MS = 200;

/** How long a pasted draft is given to read back as its rows. */
export const RESTORE_WAIT_MS = 2000;

/** A CLI's own paste chip — the row that counts the lines it folded a paste into. The folded
 *  text is the CLI's, not drawn on the screen: it can be neither copied row by row nor cleared
 *  with the box's keys, so a box showing one is left untouched. Measured on claude 2.1.303
 *  (capture test/fixtures/claude-code/2.1.289/unsent-paste-ansi.txt: `[Pasted text #2 +7 lines]`). */
const PASTE_CHIP = /\[Pasted text #\d+ \+(\d+) lines?\]/;

/** The line count a paste chip drawn in the box names, or null. */
function chipLinesOf(profile: string, screen: string): number | null {
  const box = readBox(profile, screen);
  if (box === null) return null;
  for (const row of [box.first, ...box.rows]) {
    const found = PASTE_CHIP.exec(stripSgr(row));
    if (found) return Number(found[1]);
  }
  return null;
}

type Capture = { text: string } | { why: string };

/** The unsent text a box holds, as the rows it draws: the row after the prompt, with the box's
 *  own indent stripped — the same row `boxText` reports. Refused for a text with no surface that
 *  can be copied faithfully: a fold marker (the screen shows the CLI's fold, not the text), a
 *  paste chip (the folded lines are the CLI's own), a box that reads unsent but draws no usable
 *  row, and a box drawn over more than one row. The last refusal is the ambiguity a screen
 *  cannot settle: a line the composer word-wraps draws continuation rows at the same indent as
 *  the rows a person's Enters made, so copying the rows would turn a soft wrap into a newline
 *  the person never typed. Such a box is left as it is rather than copied changed. */
function captureBox(profile: string, screen: string): Capture {
  if (readFoldMark(profile, screen)) return { why: 'behind its fold marker' };
  if (chipLinesOf(profile, screen) !== null) return { why: 'behind a paste chip' };
  const box = readBox(profile, screen);
  if (box === null) return { why: 'but its rows could not be read' };
  if (box.rows.length > 0) return { why: 'over more than one drawn row, where a soft wrap cannot be told from a newline' };
  const text = boxText(profile, screen);
  if (text === '') return { why: 'but its rows could not be read' };
  return { text };
}

/** The unsent text a box draws, as its rows; refused where no faithful copy can be made (a fold
 *  marker, a paste chip, or a box whose rows cannot be read). The read `restart` makes before it
 *  closes a pane, so the text can be pasted back into the new one. */
export function captureDraft(profile: string, screen: string): Capture {
  return captureBox(profile, screen);
}

/** Puts a captured draft back with a bracketed paste and reads it back as its rows — or, for a
 *  CLI that folds the paste, as its paste chip's line count. The paste `restart` makes once a
 *  relaunched seat is ready. */
export function pasteDraftBack(
  host: DeliverHost,
  pane: string,
  profile: string,
  text: string,
): Promise<{ ok: boolean; note?: string }> {
  return pasteBack(host, pane, profile, text);
}

/** The copy of an unsent draft, kept beside the drop file it was moved for. Null for a line
 *  that names no drop file: without a place to keep the copy, nothing is cleared. */
export function draftCopyPath(line: string): string | null {
  const path = dropPathOf(line);
  return path === null ? null : `${path}.draft`;
}

/** Keeps `text` beside the drop file: the copy the owner's text cannot be lost from. A copy
 *  already there is reused only when it holds the same text; one holding different text is an
 *  earlier delivery's and is never overwritten. */
function keepDraft(line: string, text: string): { copy: string } | { why: string } {
  const copy = draftCopyPath(line);
  if (copy === null) return { why: 'the line names no drop file to keep the text beside' };
  try {
    if (readFileSync(copy, 'utf8') === text) return { copy };
    return { why: `a different copy already sits at ${copy}` };
  } catch {
    // Absent, or unreadable: the write below is the one that says which.
  }
  try {
    dropMessage(dirname(copy), basename(copy), text);
    return { copy };
  } catch (error) {
    return { why: `the copy could not be written (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Removes the copy once the text is verified back in the box. A copy that will not unlink is
 *  left: the safe side is a copy too many, never one too few. */
function removeCopy(copy: string): void {
  try {
    unlinkSync(copy);
  } catch {
    // Left in place; nothing reads it as a drop (the scan ignores dot-suffixed names).
  }
}

type Cleared =
  | { state: 'empty'; passes: number }
  | { state: 'stuck' | 'spent' | 'unread'; passes: number }
  | { state: 'dialog'; kind: string; passes: number };

/** Empties the box with the profile's keys, one pass at a time, reading the box after each.
 *  A working screen is cleared only with the turn's own measured keys; a CLI that takes no text
 *  mid-turn never reaches here (the caller holds it). Ends on the first empty read; gives up when
 *  two passes running change nothing, at the pass bound, when the screen stops being a box, or
 *  when a key is not taken. */
async function clearBox(
  host: DeliverHost,
  pane: string,
  line: string,
  profile: string,
  input: InputBlock,
  working: boolean,
): Promise<Cleared> {
  const keys = working ? input.clearWorking : input.clear;
  if (keys === null) return { state: 'unread', passes: 0 };
  let prior: string | null = null;
  let unchanged = 0;
  for (let pass = 1; pass <= MAX_CLEAR_PASSES; pass++) {
    for (const key of keys) {
      if (host.sendKey?.(pane, key) !== true) return { state: 'unread', passes: pass };
    }
    await host.wait(CLEAR_SETTLE_MS);
    const seen = look(host, pane, line, profile);
    if (seen.state === 'dialog') return { state: 'dialog', kind: seen.kind, passes: pass };
    if (seen.state === 'empty') return { state: 'empty', passes: pass };
    if (seen.state === 'unread') return { state: 'unread', passes: pass };
    const text = seen.state === 'other' ? seen.text : line;
    if (text === prior) {
      unchanged += 1;
      if (unchanged >= 2) return { state: 'stuck', passes: pass };
    } else {
      unchanged = 0;
      prior = text;
    }
  }
  return { state: 'spent', passes: MAX_CLEAR_PASSES };
}

/** Puts `text` back into the box with a bracketed paste and reads it until it shows the text:
 *  its rows unchanged, or — a CLI that folds long pastes — its paste chip counting the same
 *  lines. The paste surface was measured on claude 2.1.303, codex 0.161.0 and cursor-agent
 *  2026.10.16, each drawing the pasted draft back as its rows. */
async function pasteBack(
  host: DeliverHost,
  pane: string,
  profile: string,
  text: string,
): Promise<{ ok: boolean; note?: string }> {
  if (host.typeText(pane, `\x1b[200~${text}\x1b[201~`) !== true) {
    return { ok: false, note: 'the pane did not take the paste' };
  }
  const lines = text.split('\n').length;
  for (let waited = RESTORE_POLL_MS; waited <= RESTORE_WAIT_MS; waited += RESTORE_POLL_MS) {
    await host.wait(RESTORE_POLL_MS);
    const screen = host.readAnsi?.(pane) ?? null;
    if (screen === null) continue;
    const chip = chipLinesOf(profile, screen);
    if (chip !== null) {
      return chip === lines
        ? { ok: true, note: `the CLI folded the text into its paste chip (${String(chip)} lines)` }
        : { ok: false, note: `the CLI's paste chip counts ${String(chip)} lines, not ${String(lines)}` };
    }
    if (boxText(profile, screen) === text) return { ok: true };
  }
  return { ok: false, note: 'the pasted text did not read back as its rows' };
}

/** Whether a screen that reads unsent is a working one: its composer took a draft mid-turn. */
function workingScreen(profile: string, screen: string): boolean {
  return readScreen(profile, screen).kind === 'working';
}

/** Clears whatever the box holds and pastes the copied `text` back, then verifies it. The copy
 *  is removed only on a verified restore; otherwise it is kept and named in the move. Never
 *  types into a dialog. */
async function putDraftBack(
  host: DeliverHost,
  pane: string,
  line: string,
  profile: string,
  input: InputBlock,
  text: string,
  copy: string,
): Promise<DraftMove> {
  let now = look(host, pane, line, profile);
  // A read that fails right after Enter can be a redraw in progress: the box is given the same
  // window a paste's read-back gets before an unreadable box is left to its copy.
  for (let waited = RESTORE_POLL_MS; now.state === 'unread' && waited <= RESTORE_WAIT_MS; waited += RESTORE_POLL_MS) {
    await host.wait(RESTORE_POLL_MS);
    now = look(host, pane, line, profile);
  }
  if (now.state === 'dialog') return { restored: false, copy, note: `the screen reads ${now.kind}; nothing was pasted back` };
  if (now.state === 'unread') return { restored: false, copy, note: 'the box could not be read to put the text back' };
  if (now.state !== 'empty') {
    const cleared = await clearBox(host, pane, line, profile, input, now.state === 'other' && workingScreen(profile, now.screen));
    if (cleared.state !== 'empty') {
      return { restored: false, copy, note: 'the box could not be cleared to put the text back' };
    }
  }
  const pasted = await pasteBack(host, pane, profile, text);
  if (!pasted.ok) return { restored: false, copy, ...(pasted.note === undefined ? {} : { note: pasted.note }) };
  removeCopy(copy);
  return { restored: true, ...(pasted.note === undefined ? {} : { note: pasted.note }) };
}

type Prep =
  | { ok: true; text: string; copy: string; input: InputBlock; working: boolean }
  | { ok: false; reason: string };

/** Whether this delivery can move the text `look()` found out of the box and back: a measured
 *  clear sequence and paste surface for the CLI, a copy it can keep, a working turn the CLI's
 *  keys were measured in, and a text that can be copied faithfully. Refusals name what is in
 *  the way and leave the box untouched. */
function prepareDraft(host: DeliverHost, line: string, profile: string, seen: Look & { state: 'other' }): Prep {
  const held = 'the composer already holds unsent text';
  if (host.sendKey === undefined) return { ok: false, reason: held };
  const input = profileFor(profile)?.input ?? null;
  if (input === null) return { ok: false, reason: `${held}, and this CLI's box has no measured clear keys; it was left as it is` };
  const working = workingScreen(profile, seen.screen);
  if (working && input.clearWorking === null) {
    return { ok: false, reason: `${held} while the seat is working, and this CLI has no key measured to clear it there; it was left as it is` };
  }
  const capture = captureBox(profile, seen.screen);
  if ('why' in capture) return { ok: false, reason: `${held} ${capture.why}; it was left as it is` };
  const copy = keepDraft(line, capture.text);
  if ('why' in copy) return { ok: false, reason: `${held}, and ${copy.why}; the box was left as it is` };
  return { ok: true, text: capture.text, copy: copy.copy, input, working };
}

/** One line about a moved draft, for a receipt: where the text is now, and what a restore
 *  that needed a word left behind. */
export function draftNote(move: DraftMove): string {
  if (move.restored) {
    return move.note === undefined ? 'the unsent text was pasted back' : `the unsent text was pasted back; ${move.note}`;
  }
  return move.copy === undefined
    ? 'the unsent text could not be put back'
    : `the unsent text could not be put back; its copy is at ${move.copy}`;
}

/**
 * Whether the screen shows a token in the transcript: a row (after SGR stripping) that names
 * `token` and, when `excludeLine` is given, is not that line's own echo.
 */
export function showsTranscriptToken(screen: string, token: string, excludeLine?: string): boolean {
  if (token === '') return false;
  for (const row of stripSgr(screen).split('\n')) {
    if (!row.includes(token)) continue;
    if (excludeLine !== undefined) {
      const fragment = row.trim().replace(/^[^A-Za-z0-9/~.]+/, '').replace(/[^A-Za-z0-9/~.]+$/, '');
      if (fragment !== '' && excludeLine.includes(fragment)) continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether the screen shows the seat reading the drop: a row that names the drop's id and is not the
 * trigger's own echo. A submitted line stays in the transcript (whole, or wrapped over several
 * rows, behind a bullet or a border), and that echo says the line was sent, not that anyone read
 * the file; a row such as `Explored 1 file (<id>)` does.
 */
export function showsDrop(screen: string, line: string): boolean {
  const id = dropIdOf(line);
  if (id === null) return false;
  return showsTranscriptToken(screen, id, line);
}

function dialogStop(kind: string, tries: number): DeliverResult {
  return { outcome: 'unreachable', tries, reason: `not reached; the screen reads ${kind}`, dialog: kind };
}

function boxOf(seen: Look, line: string): string | undefined {
  if (seen.state === 'empty') return '';
  if (seen.state === 'trigger') return line;
  if (seen.state === 'other') return seen.text;
  return undefined;
}

/** What a caller knows about the box its line is going into. */
export type DeliverOptions = {
  /** A box already holding exactly this line is the caller's own: a record says a send typed the
   *  trigger and left it unsent (a `not-submitted` send). That line gets the Enter and is never
   *  typed over. Without the record the line is someone else's, and the outcome is `held`. */
  submitHeld?: boolean;
};

/**
 * Types `line` into the pane's box and presses Enter until the seat is seen to take it.
 *
 * A screen that is a dialog is never typed into (`unreachable`). A box that holds unsent text
 * of someone else's is never typed over: when the CLI's profile carries the measured way into
 * its box (`input`), the text is copied beside the drop file, the box is cleared with the
 * profile's keys, the trigger is typed and submitted, and the text is pasted back — bracketed
 * paste — and read back as its rows before the copy is removed. A box this version cannot
 * empty or copy exactly is left untouched (`held`), as it was before that surface existed.
 * Only a `submitHeld` caller's own unsent trigger is entered without a copy.
 *
 * After Enter, a submission is verified when herdr shows the seat working (or a new
 * `done`/`blocked`) and the trigger has left the box. A try that is not verified is followed
 * by a re-read: another Enter goes only to a box that still holds exactly the trigger line, never
 * to an empty one, to one that holds something else, to one that cannot be read, or to a dialog; at
 * most `MAX_TRIES` Enters, each waiting longer than the last (`BACKOFF_MS`). Evidence has to come
 * from this line: a status that moved after Enter (never the one a seat already had), or the drop
 * in the transcript. After the last Enter the box itself is the verdict: a trigger still in it is
 * `not-submitted`; one that has left it — an empty box, one holding a pasted-back draft, or other
 * text — is `delivered` with `taken` evidence, taken but not yet confirmed, because a busy CLI can
 * clear its box while herdr's status lags or stays idle. A box that cannot be read keeps the first
 * Enter and is judged by the status alone, and never gets a second. A delivery that moved an
 * unsent draft puts it back on every delivered exit — the leave check reads the box only once,
 * 400 ms after Enter, so a clear that lands inside the verify window is restored there too — or
 * keeps the copy and names it in the move.
 */
export async function deliverTrigger(
  host: DeliverHost, pane: string, line: string, profile: string, options: DeliverOptions = {},
): Promise<DeliverResult> {
  const before = host.status(pane);
  if (before === null) return { outcome: 'unreachable', tries: 0, reason: "the seat's status could not be read" };

  const start = look(host, pane, line, profile);
  if (start.state === 'dialog') return dialogStop(start.kind, 0);

  // The draft this delivery moves out of the box and puts back: its rows, the copy it was kept
  // in, and what the receipt says. `restored` is set only when the text was read back in place;
  // a failed restore is never retried into a box that may hold part of it.
  let draftText: string | undefined;
  let copyPath: string | undefined;
  let input: InputBlock | null = null;
  let draft: DraftMove | undefined;
  let restored = false;

  if (start.state === 'other') {
    const prep = prepareDraft(host, line, profile, start);
    if (!prep.ok) return { outcome: 'held', box: start.text, tries: 0, reason: prep.reason };
    draftText = prep.text;
    copyPath = prep.copy;
    input = prep.input;
    const cleared = await clearBox(host, pane, line, profile, prep.input, prep.working);
    if (cleared.state !== 'empty') {
      const kept: DraftMove = { restored: false, copy: prep.copy };
      if (cleared.state === 'dialog') return { ...dialogStop(cleared.kind, 0), draft: kept };
      const why = cleared.state === 'stuck'
        ? `the box did not empty after ${String(cleared.passes)} clear passes`
        : cleared.state === 'spent'
          ? `the box still held text after ${String(MAX_CLEAR_PASSES)} clear passes`
          : 'the box could not be read while clearing it';
      return {
        outcome: 'held',
        box: start.text,
        tries: 0,
        reason: `the composer already holds unsent text, and ${why}; the copy is at ${prep.copy}`,
        draft: kept,
      };
    }
  }

  if (start.state === 'trigger' && options.submitHeld !== true) {
    return { outcome: 'held', box: line, tries: 0, reason: 'the composer already holds unsent text' };
  }

  let seen: Look;
  if (start.state === 'trigger') {
    // The line is already in the box and a record says it is this delivery's own unsent trigger:
    // the Enter below submits it, and nothing is typed over it.
    seen = start;
  } else {
    if (!host.typeText(pane, line)) {
      const moved = draftText !== undefined ? await putDraftBack(host, pane, line, profile, input as InputBlock, draftText, copyPath as string) : undefined;
      return { outcome: 'unreachable', tries: 0, reason: 'the pane did not take the trigger', ...(moved === undefined ? {} : { draft: moved }) };
    }
    await host.wait(SETTLE_MS);

    const typed = look(host, pane, line, profile);
    if (typed.state === 'dialog') {
      const moved = draftText !== undefined ? await putDraftBack(host, pane, line, profile, input as InputBlock, draftText, copyPath as string) : undefined;
      return { ...dialogStop(typed.kind, 0), ...(moved === undefined ? {} : { draft: moved }) };
    }
    if (typed.state === 'other') {
      // The trigger typed into a box that clear had left empty no longer reads back alone: the
      // delivery stops here and the draft goes back, so the owner's text is in the box and not
      // only in its copy.
      const moved = draftText !== undefined ? await putDraftBack(host, pane, line, profile, input as InputBlock, draftText, copyPath as string) : undefined;
      return {
        outcome: 'held',
        box: typed.text,
        tries: 0,
        reason: `the composer read-back did not match the trigger${moved === undefined ? '' : `; ${draftNote(moved)}`}`,
        ...(moved === undefined ? {} : { draft: moved }),
      };
    }
    seen = typed;
  }

  // The draft goes back the moment the box reads empty after an Enter: the trigger has left it,
  // and the owner's text waits no longer than that. A restore is attempted once; a box that is
  // not readable as empty is left for the loop's next read.
  const maybeRestore = async (): Promise<void> => {
    if (draftText === undefined || restored || copyPath === undefined || input === null) return;
    await host.wait(LEAVE_CHECK_MS);
    if (look(host, pane, line, profile).state !== 'empty') return;
    restored = true;
    draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
  };

  let tries = 0;
  // The verdict reads a box holding exactly the pasted-back draft as an empty one: the trigger
  // has left it, and the box is the owner's again.
  const afterDraft = (): string | undefined => (restored ? draftText : undefined);
  // What a delivered exit still owes the owner's text: the leave check reads the box once, so a
  // clear that lands after it — or a read that was unread there — must still put the text back,
  // or the receipt must name the copy. A box that reads other text is never typed over; the copy
  // is kept and named instead. A restore is attempted once, like the leave check's.
  const restoreOnDelivered = async (): Promise<void> => {
    if (draftText === undefined || restored || copyPath === undefined || input === null) return;
    restored = true;
    if (look(host, pane, line, profile).state === 'other') {
      draft = { restored: false, copy: copyPath, note: 'the box held other text when the trigger left; nothing was pasted back' };
      return;
    }
    draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
  };
  for (let round = 0; round < MAX_TRIES; round++) {
    // The first Enter goes, read or not. Later ones go only where a fresh read shows the box still
    // holds exactly the trigger; an empty or unreadable box waits another window, and gets no key.
    const enter = round === 0 || seen.state === 'trigger';
    if (enter) {
      if (!host.pressEnter(pane)) {
        // An Enter herdr did not take, with the line still sitting in the box, is a line typed and
        // never submitted: the box says so. Anything else is a pane that cannot be keyed. Either
        // way the draft goes back before the answer, with the trigger cleared first.
        if (draftText !== undefined && copyPath !== undefined && input !== null && !restored) {
          restored = true;
          draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
        }
        const stuck = look(host, pane, line, profile, afterDraft());
        if (stuck.state === 'trigger') {
          return {
            outcome: 'not-submitted',
            box: line,
            tries,
            reason: `the Enter was not taken and the trigger stayed in the composer${draft === undefined ? '' : `; ${draftNote(draft)}`}`,
            ...(draft === undefined ? {} : { draft }),
          };
        }
        return { outcome: 'unreachable', tries, reason: 'the Enter was not taken', ...(draft === undefined ? {} : { draft }) };
      }
      tries += 1;
    }
    await maybeRestore();
    const verified = await verify(host, pane, line, profile, before, BACKOFF_MS[round] ?? 9000, afterDraft());
    if (verified !== null) {
      await restoreOnDelivered();
      return { outcome: 'delivered', tries, ...verified, ...(draft === undefined ? {} : { draft }) };
    }
    seen = look(host, pane, line, profile, afterDraft());
    if (seen.state === 'dialog') {
      // A dialog took the box between the tries: the draft was either put back already or cannot
      // safely be typed now. It stays in its copy, and the copy is named.
      if (!restored && draftText !== undefined && copyPath !== undefined && input !== null) {
        restored = true;
        draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
      }
      return { ...dialogStop(seen.kind, tries), ...(draft === undefined ? {} : { draft }) };
    }
    if (seen.state === 'other') break;
  }
  // A box that has cleared with no sign yet is not given up on at the end of the tries: the seat
  // may be working while herdr still reads it idle.
  if (seen.state === 'empty' || seen.state === 'unread') {
    const spent = BACKOFF_MS.slice(0, MAX_TRIES).reduce((sum, ms) => sum + ms, 0);
    const late = await verify(host, pane, line, profile, before, Math.max(0, VERIFY_TOTAL_MS - spent), afterDraft());
    if (late !== null) {
      await restoreOnDelivered();
      return { outcome: 'delivered', tries, ...late, ...(draft === undefined ? {} : { draft }) };
    }
    seen = look(host, pane, line, profile, afterDraft());
    // A dialog that came up during the late window is why the seat was not reached, exactly as
    // one met between the tries: it is never the box's verdict.
    if (seen.state === 'dialog') {
      if (!restored && draftText !== undefined && copyPath !== undefined && input !== null) {
        restored = true;
        draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
      }
      return { ...dialogStop(seen.kind, tries), ...(draft === undefined ? {} : { draft }) };
    }
  }
  // The box decides after the last Enter. A trigger still in it was never taken — the draft goes
  // back first, with the trigger cleared, so the box is the owner's again. A box that no longer
  // holds the trigger — empty, holding the pasted-back draft, or other text — took it: a CLI can
  // clear its box without herdr's status moving, so a cleared box is a delivery, reported as
  // taken but not yet confirmed (the watch confirms it later). A box that cannot be read keeps
  // the status-alone judgement the window already made: nothing shows the line was taken.
  if (seen.state === 'empty' || seen.state === 'other') {
    await restoreOnDelivered();
    return { outcome: 'delivered', tries, evidence: 'taken', prior: before, reason: TAKEN_REASON, ...(draft === undefined ? {} : { draft }) };
  }
  if (draftText !== undefined && copyPath !== undefined && input !== null && !restored) {
    restored = true;
    draft = await putDraftBack(host, pane, line, profile, input, draftText, copyPath);
  }
  const box = boxOf(seen, line);
  return {
    outcome: 'not-submitted',
    ...(box === undefined ? {} : { box }),
    tries,
    reason: (seen.state === 'trigger'
      ? 'the trigger stayed in the composer after the Enters'
      : 'herdr did not report the seat working and the trigger did not leave the composer cleanly')
      + (draft === undefined ? '' : `; ${draftNote(draft)}`),
    ...(draft === undefined ? {} : { draft }),
  };
}

/**
 * What showed the seat took the line, once the box no longer holds it; else null. Either herdr's
 * status changed (working, or a new done/blocked), or the box is empty and the transcript shows
 * the drop being read, which does not wait on a status that can lag.
 */
async function verify(
  host: DeliverHost,
  pane: string,
  line: string,
  profile: string,
  before: string | null,
  window: number,
  draft?: string,
): Promise<{ status: string; evidence: 'status' | 'transcript' } | null> {
  const samples: string[] = [];
  let polls = 0;
  for (let waited = 0; waited < window; waited += POLL_MS) {
    await host.wait(POLL_MS);
    polls += 1;
    const sample = host.status(pane);
    let changed = false;
    if (sample !== null) {
      samples.push(sample);
      changed = sawSubmission(before, samples);
    }
    if (!changed && polls % TRANSCRIPT_EVERY !== 0) continue;
    const seen = look(host, pane, line, profile, draft);
    // A status that moved counts once the line has left the box and the screen is not a dialog:
    // a seat that is working under a permission dialog took nothing from this send.
    if (changed && sample !== null && seen.state !== 'trigger' && seen.state !== 'dialog') {
      return { status: sample, evidence: 'status' };
    }
    if (seen.state === 'empty' && showsDrop(seen.screen, line)) return { status: 'transcript', evidence: 'transcript' };
  }
  return null;
}

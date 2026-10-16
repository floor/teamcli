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
import { stripSgr } from '../ansi.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { classify, readBox, readScreen } from '../watch/screen.ts';
import { POLL_MS, SETTLE_MS, sawSubmission, type NativePane } from './native.ts';

/** The most Enters one delivery presses. */
export const MAX_TRIES = 3;

/** The most Enters pressed when the box cannot be read at all. */
export const BLIND_TRIES = 2;

/** How long each try waits for the seat to show the submission: 1s, 3s, then 9s. */
export const BACKOFF_MS: readonly number[] = [1000, 3000, 9000];

/** How long in all a seat whose box has cleared is given to show it took the line. herdr's status
 *  can lag or stay idle while a CLI works (agy does), so a cleared box is waited on past the
 *  tries' own windows. */
export const VERIFY_TOTAL_MS = 20_000;

/** The transcript is read once a second, not at every status poll. */
const TRANSCRIPT_EVERY = Math.ceil(1000 / POLL_MS);

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
  /** What showed the seat took the line, with `delivered`: herdr's status, or the transcript. */
  status?: string;
  evidence?: 'status' | 'transcript';
  /** The dialog kind the screen showed, when that is why the seat was not reached. */
  dialog?: string;
};

/** Binds a session to the pane operations a send already has. */
export function bindPane(native: NativePane, session: string): DeliverHost {
  const paneText = native.paneText;
  return {
    typeText: (pane, text) => native.typeText(session, pane, text),
    pressEnter: (pane) => native.pressEnter(session, pane),
    status: (pane) => native.status(session, pane),
    wait: (ms) => native.wait(ms),
    ...(paneText ? { readAnsi: (pane: string) => paneText(session, pane) } : {}),
  };
}

const DIALOGS = new Set(['question', 'permission', 'trust', 'vendor notice', 'provider error', 'rate limit']);

/** The dialog kind a screen shows, or null. A screen that could not be read is not a dialog. */
export function dialogKind(profile: string, screen: string | null): string | null {
  if (screen === null) return null;
  const kind = classify(profile, screen.split('\n')).kind;
  return DIALOGS.has(kind) ? kind : null;
}

type Look =
  | { state: 'unread' }
  | { state: 'dialog'; kind: string }
  | { state: 'empty'; screen: string }
  | { state: 'trigger' }
  | { state: 'other'; text: string };

/** What the input box holds, against the trigger line. */
function look(host: DeliverHost, pane: string, line: string, profile: string): Look {
  const screen = host.readAnsi?.(pane) ?? null;
  if (screen === null) return { state: 'unread' };
  const dialog = dialogKind(profile, screen);
  if (dialog !== null) return { state: 'dialog', kind: dialog };
  if (readScreen(profile, screen).kind !== 'unsent') return { state: 'empty', screen };
  if (boxHoldsText(profile, line, screen)) return { state: 'trigger' };
  return { state: 'other', text: boxText(profile, screen) };
}

function boxText(profile: string, screen: string): string {
  const box = readBox(profile, screen);
  if (box === null) return '';
  const pad = ' '.repeat(box.indent);
  return [box.first, ...box.rows.map((row) => (row.startsWith(pad) ? row.slice(pad.length) : row))].join('\n').trimEnd();
}

/** The drop file's id: the last segment of the path the trigger line names, or null for a line
 *  that is not `Read <path> and do that.`. */
export function dropIdOf(line: string): string | null {
  const named = /^Read (\S+) and do that\.$/.exec(line);
  const path = named?.[1];
  if (path === undefined) return null;
  const id = path.slice(path.lastIndexOf('/') + 1);
  return id === '' ? null : id;
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
  for (const row of stripSgr(screen).split('\n')) {
    if (!row.includes(id)) continue;
    const fragment = row.trim().replace(/^[^A-Za-z0-9/~.]+/, '').replace(/[^A-Za-z0-9/~.]+$/, '');
    if (fragment !== '' && line.includes(fragment)) continue;
    return true;
  }
  return false;
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

/**
 * Types `line` into the pane's box and presses Enter until the seat is seen to take it.
 *
 * Nothing is typed into a box that holds text already (`held`) or a screen that is a dialog
 * (`unreachable`). After Enter, a submission is verified when herdr shows the seat working (or a
 * new `done`/`blocked`) and the trigger has left the box. A try that is not verified is followed
 * by a re-read: another Enter goes only to a box that still holds exactly the trigger line, never
 * to an empty one, to one that holds something else, or to a dialog; at most `MAX_TRIES` Enters,
 * each waiting longer than the last (`BACKOFF_MS`). When the box cannot be read at all the status
 * alone decides, and an unverified Enter is repeated once, as the run before this one did.
 */
export async function deliverTrigger(host: DeliverHost, pane: string, line: string, profile: string): Promise<DeliverResult> {
  const before = host.status(pane);
  if (before === null) return { outcome: 'unreachable', tries: 0, reason: "the seat's status could not be read" };

  const start = look(host, pane, line, profile);
  if (start.state === 'dialog') return dialogStop(start.kind, 0);
  if (start.state === 'trigger' || start.state === 'other') {
    const text = start.state === 'other' ? start.text : line;
    return { outcome: 'held', box: text, tries: 0, reason: 'the composer already holds unsent text' };
  }

  if (!host.typeText(pane, line)) return { outcome: 'unreachable', tries: 0, reason: 'the pane did not take the trigger' };
  await host.wait(SETTLE_MS);

  const typed = look(host, pane, line, profile);
  if (typed.state === 'dialog') return dialogStop(typed.kind, 0);
  if (typed.state === 'other') {
    return { outcome: 'held', box: typed.text, tries: 0, reason: 'the composer read-back did not match the trigger' };
  }

  let tries = 0;
  let seen: Look = typed;
  for (let round = 0; round < MAX_TRIES; round++) {
    // The first Enter always goes. Later ones go only where the box still holds the trigger (or,
    // with the box unreadable, where nothing says otherwise); an empty box waits another window.
    const enter = round === 0 || seen.state === 'trigger' || seen.state === 'unread';
    if (enter) {
      if (!host.pressEnter(pane)) {
        // An Enter herdr did not take, with the line still sitting in the box, is a line typed and
        // never submitted: the box says so. Anything else is a pane that cannot be keyed.
        const stuck = look(host, pane, line, profile);
        if (stuck.state === 'trigger') {
          return { outcome: 'not-submitted', box: line, tries, reason: 'the Enter was not taken and the trigger stayed in the composer' };
        }
        return { outcome: 'unreachable', tries, reason: 'the Enter was not taken' };
      }
      tries += 1;
    }
    const verified = await verify(host, pane, line, profile, before, BACKOFF_MS[round] ?? 9000);
    if (verified !== null) return { outcome: 'delivered', tries, ...verified };
    seen = look(host, pane, line, profile);
    if (seen.state === 'dialog') return dialogStop(seen.kind, tries);
    if (seen.state === 'other') break;
    // With the box unreadable an Enter is a guess: the one repeat the run before this had, no more.
    if (seen.state === 'unread' && tries >= BLIND_TRIES) break;
  }
  // A box that has cleared with no sign yet is not given up on at the end of the tries: the seat
  // may be working while herdr still reads it idle.
  if (seen.state === 'empty') {
    const spent = BACKOFF_MS.slice(0, MAX_TRIES).reduce((sum, ms) => sum + ms, 0);
    const late = await verify(host, pane, line, profile, before, Math.max(0, VERIFY_TOTAL_MS - spent));
    if (late !== null) return { outcome: 'delivered', tries, ...late };
    seen = look(host, pane, line, profile);
  }
  const box = boxOf(seen, line);
  return {
    outcome: 'not-submitted',
    ...(box === undefined ? {} : { box }),
    tries,
    reason: 'herdr did not report the seat working and the trigger did not leave the composer cleanly',
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
    const seen = look(host, pane, line, profile);
    if (changed && sample !== null && seen.state !== 'trigger') return { status: sample, evidence: 'status' };
    if (seen.state === 'empty' && showsDrop(seen.screen, line)) return { status: 'transcript', evidence: 'transcript' };
  }
  return null;
}

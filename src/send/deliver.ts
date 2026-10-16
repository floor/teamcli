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
import { boxHoldsText } from '../launch/deliver.ts';
import { classify, readBox, readScreen } from '../watch/screen.ts';
import { POLL_MS, SETTLE_MS, sawSubmission, type NativePane } from './native.ts';

/** The most Enters one delivery presses. */
export const MAX_TRIES = 3;

/** How long each try waits for the seat to show the submission: 1s, 3s, then 9s. */
export const BACKOFF_MS: readonly number[] = [1000, 3000, 9000];

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
  /** herdr's status when the submission showed, with `delivered`. */
  status?: string;
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
  | { state: 'empty' }
  | { state: 'trigger' }
  | { state: 'other'; text: string };

/** What the input box holds, against the trigger line. */
function look(host: DeliverHost, pane: string, line: string, profile: string): Look {
  const screen = host.readAnsi?.(pane) ?? null;
  if (screen === null) return { state: 'unread' };
  const dialog = dialogKind(profile, screen);
  if (dialog !== null) return { state: 'dialog', kind: dialog };
  if (readScreen(profile, screen).kind !== 'unsent') return { state: 'empty' };
  if (boxHoldsText(profile, line, screen)) return { state: 'trigger' };
  return { state: 'other', text: boxText(profile, screen) };
}

function boxText(profile: string, screen: string): string {
  const box = readBox(profile, screen);
  if (box === null) return '';
  const pad = ' '.repeat(box.indent);
  return [box.first, ...box.rows.map((row) => (row.startsWith(pad) ? row.slice(pad.length) : row))].join('\n').trimEnd();
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
 * alone decides, and an unverified Enter is repeated as the run before this one did.
 */
export async function deliverTrigger(host: DeliverHost, pane: string, line: string, profile: string): Promise<DeliverResult> {
  const before = host.status(pane);
  if (before === null) return { outcome: 'unreachable', tries: 0, reason: "the seat's status could not be read" };

  const start = look(host, pane, line, profile);
  if (start.state === 'dialog') return { outcome: 'unreachable', tries: 0, reason: `not reached; the screen reads ${start.kind}` };
  if (start.state === 'trigger' || start.state === 'other') {
    const text = start.state === 'other' ? start.text : line;
    return { outcome: 'held', box: text, tries: 0, reason: 'the composer already holds unsent text' };
  }

  if (!host.typeText(pane, line)) return { outcome: 'unreachable', tries: 0, reason: 'the pane did not take the trigger' };
  await host.wait(SETTLE_MS);

  const typed = look(host, pane, line, profile);
  if (typed.state === 'dialog') return { outcome: 'unreachable', tries: 0, reason: `not reached; the screen reads ${typed.kind}` };
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
      if (!host.pressEnter(pane)) return { outcome: 'unreachable', tries, reason: 'the Enter was not taken' };
      tries += 1;
    }
    const verified = await verify(host, pane, line, profile, before, BACKOFF_MS[round] ?? 9000);
    if (verified !== null) return { outcome: 'delivered', tries, status: verified };
    seen = look(host, pane, line, profile);
    if (seen.state === 'dialog') return { outcome: 'unreachable', tries, reason: `not reached; the screen reads ${seen.kind}` };
    if (seen.state === 'other') break;
  }
  const box = boxOf(seen, line);
  return {
    outcome: 'not-submitted',
    ...(box === undefined ? {} : { box }),
    tries,
    reason: 'herdr did not report the seat working and the trigger did not leave the composer cleanly',
  };
}

/** The status that showed the seat took the line, once the box no longer holds it; else null. */
async function verify(host: DeliverHost, pane: string, line: string, profile: string, before: string | null, window: number): Promise<string | null> {
  const samples: string[] = [];
  for (let waited = 0; waited < window; waited += POLL_MS) {
    await host.wait(POLL_MS);
    const sample = host.status(pane);
    if (sample === null) continue;
    samples.push(sample);
    if (!sawSubmission(before, samples)) continue;
    if (look(host, pane, line, profile).state === 'trigger') continue;
    return sample;
  }
  return null;
}

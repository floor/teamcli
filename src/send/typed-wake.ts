// The typed wake: one line, one guarded Enter, one acknowledgement. A profile that declares
// `typed_wake: screen` lets a send type one trigger line into a composer two reads showed as the
// empty idle prompt; Enter is pressed only while the box still holds exactly that line, and the
// send is delivered only when the profile's own working screen shows and that line has left the
// box. A working screen that still holds the line is the CLI busy with other work, not a
// submission. Nothing else is typed: no
// draft is moved, cleared or pasted, and a wake that cannot deliver leaves the message where it
// already is, in the bus inbox. Every other messaging path still refuses to type
// (src/send/no-pane-messaging.ts), and this module is the single exemption the scan in
// test/no-pane-messaging.test.ts names.
//
// The screens are the CLI's own captured frames (`test/fixtures/muse/` and
// `test/fixtures/cursor/2026.10.22/`): `idle` is the empty box, `unsent` is the box holding the
// line, and the profile's `working` rule is the acknowledgement.
import { paneReadAsync, pressEnterAsync, sendKeyAsync, typeTextAsync } from '../herdr.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { profileFor, WAKE_IDLE_SETTLE_FLOOR_MS, WAKE_IDLE_SETTLE_MS } from '../profiles/profile.ts';
import { MESSAGE_LINE_MAX } from '../settings/message-display.ts';
import { readScreen, screenData } from '../watch/screen.ts';
import { POLL_MS } from './native.ts';

/** How long after the line is typed the box is read before the first Enter, and between the two
 *  reads that have to agree before that Enter: the CLI has to have drawn the line and stopped
 *  changing it, or the guard below would press while the row was still rendering. */
export const WAKE_ENTER_SETTLE_MS = 250;

/** How many times the wake will look again for two identical reads of its own line. Past this
 *  the line has not settled, and no Enter is pressed. */
const LINE_SETTLE_LOOKS = 4;

/** How long one Enter is given to show the working screen, polled every `POLL_MS`. */
export const WAKE_VERIFY_MS = 10_000;

/** The most Enters one wake presses. Each one is guarded: the box must still hold exactly the
 *  line, so a second Enter never goes to an empty box or to someone else's text. */
export const MAX_WAKE_ENTERS = 3;

/** The visible lines one read covers: the composer and the working line drawn above it. */
const WAKE_LINES = 40;

/** What the wake needs from the pane. Bound to one session by `herdrTypedWakeHost`; a scene
 *  hands in its own. */
export type TypedWakeHost = {
  /** The pane's visible text, or null when it cannot be read. */
  read(pane: string): string | null | Promise<string | null>;
  /** Types `text` once. False when the pane did not take it. */
  type(pane: string, text: string): boolean | Promise<boolean>;
  /** One Enter. False when the key was not taken. */
  enter(pane: string): boolean | Promise<boolean>;
  /** One named key — the profile's return-to-prompt key when the pane is scrolled back. Absent:
   *  a screen read as scrolled back is refused rather than woken. False when the key was not
   *  taken. */
  key?(pane: string, key: string): boolean | Promise<boolean>;
  wait(ms: number): Promise<void>;
};

/** The real pane operations, bound to one session name. This is the only host in the build whose
 *  type and Enter are not `refuseTyping`: the typed wake is the single grant of that rule. */
export function herdrTypedWakeHost(session: string): TypedWakeHost {
  return {
    read: (pane) => paneReadAsync(pane, WAKE_LINES, session, { timeoutMs: 10_000 }),
    type: (pane, text) => typeTextAsync(pane, text, session, { timeoutMs: 10_000 }),
    enter: (pane) => pressEnterAsync(pane, session, { timeoutMs: 10_000 }),
    key: (pane, key) => sendKeyAsync(pane, key, session, { timeoutMs: 10_000 }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** What one wake did. `reason` names exactly what was seen, for the walk's failure line: it is
 *  never a guess about a screen the wake did not read. */
export type TypedWakeResult = {
  /** True only when the profile's working screen showed after an Enter this wake pressed. */
  delivered: boolean;
  /** True when this wake put at least one key into the pane (the return key, the line, or an
   *  Enter). A caller that keeps a one-attempt reservation — a socket delivery's single re-wake
   *  — holds it when this is true; a caller that retries releases it either way and records
   *  this so a later report can say a wake was typed and none was confirmed. */
  typed: boolean;
  /** How many Enters were pressed. */
  tries: number;
  reason: string;
  /** When the first read after an Enter showed the wake's line gone, in the walk's clock's own
   *  milliseconds: the submission-confirmed point the delivery bound ends at. Absent when no read
   *  showed it (nothing was Entered, or every read held the line). */
  submittedAt?: number;
  /** When the first read after an Enter showed the profile's working screen with the line gone,
   *  in the walk's clock's own milliseconds: the redraw the trace reports beside the bound's
   *  point, never a second bound. Absent when the working screen never showed without the line. */
  workingAt?: number;
};

export type TypedWakeOptions = {
  /** The gap between the two idle reads. Defaults to the profile's own `typed_wake_settle_ms`,
   *  clamped at `WAKE_IDLE_SETTLE_FLOOR_MS`, and to the measured `WAKE_IDLE_SETTLE_MS` when the
   *  profile names none: the native `SETTLE_MS` was never measured for this path. */
  settleMs?: number;
  /** The gap between typing the line and reading the box before Enter. */
  enterSettleMs?: number;
  /** The poll interval while waiting for the working screen. */
  pollMs?: number;
  /** The settle between an Enter and the first look at what it did. Never a read at zero delay:
   *  a read before the key is drawn sees the line still in the box and presses a second Enter.
   *  Defaults to `pollMs`, the interval the host reports a status change at. */
  ackSettleMs?: number;
  /** How long one Enter is given to show the working screen. */
  verifyMs?: number;
  /** The clock the two marks are taken with, in epoch milliseconds. The real walk uses
   *  `Date.now`; a scene hands in its own so the marks are exact. */
  now?: () => number;
};

/** The two marks one walk observed, filled in as its reads show them. */
type WakeMarks = { submittedAt?: number; workingAt?: number };

/** One word for the screen a read showed, for a reason line: the screen reading, or `unreadable`
 *  when the pane could not be read at all. */
function seenOf(cli: string, screen: string | null): string {
  return screen === null ? 'unreadable' : readScreen(cli, screen).kind;
}

/** The bound ran out on a working screen that still held the wake's line. The Enter did not
 *  submit it, so the message stays in the inbox for a later wake. */
function stillHeldReason(tries: number): string {
  return `the working screen showed with the line still in the box after ${String(tries)} Enter${tries === 1 ? '' : 's'}; the line was not submitted`;
}

/** What the post-Enter poll saw. `submitted` is a working screen whose box no longer holds the
 *  wake's line. `held` is that the bound ran out while a working screen still held the line.
 *  `absent` is every other miss: no working screen, so the caller may press again. */
type WakeAck = 'submitted' | 'held' | 'absent';

/** The working screen, polled for `verifyMs` at `pollMs`. A working screen that still holds the
 *  wake's line is not a submission: the poll keeps looking until the box empties or the bound
 *  runs out. A read that cannot be taken is not a working screen. */
async function pollSubmitted(
  host: TypedWakeHost,
  pane: string,
  cli: string,
  line: string,
  pollMs: number,
  verifyMs: number,
  /** Called for every read taken, so the caller's marks see a line that leaves the box before
   *  the working screen is drawn. */
  seen?: (read: string) => void,
): Promise<WakeAck> {
  const polls = Math.max(1, Math.ceil(verifyMs / pollMs));
  let sawWorkingWhileHeld = false;
  let lastHolds = false;
  for (let i = 0; i < polls; i += 1) {
    await host.wait(pollMs);
    const screen = await host.read(pane);
    if (screen === null) continue;
    seen?.(screen);
    const holds = boxHoldsText(cli, line, screen);
    lastHolds = holds;
    const working = readScreen(cli, screen).kind === 'working';
    if (working && holds) sawWorkingWhileHeld = true;
    if (working && !holds) return 'submitted';
  }
  return sawWorkingWhileHeld && lastHolds ? 'held' : 'absent';
}

/**
 * Types one trigger line into the profile's idle composer and presses Enter, then waits for the
 * profile's working screen. Both idle reads happen before any key goes out, spaced by the wake's
 * own measured settle — the profile's `typed_wake_settle_ms`, never under the floor, and
 * `WAKE_IDLE_SETTLE_MS` when the profile names none: a pane that is working, holds unsent text,
 * shows a dialog or cannot be read is refused with nothing typed. A pane scrolled back over its
 * transcript — the profile's own bottom rows: a footer in the composer's place, or a marker above
 * a drawn composer with a status footer under it — is returned to the prompt first, with the one
 * key its row names, and the two idle reads are taken after that key: the return is the only key
 * this module sends into a screen it read as scrolled back, and it is sent once. A box that
 * already holds exactly the line is not typed again: Enter is pressed into it. After the line is
 * typed, Enter is pressed only into a box that reads back as exactly that line; a box that is
 * empty, holds other text or cannot be read gets no Enter.
 * The host's Enter is the submit key, not a Return on the text, and the first one waits
 * until two reads show that same drawn line. A line longer than the composer cap, or a line
 * with a newline, is not typed. After an Enter, a box that still holds exactly the line
 * and shows no working screen is pressed again, up to `MAX_WAKE_ENTERS`, and the line is
 * never typed a second time. After an Enter, a working screen that still holds the line is
 * not a submission: the wake keeps polling for `verifyMs` until the box empties, and delivers
 * only then. The bound ending with the line still in the box is not delivered, and the line
 * is not typed again. A box that already holds exactly this line when the wake first looks —
 * a wake child killed after typing, an Enter that did not submit — gets the same two spaced
 * looks and the same guarded Enter, and the line is never typed a second time.
 */
export async function deliverTypedWake(
  host: TypedWakeHost,
  pane: string,
  line: string,
  cli: string,
  options: TypedWakeOptions = {},
): Promise<TypedWakeResult> {
  if (line.includes('\n') || line.length > MESSAGE_LINE_MAX) {
    return { delivered: false, typed: false, tries: 0, reason: `the line does not fit ${String(MESSAGE_LINE_MAX)} characters on one row; nothing was typed` };
  }
  const marks: WakeMarks = {};
  const result = await walkTypedWake(host, pane, line, cli, options, marks);
  return { ...result, ...marks };
}

async function walkTypedWake(
  host: TypedWakeHost,
  pane: string,
  line: string,
  cli: string,
  options: TypedWakeOptions,
  marks: WakeMarks,
): Promise<TypedWakeResult> {
  const settleMs = options.settleMs
    ?? Math.max(WAKE_IDLE_SETTLE_FLOOR_MS, profileFor(cli)?.typedWakeSettleMs ?? WAKE_IDLE_SETTLE_MS);
  const enterSettleMs = options.enterSettleMs ?? WAKE_ENTER_SETTLE_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const ackSettleMs = options.ackSettleMs ?? pollMs;
  const verifyMs = options.verifyMs ?? WAKE_VERIFY_MS;
  const clock = options.now ?? Date.now;
  const firstScreen = await host.read(pane);
  const first = seenOf(cli, firstScreen);
  // The line may already be in the box — a wake child killed after typing, a wake asked twice,
  // an Enter that did not submit. That wake presses Enter into exactly this line and never types
  // it again; the two-look guard below still stands between the look and the key.
  const heldAtFirstLook = firstScreen !== null
    && readScreen(cli, firstScreen).kind === 'unsent'
    && boxHoldsText(cli, line, firstScreen);
  let tries = 0;
  let lineTyped = false;
  let keyedReturn = false;
  let screen: string | null;
  let previous: string | null = null;
  let previousHeld = false;
  let settleLooks = 0;
  if (heldAtFirstLook) {
    await host.wait(enterSettleMs);
    const reread = await host.read(pane);
    if (reread === null) {
      return { delivered: false, typed: false, tries: 0, reason: 'the screen could not be read after the line was found in the box; no Enter was pressed' };
    }
    const kind = readScreen(cli, reread).kind;
    if (kind === 'working') {
      return { delivered: false, typed: false, tries: 0, reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed' };
    }
    if (kind !== 'unsent' || !boxHoldsText(cli, line, reread)) {
      const why = kind === 'idle'
        ? 'the line left the box'
        : kind === 'unsent'
          ? 'the box held text other than the line'
          : `the screen read ${kind}`;
      return { delivered: false, typed: false, tries: 0, reason: `${why} between the two looks; no Enter was pressed` };
    }
    // Two looks, spaced by the settle, agree the box holds exactly the line: the same pair the
    // typed path waits for before its first Enter.
    screen = reread;
    previous = reread;
    previousHeld = true;
  } else {
    if (first === 'scroll back') {
      // The pane sits scrolled back over its transcript: the CLI's own bottom rows stand there,
      // either in the composer's place or around a drawn one. One press of the key those rows
      // name returns to the prompt; the box is read twice after it, exactly as it is on any
      // other wake, so a draft the scroll was hiding refuses and nothing working is typed into.
      const returnKey = screenData(cli)?.scrollBack?.returnKey;
      if (returnKey === undefined || host.key === undefined) {
        return { delivered: false, typed: false, tries: 0, reason: 'the screen is scrolled back and no return key is bound; nothing was typed' };
      }
      if (!(await host.key(pane, returnKey))) {
        return { delivered: false, typed: false, tries: 0, reason: 'the pane did not take the return key; nothing was typed' };
      }
      keyedReturn = true;
      await host.wait(enterSettleMs);
      const returned = seenOf(cli, await host.read(pane));
      if (returned !== 'idle') {
        return { delivered: false, typed: keyedReturn, tries: 0, reason: `the screen read ${returned} after the return key, not an empty idle prompt; no wake line was typed` };
      }
    } else if (first === 'feedback survey') {
      // The pane sits at the CLI's post-turn feedback survey in the composer's place. The only
      // answer TeamCLI ever sends to this dialog is '0' (Skip), once; the pane is then re-read
      // twice after it, and the wake continues only if an empty idle prompt shows.
      const skipKey = screenData(cli)?.feedbackSurvey?.skipKey;
      if (skipKey === undefined || host.key === undefined) {
        return { delivered: false, typed: false, tries: 0, reason: 'the screen is at a feedback survey and no skip key is bound; nothing was typed' };
      }
      if (!(await host.key(pane, skipKey))) {
        return { delivered: false, typed: false, tries: 0, reason: 'the pane did not take the skip key; nothing was typed' };
      }
      keyedReturn = true;
      await host.wait(enterSettleMs);
      const returned = seenOf(cli, await host.read(pane));
      if (returned !== 'idle') {
        return { delivered: false, typed: keyedReturn, tries: 0, reason: `the screen read ${returned} after the skip key, not an empty idle prompt; no wake line was typed` };
      }
    } else if (first !== 'idle') {
      return { delivered: false, typed: false, tries: 0, reason: `the first read showed ${first}, not an empty idle prompt; nothing was typed` };
    }
    await host.wait(settleMs);
    const second = seenOf(cli, await host.read(pane));
    if (second !== 'idle') {
      return {
        delivered: false,
        typed: keyedReturn,
        tries: 0,
        reason: keyedReturn
          ? `the screen read ${second} on the second idle read, not an empty idle prompt; nothing was typed`
          : `the second read showed ${second}, not an empty idle prompt; nothing was typed`,
      };
    }
    if (!(await host.type(pane, line))) {
      return { delivered: false, typed: keyedReturn, tries: 0, reason: 'the pane did not take the line; nothing was typed' };
    }
    lineTyped = true;
    await host.wait(enterSettleMs);
    screen = await host.read(pane);
  }
  /** Whether this wake put a key into the pane: it typed the line, pressed the return key, or
   *  pressed an Enter. */
  const putKeys = (): boolean => keyedReturn || lineTyped || tries > 0;
  const typedWord = lineTyped ? 'typed' : 'found in the box';
  const heldReason = (kind: string, pressed: boolean): string => {
    const why = kind === 'unsent' ? 'the box held text other than the line' : `the screen read ${kind}`;
    return pressed ? `${why} and no working screen showed` : `${why} after the line was ${typedWord}; no Enter was pressed`;
  };
  /** Reads the two marks off a post-Enter read: the first read that shows the line gone is the
   *  submission confirmed (the bound's point), the first that shows the profile's working screen
   *  with the line gone is the redraw the trace reports beside it. Both are stamped once, from
   *  the clock the caller named, and a read before any Enter by this wake stamps nothing. */
  const observe = (read: string | null): void => {
    if (read === null || tries === 0) return;
    const kind = readScreen(cli, read).kind;
    if (kind !== 'working' && kind !== 'idle') return;
    if (boxHoldsText(cli, line, read)) return;
    const at = clock();
    if (marks.submittedAt === undefined) marks.submittedAt = at;
    if (kind === 'working' && marks.workingAt === undefined) marks.workingAt = at;
  };
  for (;;) {
    observe(screen);
    if (screen === null) {
      return {
        delivered: false,
        typed: putKeys(),
        tries,
        reason: tries === 0
          ? `the screen could not be read after the line was ${typedWord}; no Enter was pressed`
          : 'the screen could not be read and no working screen showed; no further Enter was pressed',
      };
    }
    const kind = readScreen(cli, screen).kind;
    if (kind === 'working') {
      if (tries === 0) {
        return { delivered: false, typed: putKeys(), tries, reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed' };
      }
      if (boxHoldsText(cli, line, screen)) {
        return { delivered: false, typed: putKeys(), tries, reason: stillHeldReason(tries) };
      }
      return { delivered: true, typed: putKeys(), tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    const holds = boxHoldsText(cli, line, screen);
    // The first Enter waits for two looks at the drawn line. The pair agrees on the facts that
    // matter — the composer holds exactly the line — not on whole frames: a ticking counter
    // between the looks is not a reason to wait, and a line already drawn is looked at again at
    // once. A look that does not hold the line keeps the echo settle; a box that settles on
    // something else, or holds the line without settling, is never pressed.
    if (tries === 0 && !(holds && previousHeld)) {
      if (!holds && previous === screen) {
        return { delivered: false, typed: putKeys(), tries, reason: heldReason(kind, false) };
      }
      if (settleLooks >= LINE_SETTLE_LOOKS) {
        return {
          delivered: false,
          typed: putKeys(),
          tries,
          reason: holds
            ? 'the drawn line did not settle; no Enter was pressed'
            : heldReason(kind, false),
        };
      }
      previous = screen;
      previousHeld = holds;
      settleLooks += 1;
      if (!holds) await host.wait(enterSettleMs);
      screen = await host.read(pane);
      continue;
    }
    if (!holds) {
      return { delivered: false, typed: putKeys(), tries, reason: heldReason(kind, tries > 0) };
    }
    if (tries >= MAX_WAKE_ENTERS) {
      return { delivered: false, typed: putKeys(), tries, reason: `the line stayed in the box through ${String(tries)} Enters and no working screen showed` };
    }
    // Muse and Antigravity submit with Enter. The host's enter is that key, not Return.
    if (!(await host.enter(pane))) {
      return { delivered: false, typed: putKeys(), tries, reason: 'the pane did not take the Enter; no further Enter was pressed' };
    }
    tries += 1;
    // One bounded ack settle before the first look at what the Enter did: a read taken at zero
    // delay sees the row before the key has been drawn, which is what made the walk press a
    // second Enter and then wait a poll. The look itself classifies the outcome.
    await host.wait(ackSettleMs);
    const after = await host.read(pane);
    observe(after);
    if (after !== null) {
      const working = readScreen(cli, after).kind === 'working';
      const holds = boxHoldsText(cli, line, after);
      if (working && !holds) {
        return { delivered: true, typed: putKeys(), tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
      }
      // The line still sitting, with no working screen, means the submit did not take. Press
      // again, still bounded by MAX_WAKE_ENTERS. Do not type the line a second time.
      if (!working && holds) {
        screen = after;
        continue;
      }
    }
    const ack = await pollSubmitted(host, pane, cli, line, pollMs, verifyMs, observe);
    if (ack === 'submitted') {
      return { delivered: true, typed: putKeys(), tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    if (ack === 'held') {
      return { delivered: false, typed: putKeys(), tries, reason: stillHeldReason(tries) };
    }
    screen = await host.read(pane);
  }
}

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
import { paneRead, pressEnter, typeText } from '../herdr.ts';
import { boxHoldsText } from '../launch/deliver.ts';
import { readScreen } from '../watch/screen.ts';
import { POLL_MS, SETTLE_MS } from './native.ts';

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
  read(pane: string): string | null;
  /** Types `text` once. False when the pane did not take it. */
  type(pane: string, text: string): boolean;
  /** One Enter. False when the key was not taken. */
  enter(pane: string): boolean;
  wait(ms: number): Promise<void>;
};

/** The real pane operations, bound to one session name. This is the only host in the build whose
 *  type and Enter are not `refuseTyping`: the typed wake is the single grant of that rule. */
export function herdrTypedWakeHost(session: string): TypedWakeHost {
  return {
    read: (pane) => paneRead(pane, WAKE_LINES, session),
    type: (pane, text) => typeText(pane, text, session),
    enter: (pane) => pressEnter(pane, session),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** What one wake did. `reason` names exactly what was seen, for the walk's failure line: it is
 *  never a guess about a screen the wake did not read. */
export type TypedWakeResult = {
  /** True only when the profile's working screen showed after an Enter this wake pressed. */
  delivered: boolean;
  /** True when this wake put at least one key into the pane (the line, or an Enter). A caller
   *  that keeps a one-attempt reservation — a socket delivery's single re-wake — holds it when
   *  this is true; a caller that retries releases it either way and records this so a later
   *  report can say a wake was typed and none was confirmed. */
  typed: boolean;
  /** How many Enters were pressed. */
  tries: number;
  reason: string;
};

export type TypedWakeOptions = {
  /** The gap between the two idle reads. */
  settleMs?: number;
  /** The gap between typing the line and reading the box before Enter. */
  enterSettleMs?: number;
  /** The poll interval while waiting for the working screen. */
  pollMs?: number;
  /** How long one Enter is given to show the working screen. */
  verifyMs?: number;
};

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
): Promise<WakeAck> {
  const polls = Math.max(1, Math.ceil(verifyMs / pollMs));
  let sawWorkingWhileHeld = false;
  let lastHolds = false;
  for (let i = 0; i < polls; i += 1) {
    await host.wait(pollMs);
    const screen = host.read(pane);
    if (screen === null) continue;
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
 * profile's working screen. Both idle reads happen before any key goes out, spaced by a settle:
 * a pane that is working, holds unsent text, shows a dialog or cannot be read is refused with
 * nothing typed. After the line is typed, Enter is pressed only into a box that reads back as
 * exactly that line; a box that is empty, holds other text or cannot be read gets no Enter.
 * Muse and Antigravity submit with Enter, not Return, and the first Enter waits until two
 * reads show that same drawn line. After an Enter, a box that still holds exactly the line
 * and shows no working screen is pressed again, up to `MAX_WAKE_ENTERS`, and the line is
 * never typed a second time. After an Enter, a working screen that still holds the line is
 * not a submission: the wake keeps polling for `verifyMs` until the box empties, and delivers
 * only then. The bound ending with the line still in the box is not delivered, and the line
 * is not typed again.
 */
export async function deliverTypedWake(
  host: TypedWakeHost,
  pane: string,
  line: string,
  cli: string,
  options: TypedWakeOptions = {},
): Promise<TypedWakeResult> {
  const settleMs = options.settleMs ?? SETTLE_MS;
  const enterSettleMs = options.enterSettleMs ?? WAKE_ENTER_SETTLE_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const verifyMs = options.verifyMs ?? WAKE_VERIFY_MS;
  const first = seenOf(cli, host.read(pane));
  if (first !== 'idle') {
    return { delivered: false, typed: false, tries: 0, reason: `the first read showed ${first}, not an empty idle prompt; nothing was typed` };
  }
  await host.wait(settleMs);
  const second = seenOf(cli, host.read(pane));
  if (second !== 'idle') {
    return { delivered: false, typed: false, tries: 0, reason: `the second read showed ${second}, not an empty idle prompt; nothing was typed` };
  }
  if (!host.type(pane, line)) {
    return { delivered: false, typed: false, tries: 0, reason: 'the pane did not take the line; nothing was typed' };
  }
  await host.wait(enterSettleMs);
  let tries = 0;
  let screen = host.read(pane);
  let previous: string | null = null;
  let settleLooks = 0;
  const heldReason = (kind: string, pressed: boolean): string => {
    const why = kind === 'unsent' ? 'the box held text other than the line' : `the screen read ${kind}`;
    return pressed ? `${why} and no working screen showed` : `${why} after the line was typed; no Enter was pressed`;
  };
  for (;;) {
    if (screen === null) {
      return {
        delivered: false,
        typed: true,
        tries,
        reason: tries === 0
          ? 'the screen could not be read after the line was typed; no Enter was pressed'
          : 'the screen could not be read and no working screen showed; no further Enter was pressed',
      };
    }
    const kind = readScreen(cli, screen).kind;
    if (kind === 'working') {
      if (tries === 0) {
        return { delivered: false, typed: true, tries, reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed' };
      }
      if (boxHoldsText(cli, line, screen)) {
        return { delivered: false, typed: true, tries, reason: stillHeldReason(tries) };
      }
      return { delivered: true, typed: true, tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    const holds = boxHoldsText(cli, line, screen);
    // The first Enter waits until two reads draw the same line. A row that is still rendering,
    // or a row that settles on something else, is not pressed.
    if (tries === 0 && !(holds && previous === screen)) {
      if (!holds && previous === screen) {
        return { delivered: false, typed: true, tries, reason: heldReason(kind, false) };
      }
      if (settleLooks >= LINE_SETTLE_LOOKS) {
        return {
          delivered: false,
          typed: true,
          tries,
          reason: holds
            ? 'the drawn line did not settle; no Enter was pressed'
            : heldReason(kind, false),
        };
      }
      previous = screen;
      settleLooks += 1;
      await host.wait(enterSettleMs);
      screen = host.read(pane);
      continue;
    }
    if (!holds) {
      return { delivered: false, typed: true, tries, reason: heldReason(kind, tries > 0) };
    }
    if (tries >= MAX_WAKE_ENTERS) {
      return { delivered: false, typed: true, tries, reason: `the line stayed in the box through ${String(tries)} Enters and no working screen showed` };
    }
    // Muse and Antigravity submit with Enter. The host's enter is that key, not Return.
    if (!host.enter(pane)) {
      return { delivered: false, typed: true, tries, reason: 'the pane did not take the Enter; no further Enter was pressed' };
    }
    tries += 1;
    const after = host.read(pane);
    // The line still sitting, with no working screen, means the submit did not take. Press
    // again. Do not type the line a second time.
    if (after !== null && boxHoldsText(cli, line, after) && readScreen(cli, after).kind !== 'working') {
      screen = after;
      previous = after;
      continue;
    }
    const ack = await pollSubmitted(host, pane, cli, line, pollMs, verifyMs);
    if (ack === 'submitted') {
      return { delivered: true, typed: true, tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    if (ack === 'held') {
      return { delivered: false, typed: true, tries, reason: stillHeldReason(tries) };
    }
    screen = host.read(pane);
    previous = screen;
  }
}

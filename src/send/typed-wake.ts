// The typed wake: one line, one guarded Enter, one acknowledgement. A profile that declares
// `typed_wake: screen` lets a send type one trigger line into a composer two reads showed as the
// empty idle prompt; Enter is pressed only while the box still holds exactly that line, and the
// send is delivered only when the profile's own working screen shows. Nothing else is typed: no
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

/** How long after the line is typed the box is read before the first Enter: the CLI has to have
 *  drawn the line, or the guard below would see an empty box and press nothing. */
export const WAKE_ENTER_SETTLE_MS = 250;

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

/** The working screen, polled for `verifyMs` at `pollMs`. A read that cannot be taken is not a
 *  working screen: the wake never claims an acknowledgement it did not see. */
async function pollWorking(host: TypedWakeHost, pane: string, cli: string, pollMs: number, verifyMs: number): Promise<boolean> {
  const polls = Math.max(1, Math.ceil(verifyMs / pollMs));
  for (let i = 0; i < polls; i += 1) {
    await host.wait(pollMs);
    const screen = host.read(pane);
    if (screen !== null && readScreen(cli, screen).kind === 'working') return true;
  }
  return false;
}

/**
 * Types one trigger line into the profile's idle composer and presses Enter, then waits for the
 * profile's working screen. Both idle reads happen before any key goes out, spaced by a settle:
 * a pane that is working, holds unsent text, shows a dialog or cannot be read is refused with
 * nothing typed. After the line is typed, Enter is pressed only into a box that reads back as
 * exactly that line; a box that is empty, holds other text or cannot be read gets no Enter. Each
 * Enter is given `verifyMs` for the working screen, and the wake is delivered only when that
 * screen shows; up to `MAX_WAKE_ENTERS` Enters are tried, each still guarded by the box. The same
 * screen that would let a second Enter in is also what stops one: once the line has left the box,
 * nothing more is pressed.
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
    return { delivered: false, tries: 0, reason: `the first read showed ${first}, not an empty idle prompt; nothing was typed` };
  }
  await host.wait(settleMs);
  const second = seenOf(cli, host.read(pane));
  if (second !== 'idle') {
    return { delivered: false, tries: 0, reason: `the second read showed ${second}, not an empty idle prompt; nothing was typed` };
  }
  if (!host.type(pane, line)) {
    return { delivered: false, tries: 0, reason: 'the pane did not take the line; nothing was typed' };
  }
  await host.wait(enterSettleMs);
  let tries = 0;
  let screen = host.read(pane);
  for (;;) {
    if (screen === null) {
      return {
        delivered: false,
        tries,
        reason: tries === 0
          ? 'the screen could not be read after the line was typed; no Enter was pressed'
          : 'the screen could not be read and no working screen showed; no further Enter was pressed',
      };
    }
    const kind = readScreen(cli, screen).kind;
    if (kind === 'working') {
      if (tries === 0) {
        return { delivered: false, tries, reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed' };
      }
      return { delivered: true, tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    if (!boxHoldsText(cli, line, screen)) {
      const why = kind === 'unsent' ? 'the box held text other than the line' : `the screen read ${kind}`;
      return {
        delivered: false,
        tries,
        reason: tries === 0
          ? `${why} after the line was typed; no Enter was pressed`
          : `${why} and no working screen showed`,
      };
    }
    if (tries >= MAX_WAKE_ENTERS) {
      return { delivered: false, tries, reason: `the line stayed in the box through ${String(tries)} Enters and no working screen showed` };
    }
    if (!host.enter(pane)) {
      return { delivered: false, tries, reason: 'the pane did not take the Enter; no further Enter was pressed' };
    }
    tries += 1;
    if (await pollWorking(host, pane, cli, pollMs, verifyMs)) {
      return { delivered: true, tries, reason: `the working screen showed after ${String(tries)} Enter${tries === 1 ? '' : 's'}` };
    }
    screen = host.read(pane);
  }
}

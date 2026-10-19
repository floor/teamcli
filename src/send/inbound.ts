// The receiving seat's own declaration that it accepts cross-session socket frames.
//
// A Claude Code session surfaces a frame from another session only when its own top-level
// setting `crossSessionInbound` is `accept`; `hold`, `refuse` and unset either hold the frame
// at a dialog or drop it, and a held frame blocks the receiving seat's box until a person lets
// it through. A sender that dials on its own guess would do that to a seat that never agreed,
// so the walk reads the EFFECTIVE settings the session was launched with and dials on `accept`
// alone. Nothing under an owner CLI home is ever opened.
//
// Effective precedence, matching the argv the CLI actually receives:
//   - `launchCommand` appends this build's generated per-seat settings file at the END of the
//     launch line (`--settings <file>`) unless the line already names its own `--settings`, and
//     a CLI keeps the LAST settings flag. That generated file is therefore the effective word
//     whenever it was written. It merges the wrapper's declared word with the hooks
//     (`src/launch/cli-hook.ts`); when the file declares nothing, the setting is UNSET for the
//     session — a wrapper's earlier `accept` was overridden and must not be dialed through.
//   - When the generated file is not on the line (the launch sets its own settings, or has
//     none), the effective word is the last script the launch names that hands the CLI a
//     settings flag: an inline JSON value is parsed as written, a path is read as a JSON file.
//
// The file the effective word came from keeps its modification time: a session started before
// that file changed was launched without the setting in force, and the socket it exposes is
// older than the declaration. `inboundIsLive` compares the two so a not-yet-restarted seat is
// skipped rather than sent a frame its session would hold.
import { lstatSync } from 'node:fs';
import { cliHookSettingsPath, setsSettings } from '../launch/cli-hook.ts';
import {
  inboundPolicyOf, launchWords, readDeclarationText, wrapperInboundOf, type CrossSessionInbound,
} from '../launch/declaration.ts';

export { inboundPolicyOf, launchWords, type CrossSessionInbound };

/** The declaration read from the receiving seat's launch, and where it came from. */
export type InboundDeclaration = {
  policy: CrossSessionInbound | null;
  /** When the file that carried the declaration last changed, or null with no declaration. */
  declaredAt: number | null;
  /** The file the declaration came from, for a person to inspect; null when nothing declared one. */
  source: string | null;
};

const NONE: InboundDeclaration = { policy: null, declaredAt: null, source: null };

/** The declaration a JSON settings file holds, or null when it holds none. */
function policyAt(path: string): CrossSessionInbound | null {
  // The generated file is this run's own regular file, read as a declaration: a link, another
  // owner or an unreadable file declares nothing (`readDeclarationText` enforces that).
  const text = readDeclarationText(path);
  if (text === null) return null;
  try {
    return inboundPolicyOf(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** The modification time of the file a declaration came from, or null. */
function mtimeOf(path: string): number | null {
  try {
    const held = lstatSync(path);
    return held.isFile() ? held.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * The declaration in force for the receiving seat, by the session's effective settings.
 *
 * The generated per-seat file, when it is on the launch line, is the LAST `--settings` the CLI
 * receives and therefore the whole effective word: its declared value, or unset when it declares
 * none. An unset generated file is never passed over for a wrapper's `accept` — dialing on that
 * text would hold the frame at the receiver, which is the failure this reading exists to avoid.
 * With no generated file on the line, the last script the line names that sets a settings flag
 * is the effective word.
 */
export function declaredInboundOf(input: {
  /** The receiving team's state folder (the folder holding the team file). */
  dir: string;
  /** The receiving team's root, for a relative script in the launch line. */
  root: string;
  session: string;
  seat: string;
  launch?: string;
}): InboundDeclaration {
  const launch = input.launch ?? '';
  const settings = cliHookSettingsPath(input.dir, input.session, input.seat);
  if (settings !== null && !setsSettings(launch)) {
    const at = mtimeOf(settings);
    // The file is on the line: its own word decides, including "no word at all".
    if (at !== null) return { policy: policyAt(settings), declaredAt: at, source: settings };
  }
  if (launch !== '') {
    const word = wrapperInboundOf({ root: input.root, launch });
    if (word.source !== null) {
      return { policy: word.policy, declaredAt: word.declaredAt, source: word.source };
    }
  }
  return NONE;
}

/**
 * Whether the running session was launched with the declaration in force: the socket it exposes
 * must not predate the file that declares `accept`. A session older than its launcher's change
 * was started without the setting, and a frame sent to it would be held; the walk skips it and
 * says why. A socket this run cannot stat is not a proof of staleness, so the declaration stands.
 */
export function inboundIsLive(declaration: InboundDeclaration, socketPath: string): boolean {
  if (declaration.policy !== 'accept' || declaration.declaredAt === null) return true;
  try {
    return lstatSync(socketPath).mtimeMs >= declaration.declaredAt;
  } catch {
    return true;
  }
}

/** The line a walk records instead of dialing, by the declaration it read. */
export function inboundSkipReason(policy: CrossSessionInbound | null): string {
  if (policy === 'hold') return 'the receiving Claude session declares crossSessionInbound hold, which would hold the frame at its box';
  if (policy === 'refuse') return 'the receiving Claude session declares crossSessionInbound refuse';
  return 'the receiving Claude session does not declare crossSessionInbound accept';
}

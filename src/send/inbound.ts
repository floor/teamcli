// The receiving seat's own declaration that it accepts cross-session socket frames.
//
// The launch's effective word decides a dial, and the team file's word may narrow it. A Claude
// Code session surfaces a frame from another session only when its own top-level setting
// `crossSessionInbound` is `accept`; `hold`, `refuse` and unset either hold the frame at a dialog
// or drop it, and a held frame blocks the receiving seat's box until a person lets it through. A
// sender that dials on its own guess would do that to a seat that never agreed, so the walk reads
// the EFFECTIVE settings the session was launched with and dials on `accept` alone. Nothing under
// an owner CLI home is ever opened.
//
// Authorization. A seat TeamCLI launched carries this build's own generated settings file on its
// line; that file is TeamCLI's authorization, and the launch's `accept` is enough on its own — no
// team-file `inbound` line is needed. An explicit team-file `inbound: hold` or `refuse` still
// wins and keeps the socket out, and a session launched some other way (no generated file on the
// line) still needs the team file's `inbound: accept`: this build did not attest that launch.
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
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliHookSettingsPath, setsSettings } from '../launch/cli-hook.ts';
import {
  inboundPolicyOf, launchWords, readDeclarationText, wrapperInboundOf, type CrossSessionInbound,
} from '../launch/declaration.ts';
import { writeAtomic } from '../state.ts';

export { inboundPolicyOf, launchWords, type CrossSessionInbound };

/** The declaration read from the receiving seat's launch, and where it came from. */
export type InboundDeclaration = {
  policy: CrossSessionInbound | null;
  /** When the file that carried the declaration last changed, or null with no declaration. */
  declaredAt: number | null;
  /** The file the declaration came from, for a person to inspect; null when nothing declared one. */
  source: string | null;
  /** True when the word came from the generated per-seat file this build's launcher appends:
   *  TeamCLI attested the launch, and the launch's `accept` authorizes the socket by itself. */
  generated?: boolean;
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
    if (at !== null) return { policy: policyAt(settings), declaredAt: at, source: settings, generated: true };
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

/**
 * Whether a receiver is eligible for the socket leg at all. The launch's effective settings must
 * declare `crossSessionInbound: accept` — that is what the receiving CLI needs to take the frame,
 * and a session this build did not launch some other way still needs it. On top of that:
 *   - an explicit team-file `inbound: accept` authorizes any launch;
 *   - an explicit team-file `hold` or `refuse` always keeps the socket out, the documented opt-out;
 *   - with no team-file word at all, only a launch over this build's generated settings file is
 *     authorized by default: TeamCLI launched that seat, and the launch word is its attestation.
 */
export function socketEligible(
  teamWord: CrossSessionInbound | undefined,
  declaration: InboundDeclaration,
): boolean {
  if (declaration.policy !== 'accept') return false;
  if (teamWord === 'hold' || teamWord === 'refuse') return false;
  if (teamWord === 'accept') return true;
  return teamWord === undefined && declaration.generated === true;
}

/** The line a walk records instead of dialing, by both words: the team file's explicit opt-out
 *  first, then the launch's own declaration, then the team-file word a non-attested launch needs. */
export function socketSkipReason(
  teamWord: CrossSessionInbound | undefined,
  declaration: InboundDeclaration,
): string {
  if (teamWord === 'hold' || teamWord === 'refuse') {
    return `the receiving seat's team file declares inbound ${teamWord}`;
  }
  if (declaration.policy !== 'accept') return inboundSkipReason(declaration.policy);
  return "the receiving seat's team file does not declare inbound accept";
}

/**
 * Precise diagnostic reason why a Claude receiver's cross-session socket is skipped or refused,
 * distinguishing an explicit team-file hold/refuse, generated hook settings without
 * `crossSessionInbound`, human-launched / wrapper launches without `--settings` (where owner
 * CLI settings under `~/.claude` are never read), and an unattested launch whose team file omits
 * `inbound: accept`.
 */
export function preciseSocketSkipReason(
  teamWord: CrossSessionInbound | undefined,
  declaration: InboundDeclaration,
): string {
  if (teamWord === 'hold' || teamWord === 'refuse') {
    return `the receiving seat's team file declares inbound ${teamWord}`;
  }
  if (declaration.policy === 'hold') {
    return inboundSkipReason('hold');
  }
  if (declaration.policy === 'refuse') {
    return inboundSkipReason('refuse');
  }
  if (declaration.policy !== 'accept') {
    if (declaration.source !== null) {
      return `the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${declaration.source}); owner CLI settings are not read`;
    }
    return 'the receiving Claude session does not declare crossSessionInbound accept (human-launched or launch without --settings; owner CLI settings are not read)';
  }
  return "the receiving seat's team file does not declare inbound accept";
}

/** The mark a held frame leaves: when the box held it, and the declaration in force then. */
export type HeldSocket = Readonly<{ at: string; declaredAt: number | null; source: string | null }>;

/**
 * Where a held frame is remembered: the receiving team's state folder, beside the drop queue and
 * never inside it, so the seat's reader (`team messages`, an inbox server) never sees the mark as
 * a message.
 */
export function heldSocketPath(dir: string, session: string, seat: string): string {
  return join(dir, 'send-held', session, `${seat}.json`);
}

/** The mark a previous hold left, or null. Another user's file, a link, an oversized file and
 *  anything that does not parse are no mark: the safest reading is to dial as before. */
export function readHeldSocket(path: string): HeldSocket | null {
  try {
    const held = lstatSync(path);
    if (!held.isFile() || held.size > 4096) return null;
    if (process.getuid !== undefined && held.uid !== process.getuid()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HeldSocket> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
    if (parsed.declaredAt !== null && typeof parsed.declaredAt !== 'number') return null;
    if (parsed.source !== null && typeof parsed.source !== 'string') return null;
    return { at: parsed.at, declaredAt: parsed.declaredAt ?? null, source: parsed.source ?? null };
  } catch {
    return null;
  }
}

/** Record that the seat's box held a frame from the socket, with the declaration in force. A
 *  marker that cannot be written never fails the send: the hold has already happened, and the
 *  walk's own line says so. */
export function recordHeldSocket(path: string, declaration: InboundDeclaration, now: Date): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mark = { at: now.toISOString(), declaredAt: declaration.declaredAt, source: declaration.source };
    writeAtomic(path, `${JSON.stringify(mark, null, 2)}\n`);
    chmodSync(path, 0o600);
  } catch {
    // See above: the marker is a retry guard, never the record of the message.
  }
}

/**
 * Why the socket must not be dialed again, or null. A hold stands until the declaration it was
 * held under is re-confirmed: the same file rewritten, or another settings file read, both carry
 * a value that differs from the mark. A declaration that has not moved is not re-confirmed, and
 * the retry waits.
 */
export function socketHeldReason(held: HeldSocket | null, declaration: InboundDeclaration): string | null {
  if (held === null) return null;
  const reconfirmed = declaration.declaredAt !== null
    && (declaration.source !== held.source || declaration.declaredAt !== held.declaredAt);
  if (reconfirmed) return null;
  return 'its last socket frame was held at its box, and its declaration has not been re-confirmed since; restart its CLI host so it accepts';
}

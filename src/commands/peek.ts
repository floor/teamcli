import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { isOwner, logTag, walkCaller } from '../caller.ts';
import type { DelegateSources } from '../delegate.ts';
import { devModeCallerGate, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { currentTeam } from '../file/current.ts';
import { withoutFileOffer } from '../file/load.ts';
import { maskSecretsLine } from '../file/secrets.ts';
import type { Problem } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { mayReadTeam } from '../read-gate.ts';
import { readState } from '../state.ts';
import { herdrStatusSource, type StatusSource, type StatusWaitSeat } from '../watch/status-events.ts';

export const USAGE = `Usage: team peek <seat> [--lines <n>]

Prints the last lines of a seat's screen: 50 by default, 1 to 500 with --lines. It reads the
screen and sends nothing — no text, no key and no turn. A line that looks like a credential is
masked before it is printed, and the audit log records the caller, the seat and the line count,
never the text.

Exits 0 when the screen is printed, 1 when the peek is refused, 2 when the invocation or team
file can't be read, or no screen is readable.
`;

/** The screen's last lines when --lines is not given. */
export const DEFAULT_LINES = 50;
/** The most lines one peek prints; more is a usage error, not a truncated screen. */
export const MAX_LINES = 500;

// What `team peek` reads from outside the file and the state, so tests can stand in for it.
export type PeekSources = {
  now(): Date;
  /** The home `currentTeam` loads the file against. Absent in a test that does not set one. */
  home?: string;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
  /** The read-only screen source. The real one, on the team's own session, when absent. */
  source?: StatusSource;
};

export const realPeekSources: PeekSources = {
  now: () => new Date(),
  home: homedir(),
};

export const peek: Command = (argv, io) => runPeek(argv, io, realPeekSources);
export default peek;

/**
 * `team peek <seat> [--lines <n>]` — the last lines of a seat's screen, read and printed, never
 * typed into. The screen is read through the read-only StatusSource only: this module's whole
 * import list is a read path, and a static scene holds it to that list. The seat resolves by name
 * from the team's record, never by a raw pane id: a seat the record does not declare is an
 * unknown seat, a seat the file marks `human: true` is the owner's pane and is never read.
 *
 * Who may look: the owner, a seat the read gate places on its recorded pane, an approved delegate
 * pane, or — while dev mode is on — the same caller the other dev-mode lifts admit (the warning
 * and its audit line are printed and written as everywhere else). A general grant carrying
 * `peek` reaches the command through the dispatcher's door, which makes the run the owner's.
 *
 * Every peek after the file loads is logged: a success with the caller, the seat and the line
 * count, and a refusal with the caller, the seat as asked and its exit id. The screen's text is
 * never logged. A refusal before the file loads (a bad invocation, a file that will not read)
 * writes no line, because there is no team folder to write it in.
 */
export async function runPeek(argv: string[], io: Io, sources: PeekSources = realPeekSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['lines'], []);
  if (args.error) return invocation(out, args.error);
  const [name, extra] = args.rest;
  if (name === undefined) return invocation(out, 'a <seat> is required');
  if (extra !== undefined) return invocation(out, `unexpected "${plainLine(extra)}"`);
  const lines = parseLines(args.values.lines);
  if (lines === null) return invocation(out, `--lines is a whole number from 1 to ${MAX_LINES}`);

  const at = sources.now();
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  const tag = logTag(walked);
  const current = currentTeam(io.cwd, undefined, at, sources.home, false);
  if (!current.ok) {
    if (owner) return fileProblems(out, current.errors);
    // Before the file loads there is no team folder to log in, and the unapproved caller learns
    // no detail: the same one sentence status gives, without a line.
    return refuseNotYours(out, at, null, tag);
  }

  const { team, dir } = current;
  const dev = resolveDevMode('peek', io, { team, root: current.root, now: at, ...(sources.home !== undefined ? { home: sources.home } : {}) });
  logDevModeState(dir, 'peek', tag, dev, at);
  let admitted = owner || mayReadTeam(current, io, { ...(sources.home !== undefined ? { home: sources.home } : {}), ...(sources.gate !== undefined ? { gate: sources.gate } : {}) });
  if (!admitted) {
    const folded = devModeCallerGate(dev, 'this team is not yours to read');
    if (folded !== null) {
      out.stderr(`${folded}\n`);
      logDevMode(dir, 'peek', tag, folded, at);
      admitted = true;
    }
  }
  if (!admitted) return refuseNotYours(out, at, dir, tag);

  const seat = team.seats.find((held) => held.name === name);
  if (seat === undefined) return refuseUnknown(out, dir, tag, name, at);
  if (seat.human === true) return refuseOwnerPane(out, dir, tag, name, at);

  const recorded = readState(dir).sessions[team.session]?.seats[seat.name]?.pane;
  const source = sources.source ?? herdrStatusSource({ session: team.session });
  if (recorded === undefined || source.screenText === undefined) return refuseNoScreen(out, dir, tag, name, at);
  const reading: StatusWaitSeat = { name: seat.name, pane: recorded, cli: seat.cli, session: team.session };
  const raw = source.screenText(reading, lines);
  if (raw === null) return refuseNoScreen(out, dir, tag, name, at);

  const screen = visibleLines(raw, lines);
  for (const line of screen) out.stdout(`${maskSecretsLine(plainText(line))}\n`);
  logLine(dir, 'peek', tag, `team ${plainLine(team.project)}: seat ${plainLine(seat.name)}, ${count(screen.length)}`, at);
  // exit: peek.shown
  return 0;
}

/** The `--lines` reading: the default, a whole number from 1 to the maximum, or null. */
function parseLines(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_LINES;
  if (!/^[0-9]+$/.test(value)) return null;
  const asked = Number(value);
  return asked >= 1 && asked <= MAX_LINES ? asked : null;
}

/** The screen's last `lines` lines, without the one empty tail a trailing line break makes. */
function visibleLines(screen: string, lines: number): string[] {
  const parts = screen.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.slice(-lines);
}

function count(lines: number): string {
  return lines === 1 ? '1 line' : `${lines} lines`;
}

function invocation(io: Io, message: string): number {
  io.stderr(`team peek: ${plainText(message)}\n${USAGE}`);
  // exit: peek.invocation
  return 2;
}

function fileProblems(io: Io, problems: Problem[]): number {
  for (const problem of problems) {
    io.stderr(`team peek: ${problem.line ? `team config line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}\n`);
  }
  // exit: peek.file
  return 2;
}

/** The one refusal the pre-load path and the unadmitted caller share. A null `dir` is a run
 *  before the file loaded, where the team folder does not exist yet and nothing is written. */
function refuseNotYours(io: Io, at: Date, dir: string | null, caller: string): number {
  io.stderr('team peek: this team is not yours to read\n');
  if (dir !== null) logLine(dir, 'peek', caller, 'refused peek.not-yours: this team is not yours to read', at);
  // exit: peek.not-yours
  return 2;
}

function refuseUnknown(io: Io, dir: string, caller: string, name: string, at: Date): number {
  io.stderr(`team peek: no seat named "${plainLine(name)}" in this team\n`);
  logLine(dir, 'peek', caller, `refused peek.unknown: seat ${plainLine(name)}`, at);
  // exit: peek.unknown
  return 1;
}

function refuseOwnerPane(io: Io, dir: string, caller: string, name: string, at: Date): number {
  io.stderr(`team peek: "${plainLine(name)}" is the owner's pane, and the owner's pane is never read\n`);
  logLine(dir, 'peek', caller, `refused peek.owner-pane: seat ${plainLine(name)}`, at);
  // exit: peek.owner-pane
  return 1;
}

function refuseNoScreen(io: Io, dir: string, caller: string, name: string, at: Date): number {
  io.stderr(`team peek: no screen is readable for seat "${plainLine(name)}"\n`);
  logLine(dir, 'peek', caller, `refused peek.no-screen: seat ${plainLine(name)}`, at);
  // exit: peek.no-screen
  return 2;
}

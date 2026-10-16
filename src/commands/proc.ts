import { homedir } from 'node:os';
import { readArgs, type Args } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner, judgeCallerOf, walkCaller } from '../caller.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import type { Problem } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { validLockName } from '../lock/machine.ts';
import { mayReadTeam } from '../read-gate.ts';
import { emptySession, liveProcs, pidAlive, pruneProcs, readState, updateState } from '../state.ts';

export const USAGE = `Usage: team proc add <name> [--pid <pid>] [--note <text>]
       team proc list [--json]
       team proc done <name>
`;

// What `team proc` reads from outside the file and the state, so tests can stand in for it.
export type ProcSources = {
  now(): Date;
  /** The home `currentTeam` loads the file against. Absent in a test that does not set one. */
  home?: string;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
  /** Whether a recorded pid names a live process. The real reading when absent. */
  alive?(pid: number): boolean;
};

export const realProcSources: ProcSources = {
  now: () => new Date(),
  home: homedir(),
};

export const proc: Command = (argv, io) => runProc(argv, io, realProcSources);
export default proc;

/**
 * `team proc` — the registry of the processes a team's seats started. `add` records one for the
 * calling seat (or the owner), with the pid to watch and one line about what it is; `list`
 * prints the live ones; `done` clears a record. Nothing here launches, stops or signals a
 * process, and liveness is a reading: a record whose pid is gone is skipped where it is read,
 * and the next write to the map takes it out of the file. `team lock` is a machine-wide named
 * lock — a different thing, and the docs page keeps the two apart.
 */
export async function runProc(argv: string[], io: Io, sources: ProcSources = realProcSources): Promise<number> {
  const out = cleanedIo(io);
  const alive = sources.alive ?? pidAlive;
  // One parse for all three verbs — the command contract reads a single `readArgs` call — and
  // each verb refuses the flags that are not its own (below) rather than reading them silently.
  const args = readArgs(argv, ['pid', 'note'], ['json']);
  if (args.error) return invocation(out, args.error);
  const verb = args.rest[0];
  const rest = args.rest.slice(1);
  if (verb === 'add') return add(rest, args, out, sources, alive);
  if (verb === 'list') return list(rest, args, out, sources, alive);
  if (verb === 'done') return done(rest, args, out, sources, alive);
  return invocation(out, verb === undefined ? 'a subcommand is required' : `unexpected "${plainLine(verb)}"`);
}

function invocation(io: Io, message: string): number {
  io.stderr(`team proc: ${message}\n${USAGE}`);
  // exit: proc.invocation
  return 2;
}

function nameProblem(name: string): string {
  return `"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`;
}

function fileProblems(io: Io, problems: Problem[]): number {
  for (const problem of problems) {
    io.stderr(`team proc: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
  // exit: proc.file
  // exit: proc.file-invalid
  return 2;
}

function refuseDetached(io: Io, sentence: string): number {
  io.stderr(`team proc: ${sentence}\n`);
  // exit: proc.detached
  return 1;
}

function refuseNotYours(io: Io): number {
  io.stderr('team proc: this team is not yours to read\n');
  // exit: proc.not-yours
  return 2;
}

function refuseCaller(io: Io, shown: string): number {
  io.stderr(`team proc: only a seat of this team or the owner records a process; this call is ${shown}\n`);
  // exit: proc.caller
  return 1;
}

function refusePid(io: Io, pid: number): number {
  io.stderr(`team proc: pid ${pid} is not running\n`);
  // exit: proc.pid
  return 1;
}

function refuseTaken(io: Io, name: string, by: string, at: string): number {
  io.stderr(`team proc: "${name}" is ${by}'s, live since ${at}\n`);
  // exit: proc.taken
  return 1;
}

function refuseUnknown(io: Io, name: string): number {
  io.stderr(`team proc: no process named "${name}"\n`);
  // exit: proc.unknown
  return 1;
}

function refuseOtherSeat(io: Io, name: string, by: string): number {
  io.stderr(by === 'owner'
    ? `team proc: "${name}" is the owner's; only the owner clears it\n`
    : `team proc: "${name}" is ${by}'s; only ${by}, a lead or the owner clears it\n`);
  // exit: proc.other-seat
  return 1;
}

/**
 * `team proc add <name> [--pid <pid>] [--note <text>]` — records the calling seat's process.
 * The caller is a seat the file declares, or the owner: a placement the team's session does not
 * hold, a pane with no agent, and a seat of another team are refused. A name another seat holds
 * and whose process is still alive is refused too; the same seat re-adding its own name replaces
 * the record, and one whose pid is gone is replaced for anyone.
 */
function add(rest: string[], args: Args, io: Io, sources: ProcSources, alive: (pid: number) => boolean): number | Promise<number> {
  const [name, extra] = rest;
  if (name === undefined) return invocation(io, 'a <name> is required');
  if (extra !== undefined) return invocation(io, `unexpected "${plainLine(extra)}"`);
  if (args.flags.has('json')) return invocation(io, 'add takes no --json');
  if (!validLockName(name)) return invocation(io, nameProblem(name));

  const detached = detachedRefusal(callerOf(io));
  if (detached !== undefined) return refuseDetached(io, detached);

  let pid: number | undefined;
  if (args.values.pid !== undefined) {
    if (!/^[1-9][0-9]*$/.test(args.values.pid)) return invocation(io, '--pid is a whole number above zero, the process to watch');
    pid = Number(args.values.pid);
    if (!alive(pid)) return refusePid(io, pid);
  }
  const note = args.values.note !== undefined ? plainLine(args.values.note).trim() : undefined;

  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!current.ok) return fileProblems(io, current.errors);
  if (current.notice) io.stdout(`${current.notice}\n`);
  const { caller, shown } = judgeCallerOf(io, current.team.session);
  const seat = caller.kind === 'seat' && current.team.seats.some((held) => held.name === caller.name) ? caller.name : undefined;
  if (caller.kind !== 'owner' && seat === undefined) return refuseCaller(io, describeCaller(shown));

  const by = seat ?? 'owner';
  const session = current.team.session;
  const at = sources.now().toISOString();
  // One write, under the lock: the dead records go first (this is the write that takes them out
  // of the file), then the name is checked against what is left, so only a live name of another
  // seat refuses. The refusal returns before the edit; what it leaves is the prune, which is the
  // same state a reader already showed.
  const taken = updateState(current.dir, (state) => {
    const held = (state.sessions[session] ??= emptySession());
    pruneProcs(held, alive);
    const prior = held.procs?.[name];
    if (prior !== undefined && prior.by !== by) return prior;
    (held.procs ??= {})[name] = { by, at, ...(pid !== undefined ? { pid } : {}), ...(note ? { note } : {}) };
    return undefined;
  });
  if (taken !== undefined) return refuseTaken(io, name, taken.by, taken.at);
  io.stdout(`proc ${name}: added\n`);
  // exit: proc.added
  return 0;
}

/**
 * `team proc list [--json]` — the live records of this team's session, in name order. It reads
 * what `team status` reads, through the same gate: a team that is not the caller's to read is
 * refused in status's own words.
 */
function list(rest: string[], args: Args, io: Io, sources: ProcSources, alive: (pid: number) => boolean): number {
  const [extra] = rest;
  if (extra !== undefined) return invocation(io, `unexpected "${plainLine(extra)}"`);
  if (args.values.pid !== undefined || args.values.note !== undefined) return invocation(io, 'list takes no --pid or --note');

  const owner = isOwner(walkCaller(io));
  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, sources)) return refuseNotYours(io);
  } else if (!current.ok) {
    return fileProblems(io, current.errors);
  }
  if (current.notice) io.stdout(`${current.notice}\n`);

  const state = readState(current.dir);
  const session = state.sessions[current.team.session] ?? emptySession();
  const rows = liveProcs(session, alive);
  if (args.flags.has('json')) {
    io.stdout(`${JSON.stringify({ format: 1, procs: rows.map(([name, held]) => ({ name, ...held })) }, null, 2)}\n`);
  } else if (rows.length === 0) {
    io.stdout('no processes recorded\n');
  } else {
    for (const [name, held] of rows) {
      io.stdout(`${name}  ${held.by}  since ${held.at}${held.pid !== undefined ? `  pid ${held.pid}` : ''}${held.note ? `  ${held.note}` : ''}\n`);
    }
  }
  // exit: proc.listed
  return 0;
}

/**
 * `team proc done <name>` — clears a record, live or not. The caller may clear its own, the
 * owner may clear any, and the team's orchestrator or operator seat may clear what a seat that
 * is gone left behind: a lead is the one who tidies after a swap.
 */
function done(rest: string[], args: Args, io: Io, sources: ProcSources, alive: (pid: number) => boolean): number {
  const [name, extra] = rest;
  if (name === undefined) return invocation(io, 'a <name> is required');
  if (extra !== undefined) return invocation(io, `unexpected "${plainLine(extra)}"`);
  if (args.flags.has('json')) return invocation(io, 'done takes no --json');
  if (!validLockName(name)) return invocation(io, nameProblem(name));

  const detached = detachedRefusal(callerOf(io));
  if (detached !== undefined) return refuseDetached(io, detached);

  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!current.ok) return fileProblems(io, current.errors);
  if (current.notice) io.stdout(`${current.notice}\n`);
  const { caller, shown } = judgeCallerOf(io, current.team.session);
  const seat = caller.kind === 'seat' && current.team.seats.some((held) => held.name === caller.name) ? caller.name : undefined;
  if (caller.kind !== 'owner' && seat === undefined) return refuseCaller(io, describeCaller(shown));

  const owner = caller.kind === 'owner';
  const lead = seat !== undefined && (seat === current.team.orchestrator || seat === current.team.operator);
  const session = current.team.session;
  const outcome = updateState(current.dir, (state) => {
    const held = state.sessions[session];
    const prior = held?.procs?.[name];
    if (!held || prior === undefined) return { kind: 'unknown' as const };
    // The seat that recorded it, and only it, or the owner; a lead tidies after a seat that is
    // gone, and never after the owner, whose record no seat clears.
    const mine = seat !== undefined && seat === prior.by;
    if (!owner && !mine && !(lead && prior.by !== 'owner')) return { kind: 'other' as const, by: prior.by };
    pruneProcs(held, alive);
    if (held.procs) delete held.procs[name];
    return { kind: 'done' as const };
  });
  if (outcome.kind === 'unknown') return refuseUnknown(io, name);
  if (outcome.kind === 'other') return refuseOtherSeat(io, name, outcome.by);
  io.stdout(`proc ${name}: done\n`);
  // exit: proc.done
  return 0;
}

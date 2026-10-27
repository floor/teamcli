import { homedir } from 'node:os';
import { readArgs, type Args } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner, judgeCallerOf, walkCaller } from '../caller.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import { LINK_NOT_FOLLOWED, NOT_A_REPO, withoutFileOffer } from '../file/load.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { validLockName } from '../lock/machine.ts';
import { contextLine, formatTable, hasJsonFlag, pluralCount, refuse, writeJson } from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { emptySession, liveProcs, pidAlive, pruneProcs, readState, updateState } from '../state.ts';

export const USAGE = `Usage: team proc add <name> [--pid <pid>] [--note <text>] [--json]
       team proc list [--json]
       team proc done <name> [--json]

Exits 0 when the process is recorded, listed, or cleared, 1 when the operation is refused, 2 when the invocation or team file can't be read.
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
  // Read from the raw argv before the parser runs: a bad option before `--json`, or a
  // malformed `--json=<value>`, still asks for the structured refusal.
  const json = hasJsonFlag(argv);
  if (args.error) return invocation(out, json, args.error);
  const verb = args.rest[0];
  const rest = args.rest.slice(1);
  if (verb === 'add') return add(rest, args, out, json, sources, alive);
  if (verb === 'list') return list(rest, args, out, json, sources, alive);
  if (verb === 'done') return done(rest, args, out, json, sources, alive);
  return invocation(out, json, verb === undefined ? 'a subcommand is required' : `unexpected "${plainLine(verb)}"`);
}

function invocation(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'proc', { id: 'proc.invocation', message, repair: null, usage: USAGE });
  // exit: proc.invocation
  return 2;
}

function nameProblem(name: string): string {
  return `"${plainLine(name)}" is a name, not a path: lowercase letters, digits and hyphens`;
}

/** The row of the failure: the three load failures `load.ts` writes are the unreadable file;
 *  every other problem comes from the parser or the validator. */
function fileProblemId(problems: Problem[]): 'proc.file' | 'proc.file-invalid' {
  const first = problems[0]?.message ?? '';
  const load = first === NOT_A_REPO || first === LINK_NOT_FOLLOWED || first.startsWith('no team file');
  return load ? 'proc.file' : 'proc.file-invalid';
}

function problemLine(problem: Problem): string {
  // `team proc` takes no `--file`, so the no-repository refusal must not offer one; the id
  // above still reads the untransformed message.
  return `${problem.line ? `team config line ${problem.line}: ` : ''}${withoutFileOffer(problem.message)}`;
}

function fileProblems(io: Io, json: boolean, problems: Problem[]): number {
  if (json) {
    refuse(io, true, 'proc', {
      id: fileProblemId(problems),
      message: problems.map(problemLine).join('; '),
      repair: null,
    });
  } else {
    for (const problem of problems) io.stderr(`team proc: ${problemLine(problem)}\n`);
  }
  // exit: proc.file
  // exit: proc.file-invalid
  return 2;
}

function refuseDetached(io: Io, json: boolean, sentence: string): number {
  refuse(io, json, 'proc', { id: 'proc.detached', message: sentence, repair: null });
  // exit: proc.detached
  return 1;
}

function refuseNotYours(io: Io, json: boolean): number {
  refuse(io, json, 'proc', { id: 'proc.not-yours', message: 'this team is not yours to read', repair: null });
  // exit: proc.not-yours
  return 2;
}

function refuseCaller(io: Io, json: boolean, shown: string): number {
  refuse(io, json, 'proc', {
    id: 'proc.caller',
    message: `only a seat of this team or the owner records a process; this call is ${shown}`,
    repair: null,
  });
  // exit: proc.caller
  return 1;
}

function refusePid(io: Io, json: boolean, pid: number): number {
  refuse(io, json, 'proc', { id: 'proc.pid', message: `pid ${pid} is not running`, repair: null });
  // exit: proc.pid
  return 1;
}

function refuseTaken(io: Io, json: boolean, name: string, by: string, at: string): number {
  refuse(io, json, 'proc', { id: 'proc.taken', message: `"${name}" is ${by}'s, live since ${at}`, repair: null });
  // exit: proc.taken
  return 1;
}

function refuseUnknown(io: Io, json: boolean, name: string): number {
  refuse(io, json, 'proc', { id: 'proc.unknown', message: `no process named "${name}"`, repair: null });
  // exit: proc.unknown
  return 1;
}

function refuseOtherSeat(io: Io, json: boolean, name: string, by: string): number {
  refuse(io, json, 'proc', {
    id: 'proc.other-seat',
    message: by === 'owner'
      ? `"${name}" is the owner's; only the owner clears it`
      : `"${name}" is ${by}'s; only ${by}, a lead or the owner clears it`,
    repair: null,
  });
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
function add(rest: string[], args: Args, io: Io, json: boolean, sources: ProcSources, alive: (pid: number) => boolean): number | Promise<number> {
  const [name, extra] = rest;
  if (name === undefined) return invocation(io, json, 'a <name> is required');
  if (extra !== undefined) return invocation(io, json, `unexpected "${plainLine(extra)}"`);
  if (!validLockName(name)) return invocation(io, json, nameProblem(name));

  const detached = detachedRefusal(callerOf(io), { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return refuseDetached(io, json, detached);

  let pid: number | undefined;
  if (args.values.pid !== undefined) {
    if (!/^[1-9][0-9]*$/.test(args.values.pid)) return invocation(io, json, '--pid is a whole number above zero, the process to watch');
    pid = Number(args.values.pid);
    if (!alive(pid)) return refusePid(io, json, pid);
  }
  const note = args.values.note !== undefined ? plainLine(args.values.note).trim() : undefined;

  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!current.ok) return fileProblems(io, json, current.errors);
  if (current.notice && !json) io.stdout(`${plainText(current.notice)}\n`);
  const { caller, shown } = judgeCallerOf(io, current.team.session);
  const seat = caller.kind === 'seat' && current.team.seats.some((held) => held.name === caller.name) ? caller.name : undefined;
  if (caller.kind !== 'owner' && seat === undefined) return refuseCaller(io, json, describeCaller(shown));

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
  if (taken !== undefined) return refuseTaken(io, json, name, taken.by, taken.at);
  summary(io, json, current.team, name, 'added', pid, current.notice);
  // exit: proc.added
  return 0;
}

/** One action outcome: the context line and the line it already printed in plain text, the
 *  `team.proc` action envelope under `--json`. `value` is the pid the record watches, and a
 *  fallback notice rides in the document's own member — never as a line before it. */
function summary(
  io: Io,
  json: boolean,
  team: Pick<TeamFile, 'project' | 'session'>,
  name: string,
  status: 'added' | 'done',
  pid?: number,
  notice?: string,
): void {
  const line = `proc ${name}: ${status}`;
  if (json) {
    writeJson(io, 'team.proc', {
      format: 1 as const,
      dry_run: false,
      status,
      action_summary: line,
      project: team.project,
      session: team.session,
      target: name,
      value: pid !== undefined ? String(pid) : null,
      ...(notice !== undefined ? { notice: plainText(notice) } : {}),
    });
  } else {
    io.stdout(`${contextLine(team.project, team.session)}\n${line}\n`);
  }
}

/**
 * `team proc list [--json]` — the live records of this team's session, in name order. It reads
 * what `team status` reads, through the same gate: a team that is not the caller's to read is
 * refused in status's own words.
 */
function list(rest: string[], args: Args, io: Io, json: boolean, sources: ProcSources, alive: (pid: number) => boolean): number {
  const [extra] = rest;
  if (extra !== undefined) return invocation(io, json, `unexpected "${plainLine(extra)}"`);
  if (args.values.pid !== undefined || args.values.note !== undefined) return invocation(io, json, 'list takes no --pid or --note');

  const owner = isOwner(walkCaller(io));
  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, sources)) return refuseNotYours(io, json);
  } else if (!current.ok) {
    return fileProblems(io, json, current.errors);
  }
  if (current.notice && !json) io.stdout(`${plainText(current.notice)}\n`);

  const state = readState(current.dir);
  const session = state.sessions[current.team.session] ?? emptySession();
  const rows = liveProcs(session, alive);
  if (json) {
    writeJson(io, 'team.proc', {
      format: 1 as const,
      project: current.team.project,
      session: current.team.session,
      notice: current.notice ?? null,
      procs: rows.map(([name, held]) => ({
        name,
        by: held.by,
        since: held.at,
        pid: held.pid ?? null,
        note: held.note ?? null,
      })),
      summary: { processes: rows.length },
    });
  } else {
    const table = formatTable({
      headers: ['NAME', 'BY', 'SINCE', 'PID', 'NOTE'],
      rows: rows.map(([name, held]) => [
        name,
        held.by,
        held.at,
        held.pid !== undefined ? String(held.pid) : null,
        held.note ?? null,
      ]),
    });
    io.stdout(`${contextLine(current.team.project, current.team.session)}\n${table}${pluralCount(rows.length, 'process', 'processes')}\n`);
  }
  // exit: proc.listed
  return 0;
}

/**
 * `team proc done <name>` — clears a record, live or not. The caller may clear its own, the
 * owner may clear any, and the team's orchestrator or operator seat may clear what a seat that
 * is gone left behind: a lead is the one who tidies after a swap.
 */
function done(rest: string[], args: Args, io: Io, json: boolean, sources: ProcSources, alive: (pid: number) => boolean): number {
  const [name, extra] = rest;
  if (name === undefined) return invocation(io, json, 'a <name> is required');
  if (extra !== undefined) return invocation(io, json, `unexpected "${plainLine(extra)}"`);
  if (!validLockName(name)) return invocation(io, json, nameProblem(name));

  const detached = detachedRefusal(callerOf(io), { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return refuseDetached(io, json, detached);

  const current = currentTeam(io.cwd, undefined, sources.now(), sources.home, false);
  if (!current.ok) return fileProblems(io, json, current.errors);
  if (current.notice && !json) io.stdout(`${plainText(current.notice)}\n`);
  const { caller, shown } = judgeCallerOf(io, current.team.session);
  const seat = caller.kind === 'seat' && current.team.seats.some((held) => held.name === caller.name) ? caller.name : undefined;
  if (caller.kind !== 'owner' && seat === undefined) return refuseCaller(io, json, describeCaller(shown));

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
  if (outcome.kind === 'unknown') return refuseUnknown(io, json, name);
  if (outcome.kind === 'other') return refuseOtherSeat(io, json, name, outcome.by);
  summary(io, json, current.team, name, 'done', undefined, current.notice);
  // exit: proc.done
  return 0;
}

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { TeamFile } from './file/types.ts';
import { agentList, paneRootPid } from './herdr.ts';
import type { HerdrAgent } from './herdr.ts';
import type { Io } from './io.ts';
import { readState, type SeatState } from './state.ts';
import { CLI_PROCESSES, processNameMatches } from './clis.ts';

// Who runs this command, placed by its parent processes, never by its environment. This guards
// against a mistaken agent, not a hostile one: every seat runs as the owner's user.

export type Caller =
  | { kind: 'owner' }
  // A process outside herdr whose stdin is not a terminal. It is not the owner: every owner-gated
  // act refuses it with `DETACHED_REFUSAL`. The owner at a terminal, the grant, and a delegate stay.
  | { kind: 'owner-no-tty' }
  // `session` is the session the placement was made in: the command passed it to `callerOf` and
  // the caller's pane root was found in that session's agent list. Absent when no session was
  // asked about (the caller's own server answered) and on callers a test hands in.
  | { kind: 'seat'; name: string; pane: string; session?: string }
  // An agentless herdr pane whose root process is among the caller's ancestors. The pane id
  // comes from the hint; the pid is what places it. `session` is recorded when the placement
  // was asked about one, and absent when none was.
  | { kind: 'pane'; pane: string; session?: string }
  // The watch process's own principal for a direct-work send: established internally by
  // `sendWatchDirect` after `verifyWatchAuthority` proves this process holds the watch, and never
  // returned by `placeCaller`. No command line sets it and no io seam of the ordinary CLI can
  // carry it. It is a non-seat sender: admission never reads it as a seat, it never falls back to
  // the owner label, and it may never address the owner.
  | { kind: 'watch'; session: string; pane?: string }
  | { kind: 'unplaced'; reason: string };

export type Process = { pid: number; name: string };

export type CallerSources = {
  // The command's parent processes, nearest first, up to the first process of the system; null
  // when the walk stopped before it got there.
  ancestors(): Process[] | null;
  agents(): HerdrAgent[] | null;
  paneRootPid(pane: string): number | null;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
};

// Places the caller by its parent processes. When `session` is given the agent list and the pane
// roots are read in that session — the caller of `currentCaller(io, session)` — and a seat it
// places is recorded as that session's: a pane the session does not list places nobody.
export function placeCaller(sources: CallerSources, session?: string): Caller {
  const ancestors = sources.ancestors();
  // A walk that stopped early may have stopped below a herdr server: it places nobody.
  if (!ancestors?.length) return { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' };
  const pids = new Set(ancestors.map((process) => process.pid));

  if (ancestors.some((process) => process.name === 'herdr')) {
    const agents = sources.agents();
    if (!agents) return { kind: 'unplaced', reason: 'it runs under herdr, and herdr doesn\'t answer' };
    // The variable only says which pane to read first; the pids decide.
    const hint = sources.env.HERDR_PANE_ID;
    const ordered = [...agents].sort((a, b) => Number(b.pane === hint) - Number(a.pane === hint));
    for (const agent of ordered) {
      const root = sources.paneRootPid(agent.pane);
      if (root === null || !pids.has(root)) continue;
      if (agent.name) {
        return session === undefined
          ? { kind: 'seat', name: agent.name, pane: agent.pane }
          : { kind: 'seat', name: agent.name, pane: agent.pane, session };
      }
      return { kind: 'unplaced', reason: `it runs in pane ${agent.pane}, whose agent has no herdr name` };
    }
    // No agent vouched this caller. An agentless pane is placed only when the hint's pane
    // root is among the ancestors: the variable names the pane, the pid decides. No hint, a
    // root that is not an ancestor, or a read that fails stays the refusal below.
    if (hint) {
      const root = sources.paneRootPid(hint);
      if (root !== null && pids.has(root)) {
        return session === undefined
          ? { kind: 'pane', pane: hint }
          : { kind: 'pane', pane: hint, session };
      }
    }
    return { kind: 'unplaced', reason: 'it runs in a herdr pane without an agent' };
  }

  return walkOutside(ancestors, sources);
}

// The walk without any session at all: the owner is a terminal outside herdr, and that reading
// needs no agent list and no pane root. A caller under herdr is `unplaced` here, whatever session
// it might stand in — naming that seat would mean reading a session, and the refusal of a
// non-owner's `--session` must come before any session is read. The same walk as `placeCaller`'s
// first half, byte for byte on every case a session would not have decided.
/** The caller's parent processes, nearest first, from the same source `walkCaller` reads; null when they can't be read. */
export function callerAncestors(io: Pick<Io, 'callerSources'>): Process[] | null {
  const sources = io.callerSources?.(undefined);
  return sources ? sources.ancestors() : readAncestors();
}

export function walkCaller(io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>): Caller {
  if (io.caller !== undefined) return io.caller;
  const sources = io.callerSources?.(undefined);
  const ancestors = sources ? sources.ancestors() : readAncestors();
  const env = sources ? sources.env : io.env;
  const stdinIsTTY = sources ? sources.stdinIsTTY : io.stdinIsTTY;
  if (!ancestors?.length) return { kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' };
  if (ancestors.some((process) => process.name === 'herdr')) {
    return { kind: 'unplaced', reason: 'it runs under herdr' };
  }
  return walkOutside(ancestors, { env, stdinIsTTY });
}

function walkOutside(ancestors: Process[], sources: Pick<CallerSources, 'env' | 'stdinIsTTY'>): Caller {
  const cli = ancestors.find((process) => processNameMatches(process.name, CLI_PROCESSES));
  if (cli) {
    // An agent whose environment still names a herdr pane, but with no herdr server among its
    // parents, was moved out of that pane (a Claude Code background session's pty host is one
    // way). The variable never places anyone; the reason only names the cause and the repair.
    const pane = sources.env.HERDR_PANE_ID;
    if (pane) {
      return {
        kind: 'unplaced',
        reason: `it is run by an agent (${cli.name}) outside herdr: its environment names pane ${pane}, but no herdr server is among its parent processes, so the agent was detached from that pane (for example a Claude Code background session); run the seat in its pane again (team restart <seat>)`,
      };
    }
    return { kind: 'unplaced', reason: `it is run by an agent (${cli.name}) outside herdr` };
  }
  if (sources.env.AGENT_UNATTENDED) return { kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' };
  if (!sources.stdinIsTTY) return { kind: 'owner-no-tty' };
  return { kind: 'owner' };
}

export function isOwner(caller: Caller): boolean {
  return caller.kind === 'owner';
}

/** Who may run a command and where from, for the no-terminal refusal. A command the map admits
 *  more widely than the owner passes its own route, so the sentence names the caller's own way
 *  in; an owner-only act leaves it out and gets `DETACHED_REFUSAL`. */
export interface DetachedRoute {
  readonly who: string;
  readonly where: string;
}

/** The refusal for an owner-only act, run outside herdr with no terminal. It is printed with the
 *  command's own `team <command>:` prefix. A command that admits another actor does not use it:
 *  it passes its route to `detachedRefusal` and the line names that actor too. */
export const DETACHED_REFUSAL = 'only the owner runs this, from a terminal outside herdr';

/** That sentence when `caller` is the no-terminal placement, otherwise undefined — the owner-only
 *  constant, or the command's own route when it admits another actor. */
export function detachedRefusal(caller: Caller, route?: DetachedRoute): string | undefined {
  if (caller.kind !== 'owner-no-tty') return undefined;
  return route === undefined ? DETACHED_REFUSAL : `only ${route.who} runs this, from ${route.where}`;
}

/** Who may launch seats: the owner at a terminal. `up` reads this. A run with no terminal is
 *  refused by `detachedRefusal` with `up`'s own route, and never prompts, because it does not
 *  launch.
 */
export function mayLaunchSeats(caller: Caller): boolean {
  return caller.kind === 'owner';
}

/**
 * What a seat is judged against: the session the approved team file names, and the pane the state
 * records for the seat, when it records one. The pane it was launched on is the seat's; a pane
 * merely renamed to the seat's name, even in the right session, is not it. A state that records no
 * pane (a team never brought up; an orchestrator's seat `team` didn't launch) is refused: nothing in
 * the state tells that seat apart from a renamed shell, so the check fails closed. The refusal is
 * `noPaneRefusal` — the cause, and the repair that truly records a pane.
 */
export type SeatStanding = { session: string; recordedPane?: string; stage?: SeatState['stage'] };

/** The seat record the state holds for a name in a session, or undefined. A state that can't be
 *  read records none: a caller check must never become a stack trace. */
function recordedSeatOf(dir: string, session: string, name: string): Pick<SeatState, 'pane' | 'stage'> | undefined {
  try {
    return readState(dir).sessions[session]?.seats[name];
  } catch {
    return undefined;
  }
}

/** The pane the state records for a seat in a session, or undefined. A state that can't be read
 *  records no pane: a caller check must never become a stack trace. */
export function recordedPaneOf(dir: string, session: string, name: string): string | undefined {
  return recordedSeatOf(dir, session, name)?.pane;
}

/** The standing to judge `caller` by: the session this command asks about, and the seat record the
 *  state holds for the name the caller claims — its pane, and the stage it reached. A seat the
 *  state does not record is `stage: undefined`, which no map gate admits: a seat acts where it is
 *  live and ready. */
export function standingOf(dir: string, session: string, caller: Caller): SeatStanding {
  if (caller.kind !== 'seat') return { session, recordedPane: undefined };
  const held = recordedSeatOf(dir, session, caller.name);
  return { session, recordedPane: held?.pane, stage: held?.stage };
}

/**
 * Why the caller is or is not the seat `name`. `refused` is every mismatch: another name, and a
 * caller of another session. `no-pane` is the state recording no pane for the seat — refused too,
 * and the one refusal that tells its caller what to ask the owner for. `another-pane` is the name
 * in the right session on any pane but the one the state records for it — a seat restored onto a
 * new pane id: refused, and the repair is not the no-pane one (that record exists), it is the
 * stop the state can then re-record.
 */
export type CallerVerdict =
  | { kind: 'ok' }
  | { kind: 'refused' }
  | { kind: 'no-pane'; name: string }
  | { kind: 'another-pane'; name: string; recordedPane: string };

/** Whether the caller is the seat `name`: in the session judged (a caller placed in another
 *  session is a seat of that other session, not of this one), and on the pane the state records
 *  for it. A state that records no pane refuses it, and so does one that records another pane.
 *  The standing is mandatory: the name alone proves no placement, so no caller of this kind is
 *  admitted without one. */
export function callerVerdict(caller: Caller, name: string, at: SeatStanding): CallerVerdict {
  if (caller.kind !== 'seat' || caller.name !== name) return { kind: 'refused' };
  // A caller that carries no session is refused: nothing in it shows it stood in the session
  // judged. Every placement `placeCaller` makes for a command records the session it asked
  // about, so production callers always carry one; this covers a caller built by hand, which
  // must name its session to be read as a seat.
  if (caller.session !== at.session) return { kind: 'refused' };
  if (at.recordedPane === undefined) return { kind: 'no-pane', name };
  return caller.pane === at.recordedPane ? { kind: 'ok' } : { kind: 'another-pane', name, recordedPane: at.recordedPane };
}

export function callerStanding(caller: Caller, name: string, at: SeatStanding): boolean {
  return callerVerdict(caller, name, at).kind === 'ok';
}

/**
 * The refusal for a seat the state records no pane for: the cause, and the repair that truly
 * records one. Nothing records a running seat's pane — `team up` skips a ready seat without a
 * write, refuses a seat the state doesn't record while its agent runs (`up never touches a
 * running team`), and launches a fresh workspace for a record without a pane — so the seat has
 * to be stopped before `team up` can launch it and record the pane. (Runs on a fake
 * host through the real commands, round 4: with the seat live, `team up` exits 1 with that
 * line; with the seat stopped, `team up` exits 0 and records the pane it started it on.)
 */
export function noPaneRefusal(name: string): string {
  return `no pane is recorded for seat ${name} in this session: a lead stops that seat and runs \`team up\``;
}

/**
 * The refusal for a seat the state records on another pane: the name is in the session judged,
 * but not on the pane the state holds for it. No single command re-records that pane while
 * the seat runs, and which one works depends on reads a caller cannot make, so the refusal names
 * the sequence that repairs every case. (Runs on a fake host through the real commands, round 4,
 * for the seat live on a new pane, the seat gone, and the recorded pane gone:) `team up` alone
 * bails on the record it can still read (`herdr no longer shows this seat on its recorded pane;
 * nothing closed`), and `team add` bails with the same line; `team remove` of the orchestrator's
 * or the operator's name — the two this refusal can name — is refused by the file's own
 * validation (`names no declared seat`, exit 2) or, with `--keep`, is a swap that is not this
 * seat's to run on itself (`remove.swap-self`); with the recorded
 * pane gone (unreadable) `team up` alone does launch the seat afresh. `team down` then `team up`
 * repairs all three: the stop stops every seat it reaches and clears the session, the start
 * launches the seat again and records the pane it starts on (exit 0, 0; the caller then passes
 * the gate). A seat the stop cannot reach — the gone case, whose name is not in the agent list —
 * keeps its old record through the stop, and the start overwrites it by launching. (Round 4's
 * safety review read the state file after each step of the gone case: still the old pane after
 * `down`, the launched pane after `up`.)
 */
export function anotherPaneRefusal(name: string, recordedPane: string): string {
  return `the state records pane ${recordedPane} for seat ${name} in this session, not the pane this call is on: a lead stops the team and starts it again (\`team down\`, then \`team up\`)`;
}

/**
 * The refusal a command prints when a non-owner aimed `--file`: decided by the walk alone, before
 * that file is read, so every state of the flagged path — no file at all, an unparsable file, a
 * valid team file, a folder, an unreadable file — answers with these same bytes and the same
 * exit, and nothing of the flagged project and no session is read. `undefined` when the flag is
 * absent or the walk places the owner. Every command whose `--file` is the owner's (add,
 * remove, worktree list / new / remove, answer, down, watch) asks this before it reads anything; it
 * lives here, beside `walkCaller`, so an eighth command cannot forget it. (The gate grew command
 * by command: `add`, `remove` and `worktree` once read the flagged file and asked the host for its
 * session before their own `--file` check; `watch` opened the flagged file and wrote its
 * `last_valid`, log and heartbeat beside it. The readers were then split from it, and for a while
 * `status --file` was any caller's, with its one write made conditional on this walk instead, in
 * currentTeam's `remember`. `status` now asks this before it reads anything, the same as the
 * commands that write: a plain folder's seat runs from the folder that holds `.agents`, because
 * the lookup does not walk up. `watch` keeps the refusal: it writes state of its own.)
 */
export function fileOwnerRefusal(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  file: string | undefined,
): string | undefined {
  if (!file) return undefined;
  const walked = walkCaller(io);
  return isOwner(walked) ? undefined : (detachedRefusal(walked) ?? `--file is the owner's, from a terminal outside herdr; this call is ${describeCaller(walked)}`);
}

/** The one refusal a non-owner aiming `--session` meets, decided and printed before any session
 *  is read: the walk places a caller under herdr as `unplaced`, because naming its seat would
 *  read a session. */
export function sessionOwnerRefusal(walked: Caller): string {
  return detachedRefusal(walked) ?? `--session is the owner's, from a terminal outside herdr; this call is ${describeCaller(walked)}`;
}

// The owner, or the orchestrator's or the operator's seat: who may change a running team —
// by the name rule this walk grew on. The six commands that wire the map (`up`, `down`,
// `restart`, `add`, `remove`, `register`) decide by the resolver instead
// (src/permissions/who.ts's `gateVerdict`); `hold` and `worktree list / new / remove` still
// ask this, and it stays the shape they and every `CallerVerdict` branch on. Those are the
// names the file resolved (`coordinator:` or `leads: true`, and `operator:`), not the seat's
// role, so a lead written `role: coordinator` is admitted when its name is that lead. The
// no-pane and another-pane verdicts name the seat, so a command's refusal can say which seat
// the state lost, or which pane it holds that the caller is not on.
export function mayChangeTeamVerdict(caller: Caller, team: Pick<TeamFile, 'orchestrator' | 'operator'>, at: SeatStanding): CallerVerdict {
  if (caller.kind === 'owner') return { kind: 'ok' };
  const asOrchestrator = callerVerdict(caller, team.orchestrator, at);
  return asOrchestrator.kind === 'refused' ? callerVerdict(caller, team.operator, at) : asOrchestrator;
}

// The same question, as a boolean, for callers that need no reason.
export function mayChangeTeam(caller: Caller, team: Pick<TeamFile, 'orchestrator' | 'operator'>, at: SeatStanding): boolean {
  return mayChangeTeamVerdict(caller, team, at).kind === 'ok';
}

/**
 * Who may pause and resume a team: the owner, or the team's orchestrator on its own seat. The
 * operator is not admitted here. A pause stops every seat's intake of new work, which is the
 * orchestrator's own lever on the team, and the owner asked for it as one; an operator's own
 * stop is `team hold`, which carries the operator too and changes nothing any seat does.
 */
export function mayPauseTeamVerdict(caller: Caller, team: Pick<TeamFile, 'orchestrator'>, at: SeatStanding): CallerVerdict {
  if (caller.kind === 'owner') return { kind: 'ok' };
  return callerVerdict(caller, team.orchestrator, at);
}

/**
 * The caller a command that changes the team must judge, and how a refusal names it. The decision
 * is made on the caller placed in the session the command asks about — the proof that its pane is
 * that session's. `shown` is the caller's own placement, without a session, as main described it:
 * so a seat of another session is refused by its name, today's text, and the text names nothing
 * that would have told it which name would have worked.
 */
export function judgeCallerOf(io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>, session?: string): { caller: Caller; shown: Caller } {
  const caller = callerOf(io, session);
  // A caller a test handed in is itself; a seat placed in the session asked about is described
  // by that placement. Anything else is described by its own placement.
  if (io.caller !== undefined || caller.kind !== 'unplaced') return { caller, shown: caller };
  return { caller, shown: callerOf(io) };
}

/**
 * The caller a command must judge when the call named no session, and the session to judge it
 * in. The file's own session is tried first, exactly as it was before sessions were judged: a
 * team the file names is judged where it always was, and every existing binding holds. The one
 * case this adds is a team the owner started under another session — `team up --session <name>`,
 * the file still naming its own — whose seats must stand in the commands that change the team.
 * The session then comes from the caller's own placement: the state session that records this
 * caller's pane for the seat the verdict admits it as. The flag never comes back to a
 * non-owner; only a placement the owner's own state records can move the judgement. A state
 * that holds no other session — every team that never overrode one — resolves to the file's
 * own session, unchanged. A seat placed in another session but not standing in it is judged
 * there, so the refusal names the caller instead of reading it as a stranger; a caller no
 * state-held session places falls back to the file's placement, today's refusal.
 */
export function judgeCallerIn(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>,
  dir: string,
  team: Pick<TeamFile, 'session' | 'orchestrator' | 'operator'>,
  // What `stands in this session` means. The default is the name rule this search grew on
  // (`hold`, `worktree list / new / remove`); the commands wiring the map pass their own
  // resolver-based verdict, so a session the caller stands in is one the map admits it in.
  verdictOf: (caller: Caller, at: SeatStanding) => CallerVerdict = (caller, at) => mayChangeTeamVerdict(caller, team, at),
): { caller: Caller; shown: Caller; session: string } {
  const placedIn = (session: string): { caller: Caller; shown: Caller; session: string; verdict: CallerVerdict } => {
    const { caller, shown } = judgeCallerOf(io, session === 'default' ? undefined : session);
    return { caller, shown, session, verdict: verdictOf(caller, standingOf(dir, session, caller)) };
  };
  const named = placedIn(team.session);
  if (named.verdict.kind === 'ok') return named;
  let held: { caller: Caller; shown: Caller; session: string; verdict: CallerVerdict } | undefined;
  for (const session of stateSessions(dir)) {
    if (session === team.session) continue;
    const there = placedIn(session);
    if (there.verdict.kind === 'ok') return there;
    if (held === undefined && there.caller.kind === 'seat') held = there;
  }
  return held ?? named;
}

/** The sessions the state holds, or none when it can't be read: a caller check must never
 *  become a stack trace. */
function stateSessions(dir: string): string[] {
  try {
    return Object.keys(readState(dir).sessions);
  } catch {
    return [];
  }
}

export function describeCaller(caller: Caller): string {
  if (caller.kind === 'owner') return 'owner';
  // Owner-gated acts refuse this placement with `DETACHED_REFUSAL` before they describe the caller.
  // What still embeds this phrase is a description, not that refusal.
  if (caller.kind === 'owner-no-tty') return 'unplaced (it doesn\'t run on a terminal)';
  if (caller.kind === 'seat') return caller.name;
  if (caller.kind === 'pane') {
    // A sessioned pane was placed against a file, and the refusal may say no grant lists it.
    // A sessionless pane was placed before any file was read, so it cannot say that.
    if (caller.session === undefined) return `it runs in pane ${caller.pane}`;
    return `it runs in pane ${caller.session}/${caller.pane}, which no grant lists`;
  }
  if (caller.kind === 'watch') return 'the watch';
  return `unplaced (${caller.reason})`;
}

/** The bracket a log line carries: the caller's own name — `owner`, the seat that called, or the
 *  pane a passed run stands on. A seat is never its role: the orchestrator's seat logs as its
 *  name, as every other seat does. An unplaced caller is `unplaced` and never its reason — a
 *  reason can hold a pane id, and the bracket carries none. */
export function logTag(caller: Caller): string {
  if (caller.kind === 'owner' || caller.kind === 'owner-no-tty') return 'owner';
  if (caller.kind === 'unplaced') return 'unplaced';
  // A passed run's log names the pane. The refusal, which says no grant lists it, stays in
  // `describeCaller` and is not this bracket.
  if (caller.kind === 'pane') return caller.session === undefined ? caller.pane : `${caller.session}/${caller.pane}`;
  if (caller.kind === 'watch') return 'watch';
  return caller.name;
}

/** The bracket the owner-gated commands' warnings and refusals carry: `logTag`, and an unplaced
 *  caller's reason, which those lines are allowed to say. The owner is `owner` with or without a
 *  terminal: `(no terminal for owner)` on the record already says the rest. */
export function callerLabel(caller: Caller): string {
  if (caller.kind === 'unplaced') return describeCaller(caller);
  return logTag(caller);
}

// One process's parent and name, or null. By name only: arguments can hold credentials.
export type ReadProcess = (pid: number) => { ppid: number; name: string } | null;

// A process's name, however the platform spells it: ps prints a path, /proc a bare name, and a
// login shell leads with a dash.
function processName(raw: string): string {
  return basename(raw).replace(/^-/, '');
}

export const readWithPs: ReadProcess = (pid) => {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    return match ? { ppid: Number(match[1]), name: processName(match[2] as string) } : null;
  } catch {
    return null;
  }
};

// "10 (herdr) S 1 10 …", one line of /proc/<pid>/stat: the name in parentheses — it can hold
// spaces and parentheses, so the last of them closes it — then the state, then the parent.
export function parseStat(text: string): { ppid: number; name: string } | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const after = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(after[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  const name = processName(text.slice(open + 1, close));
  return name ? { ppid, name } : null;
}

// One process, from Linux's own table. `proc` is the /proc root, a parameter so a test can walk a
// captured one.
export function readWithProc(pid: number, proc = '/proc'): { ppid: number; name: string } | null {
  try {
    return parseStat(readFileSync(`${proc}/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

// The table this platform keeps: Linux answers from /proc, every other system through ps.
export function processReader(platform: string = process.platform): ReadProcess {
  return platform === 'linux' ? readWithProc : readWithPs;
}

// The parent processes of `pid`, nearest first, up to the system's first process. Null when a
// process on the way can't be read, or the chain is longer than any real one: a partial list
// could hide the herdr server above it.
export function readAncestors(pid: number = process.ppid, read: ReadProcess = processReader()): Process[] | null {
  const out: Process[] = [];
  let at = pid;
  for (let depth = 0; depth < 64; depth++) {
    if (at <= 1) return out;
    const found = read(at);
    if (!found) return null;
    out.push({ pid: at, name: found.name });
    at = found.ppid;
  }
  return null;
}

// The caller of a command: the one a test handed in, the one test sources place, or the one the
// processes show. The sources are asked about the session the command asks about, so a test sees
// the placement the command itself made.
export function callerOf(io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources'>, session?: string): Caller {
  if (io.caller !== undefined) return io.caller;
  if (io.callerSources !== undefined) return placeCaller(io.callerSources(session), session);
  return currentCaller(io, session);
}

export function currentCaller(io: { env: Record<string, string | undefined>; stdinIsTTY: boolean }, session?: string): Caller {
  return placeCaller({
    ancestors: () => readAncestors(),
    agents: () => agentList(session),
    paneRootPid: (pane) => paneRootPid(pane, session),
    env: io.env,
    stdinIsTTY: io.stdinIsTTY,
  }, session);
}

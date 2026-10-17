// `team register <seat>`: the record for a seat that is already running. `up` and `add` write a
// seat's record only in the run that launched it, so a seat someone else started — an older
// `team`, a hand-run CLI in a session this team owns — is a live pane no `team` command may
// address: `add` answers "already running", and `up` refuses the whole session as one whose
// agents this file's state does not record. This command verifies such a pane and writes the
// record without touching it: the same gate as `up` (the owner, or what the file names for
// `up`), the same reading of herdr and the pane's screen, and the state and registry writes a
// launch of it would have made. `--pane <id>` names the pane outright — for one herdr never
// named, a seat started before this team managed the session: the pane is verified the same way,
// named as the seat through herdr (the rename a launch runs), and recorded the same way. A pane
// herdr already names as another agent is refused, never renamed and adopted.
//
// What it does not write is what only a launch can know: the state's `model`, `version`,
// `effort` and `launch_line` are "what this launch declared", and a pane started by hand
// declares nothing this run can read. The file's seat is the authority for the cli, and herdr
// for the pane, the workspace and the agent session.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { callerLabel, describeCaller, detachedRefusal, judgeCallerIn, mayLaunchSeats, sessionOwnerRefusal, standingOf, walkCaller, type Caller, type SeatStanding } from '../caller.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
import { noteLaunchedPane } from '../file/launched-file.ts';
import { loadTeamFile } from '../file/load.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Seat } from '../file/types.ts';
import { entityGrantAdmits, grantGate, logGranted } from '../grant.ts';
import { agentList, agentRename, paneForeground, paneProcesses, paneRead, reportDisplayAgent, sessionState, workspaceRename, type HerdrAgent, type PaneProcesses, type SessionState } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { launchedIdentity } from '../launch/identity.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { gateVerdict, rosterOf } from '../permissions/who.ts';
import { profileFor } from '../profiles/index.ts';
import { shellQuote } from '../profiles/profile.ts';
import { registerLaunch } from '../registry/sync.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { emptySession, mintSeatId, readState, updateState, type SeatState } from '../state.ts';
import { readScreen, type Screen } from '../watch/screen.ts';

export const USAGE = `Usage: team register <seat> [--session <name>] [--pane <id>] [--dry-run]\n`;

/**
 * The reads a test replaces. Each one left out is the real read: herdr's state for a session,
 * its agent list, a pane's processes and a pane's text, and the clock. `screen` is the reading
 * the cli's profile makes of that text; left out, the real `readScreen` runs over `paneText`.
 */
export type RegisterSources = {
  home: string;
  /** `running`, `stopped` or `absent`; null when herdr doesn't answer. */
  sessionState: (session: string) => SessionState | null;
  /** Null when herdr doesn't answer for that session. */
  agents: (session: string) => HerdrAgent[] | null;
  /** Null when herdr can't read the pane's processes. */
  processInfo: (session: string, pane: string) => PaneProcesses | null;
  /** argv0 of each foreground process in the pane, or null when herdr can't read them. Left
   *  out, the pane's CLI is judged by the agent name herdr reports for it — the reading a
   *  scene that stubs `agents` already carries. The shipped reader always provides this. */
  foreground?: (session: string, pane: string) => string[] | null;
  paneText: (session: string, pane: string) => string | null;
  screen?: (cli: string, text: string | undefined) => Screen;
  delegateGate?: typeof delegateGate;
  grantGate?: typeof grantGate;
  /** The seat's live session socket, recorded on the agent after the registry write, as a
   *  launch records it. Left out, the real read runs over herdr. */
  refreshAddress?: typeof refreshAgentAddress;
  /** Line 1 of the seat's herdr sidebar, re-applied on an adoption: the file's own
   *  `workspaceLabel`, through the same rename `up` and `add` make. Left out, the real write
   *  runs over herdr. */
  renameWorkspace?: (session: string, workspace: string, label: string) => boolean;
  /** Line 2, re-applied the same way: `displayAgent(seat)`, through the `pane report-metadata`
   *  call `add` reports it with. Left out, the real write runs over herdr. */
  reportDisplayAgent?: (session: string, pane: string, text: string) => boolean;
  /** Names the pane as the seat — the herdr rename a launch runs at its `rename` step. Left out,
   *  the real `herdr agent rename` runs. Read by `--pane` only. */
  renameAgent?: (session: string, pane: string, name: string) => boolean;
  now: () => Date;
};

/** The host's rename, in the shape a launch's own host takes it (`do: rename`). */
const realRename = (session: string, pane: string, name: string): boolean => agentRename(pane, name, session);

const realSources: RegisterSources = {
  home: homedir(),
  sessionState: (session) => sessionState(session),
  agents: (session) => agentList(session),
  processInfo: (session, pane) => paneProcesses(pane, session),
  foreground: (session, pane) => paneForeground(pane, session),
  paneText: (session, pane) => paneRead(pane, 200, session),
  renameAgent: realRename,
  now: () => new Date(),
};

export const register: Command = (argv, io) => runRegister(argv, io, realSources);
export default register;

function usage(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n${USAGE}`);
  // exit: register.usage
  return 2;
}

function configuration(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
  // exit: register.file
  return 2;
}

function detachedExit(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
  // exit: register.detached
  return 1;
}

function callerRefused(out: Io, message: string, dry = false, unblock?: string): number {
  if (dry) {
    // A dry run is never denied bare: what would refuse it is said as what it is, and the
    // command that unblocks it is named beside it — `up`'s own dry words.
    out.stdout(`! register would refuse: ${plainText(message)}\n`);
    if (unblock !== undefined) out.stdout(`! to unblock: ${plainText(unblock)}\n`);
  } else {
    out.stderr(`team register: ${plainText(message)}\n`);
  }
  // exit: register.caller
  return 1;
}

function delegateRefused(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
  // exit: register.delegate
  return 1;
}

function grantRefused(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
  // exit: register.grant
  return 1;
}

function grantFlagRefused(out: Io): number {
  out.stderr("team register: --session is the owner's; the granted seat cannot use it\n");
  // exit: register.grant-flag
  return 1;
}

/** The caller gate's sentence: who may run it, and what this call is. The rule is the map's
 *  `register` row (`owner-or-own-team`): the owner, or a seat the team's own record lists. */
function notOwnerLine(caller: Caller): string {
  return `only the owner or a seat of this team registers a running seat; this call is ${plainLine(describeCaller(caller))}`;
}

function notOwnerRefused(out: Io, caller: Caller, dry = false, unblock?: string): number {
  const line = notOwnerLine(caller);
  if (dry) {
    out.stdout(`! register would refuse: ${plainText(line)}\n`);
    if (unblock !== undefined) out.stdout(`! to unblock: ${plainText(unblock)}\n`);
  } else {
    out.stderr(`team register: ${line}\n`);
  }
  // exit: register.not-owner
  return 1;
}

function unknownRefused(out: Io, name: string): number {
  out.stderr(`team register: the file has no seat ${JSON.stringify(name)}\n`);
  // exit: register.no-seat
  return 1;
}

function stoppedRefused(out: Io, name: string): number {
  out.stderr(`team register: ${plainLine(name)} is stopped in this file; the owner clears \`stopped\` and starts the team\n`);
  // exit: register.stopped
  return 1;
}

function noProfileRefused(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
  // exit: register.no-profile
  return 1;
}

function herdrRefused(out: Io): number {
  out.stderr("team register: herdr doesn't answer\n");
  // exit: register.herdr
  return 1;
}

function noSessionRefused(out: Io, session: string): number {
  out.stderr(`team register: session "${plainLine(session)}" is not running; run team up first\n`);
  // exit: register.no-session
  return 1;
}

function teamFileRefused(out: Io, session: string, file: string): number {
  out.stderr(
    `team register: session "${plainLine(session)}" was launched from ${plainLine(file)}; a seat is registered into its own team's session\n`,
  );
  // exit: register.session-file
  return 1;
}

function noAgentRefused(out: Io, name: string, session: string): number {
  out.stderr(
    `team register: no agent named ${plainLine(name)} is running in session "${plainLine(session)}"; nothing was registered\n`,
  );
  // exit: register.no-agent
  return 1;
}

function ambiguousRefused(out: Io, name: string, session: string, count: number): number {
  out.stderr(
    `team register: session "${plainLine(session)}" has ${count} agents named ${plainLine(name)}; registering one would guess\n`,
  );
  // exit: register.many-agents
  return 1;
}

function recordedRefused(out: Io, name: string, pane: string, recordedPane: string | undefined): number {
  const on = recordedPane === undefined ? 'no pane' : `pane ${plainLine(recordedPane)}`;
  out.stderr(
    `team register: ${plainLine(name)} is already recorded on ${on}, not on ${plainLine(pane)}; the owner stops the team and starts it again (\`team down\`, then \`team up\`)\n`,
  );
  // exit: register.recorded
  return 1;
}

function noPaneRefused(out: Io, pane: string, session: string): number {
  out.stderr(`team register: no pane ${plainLine(pane)} in session "${plainLine(session)}"; nothing was registered\n`);
  // exit: register.no-pane
  return 1;
}

function paneTakenRefused(out: Io, pane: string, other: string, session: string): number {
  out.stderr(
    `team register: pane ${plainLine(pane)} is ${plainLine(other)}'s in session "${plainLine(session)}"; nothing was registered\n`,
  );
  // exit: register.pane-taken
  return 1;
}

function paneNamedRefused(out: Io, pane: string, other: string, session: string): number {
  out.stderr(
    `team register: pane ${plainLine(pane)} is named ${plainLine(other)} in session "${plainLine(session)}"; --pane names a pane herdr never named, nothing was registered\n`,
  );
  // exit: register.pane-named
  return 1;
}

function noCliRefused(out: Io, name: string, pane: string): number {
  out.stderr(
    `team register: ${plainLine(name)}: pane ${plainLine(pane)} holds no process in front of its shell; nothing was registered\n`,
  );
  // exit: register.no-cli
  return 1;
}

function cliRefused(out: Io, name: string, pane: string, cli: string): number {
  out.stderr(
    `team register: ${plainLine(name)}: pane ${plainLine(pane)} holds no \`${plainLine(cli)}\` process; nothing was registered\n`,
  );
  // exit: register.cli
  return 1;
}

function screenRefused(out: Io, name: string, kind: string): number {
  out.stderr(
    `team register: ${plainLine(name)}: its pane is not the seat at its prompt (${plainLine(kind)}); nothing was registered\n`,
  );
  // exit: register.screen
  return 1;
}

// The resolved spelling: a link to the team file, or a differently-cased path to it, is the file.
function sameFile(a: string, b: string): boolean {
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  return real(a) === real(b);
}

export async function runRegister(argv: string[], io: Io, sources: RegisterSources = realSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'pane'], ['dry-run']);
  if (args.error) return usage(out, args.error);
  if (args.rest.length !== 1) {
    return usage(out, args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : 'a seat name is required');
  }
  const name = args.rest[0] ?? '';
  const dry = args.flags.has('dry-run');
  // Set to exactly `1`. Anything else, including unset, leaves every refusal where it is. Dev
  // mode folds the caller gate — and only it — into a warning and the run continues, the shape
  // `up` keeps for its own caller lines; the seat's placement in herdr, the pane's own CLI, the
  // screen and every write stay enforced. The record the run writes says so: its provenance
  // carries `dev_mode: true` — `team check` shows it as a difference — until a run in force
  // writes the seat's record again.
  const dev = io.env.TEAMCLI_DEV_MODE === '1';
  const warning: string[] = [];
  // The caller gate is the one refusal with a command of its own behind it: nothing in the file
  // changes who may run this, the owner's own run does. `up`'s sentence, for this command.
  const unblock = (values: { session?: string }): string => {
    const words = ['team register', shellQuote(name)];
    if (values.session !== undefined) words.push('--session', shellQuote(values.session));
    return `the owner runs \`${words.join(' ')}\` from this folder, at a terminal outside herdr`;
  };

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked);

  const loaded = loadTeamFile(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    const said = loaded.errors
      .map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${plainText(problem.message)}`)
      .join('\n');
    return configuration(out, said);
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);

  // The one detached caller a record write may be made by: the entity runner with an active
  // create-grant, the carve-out `up` and `add` honour. Every other run without a terminal is
  // refused here, before a session or a pane is read.
  const createGranted = entityGrantAdmits(root, io, { home: sources.home, now: sources.now(), cwd: io.cwd });
  if (detached !== undefined && !createGranted) return detachedExit(out, detached);

  // The gate, `up`'s own: the map's `register` row (`owner-or-own-team` — the owner, or a seat
  // this team's record lists), a delegate this file names for `up` — the act that would have
  // written this record in the first place — the seat the file's `grant` names for `up`, or the
  // create-granted runner. The run launches nothing, so no launch is granted; but the record is
  // what lets `team send` type into the pane, so it is the owner's authority, judged by the
  // same gate and in the same order: the ordinary rule first, the delegate gate only where it
  // refused and the file has a delegates section to read, and the grant only where no delegate
  // took the run and the file has a `grant` at all.
  const verdict =
    mayLaunchSeats(walked) || detached !== undefined || !team.delegates
      ? null
      : (sources.delegateGate ?? delegateGate)({
          command: 'up',
          team,
          root,
          dir,
          flags: [...args.flags, ...Object.keys(args.values)],
          io,
          home: sources.home,
        });
  const delegated = verdict?.kind === 'passed' ? verdict.pane : null;
  // `up`'s own fallback: a delegate refusal that is not the plain "not a listed pane" is final,
  // and a file that omits `grant` does not ask.
  const delegateMissed = verdict === null || (verdict.kind === 'refused' && verdict.id === 'up.delegate');
  const grantSaid =
    delegateMissed && !mayLaunchSeats(walked) && !createGranted && team.grant !== null
      ? (sources.grantGate ?? grantGate)({ act: 'up', io, home: sources.home })
      : null;
  const grantedSeat = grantSaid?.kind === 'passed' ? grantSaid.grant.seat : null;
  // The caller rule is the map's row (`owner-or-own-team`): the owner, or a seat this team's
  // record lists — the registry's roster line, or the file's own declaration where the registry
  // holds no record of the team. The decision is made where the caller stands, by the same
  // search `up` and `down` make, and the pane proof stays the standing's. A file's `grant` is
  // the orchestrator's own authority and, where the map has admitted it, its constraint: a
  // verified grant outside its scope refuses the orchestrator's run. A file no approval covers
  // grants nothing, not even a constraint, so its refusal does not stop the map's admission.
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, sources.home, 'register', at, sources.now);
  const judged = mayLaunchSeats(walked) || detached !== undefined ? null : judgeCallerIn(io, dir, team, verdictOf);
  const rule = judged !== null ? verdictOf(judged.caller, standingOf(dir, judged.session, judged.caller)) : null;
  const caller = judged?.caller ?? walked;
  const ordinaryAdmitted = mayLaunchSeats(walked) || rule?.kind === 'ok';
  const grantBlocked =
    ordinaryAdmitted &&
    grantSaid?.kind === 'refused' &&
    grantSaid.id !== 'grant.approval' &&
    caller.kind === 'seat' &&
    caller.name === team.orchestrator;
  const named = (ordinaryAdmitted && !grantBlocked) || delegated !== null || createGranted || grantedSeat !== null;
  // `--session` picks the herdr session the pane is verified in: where the record it writes will
  // point `send`, `watch` and `down`. It is the owner's: a granted seat is refused in the grant's
  // own words, and everyone else — a delegate that aimed it included — before the named session
  // is read.
  if (args.values.session !== undefined && !mayLaunchSeats(walked) && !createGranted) {
    if (grantedSeat !== null) return grantFlagRefused(out);
    const line = sessionOwnerRefusal(walked);
    if (dev) warning.push(line);
    else return callerRefused(out, line, dry, unblock(args.values));
  }
  if (!named && grantSaid?.kind === 'refused') return grantRefused(out, grantSaid.text);
  if (!named && verdict?.kind === 'refused') return delegateRefused(out, verdict.text);
  if (!named) {
    // The caller gate, the one dev mode lifts; a dry run keeps it as the refusal it is, with
    // the owner's own command beside it. The grant's and the delegate's own refusals stay
    // refusals either way, as they do for `up`.
    const line = notOwnerLine(caller);
    if (dev) warning.push(line);
    else return notOwnerRefused(out, caller, dry, unblock(args.values));
  }
  if (warning.length > 0) {
    const line = [...new Set(warning)].join('; ');
    if (dry) out.stdout(`! warning: ${plainText(line)}\n`);
    else out.stderr(`team register: warning: ${plainText(line)}\n`);
  }

  const session = args.values.session ?? team.session;
  if (session === 'default') {
    return callerRefused(out, 'session can\'t be "default", herdr\'s own session');
  }

  const seat = team.seats.find((item) => item.name === name);
  if (!seat) return unknownRefused(out, name);
  if (seat.stopped) return stoppedRefused(out, name);
  const profile = profileFor(seat.cli);
  if (!profile) {
    return noProfileRefused(out, `no launch profile for \`${plainLine(seat.cli)}\` in this version`);
  }

  // The session's own record, read before herdr is asked. The file a session was launched from
  // is the one team a seat standing in it belongs to; the seat's own record says whether there
  // is anything to write at all.
  const recorded = readState(dir).sessions[session] ?? emptySession();
  const launchedFrom = recorded.launched_file;
  if (launchedFrom !== undefined && !sameFile(launchedFrom, path)) {
    return teamFileRefused(out, session, launchedFrom);
  }
  const held = recorded.seats[name];

  const liveState = sources.sessionState(session);
  if (liveState === null) return herdrRefused(out);
  if (liveState !== 'running') return noSessionRefused(out, session);
  const agents = sources.agents(session);
  if (agents === null) return herdrRefused(out);

  // The pane the run records, and what herdr lists on it: the agent herdr answers to the seat's
  // name, or the pane `--pane` names outright — one herdr never named, a seat started before
  // this team managed the session. What herdr lists on that pane stands in for the found agent.
  const paneArg = args.values.pane;
  let pane: string;
  let listed: HerdrAgent | undefined;
  if (paneArg !== undefined) {
    pane = paneArg;
    listed = agents.find((agent) => agent.pane === paneArg);
    // `--pane` is for a pane herdr never named. One herdr already answers to as another agent
    // is that agent's: adopting it would put a second name on a running agent's pane, and the
    // seat's record would point `send` at a process that is someone else's. A pane herdr names
    // as this seat, or lists with no name at all, is no adoption of another's.
    if (listed !== undefined && listed.name !== null && listed.name !== name) {
      return paneNamedRefused(out, pane, listed.name, session);
    }
  } else {
    listed = agents.find((agent) => agent.name === name);
    const namedCount = agents.filter((agent) => agent.name === name).length;
    if (listed === undefined) return noAgentRefused(out, name, session);
    if (namedCount > 1) return ambiguousRefused(out, name, session, namedCount);
    pane = listed.pane;
  }
  // A pane is one seat's: the pane this run records — named by `--pane`, or the one herdr names
  // the seat on — must not be one another seat of this session's record already holds. A pane
  // herdr renamed to this seat, but recorded for another, would otherwise be held twice.
  const holder = Object.entries(recorded.seats).find(([seat, state]) => seat !== name && state.pane === pane);
  if (holder !== undefined) return paneTakenRefused(out, pane, holder[0], session);

  // A record that names another pane — or no pane at all, a launch this command did not finish —
  // is not overwritten from here: that is the owner's `team down`, then `team up`.
  if (held !== undefined && held.pane !== pane) {
    return recordedRefused(out, name, pane, held.pane);
  }

  // What the pane is: a process in front of the pane's own shell that the seat's CLI profile
  // names — the file's `cli` is the authority, and herdr's argv0 the reading. Read on every
  // path, the already-recorded one included: a pane whose CLI has exited or been replaced is
  // not the seat to record, whatever its record says it is.
  const procs = sources.processInfo(session, pane);
  // `--pane` names a pane another session's window holds just as well: herdr knowing nothing of
  // it in this one is the reading that says so, and is its own refusal.
  if (procs === null && paneArg !== undefined) return noPaneRefused(out, pane, session);
  const identity = launchedIdentity(procs);
  if (identity === null) return noCliRefused(out, name, pane);
  // The pane's own CLI, in the seat's profile's terms: the foreground argv0s where the caller
  // reads them, else the agent name herdr reports for that pane. A pane standing in front of
  // another agent is not this seat, and is not recorded.
  const live = sources.foreground
    ? sources.foreground(session, pane)
    : listed === undefined || listed.agent === null ? null : [listed.agent];
  if (!reportedLiveAgent(live, profile.processNames)) {
    return cliRefused(out, name, pane, seat.cli);
  }

  // Already recorded on this pane, and ready: the seat is not relaunched and its screen is not
  // read. The record a launch writes is written again from the file as it now stands — the
  // signing, the roster, the team's project pointers and the address — so the repair `team
  // check` names lands where the seat stands, and a file that gained `in_project` or a new
  // signing since the launch reaches the registry. The session's own record is left exactly as
  // it is.
  if (held !== undefined && held.pane === pane && held.stage === 'ready') {
    // One more repair from the same run, and a dry run paints nothing for it either: the seat's
    // two sidebar lines are re-applied from the file, so a label or display that drifted is put
    // back where the seat stands.
    // The record this path can still owe is the launch's own write from the file as it now
    // stands — the roster line among the rest. Where the registry holds a record of the team,
    // the permission bridge (`src/permissions/who.ts`) reads that roster as the record of who
    // its seats are: a seat the roster does not list has no record there whatever the approved
    // file declares, and every gate wired to the bridge refuses it what the file says it holds.
    // The line goes in exactly as a launch writes it, the signing and the project pointers
    // included. A team the registry holds no record of is written here too — the team record,
    // the seat's agent record and its roster line, exactly what a launch writes — so a team
    // started before this version kept registry records is repaired the same way, and the
    // bridge and `team check` read the same team for it as for any other.
    const roster = rosterOf(sources.home, root);
    const unlisted = roster.kind !== 'listed' || !roster.roster.some((line) => line.seat === name);
    let refreshed = false;
    let wroteRoster = false;
    if (!dry) {
      const refreshedAt = sources.now();
      relabel(out, sources, session, seat, pane, listed?.workspace, name);
      // The audit lines a delegated and a granted act write, the same ones the launch path
      // writes below: this path is that act too, and its early return must not skip them.
      if (delegated !== null) logDelegated(dir, delegated, 'up', refreshedAt, 'register');
      if (grantedSeat !== null) logGranted(dir, grantedSeat, 'up', refreshedAt, 'register');
      const wrote = registerLaunch({ home: sources.home, team, root, by: callerLabel(walked), session, devMode: dev, owner: walked.kind === 'owner' }, seat, pane, held.id);
      if ('note' in wrote) logLine(dir, 'register', callerLabel(walked), wrote.note, refreshedAt);
      else {
        refreshed = true;
        wroteRoster = unlisted;
        // The address, re-read the way a launch reads it, on the id the write above returned.
        const address = (sources.refreshAddress ?? refreshAgentAddress)(sources.home, wrote.id, pane, session);
        if (address.note) logLine(dir, 'register', callerLabel(walked), address.note, refreshedAt);
        logLine(dir, 'register', callerLabel(walked), `${name}: refreshed ${held.id ?? wrote.id} — pane ${pane}`, refreshedAt);
        if (wroteRoster) logLine(dir, 'register', callerLabel(walked), `${name}: roster line written — pane ${pane}`, refreshedAt);
      }
    }
    const ended = `already registered — pane ${plainLine(pane)}`;
    if (wroteRoster) out.stdout(`${plainLine(name)}: ${ended}; the team registry's roster did not list it, and was written\n`);
    else if (unlisted && dry) out.stdout(`${plainLine(name)}: ${ended}; the team registry's roster would be written\n`);
    else if (dry || refreshed) out.stdout(`${plainLine(name)}: ${ended}; the record ${dry ? 'would be' : 'was'} refreshed from the file, nothing relaunched\n`);
    else out.stdout(`${plainLine(name)}: ${ended}; nothing was written\n`);
    // exit: register.already
    return 0;
  }

  // The screen: the seat at its prompt. A dialog, or a reading this version does not recognise,
  // is not a seat to record; the already path above does not read it.
  const text = sources.paneText(session, pane) ?? undefined;
  const screen = sources.screen ? sources.screen(seat.cli, text) : readScreen(seat.cli, text);
  if (screen.kind !== 'idle' && screen.kind !== 'working') {
    return screenRefused(out, name, screen.kind);
  }

  if (dry) {
    out.stdout(
      paneArg === undefined
        ? `${plainLine(name)}: would register — pane ${plainLine(pane)}; nothing would be launched\n`
        : `${plainLine(name)}: would register — pane ${plainLine(pane)}; the pane would be named ${plainLine(name)} and recorded, nothing would be launched\n`,
    );
    // exit: register.dry-run
    return 0;
  }

  const now = sources.now();
  // The pane `--pane` named carries no name of the seat's yet: herdr is told it — the rename a
  // launch runs after its idle wait — before anything is recorded. A rename herdr did not take
  // is a note, never a refusal: the record is what this command exists to write, and the next
  // `--pane` run names the pane again.
  const renamed = paneArg === undefined || (sources.renameAgent ?? realRename)(session, pane, name);
  if (!renamed) {
    logLine(dir, 'register', callerLabel(walked), `the pane was not named ${name}: herdr did not take the rename`, now);
  }
  // The id the seat keeps: the one a launch recorded for it — a record short of ready is
  // completed, never replaced — the one a stopped session retained, or a fresh one.
  const id = held?.id ?? recorded.retained_seats?.[name]?.id ?? mintSeatId();
  updateState(dir, (state) => {
    const current = (state.sessions[session] ??= emptySession());
    if (current.retained_seats?.[name]) delete current.retained_seats[name];
    const carried: SeatState = { ...(held ?? { stage: 'launched' }) };
    // A record that was waiting on a dialog is not waiting now: the screen above is the seat's
    // own prompt, and the word that said otherwise goes with the launch that wrote it.
    delete carried.waiting;
    current.seats[name] = {
      ...carried,
      id,
      stage: 'ready',
      cli: seat.cli,
      pane,
      ...(listed?.workspace !== undefined ? { workspace: listed.workspace } : {}),
      last_active: now.toISOString(),
      launched: identity,
      ...(listed?.session ? { agent_session: listed.session } : {}),
    };
    // The pointer `up` and `add` write for the panes they launch, so the seat's own `team send`
    // resolves this team file from the pane it stands in. Kept when the session already names it.
    current.launched_file = path;
  });

  const wrote = registerLaunch({ home: sources.home, team, root, by: callerLabel(walked), session, devMode: dev, owner: walked.kind === 'owner' }, seat, pane, id);
  if ('note' in wrote) logLine(dir, 'register', callerLabel(walked), wrote.note, now);
  else {
    // The address: the live session socket this seat answers at, recorded on the agent the way a
    // launch records it — the pane above is the one herdr showed, read again as `add` reads it.
    // The record it names is the registry's agent, the id the write above returned.
    const refreshed = (sources.refreshAddress ?? refreshAgentAddress)(sources.home, wrote.id, pane, session);
    if (refreshed.note) logLine(dir, 'register', callerLabel(walked), refreshed.note, now);
  }
  // The seat's sidebar, painted from the file the way `up` and `add` paint it: the record above
  // makes the seat reachable; these two writes make its own lines say what the file says.
  relabel(out, sources, session, seat, pane, listed?.workspace, name);
  noteLaunchedPane(sources.home, path, pane, session);
  // The audit line a delegated act writes, naming the authority (`up`) it was run under; a
  // granted seat writes the grant's own line.
  if (delegated !== null) logDelegated(dir, delegated, 'up', now, 'register');
  if (grantedSeat !== null) logGranted(dir, grantedSeat, 'up', now, 'register');
  logLine(dir, 'register', callerLabel(walked), `${name}: registered ${id} — pane ${pane}`, now);
  out.stdout(
    paneArg === undefined
      ? `${plainLine(name)}: registered — pane ${plainLine(pane)}; nothing was launched\n`
      : `${plainLine(name)}: registered — pane ${plainLine(pane)}; ${
        renamed ? `the pane was named ${plainLine(name)}` : 'herdr did not take the name'
      }, nothing was launched\n`,
  );
  // exit: register.ready
  return 0;
}

/** The two sidebar writes `up` and `add` make after a launch, re-applied to the seat this run
 *  adopts — line 1, the file's own `workspaceLabel`, line 2 its `displayAgent` — with no
 *  relaunch and nothing typed. A pane herdr names no workspace for (an adopted pane herdr never
 *  recorded) has no title to re-apply, and only the display is reported. A herdr that refuses
 *  one is one line for that seat, the relabel contract `up`, `add` and the watch keep; the
 *  record stands either way. */
function relabel(
  out: Io,
  sources: RegisterSources,
  session: string,
  seat: Seat,
  pane: string,
  workspace: string | undefined,
  name: string,
): void {
  if (workspace !== undefined) {
    const title = workspaceLabel(seat);
    const renamed = (sources.renameWorkspace ?? ((s, ws, label) => workspaceRename(ws, label, s)))(
      session,
      workspace,
      title,
    );
    if (!renamed) out.stdout(`${plainLine(name)}: its title was not reported\n`);
  }
  const display = displayAgent(seat);
  const reported = (sources.reportDisplayAgent ?? ((s, pane, text) => reportDisplayAgent(pane, text, s)))(
    session,
    pane,
    display,
  );
  if (!reported) out.stdout(`${plainLine(name)}: its display was not reported\n`);
}

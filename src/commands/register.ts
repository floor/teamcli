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
import { devModeCallerGate, devModeExpiryNote, devModeMark, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { noteLaunchedPane } from '../file/launched-file.ts';
import { withoutFileOffer } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { Seat } from '../file/types.ts';
import { entityGrantAdmits, grantGate, logGranted } from '../grant.ts';
import { agentList, agentRename, agentStatus, paneForeground, paneProcesses, paneRead, reportDisplayAgent, sessionState, SIDEBAR_TTL_CAP_MS, workspaceRename, type HerdrAgent, type PaneProcesses, type SessionState } from '../herdr.ts';
import { sidebarPolicy } from '../settings/sidebar-policy.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { currentBriefClaim, deliverBriefForAttribution, walkBriefDeliveries } from '../launch/general-brief.ts';
import { GENERAL_BRIEF_SHA256 } from '../launch/general-brief-text.ts';
import { launchedIdentity, seatProcessVerdict } from '../launch/identity.ts';
import { resetCliHookState } from '../launch/cli-hook.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { rulesOriginOf } from '../launch/rules.ts';
import { rulesDeliveryOf, rulesFileHash, writeRulesFile } from '../launch/rules-file.ts';
import { unreadIdle } from '../launch/unread.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { gateVerdict, rosterOf } from '../permissions/who.ts';
import { profileFor } from '../profiles/index.ts';
import { shellQuote, type Profile } from '../profiles/profile.ts';
import { readAgents } from '../registry/agents.ts';
import { recordedSeatRecord, recordedSeatSession } from '../registry/resume.ts';
import { registerLaunch } from '../registry/sync.ts';
import { teamIdOf } from '../registry/teams.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { nativePushBindingFor } from '../send/push.ts';
import { emptySession, mintSeatId, readState, seatOfFile, updateState, type SeatState } from '../state.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { readScreen, type Screen } from '../watch/screen.ts';

export const USAGE = `Usage: team register <seat> [--session <name>] [--pane <id>] [--dry-run] [--json]

Exits 0 when the seat is registered (or already recorded, or on --dry-run), 1 when registration is refused, 2 when the invocation or team file can't be read.
`;

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
  reportDisplayAgent?: (session: string, pane: string, text: string, ttlMs?: number) => boolean;
  /** Names the pane as the seat — the herdr rename a launch runs at its `rename` step. Left out,
   *  the real `herdr agent rename` runs. */
  renameAgent?: (session: string, pane: string, name: string) => boolean;
  /** The approval standing a waiting-for-trust seat's rules file is written under. */
  standing?: (root: string) => Standing;
  agentStatus?: (session: string, pane: string) => string | null;
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
  standing: (root) => approvalStanding(root, homedir()),
  agentStatus: (session, pane) => agentStatus(pane, session),
  now: () => new Date(),
};

export const register: Command = (argv, io) => runRegister(argv, io, realSources);
export default register;

/** What register says after writing a waiting seat's rules file. A launch that can carry the
 *  line names the restart that carries it; a CLI whose launch line takes no rules prompt says
 *  plainly that no launch can. */
export function rulesWrittenLine(name: string, profile: Pick<Profile, 'rulesPrompt'>): string {
  return profile.rulesPrompt !== null
    ? `its rules file is written; nothing is typed: its rules ride its next launch (run team restart ${name} to carry them)`
    : "its rules file is written; this CLI's launch line carries no rules line, so no launch can carry them";
}

function usage(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.usage', message, repair: null, usage: USAGE });
  // exit: register.usage
  return 2;
}

function configuration(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.file', message, repair: null });
  // exit: register.file
  return 2;
}

function detachedExit(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.detached', message, repair: null });
  // exit: register.detached
  return 1;
}

function callerRefused(out: Io, json: boolean, message: string, dry = false, unblock?: string): number {
  if (json) {
    refuse(out, true, 'register', { id: 'register.caller', message, repair: null });
  } else if (dry) {
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

function delegateRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.delegate', message, repair: null });
  // exit: register.delegate
  return 1;
}

function grantRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.grant', message, repair: null });
  // exit: register.grant
  return 1;
}

function grantFlagRefused(out: Io, json: boolean): number {
  refuse(out, json, 'register', {
    id: 'register.grant-flag',
    message: "--session is the owner's; the granted seat cannot use it",
    repair: null,
  });
  // exit: register.grant-flag
  return 1;
}

/** The caller gate's sentence: who may run it, and what this call is. The rule is the map's
 *  `register` row (`owner-or-own-team`): the owner, or a seat the team's own record lists. */
function notOwnerLine(caller: Caller): string {
  return `only the owner or a seat of this team registers a running seat; this call is ${plainLine(describeCaller(caller))}`;
}

function notOwnerRefused(out: Io, json: boolean, caller: Caller, dry = false, unblock?: string, note = ''): number {
  const line = `${notOwnerLine(caller)}${note}`;
  if (json) {
    refuse(out, true, 'register', { id: 'register.not-owner', message: line, repair: null });
  } else if (dry) {
    out.stdout(`! register would refuse: ${plainText(line)}\n`);
    if (unblock !== undefined) out.stdout(`! to unblock: ${plainText(unblock)}\n`);
  } else {
    out.stderr(`team register: ${line}\n`);
  }
  // exit: register.not-owner
  return 1;
}

function unknownRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'register', {
    id: 'register.no-seat',
    message: `the file has no seat ${JSON.stringify(name)}`,
    repair: null,
  });
  // exit: register.no-seat
  return 1;
}

function stoppedRefused(out: Io, json: boolean, name: string): number {
  refuse(out, json, 'register', {
    id: 'register.stopped',
    message: `${plainLine(name)} is stopped in this file; a lead clears \`stopped\` and starts the team`,
    repair: null,
  });
  // exit: register.stopped
  return 1;
}

function noProfileRefused(out: Io, json: boolean, message: string): number {
  refuse(out, json, 'register', { id: 'register.no-profile', message, repair: null });
  // exit: register.no-profile
  return 1;
}

function herdrRefused(out: Io, json: boolean): number {
  refuse(out, json, 'register', { id: 'register.herdr', message: "herdr doesn't answer", repair: null });
  // exit: register.herdr
  return 1;
}

function noSessionRefused(out: Io, json: boolean, session: string): number {
  refuse(out, json, 'register', {
    id: 'register.no-session',
    message: `session "${plainLine(session)}" is not running; run team up first`,
    repair: 'team up',
  });
  // exit: register.no-session
  return 1;
}

function teamFileRefused(out: Io, json: boolean, session: string, file: string): number {
  refuse(out, json, 'register', {
    id: 'register.session-file',
    message: `session "${plainLine(session)}" was launched from ${plainLine(file)}; a seat is registered into its own team's session`,
    repair: null,
  });
  // exit: register.session-file
  return 1;
}

function noAgentRefused(out: Io, json: boolean, name: string, session: string): number {
  refuse(out, json, 'register', {
    id: 'register.no-agent',
    message: `no agent named ${plainLine(name)} is running in session "${plainLine(session)}"; nothing was registered`,
    repair: null,
  });
  // exit: register.no-agent
  return 1;
}

function ambiguousRefused(out: Io, json: boolean, name: string, session: string, count: number): number {
  refuse(out, json, 'register', {
    id: 'register.many-agents',
    message: `session "${plainLine(session)}" has ${count} agents named ${plainLine(name)}; registering one would guess`,
    repair: null,
  });
  // exit: register.many-agents
  return 1;
}

function recordedRefused(out: Io, json: boolean, name: string, pane: string, recordedPane: string | undefined): number {
  const on = recordedPane === undefined ? 'no pane' : `pane ${plainLine(recordedPane)}`;
  refuse(out, json, 'register', {
    id: 'register.recorded',
    message: `${plainLine(name)} is already recorded on ${on}, not on ${plainLine(pane)}; a lead stops the team and starts it again (\`team down\`, then \`team up\`); the seat's own team registers it`,
    repair: 'a lead runs `team down`, then `team up`',
  });
  // exit: register.recorded
  return 1;
}

function noPaneRefused(out: Io, json: boolean, pane: string, session: string): number {
  refuse(out, json, 'register', {
    id: 'register.no-pane',
    message: `no pane ${plainLine(pane)} in session "${plainLine(session)}"; nothing was registered`,
    repair: null,
  });
  // exit: register.no-pane
  return 1;
}

function paneTakenRefused(out: Io, json: boolean, pane: string, other: string, session: string): number {
  refuse(out, json, 'register', {
    id: 'register.pane-taken',
    message: `pane ${plainLine(pane)} is ${plainLine(other)}'s in session "${plainLine(session)}"; nothing was registered`,
    repair: null,
  });
  // exit: register.pane-taken
  return 1;
}

function paneNamedRefused(out: Io, json: boolean, pane: string, other: string, session: string): number {
  refuse(out, json, 'register', {
    id: 'register.pane-named',
    message: `pane ${plainLine(pane)} is named ${plainLine(other)} in session "${plainLine(session)}"; --pane names a pane herdr never named, nothing was registered`,
    repair: null,
  });
  // exit: register.pane-named
  return 1;
}

function noCliRefused(out: Io, json: boolean, name: string, pane: string): number {
  refuse(out, json, 'register', {
    id: 'register.no-cli',
    message: `${plainLine(name)}: pane ${plainLine(pane)} holds no process in front of its shell; nothing was registered`,
    repair: null,
  });
  // exit: register.no-cli
  return 1;
}

function cliRefused(out: Io, json: boolean, name: string, pane: string, cli: string): number {
  refuse(out, json, 'register', {
    id: 'register.cli',
    message: `${plainLine(name)}: pane ${plainLine(pane)} holds no \`${plainLine(cli)}\` process; nothing was registered`,
    repair: null,
  });
  // exit: register.cli
  return 1;
}

function replacedProcessRefused(out: Io, json: boolean, name: string, pane: string): number {
  refuse(out, json, 'register', {
    id: 'register.replaced',
    message: `${plainLine(name)}: pane ${plainLine(pane)} holds a process other than the one its record's launch started; the record was not refreshed`,
    repair: null,
  });
  // exit: register.replaced
  return 1;
}

/**
 * The pane root is the launch's own write: the daemon's launch, or the owner's walk. A caller
 * other than the owner may repeat an identity the record already holds and this pane still
 * matches; a new one — a first record, a record that predates the identity, or a replaced
 * process — is not that caller's to make. `register.replaced` stays the owner's refusal on the
 * already path: the same live fact, said to the only caller that could have recorded it.
 */
function launchOnlyRefused(out: Io, json: boolean, name: string, pane: string, dry: boolean, unblock: string): number {
  const line = `${plainLine(name)}: pane ${plainLine(pane)} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr`;
  if (json) {
    refuse(out, true, 'register', { id: 'register.launch-only', message: line, repair: null });
  } else if (dry) {
    out.stdout(`! register would refuse: ${plainText(line)}\n`);
    out.stdout(`! to unblock: ${plainText(unblock)}\n`);
  } else {
    out.stderr(`team register: ${line}\n`);
  }
  // exit: register.launch-only
  return 1;
}

function handleHeldRefused(out: Io, json: boolean, name: string, id: string, holder: string): number {
  refuse(out, json, 'register', {
    id: 'register.handle-held',
    message: `${plainLine(name)}: the id its record holds (${plainLine(id)}) is ${plainLine(holder)}'s handle; the record was not refreshed`,
    repair: null,
  });
  // exit: register.handle-held
  return 1;
}

/** The seat whose live agent record already holds `id`, or null. Only the registry can hold one
 *  handle twice: the state's read door de-duplicates seat ids in a session (a later seat that
 *  repeats an id is read without it), while the registry is written by every launch and stop and
 *  has no such door. This seat's own records are not holders — the handle being rebound is the
 *  one its record may already carry under an earlier incarnation. A retired record holds nothing:
 *  `findAgent` never binds a seat to one. */
function handleHolder(home: string, root: string, name: string, id: string): string | null {
  const team = teamIdOf(root);
  for (const agent of readAgents(home)) {
    if (agent.lifecycle === 'retired') continue;
    if (agent.reach.team !== team || agent.reach.seat === name) continue;
    if (agent.seat_handle === id) return agent.reach.seat;
  }
  return null;
}

function screenRefused(out: Io, json: boolean, name: string, kind: string): number {
  refuse(out, json, 'register', {
    id: 'register.screen',
    message: `${plainLine(name)}: its pane is not the seat at its prompt (${plainLine(kind)}); nothing was registered`,
    repair: null,
  });
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
  // `--json` is read off the raw argv before the parser: an invocation the parser refuses still
  // owes the `team.error` document rather than the plain usage line.
  const wantsJson = hasJsonFlag(argv);
  const jsonNotes: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) if (line !== '') jsonNotes.push(plainLine(line));
  };
  // Under `--json` the command's own lines are notes for the document: nothing but the one
  // document reaches stdout, and stderr stays empty.
  const out = cleanedIo(wantsJson ? { ...io, stdout: collect, stderr: collect } : io);
  const args = readArgs(argv, ['session', 'pane'], ['dry-run', 'json']);
  const json = wantsJson;
  if (args.error) return usage(io, json, args.error);
  if (args.rest.length !== 1) {
    return usage(io, json, args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : 'a seat name is required');
  }
  const name = args.rest[0] ?? '';
  const dry = args.flags.has('dry-run');
  // Set to exactly `1`. Anything else, including unset, leaves every refusal where it is. Dev
  // mode folds the caller gate — and only it — into a warning and the run continues, the shape
  // `up` keeps for its own caller lines; the seat's placement in herdr, the pane's own CLI, the
  // screen and every write stay enforced. The record the run writes says so: its provenance
  // carries `dev_mode: true` — `team check` shows it as a difference — until a run in force
  // writes the seat's record again.
  const warning: string[] = [];
  // Whether a gate was folded this run: the caller gate below, or the delegate gate's
  // approval precondition. The record the run writes says so, the same mark `add` keeps.
  let devFolded = false;
  // The caller gate is the one refusal with a command of its own behind it: nothing in the file
  // changes who may run this; a seat of this team runs it from its own pane, or the owner runs it
  // in this folder from a terminal outside herdr. `up`'s sentence, for this command.
  const unblock = (values: { session?: string }): string => {
    const words = ['team register', shellQuote(name)];
    if (values.session !== undefined) words.push('--session', shellQuote(values.session));
    return `a seat of this team runs \`${words.join(' ')}\` from its own pane (the owner runs it from this folder, at a terminal outside herdr)`;
  };
  // The pane root's own way out: the owner's run, which is a launch's own authority for this
  // record even where the seat stands elsewhere.
  const unblockRoot = (values: { session?: string }): string => {
    const words = ['team register', shellQuote(name)];
    if (values.session !== undefined) words.push('--session', shellQuote(values.session));
    return `the owner runs \`${words.join(' ')}\` from a terminal outside herdr`;
  };

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });

  const loaded = readTeamConfig(io.cwd, { home: sources.home });
  if (!loaded.ok) {
    // `team register` takes no `--file`, so the no-repository refusal must not offer one.
    const said = loaded.errors
      .map((problem) => `${problem.line ? `line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}`)
      .join('\n');
    return configuration(io, json, said);
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);
  // Dev mode, from the file this run records against: a `dev-mode` value anywhere in the
  // caller's chain governs, and `TEAMCLI_DEV_MODE` is then ignored; before any such value the
  // variable set to exactly `1` keeps its behaviour. Only the caller gate is ever folded.
  const dev = resolveDevMode('register', io, { home: sources.home, team, root, now: sources.now() });
  if (!dry) logDevModeState(dir, 'register', callerLabel(walked), dev, sources.now());

  // A seat whose own registry record an active create-grant names may write a record here — the
  // carve-out `up` and `add` honour. A caller outside herdr has no registry record, so a detached
  // run is refused here, before a session or a pane is read.
  const createGranted = entityGrantAdmits(root, io, { home: sources.home, now: sources.now(), cwd: io.cwd });
  if (detached !== undefined && !createGranted) return detachedExit(io, json, detached);

  // `--session` picks the herdr session the pane is verified in: where the record it writes will
  // point `send`, `watch` and `down`. It is the owner's, and the aim is refused before the map is
  // walked for this run — the walk reads a session — whatever the grant state: a seat the grant
  // names is refused in the grant's own words, and everyone else — a delegate that aimed it
  // included — before the named session is read. The grant is asked for its sentence alone; its
  // verdict decides nothing here, and a grant that refused the run never turns the aim into an
  // ordinary one.
  if (args.values.session !== undefined && !mayLaunchSeats(walked) && !createGranted) {
    const said = team.grant !== null ? (sources.grantGate ?? grantGate)({ act: 'up', io, home: sources.home }) : null;
    if (said?.kind === 'passed') return grantFlagRefused(io, json);
    const line = `${sessionOwnerRefusal(walked)}${devModeExpiryNote(dev)}`;
    if (dev.on) {
      warning.push(line);
      // The audit line the fold owes, written where the gate is used: the refusal's words, on
      // a real run. A dry run decides nothing and writes none.
      if (!dry) logDevMode(dir, 'register', callerLabel(walked), `warning: ${line}`, sources.now());
    } else return callerRefused(io, json, line, dry, unblock(args.values));
  }

  // The caller rule is the map's row (`owner-or-own-team`): the owner, or a seat this team's
  // record lists — the registry's roster line, or the file's own declaration where the registry
  // holds no record of the team. The decision is made where the caller stands, by the same
  // search `up` and `down` make, and the pane proof stays the standing's. It is decided first:
  // an admitted run owes neither the delegate nor the grant, and neither gate's audit line.
  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, sources.home, 'register', at, sources.now);
  const judged = mayLaunchSeats(walked) || detached !== undefined ? null : judgeCallerIn(io, dir, team, verdictOf);
  const rule = judged !== null ? verdictOf(judged.caller, standingOf(dir, judged.session, judged.caller)) : null;
  const caller = judged?.caller ?? walked;
  const ordinaryAdmitted = mayLaunchSeats(walked) || rule?.kind === 'ok';
  // The fallbacks, `up`'s own, asked only where the map refused: a delegate this file names for
  // `up` — the act that would have written this record in the first place — then the seat the
  // file's `grant` names for `up`, then the seat whose own registry record an active create-grant
  // names. The run launches nothing, so no launch is granted; but the record is what lets
  // `team send` type into the pane, so it is the owner's authority, judged by the same gates and
  // in the same order.
  const verdict =
    ordinaryAdmitted || detached !== undefined || !team.delegates
      ? null
      : (sources.delegateGate ?? delegateGate)({
          command: 'up',
          team,
          root,
          dir,
          flags: [...args.flags, ...Object.keys(args.values)],
          io,
          home: sources.home,
          // Dev mode folds the delegation's approval precondition, exactly as it does for
          // `add` and `remove`: the live file counts as approved, and the passed verdict
          // carries the warning naming it. The evidence, the placement, the entry, its
          // command list and the owner's flags still refuse.
          dev,
          file: path,
        });
  const delegated = verdict?.kind === 'passed' ? verdict.pane : null;
  if (verdict?.kind === 'passed' && verdict.devApproval !== undefined) {
    devFolded = true;
    const said = plainText(verdict.devApproval);
    if (json) out.stderr(`${said}\n`);
    else if (dry) out.stdout(`! ${said}\n`);
    else out.stderr(`team register: ${said}\n`);
    if (!dry) logDevMode(dir, 'register', callerLabel(walked), verdict.devApproval, sources.now());
  }
  // `up`'s own fallback: a delegate refusal that is not the plain "not a listed pane" is final,
  // and a file that omits `grant` does not ask.
  const delegateMissed = verdict === null || (verdict.kind === 'refused' && verdict.id === 'up.delegate');
  const grantSaid =
    !ordinaryAdmitted && delegateMissed && !createGranted && team.grant !== null
      ? (sources.grantGate ?? grantGate)({ act: 'up', io, home: sources.home })
      : null;
  const grantedSeat = grantSaid?.kind === 'passed' ? grantSaid.grant.seat : null;
  // The map's admission, the create-grant's own seat, a passed delegation, or the granted seat.
  const named = ordinaryAdmitted || delegated !== null || createGranted || grantedSeat !== null;
  if (!named && grantSaid?.kind === 'refused') return grantRefused(io, json, grantSaid.text);
  if (!named && verdict?.kind === 'refused') return delegateRefused(io, json, verdict.text);
  if (!named) {
    // The caller gate, the one dev mode lifts; a dry run keeps it as the refusal it is, with
    // the owner's own command beside it. The grant's and the delegate's own refusals stay
    // refusals either way, as they do for `up`.
    const line = notOwnerLine(caller);
    if (dev.on) warning.push(line);
    else return notOwnerRefused(out, json, caller, dry, unblock(args.values), devModeExpiryNote(dev));
  }
  if (warning.length > 0) {
    const line = [...new Set(warning)].join('; ');
    // The one override sentence every lifecycle command prints, its tail included.
    const folded = devModeCallerGate(dev, line) ?? line;
    if (!dry) logDevMode(dir, 'register', callerLabel(walked), folded, sources.now());
    if (json) out.stderr(`${plainText(folded)}\n`);
    else if (dry) out.stdout(`! ${plainText(folded)}\n`);
    else out.stderr(`team register: ${plainText(folded)}\n`);
  }

  const session = args.values.session ?? team.session;
  if (session === 'default') {
    return callerRefused(io, json, 'session can\'t be "default", herdr\'s own session');
  }

  const seat = team.seats.find((item) => item.name === name);
  if (!seat) return unknownRefused(io, json, name);
  if (seat.stopped) return stoppedRefused(io, json, name);
  const profile = profileFor(seat.cli);
  if (!profile) {
    return noProfileRefused(io, json, `no launch profile for \`${plainLine(seat.cli)}\` in this version`);
  }

  // The session's own record, read before herdr is asked. The file a session was launched from
  // is the one team a seat standing in it belongs to; the seat's own record says whether there
  // is anything to write at all.
  const recorded = readState(dir).sessions[session] ?? emptySession();
  const launchedFrom = recorded.launched_file;
  if (launchedFrom !== undefined && !sameFile(launchedFrom, path)) {
    return teamFileRefused(io, json, session, launchedFrom);
  }
  const held = recorded.seats[name];

  const liveState = sources.sessionState(session);
  if (liveState === null) return herdrRefused(io, json);
  if (liveState !== 'running') return noSessionRefused(io, json, session);
  const agents = sources.agents(session);
  if (agents === null) return herdrRefused(io, json);

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
      return paneNamedRefused(io, json, pane, listed.name, session);
    }
  } else {
    const named = agents.filter((agent) => agent.name === name);
    const waitingOnRecorded =
      held?.waiting?.classification === 'trust' && held.pane !== undefined
        ? agents.find((agent) => agent.pane === held.pane)
        : undefined;
    if (waitingOnRecorded !== undefined && waitingOnRecorded.name !== null && waitingOnRecorded.name !== name) {
      return paneNamedRefused(io, json, waitingOnRecorded.pane, waitingOnRecorded.name, session);
    }
    listed = waitingOnRecorded ?? named[0];
    if (listed === undefined) return noAgentRefused(io, json, name, session);
    if (!waitingOnRecorded && named.length > 1) return ambiguousRefused(io, json, name, session, named.length);
    pane = listed.pane;
  }
  // A pane is one seat's: the pane this run records — named by `--pane`, or the one herdr names
  // the seat on — must not be one another seat of this session's record already holds. A pane
  // herdr renamed to this seat, but recorded for another, would otherwise be held twice. The
  // file is the truth: a record for a seat the file no longer declares names nothing of this
  // team's, and its pane is free for a seat the file does name (`seatOfFile`; a temporary seat
  // the file never lists still holds its own).
  const declared = new Set(team.seats.map((item) => item.name));
  const holder = Object.entries(recorded.seats).find(
    ([seat, state]) => seat !== name && state.pane === pane && seatOfFile(seat, state, declared),
  );
  if (holder !== undefined) return paneTakenRefused(io, json, pane, holder[0], session);

  // A record that names another pane — or no pane at all, a launch this command did not finish —
  // is not overwritten from here: that is the owner's `team down`, then `team up`.
  if (held !== undefined && held.pane !== pane) {
    return recordedRefused(io, json, name, pane, held.pane);
  }

  // What the pane is: a process in front of the pane's own shell that the seat's CLI profile
  // names — the file's `cli` is the authority, and herdr's argv0 the reading. Read on every
  // path, the already-recorded one included: a pane whose CLI has exited or been replaced is
  // not the seat to record, whatever its record says it is.
  const procs = sources.processInfo(session, pane);
  // `--pane` names a pane another session's window holds just as well: herdr knowing nothing of
  // it in this one is the reading that says so, and is its own refusal.
  if (procs === null && paneArg !== undefined) return noPaneRefused(io, json, pane, session);
  const identity = launchedIdentity(procs);
  if (identity === null) return noCliRefused(io, json, name, pane);
  // The pane's own CLI, in the seat's profile's terms: the foreground argv0s where the caller
  // reads them, else the agent name herdr reports for that pane. A pane standing in front of
  // another agent is not this seat, and is not recorded.
  const live = sources.foreground
    ? sources.foreground(session, pane)
    : listed === undefined || listed.agent === null ? null : [listed.agent];
  if (!reportedLiveAgent(live, profile.processNames)) {
    return cliRefused(io, json, name, pane, seat.cli);
  }

  // The pane root this run would write is the launch's own: the process identity of the pane the
  // daemon launched, or the owner's walk recorded. A caller other than the owner — a seat of this
  // team, a delegate, a grant — may repeat the identity its record already holds and this live
  // pane still matches (a run in the seat's own unchanged pane, the pane `team restart` wrote), and it
  // may do everything else this command does; it may not make a root. A record that predates the
  // identity, a first record, and a replaced process are all that refusal. The gate sits on both
  // writes below: the already path's completion of a missing identity, and the adopt write. It is
  // the record's own evidence, not the caller gate's, so dev mode does not fold it: a folded
  // caller still records no root.
  const rootContinuity = seatProcessVerdict(held?.launched, procs);
  if (rootContinuity !== 'same' && !mayLaunchSeats(walked)) {
    return launchOnlyRefused(io, json, name, pane, dry, unblockRoot(args.values));
  }

  // Already recorded on this pane, and ready: the seat is not relaunched and its screen is not
  // read. The record a launch writes is written again from the file as it now stands — the
  // signing, the roster, the team's project pointers and the address — so the repair `team
  // check` names lands where the seat stands, and a file that gained `in_project` or a new
  // signing since the launch reaches the registry. The session's own record is left exactly as
  // it is, save for a launch's id and process identity it is missing, which this run completes.
  if (held !== undefined && held.pane === pane && held.stage === 'ready' && held.waiting === undefined) {
    // What this refresh may bind. The record it writes carries the handle the native route binds
    // the agent by, so the live pane must first prove it is the launch this record made: the
    // recorded process identity is compared with the pane's, and only a match — the recorded
    // shell with one of its recorded CLI pids in front — is continuity. A record that predates
    // the identity has none to compare, and the refresh completes it below. Ready on the same
    // pane is not proof.
    const continuity = seatProcessVerdict(held.launched, procs);
    if (held.launched !== undefined && continuity !== 'same') {
      return replacedProcessRefused(io, json, name, pane);
    }
    // The id the record would carry is this seat's, and only this seat's: the session's read
    // door already gives one seat per id, so the holder left to refuse is a live agent record of
    // this team carrying it under another seat's name. It is never written onto this seat.
    const carriedId = held.id ?? recorded.retained_seats?.[name]?.id;
    const holder = carriedId === undefined ? null : handleHolder(sources.home, root, name, carriedId);
    if (carriedId !== undefined && holder !== null) {
      return handleHeldRefused(io, json, name, carriedId, holder);
    }
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
    // Why the registry holds no record binding this seat, when it does not: the seat stands, but
    // native delivery cannot resolve it and only pull reaches it.
    let pullOnly: string | null = null;
    if (!dry) {
      const refreshedAt = sources.now();
      // The launch's own record, completed where this version reads a gap a launch that predates
      // it left: the seat id (`team seats`' `-`, and the registry agent's missing `seat_handle`)
      // and the process identity (`team doctor`'s "launched before team recorded its process").
      // The same id chain and the same identity read the launch path below writes; a record that
      // holds both is left byte for byte as it is — unless herdr reports a session id the record
      // does not hold. That reading is measured now, and the registry write below keeps the same
      // id, so the record takes it too rather than keeping a reading the registry no longer has.
      const seatId = carriedId ?? mintSeatId();
      const liveSession = listed?.session;
      const sessionMoved = liveSession !== undefined && held.agent_session !== liveSession;
      if (held.id === undefined || held.launched === undefined || sessionMoved) {
        updateState(dir, (state) => {
          const current = (state.sessions[session] ??= emptySession());
          if (current.retained_seats?.[name]) delete current.retained_seats[name];
          const carried = current.seats[name] ?? held;
          current.seats[name] = {
            ...carried,
            id: seatId,
            ...(carried.launched === undefined ? { launched: identity } : {}),
            ...(sessionMoved ? { agent_session: liveSession } : {}),
          };
        });
      }
      relabel(
        out,
        sources,
        session,
        seat,
        pane,
        listed?.workspace,
        name,
        sidebarPolicy({ home: sources.home, root, team, now: refreshedAt }).ttlMs,
      );
      // The audit lines a delegated and a granted act write, the same ones the launch path
      // writes below: this path is that act too, and its early return must not skip them.
      if (delegated !== null) logDelegated(dir, delegated, 'up', refreshedAt, 'register');
      if (grantedSeat !== null) logGranted(dir, grantedSeat, 'up', refreshedAt, 'register');
      // The record names the caller the run admitted, not the process the walk saw: a seat under
      // a pane override walks as unplaced and is judged as the seat its pane proves it is, and
      // `registered_by` must say the seat.
      const wrote = registerLaunch(
        {
          home: sources.home, team, root, by: callerLabel(caller), session, devMode: devModeMark(dev, devFolded || warning.length > 0), owner: walked.kind === 'owner',
          // An existing handle is rewritten only under the continuity proven above: the live
          // process is the one this record's launch started. Then a record holding another
          // incarnation's handle is bound to the live seat, not only the file's fields, and the
          // native route binds the agent again. A record that predates the identity is not
          // rebound from here: ready on the same pane is not proof, and the id below only fills
          // the handle such a record never had (the repair `team doctor` names).
          ...(continuity === 'same' ? { rebindSeatHandle: true } : {}),
        },
        seat,
        pane,
        seatId,
        listed?.session,
      );
      if ('note' in wrote) logLine(dir, 'register', callerLabel(walked), wrote.note, refreshedAt);
      else {
        refreshed = true;
        wroteRoster = unlisted;
        // The address, re-read the way a launch reads it, on the id the write above returned.
        const address = (sources.refreshAddress ?? refreshAgentAddress)(sources.home, wrote.id, pane, session);
        if (address.note) logLine(dir, 'register', callerLabel(walked), address.note, refreshedAt);
        logLine(dir, 'register', callerLabel(walked), `${name}: refreshed ${seatId} — pane ${pane}`, refreshedAt);
        if (wroteRoster) logLine(dir, 'register', callerLabel(walked), `${name}: roster line written — pane ${pane}`, refreshedAt);
      }
      // The record the seat's native route resolves the seat by, read back where it now stands
      // and with the binding that route needs: a conversation-addressed route also needs the
      // recorded agent session, while the seat record alone is enough where the route only places
      // the seat. A write that failed, or a record the checks refuse, leaves the seat reachable
      // only by pull; the run's own result says so rather than reporting the refresh as done.
      const lookedUp = {
        home: sources.home,
        root,
        herdrSession: session,
        seat,
        state: readState(dir).sessions[session]?.seats[name],
      };
      const record = nativePushBindingFor(seat.cli) === 'conversation'
        ? recordedSeatSession(lookedUp)
        : recordedSeatRecord(lookedUp);
      if (record.kind !== 'bound') pullOnly = record.why;
      // The general seat brief, through the one boundary every attribution path calls. This run
      // attributed no seat — the record was already here — so the boundary writes a fresh
      // lifetime for nobody; it delivers where a live seat's claim is missing or another build's,
      // and an idempotent delivery leaves a current claim and its verified drop as they are. The
      // call sits after the state record above, and a dry run never reaches this block.
      const briefs = deliverBriefForAttribution({
        dir,
        root,
        session,
        home: sources.home,
        now: refreshedAt,
        team,
        state: readState(dir).sessions[session] ?? emptySession(),
        // Registering one seat refreshes that seat's brief alone, never the rest of the team:
        // a fresh lifetime only where this seat's own claim is missing or another build's.
        attributed:
          currentBriefClaim(readState(dir).sessions[session]?.briefs?.[name])?.sha256 === GENERAL_BRIEF_SHA256
            ? []
            : [name],
        onlyAttributed: true,
      });
      await walkBriefDeliveries(briefs, { dir, home: sources.home });
      for (const delivery of briefs.deliveries) {
        if (delivery.ok) continue;
        const said = `${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`;
        out.stderr(`team register: ${plainText(said)}\n`);
        logLine(dir, 'register', callerLabel(walked), said, refreshedAt);
      }
      if (briefs.recording !== undefined) {
        const said = `the general seat brief was written and not recorded (${briefs.recording})`;
        out.stderr(`team register: ${plainText(said)}\n`);
        logLine(dir, 'register', callerLabel(walked), said, refreshedAt);
      }
    }
    const ended = `already registered — pane ${plainLine(pane)}`;
    const pull = pullOnly === null ? '' : `; pull-only: ${plainLine(pullOnly)}`;
    const line = wroteRoster
      ? `${plainLine(name)}: ${ended}; the team registry's roster did not list it, and was written${pull}`
      : unlisted && dry
        ? `${plainLine(name)}: ${ended}; the team registry's roster would be written${pull}`
        : dry || refreshed
          ? `${plainLine(name)}: ${ended}; the record ${dry ? 'would be' : 'was'} refreshed from the file, nothing relaunched${pull}`
          : `${plainLine(name)}: ${ended}; nothing was written${pull}`;
    if (json) {
      if (dry) {
        // A dry run's document is its plan whatever the real run would find, the already path
        // included: its one step is the write it would make, and nothing is launched.
        const detail = unlisted
          ? `${plainLine(name)}: ${ended}; the team registry's roster did not list it, and would be written`
          : `${plainLine(name)}: ${ended}; the record would be refreshed from the file, nothing relaunched`;
        writeJson(io, 'team.register', {
          format: 1,
          dry_run: true,
          status: 'dry-run',
          action_summary: 'dry run: nothing was run',
          project: team.project,
          session,
          seat: name,
          pane,
          plan: [{ step: 'register', seat: name, detail, prefix: '+' }],
          notes: jsonNotes,
        });
      } else {
        writeJson(io, 'team.register', {
          format: 1,
          dry_run: false,
          status: 'already',
          action_summary: line,
          project: team.project,
          session,
          seat: name,
          pane,
          notes: jsonNotes,
          ...(pullOnly === null ? {} : { pull_only: pullOnly }),
        });
      }
    } else {
      out.stdout(`${line}\n`);
    }
    // exit: register.already
    return 0;
  }

  // The screen: the seat at its prompt. A dialog, or a reading this version does not recognise,
  // is not a seat to record; the already path above does not read it.
  const text = sources.paneText(session, pane) ?? undefined;
  const screen = sources.screen ? sources.screen(seat.cli, text) : readScreen(seat.cli, text);
  const waitingTrust = held?.waiting?.classification === 'trust';
  const status = sources.agentStatus ? sources.agentStatus(session, pane) : listed?.status ?? null;
  const waitingIdle = waitingTrust && screen.kind === 'unknown' && unreadIdle(status);
  if (screen.kind !== 'idle' && screen.kind !== 'working' && !waitingIdle) {
    return screenRefused(io, json, name, screen.kind);
  }

  if (dry) {
    const would =
      paneArg === undefined
        ? `${plainLine(name)}: would register — pane ${plainLine(pane)}; nothing would be launched`
        : `${plainLine(name)}: would register — pane ${plainLine(pane)}; the pane would be named ${plainLine(name)} and recorded, nothing would be launched`;
    if (json) {
      // The plan's one step is this command's own line: what the real run would print for the
      // same pane, its `--pane` rename included.
      const detail =
        paneArg === undefined
          ? `${plainLine(name)}: registered — pane ${plainLine(pane)}; nothing was launched`
          : `${plainLine(name)}: registered — pane ${plainLine(pane)}; the pane was named ${plainLine(name)}, nothing was launched`;
      writeJson(io, 'team.register', {
        format: 1,
        dry_run: true,
        status: 'dry-run',
        action_summary: 'dry run: nothing was run',
        project: team.project,
        session,
        seat: name,
        pane,
        plan: [{ step: 'register', seat: name, detail, prefix: '+' }],
        notes: jsonNotes,
      });
    } else {
      out.stdout(`${would}\n`);
    }
    // exit: register.dry-run
    return 0;
  }

  const now = sources.now();
  // The pane `--pane` named, or a waiting-for-trust pane that left out before rename, carries no
  // name of the seat's yet: herdr is told it before anything is recorded. A rename herdr did not
  // take is a note, never a refusal: the record is what this command exists to write, and the next
  // `--pane` run names the pane again.
  const needsRename = paneArg !== undefined || waitingTrust || listed?.name !== name;
  const renamed = !needsRename || (sources.renameAgent ?? realRename)(session, pane, name);
  if (!renamed) {
    logLine(dir, 'register', callerLabel(walked), `the pane was not named ${name}: herdr did not take the rename`, now);
  }

  let finishedRules: 'option' | 'message' | 'undelivered' | undefined;
  if (waitingTrust) {
    // A record a launch wrote before the file marked this seat a human's may still say a trust
    // dialog is waiting. The mark is the last word: nothing is typed into a human's pane, so no
    // rules file is written and no rules line is typed, and the run says why.
    if (seat.human) {
      out.stdout(`${plainLine(name)}: the pane is a human's; no rules line was typed; left as it is\n`);
      logLine(dir, 'register', callerLabel(walked), `${name}: no rules line; the pane is a human's`, now);
    } else if (profile.rulesOption !== null) {
      finishedRules = 'option';
    } else {
      const standing = (sources.standing ?? ((r: string) => approvalStanding(r, sources.home)))(root);
      const delivery = rulesDeliveryOf(standing, team, seat, root, sources.home, false, rulesOriginOf(loaded.source));
      if ('refusal' in delivery) {
        return screenRefused(io, json, name, screen.kind);
      }
      const written = writeRulesFile(standing, seat.name, root, sources.home, delivery.text, rulesFileHash(delivery.text), undefined, team.project);
      if (!written.ok) {
        return screenRefused(io, json, name, screen.kind);
      }
      // The rules are never typed into the pane this run adopts: the file is all it writes, and
      // the seat reads it with the next launch that carries the line. A CLI whose launch line
      // takes no rules prompt has no such launch, and the run says that rather than naming a
      // restart that would change nothing.
      const said = rulesWrittenLine(name, profile);
      out.stdout(`${plainLine(name)}: ${said}\n`);
      logLine(dir, 'register', callerLabel(walked), `${name}: ${said}`, now);
      finishedRules = 'undelivered';
    }
  }

  const workspace = listed?.workspace ?? held?.workspace;
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
      ...(workspace !== undefined ? { workspace } : {}),
      ...(finishedRules !== undefined ? { rules: finishedRules } : {}),
      last_active: now.toISOString(),
      launched: identity,
      ...(listed?.session ? { agent_session: listed.session } : {}),
    };
    // The pointer `up` and `add` write for the panes they launch, so the seat's own `team send`
    // resolves this team file from the pane it stands in. Kept when the session already names it.
    current.launched_file = path;
  });
  // The reading a launch's own hooks left belongs to the record this run completes, and is
  // retired with it: a `working` written before the registration must not answer for the seat
  // now. The seat's next prompt writes the file again.
  resetCliHookState(dir, session, [name]);

  // The judged caller, as above: `registered_by` is the seat the admission found, never the
  // unplaced process the walk saw under a pane override.
  const wrote = registerLaunch({ home: sources.home, team, root, by: callerLabel(caller), session, devMode: devModeMark(dev, devFolded || warning.length > 0), owner: walked.kind === 'owner' }, seat, pane, id, listed?.session);
  if ('note' in wrote) logLine(dir, 'register', callerLabel(walked), wrote.note, now);
  else {
    // The address: the live session socket this seat answers at, recorded on the agent the way a
    // launch records it — the pane above is the one herdr showed, read again as `add` reads it.
    // The record it names is the registry's agent, the id the write above returned.
    const refreshed = (sources.refreshAddress ?? refreshAgentAddress)(sources.home, wrote.id, pane, session);
    if (refreshed.note) logLine(dir, 'register', callerLabel(walked), refreshed.note, now);
  }
  // The general seat brief, through the one boundary every attribution path calls: this run
  // attributed the seat, so it gets a fresh delivery lifetime, and the broadcast reaches the rest
  // of the team. The claim is written here, after the state record above and before any line says
  // the seat is up; the seat itself reads the drop at its next turn. A delivery that cannot be
  // written is said and logged, and the registration goes on; `team check` names the seat.
  const briefs = deliverBriefForAttribution({
    dir,
    root,
    session,
    home: sources.home,
    now,
    team,
    state: readState(dir).sessions[session] ?? emptySession(),
    attributed: [name],
    // One seat registered: its brief alone, never a drop to the rest of the team.
    onlyAttributed: true,
  });
  await walkBriefDeliveries(briefs, { dir, home: sources.home });
  for (const delivery of briefs.deliveries) {
    if (delivery.ok) continue;
    const said = `${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`;
    out.stderr(`team register: ${plainText(said)}\n`);
    logLine(dir, 'register', callerLabel(walked), said, now);
  }
  if (briefs.recording !== undefined) {
    const said = `the general seat brief was written and not recorded (${briefs.recording})`;
    out.stderr(`team register: ${plainText(said)}\n`);
    logLine(dir, 'register', callerLabel(walked), said, now);
  }
  // The seat's sidebar, painted from the file the way `up` and `add` paint it: the record above
  // makes the seat reachable; these two writes make its own lines say what the file says.
  const sidebarTtlMs = sidebarPolicy({ home: sources.home, root, team, now }).ttlMs;
  relabel(out, sources, session, seat, pane, workspace, name, sidebarTtlMs);
  noteLaunchedPane(sources.home, path, pane, session);
  // The audit line a delegated act writes, naming the authority (`up`) it was run under; a
  // granted seat writes the grant's own line.
  if (delegated !== null) logDelegated(dir, delegated, 'up', now, 'register');
  if (grantedSeat !== null) logGranted(dir, grantedSeat, 'up', now, 'register');
  logLine(dir, 'register', callerLabel(walked), `${name}: registered ${id} — pane ${pane}`, now);
  const registered =
    paneArg === undefined
      ? `${plainLine(name)}: registered — pane ${plainLine(pane)}; nothing was launched`
      : `${plainLine(name)}: registered — pane ${plainLine(pane)}; ${
        renamed ? `the pane was named ${plainLine(name)}` : 'herdr did not take the name'
      }, nothing was launched`;
  if (json) {
    writeJson(io, 'team.register', {
      format: 1,
      dry_run: false,
      status: 'ready',
      action_summary: registered,
      project: team.project,
      session,
      seat: name,
      pane,
      notes: jsonNotes,
    });
  } else {
    out.stdout(`${registered}\n`);
  }
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
  ttlMs = SIDEBAR_TTL_CAP_MS,
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
  const reported = (
    sources.reportDisplayAgent ?? ((s, p, text, ttl = SIDEBAR_TTL_CAP_MS) => reportDisplayAgent(p, text, s, ttl))
  )(session, pane, display, ttlMs);
  if (!reported) out.stdout(`${plainLine(name)}: its display was not reported\n`);
}

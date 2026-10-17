// `team register <seat>`: the record for a seat that is already running. `up` and `add` write a
// seat's record only in the run that launched it, so a seat someone else started — an older
// `team`, a hand-run CLI in a session this team owns — is a live pane no `team` command may
// address: `add` answers "already running", and `up` refuses the whole session as one whose
// agents this file's state does not record. This command verifies such a pane and writes the
// record without touching it: the same gate as `up` (the owner, or what the file names for
// `up`), the same reading of herdr and the pane's screen, and the state and registry writes a
// launch of it would have made.
//
// What it does not write is what only a launch can know: the state's `model`, `version`,
// `effort` and `launch_line` are "what this launch declared", and a pane started by hand
// declares nothing this run can read. The file's seat is the authority for the cli, and herdr
// for the pane, the workspace and the agent session.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import { callerLabel, describeCaller, detachedRefusal, mayLaunchSeats, sessionOwnerRefusal, walkCaller, type Caller } from '../caller.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
import { noteLaunchedPane } from '../file/launched-file.ts';
import { loadTeamFile } from '../file/load.ts';
import { entityGrantAdmits, grantGate, logGranted } from '../grant.ts';
import { agentList, paneForeground, paneProcesses, paneRead, sessionState, type HerdrAgent, type PaneProcesses, type SessionState } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { reportedLiveAgent } from '../launch/agent.ts';
import { launchedIdentity } from '../launch/identity.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { profileFor } from '../profiles/index.ts';
import { registerLaunch } from '../registry/sync.ts';
import { refreshAgentAddress } from '../send/address.ts';
import { emptySession, mintSeatId, readState, updateState, type SeatState } from '../state.ts';
import { readScreen, type Screen } from '../watch/screen.ts';

export const USAGE = `Usage: team register <seat> [--session <name>] [--dry-run]\n`;

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
  now: () => Date;
};

const realSources: RegisterSources = {
  home: homedir(),
  sessionState: (session) => sessionState(session),
  agents: (session) => agentList(session),
  processInfo: (session, pane) => paneProcesses(pane, session),
  foreground: (session, pane) => paneForeground(pane, session),
  paneText: (session, pane) => paneRead(pane, 200, session),
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

function callerRefused(out: Io, message: string): number {
  out.stderr(`team register: ${plainText(message)}\n`);
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

function notOwnerRefused(out: Io, caller: Caller): number {
  out.stderr(
    `team register: only the owner, a delegate this file names for \`up\`, or the seat a grant names for it registers a running seat; this call is ${plainLine(describeCaller(caller))}\n`,
  );
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
  const args = readArgs(argv, ['session'], ['dry-run']);
  if (args.error) return usage(out, args.error);
  if (args.rest.length !== 1) {
    return usage(out, args.rest.length > 1 ? `unexpected "${plainLine(args.rest[1] ?? '')}"` : 'a seat name is required');
  }
  const name = args.rest[0] ?? '';
  const dry = args.flags.has('dry-run');

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

  // The gate, `up`'s own: the owner, a delegate this file names for `up` — the act that
  // would have written this record in the first place — the seat the file's `grant` names for
  // `up`, or the create-granted runner. The run launches nothing, so no launch is granted; but
  // the record is what lets `team send` type into the pane, so it is the owner's authority,
  // judged by the same gate and in the same order: the ordinary rule first, the delegate gate
  // only where it refused and the file has a delegates section to read, and the grant only
  // where no delegate took the run and the file has a `grant` at all.
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
  const named = mayLaunchSeats(walked) || delegated !== null || createGranted || grantedSeat !== null;
  // `--session` picks the herdr session the pane is verified in: where the record it writes will
  // point `send`, `watch` and `down`. It is the owner's: a granted seat is refused in the grant's
  // own words, and everyone else — a delegate that aimed it included — before the named session
  // is read.
  if (args.values.session !== undefined && !mayLaunchSeats(walked) && !createGranted) {
    if (grantedSeat !== null) return grantFlagRefused(out);
    return callerRefused(out, sessionOwnerRefusal(walked));
  }
  if (!named && grantSaid?.kind === 'refused') return grantRefused(out, grantSaid.text);
  if (!named && verdict?.kind === 'refused') return delegateRefused(out, verdict.text);
  if (!named) return notOwnerRefused(out, walked);

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

  const found = agents.find((agent) => agent.name === name);
  const namedCount = agents.filter((agent) => agent.name === name).length;
  if (found === undefined) return noAgentRefused(out, name, session);
  if (namedCount > 1) return ambiguousRefused(out, name, session, namedCount);

  // Already recorded on this pane, and ready: there is nothing to write, and the pane is not
  // read. A record that names another pane — or no pane at all, a launch this command did not
  // finish — is not overwritten from here: that is the owner's `team down`, then `team up`.
  if (held !== undefined && held.pane === found.pane && held.stage === 'ready') {
    out.stdout(`${plainLine(name)}: already registered — pane ${plainLine(found.pane)}; nothing was written\n`);
    // exit: register.already
    return 0;
  }
  if (held !== undefined && held.pane !== found.pane) {
    return recordedRefused(out, name, found.pane, held.pane);
  }

  // What the pane is: a process in front of the pane's own shell that the seat's CLI profile
  // names — the file's `cli` is the authority, and herdr's argv0 the reading — and a screen the
  // seat's profile reads as the seat at its prompt. A dialog, a CLI that has exited, another
  // CLI in front, or a reading this version does not recognise is not a seat to record;
  // neither is a shell behind a name herdr still lists for it.
  const identity = launchedIdentity(sources.processInfo(session, found.pane));
  if (identity === null) return noCliRefused(out, name, found.pane);
  // The pane's own CLI, in the seat's profile's terms: the foreground argv0s where the caller
  // reads them, else the agent name herdr reports for that pane. A pane standing in front of
  // another agent is not this seat, and is not recorded.
  const live = sources.foreground ? sources.foreground(session, found.pane) : found.agent === null ? null : [found.agent];
  if (!reportedLiveAgent(live, profile.processNames)) {
    return cliRefused(out, name, found.pane, seat.cli);
  }
  const text = sources.paneText(session, found.pane) ?? undefined;
  const screen = sources.screen ? sources.screen(seat.cli, text) : readScreen(seat.cli, text);
  if (screen.kind !== 'idle' && screen.kind !== 'working') {
    return screenRefused(out, name, screen.kind);
  }

  if (dry) {
    out.stdout(`${plainLine(name)}: would register — pane ${plainLine(found.pane)}; nothing would be launched\n`);
    // exit: register.dry-run
    return 0;
  }

  const now = sources.now();
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
      pane: found.pane,
      workspace: found.workspace,
      last_active: now.toISOString(),
      launched: identity,
      ...(found.session ? { agent_session: found.session } : {}),
    };
    // The pointer `up` and `add` write for the panes they launch, so the seat's own `team send`
    // resolves this team file from the pane it stands in. Kept when the session already names it.
    current.launched_file = path;
  });

  const wrote = registerLaunch({ home: sources.home, team, root, by: callerLabel(walked), session }, seat, found.pane, id);
  if ('note' in wrote) logLine(dir, 'register', callerLabel(walked), wrote.note, now);
  else {
    // The address: the live session socket this seat answers at, recorded on the agent the way a
    // launch records it — the pane above is the one herdr showed, read again as `add` reads it.
    // The record it names is the registry's agent, the id the write above returned.
    const refreshed = (sources.refreshAddress ?? refreshAgentAddress)(sources.home, wrote.id, found.pane, session);
    if (refreshed.note) logLine(dir, 'register', callerLabel(walked), refreshed.note, now);
  }
  noteLaunchedPane(sources.home, path, found.pane, session);
  // The audit line a delegated act writes, naming the authority (`up`) it was run under; a
  // granted seat writes the grant's own line.
  if (delegated !== null) logDelegated(dir, delegated, 'up', now, 'register');
  if (grantedSeat !== null) logGranted(dir, grantedSeat, 'up', now, 'register');
  logLine(dir, 'register', callerLabel(walked), `${name}: registered ${id} — pane ${found.pane}`, now);
  out.stdout(`${plainLine(name)}: registered — pane ${plainLine(found.pane)}; nothing was launched\n`);
  // exit: register.ready
  return 0;
}

import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  describeCaller,
  detachedRefusal,
  fileOwnerRefusal,
  isOwner,
  judgeCallerIn,
  judgeCallerOf,
  logTag,
  noPaneRefusal,
  sessionOwnerRefusal,
  standingOf,
  walkCaller,
  type Caller,
} from '../caller.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { readLaunchedTeam } from '../file/team-text.ts';
import type { Problem } from '../file/types.ts';
import { agentList, sessionState, workspaceList, type HerdrAgent } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { sidebarTail } from '../launch/auto-order.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { gateVerdict } from '../permissions/who.ts';
import { readState } from '../state.ts';
import { unverifiedRecordSentence } from '../approve/unverified-record.ts';
import { devModeState } from '../dev_mode.ts';
import { approvalStanding, findStore, readApproval, type Standing } from '../store/store.ts';
import { notInForce } from '../approve/approval.ts';
import { realSources as restartSources, runRestart } from './restart.ts';

export const USAGE = `Usage: team order [--dry-run] [--session <name>] [--file <path>]

Re-orders the session's sidebar to the roster: the orchestrator's seat first, then the remaining
seats in the team file's order. The pane host keeps no move command — the sidebar follows the
workspaces' creation order, and a re-added or restarted seat lands at the end — so this command
closes and re-creates, through \`team restart\`, exactly the seats from the first position where
the two orders diverge. Each re-created seat resumes its recorded conversation, as a restart
does. Workspaces that hold no declared seat (the watch, the bus) never move and may stay between
seats; the seats' own relative order is what this command restores.

A seat that is working or blocked at a prompt is never interrupted: the run refuses up front and
names them. A run from a seat whose own pane is in the moving set refuses too — closing it would
kill this very run. \`--dry-run\` prints the set it would close and re-create, and touches
nothing.

Exits 0 when the sidebar matches the roster (or was brought to it, or the dry-run plan is
printed), 1 when the re-order is refused or a restart in it fails, 2 when the invocation or team
file can't be read.
`;

/** What `team order` reads and whom it delegates to, so tests can stand in for all of it. */
export type OrderSources = {
  home: string;
  now(): Date;
  sessionState(session: string): 'absent' | 'running' | 'stopped' | null;
  /** The session's workspaces in the order the pane host holds them (the sidebar's order). */
  workspaces(session: string): { id: string }[] | null;
  /** The session's agents, for the working pre-flight read by pane. */
  agents(session: string): HerdrAgent[] | null;
  /** The team's state record; a record that cannot be read fails the run before anything closes. */
  state(dir: string): ReturnType<typeof readState>;
  standing?: (root: string) => Standing;
  /** One seat's relaunch, exactly as `team restart <seat>` runs it. */
  restart(argv: string[], io: Io): Promise<number>;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: OrderSources = {
  home: homedir(),
  now: () => new Date(),
  sessionState,
  workspaces(session) {
    const listed = workspaceList(aim(session));
    return listed === null ? null : listed.map((workspace) => ({ id: workspace.id }));
  },
  agents: (session) => agentList(aim(session)),
  state: (dir) => readState(dir),
  restart: (argv, io) => runRestart(argv, io, restartSources),
};

export const order: Command = (argv, io) => runOrder(argv, io, realSources);
export default order;

/**
 * `team order` — the sidebar read in roster order, the orchestrator first. The command owns no
 * stop or launch of its own: it computes the out-of-order tail and hands each seat of it to
 * `team restart`, which already holds the busy refusals, the unsent-draft copy and the recorded
 * conversation's resume. Who may run it: the owner or a seat this team's map admits as `leads`
 * on its recorded pane — the same row as `restart`, whose act each seat's move is. There is no
 * dev-mode fold here: `order` is not one of the operations the machine's development-mode policy
 * lifts, so its gate refuses where `restart` would only warn, and the seats can still be
 * restarted one at a time.
 */
export async function runOrder(argv: string[], io: Io, sources: OrderSources = realSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file'], ['dry-run']);
  if (args.error || args.rest.length > 0) {
    const reason = args.error ?? `unexpected "${plainLine(args.rest[0] ?? '')}"`;
    return usage(out, reason);
  }
  const dry = args.flags.has('dry-run');

  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or a `leads` seat', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return detachedExit(out, detached);

  const flagRefusal = fileOwnerRefusal(io, args.values.file)
    ?? (args.values.session !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) return callerRefused(out, flagRefusal);

  const launched = args.values.file ? undefined : launchedTeamFile(io, sources.home);
  const readOptions = {
    home: sources.home,
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  };
  const loaded = args.values.file
    ? readTeamConfig(io.cwd, { ...readOptions, file: args.values.file })
    : launched !== undefined
      ? readLaunchedTeam(launched, readOptions)
      : readTeamConfig(io.cwd, readOptions);
  if (!loaded.ok) {
    return configuration(out, loaded.errors.map((problem) => `${where(problem)}${plainText(problem.message)}`).join('\n'));
  }
  const { team, root, path } = loaded;
  const dir = dirname(path);

  const home = sources.home ?? homedir();
  const at = sources.now();
  const verdictOf = (who: Caller, standing: ReturnType<typeof standingOf>): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'order', standing, sources.now);
  // A run that named a session is judged in it, exactly as `restart` judges its own: the flag
  // names the session whose sidebar this pass reorders, so the caller is placed there and every
  // read below (the state record, the sidebar, the agents) follows — never the file's own session.
  const judged = args.values.session !== undefined
    ? { ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session), session: args.values.session }
    : judgeCallerIn(io, dir, team, verdictOf);
  const { caller, shown, session } = judged;
  if (session === 'default') {
    return callerRefused(out, 'session can\'t be "default", herdr\'s own session');
  }

  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  if (standing.kind !== 'verified' && standing.kind !== 'none') {
    // Outside dev mode the refusal is the standing's own line. In dev mode the fold is the one
    // restart uses: name the record, the unverified lines, and that standing cannot be renewed.
    // Nothing here signs.
    const dev = devModeState(io, { home: sources.home, team, root, now: sources.now() });
    if (!dev.on) return callerRefused(out, notInForce(standing));
    const store = findStore(root, home);
    const file = store === null ? '' : (readApproval(store)?.file ?? '');
    const sentence = unverifiedRecordSentence(`${team.project}'s approval record`, file);
    out.stderr(`team order: ${plainText(sentence)}\n`);
  }
  // The gate is the map's own `order` row, read exactly as `restart` reads its own: the owner,
  // or a seat this team's file admits as `leads` placed on its recorded pane in this session.
  const mayOrder = verdictOf(caller, standingOf(dir, session, caller));
  if (mayOrder.kind !== 'ok') {
    const refusal = mayOrder.kind === 'no-pane' ? noPaneRefusal(mayOrder.name)
      : mayOrder.kind === 'another-pane' ? anotherPaneRefusal(mayOrder.name, mayOrder.recordedPane)
        : `only the owner or \`leads\` orders the sidebar; this call is ${plainLine(describeCaller(shown))}`;
    return callerRefused(out, refusal);
  }

  const liveState = sources.sessionState(session);
  const workspaces = sources.workspaces(session);
  const agents = sources.agents(session);
  if (liveState === null || workspaces === null || agents === null) return herdrRefused(out);
  if (liveState !== 'running') return noSessionRefused(out, session);

  let state: ReturnType<typeof readState>;
  try {
    state = sources.state(dir);
  } catch {
    return configuration(out, 'the team\'s state record can\'t be read');
  }
  const recorded = state.sessions[session];

  // The roster order this run aims at and the tail that would move: the one computation
  // shared with the automatic pass after add/restart, so the two can never disagree
  // about what is out of order.
  const { roster, inSidebar, aimed, tail } = sidebarTail(team, recorded, workspaces, agents);

  out.stdout(`team order: sidebar: ${inSidebar.join(', ')}\n`);
  out.stdout(`team order: roster: ${aimed.join(', ')}\n`);

  if (tail.length === 0) {
    out.stdout('team order: the sidebar already reads in roster order; nothing was closed\n');
    logLine(dir, 'order', logTag(walked), `sidebar already in roster order (session ${plainLine(session)})`, at);
    // exit: order.match
    return 0;
  }
  // The moving tail: the seats from the first divergence on, re-created in roster order.
  // The sidebar's own slice holds the same seats in its current order, so the tail is
  // both the membership and the sequence.
  const set = tail;
  const sequence = tail;

  // A run may not close the pane it runs in: the loop below would kill this command mid-pass.
  if (caller.kind === 'seat') {
    const own = caller.name !== undefined && set.includes(caller.name);
    const ownPane = caller.pane !== undefined && set.some((name) => recorded?.seats[name]?.pane === caller.pane);
    if (own || ownPane) {
      return selfRefused(out, dir, logTag(walked), caller.name ?? 'this seat', at);
    }
  }

  // No seat mid-turn is interrupted: the pre-flight reads the pane host's own status per seat and
  // refuses the whole pass while any seat of the set works or sits at a prompt. What the pane
  // host cannot say here — unsent text, an exit question — `team restart` itself refuses seat by
  // seat, and the pass stops there, honestly, after the seats before it.
  const busy: string[] = [];
  for (const name of set) {
    const pane = recorded?.seats[name]?.pane;
    const agent = pane === undefined ? undefined : agents.find((one) => one.pane === pane);
    if (agent?.status === 'working') busy.push(`${name} is working`);
    else if (agent?.status === 'blocked') busy.push(`${name} is blocked at a prompt`);
  }
  if (busy.length > 0) {
    return busyRefused(out, dir, logTag(walked), busy, at);
  }

  if (dry) {
    out.stdout(`team order: would close and re-create ${sequence.join(', ')} in roster order, each through team restart; nothing was closed\n`);
    logLine(dir, 'order', logTag(walked), `dry-run: would re-order ${sequence.join(', ')} (session ${plainLine(session)})`, at);
    // exit: order.dry-run
    return 0;
  }

  out.stdout(`team order: closing and re-creating ${sequence.join(', ')} in roster order, each through team restart\n`);
  // The owner's own --session/--file govern the delegated restarts too: a run that named either
  // reads and places in that session and file, and each `team restart` it delegates to must run
  // against the same ones — else the pass would reorder one session's sidebar while restarting
  // the seats in another.
  const restartArgv = (name: string): string[] => [
    name,
    ...(args.values.session !== undefined ? ['--session', args.values.session] : []),
    ...(args.values.file !== undefined ? ['--file', args.values.file] : []),
  ];
  const restarted: string[] = [];
  for (const name of sequence) {
    const code = await sources.restart(restartArgv(name), io);
    if (code !== 0) {
      out.stderr(`team order: team restart ${plainLine(name)} exited ${code}; ${restarted.length === 0 ? 'no seat before it moved' : `${plainLine(joinList(restarted))} relaunched`}; run team order again once it clears\n`);
      logLine(dir, 'order', logTag(walked), `stopped at ${plainLine(name)}: restart exited ${code}`, at);
      // exit: order.stopped
      return 1;
    }
    restarted.push(name);
  }

  // The pass verifies what it claims: the sidebar's own order, re-read, names the seats in roster
  // order. A pane host that answered something else is said, never assumed.
  const after = sources.workspaces(session);
  let afterState: ReturnType<typeof readState>;
  try {
    afterState = sources.state(dir);
  } catch {
    afterState = state;
  }
  const afterRecorded = afterState.sessions[session];
  const afterAgents = sources.agents(session) ?? agents;
  const afterWorkspaceOf = (name: string): string | undefined => {
    const held = afterRecorded?.seats[name]?.workspace;
    if (held !== undefined) return held;
    const pane = afterRecorded?.seats[name]?.pane;
    const agent = pane === undefined ? undefined : afterAgents.find((one) => one.pane === pane);
    return agent?.workspace;
  };
  const afterSidebar = (after ?? workspaces).flatMap((workspace) => {
    const name = roster.find((seat) => afterWorkspaceOf(seat) === workspace.id);
    return name === undefined ? [] : [name];
  });
  if (afterSidebar.join('|') !== aimed.join('|')) {
    out.stderr(`team order: the sidebar does not read in roster order after the pass: ${afterSidebar.join(', ')}\n`);
    logLine(dir, 'order', logTag(walked), `re-ordered but the sidebar reads ${afterSidebar.join(', ')} (session ${plainLine(session)})`, at);
    // exit: order.unordered
    return 1;
  }
  out.stdout(`team order: sidebar: ${afterSidebar.join(', ')}\n`);
  logLine(dir, 'order', logTag(walked), `re-ordered ${joinList(restarted)} (session ${plainLine(session)})`, at);
  // exit: order.done
  return 0;
}

/** `a`, `a and b`, `a, b and c` — the roster lists read as one phrase. */
function joinList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'nothing';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

function where(problem: Problem): string {
  return problem.line ? `team config line ${problem.line}: ` : '';
}

function usage(out: Io, message: string): number {
  out.stderr(`team order: ${plainText(message)}\n${USAGE}`);
  // exit: order.usage
  return 2;
}

function configuration(out: Io, message: string): number {
  out.stderr(`team order: ${plainText(message)}\n`);
  // exit: order.configuration
  return 2;
}

function detachedExit(out: Io, message: string): number {
  out.stderr(`team order: ${message}\n`);
  // exit: order.detached
  return 1;
}

function callerRefused(out: Io, message: string): number {
  out.stderr(`team order: ${plainText(message)}\n`);
  // exit: order.caller
  return 1;
}

function selfRefused(out: Io, dir: string, caller: string, name: string, at: Date): number {
  out.stderr(`team order: this run sits in ${name}'s own pane, and closing it would end the pass; another \`leads\` seat (or the owner) orders it\n`);
  logLine(dir, 'order', caller, `refused order.self: the run sits in ${plainLine(name)}'s pane`, at);
  // exit: order.self
  return 1;
}

function busyRefused(out: Io, dir: string, caller: string, busy: string[], at: Date): number {
  out.stderr(`team order: ${busy.join('; ')}; left as they are, nothing was closed\n`);
  logLine(dir, 'order', caller, `refused order.busy: ${busy.join('; ')}`, at);
  // exit: order.busy
  return 1;
}

function herdrRefused(out: Io): number {
  out.stderr('team order: the pane host does not answer\n');
  // exit: order.herdr
  return 1;
}

function noSessionRefused(out: Io, session: string): number {
  out.stderr(`team order: session "${plainLine(session)}" is not running\n`);
  // exit: order.no-session
  return 1;
}

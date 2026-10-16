// Bare `team check`: one answer to "is anything wrong with this team that someone should act on",
// for the callers who may see it — the owner, a seat of the team, and a pane the team's approved
// file names (design note §3, §4). It needs no git, it reads, and it changes nothing: the file is
// resolved with `remember` false for every caller, nothing of the watch's pass, report, readings
// or nudge path is called, and the one screen reading (§3.3a) is read-only.
//
// The caller decides, not the flags. The walk classifies the caller before any target is opened,
// and a caller that does not pass as one of the three gets one fixed sentence and nothing else,
// whatever failed underneath — a loader error, a refused standing, herdr's silence, an aimed flag
// and every caller detail among them (the two-phase rule, §4).
import { approvalCase, watchInForceOf } from '../approve/approval.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { approvalDrift, emptyOverrides, overrideDrift, protectedCheckouts, realSources, rulesFileDifferences } from '../commands/status.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { agentList, PANE_WINDOW, paneProcesses, paneRead, sessionRunning, workspaceList, type PaneProcesses } from '../herdr.ts';
import type { Io } from '../io.ts';
import { overridesInForceOf } from '../profiles/overrides.ts';
import { mayReadTeam } from '../read-gate.ts';
import { emptySession, readState, type SessionState, type State } from '../state.ts';
import { compare, orderAndAnnotateDifferences, type Difference, type Live } from '../status/compare.ts';
import type { Standing } from '../store/store.ts';
import type { Attention } from '../watch/check.ts';
import { attentionOf } from '../watch/pass.ts';
import { readScreen } from '../watch/screen.ts';

/** The team check's own arguments: both flags are the owner's, and both are optional. */
export type TeamCheckArgs = { session?: string; file?: string };

// What the check reads from outside the file and the state, so tests and the docs harness can
// stand in for it: the same reads `status` makes, except that the live read is narrowed to the
// panes this project's state records for this team's seats (§3.3a).
export type CheckSources = {
  live(session: string, team: TeamFile, state: SessionState): Live | null;
  branch(path: string): string | null;
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the approval record and the override file. Absent in a test
   *  that does not set one, exactly as `StatusSources.home`. */
  home?: string;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
};

/**
 * The shipped sources. The live read is `status`'s own with one narrowing: `status` reads every
 * agent's pane, a stray's included, and this reads a pane only where this project's state records
 * one for a seat of this team in the session read. The rest is the same code, not a copy of it.
 */
export const realCheckSources: CheckSources = {
  live(session, team, state) {
    const running = sessionRunning(session);
    if (running === null) return null;
    if (!running) return { running: false, agents: [], workspaces: [], screens: {} };
    const agents = agentList(session);
    const workspaces = workspaceList(session);
    if (!agents || !workspaces) return null;
    // The panes this project's state records for this team's seats: a pane recorded for another
    // session, another project or nobody at all is not read here.
    const recorded = new Set<string>();
    for (const seat of team.seats) {
      const pane = state.seats[seat.name]?.pane;
      if (pane) recorded.add(pane);
    }
    const screens: Record<string, string> = {};
    const processes: Record<string, PaneProcesses | null> = {};
    for (const agent of agents) {
      if (!recorded.has(agent.pane)) continue;
      const screen = paneRead(agent.pane, PANE_WINDOW, session);
      if (screen !== null) screens[agent.pane] = screen;
      // The pane's process identity, for the comparison with the one the state recorded: a pane
      // that no longer holds what team launched is not the seat. Null when herdr can't tell.
      processes[agent.pane] = paneProcesses(agent.pane, session);
    }
    // A recorded seat herdr no longer lists an agent for still has its pane standing where it was
    // launched: read too, so one left holding its shell is told apart from one that is gone.
    for (const seat of team.seats) {
      const held = state.seats[seat.name];
      if (!held?.launched || !held.pane || held.pane in processes) continue;
      processes[held.pane] = paneProcesses(held.pane, session);
      const screen = paneRead(held.pane, PANE_WINDOW, session);
      if (screen !== null) screens[held.pane] = screen;
    }
    return { running: true, agents, workspaces, screens, processes };
  },
  branch: realSources.branch,
  standing: realSources.standing,
  now: realSources.now,
  home: realSources.home,
};

/**
 * The check's run. Every return is one of the check's own exits, and every one of them is reached
 * only after the caller gate above it has answered (design §4's two-phase rule).
 */
export function runTeamCheck(args: TeamCheckArgs, io: Io, sources: CheckSources): number {
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  // Phase 1 is the typed line and the walk alone. Phase 2 resolves the file, the approval's
  // standing, the state and herdr — and uses all of it only to decide: for a caller that does not
  // pass, `--file` is never opened and no session is placed, so the target is the file the
  // caller's own place finds.
  const current = currentTeam(io.cwd, owner ? args.file : undefined, sources.now(), sources.home, false);
  if (owner) {
    if (!current.ok) {
      printProblems(io, current.errors);
      // exit: check.not-a-repo
      // exit: check.file
      // exit: check.file-invalid
      return 2;
    }
  } else {
    if (!current.ok || !mayReadTeam(current, io, sources)) {
      return notYours(io);
    }
    // The caller passes and is not the owner: the flags aim nothing, and one aimed meets the
    // refusal every other command gives it — after the gate, never before it.
    if (args.file !== undefined) {
      io.stderr(`team check: ${fileOwnerRefusal(io, args.file)}\n`);
      // exit: check.file-owner
      return 1;
    }
    if (args.session !== undefined) {
      io.stderr(`team check: ${sessionOwnerRefusal(walked)}\n`);
      // exit: check.session-owner
      return 1;
    }
  }
  const { team, root, dir } = current;
  const session = owner ? (args.session ?? team.session) : team.session;
  // The one read of the approval store: the drift, and the values in force, all derive from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  let whole: State;
  try {
    whole = readState(dir);
  } catch (error) {
    io.stderr(`team check: ${error instanceof Error ? error.message : String(error)}\n`);
    // exit: check.state
    return 2;
  }
  const state = whole.sessions[session] ?? emptySession();
  const live = sources.live(session, team, state);
  if (!live) {
    io.stderr('team check: herdr doesn\'t answer; is it installed and running?\n');
    // exit: check.herdr
    return 2;
  }
  const comparison = compare(team, session, state, live, sources.now(), watchInForceOf(standing, team));
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...attentionDifferences(team, state, live),
    ...protectedCheckouts(team, root, { branch: sources.branch }),
    ...approvalDrift(approvalCase(standing, team)),
    ...overrideDrift(overrides),
    ...rulesFileDifferences(standing, team, root, sources.home),
  ]);
  const differences = comparison.differences;
  for (const difference of differences) {
    io.stdout(`difference: ${difference.what}\n  repair: ${difference.repair}\n`);
  }
  const ownerCount = differences.filter((difference) => difference.owner === true).length;
  if (differences.length === 0) {
    io.stdout('team check: nothing wrong\n');
  } else {
    io.stdout(`team check: ${differences.length} difference(s)${ownerCount > 0 ? `, ${ownerCount} for the owner` : ''}\n`);
  }
  // What the check cannot see is not silently implied to be fine (§3.4, decision 2): the one line
  // that names it stands under both answers.
  io.stdout('not known: work sent and unread, a lead waiting on a seat, a landing not recorded\n');
  // exit: check.findings
  // exit: check.ok
  return differences.length > 0 ? 1 : 0;
}

// The one sentence a caller that does not pass gets, whatever failed underneath it: it names no
// seat, no session and no path, and it is the only output such a caller can get (§3.4, §4).
function notYours(io: Io): number {
  io.stderr('team check: this team is not yours to check\n');
  // exit: check.not-yours
  return 2;
}

/**
 * The watch's own report texts, as differences with the repair beside them (§3.3a): one read of
 * each pane this project's state records for a seat of this team, through the watch's own reader.
 * No write, no key, no nudge, and no pane the state does not record for this team. `to` stays the
 * watch's word for who acts, and no line quotes a seat's screen text.
 */
function attentionDifferences(team: TeamFile, state: SessionState, live: Live): Difference[] {
  const out: Difference[] = [];
  for (const seat of team.seats) {
    const recorded = state.seats[seat.name]?.pane;
    if (recorded === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    // Only the pane the state records for this seat, and only where that seat answers on it: a
    // pane herdr lists for the name on any other pane is a stale record, and is not read.
    if (!agent || agent.pane !== recorded) continue;
    const quiet = agent.status === 'idle' || agent.status === 'done';
    const view = viewOf(attentionOf(readScreen(seat.cli, live.screens[recorded]), agent.status, quiet), seat.name, agent.status);
    if (view) out.push(view);
  }
  return out;
}

/**
 * One difference per attention, in the watch's own words (`src/watch/checks/attention.ts`): the
 * repair is the one act the report names, and `owner` is the watch's `to`, an owner's report only.
 */
function viewOf(attention: Attention, name: string, status: string): Difference | null {
  switch (attention) {
    // `compare()` already emits the permission-prompt difference for `status` and `check`.
    case 'question':
      return { what: `${name} asked a question: the operator's to act on`, repair: 'the operator acts in the pane' };
    case 'vendor notice':
      return { what: `${name} shows a vendor notice: its owner's to act on`, repair: 'the owner acts in the pane', owner: true };
    case 'blocked':
      return { what: `${name} is blocked, and its screen is not one the watch recognises`, repair: 'the owner looks at the pane', owner: true };
    case 'unknown':
      return { what: `${name}: herdr reports the status "${status}"`, repair: 'the operator looks at the pane' };
    default:
      return null;
  }
}

// `status`'s own problem lines, in the check's name.
function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team check: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}

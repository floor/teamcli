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
import { join } from 'node:path';
import { notInForce, watchInForceOf } from '../approve/approval.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { blindDifferences } from '../commands/seats.ts';
import { approvalCaseRow, emptyOverrides, overrideDrift, protectedCheckouts, realSources, rulesFileDifferences } from '../commands/status.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import { declaredModel } from '../file/model.ts';
import { loadTeamFile, TEAM_FILE } from '../file/load.ts';
import { isLeadSeat, relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { LoadResult, Problem, Seat, TeamFile } from '../file/types.ts';
import { agentList, PANE_WINDOW, paneProcesses, paneRead, sessionRunning, workspaceList, type PaneProcesses } from '../herdr.ts';
import type { Io } from '../io.ts';
import { NOT_PRETENDED } from '../permissions/must-not-pretend.ts';
import { rosterOf } from '../permissions/who.ts';
import { overridesInForceOf } from '../profiles/overrides.ts';
import { mayReadTeam } from '../read-gate.ts';
import { findAgent } from '../registry/agents.ts';
import { byName, ofTeam, ProjectsError } from '../registry/projects.ts';
import { getTeam, teamIdOf, TeamsError } from '../registry/teams.ts';
import { emptySession, liveHold, readState, type SessionState, type State } from '../state.ts';
import { compare, orderAndAnnotateDifferences, type Difference, type Live } from '../status/compare.ts';
import { observeLabel } from '../labels/observe.ts';
import { seatModel } from '../status/statusline.ts';
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
    ...signingDifferences(team, live, root, sources.home),
    ...devModeDifferences(team, root, sources.home),
    ...attentionDifferences(team, state, live),
    ...labelDifferences(team, state, live),
    ...rosterDifferences(team, state, live, root, sources.home),
    ...registryDifferences(team, root, sources.home),
    ...protectedCheckouts(team, root, { branch: sources.branch }),
    // The same row `status` prints: a legacy record or one the verification refused still says what
    // it is; a machine that never approved the file is the ordinary file now, and nothing to repair.
    ...approvalCaseRow(standing.kind === 'legacy' || standing.kind === 'refused' ? notInForce(standing) : null),
    ...overrideDrift(overrides),
    ...rulesFileDifferences(standing, team, root, sources.home),
    // A blind seat — unknown past the blind threshold — counts as not working, and is
    // a must-fix here exactly as it is in `team status`.
    ...blindDifferences(team, state, live, comparison, sources.now(), liveHold(whole, sources.now()) !== null, { project: team.project, root, home: sources.home }),
  ]);
  const differences = comparison.differences;
  // The notes print above the differences, as `team status` prints them: a note names something
  // worth acting on without counting it wrong — it is not in the total and does not change the exit.
  for (const note of delegateNotes(team)) io.stdout(`note: ${note}\n`);
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
  // Under both answers too, the decision record's own limits, in its words: the gaps this release
  // does not close are named here, never left to be discovered
  // (decided-grants-minimum-2026-10-17, "What 0.5.0 must not pretend").
  for (const line of NOT_PRETENDED) io.stdout(`${line}\n`);
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
 * A seat whose record carries the dev mark: its registration was written by a run whose caller
 * gate was folded into a warning (`src/registry/agents.ts`, `src/registry/sync.ts`), so the
 * record that says what the seat is was made without the ordinary gate behind it. The difference
 * names the caller the record itself kept — the dev-mode run's own `dev_mode_by`, and the
 * `registered_by` of an older record that kept only the mark — and the one repair that takes the
 * mark off: the owner's own `team register`, the same write with nothing folded — a clean launch
 * of the seat does it too. A seat the file no longer names, and one whose record the registry
 * holds none for, is not this finding's.
 */
function devModeDifferences(team: TeamFile, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  const out: Difference[] = [];
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (record?.provenance.dev_mode !== true) continue;
    out.push({
      what: `${seat.name}: registered under dev mode (by ${record.provenance.dev_mode_by ?? record.provenance.registered_by})`,
      repair: `re-record the seat with the caller gate in force (team register ${seat.name})`,
    });
  }
  return out;
}

/**
 * The check's notes: what it names without counting it wrong. A `delegates` entry naming `approve`
 * is one — `team approve` was removed, and the word is still accepted only so a file that already
 * names it loads unchanged, so the file carries a stale word to drop. A note prints above the
 * differences, is counted in neither their total nor the exit code, and names the entry's pane.
 */
function delegateNotes(team: TeamFile): string[] {
  const notes: string[] = [];
  for (const delegate of team.delegates ?? []) {
    if (!delegate.commands.includes('approve')) continue;
    notes.push(`${delegate.pane}'s delegate entry names approve, which no command acts on since team approve was removed; drop it from the file`);
  }
  return notes;
}

/**
 * The registry's signing triple against the pane: a seat whose agent record says it signs as
 * `<model> <version>` while its screen runs another model would sign commits with a model it does
 * not run, so the two things are named side by side with the re-record and the relaunch beside
 * them. The record is the launch's own declaration (`src/registry/sync.ts`), and nothing here
 * updates it: an accepted drift is re-recorded by `team register`, or the seat is relaunched on
 * the record's model. A team the registry holds no record for reads as before, and a screen the
 * reader cannot name a model from — unread, or another maker's through Claude Code — is never
 * wrong.
 */
function signingDifferences(team: TeamFile, live: Live, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  const out: Difference[] = [];
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent) continue;
    const running = seatModel(seat, live.screens[agent.pane]);
    if (!running) continue;
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (!record) continue;
    const { model, version } = record.signing;
    if (running.model === model && running.version === version) continue;
    // The record's own words, unless the file still declares exactly what the record signs: then
    // the seat's display spelling is the record's, the spelling every other line gives it.
    const signs = seat.model === model && seat.version === version ? declaredModel(seat) : `${model} ${version}`;
    const command = isLeadSeat(team, seat.name)
      ? relaunchRepair(team, seat.name, 'plain')
      : `team remove ${seat.name} --keep, then team add ${seat.name}`;
    out.push({
      what: `${seat.name}: signs as ${signs}, runs ${running.model} ${running.version}`,
      repair: `re-record the seat once the drift is accepted (team register ${seat.name}), or relaunch it on the record's model (${command})`,
      needs: 'approve',
    });
  }
  return out;
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
 * The two herdr sidebar lines a file seat carries, as differences when they read as neither the
 * file's own text nor a line the watch is entitled to paint. Line 1 is exactly
 * `workspaceLabel(seat)` — nothing else writes it — so any other label is drift. Line 2 is the
 * watch's (`src/labels/observe.ts`): it may carry the model the pane shows in place of the file's
 * display, and an effort word read from a screen, so a line the observation explains is left
 * alone. The repair is `team register <seat>`, which re-applies both lines from the file without
 * a relaunch. One pane per seat, the one this project's state records — the same read the
 * attention report makes.
 */
function labelDifferences(team: TeamFile, state: SessionState, live: Live): Difference[] {
  const out: Difference[] = [];
  for (const seat of team.seats) {
    const recorded = state.seats[seat.name]?.pane;
    if (recorded === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== recorded) continue;
    const title = live.workspaces.find((workspace) => workspace.id === agent.workspace)?.label;
    if (title !== undefined && title !== workspaceLabel(seat)) {
      out.push({
        what: `${seat.name}: its herdr workspace label reads "${title}", the file says "${workspaceLabel(seat)}"`,
        repair: `team register ${seat.name}`,
      });
    }
    const line = agent.displayAgent;
    // A pane herdr holds no display for is not drift: many panes never had one reported, and the
    // file does not say a pane must carry one. Only a line something else wrote is named.
    if (line !== undefined && !displayLineMatches(seat, line, live.screens[recorded])) {
      out.push({
        what: `${seat.name}: its herdr display reads "${line}", the file's line is "${displayAgent(seat)}"`,
        repair: `team register ${seat.name}`,
      });
    }
  }
  return out;
}

/**
 * A seat this project's state holds ready, running on the pane it recorded, that the team
 * registry's record does not list in its roster. The roster line is the seat's identity for
 * the permission bridge (`src/permissions/who.ts`): where the registry holds a record of the
 * team, the roster is the record of who its seats are, and a seat it does not list has none —
 * every gate wired to the bridge refuses the seat what the approved file says it holds. A team
 * the registry holds no record of is not this difference: the bridge reads the file's own
 * declaration then, and the seat is served. A seat still launching is not one either: the line
 * is written when the seat reaches ready, and `team register <seat>` writes it for a seat that
 * is ready without one, its repair here.
 */
function rosterDifferences(
  team: TeamFile,
  state: SessionState,
  live: Live,
  root: string,
  home: string | undefined,
): Difference[] {
  if (home === undefined) return [];
  const roster = rosterOf(home, root);
  // Only a listed roster can name a missing line: a team the registry holds no record of reads
  // the file's declaration, and a registry that cannot be read names nothing here either — the
  // permission bridge refuses those callers closed, which this report does not soften.
  if (roster.kind !== 'listed') return [];
  const listed = new Set(roster.roster.map((line) => line.seat));
  const out: Difference[] = [];
  for (const seat of team.seats) {
    if (listed.has(seat.name)) continue;
    const held = state.seats[seat.name];
    if (held?.stage !== 'ready') continue;
    // The live pane the state recorded for the seat, as the label differences read it: a pane
    // herdr lists the name on anywhere else is a stale record, and `team register` would refuse
    // it, so it is not repaired from here.
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== held.pane) continue;
    out.push({
      what: `${seat.name}: ready and running, and the team registry's roster does not list it`,
      repair: `team register ${seat.name}`,
    });
  }
  return out;
}

/**
 * Every effort word the `observeLabel` readers can print from a list, lowercased
 * (`src/labels/observe.ts`). A grok pane's word is whatever sits in its parens, so it is not
 * checked against this set.
 */
const EFFORT_WORDS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'none', 'minimal']);

/**
 * Whether a live line 2 is one the file or the watch could have written. The watch's line is
 * `observeLabel(seat, screen)` (src/labels/observe.ts): the file's display, replaced by the model
 * the pane shows when the screen names a different one, and the file's effort or one a screen
 * showed. The effort the watch read from an *earlier* screen in its own process is not readable
 * here, so any word those readers can print is accepted beside the line it would paint now.
 */
function displayLineMatches(seat: Seat, line: string, screen: string | undefined): boolean {
  const observed = observeLabel(seat, screen).line;
  if (line === observed) return true;
  const cut = line.lastIndexOf(' ');
  const model = cut < 0 ? line : line.slice(0, cut);
  const effort = cut < 0 ? '' : line.slice(cut + 1);
  const observedCut = observed.lastIndexOf(' ');
  if (model !== (observedCut < 0 ? observed : observed.slice(0, observedCut))) return false;
  if (effort === (seat.effort || 'default')) return true;
  return seat.cli === 'grok' || EFFORT_WORDS.has(effort);
}

/**
 * What the registries say about this team's place (src/registry/projects.ts, src/registry/teams.ts).
 * A team is named in one project at most: `ofTeam` owns that rule and refuses the state where two
 * name it, naming both, and the refusal is repeated here rather than re-derived. A registry that
 * does not read refuses in the same line, so a machine whose registry cannot be read is not read
 * as fine. And a project is led by one team: when this team declares `project_lead: true`, the
 * project's other teams are looked up in the team registry (their `root` to their file) and a
 * second declaring team is a difference. A sibling the registries cannot answer for — no record,
 * no readable file, or a file naming another project — is not counted, and a team that declares
 * no lead reads no sibling at all. A team no project names is its own project, and a machine with
 * no registry has no projects: neither is a difference. A check with no home answers for no
 * registry at all, exactly as it reads no approval store.
 */
function registryDifferences(team: TeamFile, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  try {
    ofTeam(home, teamIdOf(root));
    if (!team.projectLead || team.inProject === null) return [];
    const project = byName(home, team.inProject);
    if (project === null) return [];
    const leads = [team.project, ...leadSiblings(team, root, home, project.teams)];
    if (leads.length < 2) return [];
    return [{
      what: `the project ${team.inProject} has ${leads.length} lead teams: ${leads.join(', ')}`,
      repair: 'take "project_lead: true" off all but one of them',
    }];
  } catch (error) {
    if (error instanceof ProjectsError) return [{ what: `the project registry: ${error.message}`, repair: 'fix the project registry (~/.config/team/projects.yaml)' }];
    if (error instanceof TeamsError) return [{ what: `the team registry: ${error.message}`, repair: 'fix the team registry (~/.config/team/teams.yaml)' }];
    throw error;
  }
}

/**
 * The names of this project's other teams whose files declare `project_lead: true` too, read
 * through the team registry's `root` and the file's canonical path — text only, so a sibling's
 * placement and its own trust are not this check's business. A sibling whose file names another
 * project is a stale registry, not a second lead of this one.
 */
function leadSiblings(team: TeamFile, root: string, home: string, teamIds: string[]): string[] {
  const mine = teamIdOf(root);
  const out: string[] = [];
  for (const id of teamIds) {
    if (id === mine) continue;
    const siblingRoot = getTeam(home, id)?.root;
    if (siblingRoot === undefined) continue;
    let loaded: LoadResult;
    try {
      loaded = loadTeamFile(siblingRoot, { file: join(siblingRoot, TEAM_FILE), home, checkOnly: true });
    } catch {
      // A file that cannot be read at all (permissions, a broken link) is a sibling the check
      // cannot see: not counted, and not a reason for this team's check to fail.
      continue;
    }
    if (!loaded.ok) continue;
    if (loaded.team.projectLead && loaded.team.inProject === team.inProject) out.push(loaded.team.project);
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

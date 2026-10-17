// Bare `team check`: one answer to "is anything wrong with this team that someone should act on",
// for the callers who may see it — the owner, a seat of the team, and a pane the team's approved
// file names (design note §3, §4). It needs no git, it reads, and it changes nothing but the two
// leftovers the owner's `--repair` drops — a state record for a seat the file no longer declares, a
// state record for a session with no seat of the team in it: the file is resolved with `remember`
// false for every caller, nothing of the watch's pass, report, readings or nudge path is called, and
// the one screen reading (§3.3a) is read-only.
//
// The caller decides, not the flags. The walk classifies the caller before any target is opened,
// and a caller that does not pass as one of the three gets one fixed sentence and nothing else,
// whatever failed underneath — a loader error, a refused standing, herdr's silence, an aimed flag
// and every caller detail among them (the two-phase rule, §4).
import { homedir } from 'node:os';
import { join, isAbsolute, relative } from 'node:path';
import { notInForce, watchInForceOf } from '../approve/approval.ts';
import { callerLabel, fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import { blindDifferences } from '../commands/seats.ts';
import { approvalAndOverrideRows, emptyOverrides, protectedCheckouts, realSources, rulesFileDifferences } from '../commands/status.ts';
import type { DelegateSources } from '../delegate.ts';
import { devModeActive } from '../dev_mode.ts';
import { currentTeam } from '../file/current.ts';
import { declaredModel } from '../file/model.ts';
import { isParseError, loadTeamFile, TEAM_FILE } from '../file/load.ts';
import { isLeadSeat, relaunchRepair } from '../file/sections/lead.ts';
import { displayAgent, workspaceLabel } from '../file/sections/seats.ts';
import type { LoadResult, Problem, Seat, TeamFile } from '../file/types.ts';
import { agentList, PANE_WINDOW, paneProcesses, paneRead, sessionRunning, workspaceList, type PaneProcesses } from '../herdr.ts';
import type { Io } from '../io.ts';
import { logLine } from '../log.ts';
import { resolveLobby } from '../lobby/gate.ts';
import {
  collapseNotes,
  contextLine,
  renderDeprecationWarnings,
  renderDifferences,
  renderNotes,
  renderSummary,
  summaryCounts,
  toJsonDifference,
  ttyStyle,
  writeJson,
  writeJsonError,
  type DeprecationWarning,
} from '../output/index.ts';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { rosterOf } from '../permissions/who.ts';
import { overridesInForceOf } from '../profiles/overrides.ts';
import {
  loadAndResolvePolicyChain,
  readProjectPolicySource,
  readSeatPolicySource,
  readTeamPolicySource,
  type PolicyLoadRefusal,
} from '../policy/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { findAgent } from '../registry/agents.ts';
import { byName, ofTeam, projectIdOf, ProjectsError } from '../registry/projects.ts';
import { getTeam, readTeams, teamIdOf, TeamsError } from '../registry/teams.ts';
import { DELIVERY_ORDER, orderDeclarationsOf, type DeliveryLeg } from '../settings/inherit.ts';
import { resolveOrderSetting } from '../settings/resolve.ts';
import { emptySession, liveHold, readState, seatOfFile, updateState, type SessionState, type State } from '../state.ts';
import { compare, orderAndAnnotateDifferences, type Difference, type Live } from '../status/compare.ts';
import { observeLabel } from '../labels/observe.ts';
import { modelDiffers, seatModel } from '../status/statusline.ts';
import type { Standing } from '../store/store.ts';
import { plainText } from '../launch/plain.ts';
import type { Attention } from '../watch/check.ts';
import { attentionOf } from '../watch/pass.ts';
import { readScreen } from '../watch/screen.ts';

/** The team check's own arguments: the owner's aimed/repair flags and optional `--json`. */
export type TeamCheckArgs = { session?: string; file?: string; repair?: boolean; json?: boolean };

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
  const current = currentTeam(io.cwd, owner ? args.file : undefined, sources.now(), sources.home, false, owner ? args.session : undefined);
  if (owner) {
    if (!current.ok) {
      if (args.json) {
        const id = current.errors.some((e) => e.message.startsWith('not inside a git repository'))
          ? 'check.not-a-repo'
          : current.errors.some(isParseError)
            ? 'check.file-invalid'
            : 'check.file';
        writeJsonError(io, id, current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${p.message}`).join('; '));
      } else {
        printProblems(io, current.errors);
      }
      // exit: check.not-a-repo
      // exit: check.file
      // exit: check.file-invalid
      return 2;
    }
  } else {
    if (!current.ok || !mayReadTeam(current, io, sources)) {
      return notYours(io, args.json);
    }
    const fallbackNotice = current.notice ? plainText(current.notice) : undefined;
    // The caller passes and is not the owner: the flags aim nothing, and one aimed meets the
    // refusal every other command gives it — after the gate, never before it.
    if (args.file !== undefined) {
      const msg = fileOwnerRefusal(io, args.file) ?? "--file is the owner's";
      if (args.json) {
        writeJsonError(io, 'check.file-owner', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.file-owner
      return 1;
    }
    if (args.session !== undefined) {
      const msg = sessionOwnerRefusal(walked);
      if (args.json) {
        writeJsonError(io, 'check.session-owner', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.session-owner
      return 1;
    }
    // `--repair` writes the state: the one act the check has, and the owner's alone, as the two
    // aimed flags are.
    if (args.repair === true) {
      const msg = "--repair is the owner's";
      if (args.json) {
        writeJsonError(io, 'check.repair-owner', msg, null, 1, undefined, fallbackNotice);
      } else {
        io.stderr(`team check: ${msg}\n`);
      }
      // exit: check.repair-owner
      return 1;
    }
  }
  const { team, root, dir } = current;
  const notice = current.notice ? plainText(current.notice) : undefined;
  if (!args.json && notice !== undefined) io.stdout(`${notice}\n`);
  const session = owner ? (args.session ?? team.session) : team.session;
  // The one read of the approval store: the drift, and the values in force, all derive from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  let whole: State;
  try {
    whole = readState(dir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.json) {
      writeJsonError(io, 'check.state', msg, null, 1, undefined, notice);
    } else {
      io.stderr(`team check: ${msg}\n`);
    }
    // exit: check.state
    return 2;
  }
  // The live read comes before the repair: the check refuses when herdr cannot answer, and a run
  // that refuses must have changed nothing. The read is the state's own seats for the file's
  // seats — the leftovers the repair drops are never among them — so the comparison below reads
  // the same live session either way.
  const recorded = whole.sessions[session] ?? emptySession();
  const live = sources.live(session, team, recorded);
  if (!live) {
    const msg = "herdr doesn't answer; is it installed and running?";
    if (args.json) {
      writeJsonError(io, 'check.herdr', msg, null, 1, undefined, notice);
    } else {
      io.stderr(`team check: ${msg}\n`);
    }
    // exit: check.herdr
    return 2;
  }
  // The state's leftovers, read before anything is compared: a record for a seat the file no
  // longer declares, and a session the file does not name with no seat of the team in it. They
  // are named as differences below; with the owner's `--repair` they are dropped first, so the
  // comparison runs on the state the file would have written. The file is the truth: nothing is
  // ever guessed back into it.
  let stale = staleState(team, session, whole);
  const repaired: string[] = [];
  if (args.repair === true && (stale.seats.length > 0 || stale.sessions.length > 0)) {
    // A write that fails throws, as every other command's state write does: the failure is
    // `team.command-threw`'s, not a second reading of the state.
    repaired.push(...dropStale(dir, session, stale));
    for (const line of repaired) {
      logLine(dir, 'check', callerLabel(walked), `repaired: ${line}`, sources.now());
    }
    whole = readState(dir);
    stale = staleState(team, session, whole);
  }
  const state = whole.sessions[session] ?? emptySession();
  const policyChecked = policyCheck(team, root, sources.home, sources.now(), io.env, dir, callerLabel(walked));
  // The same live grant `status` reads, so the two readings offer `team answer` together or not
  // at all: the setting is one record, never a file key and never a stale approval.
  const comparison = compare(team, session, state, live, sources.now(), watchInForceOf(standing, team), undefined, dialogsTrustInForce(sources.home ?? homedir(), root, sources.now()));
  // Dev mode is the local override, read from the caller's place: under it the approval and
  // overrides state rows fold into quiet notes, and a seat recorded under it is counted rather
  // than named seat by seat — `team seats` keeps the mark, and `team status --all --json` keeps
  // the field. Outside dev mode every row stands. The effective policy, not the variable, decides
  // once a value governs.
  const quiet = devModeActive(io, {
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    entity: team.entity,
    team,
    root,
    now: sources.now(),
  });
  const record = approvalAndOverrideRows(
    standing.kind === 'legacy' || standing.kind === 'refused' ? notInForce(standing) : null,
    overrides,
    quiet,
  );
  const provenance = devModeDifferences(team, root, sources.home, quiet);
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...signingDifferences(team, state, live, root, sources.home),
    ...provenance.differences,
    ...attentionDifferences(team, state, live),
    ...labelDifferences(team, state, live),
    ...rosterDifferences(team, state, live, root, sources.home),
    ...registryDifferences(team, root, sources.home),
    ...deliveryOrderDifferences(team, root, sources.home),
    ...policyChecked.differences,
    ...protectedCheckouts(team, root, { branch: sources.branch }),
    // The same rows `status` prints: a legacy record or one the verification refused still says
    // what it is; a machine that never approved the file is the ordinary file now, and nothing to
    // repair. Under dev mode both fold into the quiet notes above.
    ...record.differences,
    ...rulesFileDifferences(standing, team, root, sources.home),
    ...staleDifferences(stale),
    // A blind seat — unknown past the blind threshold — counts as not working, and is
    // a must-fix here exactly as it is in `team status`.
    ...blindDifferences(team, state, live, comparison, sources.now(), liveHold(whole, sources.now()) !== null, { project: team.project, root, home: sources.home, stateDir: dir, session }),
  ]);
  const differences = comparison.differences;
  // A deprecated field the file still reads: the check is the one command that names it, with
  // the repair its record carries. It is not a difference and does not change the exit — the
  // file works, it just carries a key this build no longer acts on.
  const shown = shownTeamFile(current.path, root);
  const deprecationWarnings: DeprecationWarning[] = [
    ...current.warnings.flatMap((w): DeprecationWarning[] => {
      const repair = deprecationRepairOf(w.message, shown);
      if (repair === undefined) return [];
      return [{ line: w.line || undefined, message: w.message, repair }];
    }),
    ...(current.deprecations ?? []).map((deprecation) => ({
      line: deprecation.line || undefined,
      message: deprecation.message,
      repair: deprecation.repair.replace('{file}', shown),
    })),
  ];
  const warnings = renderDeprecationWarnings(deprecationWarnings);
  // The notes print above the differences, as `team status` prints them: a note names something
  // worth acting on without counting it wrong — it is not in the total and does not change the exit.
  const notes = collapseNotes([
    ...delegateNotes(team),
    ...lobbyNotes(team, root, sources.home, session),
    ...policyChecked.notes,
    ...unknownStatusNotes(team, state, live),
    ...record.notes,
    ...provenance.notes,
  ]);
  if (args.json) {
    writeJson(io, 'team.check', {
      format: 1,
      project: team.project,
      session,
      ...(notice !== undefined ? { notice } : {}),
      warnings,
      repaired,
      notes,
      differences: differences.map(toJsonDifference),
      summary: summaryCounts(differences),
    });
  } else {
    const style = ttyStyle(io);
    io.stdout(`${contextLine(team.project, session)}\n`);
    for (const warning of warnings) io.stdout(`${warning}\n`);
    for (const line of repaired) io.stdout(`repaired: ${line}\n`);
    for (const line of renderNotes(notes)) io.stdout(`${line}\n`);
    for (const line of renderDifferences(differences, style)) io.stdout(`${line}\n`);
    io.stdout(`${renderSummary(differences)}\n`);
  }
  if (differences.length > 0) {
    // exit: check.findings
    return 1;
  }
  // The owner's own repair ran and left nothing to act on: the state now says what the file
  // does, and the run ends as a clean check with the dropped records named above.
  if (repaired.length > 0) {
    // exit: check.repaired
    return 0;
  }
  // exit: check.ok
  return 0;
}

// The one sentence a caller that does not pass gets, whatever failed underneath it: it names no
// seat, no session and no path, and it is the only output such a caller can get (§3.4, §4).
function notYours(io: Io, json?: boolean): number {
  const msg = 'this team is not yours to check';
  if (json) {
    writeJsonError(io, 'check.not-yours', msg);
  } else {
    io.stderr(`team check: ${msg}\n`);
  }
  // exit: check.not-yours
  return 2;
}

/** The team file as a repair names it: `.agents/team.yaml` under the root the load found, or
 *  the path itself when `--file` aimed the run at another folder. */
function shownTeamFile(path: string | undefined, root: string): string {
  if (path === undefined) return TEAM_FILE;
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** A state seat record the file no longer declares, with the pane it claims when it expects one. */
type StaleSeat = { name: string; pane?: string };

/** What the state keeps that the file does not: seats the file no longer declares (a temporary
 *  seat excepted — the file never lists one), and sessions with no seat of the team in them. */
type Stale = { seats: StaleSeat[]; sessions: string[] };

/**
 * The state's leftovers, read against the file alone. The addressed session's seats are compared
 * with the file's own: a record for a name the file no longer declares names no pane of this
 * team's, and only a temporary seat — which the file never lists — keeps its record. Every other
 * session the state holds is a leftover unless a seat of the team lives in it: a name the file
 * declares, or a temporary seat the file never lists. The file's own session and the addressed
 * session are never leftovers themselves: the first is where the team runs, and the second is the
 * session this run is about — `--session` aims the check at it, so the repair must not drop the
 * record it is reading. What herdr is running is not read: the state's own claims are the subject,
 * and a pane herdr no longer lists is still a pane the state claims.
 */
function staleState(team: TeamFile, session: string, whole: State): Stale {
  const declared = new Set(team.seats.map((seat) => seat.name));
  const seats: StaleSeat[] = [];
  for (const [name, seat] of Object.entries(whole.sessions[session]?.seats ?? {})) {
    if (seatOfFile(name, seat, declared)) continue;
    seats.push({ name, ...(seat.pane !== undefined ? { pane: seat.pane } : {}) });
  }
  const sessions: string[] = [];
  for (const [name, held] of Object.entries(whole.sessions)) {
    if (name === team.session || name === session) continue;
    if (Object.entries(held.seats).some(([seatName, seat]) => seatOfFile(seatName, seat, declared))) continue;
    sessions.push(name);
  }
  return { seats, sessions };
}

/** One difference per leftover, the owner's to drop: the check names them and `--repair` is the
 *  repair — never an edit of the file, and never a guess at which record is right. */
function staleDifferences(stale: Stale): Difference[] {
  const repair = 'drop its record from the state (team check --repair)';
  const out: Difference[] = [];
  for (const seat of stale.seats) {
    out.push({
      what: seat.pane === undefined
        ? `${seat.name}: left the team file but its record is still in the state`
        : `${seat.name}: left the team file but its record still claims pane ${seat.pane}`,
      repair,
      owner: true,
    });
  }
  for (const name of stale.sessions) {
    out.push({
      what: `the state records the session "${name}", and no seat of the team is in it`,
      repair,
      owner: true,
    });
  }
  return out;
}

/**
 * The owner's repair: the leftovers `staleState` named, dropped from the state in one locked
 * write, each one re-checked against the record now on disk — a temporary seat, or a record
 * gone already, is left alone. The lines returned are the ones actually dropped, each printed
 * as a `repaired:` line and written to the log; a write that fails throws, as every command's
 * state write does.
 */
function dropStale(dir: string, session: string, stale: Stale): string[] {
  return updateState(dir, (state) => {
    const lines: string[] = [];
    for (const name of stale.sessions) {
      if (!Object.hasOwn(state.sessions, name)) continue;
      delete state.sessions[name];
      lines.push(`the state's session "${name}" holds no seat of the team; its record is dropped`);
    }
    const current = state.sessions[session];
    if (current !== undefined) {
      for (const seat of stale.seats) {
        const held = current.seats[seat.name];
        if (held === undefined || held.temporary !== undefined) continue;
        delete current.seats[seat.name];
        lines.push(seat.pane === undefined
          ? `${seat.name}: left the team file; its record is dropped`
          : `${seat.name}: left the team file and its record claimed pane ${seat.pane}; its record is dropped`);
      }
    }
    return lines;
  });
}

/**
 * A seat whose record carries the dev mark: its registration was written by a run whose caller
 * gate was folded into a warning (`src/registry/agents.ts`, `src/registry/sync.ts`), so the
 * record that says what the seat is was made without the ordinary gate behind it. The difference
 * states plainly that the seat was registered by an agent rather than by the owner, and names the
 * one repair that takes the mark off: the owner's own `team register`, the same write with nothing
 * folded — a clean launch of the seat does it too. A seat the file no longer names, and one whose
 * record the registry holds none for, is not this finding's.
 */
function devModeDifferences(
  team: TeamFile,
  root: string,
  home: string | undefined,
  quiet: boolean,
): { differences: Difference[]; notes: string[] } {
  if (home === undefined) return { differences: [], notes: [] };
  const out: Difference[] = [];
  let marked = 0;
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (record?.provenance.dev_mode !== true) continue;
    // Under dev mode the mark is the expected record, not a finding: one quiet note counts the
    // seats instead of one row per seat.
    if (quiet) {
      marked += 1;
      continue;
    }
    out.push({
      what: `${seat.name}: registered by an agent, not by the owner`,
      repair: `re-record the seat with the caller gate in force (team register ${seat.name})`,
    });
  }
  return { differences: out, notes: marked > 0 ? [`${marked} seat(s) recorded under dev mode`] : [] };
}

/**
 * The lobby the registry holds against the one the file would derive. Once the registry holds a
 * team's lobby, the entity never derives it again (`src/lobby/recorded.ts`): changing `entity` on
 * a running team no longer moves its seats, so the check names the file that now derives another
 * lobby and says which path stands. A file with an explicit `lobby:` is not a derivation — the
 * owner's own declaration re-records it — and a team the registry holds no lobby for has nothing
 * recorded to stand. The registry keeps one lobby per session, so the record speaks for this run
 * through the session it addresses — the file's own, or the `--session` the check was given; a
 * session with no entry derives from its entity, as a new team does. A home that names no store
 * answers for no registry, as the other notes do.
 */
function lobbyNotes(team: TeamFile, root: string, home: string | undefined, session: string): string[] {
  if (home === undefined || team.lobby) return [];
  let recorded = '';
  try {
    const record = getTeam(home, teamIdOf(root));
    // The session the check addresses: its own recorded lobby is the one that stands, and it is
    // the file's own unless `team check --session` named another.
    if (record !== null) recorded = record.lobbies[session] ?? '';
  } catch (error) {
    // An unreadable registry already has its own difference; it cannot say where the lobby is.
    if (!(error instanceof TeamsError)) throw error;
    return [];
  }
  if (!recorded) return [];
  const derived = resolveLobby(home, { entity: team.entity });
  if (derived === recorded) return [];
  return [`the file's entity derives the lobby ${derived}, and the registry records ${recorded}: the recorded lobby stands`];
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
 * them. The live agent must be the pane the state recorded for the seat, as the attention and
 * label differences read it: a name herdr lists on another pane is a stray, and its screen is not
 * this seat's. The record is the launch's own declaration (`src/registry/sync.ts`), and nothing
 * here updates it: `team register` writes the file's declared model into the record, so an
 * accepted drift is the file's model updated first and registered after, or the seat relaunched
 * on the record's model. A team the registry holds no record for reads as before, and a screen
 * the reader cannot name a model from — unread, or another maker's through Claude Code — is never
 * wrong.
 */
function signingDifferences(team: TeamFile, state: SessionState, live: Live, root: string, home: string | undefined): Difference[] {
  if (home === undefined) return [];
  const out: Difference[] = [];
  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    // The pane the state recorded for the seat: a name on another pane is not the seat, and its
    // model is not the one the record is compared with.
    const recorded = state.seats[seat.name]?.pane;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== recorded) continue;
    const running = seatModel(seat, live.screens[agent.pane]);
    if (!running) continue;
    const record = findAgent(home, { team: teamId, seat: seat.name });
    if (!record) continue;
    const { model, version } = record.signing;
    // The comparison is the file's own (`modelDiffers`): a name in another word order, or a
    // version spelled inside the record's model name, is the model the pane runs.
    if (!modelDiffers(running, { model, version })) continue;
    // The record's own words, unless the file still declares exactly what the record signs: then
    // the seat's display spelling is the record's, the spelling every other line gives it.
    const signs = seat.model === model && seat.version === version ? declaredModel(seat) : `${model} ${version}`;
    const command = isLeadSeat(team, seat.name)
      ? relaunchRepair(team, seat.name, 'plain')
      : `team remove ${seat.name} --keep, then team add ${seat.name}`;
    out.push({
      what: `${seat.name}: signs as ${signs}, runs ${running.model} ${running.version}`,
      repair: `update the team file's model, then team register ${seat.name}, or relaunch on the recorded model (${command})`,
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
 * every gate wired to the bridge refuses the seat what the live file says it holds. A team
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
 * as fine. The team registry is read for every team, a project lead's or not: the roster bridge
 * (`src/permissions/who.ts`) answers from it for every seat, so a file it cannot read leaves every
 * team unserved, and the difference is named wherever the check runs. And a project is led by one
 * team: when this team declares `project_lead: true`, the
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
    // Read for every team, not only below for a lead's siblings: `rosterOf` swallows the read's
    // own error and reports no roster, which reads as no gap — so the unreadable registry is
    // named here, once, wherever the check runs.
    readTeams(home);
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
    if (error instanceof TeamsError) return [{ what: `the team registry cannot be read: ${error.message}`, repair: 'fix the team registry (~/.config/team/teams.yaml)' }];
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
 * A `delivery_order` declaration in `.agents/team.yaml` (at the team or seat level) that
 * `resolveOrderSetting` sets aside because it names a leg the inherited order does not have, leaving
 * the inherited order in force (`src/settings/inherit.ts`, output contract §1.5 scene D4).
 */
function deliveryOrderDifferences(team: TeamFile, root: string, home: string | undefined): Difference[] {
  let projectOrder: readonly DeliveryLeg[] | undefined;
  let signedTeamOrder = false;
  if (home !== undefined) {
    try {
      projectOrder = ofTeam(home, teamIdOf(root))?.deliveryOrder;
    } catch {
      projectOrder = undefined;
    }
    const teamSource = readTeamPolicySource(home, root, team);
    if (teamSource.ok && teamSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner')) {
      signedTeamOrder = true;
    }
  }
  const out: Difference[] = [];
  if (team.deliveryOrder !== null && !signedTeamOrder) {
    const res = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf<DeliveryLeg>({
        ...(projectOrder !== undefined ? { project: projectOrder } : {}),
        team: team.deliveryOrder,
      }),
    );
    if (res.refused.some((r) => r.level === 'team')) {
      out.push({
        what: `delivery_order [${team.deliveryOrder.join(', ')}] in .agents/team.yaml is set aside; [${res.value.join(', ')}] stands`,
        repair: 'drop the leg(s) not in the inherited delivery_order in .agents/team.yaml',
        owner: true,
      });
    }
  }
  for (const seat of team.seats) {
    if (seat.deliveryOrder === undefined) continue;
    const res = resolveOrderSetting(
      DELIVERY_ORDER,
      orderDeclarationsOf<DeliveryLeg>({
        ...(projectOrder !== undefined ? { project: projectOrder } : {}),
        ...(!signedTeamOrder && team.deliveryOrder ? { team: team.deliveryOrder } : {}),
        seat: seat.deliveryOrder,
      }),
    );
    if (res.refused.some((r) => r.level === 'seat')) {
      out.push({
        what: `${seat.name}: delivery_order [${seat.deliveryOrder.join(', ')}] in .agents/team.yaml is set aside; [${res.value.join(', ')}] stands`,
        repair: `drop the leg(s) not in the inherited delivery_order for ${seat.name} in .agents/team.yaml`,
        owner: true,
      });
    }
  }
  return out;
}

/**
 * One difference per attention, in the watch's own words (`src/watch/checks/attention.ts`): the
 * repair is the one act the report names, and `owner` is the watch's `to`, an owner's report only.
 * A seat that is idle or done on an unrecognised screen (`attention === 'unknown'`) is a normal
 * state, never a difference; an unrecognised herdr status word is surfaced as a note by
 * `unknownStatusNotes` instead.
 */
function viewOf(attention: Attention, name: string, _status: string): Difference | null {
  switch (attention) {
    // `compare()` already emits the permission-prompt difference for `status` and `check`.
    case 'question':
      return { what: `${name} asked a question: the operator's to act on`, repair: 'the operator acts in the pane' };
    case 'vendor notice':
      return { what: `${name} shows a vendor notice: its owner's to act on`, repair: 'the owner acts in the pane', owner: true };
    case 'blocked':
      return { what: `${name} is blocked, and its screen is not one the watch recognises`, repair: 'the owner looks at the pane', owner: true };
    default:
      return null;
  }
}

/**
 * A note for any seat on its recorded pane whose herdr status is not one of the known words
 * (`idle`, `done`, `working`, `blocked`). An `idle` or `done` seat is a normal state even when its
 * screen is unrecognised, and an unknown herdr status word is reported as a note so it does not
 * count as a difference or change the exit code.
 */
function unknownStatusNotes(team: TeamFile, state: SessionState, live: Live): string[] {
  const out: string[] = [];
  for (const seat of team.seats) {
    const recorded = state.seats[seat.name]?.pane;
    if (recorded === undefined) continue;
    const agent = live.agents.find((candidate) => candidate.name === seat.name);
    if (!agent || agent.pane !== recorded) continue;
    if (
      agent.status !== '' &&
      agent.status !== 'idle' &&
      agent.status !== 'done' &&
      agent.status !== 'working' &&
      agent.status !== 'blocked'
    ) {
      out.push(`${seat.name}: herdr reports the status "${agent.status}"`);
    }
  }
  return out;
}

// `status`'s own problem lines, in the check's name.
function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team check: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}

/**
 * The repair command for a deprecated field warning in `current.warnings` (`coordinator:`,
 * `watch.quota_marks`, `budgets.marks`). Non-deprecation warnings (such as `effort`) return
 * `undefined` so `team check` emits only deprecation warnings.
 */
function deprecationRepairOf(message: string, shownFile: string): string | undefined {
  if (message.startsWith('`coordinator:` is now `leads: true`')) {
    return `set \`leads: true\` on the lead's seat and remove \`coordinator:\` from ${shownFile}`;
  }
  if (message.startsWith('watch.quota_marks is now budgets.marks')) {
    return `move \`watch.quota_marks\` to \`budgets.marks\` in ${shownFile}`;
  }
  if (message.startsWith('budgets.marks replaces watch.quota_marks')) {
    return `remove \`watch.quota_marks\` from ${shownFile} and keep \`budgets.marks\``;
  }
  return undefined;
}

function policyRefusalRepair(refusal: PolicyLoadRefusal, seatName?: string): string {
  if ((refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true) {
    if (seatName) {
      return `remove or narrow delivery_order for ${seatName} in .agents/team.yaml`;
    }
    return 'remove or narrow delivery_order in .agents/team.yaml';
  }
  const seatFlag = seatName ? ` --seat ${seatName}` : '';
  if (refusal.kind === 'loosening') {
    return `team policy unset ${refusal.lowerLevel} ${refusal.policy}${seatFlag}`;
  }
  if (refusal.kind === 'invalid-policy') {
    return `team policy unset ${refusal.level} ${refusal.policy}${seatFlag}`;
  }
  const match = /policy "([^"]+)"/.exec(refusal.why);
  if (match?.[1]) {
    return `team policy unset ${refusal.level} ${match[1]}${seatFlag}`;
  }
  return `team policy unset ${refusal.level} <name>${seatFlag}`;
}

/**
 * Policy chain verification and `dev-mode` migration notice (Kernel Amendment 02, Gap 6 & Gap 7):
 * - Reads and resolves the policy chain (`entity → project → team`, plus each registered `seat`).
 * - Any unreadable/unverified source, invalid policy, or load-time loosening refusal is reported
 *   as an owner difference with a `team policy unset` repair (or, when the loosening declaration
 *   is an unsigned legacy field in `.agents/team.yaml`, a lead file-edit repair).
 * - When a signed policy entry shadows a legacy `delivery_order:` line in the same file, emits a
 *   note naming the shadowed line so `team policy unset` does not silently bring it back.
 * - While no `dev-mode` policy is set in the chain (`devModeGoverned === false`) and
 *   `TEAMCLI_DEV_MODE=1` is set in the environment, emits the one migration note.
 */
function policyCheck(
  team: TeamFile,
  root: string,
  home: string | undefined,
  now: Date,
  env: Record<string, string | undefined>,
  stateDir: string,
  caller: string,
): { differences: Difference[]; notes: string[] } {
  if (home === undefined) {
    const notes =
      env.TEAMCLI_DEV_MODE === '1'
        ? ['dev-mode: no policy is set yet for this entity; TEAMCLI_DEV_MODE=1 still applies until the owner sets dev-mode']
        : [];
    return { differences: [], notes };
  }

  let projectId: string | null = null;
  let legacyProjectDeliveryOrder: readonly DeliveryLeg[] | undefined;
  try {
    const byTeam = ofTeam(home, teamIdOf(root));
    if (byTeam) {
      projectId = byTeam.id ?? null;
      legacyProjectDeliveryOrder = byTeam.deliveryOrder;
    } else if (team.inProject) {
      const proj = byName(home, team.inProject);
      projectId = proj?.id ?? projectIdOf(team.inProject);
      legacyProjectDeliveryOrder = proj?.deliveryOrder;
    } else {
      projectId = projectIdOf(team.project);
    }
  } catch {
    projectId = null;
  }

  const legacyDeliveryDiffs = deliveryOrderDifferences(team, root, home);
  const differences: Difference[] = [];
  const notes: string[] = [];

  const projectSource = readProjectPolicySource(home, projectId);
  if (
    projectSource.ok &&
    projectSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
    legacyProjectDeliveryOrder !== undefined
  ) {
    notes.push(
      `delivery_order [${legacyProjectDeliveryOrder.join(', ')}] in ~/.config/team/projects.yaml is shadowed by the signed project delivery-order policy; remove delivery_order from ~/.config/team/projects.yaml so team policy unset does not bring it back`,
    );
  }

  const teamSource = readTeamPolicySource(home, root, team);
  if (
    teamSource.ok &&
    teamSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
    team.deliveryOrder !== null
  ) {
    notes.push(
      `delivery_order [${team.deliveryOrder.join(', ')}] in .agents/team.yaml is shadowed by the signed team delivery-order policy; remove delivery_order from .agents/team.yaml so team policy unset does not bring it back`,
    );
  }

  const teamChain = loadAndResolvePolicyChain(
    {
      home,
      entity: team.entity ?? null,
      projectId,
      teamRoot: root,
      team,
    },
    { now, upToLevel: 'team' },
  );

  if (!teamChain.ok) {
    for (const refusal of teamChain.refusals) {
      if (
        refusal.kind === 'loosening' &&
        refusal.policy === 'delivery-order' &&
        refusal.lowerLevel === 'team' &&
        legacyDeliveryDiffs.some((d) => d.what.startsWith('delivery_order '))
      ) {
        continue;
      }
      const isUnsigned =
        (refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true;
      differences.push({
        what: refusal.message,
        repair: policyRefusalRepair(refusal),
        ...(isUnsigned ? {} : { owner: true }),
      });
    }
  }

  const teamId = teamIdOf(root);
  for (const seat of team.seats) {
    let agentId: string | null = null;
    try {
      agentId = findAgent(home, { team: teamId, seat: seat.name })?.id ?? null;
    } catch {
      agentId = null;
    }
    if (!agentId && seat.deliveryOrder === undefined) continue;
    const seatSource = readSeatPolicySource(home, agentId, seat);
    if (
      seatSource.ok &&
      seatSource.policies.some((p) => p.name === 'delivery-order' && p.setter === 'owner') &&
      seat.deliveryOrder !== undefined
    ) {
      notes.push(
        `${seat.name}: delivery_order [${seat.deliveryOrder.join(', ')}] in .agents/team.yaml is shadowed by the signed seat delivery-order policy; remove delivery_order for ${seat.name} from .agents/team.yaml so team policy unset does not bring it back`,
      );
    }
    const seatChain = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity ?? null,
        projectId,
        teamRoot: root,
        team,
        agentId,
        seat,
      },
      { now, upToLevel: 'seat' },
    );
    if (!seatChain.ok) {
      for (const refusal of seatChain.refusals) {
        const isSeatRefusal =
          (refusal.kind === 'loosening' && refusal.lowerLevel === 'seat') ||
          ((refusal.kind === 'unreadable-source' || refusal.kind === 'invalid-policy') && refusal.level === 'seat');
        if (!isSeatRefusal) continue;
        if (
          refusal.kind === 'loosening' &&
          refusal.policy === 'delivery-order' &&
          legacyDeliveryDiffs.some((d) => d.what.startsWith(`${seat.name}: delivery_order `))
        ) {
          continue;
        }
        const isUnsigned =
          (refusal.kind === 'loosening' || refusal.kind === 'invalid-policy') && refusal.unsigned === true;
        differences.push({
          what: `${seat.name}: ${refusal.message}`,
          repair: policyRefusalRepair(refusal, seat.name),
          ...(isUnsigned ? {} : { owner: true }),
        });
      }
    }
  }

  const expiredDevMode = teamChain.expired.filter((exp) => exp.name === 'dev-mode').at(-1);
  if (expiredDevMode && (!teamChain.ok || teamChain.policies['dev-mode']?.value === 'off')) {
    notes.push(`dev-mode expired at ${expiredDevMode.expiry ?? 'now'} for ${expiredDevMode.level}; off since`);
  }
  if (env.TEAMCLI_DEV_MODE === '1') {
    if (!teamChain.devModeGoverned) {
      notes.push(
        'dev-mode: no policy is set yet for this entity; TEAMCLI_DEV_MODE=1 still applies until the owner sets dev-mode',
      );
    } else if (teamChain.ok && teamChain.policies['dev-mode']?.value === 'off') {
      logLine(stateDir, 'check', caller, 'dev-mode: TEAMCLI_DEV_MODE=1 ignored because dev-mode policy is off', now);
    }
  }

  return { differences, notes };
}


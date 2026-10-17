import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { budgetsInForceOf, notInForce, watchInForceOf } from '../approve/approval.ts';
import { dialogsTrustInForce } from '../permissions/dialogs-trust.ts';
import { overridesInForceOf, type OverrideForce } from '../profiles/overrides.ts';
import { readArgs } from '../args.ts';
import { budgetLine, budgetTable, type BudgetRow } from '../budgets/table.ts';
import { recall } from '../budgets/readings.ts';
import { fileOwnerRefusal, isOwner, sessionOwnerRefusal, walkCaller } from '../caller.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { entityGrantAdmits, readEntityCreateGrants } from '../grant.ts';
import { agentList, PANE_WINDOW, paneProcesses, paneRead, sessionRunning, workspaceList, type PaneProcesses } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { emptySession, holdText, liveHold, liveProcs, pidAlive, readState, type HoldRecord, type SessionState } from '../state.ts';
import { keyFingerprint, keyState } from '../store/keys.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import type { SeatStateWord, StateSource } from '../labels/state.ts';
import { checkRulesFile, rulesFilePath } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import { INTEGRITY_NOT_AUTHORITY } from '../permissions/must-not-pretend.ts';
import { profileFor } from '../profiles/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { readTeams } from '../registry/teams.ts';
import { realSources as realProjectSources, type ProjectSources } from './projects.ts';
import * as projectRegistry from '../registry/projects.ts';
import { APPROVAL_REPAIR, compare, orderAndAnnotateDifferences } from '../status/compare.ts';
import type { Comparison, Difference, Live } from '../status/compare.ts';
import { readMachine, swapTotalProblem, type Machine } from '../watch/machine.ts';
import { blindDifferences, renderSeatsTable, seatRegistryRows, type SeatRegistryRow } from './seats.ts';

// What `status` reads from outside the file and the state, so tests can stand in for it.
export type StatusSources = {
  live(session: string, team: TeamFile, state: SessionState): Live | null;
  branch(path: string): string | null;
  // The approval store's one snapshot, read once for the whole report: the
  // file's case, the watch and budget values in force, and the overrides all
  // derive from it, so no later read can disagree with the first.
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the override file and the key. Absent in a test that does not set one. */
  home?: string;
  /** The project registry, for `--project`. The real one when absent; a test stands in for it. */
  projects?: ProjectSources;
  /** This machine's own figures, read for the one check no machine can ever meet. Absent in a test
   *  that does not read them; absent is not "fine", it is nothing said. */
  machine?(root: string): Machine;
  /** Whether a recorded process id names something still running, for the `team proc` note.
   *  The real reading when absent; a test stands in for it so no fixture depends on a pid. */
  alive?(pid: number): boolean;
  /** The approved pane's read gate's own reads; the real ones when absent. */
  gate?: DelegateSources;
};

/**
 * The standing source against a home that is not the owner's real one — the
 * shipped command's own, and what a test or a scratch home stands in for.
 */
export function standingSource(home: string): StatusSources['standing'] {
  return (root) => approvalStanding(root, home);
}

export const realSources: StatusSources = {
  live(session, team, state) {
    const running = sessionRunning(session);
    if (running === null) return null;
    if (!running) return { running: false, agents: [], workspaces: [], screens: {} };
    const agents = agentList(session);
    const workspaces = workspaceList(session);
    if (!agents || !workspaces) return null;
    const screens: Record<string, string> = {};
    const processes: Record<string, PaneProcesses | null> = {};
    // Every agent's pane, not only one whose name is a seat: a stray in a seat's workspace has a
    // screen too. A null screen is left out, and that pane is then unread.
    for (const agent of agents) {
      const screen = paneRead(agent.pane, PANE_WINDOW, session);
      if (screen !== null) screens[agent.pane] = screen;
      // The pane's process identity, for the comparison with the one the state recorded: a pane
      // that no longer holds what team launched is not the seat. Null when herdr can't tell.
      processes[agent.pane] = paneProcesses(agent.pane, session);
    }
    // A recorded seat herdr no longer lists an agent for still has its pane standing where it was
    // launched: that pane is read too, so one left holding its shell is told apart from one that is
    // gone. Only a seat with a recorded process is read — one with no record is never compared.
    // The screen is the same read: a pane with no agent still has visible text, and a null leaves
    // the restored row with no note.
    for (const seat of team.seats) {
      const held = state.seats[seat.name];
      if (!held?.launched || !held.pane || held.pane in processes) continue;
      processes[held.pane] = paneProcesses(held.pane, session);
      const screen = paneRead(held.pane, PANE_WINDOW, session);
      if (screen !== null) screens[held.pane] = screen;
    }
    return { running: true, agents, workspaces, screens, processes };
  },
  branch(path) {
    try {
      return execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
  standing: standingSource(homedir()),
  now: () => new Date(),
  home: homedir(),
  projects: realProjectSources,
  machine: readMachine,
};

export const status: Command = (argv, io) => runStatus(argv, io, realSources);
export default status;

/**
 * The JSON shape printed by `team status --json`.
 * Format 1.
 */
export interface StatusJson {
  format: 1;
  project: string;
  session: string;
  rows: Array<{
    name: string;
    id?: string | null;
    role?: string;
    cli?: string;
    state: string;
    model: string;
    effort?: string | null;
    last_active?: string | null;
    pane: string;
    launch_line?: string | null;
    /** The seat's own reading (src/labels/state.ts), the table's STATE and SOURCE columns.
     *  `state` above keeps its published meaning — the comparison's phrase about the record. */
    seat_state?: SeatStateWord;
    seat_state_source?: StateSource;
    /** Present, true, only where it applies: `unknown` past the blind threshold, which counts
     *  as not working (the table's `(blind)`). */
    blind?: true;
    /** `--all` only, like the registry's other fields: present when the seat's registry record
     *  carries the dev mark — a registration dev mode admitted wrote it. */
    dev_mode?: boolean;
    start_cwd?: string;
  }>;
  notes: string[];
  differences: Array<{
    what: string;
    repair: string;
  }>;
  notice: string | null;
  /** Present when the file names an account, or a reading is stored. */
  budgets?: BudgetRow[];
  /** Present while a hold stands and has not lapsed (`team hold`). */
  hold?: HoldRecord;
  /** The live records of `team proc`, present only when the session's seats hold some. */
  procs?: Array<{
    name: string;
    by: string;
    at: string;
    pid?: number;
    note?: string;
  }>;
}

export const USAGE = 'Usage: team status [--session <name>] [--file <path>] [--project <name>] [--all] [--json]\n';

export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file', 'project'], ['all', 'json']);
  // `--project` reads the project level instead of one team: the project's teams, from the
  // registry, wherever the run stands — no team file and no caller gate, the way `team projects`
  // reads. `--session` and `--file` name one team's readings and do not apply beside it.
  const beside = args.values.project !== undefined && (args.values.session !== undefined || args.values.file !== undefined);
  if (args.error || args.rest.length || beside) {
    const why = args.error ?? (args.rest.length
      ? `unexpected "${args.rest[0]}"`
      : '--project reads the project; --session and --file name one team');
    out.stderr(`team status: ${plainText(why)}\n${USAGE}`);
    // exit: status.invocation
    return 2;
  }
  if (args.values.project !== undefined) {
    return projectReport(args.values.project, out, io, sources, args.flags.has('json'));
  }
  // `--file` and `--session` are the owner's. The walk decides that before any file or session
  // is read, the same gate `worktree` and `watch` use. A plain folder's own seats need no flag:
  // `currentTeam` finds `.agents/team.yaml` in their folder. The one write on this path is the
  // `last_valid` copy, and only the owner's run keeps it.
  const walked = walkCaller(io);
  const owner = isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) {
      out.stderr(`team status: ${plainText(refusal)}\n`);
      // exit: status.file-owner
      return 1;
    }
  }
  if (args.values.session !== undefined && !owner) {
    out.stderr(`team status: ${plainText(sessionOwnerRefusal(walked))}\n`);
    // exit: status.session-owner
    return 1;
  }

  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, sources.now(), sources.home, owner);
  if (!owner) {
    const read = current.ok && mayReadTeam(current, io, sources);
    // A create-grant admits its holder's runner to the read, for a team whose root is under the
    // granted paths: the same record `init` and `up` consult. It buys the read alone — `--file`
    // and `--session` above stay the owner's, and this run keeps no `last_valid` copy. Asked only
    // where the read gate has refused, and only when a record exists, so a seat's own reading
    // reads no clock for it.
    const granted = current.ok && !read
      && readEntityCreateGrants(sources.home ?? homedir()).length > 0
      && entityGrantAdmits(current.root, io, { home: sources.home, now: sources.now(), cwd: io.cwd });
    if (!current.ok || (!read && !granted)) {
      out.stderr('team status: this team is not yours to read\n');
      // exit: status.not-yours
      return 2;
    }
  } else if (!current.ok) {
    printProblems(out, current.errors);
    // exit: status.not-a-repo
    // exit: status.file
    // exit: status.file-invalid
    return 2;
  }
  const { team, root, dir } = current;
  if (!args.flags.has('json') && current.notice) out.stdout(`${plainText(current.notice)}\n`);
  for (const warning of current.warnings) out.stderr(`team status: warning, line ${warning.line}: ${plainText(warning.message)}\n`);

  const session = args.values.session ?? team.session;
  // The one read of the approval store: everything below derives from it.
  const standing = sources.standing(root);
  const overrides = sources.home ? overridesInForceOf(standing, team.project, root, sources.home) : emptyOverrides();
  for (const problem of overrides.problems) out.stderr(`team status: ${plainText(problem)}\n`);
  // The state is read before the world: the live read compares each pane with the process the
  // state recorded for the seat it holds.
  const whole = readState(dir);
  const state = whole.sessions[session] ?? emptySession();
  const live = sources.live(session, team, state);
  if (!live) {
    out.stderr('team status: herdr doesn\'t answer; is it installed and running?\n');
    // exit: status.herdr
    return 2;
  }
  const now = sources.now();
  // The team's hold first of all, the way it is the first thing a reader should know: a hold
  // past its `until` reads as none (`liveHold`), so neither the note nor the document carries
  // one that has lapsed. Read before the comparison below, whose held seats it marks.
  const hold = liveHold(whole, now);
  const budgets = budgetTable(budgetsInForceOf(standing, team), recall(whole.budgets), now.getTime());
  const comparison = compare(
    team, session, state, live, now,
    watchInForceOf(standing, team),
    undefined,
    // The owner's live grant, read fresh: the `team answer` repair line appears only while the
    // team grant carries `dialogs.trust`.
    dialogsTrustInForce(sources.home ?? homedir(), root, now),
  );
  const all = args.flags.has('all');
  // The registry rows carry each seat's own reading: `--all` renders them as the expanded
  // table, and every `--json` document carries the reading on each row whether `--all` is
  // there or not. Without either, nothing here is read.
  const registryRows = all || args.flags.has('json')
    ? seatRegistryRows(team, state, live, comparison, now, true, hold !== null, { project: team.project, root, home: sources.home, stateDir: dir, session })
    : undefined;
  const registryByName = registryRows ? new Map(registryRows.map((item) => [item.name, item])) : undefined;
  // The one machine check this reading cannot pass — the same fact `doctor` reports as a finding,
  // as one note, in the reading's own words. `up`'s refusal on it is its own line, and nothing
  // here changes an exit.
  const machine = sources.machine?.(root);
  if (machine) {
    const problem = swapTotalProblem(machine, team.machine);
    if (problem !== null) comparison.notes.unshift(problem);
  }
  if (!live.running) comparison.notes.unshift(`the herdr session "${session}" is not running`);
  if (hold) comparison.notes.unshift(holdText(hold));
  // What the seats recorded with `team proc add`: one note per live process, read the same way
  // `team proc list` reads it — a record whose pid is gone is skipped here and left for the next
  // write to clear. The reading is the note and the document, one derivation for both.
  // `--json` is the one text not cleaned: the document carries each string as it was read, so the
  // rows here are raw, and the note below is cleaned where it is printed like every other note.
  const procs = liveProcs(state, sources.alive ?? pidAlive).map(([name, held]) => ({
    name,
    by: held.by,
    at: held.at,
    ...(held.pid !== undefined ? { pid: held.pid } : {}),
    ...(held.note !== undefined ? { note: held.note } : {}),
  }));
  for (const held of procs) {
    comparison.notes.push(`proc ${held.name}: ${held.by} since ${held.at}${held.pid !== undefined ? `, pid ${held.pid}` : ''}`);
  }
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...protectedCheckouts(team, root, sources),
    // `approve` is gone: a machine that never approved this file is the ordinary case now, not a
    // difference, and the reading exits 0 for it. A legacy record and one the verification refused
    // still say what they are.
    ...approvalCaseRow(standing.kind === 'legacy' || standing.kind === 'refused' ? notInForce(standing) : null),
    ...overrideDrift(overrides),
    // The file's own rules files, only once a record exists for a launch to have written them.
    ...rulesFileDifferences(standing, team, root, sources.home),
    // A seat whose reading is blind — unknown past the blind threshold — counts as
    // not working, and is a must-fix here exactly as it is in `team check`.
    ...blindDifferences(team, state, live, comparison, now, hold !== null, { project: team.project, root, home: sources.home, stateDir: dir, session }),
  ]);

  if (args.flags.has('json')) {
    const doc: StatusJson = {
      format: 1,
      project: team.project,
      session,
      rows: comparison.rows.map((row) => {
        // The expanded columns stay `--all`'s: without it `extra` is undefined and every field
        // the row published stands as it was. The reading below is every row's, `--all` or not.
        const found = registryByName?.get(row.name);
        const extra = all ? found : undefined;
        return {
          name: row.name,
          ...(extra ? { id: extra.id } : row.id ? { id: row.id } : {}),
          ...(extra ? { role: extra.role, cli: extra.cli } : {}),
          state: row.stored ?? row.state,
          model: row.model,
          ...(extra ? { effort: extra.effort, last_active: extra.last_active } : {}),
          pane: row.pane,
          ...(extra ? { launch_line: extra.launch_line } : {}),
          ...(found ? { seat_state: found.state, seat_state_source: found.state_source } : {}),
          ...(found?.blind ? { blind: true as const } : {}),
          ...(extra?.dev_mode === true ? { dev_mode: true } : {}),
          ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
        };
      }),
      notes: comparison.notes,
      // Format 1: the extra facts a difference carries (needs/owner/approval) are for the
      // renderer, not the document.
      differences: comparison.differences.map(({ what, repair }) => ({ what, repair })),
      notice: current.notice ?? null,
      ...(budgets.length ? { budgets } : {}),
      ...(hold ? { hold } : {}),
      ...(procs.length ? { procs } : {}),
    };
    io.stdout(`${JSON.stringify(doc, null, 2)}\n`);
  } else {
    out.stdout(render(team, session, comparison, budgets, registryRows));
  }
  // exit: status.agrees
  // exit: status.difference
  return comparison.differences.length ? 1 : 0;
}

export function emptyOverrides(): OverrideForce {
  return { profiles: [], differences: [], problems: [] };
}

export function overrideDrift(report: OverrideForce): Difference[] {
  return [
    ...report.differences.map((line): Difference => ({
      what: `the overrides differ from the approved copy: ${line}`,
      repair: APPROVAL_REPAIR,
      approval: true,
      owner: true,
    })),
    ...report.problems.map((problem): Difference => ({ what: problem, repair: 'fix the overrides file' })),
  ];
}

// The file's case as one row of its own, for a standing that still says something: a legacy
// record, or one the verification refused. No record on this machine is not one of those — with
// `approve` gone it is the ordinary file, nothing for the owner to repair, and it never fails a
// reading. A record in force is nothing to say either, and nothing is compared against it — the
// live file is what the commands read, so an edit to it is not a difference.
export function approvalCaseRow(reason: string | null): Difference[] {
  if (reason === null) return [];
  return [{ what: reason, repair: APPROVAL_REPAIR, approval: true, owner: true }];
}


/** Every message-rules seat's file, against the rules the live file gives it. A file that
 *  differs is a difference for the owner to repair with `team reload <seat>` — never rewritten
 *  here. An option seat has no file, and a seat whose rules can't travel at all is `up`'s to
 *  refuse. */
export function rulesFileDifferences(standing: Standing, team: TeamFile, root: string, home: string | undefined): Difference[] {
  // Like the overrides: no home set is a test that stands in for no store at all. The check
  // runs only once a record exists, so a file that was never approved does not grow a
  // difference for a file no launch has written.
  if (home === undefined || standing.kind !== 'verified') return [];
  const out: Difference[] = [];
  for (const seat of team.seats) {
    // A stopped seat is not checked: `up` writes the file only at a delivery, so the repair
    // below could not fix a stopped seat's file. An unstopped seat's file is rewritten the
    // next time it launches, so no stale file outlives one.
    if (seat.stopped) continue;
    if (profileFor(seat.cli)?.rulesOption != null) continue;
    const path = rulesFilePath(team.project, root, home, seat.name);
    if (path === null) continue;
    const text = rulesOf(team, seat, root);
    const check = checkRulesFile(path, text);
    if (!check.ok) out.push({ what: `${seat.name}: ${check.what}`, repair: `team reload ${seat.name}`, owner: true });
  }
  return out;
}

/** The protected checkouts left on another branch — the same rows `status` prints, for `check`
 *  too. All it reads of the sources is the branch of a path. */
export function protectedCheckouts(team: TeamFile, root: string, sources: { branch(path: string): string | null }): Difference[] {
  const base = team.workspace.base;
  if (!base) return [];
  const out: Difference[] = [];
  for (const path of team.workspace.protected) {
    const full = resolve(root, path);
    const branch = sources.branch(full);
    if (branch === null || branch === base) continue;
    const shown = relative(root, full) || '.';
    out.push({
      what: `the protected checkout "${shown}" is on ${branch === 'HEAD' ? 'a detached commit' : `"${branch}"`}, not on "${base}"`,
      repair: `the owner switches it back: git -C ${shown} switch ${base}`,
      owner: true,
    });
  }
  return out;
}

/**
 * `team status --project <name>`: the project's teams, from the registry — the project itself
 * through the projects source, each team's record through the team registry. The reading covers
 * every team of the project the way the plain reading covers every seat of a team: a team the
 * registry does not know is said as such, never left out.
 */
function projectReport(name: string, out: Io, io: Io, sources: StatusSources, json: boolean): number {
  // An injected projects source answers for itself; with none, the registry the home holds is the
  // reading — the same file `team projects` reads, bound to the injected home, never another's.
  const project = sources.projects ? sources.projects.byName(name) : projectRegistry.byName(sources.home ?? homedir(), name);
  if (!project) {
    out.stderr(`team status: no project named ${JSON.stringify(name)}; nothing to show\n`);
    // exit: status.project-unknown
    return 1;
  }
  const records = readTeams(sources.home ?? homedir());
  const teams = project.teams.map((teamId) => {
    const record = records[teamId] ?? null;
    return {
      name: teamId,
      session: record?.session ?? null,
      lifecycle: record?.lifecycle ?? null,
      seats: record ? record.roster.length : null,
    };
  });
  if (json) {
    io.stdout(`${JSON.stringify({ format: 1, project, teams }, null, 2)}\n`);
  } else {
    const head = [`project ${plainLine(project.name)}  ${plainLine(project.id ?? '-')}`];
    if (project.entity !== null) head.push(`entity ${plainLine(project.entity)}`);
    head.push(`lead ${plainLine(project.lead ?? '-')}`);
    const lines = [head.join('  ')];
    for (const team of teams) {
      lines.push(team.session === null
        ? `  ${plainLine(team.name)}  not registered`
        : `  ${plainLine(team.name)}  session "${plainLine(team.session)}"  ${plainLine(team.lifecycle ?? '?')}  ${String(team.seats ?? '?')} seat(s)`);
    }
    out.stdout(`${lines.join('\n')}\n`);
  }
  // exit: status.project-listed
  return 0;
}

function render(
  team: TeamFile,
  session: string,
  comparison: Comparison,
  budgets: BudgetRow[],
  registryRows?: SeatRegistryRow[],
): string {
  const lines = [`team ${plainLine(team.project)}, session "${plainLine(session)}"`];
  if (registryRows) {
    lines.push(...renderSeatsTable(registryRows, '  ').trimEnd().split('\n'));
  } else {
    const rows = comparison.rows.map((row) => ({
      name: plainLine(row.name),
      state: plainLine(row.state),
      model: plainLine(row.model),
      pane: plainLine(row.pane),
      // How a send would reach the seat: the socket its session answers at, else the typed
      // delivery. The JSON row keeps its published shape; this is the plain table's word.
      reach: row.reach ?? 'typed',
    }));
    const widths = [0, 0, 0];
    for (const row of rows) {
      widths[0] = Math.max(widths[0] as number, row.name.length);
      widths[1] = Math.max(widths[1] as number, row.state.length);
      widths[2] = Math.max(widths[2] as number, row.model.length);
    }
    for (const row of rows) {
      lines.push(`  ${row.name.padEnd(widths[0] as number)}  ${row.state.padEnd(widths[1] as number)}  ${row.model.padEnd(widths[2] as number)}  ${row.pane.padEnd(4)}  ${row.reach}`.trimEnd());
    }
  }
  if (budgets.length) {
    lines.push('budgets:');
    // The row carries its own reserve: the line and the JSON can't disagree (queue 79).
    for (const row of budgets) lines.push(`  ${plainLine(budgetLine(row))}`);
  }
  for (const note of comparison.notes) lines.push(`note: ${plainLine(note)}`);
  for (const difference of comparison.differences) {
    lines.push(`difference: ${plainLine(difference.what)}`, `  repair: ${plainLine(difference.repair)}`);
  }
  const ownerCount = comparison.differences.filter((difference) => difference.owner === true).length;
  if (ownerCount > 0) {
    lines.push(`${comparison.differences.length} difference(s), ${ownerCount} for the owner`);
  } else {
    lines.push(`${comparison.differences.length} difference(s)`);
  }
  // The footer the decision record puts on a view of records
  // (decided-grants-minimum-2026-10-17, "every record and view says so"): this reading is a view,
  // not an authority. The plain reading alone carries it; the document is a script's to read.
  lines.push(INTEGRITY_NOT_AUTHORITY);
  return `${lines.join('\n')}\n`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team status: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
  }
}

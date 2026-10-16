import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import { approvalCase, budgetsInForceOf, watchInForceOf } from '../approve/approval.ts';
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
import { emptySession, readState, type SessionState } from '../state.ts';
import { keyFingerprint, keyState } from '../store/keys.ts';
import { approvalStanding, type Standing } from '../store/store.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { checkRulesFile, rulesFilePath } from '../launch/rules-file.ts';
import { rulesOf } from '../launch/rules.ts';
import { profileFor } from '../profiles/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { APPROVAL_REPAIR, compare, orderAndAnnotateDifferences } from '../status/compare.ts';
import type { Comparison, Difference, Live } from '../status/compare.ts';
import { readMachine, swapTotalProblem, type Machine } from '../watch/machine.ts';
import { renderSeatsTable, seatRegistryRows, type SeatRegistryRow } from './seats.ts';

// What `status` reads from outside the file and the state, so tests can stand in for it.
export type StatusSources = {
  live(session: string, team: TeamFile, state: SessionState): Live | null;
  branch(path: string): string | null;
  // The approval store's one snapshot, read once for the whole report: the
  // drift, the watch and budget values in force, and the overrides all derive
  // from it, so no later read can disagree with the first.
  standing(root: string): Standing;
  now(): Date;
  /** The home whose store holds the override file and the key. Absent in a test that does not set one. */
  home?: string;
  /** This machine's own figures, read for the one check no machine can ever meet. Absent in a test
   *  that does not read them; absent is not "fine", it is nothing said. */
  machine?(root: string): Machine;
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
}

export const USAGE = 'Usage: team status [--session <name>] [--file <path>] [--all] [--json]\n';

export async function runStatus(argv: string[], io: Io, sources: StatusSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file'], ['all', 'json']);
  if (args.error || args.rest.length) {
    out.stderr(`team status: ${plainText(args.error ?? `unexpected "${args.rest[0]}"`)}\n${USAGE}`);
    // exit: status.invocation
    return 2;
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
  const budgets = budgetTable(budgetsInForceOf(standing, team), recall(whole.budgets), now.getTime());
  const comparison = compare(team, session, state, live, now, watchInForceOf(standing, team));
  const all = args.flags.has('all');
  const registryRows = all ? seatRegistryRows(team, state, live, comparison, now, true) : undefined;
  const registryByName = registryRows ? new Map(registryRows.map((item) => [item.name, item])) : undefined;
  if (standing.kind === 'verified') {
    const key = sources.home ? keyState(sources.home) : { kind: 'missing' as const };
    const ofKey = key.kind === 'key' ? `, key ${keyFingerprint(key.key)}` : '';
    comparison.notes.unshift(`approval #${standing.generation} (${standing.signedAt.slice(0, 10)})${ofKey}`);
  }
  // The one machine check this reading cannot pass — the same fact `doctor` reports as a finding,
  // as one note, in the reading's own words. `up`'s refusal on it is its own line, and nothing
  // here changes an exit.
  const machine = sources.machine?.(root);
  if (machine) {
    const problem = swapTotalProblem(machine, team.machine);
    if (problem !== null) comparison.notes.unshift(problem);
  }
  if (!live.running) comparison.notes.unshift(`the herdr session "${session}" is not running`);
  comparison.differences = orderAndAnnotateDifferences([
    ...comparison.differences,
    ...protectedCheckouts(team, root, sources),
    ...approvalDrift(approvalCase(standing, team)),
    ...overrideDrift(overrides),
    // The approved file's own rules files, only when there is an approval to write them.
    ...rulesFileDifferences(standing, team, root, sources.home),
  ]);

  if (args.flags.has('json')) {
    const doc: StatusJson = {
      format: 1,
      project: team.project,
      session,
      rows: comparison.rows.map((row) => {
        const extra = registryByName?.get(row.name);
        return {
          name: row.name,
          ...(extra ? { id: extra.id } : row.id ? { id: row.id } : {}),
          ...(extra ? { role: extra.role, cli: extra.cli } : {}),
          state: row.stored ?? row.state,
          model: row.model,
          ...(extra ? { effort: extra.effort, last_active: extra.last_active } : {}),
          pane: row.pane,
          ...(extra ? { launch_line: extra.launch_line } : {}),
          ...(row.start_cwd ? { start_cwd: row.start_cwd } : {}),
        };
      }),
      notes: comparison.notes,
      // Format 1: the extra facts a difference carries (needs/owner/approval) are for the
      // renderer, not the document.
      differences: comparison.differences.map(({ what, repair }) => ({ what, repair })),
      notice: current.notice ?? null,
      ...(budgets.length ? { budgets } : {}),
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

// A file that was never approved, or was changed since, runs nothing until the owner approves it.
// A legacy or refused record is the whole case and its repair in one line of its own.
export function approvalDrift(approval: { differences: string[] | null; reason: string | null }): Difference[] {
  const withApproval = (what: string): Difference => ({ what, repair: APPROVAL_REPAIR, approval: true, owner: true });
  if (approval.reason !== null) return [withApproval(approval.reason)];
  if (approval.differences === null) return [withApproval('the file was never approved on this machine')];
  return approval.differences.map((line) => withApproval(`the file differs from the approved one: ${line}`));
}


/** Every message-rules seat's file, against the rules the live file gives it. A file that
 *  differs is a difference for the owner to repair with `up` — never rewritten here. An option
 *  seat has no file, and a seat whose rules can't travel at all is `up`'s to refuse. */
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
    if (!check.ok) out.push({ what: `${seat.name}: ${check.what}`, repair: 'the owner runs team up', owner: true });
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
    }));
    const widths = [0, 0, 0];
    for (const row of rows) {
      widths[0] = Math.max(widths[0] as number, row.name.length);
      widths[1] = Math.max(widths[1] as number, row.state.length);
      widths[2] = Math.max(widths[2] as number, row.model.length);
    }
    for (const row of rows) {
      lines.push(`  ${row.name.padEnd(widths[0] as number)}  ${row.state.padEnd(widths[1] as number)}  ${row.model.padEnd(widths[2] as number)}  ${row.pane}`.trimEnd());
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
  return `${lines.join('\n')}\n`;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team status: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
  }
}

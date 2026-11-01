// `team agents`: the machine's agent records, and the one act this command has on them. `prune`
// lists every record no team roster names and, with `--apply`, retires the ones whose seat is
// gone. Retiring is a recorded lifecycle state, never a delete: the record keeps every field —
// its signed settings among them — and is skipped by the lookups that place a live seat. Records
// this command never touches: one a roster names (it holds a seat), one whose seat the team's
// live configuration still declares (a declared seat gets its record before its first launch, and
// retiring it would break the identity its grants name), and one whose team the registry no
// longer holds (`team forget` leaves records behind, and a later registration reuses one). A
// team whose configuration cannot be read declares nothing here: its records are listed and left
// alone, so a file this build cannot read never orphans a record.
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner, type Caller } from '../caller.ts';
import { readGeneralGrant } from '../client/general-grant.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { hasJsonFlag, pluralCount, refuse, renderTable, ttyStyle, writeJson } from '../output/index.ts';
import { readAgents, updateAgent, type Agent } from '../registry/agents.ts';
import { readTeams, withTeamsLock, type TeamRecord } from '../registry/teams.ts';

export const USAGE = `Usage: team agents prune [--apply] [--json]

Lists one line per agent record this machine holds that no team roster names: the agent, the
seat and team it reaches, its lifecycle, why no roster names it, and what \`prune\` would do with
it. A record a roster names is not listed.

Retiring is a recorded state, never a delete: the record keeps every field, its signed settings
among them, and stays readable. A record whose seat is gone from a team whose configuration can be
read is marked with the time it was found orphaned. Three kinds are listed and left alone: a seat
the team's configuration still declares (it has not launched yet), a record whose team the registry
no longer holds (\`team forget\` leaves records behind), and a record whose team's configuration
cannot be read.

\`--apply\` retires every listed record it would retire; without it nothing is written. It is the
owner's, from a terminal rather than a seat's pane.

Exits 0 when the dry run finds nothing to retire or \`--apply\` retires every record it listed, 1
when the dry run finds records to retire, \`--apply\` is aimed by a caller who is not the owner, a
record cannot be written, or the team registry can't be read, 2 when the invocation can't be read.
`;

export type AgentsSources = {
  home: string;
  now(): Date;
};

export const realAgentsSources: AgentsSources = { home: homedir(), now: () => new Date() };

export const agents: Command = (argv, io) => runAgents(argv, io, realAgentsSources);
export default agents;

/** Why a listed record is not named by a roster, and whether `prune` retires it. */
export type AgentState = 'orphaned' | 'superseded' | 'declared' | 'unverified' | 'unregistered';

export type AgentAction = 'retire' | 'none';

/** One listed record: the agent, the team its reach names (when the registry holds one), and
 *  what a dry run says about it. */
export type AgentRow = {
  agent: Agent;
  team: TeamRecord | null;
  state: AgentState;
  action: AgentAction;
  reason: string;
};

export type AgentsJson = {
  format: 1;
  apply: boolean;
  records: {
    id: string;
    name: string;
    team: string;
    project: string | null;
    seat: string;
    session: string;
    lifecycle: string;
    state: AgentState;
    action: AgentAction;
    orphaned_at: string | null;
    reason: string;
  }[];
  counts: {
    listed: number;
    orphaned: number;
    superseded: number;
    declared: number;
    unverified: number;
    unregistered: number;
    to_retire: number;
    retired: number;
    unchanged: number;
    failed: number;
  };
};

const REASONS: Record<AgentState, string> = {
  orphaned: 'no roster line names it and the team declares no seat by that name',
  superseded: 'another agent holds the seat in the team roster',
  declared: 'the team declares the seat and it has not launched yet',
  unverified: 'the team\'s configuration could not be read, so its seats were not judged',
  unregistered: 'the team registry holds no record of this team',
};

/** What one team's configuration declares, read once per team. */
type Declared = { kind: 'seats'; seats: Set<string> } | { kind: 'unreadable' };

function declaredSeats(root: string, home: string, cache: Map<string, Declared>): Declared {
  const held = cache.get(root);
  if (held !== undefined) return held;
  let read: Declared;
  try {
    const loaded = readTeamConfig(root, { home });
    read = loaded.ok ? { kind: 'seats', seats: new Set(loaded.team.seats.map((seat) => seat.name)) } : { kind: 'unreadable' };
  } catch {
    read = { kind: 'unreadable' };
  }
  cache.set(root, read);
  return read;
}

/** Which teams a run may list and retire: every team for the owner's own run, or the entities a
 *  general grant names. A team that names no entity is outside every grant; only the owner's own
 *  run — no grant — reaches it, so machine-wide retirement never passes through a scoped grant. */
type Scope = { kind: 'machine' } | { kind: 'entities'; entities: readonly string[] };

function inScope(scope: Scope, team: TeamRecord | undefined): boolean {
  if (scope.kind === 'machine') return true;
  if (team === undefined || team.entity === null) return false;
  return scope.entities.includes('*') || scope.entities.includes(team.entity);
}

/** The scope a run carries. `io.general` is set only after the general door verified the grant;
 *  the record is read again here so the run acts on the entity list that was signed, and a grant
 *  that no longer reads is no proof of the owner: the run refuses rather than widens. */
type ScopeRead = { kind: 'scoped'; scope: Scope } | { kind: 'refused'; why: string };

function scopeOf(out: Io, home: string, now: () => Date): ScopeRead {
  const general = out.general;
  if (general === undefined) return { kind: 'scoped', scope: { kind: 'machine' } };
  let read: ReturnType<typeof readGeneralGrant>;
  try {
    read = readGeneralGrant(home, general.grant, now());
  } catch (error) {
    return { kind: 'refused', why: `the general grant could not be read again: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!read.ok) return { kind: 'refused', why: `the general grant could not be read again: ${read.why}` };
  return { kind: 'scoped', scope: { kind: 'entities', entities: read.grant.entities } };
}

/** Every agent ID any registered team's roster names. A record one roster names holds a seat
 *  somewhere, so no run retires it; its own team's roster is not the only one that can name it. */
function namedAgents(teams: Record<string, TeamRecord>): Set<string> {
  const named = new Set<string>();
  for (const team of Object.values(teams)) for (const line of team.roster) named.add(line.agent);
  return named;
}

/** The records no roster names, one row each, in the order the agents folder lists them. */
export function classify(
  agents: readonly Agent[],
  teams: Record<string, TeamRecord>,
  home: string,
  scope: Scope = { kind: 'machine' },
): AgentRow[] {
  const cache = new Map<string, Declared>();
  const named = namedAgents(teams);
  const rows: AgentRow[] = [];
  for (const agent of agents) {
    const team = teams[agent.reach.team];
    // The listing follows the run's scope: a record outside it is not this run's to report.
    if (!inScope(scope, team)) continue;
    // A roster line in any registered team protects the record. A registry read that cannot
    // vouch for every roster refuses before this point, so "not named" here is a verified fact.
    if (named.has(agent.id)) continue;
    if (team === undefined) {
      rows.push({ agent, team: null, state: 'unregistered', action: 'none', reason: REASONS.unregistered });
      continue;
    }
    const retired = agent.lifecycle === 'retired' ? 'none' : 'retire';
    if (team.roster.some((line) => line.seat === agent.reach.seat)) {
      rows.push({ agent, team, state: 'superseded', action: retired, reason: REASONS.superseded });
      continue;
    }
    const declared = declaredSeats(team.root, home, cache);
    if (declared.kind === 'unreadable') {
      rows.push({ agent, team, state: 'unverified', action: 'none', reason: REASONS.unverified });
    } else if (declared.seats.has(agent.reach.seat)) {
      rows.push({ agent, team, state: 'declared', action: 'none', reason: REASONS.declared });
    } else {
      rows.push({ agent, team, state: 'orphaned', action: retired, reason: REASONS.orphaned });
    }
  }
  return rows;
}

/** Why `--apply` cannot run for this caller, or null when it can: the owner, at a terminal. */
function applyProblem(caller: Caller): string | null {
  const detached = detachedRefusal(caller);
  if (detached !== undefined) return detached;
  if (!isOwner(caller)) return `--apply is the owner's; ${describeCaller(caller)} is not the owner`;
  return null;
}

function countsOf(rows: readonly AgentRow[], retired: number, failed: number): AgentsJson['counts'] {
  const count = (state: AgentState): number => rows.filter((row) => row.state === state).length;
  return {
    listed: rows.length,
    orphaned: count('orphaned'),
    superseded: count('superseded'),
    declared: count('declared'),
    unverified: count('unverified'),
    unregistered: count('unregistered'),
    to_retire: rows.filter((row) => row.action === 'retire').length,
    retired,
    unchanged: rows.filter((row) => row.action === 'none').length,
    failed,
  };
}

function summaryLine(rows: readonly AgentRow[], apply: boolean, retired: number, failed: number): string {
  if (rows.length === 0) return 'no agent record stands without a roster line';
  const toRetire = rows.filter((row) => row.action === 'retire').length;
  const tail = apply
    ? failed > 0
      ? `${pluralCount(retired, 'record')} retired, ${pluralCount(failed, 'record')} could not be retired`
      : toRetire === 0
        ? 'none to retire'
        : `${pluralCount(retired, 'record')} retired`
    : toRetire === 0
      ? 'none to retire'
      : `${pluralCount(toRetire, 'record')} to retire`;
  return `${pluralCount(rows.length, 'agent record', 'agent records')} no team roster names: ${tail}`;
}

export async function runAgents(argv: string[], io: Io, sources: AgentsSources = realAgentsSources): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['apply', 'json']);
  const verb = args.rest[0];
  const isPrune = verb === 'prune';
  const extra = args.rest[1];
  const problem = args.error
    ?? (verb === undefined
      ? 'a subcommand is required (prune)'
      : !isPrune
        ? `unknown subcommand "${verb}"`
        : extra !== undefined
          ? `unexpected "${extra}"`
          : null);
  if (problem !== null) {
    refuse(out, json, 'agents', { id: 'agents.invocation', message: problem, repair: null, usage: USAGE });
    // exit: agents.invocation
    return 2;
  }
  const apply = args.flags.has('apply');
  // The registry is read strictly: a roster this read cannot vouch for refuses the whole run,
  // dry run included, because "no roster names this record" is the ground prune retires on.
  let teams: Record<string, TeamRecord> | null = null;
  let registryProblem: string | null = null;
  try {
    teams = readTeams(sources.home, { strictRoster: true });
  } catch (error) {
    registryProblem = error instanceof Error ? error.message : String(error);
  }
  let rows: AgentRow[] = [];
  let retired = 0;
  let failed = 0;
  if (registryProblem === null && teams !== null) {
    const scopeRead = scopeOf(out, sources.home, sources.now);
    const denied = apply ? applyProblem(callerOf(out)) : null;
    const refusal = denied ?? (scopeRead.kind === 'refused' ? scopeRead.why : null);
    if (refusal !== null) {
      refuse(out, json, 'agents', { id: 'agents.owner', message: refusal, repair: null });
      // exit: agents.owner
      return 1;
    }
    const scope: Scope = scopeRead.kind === 'scoped' ? scopeRead.scope : { kind: 'machine' };
    if (apply) {
      // Taken before the lock: a reader of this run's clock may write the registry (a roster line
      // landing just before the retirement write), and that write must finish before this run
      // takes the lock, never while it holds it.
      const at = sources.now().toISOString();
      try {
        // Every roster is read again under the lock that roster writes take, and every retirement
        // is written while it is held: a line naming a record cannot land between the reading that
        // clears it and the write that retires it.
        const done = withTeamsLock(sources.home, () => {
          const lockedTeams = readTeams(sources.home, { strictRoster: true });
          const lockedRows = classify(readAgents(sources.home), lockedTeams, sources.home, scope);
          const named = namedAgents(lockedTeams);
          let written = 0;
          let missed = 0;
          for (const row of lockedRows) {
            if (row.action !== 'retire') continue;
            // Re-validated inside the lock: a roster line that names the record holds it, and no
            // write can have named it since these rosters were read.
            if (named.has(row.agent.id)) continue;
            try {
              row.agent = updateAgent(sources.home, row.agent.id, {
                lifecycle: 'retired',
                reach: { pane: null },
                ...(row.state === 'orphaned' && row.agent.orphaned_at == null ? { orphaned_at: at } : {}),
              });
              written += 1;
            } catch {
              missed += 1;
            }
          }
          return { rows: lockedRows, retired: written, failed: missed };
        });
        rows = done.rows;
        retired = done.retired;
        failed = done.failed;
      } catch (error) {
        registryProblem = error instanceof Error ? error.message : String(error);
      }
    } else {
      rows = classify(readAgents(sources.home), teams, sources.home, scope);
    }
  }
  if (registryProblem !== null) {
    refuse(out, json, 'agents', { id: 'agents.registry', message: registryProblem, repair: null });
    // exit: agents.registry
    return 1;
  }
  if (!json) {
    const style = ttyStyle(io, { json: false });
    const lines = [summaryLine(rows, apply, retired, failed)];
    if (rows.length > 0) {
      lines.push(...renderTable({
        headers: ['AGENT', 'SEAT', 'TEAM', 'LIFECYCLE', 'STATE', 'ACTION'],
        rows: rows.map((row) => [
          row.agent.id,
          row.agent.reach.seat,
          row.team === null ? '-' : row.team.project,
          row.agent.lifecycle,
          row.state,
          row.action,
        ]),
        style,
      }));
    }
    io.stdout(`${lines.join('\n')}\n`);
  } else {
    const counts = countsOf(rows, retired, failed);
    const payload: AgentsJson = {
      format: 1,
      apply,
      records: rows.map((row) => ({
        id: row.agent.id,
        name: row.agent.name,
        team: row.agent.reach.team,
        project: row.team === null ? null : row.team.project,
        seat: row.agent.reach.seat,
        session: row.agent.reach.session,
        lifecycle: row.agent.lifecycle,
        state: row.state,
        action: row.action,
        orphaned_at: row.agent.orphaned_at ?? null,
        reason: row.reason,
      })),
      counts,
    };
    writeJson(io, 'team.agents', payload);
  }
  if (!apply) {
    if (rows.every((row) => row.action === 'none')) {
      // exit: agents.plan
      return 0;
    }
    // exit: agents.stale
    return 1;
  }
  if (failed > 0) {
    // exit: agents.incomplete
    return 1;
  }
  // exit: agents.retired
  return 0;
}

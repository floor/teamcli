// Send addressing: one spec — an agent id (`agt_…`), a `<target>@<scope>` (a seat or a nickname
// before the `@`, or nothing for the team's own lead), or a plain seat or nickname of the team
// whose shell the caller stands in — resolved through the registry. The parse step reads the
// text alone; the lookup step asks the team's roster and the agent records what it reaches. The
// registry's records are the address; the live herdr read is the fallback for a record that
// carries no pane yet.

import { loadTeamFile } from '../file/load.ts';
import { agentList } from '../herdr.ts';
import type { Io } from '../io.ts';
import { AGENT_ID_PATTERN, findAgent, getAgent, type Agent } from '../registry/agents.ts';
import { findTeam, teamIdOf, type TeamRecord } from '../registry/teams.ts';

/** What a spec resolves to: the owning team record, the agent, and the pane to type into. */
export type Target = { team: TeamRecord; agent: Agent; pane: string };

/**
 * A spec the resolver refuses. `kind` labels the refusals a caller must act on before any
 * fallback: an ambiguous spec names two seats (or two leads for `@<team>`), and no declared-seat
 * path may pick one of them by accident.
 */
export type ResolveProblem = { error: string; kind?: 'ambiguous' };

/** One live agent as the herdr read returns it: a name and a pane. */
export type LiveAgent = { name?: string | null; pane: string };

export type LiveRead = (session: string) => LiveAgent[] | null;

const liveFromHerdr: LiveRead = (session) => agentList(session);

/** True for the specs the registry alone answers: an agent id, whole or mistyped, and a
 *  `seat@team`. A plain seat is answered by the registry too, but falls back to the pre-registry
 *  path when the team has no record. */
export function isRegistrySpec(spec: string): boolean {
  return AGENT_ID_PATTERN.test(spec) || spec.startsWith('agt_') || spec.includes('@');
}

/** What a spec's text names, before the registry is asked: an agent id, a `<target>@<scope>`
 *  pair (an empty target is the team's own address: its lead), or a plain seat or nickname of
 *  the caller's own team. The parse reads no file. */
export type ParsedSpec =
  | { kind: 'id'; id: string }
  | { kind: 'at'; target: string; scope: string }
  | { kind: 'seat'; seat: string };

/**
 * The parse step: one grammar, whatever the `<target>` later turns out to name. An agent id is
 * whole; `<target>@<scope>` is exactly one `@` with a scope after it and text before it when a
 * target is written — `@<scope>` alone is the team's own address. A plain target is a seat or
 * nickname of the caller's own team. The agent-id spelling is caught before the plain form so a
 * mistyped id is refused as one rather than looked up as a seat.
 */
export function parseSpec(spec: string): ParsedSpec | { error: string } {
  if (AGENT_ID_PATTERN.test(spec)) return { kind: 'id', id: spec };
  const at = spec.indexOf('@');
  if (at >= 0) {
    const target = spec.slice(0, at);
    const scope = spec.slice(at + 1);
    if (at !== spec.lastIndexOf('@') || scope === '') {
      return { error: `${spec}: a spec is <seat>@<team>, <nickname>@<team>, @<team>, or an agent id` };
    }
    return { kind: 'at', target, scope };
  }
  if (spec.startsWith('agt_')) return { error: `${spec}: that is not an agent id (agt_ plus 12 hex)` };
  return { kind: 'seat', seat: spec };
}

/**
 * The team a spec names, as a person wrote it: the agent id's own `reach.team`, or the scope after
 * the `@`, or — for a plain seat — the team file at the caller's cwd, matched by the id the
 * registry keys teams on, then by the project or session name it may also be written as.
 */
export function resolveTarget(
  home: string,
  spec: string,
  io: Pick<Io, 'cwd'>,
  live: LiveRead = liveFromHerdr,
): Target | ResolveProblem {
  const parsed = parseSpec(spec);
  if ('error' in parsed) return parsed;
  if (parsed.kind === 'id') return fromId(home, parsed.id, live);
  if (parsed.kind === 'at') {
    const team = findTeam(home, parsed.scope);
    if (!team) return { error: `${spec}: no team registry record matches "${parsed.scope}" (by id, project or session)` };
    return lookupInTeam(home, spec, team, parsed.target, live);
  }
  const loaded = loadTeamFile(io.cwd, { home });
  if (!loaded.ok) return { error: `${spec}: the team of the caller's folder cannot be read (${io.cwd})` };
  const id = teamIdOf(loaded.root);
  const team = findTeam(home, id) ?? findTeam(home, loaded.team.project) ?? findTeam(home, loaded.team.session);
  if (!team) return { error: `${spec}: this team has no registry record yet` };
  return lookupInTeam(home, spec, team, parsed.seat, live);
}

/** The agent that holds a seat, across the spellings a record's `reach.team` may use: the
 *  team id the registry keys on, its project, or its session. */
export function seatAgent(home: string, teamKeys: string[], seat: string): Agent | null {
  for (const key of teamKeys) {
    const agent = findAgent(home, { team: key, seat });
    if (agent) return agent;
  }
  return null;
}

function fromId(home: string, id: string, live: LiveRead): Target | ResolveProblem {
  const agent = getAgent(home, id);
  if (!agent) return { error: `${id}: no registered agent carries that id` };
  if (agent.lifecycle === 'retired') return { error: `${id}: the agent is retired; nothing was sent` };
  const team = findTeam(home, agent.reach.team);
  if (!team) return { error: `${id}: its team "${agent.reach.team}" has no registry record` };
  const pane = paneOf(agent, live);
  if ('error' in pane) return pane;
  return { team, agent, pane: pane.pane };
}

/**
 * The lookup step: the record a target reaches inside the team its scope named. The team's roster
 * is asked first, so a seat is reached by its name, a nickname by the human name the file gives
 * it, and `@<team>` by the seat whose entry holds `leads` — never by a role's name. A target two
 * entries answer, as one seat's name and another seat's nickname, is refused naming both before
 * anything is sent. A seat no roster line names keeps the agent-record lookup, so a registry whose
 * roster has not caught up still addresses the seat. The records' own spellings — the id the
 * registry keys on, then its project and session — are asked, because a record's `reach.team` may
 * be written as any of them.
 */
function lookupInTeam(
  home: string,
  spec: string,
  team: TeamRecord,
  target: string,
  live: LiveRead,
): Target | ResolveProblem {
  const chosen = seatOfTarget(team, spec, target);
  if (chosen !== null && 'error' in chosen) return chosen;
  const seat = chosen === null ? target : chosen.seat;
  const agent = seatAgent(home, [teamIdOf(team.root), team.project, team.session], seat);
  // The commands that write the record this spec needs: `register` records a seat its file
  // declares where it already runs, and `up` records every seat it launches, so a seat that ran
  // before this machine's store held it is judged by its own row afterwards.
  if (!agent) {
    const wanted =
      chosen === null
        ? `the seat or nickname "${target}"`
        : seat === target
          ? `the seat "${seat}"`
          : `the seat "${seat}" (the nickname "${target}")`;
    return { error: `${spec}: no registered agent holds ${wanted} in that team; \`team up\` records a seat it launches, or \`team register ${seat}\` records one already running` };
  }
  const pane = paneOf(agent, live);
  if ('error' in pane) return pane;
  return { team, agent, pane: pane.pane };
}

/**
 * The seat a target names in one team, from the team's roster: `''` is the team's lead — the
 * entry its file marks `leads: true` — and a written target is a seat's name or a nickname. A
 * team with no lead has no one its team-level address can reach, so the send is refused rather
 * than silently dropped; a roster marking two leads refuses that address too, naming both. A
 * target that two entries answer is refused naming both: the load refuses that collision, so
 * only a registry written elsewhere can hold it, and no address in it may pick a seat by
 * accident. `null` leaves the target to the agent-record lookup below.
 */
function seatOfTarget(
  team: TeamRecord,
  spec: string,
  target: string,
): { seat: string } | ResolveProblem | null {
  if (target === '') {
    const [lead, ...otherLeads] = team.roster.filter((entry) => entry.leads === true);
    if (lead === undefined) {
      // TODO 0.5.1: resolve to the owner once the owner is reachable through team send
      return { error: `${spec}: this team has no lead seat, so there is no one to deliver to; name a seat (team send --list) or give a seat \`leads\`` };
    }
    if (otherLeads.length > 0) {
      const named = [lead, ...otherLeads].map((entry) => `"${entry.seat}"`);
      return { error: `${spec}: this team has more than one lead seat — ${named.join(' and ')}; nothing was sent`, kind: 'ambiguous' };
    }
    return { seat: lead.seat };
  }
  const seatNames = team.roster.filter((entry) => entry.seat === target).map((entry) => entry.seat);
  const nicknameSeats = team.roster
    .filter((entry) => entry.nickname === target && entry.seat !== target)
    .map((entry) => entry.seat);
  const answers = [...new Set([...seatNames, ...nicknameSeats])];
  if (answers.length > 1) {
    const named = [
      ...seatNames.map((seat) => `the seat "${seat}"`),
      ...nicknameSeats.filter((seat) => !seatNames.includes(seat)).map((seat) => `the nickname "${target}" of the seat "${seat}"`),
    ];
    return { error: `${spec}: the spec matches two seats — ${named.join(' and ')}; nothing was sent`, kind: 'ambiguous' };
  }
  if (seatNames.length > 0) return { seat: seatNames[0] as string };
  if (nicknameSeats.length > 0) return { seat: nicknameSeats[0] as string };
  return null;
}

/** The pane to type into: the one the record carries, re-pointed on relaunch; when it carries
 *  none, the live read of the record's session, and only a single agent of the seat's name. */
function paneOf(agent: Agent, live: LiveRead): { pane: string } | { error: string } {
  if (agent.reach.pane !== null && agent.reach.pane !== '') return { pane: agent.reach.pane };
  const agents = live(agent.reach.session);
  if (agents === null) return { error: `${agent.id}: the session "${agent.reach.session}" could not be read for a pane` };
  const named = agents.filter((one) => one.name === agent.reach.seat);
  if (named.length === 0) {
    return { error: `${agent.id}: no live agent carries the seat "${agent.reach.seat}" in the session "${agent.reach.session}"` };
  }
  if (named.length > 1) {
    return { error: `${agent.id}: herdr lists more than one agent named "${agent.reach.seat}"; nothing was sent` };
  }
  return { pane: (named[0] as LiveAgent).pane };
}

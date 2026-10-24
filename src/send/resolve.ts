// Send addressing: one spec — an agent id (`agt_…`), a `@<nickname>`, a `<target>@<team>` (a
// seat or a nickname before the `@`, or the reserved `lead` for the team's own lead), or a plain
// seat or nickname of the team whose shell the caller stands in — resolved through the registry.
// The parse step reads the text alone; the lookup step asks the team's roster and the agent
// records what it reaches. The registry's records are the address; the live herdr read is the
// fallback for a record that carries no pane yet.

import { readTeamConfig } from '../file/team-config.ts';
import { agentList } from '../herdr.ts';
import type { Io } from '../io.ts';
import { AGENT_ID_PATTERN, findAgent, getAgent, type Agent } from '../registry/agents.ts';
import { findTeam, readTeams, teamIdOf, type RosterEntry, type TeamRecord } from '../registry/teams.ts';
import { resolveSeatSettings } from '../config/apply.ts';
import { agentIdOf } from '../config/read.ts';

/** What a spec resolves to: the owning team record, the agent, and the pane to type into. */
export type Target = { team: TeamRecord; agent: Agent; pane: string };

/**
 * A spec the resolver refuses. `kind` labels the refusals a caller must act on before any
 * fallback: an ambiguous spec names two seats (or two leads for `lead@<team>`), and no
 * declared-seat path may pick one of them by accident; `configuration` names a settings record
 * that exists and does not verify, which an actual send refuses rather than routing around.
 */
export type ResolveProblem = { error: string; kind?: 'ambiguous' | 'configuration' };

/** One live agent as the herdr read returns it: a name and a pane. */
export type LiveAgent = { name?: string | null; pane: string };

export type LiveRead = (session: string) => LiveAgent[] | null;

const liveFromHerdr: LiveRead = (session) => agentList(session);

/** The reserved word that addresses a team's lead: `lead@<team>`. No team file may give a new
 *  seat or any nickname that name (src/file/sections/seats.ts), so the address names the `leads`
 *  seat and nothing else; a legacy seat that keeps the name loads and is addressed bare, never
 *  by the lead address. */
const LEAD = 'lead';

const GRAMMAR = '@<nickname>, <seat>@<team>, <nickname>@<team>, lead@<team>, or an agent id';

/** True for the specs the registry alone answers: an agent id, whole or mistyped, a
 *  `@<nickname>`, and a `<seat>@<team>`. A plain seat is answered by the registry too, but
 *  falls back to the pre-registry path when the team has no record. */
export function isRegistrySpec(spec: string): boolean {
  return AGENT_ID_PATTERN.test(spec) || spec.startsWith('agt_') || spec.includes('@');
}

/** What a spec's text names, before the registry is asked: an agent id, a bare
 *  `@<nickname>`, a `<target>@<team>` pair (a seat, a nickname, or the reserved `lead`), or a
 *  plain seat or nickname of the caller's own team. The parse reads no file. */
export type ParsedSpec =
  | { kind: 'id'; id: string }
  | { kind: 'at'; target: string; scope: string }
  | { kind: 'nickname'; nickname: string }
  | { kind: 'seat'; seat: string };

/**
 * The parse step: one grammar, whatever the `<target>` later turns out to name. An agent id is
 * whole; a spec that starts with `@` is a bare nickname; `<target>@<scope>` is exactly one `@`
 * with a scope after it. A plain target is a seat or nickname of the caller's own team. The
 * agent-id spelling is caught before the plain form so a mistyped id is refused as one rather
 * than looked up as a seat.
 */
export function parseSpec(spec: string): ParsedSpec | { error: string } {
  if (AGENT_ID_PATTERN.test(spec)) return { kind: 'id', id: spec };
  if (spec.startsWith('@')) {
    const nickname = spec.slice(1);
    if (nickname === '' || nickname.includes('@')) return { error: `${spec}: a spec is ${GRAMMAR}` };
    return { kind: 'nickname', nickname };
  }
  const at = spec.indexOf('@');
  if (at >= 0) {
    const target = spec.slice(0, at);
    const scope = spec.slice(at + 1);
    if (at !== spec.lastIndexOf('@') || scope === '') {
      return { error: `${spec}: a spec is ${GRAMMAR}` };
    }
    return { kind: 'at', target, scope };
  }
  if (spec.startsWith('agt_')) return { error: `${spec}: that is not an agent id (agt_ plus 12 hex)` };
  return { kind: 'seat', seat: spec };
}

/**
 * The team a spec names, as a person wrote it: the agent id's own `reach.team`, the scope after
 * the `@`, the caller's own team for a `@<nickname>`, or — for a plain seat — the team file at
 * the caller's cwd, matched by the id the registry keys teams on, then by the project or
 * session name it may also be written as.
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
    return lookupInTeam(home, spec, team, parsed.target, live, true);
  }
  if (parsed.kind === 'nickname') return fromNickname(home, spec, parsed.nickname, io, live);
  const loaded = readTeamConfig(io.cwd, { home });
  if (!loaded.ok) return { error: `${spec}: the team of the caller's folder cannot be read (${io.cwd})` };
  const id = teamIdOf(loaded.root);
  const team = findTeam(home, id) ?? findTeam(home, loaded.team.project) ?? findTeam(home, loaded.team.session);
  if (!team) return { error: `${spec}: this team has no registry record yet` };
  return lookupInTeam(home, spec, team, parsed.seat, live, false);
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

type NicknameSeat = { team: TeamRecord; seat: string };

/** One roster line's effective nickname, or the reason its record could not be read. */
type NicknameAnswer = { nickname: string | undefined } | { error: string };

/** The nickname a roster line answers to: the seat's signed setting where one is set, the
 *  roster's projection of the file's word otherwise. A signed word stands in the file's place,
 *  as it does in the headline a send prints, and the file's old word stops addressing the seat.
 *  A record that exists but does not verify is a refusal, never a fallback: an address decision
 *  cannot stand on a word the record disowns. */
function nicknameOfLine(home: string, team: TeamRecord, line: RosterEntry): NicknameAnswer {
  // A roster line is not the whole context: the team record can carry one and still name no
  // project or entity, and the project registry is then the declaration the signed chain reads.
  // Resolving the context around the line keeps a project record from being skipped here, where
  // an address decision must not stand on a record the resolver never asked for.
  const context = agentIdOf(home, team.root, line.seat);
  const read = resolveSeatSettings({
    home,
    root: team.root,
    agentId: line.agent,
    seat: line.seat,
    teamId: team.id,
    entity: context.entity,
    projectId: context.projectId,
  });
  if (!read.ok) return { error: `the settings record of the seat "${line.seat}" cannot be read: ${read.why}` };
  return { nickname: read.overrides.nickname ?? line.nickname };
}

/** The roster lines one nickname answers in one team. The file makes a nickname unique in its
 *  team; a registry written elsewhere may hold the collision, and no address in it may pick a
 *  seat by accident. One unreadable record refuses the scan: the full set is unknown. */
function nicknameSeatsOf(home: string, team: TeamRecord, nickname: string): { seats: NicknameSeat[] } | { error: string } {
  const seats: NicknameSeat[] = [];
  for (const entry of team.roster) {
    const answer = nicknameOfLine(home, team, entry);
    if ('error' in answer) return answer;
    if (answer.nickname === nickname) seats.push({ team, seat: entry.seat });
  }
  return { seats };
}

/**
 * The seat a `@<nickname>` names: the caller's team first — the team file at its cwd and the
 * registry record keyed on it — then the other teams of that team's entity, each asked for a
 * roster line carrying the nickname. A caller outside any team's folder has neither, so every
 * team record is asked. Exactly one answer sends; several are refused, each named by the
 * `<nickname>@<team>` spelling that picks it; none is refused, pointing at `team send --list`.
 */
function fromNickname(
  home: string,
  spec: string,
  nickname: string,
  io: Pick<Io, 'cwd'>,
  live: LiveRead,
): Target | ResolveProblem {
  // The caller's own team: the file at its cwd names the registry record (by the id the registry
  // keys on, then the project or session it may also be written as), and the file's `entity`
  // stands in when that record carries none.
  let self: TeamRecord | null = null;
  let entity: string | null = null;
  const loaded = readTeamConfig(io.cwd, { home });
  if (loaded.ok) {
    const id = teamIdOf(loaded.root);
    self = findTeam(home, id) ?? findTeam(home, loaded.team.project) ?? findTeam(home, loaded.team.session);
    entity = self?.entity ?? loaded.team.entity ?? null;
  }
  if (self !== null) {
    const own = nicknameSeatsOf(home, self, nickname);
    if ('error' in own) return { error: `${spec}: ${own.error}; nothing was sent`, kind: 'configuration' };
    if (own.seats.length > 1) {
      const named = own.seats.map((one) => `the seat "${one.seat}"`);
      return { error: `${spec}: the nickname "${nickname}" names more than one seat of this team — ${named.join(' and ')}; nothing was sent`, kind: 'ambiguous' };
    }
    if (own.seats.length === 1) {
      const one = own.seats[0] as NicknameSeat;
      return targetOfSeat(home, spec, self, one.seat, `the seat "${one.seat}" (the nickname "${nickname}")`, live);
    }
  }
  const teams = Object.values(readTeams(home)).sort((left, right) => left.project.localeCompare(right.project));
  // Inside a team's folder, that team and its entity are the whole reach; outside one, every
  // registry record is. A caller whose team has no entity is reached by its own team alone.
  const scope =
    self === null
      ? teams
      : teams.filter((team) => team.id !== self.id && entity !== null && team.entity === entity);
  const found: NicknameSeat[] = [];
  for (const team of scope) {
    const answer = nicknameSeatsOf(home, team, nickname);
    if ('error' in answer) return { error: `${spec}: ${answer.error}; nothing was sent`, kind: 'configuration' };
    found.push(...answer.seats);
  }
  if (found.length === 0) {
    return { error: `${spec}: no seat carries the nickname "${nickname}"; \`team send --list\` shows the addresses` };
  }
  if (found.length > 1) {
    const named = found.map((one) => `${nickname}@${one.team.project}`);
    return { error: `${spec}: the nickname "${nickname}" is on more than one team: ${named.join(' or ')}: say which`, kind: 'ambiguous' };
  }
  const only = found[0] as NicknameSeat;
  return targetOfSeat(home, spec, only.team, only.seat, `the seat "${only.seat}" (the nickname "${nickname}")`, live);
}

/**
 * The lookup step: the record a target reaches inside the team its scope named. The team's roster
 * is asked first, so a seat is reached by its name, a nickname by the human name the file gives
 * it, and the `lead@<team>` address by the seat whose entry holds `leads` — never by a role's
 * name, and never the seat that happens to be named `lead` (which keeps its bare name). A target
 * two entries answer, as one seat's name and another seat's nickname, is refused naming both
 * before anything is sent. A seat no roster line names keeps the agent-record lookup, so a
 * registry whose roster has not caught up still addresses the seat. The records' own spellings —
 * the id the registry keys on, then its project and session — are asked, because a record's
 * `reach.team` may be written as any of them.
 */
function lookupInTeam(
  home: string,
  spec: string,
  team: TeamRecord,
  target: string,
  live: LiveRead,
  leadAddress: boolean,
): Target | ResolveProblem {
  const chosen = seatOfTarget(home, team, spec, target, leadAddress, leadAddress && target === LEAD ? fileLeadOf(home, team) : null);
  if (chosen !== null && 'error' in chosen) return chosen;
  const seat = chosen === null ? target : chosen.seat;
  const wanted =
    chosen === null
      ? `the seat or nickname "${target}"`
      : chosen.via === 'lead'
        ? `the seat "${seat}"`
        : seat === target
          ? `the seat "${seat}"`
          : `the seat "${seat}" (the nickname "${target}")`;
  return targetOfSeat(home, spec, team, seat, wanted, live);
}

/** One roster seat's agent and pane, the registry asked by the record's own team spellings. */
function targetOfSeat(
  home: string,
  spec: string,
  team: TeamRecord,
  seat: string,
  wanted: string,
  live: LiveRead,
): Target | ResolveProblem {
  const agent = seatAgent(home, [teamIdOf(team.root), team.project, team.session], seat);
  // The commands that write the record this spec needs: `register` records a seat its file
  // declares where it already runs, and `up` records every seat it launches, so a seat that ran
  // before this machine's store held it is judged by its own row afterwards.
  if (!agent) {
    return { error: `${spec}: no registered agent holds ${wanted} in that team; \`team up\` records a seat it launches, or \`team register ${seat}\` records one already running` };
  }
  const pane = paneOf(agent, live);
  if ('error' in pane) return pane;
  return { team, agent, pane: pane.pane };
}

/**
 * The seat a target names in one team, from the team's roster: the `lead@<team>` address is the
 * team's lead — the entry its file marks `leads: true`, since the reserved word may not be a new
 * seat's name or any nickname, though a legacy seat may still carry the name and keeps its bare
 * spelling. A roster written before the `leads` capability existed holds no mark, and a team
 * upgraded from 0.3.5/0.4 names its lead with the legacy `coordinator:` key: the live file
 * resolves either spelling, and `fileLead` — the lead the file declares, read only when the
 * roster marks none — is that seat. A team whose file names no lead either has no one its lead
 * address can reach, so the send is refused rather than silently dropped; a roster marking two
 * leads refuses that address too, naming both. Any other target is a seat's name or a nickname,
 * and one that two entries answer is refused naming both: the load refuses that collision, so
 * only a registry written elsewhere can hold it, and no address in it may pick a seat by
 * accident. `null` leaves the target to the agent-record lookup in `targetOfSeat`.
 */
function seatOfTarget(
  home: string,
  team: TeamRecord,
  spec: string,
  target: string,
  leadAddress: boolean,
  fileLead: string | null,
): { seat: string; via: 'lead' | 'seat' | 'nickname' } | ResolveProblem | null {
  if (leadAddress && target === LEAD) {
    const [lead, ...otherLeads] = team.roster.filter((entry) => entry.leads === true);
    if (lead === undefined) {
      if (fileLead !== null) return { seat: fileLead, via: 'lead' };
      // TODO 0.5.1: resolve to the owner once the owner is reachable through team send
      return { error: `${spec}: this team has no lead seat, so there is no one to deliver to; name a seat (team send --list) or give a seat \`leads\`` };
    }
    if (otherLeads.length > 0) {
      const named = [lead, ...otherLeads].map((entry) => `"${entry.seat}"`);
      return { error: `${spec}: this team has more than one lead seat — ${named.join(' and ')}; nothing was sent`, kind: 'ambiguous' };
    }
    return { seat: lead.seat, via: 'lead' };
  }
  const seatNames = team.roster.filter((entry) => entry.seat === target).map((entry) => entry.seat);
  const nicknameSeats: string[] = [];
  for (const entry of team.roster) {
    if (entry.seat === target) continue;
    const answer = nicknameOfLine(home, team, entry);
    if ('error' in answer) return { error: `${spec}: ${answer.error}; nothing was sent`, kind: 'configuration' };
    if (answer.nickname === target) nicknameSeats.push(entry.seat);
  }
  const answers = [...new Set([...seatNames, ...nicknameSeats])];
  if (answers.length > 1) {
    const named = [
      ...seatNames.map((seat) => `the seat "${seat}"`),
      ...nicknameSeats.filter((seat) => !seatNames.includes(seat)).map((seat) => `the nickname "${target}" of the seat "${seat}"`),
    ];
    return { error: `${spec}: the spec matches two seats — ${named.join(' and ')}; nothing was sent`, kind: 'ambiguous' };
  }
  if (seatNames.length > 0) return { seat: seatNames[0] as string, via: 'seat' };
  if (nicknameSeats.length > 0) return { seat: nicknameSeats[0] as string, via: 'nickname' };
  return null;
}

/**
 * The lead a team file declares, for a registry roster that marks none: the file's `leads: true`
 * seat or the legacy `coordinator:` key, whichever spelling it used — the loader resolves the two
 * as one lead and never reads a role's word, so an upgraded 0.3.5/0.4 team reaches its lead
 * without the role rename. Read only for `lead@<team>` and only when no roster line holds the
 * capability: when one does, the registry is the address and the file is not asked. Null when the
 * file cannot be read — the refusal then says the registry holds no lead.
 */
function fileLeadOf(home: string, team: TeamRecord): string | null {
  if (team.roster.some((entry) => entry.leads === true)) return null;
  const loaded = readTeamConfig(team.root, { home });
  return loaded.ok && loaded.team.orchestrator !== '' ? loaded.team.orchestrator : null;
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

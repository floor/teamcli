// Send admission: who may write into whose drop folder.
//
// Default deny. A send is admitted only by one of the rules below, and each names itself in the
// verdict so the drop file's header can carry both the sender's agent id and the rule that let it
// through. Nothing here reads a clock, a file or herdr: it is a decision over the registry's own
// records, so the same pair always judges the same way.
//
// The project level is read from the records the caller hands in beside the team registry —
// `AdmitContext` — and its rules are asked first, so a project's own pairs are admitted by the
// project's own rules. Those rules are decided by the project record and by the `leads`
// capability a seat holds, never by a role's name, which is each team's own word in any language.
// A pair whose teams share no project keeps the team rules below unchanged: nothing here ever
// crosses projects. And a record confers no right: registration, a lifecycle, a signing role —
// none of it admits anything by itself; every verdict is made from the pair's own relationships
// and capabilities, and a send with a record on each side but no rule for the pair is refused
// exactly as a pair the registry never knew.

import type { Agent } from '../registry/agents.ts';
import { seatsCrossTeams, type SettingLevel } from '../settings/inherit.ts';

/** What admission needs of a team: its identity and its roster. The team registry's own record
 *  is wider, and satisfies this shape as it stands. */
export type AdmitTeam = {
  project: string;
  /** The entity a team belongs to; null when its file names none. */
  entity: string | null;
  /** The team's lead seat, when the record carries it — the seat a team file's own `leads` spelling
   *  projects onto; the roster line holding the capability is read when it does not. */
  orchestrator?: string | null;
  /** The session the team runs in, when the record carries it; a grant may spell a team by it. */
  session?: string | null;
  /** The roster lines, and, where the record holds them, the capabilities that make a seat's
   *  place in the chain what it is: `leads`, the only thing that makes a seat its team's lead to
   *  admission, and `assistant`, which puts a seat at the entity's assistant position. */
  roster: { agent: string; seat: string; role: string; leads?: boolean; assistant?: boolean }[];
};

/** Every registered team, by team id — `readTeams`' own shape. */
export type AdmitTeams = Record<string, AdmitTeam>;

/** One registered project as admission reads it: the lead, by agent id, and the teams it names.
 *  The project registry's own record (`readProjects`) is wider and satisfies this shape as it
 *  stands. */
export type AdmitProject = { lead: string | null; teams: string[] };

/** Every registered project, by project id — `readProjects`' own shape. */
export type AdmitProjects = Record<string, AdmitProject>;

/**
 * The project level, in the caller's own hands: the registered projects, and the asker's own
 * chain of `seats_cross_teams` declarations, entity → project → team → seat, as the records
 * declare them — `seatsCrossTeams` resolves one, a level that says nothing is left out, and no
 * declaration at all is the setting's own default, off. Given when the caller's records know
 * their projects; absent leaves the project rules out of play entirely.
 */
export type AdmitContext = {
  projects: AdmitProjects;
  crossTeams?: Partial<Record<SettingLevel, boolean | undefined>>;
};

export type SendVerdict = { ok: true; rule: string } | { ok: false; why: string };

/** An owner-signed grant naming `send`, already verified by the caller's grant machinery. */
export type SendGrant = { name: string };

/**
 * One send-grant record as read from the owner's grants folder (`~/.config/team/grants/`): the
 * pair it admits, spelled as `from` and `to`, and the moment it stops. Reading the folder is
 * `readSendGrants`'; deciding whether a record admits this pair is `sendGrantFor`, which reads
 * no file and no clock of its own.
 */
export type SendGrantRecord = { name: string; from: string; to: string; expires: string };

/**
 * A side of a send that admission can judge without the registry: the seat a command has already
 * resolved, and the team it sits in, with the role when the file names one. A sender is judged
 * from its `Agent` record — that is where the id the receiver sees comes from — while a target is
 * the seat the command resolved, which is the same pair either way.
 */
export type SendSeat = { seat: string; team: string; role?: string };

/**
 * A sender the registry holds no record for yet: the seat the live team file declares, placed by
 * herdr. Admission judges it by the declared seat's own name, team and role, so the rules that
 * stay inside that team reach it — the one case the bootstrap loop needs — and the header says the
 * record is missing, so a receiver reads why the agent id is absent. It is never granted: a grant
 * names a record's identity, and this sender has none yet.
 */
export type DeclaredSender = SendSeat & { declared: true };

/** Either side of a send: the registry's own record, or a resolved seat — a declared one when
 *  the sender has no record yet. */
export type SendSide = Agent | SendSeat | DeclaredSender;

/** The rules, in the order they are asked. Named once, so a refusal, a caller that has no
 *  identity to judge by, and the docs all read alike. */
export const RULE_SUMMARY = [
  'the owner',
  'an orchestrator to another orchestrator',
  "an orchestrator or operator to a seat of its own team",
  "an assistant seat to its entity's coordinator",
  "a seat to its own team's orchestrator",
  'an owner-signed grant naming send',
].join('; ');

/** The project rules, in the order they are asked — ahead of the team rules above — and each
 *  names itself in the verdict as those do. All three are decided by the project record and the
 *  `leads` capability, and none of them ever crosses projects. */
export const PROJECT_RULES = [
  'the project lead and the leads of its teams',
  'team leads within one project to each other',
  'seats crossing teams within one project, where the project allows it',
] as const;

export const PROJECT_RULE_SUMMARY = PROJECT_RULES.join('; ');

/**
 * The verdict for one send. `caller` is the sender's registry record, or the literal `owner`;
 * `target` is the receiver's record, or the seat it resolved to; `teams` is the team registry.
 * `grant` is given only after the caller has verified an owner-signed grant naming `send`:
 * admission never reads the grant store itself, it names the grant in the rule it returns.
 * `context` is the project level: given when the caller's records know their projects, absent
 * when they do not — and the project rules are then simply not in play.
 */
export function admitSend(
  caller: SendSide | 'owner',
  target: SendSide,
  teams: AdmitTeams,
  grant?: SendGrant,
  context?: AdmitContext,
): SendVerdict {
  if (caller === 'owner') return { ok: true, rule: 'the owner' };

  const callerTeamId = teamOf(caller);
  const callerTeam = teams[callerTeamId];
  const targetTeamId = teamOf(target);
  const targetTeam = teams[targetTeamId];
  const targetOrchestrator = orchestratorSeat(targetTeam);

  // The project rules, asked first when the caller's records know their projects: the project
  // record decides its own pairs, and the `leads` capability decides which seat leads a team.
  if (context !== undefined) {
    const twice = duplicateProjectName(callerTeamId, targetTeamId, context.projects);
    if (twice !== null) return { ok: false, why: `${seatAt(caller)} may not send to ${seatAt(target)}: ${twice}` };
    const project = sharedProject(callerTeamId, targetTeamId, context.projects);
    if (project !== null) {
      const crossing = callerTeamId !== targetTeamId;
      const callerLead = leadSeat(callerTeam);
      const targetLead = leadSeat(targetTeam);
      const callerIsLead = callerLead !== null && seatOf(caller) === callerLead;
      const targetIsLead = targetLead !== null && seatOf(target) === targetLead;
      const callerId = idOf(caller);
      const targetId = idOf(target);
      // The project lead and the leads of its teams, either way round.
      if (callerId !== '' && callerId === project.lead && targetIsLead) return { ok: true, rule: PROJECT_RULES[0] };
      if (targetId !== '' && targetId === project.lead && callerIsLead) return { ok: true, rule: PROJECT_RULES[0] };
      // Two leads of one project, to each other.
      if (crossing && callerIsLead && targetIsLead) return { ok: true, rule: PROJECT_RULES[1] };
      // Seats crossing teams, where the project's setting allows it — default off.
      if (crossing && seatsCrossTeams(context.crossTeams ?? {})) return { ok: true, rule: PROJECT_RULES[2] };
    }
  }

  // An orchestrator writes to an orchestrator, in any team: the pair that carries work between
  // teams.
  if (seatOf(caller) === orchestratorSeat(callerTeam) && seatOf(target) === targetOrchestrator) {
    return { ok: true, rule: 'an orchestrator to another orchestrator' };
  }
  // The team's own leads brief its seats: the orchestrator, or the operator, to any seat of the
  // same team. Never across teams: another team's seats are reached through its orchestrator.
  const leadsOwnTeam = seatOf(caller) === orchestratorSeat(callerTeam) || roleOf(caller, callerTeam) === 'operator';
  if (callerTeam !== undefined && targetTeam === callerTeam && leadsOwnTeam) {
    return { ok: true, rule: 'an orchestrator or operator to a seat of its own team' };
  }
  // The entity's assistant writes to the coordinator of its own entity: the seat above the
  // entity's teams. Which seat that is, is a place in the chain and the capability the file
  // marks — the entity's first assistant — never the word in a role.
  const assistant = entityAssistant(callerTeam?.entity, teams);
  if (
    assistant !== null && callerTeamId === assistant.team && seatOf(caller) === assistant.seat
    && onMainCoordinator(target, callerTeam?.entity, teams)
  ) {
    return { ok: true, rule: "an assistant seat to its entity's coordinator" };
  }
  // Any seat writes to its own team's orchestrator.
  if (callerTeam !== undefined && targetTeam === callerTeam && seatOf(target) === targetOrchestrator) {
    return { ok: true, rule: "a seat to its own team's orchestrator" };
  }
  if (grant !== undefined) return { ok: true, rule: `an owner-signed grant naming send (${grant.name})` };

  const summary = context === undefined ? RULE_SUMMARY : `${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY}`;
  return {
    ok: false,
    why: `${seatAt(caller)} may not send to ${seatAt(target)}: no rule admits it (${summary})`,
  };
}

/**
 * The owner-signed grant that admits this pair, or undefined: the first record whose `from` names
 * the caller — by its agent id, its `seat@team` or its `session/seat` — whose `to` names the
 * receiver the same way (or, as a bare seat, the caller's own team's seat), and whose `expires` is
 * still ahead of `now`. A record matching neither side is not a grant for this send: the caller
 * passes only what this returns into `admitSend`.
 *
 * Nothing looser is read: a bare `from` is ambiguous between teams and matches nobody, and a
 * `from` naming another agent — however spelled — is refused here, so the identity the drop file
 * carries is always the registry's own record for the caller.
 */
export function sendGrantFor(
  caller: SendSide,
  target: SendSide,
  grants: SendGrantRecord[],
  teams: AdmitTeams,
  now: Date,
): SendGrant | undefined {
  const nowMs = now.getTime();
  for (const grant of grants) {
    const expMs = Date.parse(grant.expires);
    if (!Number.isFinite(expMs) || nowMs >= expMs) continue;
    if (!grantFromNames(grant.from, caller, teams)) continue;
    if (!grantToNames(grant.to, target, caller, teams)) continue;
    return { name: grant.name };
  }
  return undefined;
}

/** Whether a grant's `from` names this caller: an agent id, `seat@team`, or `session/seat`. */
function grantFromNames(from: string, caller: SendSide, teams: AdmitTeams): boolean {
  if (from.startsWith('agt_')) return 'reach' in caller && caller.id === from;
  const at = from.lastIndexOf('@');
  if (at > 0) {
    return seatOf(caller) === from.slice(0, at) && teamSpelled(teamOf(caller), from.slice(at + 1), teams);
  }
  const slash = from.indexOf('/');
  if (slash > 0) {
    return 'reach' in caller && caller.reach.session === from.slice(0, slash) && seatOf(caller) === from.slice(slash + 1);
  }
  return false;
}

/** Whether a grant's `to` names this receiver: an agent id, `seat@team`, `session/seat`, or a
 *  bare seat, which only the caller's own team makes unambiguous. */
function grantToNames(to: string, target: SendSide, caller: SendSide, teams: AdmitTeams): boolean {
  if (to.startsWith('agt_')) return 'reach' in target && target.id === to;
  const at = to.lastIndexOf('@');
  if (at > 0) {
    return seatOf(target) === to.slice(0, at) && teamSpelled(teamOf(target), to.slice(at + 1), teams);
  }
  const slash = to.indexOf('/');
  if (slash > 0) {
    return 'reach' in target && target.reach.session === to.slice(0, slash) && seatOf(target) === to.slice(slash + 1);
  }
  return seatOf(target) === to && teamOf(target) === teamOf(caller);
}

/** Whether `spelled` names the team `id`: the record's own id, its project or its session. */
function teamSpelled(id: string, spelled: string, teams: AdmitTeams): boolean {
  if (id === spelled) return true;
  const team = teams[id];
  return team !== undefined && (team.project === spelled || team.session === spelled);
}

/**
 * The drop file's first line: who wrote it, and the rule or grant that admitted the write. The
 * body follows one empty line under it, so a reader sees the sender before the message.
 */
export function senderHeader(caller: SendSide | 'owner', rule: string): string {
  if (caller === 'owner') return `from the owner — admitted by: ${rule}\n`;
  // A declared seat: the id the receiver would judge by is the one the registry has not written
  // yet, so the header says whose seat it is instead of an id.
  if ('declared' in caller && caller.declared) {
    return `from the file's seat ${caller.seat} (no registry record yet) — admitted by: ${rule}\n`;
  }
  const id = 'reach' in caller ? caller.id : '';
  const name = 'reach' in caller ? caller.name : caller.seat;
  const who = id === '' ? `${name}, ${seatAt(caller)}` : `${id} (${name}, ${seatAt(caller)})`;
  return `from ${who} — admitted by: ${rule}\n`;
}

/** The seat a side sits in. */
function seatOf(side: SendSide): string {
  return 'reach' in side ? side.reach.seat : side.seat;
}

/** The team a side sits in. */
export function teamOf(side: SendSide): string {
  return 'reach' in side ? side.reach.team : side.team;
}

/** The agent id a side carries, when it has one. */
function idOf(side: SendSide): string {
  return 'reach' in side ? side.id : '';
}

/** The sender's role in its own team's roster: the roster first, by agent id and then by the
 *  seat it sits in, and the side's own role when the roster does not name it. */
function roleOf(caller: SendSide, team: AdmitTeam | undefined): string | null {
  if (team) {
    const byAgent = team.roster.find((entry) => entry.agent !== '' && entry.agent === idOf(caller));
    if (byAgent) return byAgent.role;
    const bySeat = team.roster.find((entry) => entry.seat === seatOf(caller));
    if (bySeat) return bySeat.role;
  }
  if ('reach' in caller) return caller.signing.role === '' ? null : caller.signing.role;
  return caller.role ?? null;
}

/** The lead seat of a team: the record's own field, else the seat holding the `leads` capability
 *  — the same reading the project rules make — else the legacy spelling for records that predate
 *  the capability: the registry's `orchestrator` role, the `coordinator` a live file's own seats
 *  carry, or the seat named for it. */
function orchestratorSeat(team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  if (team.orchestrator) return team.orchestrator;
  const byCapability = team.roster.find((entry) => entry.leads === true);
  if (byCapability) return byCapability.seat;
  const byRole =
    team.roster.find((entry) => entry.role === 'orchestrator') ?? team.roster.find((entry) => entry.role === 'coordinator');
  if (byRole) return byRole.seat;
  return team.roster.find((entry) => entry.seat === 'orchestrator')?.seat ?? null;
}

/** The seat that leads a team by the `leads` capability: the lead seat the record carries — the
 *  one a team file's own `leads` spelling projects onto — else the roster line that holds the
 *  capability. Null when the record says neither, and never a guess from a role's name: a role is
 *  each team's own word, in any language. */
function leadSeat(team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  if (team.orchestrator) return team.orchestrator;
  return team.roster.find((entry) => entry.leads === true)?.seat ?? null;
}

/** The entity's assistant, with the team it sits in: the seat holding the `assistant` capability
 *  nearest the head of the chain — the entity's own team first (the team whose project is the
 *  entity itself), the entity's other teams after it by team id, each roster in the order the
 *  file declares it — and null when no seat of the entity holds the capability. A capability and
 *  a place in the chain, never a role's name: a role is each team's own word, in any language. */
function entityAssistant(entity: string | null | undefined, teams: AdmitTeams): { team: string; seat: string } | null {
  if (!entity) return null;
  const head = (id: string): number => (teams[id]?.project === entity ? 0 : 1);
  const ids = Object.keys(teams).sort((a, b) => head(a) - head(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) {
    const team = teams[id];
    if (!team || team.entity !== entity) continue;
    const line = team.roster.find((entry) => entry.assistant === true);
    if (line) return { team: id, seat: line.seat };
  }
  return null;
}

/** The registered projects naming a team, in project-id order, with their ids — the reverse index
 *  `ofTeam` reads from the live registry, over the records admission was handed. */
function projectsNaming(teamId: string, projects: AdmitProjects): [string, AdmitProject][] {
  return Object.keys(projects)
    .sort()
    .flatMap((id) => {
      const project = projects[id];
      return project !== undefined && project.teams.includes(teamId) ? [[id, project] as [string, AdmitProject]] : [];
    });
}

/** The one project naming both teams, or null — the record a pair's project rules are read from.
 *  A team named by two projects never gets here: `duplicateProjectName` refuses first. A pair
 *  whose teams share no project reaches no project rule at all, so nothing crosses projects. */
function sharedProject(callerTeamId: string, targetTeamId: string, projects: AdmitProjects): AdmitProject | null {
  for (const [, project] of projectsNaming(callerTeamId, projects)) {
    if (project.teams.includes(targetTeamId)) return project;
  }
  return null;
}

/** The refusal when a team of this pair is named by more than one project — the state the project
 *  readers refuse, naming both — so admission refuses it too rather than pick one silently. Null
 *  when neither team is named twice. */
function duplicateProjectName(callerTeamId: string, targetTeamId: string, projects: AdmitProjects): string | null {
  for (const teamId of callerTeamId === targetTeamId ? [callerTeamId] : [callerTeamId, targetTeamId]) {
    const named = projectsNaming(teamId, projects);
    if (named.length > 1) {
      return `team ${teamId} is named in ${named.length} projects: ${named.map(([id]) => id).join(', ')}`;
    }
  }
  return null;
}

/** True when the target is the coordinator of `entity`: the lead seat of the entity's own team,
 *  the one whose project is the entity itself. */
function onMainCoordinator(target: SendSide, entity: string | null | undefined, teams: AdmitTeams): boolean {
  if (!entity) return false;
  for (const id of Object.keys(teams).sort()) {
    const team = teams[id];
    if (!team || team.entity !== entity || team.project !== entity) continue;
    if (teamOf(target) === id && seatOf(target) === orchestratorSeat(team)) return true;
  }
  return false;
}

/** How a refusal and the header name a side: its seat in its team. */
function seatAt(side: SendSide): string {
  return `${seatOf(side)}@${teamOf(side)}`;
}

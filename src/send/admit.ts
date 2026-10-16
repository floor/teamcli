// Send admission: who may write into whose drop folder.
//
// Default deny. A send is admitted only by one of the rules below, and each names itself in the
// verdict so the drop file's header can carry both the sender's agent id and the rule that let it
// through. Nothing here reads a clock, a file or herdr: it is a decision over the registry's own
// records, so the same pair always judges the same way.

import type { Agent } from '../registry/agents.ts';

/** What admission needs of a team: its identity and its roster. The team registry's own record
 *  is wider, and satisfies this shape as it stands. */
export type AdmitTeam = {
  project: string;
  entity: string;
  /** The lead seat, when the record carries it; the roster is read when it does not. */
  orchestrator?: string | null;
  roster: { agent: string; seat: string; role: string }[];
};

/** Every registered team, by team id — `readTeams`' own shape. */
export type AdmitTeams = Record<string, AdmitTeam>;

export type SendVerdict = { ok: true; rule: string } | { ok: false; why: string };

/** An owner-signed grant naming `send`, already verified by the caller's grant machinery. */
export type SendGrant = { name: string };

/** The rules, in the order they are asked. Named once, so a refusal and the docs read alike. */
const RULES = [
  'the owner',
  'an orchestrator to another orchestrator',
  "an assistant seat to its entity's coordinator",
  "a seat to its own team's orchestrator",
  'an owner-signed grant naming send',
].join('; ');

/**
 * The verdict for one send. `caller` is the sender's registry record, or the literal `owner`;
 * `target` is the receiver's record; `teams` is the team registry. `grant` is given only after
 * the caller has verified an owner-signed grant naming `send`: admission never reads the grant
 * store itself, it names the grant in the rule it returns.
 */
export function admitSend(caller: Agent | 'owner', target: Agent, teams: AdmitTeams, grant?: SendGrant): SendVerdict {
  if (caller === 'owner') return { ok: true, rule: 'the owner' };

  const callerTeam = teams[caller.reach.team];
  const targetTeam = teams[target.reach.team];
  const callerSeat = caller.reach.seat;
  const targetOrchestrator = orchestratorSeat(targetTeam);

  // An orchestrator writes to an orchestrator: the pair that carries work between teams.
  if (callerSeat === orchestratorSeat(callerTeam) && target.reach.seat === targetOrchestrator) {
    return { ok: true, rule: 'an orchestrator to another orchestrator' };
  }
  // An assistant writes to the coordinator of its own entity: the seat above the entity's teams.
  if (roleOf(caller, callerTeam) === 'assistant' && onMainCoordinator(target, callerTeam?.entity, teams)) {
    return { ok: true, rule: "an assistant seat to its entity's coordinator" };
  }
  // Any seat writes to its own team's orchestrator.
  if (callerTeam !== undefined && targetTeam === callerTeam && target.reach.seat === targetOrchestrator) {
    return { ok: true, rule: "a seat to its own team's orchestrator" };
  }
  if (grant !== undefined) return { ok: true, rule: `an owner-signed grant naming send (${grant.name})` };

  return {
    ok: false,
    why: `${seatAt(caller)} may not send to ${seatAt(target)}: no rule admits it (${RULES})`,
  };
}

/**
 * The drop file's first line: who wrote it, and the rule or grant that admitted the write. The
 * body follows one empty line under it, so a reader sees the sender before the message.
 */
export function senderHeader(caller: Agent | 'owner', rule: string): string {
  const from = caller === 'owner' ? 'the owner' : `${caller.id} (${caller.name}, ${seatAt(caller)})`;
  return `from ${from} — admitted by: ${rule}\n`;
}

/** The caller's role in its own team's roster: by agent id first, then by the seat it sits in. */
function roleOf(agent: Agent, team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  const byAgent = team.roster.find((entry) => entry.agent === agent.id);
  if (byAgent) return byAgent.role;
  return team.roster.find((entry) => entry.seat === agent.reach.seat)?.role ?? null;
}

/** The lead seat of a team: the record's own field, else the roster, else the seat named for it. */
function orchestratorSeat(team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  if (team.orchestrator) return team.orchestrator;
  const byRole = team.roster.find((entry) => entry.role === 'orchestrator');
  if (byRole) return byRole.seat;
  return team.roster.find((entry) => entry.seat === 'orchestrator')?.seat ?? null;
}

/** True when the target is the coordinator of `entity`: the lead seat of the entity's own team,
 *  the one whose project is the entity itself. */
function onMainCoordinator(target: Agent, entity: string | undefined, teams: AdmitTeams): boolean {
  if (entity === undefined) return false;
  for (const id of Object.keys(teams).sort()) {
    const team = teams[id];
    if (!team || team.entity !== entity || team.project !== entity) continue;
    if (target.reach.team === id && target.reach.seat === orchestratorSeat(team)) return true;
  }
  return false;
}

/** How a refusal and the header name an agent: its seat in its team. */
function seatAt(agent: Agent): string {
  return `${agent.reach.seat}@${agent.reach.team}`;
}

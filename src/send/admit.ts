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
  /** The entity a team belongs to; null when its file names none. */
  entity: string | null;
  /** The lead seat, when the record carries it; the roster is read when it does not. */
  orchestrator?: string | null;
  /** The session the team runs in, when the record carries it; a grant may spell a team by it. */
  session?: string | null;
  roster: { agent: string; seat: string; role: string }[];
};

/** Every registered team, by team id — `readTeams`' own shape. */
export type AdmitTeams = Record<string, AdmitTeam>;

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

/** Either side of a send: the registry's own record, or a resolved seat. */
export type SendSide = Agent | SendSeat;

/** The rules, in the order they are asked. Named once, so a refusal, a caller that has no
 *  identity to judge by, and the docs all read alike. */
export const RULE_SUMMARY = [
  'the owner',
  'an orchestrator to another orchestrator',
  "an assistant seat to its entity's coordinator",
  "a seat to its own team's orchestrator",
  'an owner-signed grant naming send',
].join('; ');

/**
 * The verdict for one send. `caller` is the sender's registry record, or the literal `owner`;
 * `target` is the receiver's record, or the seat it resolved to; `teams` is the team registry.
 * `grant` is given only after the caller has verified an owner-signed grant naming `send`:
 * admission never reads the grant store itself, it names the grant in the rule it returns.
 */
export function admitSend(caller: SendSide | 'owner', target: SendSide, teams: AdmitTeams, grant?: SendGrant): SendVerdict {
  if (caller === 'owner') return { ok: true, rule: 'the owner' };

  const callerTeam = teams[teamOf(caller)];
  const targetTeamId = teamOf(target);
  const targetTeam = teams[targetTeamId];
  const targetOrchestrator = orchestratorSeat(targetTeam);

  // An orchestrator writes to an orchestrator, in any team: the pair that carries work between
  // teams. The design admits no other orchestrator-to-seat reach — a seat of the caller's own
  // team included — so nothing here names one.
  if (seatOf(caller) === orchestratorSeat(callerTeam) && seatOf(target) === targetOrchestrator) {
    return { ok: true, rule: 'an orchestrator to another orchestrator' };
  }
  // An assistant writes to the coordinator of its own entity: the seat above the entity's teams.
  if (roleOf(caller, callerTeam) === 'assistant' && onMainCoordinator(target, callerTeam?.entity, teams)) {
    return { ok: true, rule: "an assistant seat to its entity's coordinator" };
  }
  // Any seat writes to its own team's orchestrator.
  if (callerTeam !== undefined && targetTeam === callerTeam && seatOf(target) === targetOrchestrator) {
    return { ok: true, rule: "a seat to its own team's orchestrator" };
  }
  if (grant !== undefined) return { ok: true, rule: `an owner-signed grant naming send (${grant.name})` };

  return {
    ok: false,
    why: `${seatAt(caller)} may not send to ${seatAt(target)}: no rule admits it (${RULE_SUMMARY})`,
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
function teamOf(side: SendSide): string {
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

/** The lead seat of a team: the record's own field, else the roster's lead role — the registry's
 *  `orchestrator`, or the `coordinator` a live file's own seats carry — else the seat named for it. */
function orchestratorSeat(team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  if (team.orchestrator) return team.orchestrator;
  const byRole =
    team.roster.find((entry) => entry.role === 'orchestrator') ?? team.roster.find((entry) => entry.role === 'coordinator');
  if (byRole) return byRole.seat;
  return team.roster.find((entry) => entry.seat === 'orchestrator')?.seat ?? null;
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

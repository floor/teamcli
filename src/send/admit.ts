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
// crosses projects. The cross-team reaches are the entity's own: its leads write to each other —
// a lead to a lead of its entity, and the entity's coordinator to every team lead of that entity
// — and the entity's main orchestrator, the lead of the team whose project is the entity itself,
// writes to any seat of the entity's teams. Both are read from the team records' `entity` and the
// `leads` capability, never from a role's word, and both are refused across entities. Each reads
// the asker's own `seats_cross_teams` chain with its own default: on for both entity reaches,
// off for the project's crossing seats. And a record confers no right: registration, a lifecycle,
// a signing role — none of it admits anything by itself; every verdict is made from the pair's
// own relationships and capabilities, and a send with a record on each side but no rule for the
// pair is refused exactly as a pair the registry never knew.

import type { Agent } from '../registry/agents.ts';
import { declarationsOf, type SettingLevel, type SettingSpec } from '../settings/inherit.ts';
import { resolveSetting, seatsCrossTeams } from '../settings/resolve.ts';
import { defaultNaming, senderDisplayName, type SenderIdentity, type SenderNaming } from './names.ts';

/** What admission needs of a team: its identity and its roster. The team registry's own record
 *  is wider, and satisfies this shape as it stands. */
export type AdmitTeam = {
  project: string;
  /** The entity a team belongs to; null when its file names none. */
  entity: string | null;
  /** The team's lead seat, when the record carries it — the seat a team file's own `leads` spelling
   *  projects onto; the roster line holding the capability is read when it does not. */
  orchestrator?: string | null;
  /** The seat the team file declares as its operator — a place in the file's chain, like the
   *  lead's, never a role word. Read from the live file's `operator:` key; a record that carries
   *  none leaves the operator rule off for that team. */
  operator?: string | null;
  /** The session the team runs in, when the record carries it; a grant may spell a team by it. */
  session?: string | null;
  /** Previous team names carried across a rename during the grace window. */
  previousNames?: { name: string; until: string }[];
  /** The roster lines, and, where the record holds them, the capabilities that make a seat's
   *  place in the chain what it is: `leads`, the only thing that makes a seat its team's lead to
   *  admission, and `assistant`, which puts a seat at the entity's assistant position. */
  roster: { agent: string; seat: string; role: string; leads?: boolean; assistant?: boolean }[];
};

/** Every registered team, by team id — `readTeams`' own shape. */
export type AdmitTeams = Record<string, AdmitTeam>;

/** One registered project as admission reads it: the lead, by agent id, and the teams it names.
 *  The project registry's public reads derive these memberships from team records. */
export type AdmitProject = { entity?: string | null; lead: string | null; teams: string[] };

/** Every registered project, keyed by id, with memberships derived from team records. */
export type AdmitProjects = Record<string, AdmitProject>;

/** The two reply contexts a reply command may hand in: the general open-thread reply, and the
 *  bound answer to the entity's main orchestrator. Nothing else sets either. */
export type ReplyContext = 'open-thread' | 'main-orchestrator-thread';

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
  /**
   * Set by a reply alone, and only after the caller has verified the records it stands on. A
   * send never sets it. `open-thread` is the record-and-thread check `reply-on-open-thread`
   * asks; `main-orchestrator-thread` is the narrower one a seat's answer to the entity's main
   * orchestrator carries — its record, its sender and the opening record of its thread — and the
   * reach is then asked again here, as a setting and as a chain place.
   */
  reply?: ReplyContext;
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

/** One send-shaped record as the reader classified it: `verified` when the signature checks out
 *  under the owner's approval key, `unsigned` when the file carries none, `bad-signature` when it
 *  carries one that does not verify (including when the key itself is missing or unreadable).
 *  Only `verified` records admit; the other two let a refusal name the record and its re-issue. */
export type SendGrantRead = SendGrantRecord & { state: 'verified' | 'unsigned' | 'bad-signature' };

/** The reserved receiver word: `orchestrator@<entity>` names the lead seat of a team of the
 *  sender's own entity, in `to`, and nothing else. */
export const ORCHESTRATOR_RECEIVER = 'orchestrator';

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

/** The declared same-team seat-to-seat rule: any roster-declared seat of a team writes to any
 *  roster-declared seat of that same team, asked after every specific rule, grant, and reply so
 *  all earlier verdict labels remain unchanged. */
export const DECLARED_SEAT_RULE = 'a seat to a declared seat of its own team';

/** The rules, in the order they are asked. Named once, so a refusal, a caller that has no
 *  identity to judge by, and the docs all read alike. */
export const RULE_SUMMARY = [
  'the owner',
  'an orchestrator to another orchestrator',
  'an orchestrator or operator to a seat of its own team',
  'an operator to another operator of its own team',
  "an assistant seat to its entity's coordinator",
  "the entity's main orchestrator to any seat of the entity's teams",
  "a seat to its own team's orchestrator",
  'an owner-signed grant naming send',
  DECLARED_SEAT_RULE,
].join('; ');

/**
 * The rule a reply is admitted by when no rule above admits its pair — draft 3 §7's
 * `reply-on-open-thread`: the reply's record verified, its thread open, neither seat removed and
 * no revocation or deny on the pair, all of which the caller checked before handing in the
 * context. Named in the same words as the rules above, so the record, the refusal and the docs
 * read alike.
 */
export const REPLY_RULE = 'a reply to the sender of a record on an open thread';

/**
 * The rule a seat's reply to the entity's main orchestrator is admitted by — the main
 * orchestrator's reach in the direction of an answer: the main orchestrator
 * wrote to the seat on a thread it opened, and the seat answers there, on that thread, and
 * nowhere else. The caller sets the marker only after it verified the record, its sender and
 * the thread's opening record; admission asks the chain place and the setting again. It is never
 * a send's rule, so it is not in `RULE_SUMMARY`.
 */
export const MAIN_ORCHESTRATOR_REPLY_RULE = "a seat replying to the entity's main orchestrator on its thread";

/** The project rules, in the order they are asked — ahead of the team rules above — and each
 *  names itself in the verdict as those do. All three are decided by the project record and the
 *  `leads` capability, and none of them ever crosses projects. */
export const PROJECT_RULES = [
  'the project lead and the leads of its teams',
  'team leads within one project to each other',
  'seats crossing teams within one project, where the project allows it',
] as const;

export const PROJECT_RULE_SUMMARY = PROJECT_RULES.join('; ');

/** The one role word admission reads, and the only pair it decides: two seats of one team whose
 *  roster lines carry `role: operator` write to each other. Every other role word still names
 *  nothing — a seat called `operator`, or one whose file marks the operator place, is not reached
 *  by this word — and the pair never crosses teams. */
export const OPERATOR_ROLE = 'operator';

/**
 * The verdict for one send. `caller` is the sender's registry record, or the literal `owner`;
 * `target` is the receiver's record, the seat it resolved to, or the literal `owner` on a reply
 * whose answer goes back to the owner; `teams` is the team registry.
 * `grant` is given only after the caller has verified an owner-signed grant naming `send`:
 * admission never reads the grant store itself, it names the grant in the rule it returns.
 * `context` is the project level: given when the caller's records know their projects, absent
 * when they do not — and the project rules are then simply not in play. Its `reply` field is a
 * reply's own word that its record and thread were verified; only then is the reply rule asked.
 */
export function admitSend(
  caller: SendSide | 'owner',
  target: SendSide | 'owner',
  teams: AdmitTeams,
  grant?: SendGrant,
  context?: AdmitContext,
): SendVerdict {
  if (caller === 'owner') return { ok: true, rule: 'the owner' };
  // The owner as the receiver is admitted by the reply rule alone: a message to the owner is
  // delivered by the runtime, not by a seat's write into a folder, and this rule is the one
  // pair whose answer comes back on the thread it was asked on.
  if (target === 'owner') {
    if (context?.reply === 'open-thread') return { ok: true, rule: REPLY_RULE };
    return { ok: false, why: `${seatAt(caller)} may not send to the owner: no rule admits it (${summaryFor(context)})` };
  }

  const callerTeamId = teamOf(caller);
  const callerTeam = teams[callerTeamId];
  const targetTeamId = teamOf(target);
  const targetTeam = teams[targetTeamId];
  const targetOrchestrator = leadSeat(targetTeam);

  // The project rules, asked first when the caller's records know their projects: the project
  // record decides its own pairs, and the `leads` capability decides which seat leads a team.
  if (context !== undefined) {
    for (const [, project] of projectsNaming(callerTeamId, context.projects)) {
      if (!project.teams.includes(targetTeamId)) continue;
      // Membership is reach within one recorded entity, never a bridge to another entity.
      if (project.entity == null || project.entity !== callerTeam?.entity || project.entity !== targetTeam?.entity) continue;
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

  // Two leads write to each other: the pair that carries work between a team and the team above
  // it. The team's lead is the `leads` capability — the entity's own coordinator is the lead of
  // the team whose project is the entity, so this rule reaches it as any other team lead, which
  // is the entity's coordinator to every team lead of the entity. The pair is one team's, or two
  // teams of one entity; across entities it is refused, however the two seats are named.
  if (
    seatOf(caller) === leadSeat(callerTeam) && seatOf(target) === targetOrchestrator
    && leadsMayWrite(callerTeamId, targetTeamId, callerTeam, targetTeam, context)
  ) {
    return { ok: true, rule: 'an orchestrator to another orchestrator' };
  }
  // The team's own leads brief its seats: the orchestrator, or the operator, to any seat of the
  // same team. Never across teams: another team's seats are reached through its orchestrator.
  // Both are places in the file's chain — the seat the file declares as its lead or its operator —
  // never a role's word, which is each team's own, in any language.
  const leadsOwnTeam = seatOf(caller) === leadSeat(callerTeam) || seatOf(caller) === operatorSeat(callerTeam);
  if (callerTeam !== undefined && targetTeam === callerTeam && leadsOwnTeam) {
    return { ok: true, rule: 'an orchestrator or operator to a seat of its own team' };
  }
  // Two seats the file writes the role word `operator` on, in one team, write to each other: the
  // operators of a team coordinate, and neither sits in the file's operator place. It is the one
  // rule that reads a role's word — the owner asked for the word itself — and only for this pair:
  // the same word is no lead, no assistant and no other reach, and the pair never leaves the team,
  // so another team's operator is still reached through its orchestrator or a grant.
  if (callerTeam !== undefined && targetTeam === callerTeam && roleOf(caller, callerTeam) === OPERATOR_ROLE && roleOf(target, targetTeam) === OPERATOR_ROLE) {
    return { ok: true, rule: 'an operator to another operator of its own team' };
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
  // The entity's main orchestrator writes to any seat of the entity's teams: the lead of the team
  // whose project is the entity itself reaches every seat below it, one entity and no further.
  // The seat is the chain place `onMainCoordinator` reads — the `leads` capability on the head
  // team, never a role's word — and the reach is a setting: the same `seats_cross_teams` word the
  // lead pair reads, with its own default on and the project as the
  // only level that may reopen it.
  const entity = callerTeam?.entity ?? null;
  if (
    entity !== null && targetTeam?.entity === entity
    && onMainCoordinator(caller, entity, teams)
    && mainOrchestratorReaches(context?.crossTeams ?? {})
  ) {
    return { ok: true, rule: "the entity's main orchestrator to any seat of the entity's teams" };
  }
  // Any seat writes to its own team's orchestrator.
  if (callerTeam !== undefined && targetTeam === callerTeam && seatOf(target) === targetOrchestrator) {
    return { ok: true, rule: "a seat to its own team's orchestrator" };
  }
  if (grant !== undefined) return { ok: true, rule: `an owner-signed grant naming send (${grant.name})` };
  // Asked before the generic reply rule and instead of it: a seat answering the entity's main
  // orchestrator on the thread that orchestrator opened. The caller set the marker only after it
  // verified the answered record, its sender and the thread's opening record; the place and the
  // reach's setting are asked again here, and the marker is decisive — a marked reply whose
  // target does not hold the place, or whose reach the asker's chain closed, is refused rather
  // than handed to the generic rule. The reach is the same `seats_cross_teams` word the send
  // direction reads, with the same default on and the same project loosening level.
  if (context?.reply === 'main-orchestrator-thread') {
    if (!onMainCoordinator(target, entity, teams)) {
      return {
        ok: false,
        why: `${seatAt(caller)} may not reply to ${seatAt(target)}: ${MAIN_ORCHESTRATOR_REPLY_RULE}, and ${seatAt(target)} does not hold the entity's main orchestrator place`,
      };
    }
    if (!mainOrchestratorReaches(context.crossTeams ?? {})) {
      return {
        ok: false,
        why: `${seatAt(caller)} may not reply to ${seatAt(target)}: the entity's main orchestrator reach is closed by the asker's seats_cross_teams chain (${MAIN_ORCHESTRATOR_REPLY_RULE})`,
      };
    }
    return { ok: true, rule: MAIN_ORCHESTRATOR_REPLY_RULE };
  }
  // Asked last before the declared same-team rule: a reply to a record on an open thread, when
  // every rule above leaves the pair unadmitted. The caller has already verified the record and
  // the thread.
  if (context?.reply === 'open-thread') return { ok: true, rule: REPLY_RULE };
  // Any declared seat writes to any declared seat of its own team: the whole team coordinates
  // inside itself without relaying through the orchestrator, while a seat off the roster and
  // every cross-team pair stay refused unless an earlier rule, project setting, grant, or open
  // thread admitted them.
  if (
    callerTeam !== undefined && targetTeam === callerTeam
    && declaredInRoster(caller, callerTeam)
    && declaredInRoster(target, targetTeam)
  ) {
    return { ok: true, rule: DECLARED_SEAT_RULE };
  }

  return {
    ok: false,
    why: `${seatAt(caller)} may not send to ${seatAt(target)}: no rule admits it (${summaryFor(context)})`,
  };
}

/** Whether `side` sits in a seat that `team`'s roster declares. */
function declaredInRoster(side: SendSide, team: AdmitTeam): boolean {
  const seat = seatOf(side);
  return team.roster.some((entry) => entry.seat === seat);
}

/** The rules a refusal names, in the order they were asked: every rule above, and the one reply
 *  rule the context asked — the generic open-thread rule, or the bound answer to the entity's
 *  main orchestrator. A send's refusal names exactly the rules a send is judged by. */
function summaryFor(context: AdmitContext | undefined): string {
  const summary = context === undefined ? RULE_SUMMARY : `${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY}`;
  if (context?.reply === undefined) return summary;
  return `${summary}; ${context.reply === 'open-thread' ? REPLY_RULE : MAIN_ORCHESTRATOR_REPLY_RULE}`;
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
    if (!grantFromNames(grant.from, caller, teams, nowMs)) continue;
    if (!grantToNames(grant.to, target, caller, teams, nowMs)) continue;
    return { name: grant.name };
  }
  return undefined;
}

/**
 * The unverified record that would have admitted this pair, or undefined: the first unexpired
 * send-shaped record whose `from` and `to` name the pair as `sendGrantFor` reads them but whose
 * signature did not verify. `verified` records are skipped — a verified record that matches either
 * admitted the send before this is asked, or was refused by a rule the record cannot override.
 * The caller turns the answer into the refusal that names the record and the line that re-issues
 * it; nothing here reads a file or decides what an unverified record means beyond naming it.
 */
export function unverifiedGrantFor(
  caller: SendSide,
  target: SendSide,
  reads: SendGrantRead[],
  teams: AdmitTeams,
  now: Date,
): SendGrantRead | undefined {
  const nowMs = now.getTime();
  for (const grant of reads) {
    if (grant.state === 'verified') continue;
    const expMs = Date.parse(grant.expires);
    if (!Number.isFinite(expMs) || nowMs >= expMs) continue;
    if (!grantFromNames(grant.from, caller, teams, nowMs)) continue;
    if (!grantToNames(grant.to, target, caller, teams, nowMs)) continue;
    return grant;
  }
  return undefined;
}

/** Whether a grant's `from` names this caller: an agent id, `seat@team`, or `session/seat`. */
function grantFromNames(from: string, caller: SendSide, teams: AdmitTeams, nowMs: number): boolean {
  if (from.startsWith('agt_')) return 'reach' in caller && caller.id === from;
  const at = from.lastIndexOf('@');
  if (at > 0) {
    return seatOf(caller) === from.slice(0, at) && teamSpelled(teamOf(caller), from.slice(at + 1), teams, nowMs);
  }
  const slash = from.indexOf('/');
  if (slash > 0) {
    return 'reach' in caller && caller.reach.session === from.slice(0, slash) && seatOf(caller) === from.slice(slash + 1);
  }
  return false;
}

/** Whether a grant's `to` names this receiver: an agent id, `seat@team`, `session/seat`, a bare
 *  seat, which only the caller's own team makes unambiguous — or the reserved
 *  `orchestrator@<entity>`, the lead seat of a team of the sender's own entity. */
function grantToNames(to: string, target: SendSide, caller: SendSide, teams: AdmitTeams, nowMs: number): boolean {
  if (to.startsWith('agt_')) return 'reach' in target && target.id === to;
  const at = to.lastIndexOf('@');
  if (at > 0) {
    const seat = to.slice(0, at);
    const spelled = to.slice(at + 1);
    // The reserved receiver word binds to the sender's entity: the word is the entity's own lead
    // seat, read through `leadSeat` on the target's team, and it resolves only inside the entity
    // the caller's team names. Another entity, a team with no entity, and a non-lead target all
    // refuse — and the word never falls back to the older `seat@team` reading, so a record cannot
    // spell another entity's lead through it.
    if (seat === ORCHESTRATOR_RECEIVER) {
      const entity = teams[teamOf(caller)]?.entity ?? null;
      const targetTeam = teams[teamOf(target)];
      return entity !== null
        && spelled === entity
        && targetTeam?.entity === entity
        && seatOf(target) === leadSeat(targetTeam);
    }
    return seatOf(target) === seat && teamSpelled(teamOf(target), spelled, teams, nowMs);
  }
  const slash = to.indexOf('/');
  if (slash > 0) {
    return 'reach' in target && target.reach.session === to.slice(0, slash) && seatOf(target) === to.slice(slash + 1);
  }
  return seatOf(target) === to && teamOf(target) === teamOf(caller);
}

/**
 * Whether `spelled` names the team `id`: the record's own id, its project, its session, or an
 * unexpired `previousNames` entry while `TEAM_RENAME_GRACE` is not `'off'` and no registered team
 * currently holds `spelled` by id, project or session.
 */
function teamSpelled(id: string, spelled: string, teams: AdmitTeams, nowMs: number): boolean {
  if (id === spelled) return true;
  const team = teams[id];
  if (team === undefined) return false;
  if (team.project === spelled || team.session === spelled) return true;
  if (process.env.TEAM_RENAME_GRACE === 'off') return false;
  if (teams[spelled] !== undefined) return false;
  for (const other of Object.values(teams)) {
    if (other.project === spelled || other.session === spelled) return false;
  }
  return Boolean(
    team.previousNames?.some((entry) => {
      if (entry.name !== spelled) return false;
      const untilMs = Date.parse(entry.until);
      return Number.isFinite(untilMs) && untilMs > nowMs;
    }),
  );
}

/**
 * The line a message's body opens with: who wrote it, and the rule or grant that admitted the
 * write. The body follows one empty line under it, so a reader sees the sender before the message;
 * the signed record carries the same facts in its payload — the seat's name and the registry id —
 * which is what a reader verifies. The headline itself carries no id: it reads the project's
 * `sender_name` word (`src/send/names.ts`), so a person sees a nickname or `seat@team` where an
 * earlier build printed `agt_…`.
 */
export function senderHeader(caller: SendSide | 'owner' | 'watch' | 'daemon', rule: string, naming: SenderNaming = defaultNaming()): string {
  if (caller === 'owner') return `from the owner — admitted by: ${rule}\n`;
  // The watch's own direct-work principal: a non-seat sender, named by its reserved word so no
  // reader mistakes it for the owner or for the lead's seat.
  if (caller === 'watch') return `from the watch — admitted by: ${rule}\n`;
  // The daemon's reminder principal: a non-seat sender, named by its reserved word for the same
  // reason — no reader mistakes it for the owner, the lead's seat or the watch.
  if (caller === 'daemon') return `from the daemon — admitted by: ${rule}\n`;
  const readable = senderDisplayName(senderIdentityOf(caller), naming);
  // A declared seat: the id the receiver would judge by is the one the registry has not written
  // yet, so the header says whose seat it is instead of an id.
  if ('declared' in caller && caller.declared) {
    return `from the file's seat ${readable} (no registry record yet) — admitted by: ${rule}\n`;
  }
  return `from ${readable} — admitted by: ${rule}\n`;
}

/** A side as the naming rule reads it: the seat, the team, and the registry id when one is held. */
function senderIdentityOf(side: SendSide): SenderIdentity {
  return 'reach' in side
    ? { seat: side.reach.seat, team: side.reach.team, id: side.id }
    : { seat: side.seat, team: side.team };
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

/** The team's lead seat — the seat the rules above also call its orchestrator: the record's own
 *  field, which a live file's `orchestrator:` seat fills, else the seat holding the `leads`
 *  capability — the mark a file's `leads: true` writes on the lead's line. Null when the record
 *  says neither, and never a guess from a role's name: a role is each team's own word, in any
 *  language, so `orchestrator` and `coordinator` name nothing on their own. */
function leadSeat(team: AdmitTeam | undefined): string | null {
  if (!team) return null;
  if (team.orchestrator) return team.orchestrator;
  return team.roster.find((entry) => entry.leads === true)?.seat ?? null;
}

/** The team's operator seat: the file's declared `operator:` place, exactly as `leadSeat` reads
 *  the file's lead. A role word named `operator` is no place at all. */
function operatorSeat(team: AdmitTeam | undefined): string | null {
  return team?.operator ?? null;
}

/** The role word a side's own line carries in its team's roster: a side a command already placed
 *  carries its role as it stands; a registry record is named by its agent id first, and by its
 *  seat when the roster holds no line for the id, which is the file's own seat behind the store's.
 *  Null when the team or the line is not there — the word then decides nothing. */
function roleOf(side: SendSide, team: AdmitTeam | undefined): string | null {
  if (team === undefined) return null;
  if (!('reach' in side) && side.role !== undefined) return side.role;
  const id = idOf(side);
  if (id !== '') {
    const byId = team.roster.find((entry) => entry.agent === id);
    if (byId !== undefined) return byId.role;
  }
  return team.roster.find((entry) => entry.seat === seatOf(side))?.role ?? null;
}

/**
 * Whether two leads may write to each other. Within one team, always: that pair is the team's own
 * lead seat, and the own-team rules reach everything else. Across teams, only where both records
 * name the same entity — the record's `entity` field, written from the team file's `entity:` key:
 * it must be non-null and equal on both sides, so two teams that name no entity, or name
 * different ones, are not one entity's, and cross-entity stays refused however the two lead seats
 * are named. The asker's own chain may close the crossing through the `seats_cross_teams` word;
 * with no word it stands, since this reach is the entity's own and the project setting's default,
 * off, does not close it.
 */
function leadsMayWrite(
  callerTeamId: string,
  targetTeamId: string,
  callerTeam: AdmitTeam | undefined,
  targetTeam: AdmitTeam | undefined,
  context: AdmitContext | undefined,
): boolean {
  if (callerTeam === undefined || targetTeam === undefined) return false;
  if (callerTeamId === targetTeamId) return true;
  const entity = callerTeam.entity;
  if (entity === null || entity === undefined || entity !== targetTeam.entity) return false;
  return leadsAcrossTeams(context?.crossTeams ?? {});
}

/**
 * The leadership reach at the entity's edge, over the asker's own chain: open unless a level
 * closes it. It is the same `seats_cross_teams` word the project setting and the main
 * orchestrator's reach read, with this reach's own default — a lead pair of one entity is what
 * carries work between a team and the team above it, so it stands until the seat's own chain says
 * otherwise. Closing is legal at every level; the project may open it again, as the setting
 * itself allows.
 */
const LEADS_ACROSS_TEAMS: SettingSpec = {
  name: 'seats_cross_teams',
  policy: 'seats-cross-teams',
  fallback: true,
  looseningLevels: ['project'],
};

function leadsAcrossTeams(declared: Partial<Record<SettingLevel, boolean | undefined>>): boolean {
  return resolveSetting(LEADS_ACROSS_TEAMS, declarationsOf(declared)).value;
}

/**
 * The main orchestrator's reach over the entity's teams: the same `seats_cross_teams` word the
 * lead pair reads, with this reach's own default — on, so the entity's
 * main orchestrator reaches any seat of the entity's teams — and the same
 * project loosening level. A word at any level of the asker's chain that closes it closes this
 * reach; only the project may reopen what an entity closed.
 */
const MAIN_ORCHESTRATOR_REACH: SettingSpec = {
  name: 'seats_cross_teams',
  policy: 'seats-cross-teams',
  fallback: true,
  looseningLevels: ['project'],
};

function mainOrchestratorReaches(declared: Partial<Record<SettingLevel, boolean | undefined>>): boolean {
  return resolveSetting(MAIN_ORCHESTRATOR_REACH, declarationsOf(declared)).value;
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

/** All registered memberships of a team, in project-id order, over the derived records
 *  admission was handed. Home inheritance is resolved separately by the caller. */
function projectsNaming(teamId: string, projects: AdmitProjects): [string, AdmitProject][] {
  return Object.keys(projects)
    .sort()
    .flatMap((id) => {
      const project = projects[id];
      return project !== undefined && project.teams.includes(teamId) ? [[id, project] as [string, AdmitProject]] : [];
    });
}

/** True when the target is the coordinator of `entity`: the lead seat of the entity's own team,
 *  the one whose project is the entity itself. */
function onMainCoordinator(target: SendSide, entity: string | null | undefined, teams: AdmitTeams): boolean {
  if (!entity) return false;
  for (const id of Object.keys(teams).sort()) {
    const team = teams[id];
    if (!team || team.entity !== entity || team.project !== entity) continue;
    if (teamOf(target) === id && seatOf(target) === leadSeat(team)) return true;
  }
  return false;
}

/** How a refusal and the header name a side: its seat in its team. */
function seatAt(side: SendSide): string {
  return `${seatOf(side)}@${teamOf(side)}`;
}

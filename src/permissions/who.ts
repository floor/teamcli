// The bridge: a walked caller (src/caller.ts) read as the resolver's record
// (src/permissions/resolve.ts). The walk says WHERE an ask came from — the owner at a terminal,
// a seat in a pane, a pane without an agent, a placement that failed — and the resolver decides
// WHAT that caller may do, from records. This module is the one place the two meet: it answers
// "who is this, as a record?" and hands the question to the resolver, so every gate wired to
// the map asks it the same way and a later gate cannot spell the caller differently.
//
// The seat's identity is the registry's roster line: the agent id a seat grant names, the seat
// and role the registry holds. The team a seat belongs to is the team at the root the command
// is about — a roster of this team that does not list the caller stands for no seat, and a
// caller with no record is refused (the resolver's own rule). Where the registry holds NO
// record of this team at all — a team the owner has not registered, which is how every team
// starts life — the file's own declaration stands: the live file is then the record of who its
// seats are, its `leads` mark decides `leads`, and the record carries no agent id,
// so no grant can name it and no seat-record row admits it. A registry that cannot be read is
// not a team the registry holds no record of: it fails closed, and a seat is refused with
// "the registry cannot be read" rather than judged from the file.
//
// The loader and the loader's reads are not here: this module reads the registry's roster and
// the grant store's active set, decides, and returns. The owner, a seat, or null — never a
// pane: an agentless pane and an unplaced run are callers the walk placed, and the map's rows
// admit no one through them.
import {
  anotherPaneRefusal,
  callerVerdict,
  describeCaller,
  detachedRefusal,
  mayChangeTeamVerdict,
  mayPauseTeamVerdict,
  noPaneRefusal,
  type Caller,
  type CallerVerdict,
  type SeatStanding,
} from '../caller.ts';
import { readTeams, teamIdOf, type RosterEntry } from '../registry/teams.ts';
import { activeGrants } from './grants.ts';
import { COMMAND_GATES, type Gate } from './map.ts';
import { resolvePermission, type CallerRecord, type PermissionDecision } from './resolve.ts';

/** What the bridge reads of the team file: the lead's resolved name (its `leads` mark or the
 *  `coordinator:` key — `readLeadField`'s answer), the operator's seat name, and the declared
 *  seats, for the fallback where the registry holds no record of the team, and for the
 *  `team-change` rows, whose verdict function judges the operator too. */
export type BridgeTeam = {
  id: string;
  orchestrator: string;
  operator: string;
  seats: readonly { name: string; role: string }[];
};

/** What the registry's read answered, and the three answers are different rules: the team's
 *  roster (`listed`), no record of that team at all (`unregistered` — the file's declaration
 *  stands for it), and a registry that cannot be read (`unreadable` — refused closed, never
 *  read as `unregistered`). An empty listed roster is a record that knows no seat, not an
 *  absent one. */
export type RosterRead =
  | { kind: 'listed'; roster: readonly RosterEntry[] }
  | { kind: 'unregistered' }
  | { kind: 'unreadable'; why: string };

/** The registry's roster for the team at `root`, or the reason there is none. A read that
 *  throws — a corrupt `teams.yaml`, one that cannot be read — is `unreadable`, never
 *  `unregistered`: a corrupt registry must not fail open to the team file. */
export function rosterOf(home: string, root: string): RosterRead {
  let record: ReturnType<typeof readTeams>[string] | undefined;
  try {
    record = readTeams(home)[teamIdOf(root)];
  } catch (error) {
    return { kind: 'unreadable', why: error instanceof Error ? error.message : String(error) };
  }
  return record === undefined ? { kind: 'unregistered' } : { kind: 'listed', roster: record.roster };
}

/** The roster the caller record may read: the listed one, or null where the registry holds no
 *  record of the team. `unreadable` is not null — the callers of this helper have refused
 *  before they reach it, and a fall-through reads no file. */
function rosterList(read: RosterRead): readonly RosterEntry[] | null {
  return read.kind === 'listed' ? read.roster : null;
}

/**
 * The caller as a record. The owner is the owner. A seat is a record only where one stands:
 * the roster line the registry holds for this team, or — where the registry holds no record
 * of the team — the file's own declaration. `leads` is the file's resolved lead, or the
 * roster's own mark where a later sync wrote one; the role's name is recorded and never
 * decides, and the bundle is empty in 0.5.0, where the file declares no per-role capabilities
 * and capabilities come only from grants. The file's declaration is not a registry record: it
 * carries `agent: ''`, so no grant can name it and the resolver's `seat-record` rows refuse it
 * — it judges the file's own `leads` rows and comms admission alone. Everything else — a
 * no-terminal owner, a pane, an unplaced run, a seat the record does not know — is null: a
 * caller with no record.
 */
export function callerRecordOf(
  caller: Caller,
  team: BridgeTeam,
  roster: readonly RosterEntry[] | null,
): CallerRecord | null {
  if (caller.kind === 'owner') return { kind: 'owner' };
  if (caller.kind !== 'seat') return null;
  const listed = roster?.find((line) => line.seat === caller.name) ?? null;
  if (roster !== null) {
    // The registry holds this team, so its roster is the record: a seat it does not list has
    // none, whatever the file declares.
    if (listed === null) return null;
    return {
      kind: 'seat',
      agent: listed.agent,
      seat: caller.name,
      team: team.id,
      role: listed.role,
      bundle: [],
      leads: listed.leads === true || caller.name === team.orchestrator,
    };
  }
  const declared = team.seats.find((seat) => seat.name === caller.name);
  if (declared === undefined) return null;
  return {
    kind: 'seat',
    // No registry identity stands, so no grant can name this seat: a seat grant names an agent.
    agent: '',
    seat: caller.name,
    team: team.id,
    role: declared.role,
    bundle: [],
    leads: caller.name === team.orchestrator,
  };
}

/** The map's decision for a walked caller at one command's gate: the bridge, the fresh read of
 *  the active grants (`activeGrants(home, now)` — revoked and expired left out), and the pure
 *  resolver. `root` is the team's root: the roster and the team id are read from it, and it is
 *  the target a capability row's grant scope is read against. `at` is the placement proof: the
 *  session judged and the seat's live, ready record there. A seat a registry that cannot be
 *  read would have to establish is refused closed, never judged from the file; a seat the map
 *  admits must then be placed on its recorded pane, in the session judged, and ready — a
 *  refusal lands as `unplaced` (or `unreadable`) and never as an allow.
 *
 *  Three kinds are decided by the module's own function before the records are read, because a
 *  record cannot see what the function judges: a row carrying `terminal` asks `detachedRefusal`
 *  with the row's route, a `team-change` row asks `mayChangeTeamVerdict` with the walked
 *  caller and the standing, and a `team-pause` row asks `mayPauseTeamVerdict` — the owner or
 *  the orchestrator's seat, never the operator. A `team-read` row is the read gate's
 *  (`mayReadTeam`), which needs
 *  the loaded team and the delegate evidence this record-only path does not hold: the resolver
 *  refuses it closed under `team-read`, and only the command's own read gate admits. */
export function resolveCaller(
  caller: Caller,
  team: BridgeTeam,
  root: string,
  home: string,
  command: string,
  at: SeatStanding,
  now: Date = new Date(),
): PermissionDecision {
  const gate = COMMAND_GATES[command];
  // A row carrying `terminal` is refused here by the module's own `detachedRefusal`, with the
  // module's own route: a record cannot say where the caller runs, so the bridge decides this
  // requirement before the resolver is asked — never as a copy of the sentence.
  if (gate !== undefined && gate.terminal !== undefined) {
    const detached = detachedRefusal(caller, gate.terminal);
    if (detached !== undefined) return { effect: 'deny', rule: 'terminal', why: detached };
  }
  // A `team-change` row is `mayChangeTeamVerdict`'s: the owner, the orchestrator's seat or the
  // operator's seat, judged from the walk and the standing. The function is called itself, with
  // the walked caller; a registry record alone cannot say where the caller stands.
  if (gate !== undefined && gate.kind === 'team-change') {
    return changeDecision(caller, command, gate, mayChangeTeamVerdict(caller, team, at));
  }
  // A `team-pause` row is `mayPauseTeamVerdict`'s: the owner, or the team's orchestrator on its
  // own seat. Called itself, as `pause` and `resume` call it.
  if (gate !== undefined && gate.kind === 'team-pause') {
    return pauseDecision(caller, command, gate, mayPauseTeamVerdict(caller, team, at));
  }
  const roster = rosterOf(home, root);
  if (roster.kind === 'unreadable' && caller.kind === 'seat') {
    return {
      effect: 'deny',
      rule: 'unreadable',
      why: `the registry cannot be read (${roster.why}): no seat is judged from the file where the registry that would record it cannot be read`,
    };
  }
  const record = callerRecordOf(caller, team, rosterList(roster));
  // A row carrying `terminal` reached this line only because the module's `detachedRefusal`
  // answered undefined for this caller: that answer is the proof the record cannot carry.
  const proof = gate !== undefined && gate.terminal !== undefined ? { terminal: true as const } : {};
  const decision = resolvePermission(record, { id: team.id }, command, activeGrants(home, now), { root }, proof);
  if (decision.effect !== 'allow' || record === null || record.kind !== 'seat') return decision;
  return placed(decision, caller, record.seat, at);
}

/** An allowed seat's decision, held to its placement: the caller is the seat its record names,
 *  in the session judged, on the pane the state records for it. A refused name or session, a
 *  missing pane and another pane each deny under `unplaced`, naming the repair where one
 *  exists. The launch stage is the launcher's business, not the gate's: a seat the state
 *  records `launched` is still that seat. */
function placed(
  decision: PermissionDecision,
  caller: Caller,
  seat: string,
  at: SeatStanding,
): PermissionDecision {
  const verdict = callerVerdict(caller, seat, at);
  if (verdict.kind === 'no-pane') return { effect: 'deny', rule: 'unplaced', why: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') {
    return { effect: 'deny', rule: 'unplaced', why: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  }
  if (verdict.kind !== 'ok') {
    return {
      effect: 'deny',
      rule: 'unplaced',
      why: `the caller is not placed as ${seat} in session ${at.session}: a seat acts where its own placement records it, never by its name alone`,
    };
  }
  return decision;
}

/** A `mayChangeTeamVerdict` answer read as the resolver's decision: `ok` allows under
 *  `team-change`, and each refusal keeps the verdict's own words — the lost pane's repair, or
 *  the rule's sentence naming the three callers it admits. */
function changeDecision(caller: Caller, command: string, gate: Gate, verdict: CallerVerdict): PermissionDecision {
  if (verdict.kind === 'ok') {
    return {
      effect: 'allow',
      rule: 'team-change',
      why: `${describeCaller(caller)} may change the team on \`${command}\`: ${gate.why}`,
    };
  }
  if (verdict.kind === 'no-pane') return { effect: 'deny', rule: 'unplaced', why: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') {
    return { effect: 'deny', rule: 'unplaced', why: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  }
  return {
    effect: 'deny',
    rule: 'team-change',
    why: `\`${command}\` is decided by \`mayChangeTeamVerdict\`: ${describeCaller(caller)} is neither the owner, the orchestrator's seat nor the operator's seat — ${gate.why}`,
  };
}

/**
 * A `mayPauseTeamVerdict` answer read as the resolver's decision: `ok` allows under
 * `team-pause`, and each refusal keeps the verdict's own words — the lost pane's repair, or the
 * rule's sentence naming the two callers it admits (the operator is not one of them).
 */
function pauseDecision(caller: Caller, command: string, gate: Gate, verdict: CallerVerdict): PermissionDecision {
  if (verdict.kind === 'ok') {
    return {
      effect: 'allow',
      rule: 'team-pause',
      why: `${describeCaller(caller)} may pause or resume the team on \`${command}\`: ${gate.why}`,
    };
  }
  if (verdict.kind === 'no-pane') return { effect: 'deny', rule: 'unplaced', why: noPaneRefusal(verdict.name) };
  if (verdict.kind === 'another-pane') {
    return { effect: 'deny', rule: 'unplaced', why: anotherPaneRefusal(verdict.name, verdict.recordedPane) };
  }
  return {
    effect: 'deny',
    rule: 'team-pause',
    why: `\`${command}\` is decided by \`mayPauseTeamVerdict\`: ${describeCaller(caller)} is neither the owner nor the orchestrator's seat — ${gate.why}`,
  };
}

/**
 * The same decision, in the shape the commands that change a team already branch on
 * (`CallerVerdict`): `ok` where the map admits the caller, `refused` where it does not, and —
 * for a seat the map admits — the standing's own verdict, so a lead on a pane the state does
 * not record for it is still refused with the repair (`no-pane`, `another-pane`). The map is
 * the record's judge; the standing is the placement's proof, and an admitted seat passes both.
 * A caller the map refuses is `refused` whatever pane it sits on: the refusal is the rule's,
 * and the commands say the rule's sentence.
 *
 * `now` is read only where the row reads grants: a gate row (owner-only, owner-or-leads,
 * owner-or-own-team, seat-record, team-change) decides from the record alone or from the walk,
 * so it opens no grant folder and takes no clock reading it never uses — a command's other
 * readings stay where they were. A `team-change` or `team-pause` row never reaches the
 * records at all: the verdict function itself is the answer, with the standing judged. A row
 * carrying `terminal` refuses a no-terminal run through `detachedRefusal` before anything else.
 *
 * The placement is mandatory: `at` carries the session judged and the seat's record there, and
 * an admitted seat that is not on its recorded pane in that session is refused before any
 * command branches on it. A registry that cannot be read refuses every seat for the
 * same reason the resolver does: closed, never the file's declaration.
 */
export function gateVerdict(
  caller: Caller,
  team: { orchestrator: string; operator: string; seats: readonly { name: string; role: string }[] },
  root: string,
  home: string,
  command: string,
  at: SeatStanding,
  now: () => Date = () => new Date(),
): CallerVerdict {
  const gate = COMMAND_GATES[command];
  // The module's own detached refusal, before any record is read: a row carrying `terminal`
  // refuses a run with no terminal exactly as its command does.
  if (gate !== undefined && gate.terminal !== undefined && detachedRefusal(caller, gate.terminal) !== undefined) {
    return { kind: 'refused' };
  }
  // A `team-change` row is the verdict function itself, called with the walked caller and the
  // standing judged: the owner, the orchestrator's seat or the operator's seat.
  if (gate !== undefined && gate.kind === 'team-change') return mayChangeTeamVerdict(caller, team, at);
  // A `team-pause` row is the pause verdict itself: the owner, or the team's orchestrator on its
  // own seat; the operator is refused by the function, not by a copy of its rule.
  if (gate !== undefined && gate.kind === 'team-pause') return mayPauseTeamVerdict(caller, team, at);
  const bridge: BridgeTeam = { id: teamIdOf(root), orchestrator: team.orchestrator, operator: team.operator, seats: team.seats };
  const roster = rosterOf(home, root);
  if (roster.kind === 'unreadable' && caller.kind === 'seat') return { kind: 'refused' };
  const record = callerRecordOf(caller, bridge, rosterList(roster));
  const grants = COMMAND_GATES[command]?.kind === 'capability' ? activeGrants(home, now()) : [];
  // The terminal requirement, where the row carries one, was checked above with the module's
  // `detachedRefusal`; that answer is the proof the records path cannot carry.
  const proof = gate !== undefined && gate.terminal !== undefined ? { terminal: true as const } : {};
  const decision = resolvePermission(record, { id: bridge.id }, command, grants, { root }, proof);
  if (decision.effect === 'deny') return { kind: 'refused' };
  if (record !== null && record.kind === 'owner') return { kind: 'ok' };
  // A seat the map admits: the pane proof is the standing's, and the seat must sit where the
  // state records it — in the session judged, on its recorded pane. The verdict is the walk's
  // own (`callerVerdict`), so the gate and the commands read a seat the same way; a caller
  // recorded `launched` is still the seat. A seat with no record or another pane is refused.
  return callerVerdict(caller, (record as { seat: string }).seat, at);
}

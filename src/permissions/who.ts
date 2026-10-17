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
// starts life — the file's own declaration stands: the owner-approved file is then the record
// of who its seats are, its `leads` mark decides `leads`, and the record carries no agent id,
// so no grant can name it. A registry that cannot be read stands for no team either, exactly
// as an unreadable state records no pane: a caller check must never become a stack trace.
//
// The loader and the loader's reads are not here: this module reads the registry's roster and
// the grant store's active set, decides, and returns. The owner, a seat, or null — never a
// pane: an agentless pane and an unplaced run are callers the walk placed, and the map's rows
// admit no one through them.
import { callerVerdict, type Caller, type CallerVerdict, type SeatStanding } from '../caller.ts';
import { readTeams, teamIdOf, type RosterEntry } from '../registry/teams.ts';
import { activeGrants } from './grants.ts';
import { COMMAND_GATES } from './map.ts';
import { resolvePermission, type CallerRecord, type PermissionDecision } from './resolve.ts';

/** What the bridge reads of the team file: the lead's resolved name (its `leads` mark or the
 *  `coordinator:` key — `readLeadField`'s answer) and the declared seats, for the fallback
 *  where the registry holds no record of the team. */
export type BridgeTeam = {
  id: string;
  orchestrator: string;
  seats: readonly { name: string; role: string }[];
};

/** The roster the registry holds for the team at `root`, or null where it holds no record of
 *  that team at all — a team never registered, and a registry that cannot be read. An empty
 *  roster is not null: the record exists and lists no seat, which is a record that knows no
 *  seat, not an absent one. */
export function rosterOf(home: string, root: string): RosterEntry[] | null {
  try {
    return readTeams(home)[teamIdOf(root)]?.roster ?? null;
  } catch {
    return null;
  }
}

/**
 * The caller as a record. The owner is the owner. A seat is a record only where one stands:
 * the roster line the registry holds for this team, or — where the registry holds no record
 * of the team — the file's own declaration. `leads` is the file's resolved lead, or the
 * roster's own mark where a later sync wrote one; the role's name is recorded and never
 * decides, and the bundle is empty in 0.5.0, where the file declares no per-role capabilities
 * and capabilities come only from grants. Everything else — a no-terminal owner, a pane, an
 * unplaced run, a seat the record does not know — is null: a caller with no record.
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
 *  resolver. `root` is the team's root: the roster and the team id are read from it. */
export function resolveCaller(
  caller: Caller,
  team: BridgeTeam,
  root: string,
  home: string,
  command: string,
  now: Date = new Date(),
): PermissionDecision {
  const record = callerRecordOf(caller, team, rosterOf(home, root));
  return resolvePermission(record, { id: team.id }, command, activeGrants(home, now));
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
 * owner-or-own-team, seat-record) decides from the record alone, so it opens no grant folder
 * and takes no clock reading it never uses — a command's other readings stay where they were.
 */
export function gateVerdict(
  caller: Caller,
  team: { orchestrator: string; seats: readonly { name: string; role: string }[] },
  root: string,
  home: string,
  command: string,
  at?: SeatStanding,
  now: () => Date = () => new Date(),
): CallerVerdict {
  const bridge: BridgeTeam = { id: teamIdOf(root), orchestrator: team.orchestrator, seats: team.seats };
  const record = callerRecordOf(caller, bridge, rosterOf(home, root));
  const grants = COMMAND_GATES[command]?.kind === 'capability' ? activeGrants(home, now()) : [];
  const decision = resolvePermission(record, { id: bridge.id }, command, grants);
  if (decision.effect === 'deny') return { kind: 'refused' };
  if (record !== null && record.kind === 'owner') return { kind: 'ok' };
  // A seat the map admits: the pane proof is the standing's, and the seat must be where the
  // state records it — the same judgement every admitted seat met before the map.
  return callerVerdict(caller, (record as { seat: string }).seat, at);
}

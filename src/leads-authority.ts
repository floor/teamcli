// The default authority of a team's own lead and operator. With `leads.authority` at
// `own-team` (the release default), a placed lead and a placed operator run every command for
// that team with no owner prompt, no card and no terminal ask. `owner-asks` restores today's
// owner gates. The proof is the target team's own file and the pane its state records: a lead
// of another team proves nothing. Dev mode is a separate switch and is not read here.
//
// The exclusion list is the one place a command stays the owner's. The orchestrator seat
// itself stays the owner's, and `team forget` of the lead's own team stays the owner's.
// Abandon is the owner's on every door: `remove --abandon` and `down --abandon`, the two
// rows the reserved table names. The operator seat stays the lead's.

import { dirname } from 'node:path';
import { callerOf, callerVerdict, logTag, standingOf, type Caller, type SeatStanding } from './caller.ts';
import { readTeamConfig } from './file/team-config.ts';
import type { TeamFile } from './file/types.ts';
import type { Io } from './io.ts';
import { logLine } from './log.ts';
import { OWNER_RESERVED_GATES } from './dev_mode.ts';
import { loadAndResolvePolicyChain } from './policy/sources.ts';
import { getPolicySpec, type LeadsAuthorityValue } from './policy/types.ts';

/** Commands that stay the owner's. Everything else is the team's under `own-team`. */
export const LEADS_AUTHORITY_EXCLUDED: ReadonlySet<string> = new Set([
  // Grant, in every form, and the revocation and delegation that issue or withdraw authority.
  'grant',
  'delegate',
  'revoke',
  'revoke:delegate',
  'revoke:grant',
  'approvals:revoke',
  'client',
  'client:general-grant',
  // The owner's identity and keys: the charter, the owner seat, and the machine switch.
  'setup',
  'owner-seat:setup',
  'development-mode',
  'development-mode:set',
  // The credential store, and the owner's machine.
  'broker',
  'daemon',
  'daemon:run',
  'daemon:install',
  'daemon:restart',
  'daemon:fault-watch',
  'daemon:uninstall',
  'daemon:chores',
  // Erasing the team's own record. There is no other team this proof can reach.
  'forget',
  // The first admission of an account has no team to be the lead of.
  'start',
  // Migrate writes a team's first authority record, the same class as start.
  // The owner-seat door says `import` for this act. Both names stay excluded.
  'migrate',
  // Recording a served project (`also_in`) is not a command. `noteTeam` publishes those
  // memberships only when the run is the owner's: a seat's sync names them and they stay.
]);

/** The owner-seat door's name for an act the map already excludes. The two spellings are one
 *  act: a door name that is not excluded admits what the map keeps the owner's. */
export const LEADS_DOOR_COMMANDS: Readonly<Record<string, string>> = {
  approvals: 'approvals:revoke',
  import: 'migrate',
  // `team up` is the start act the exclusion list names. The door says `up`.
  up: 'start',
};

/** The reserved table's abandon rows. A placed lead is not admitted to either. */
const LEADS_ABANDON_GATES = OWNER_RESERVED_GATES.filter(
  (row) => row.gate === 'abandon-seat' || row.gate === 'abandon-team',
);

/** The reserved table's abandon gate for this command, when the line carries `--abandon`. */
export function abandonGateOf(command: string, abandon: boolean): string | undefined {
  if (!abandon) return undefined;
  return LEADS_ABANDON_GATES.find((row) => row.command === command)?.gate;
}

export function leadsCommandExcluded(command: string, gate?: string): boolean {
  if (LEADS_AUTHORITY_EXCLUDED.has(command)) return true;
  const mapped = LEADS_DOOR_COMMANDS[command];
  if (mapped !== undefined && LEADS_AUTHORITY_EXCLUDED.has(mapped)) return true;
  return gate !== undefined && LEADS_ABANDON_GATES.some((row) => row.command === command && row.gate === gate);
}

/** Whether setting this policy key changes who may act, so only the owner may set it.
 *  The catalogue marks the authority keys, and also the keys that open the owner's machine:
 *  `dev-mode` and `development-mode` (the switch and its scope, aliases included), and
 *  `daemon.broker` (the broker reads the credential store), `daemon.chores` and
 *  `daemon.heartbeat` (both reach the one machine daemon every team shares). */
export function policyNeedsOwner(name: string): boolean {
  return getPolicySpec(name)?.needsOwner === true;
}

/** A policy write the default rule may admit: this team's own record, or a seat that record
 *  declares. Entity and project reach other teams, so they stay on the owner's path. */
export function policyWriteOwnTeam(
  rawLevel: string,
  seatFlag: string | undefined,
  team: { seats: readonly { name: string }[] } | null,
): boolean {
  if (rawLevel === 'team') return true;
  const seatName = rawLevel.startsWith('seat:')
    ? rawLevel.slice('seat:'.length).trim()
    : rawLevel === 'seat'
      ? (seatFlag?.trim() ?? '')
      : null;
  if (seatName === null || seatName === '') return false;
  return team !== null && team.seats.some((seat) => seat.name === seatName);
}

/** The orchestrator seat is the owner's to change. The operator seat is the lead's. */
export function orchestratorSeatStaysOwner(team: { orchestrator: string }, name: string): boolean {
  return name === team.orchestrator;
}

/** The effective word. An unreadable chain fails closed to `owner-asks`. An unset key is `own-team`. */
export function leadsAuthorityOf(home: string, root: string, now: Date, team?: TeamFile): LeadsAuthorityValue {
  try {
    const chain = loadAndResolvePolicyChain({ home, teamRoot: root, ...(team !== undefined ? { team } : {}) }, { now });
    if (!chain.ok) return 'owner-asks';
    return chain.policies['leads.authority']?.value === 'owner-asks' ? 'owner-asks' : 'own-team';
  } catch {
    return 'owner-asks';
  }
}

/** The role this caller holds on the target team, placed on the pane that team's state records. */
export function placedOwnTeamRole(
  caller: Caller,
  team: { orchestrator: string; operator: string },
  at: SeatStanding,
): 'lead' | 'operator' | null {
  if (caller.kind !== 'seat') return null;
  const role = caller.name === team.orchestrator ? 'lead' : caller.name === team.operator ? 'operator' : null;
  if (role === null) return null;
  return callerVerdict(caller, caller.name, at).kind === 'ok' ? role : null;
}

export type LeadsAdmission = { role: 'lead' | 'operator'; warning: string };

/** Whether the default rule admits this caller to this command. `dir` writes the audit line. */
export function leadsOwnTeamAdmits(options: {
  caller: Caller;
  team: { orchestrator: string; operator: string };
  at: SeatStanding;
  home: string;
  root: string;
  command: string;
  /** Set on an abandon. Those two reserved rows stay the owner's. */
  gate?: string;
  now: Date;
  dir?: string;
  teamFile?: TeamFile;
}): LeadsAdmission | null {
  if (leadsCommandExcluded(options.command, options.gate)) return null;
  if (leadsAuthorityOf(options.home, options.root, options.now, options.teamFile) !== 'own-team') return null;
  const role = placedOwnTeamRole(options.caller, options.team, options.at);
  if (role === null) return null;
  const warning = `warning: owner gate; admitted as ${role}`;
  if (options.dir !== undefined) logLine(options.dir, options.command, logTag(options.caller), warning, options.now);
  return { role, warning };
}

/** The same admission for a command that has the team file at `io.cwd`. */
export function leadsOwnTeamAtCwd(
  io: Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>,
  options: { command: string; home: string; now: Date },
): LeadsAdmission | null {
  let loaded: ReturnType<typeof readTeamConfig>;
  try {
    loaded = readTeamConfig(io.cwd, { home: options.home });
  } catch {
    return null;
  }
  if (!loaded.ok) return null;
  const dir = dirname(loaded.path);
  const caller = callerOf(io, loaded.team.session);
  return leadsOwnTeamAdmits({
    caller,
    team: loaded.team,
    teamFile: loaded.team,
    at: standingOf(dir, loaded.team.session, caller),
    home: options.home,
    root: loaded.root,
    command: options.command,
    now: options.now,
    dir,
  });
}

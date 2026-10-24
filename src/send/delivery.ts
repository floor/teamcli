// The production reading of a delivery order: the receiving seat's chain — entity, project,
// team, seat — as the records on this machine declare it. Every level's word may be the signed
// `delivery-order` policy its record holds: the entity's in `entities.yaml`, the project's in
// `projects.yaml`, the team's in the file's `policies:`. A legacy unsigned word is read where
// its level holds no signed record — the team file's own `delivery_order` at the top level or
// on a seat, and the registry project record's `delivery_order` — and a signed record shadows
// the legacy word at its level: expired or unreadable, it leaves the level silent rather than
// reviving what it replaced. A seat that declares no word of its own takes the one its shape
// implies: a human's pane walks the drop file alone, and a CLI whose launch installs no watcher
// never walks the drop leg at all. A seat's signed settings, when the caller has read them, say
// `delivery_order` and `human` in the file's place. runSend resolves `host.delivery` when a
// caller hands a chain in — tests do — and this reading otherwise.
import type { SeatOverrides } from '../config/apply.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { cliWatcher } from '../launch/cli-hook.ts';
import type { PolicySourceRead } from '../policy/resolve.ts';
import { readEntityPolicySource, readProjectPolicySource, readTeamPolicySource } from '../policy/sources.ts';
import { getPolicySpec, normalizePolicyName, type Policy } from '../policy/types.ts';
import type { ProjectRecord } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import type { DeliveryLeg, SettingLevel } from '../settings/inherit.ts';

/** A chain as the levels that declare an order; a level left out declares nothing. */
export type DeliveryChain = Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>;

/**
 * Reads the chain the receiving seat's files declare. `file` is the receiving team's validated
 * file when the caller already holds it; otherwise the file at `root` is loaded, tolerantly — a
 * file this reader cannot load declares nothing and the default order stands, because the order
 * says how a message travels, never whether it may, and a send must not fail on it.
 *
 * Each level's word is the signed `delivery-order` policy its record holds, and the level's
 * legacy unsigned word fills in only where no signed record is held. The project's word is
 * asked of the registry record for the project the team sits in: its `id` names the project
 * policy's target and its `delivery_order` is the legacy word. A registry that cannot answer —
 * a file that does not read, or a team two projects name — is read as no word rather than
 * failing the send, the same way a team file that cannot be loaded is. A signed word that is
 * expired, or a value the catalogue cannot read, leaves its level silent. The seat's word is
 * the signed settings' or the file's; when neither gives one, the seat's shape supplies one — a
 * human's drop-only order, and a watcherless CLI's order without the drop leg.
 */
export function deliveryChainOf(input: {
  /** The receiving team's root. */
  root: string;
  /** The receiving seat's name, as the team file spells it. */
  seat: string;
  /** The home the team file and the registry read from. */
  home: string;
  /** The receiving team's validated file, when the caller already holds it. */
  file?: TeamFile;
  /** The registry's answer for the project a team sits in, or null. */
  projectOfTeam: (teamId: string) => ProjectRecord | null;
  /** The seat's signed settings, when the caller already read them. A signed `delivery_order`
   *  is the seat's word in place of the file's, and a signed `human` is the caller's walk rule;
   *  the file's own words still fill what the records do not set. */
  overrides?: SeatOverrides;
  /** The instant an expiry is judged at; the wall clock when none is given. */
  now?: Date;
}): DeliveryChain {
  const now = input.now ?? new Date();
  let file = input.file;
  if (!file) {
    try {
      const loaded = readTeamConfig(input.root, { home: input.home });
      if (loaded.ok) file = loaded.team;
    } catch {
      // A file that cannot even be read declares nothing, as one that does not validate does.
    }
  }
  const entity = signedOrderOf(readEntityPolicySource(input.home, file?.entity ?? null), now) ?? undefined;
  let project: readonly DeliveryLeg[] | undefined;
  let projectId: string | null = null;
  try {
    const record = input.projectOfTeam(teamIdOf(input.root));
    projectId = record?.id ?? null;
    project = record?.deliveryOrder;
  } catch {
    project = undefined;
  }
  const projectPolicy = signedOrderOf(readProjectPolicySource(input.home, projectId), now);
  if (projectPolicy !== undefined) project = projectPolicy ?? undefined;
  // The team source carries the file's legacy word itself when no signed record is held; the
  // fallback covers a source that cannot be read, where the validated file's word still stands.
  const teamPolicy = file ? signedOrderOf(readTeamPolicySource(input.home, input.root, file), now) : undefined;
  const team = teamPolicy !== undefined ? (teamPolicy ?? undefined) : (file?.deliveryOrder ?? undefined);
  const found: Seat | undefined = file?.seats.find((one) => one.name === input.seat);
  const seat = input.overrides?.deliveryOrder ?? found?.deliveryOrder ?? seatDefault(found);
  return {
    ...(entity !== undefined ? { entity } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(team !== undefined ? { team } : {}),
    ...(seat !== undefined ? { seat } : {}),
  };
}

/**
 * One level's signed `delivery-order` word. `undefined` means the level holds no signed record —
 * the legacy word, when it has one, still applies. `null` means it holds one but no word stands:
 * every declaration it holds is expired or a value the catalogue cannot read, so the level is
 * silent and the legacy word it shadows does not come back.
 */
function signedOrderOf(source: PolicySourceRead | null, now: Date): readonly DeliveryLeg[] | null | undefined {
  if (source === null || !source.ok) return undefined;
  const spec = getPolicySpec('delivery-order');
  let held = false;
  let word: readonly DeliveryLeg[] | undefined;
  for (const policy of source.policies) {
    if (normalizePolicyName(policy.name) !== 'delivery-order') continue;
    // The readers inject a legacy unsigned word beside the signed ones; only a signed record
    // shadows it, and only a signed record is read here.
    if (!isSignedPolicy(policy)) continue;
    held = true;
    if (expiredPolicy(policy, now)) continue;
    const parsed = spec?.parseValue(policy.value) as readonly DeliveryLeg[] | null | undefined;
    if (parsed) word = parsed;
  }
  if (!held) return undefined;
  return word ?? null;
}

/** A policy record that was signed, as opposed to a legacy word injected by a source reader. */
function isSignedPolicy(policy: Policy): boolean {
  return policy.setter !== null || policy.signature !== undefined;
}

/** An expired declaration counts as unset at its level, as it does in the policy chain. */
function expiredPolicy(policy: Policy, now: Date): boolean {
  if (!policy.expiry) return false;
  const at = Date.parse(policy.expiry);
  return Number.isFinite(at) && at <= now.getTime();
}

/**
 * The word a seat's own shape puts when the file declares none: a human's pane walks the drop
 * file alone, whatever the default; and a CLI whose launch installs no watcher can never take a
 * drop, so the drop leg is left out of its order — the launch's plan says which CLI watches
 * nothing and why. A seat with a watcher, and one no profile answers for, declare nothing and
 * take the default order. A word the file does declare is the seat's, never replaced here.
 */
function seatDefault(seat: Seat | undefined): readonly DeliveryLeg[] | undefined {
  if (seat === undefined) return undefined;
  if (seat.human === true) return ['drop'];
  if (cliWatcher(seat.cli, seat.launch) === 'none') return ['mcp-inbox', 'typed'];
  return undefined;
}

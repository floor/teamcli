// The production reading of a delivery order: the receiving seat's chain — entity, project,
// team, seat — as the records on this machine declare it. Every level's word may be the signed
// `delivery-order` policy its record holds: the entity's in `entities.yaml`, the project's in
// `projects.yaml`, the team's in the file's `policies:`. A legacy unsigned word is read where
// its level holds no signed record — the team file's own `delivery_order` at the top level or
// on a seat, and the registry project record's `delivery_order` — and a signed record shadows
// the legacy word at its level: expired, or a value the catalogue cannot read, it leaves the
// level silent rather than reviving what it replaced. The project level is not silent when its
// record cannot be read at all: the project's word can only narrow the order, so a reader that
// fell through to the fallback could widen the legs a send travels. The chain refuses there
// (`DeliveryChainUnreadable`) and the caller says so in its own words.
// A seat that declares no word of its own takes the one its shape implies: a human's pane walks
// the drop file alone, and a CLI whose launch installs no watcher never walks the drop leg at
// all. A seat's signed settings, when the caller has read them, say `delivery_order` and `human`
// in the file's place. runSend resolves `host.delivery` when a caller hands a chain in — tests
// do — and this reading otherwise.
import type { SeatOverrides } from '../config/apply.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { cliWatcher } from '../launch/cli-hook.ts';
import type { PolicySourceRead } from '../policy/resolve.ts';
import { readEntityPolicySource, readProjectPolicySource, readTeamPolicySource } from '../policy/sources.ts';
import { getPolicySpec, normalizePolicyName, type Policy } from '../policy/types.ts';
import type { ProjectRecord } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { liveOrderWords, type DeliveryLeg, type OrderWord, type SettingLevel } from '../settings/inherit.ts';
import { deliveryOrder } from '../settings/resolve.ts';

/**
 * A chain as the levels that declare an order; a level left out declares nothing. What a level
 * holds is live legs only: the retired `mcp-inbox` alias is dropped before the chain is built
 * (`liveWordOf`). A level whose word held only that name is `drop`, the mailbox, so the seat's
 * shape cannot fill the gap with a typed wake. An empty word is still left out. The word an
 * older build wrote still reads in the files; the chain never carries the retired name.
 */
export type DeliveryChain = Partial<Record<SettingLevel, readonly OrderWord[] | undefined>>;

/** Chains whose deciding word began with the retired inbox name. The chain object carries only
 *  live legs; this map is the only place that fact survives the drop. */
const inboxLedChains = new WeakMap<DeliveryChain, true>();

/** Whether the word that decides this chain began with `mcp-inbox`. A host-supplied chain is
 *  unmarked: a caller that left the alias on the words reads it there. */
export function deliveryInboxLed(chain: DeliveryChain): boolean {
  return inboxLedChains.has(chain);
}

/** One level's word with the retired alias names dropped. A word that is only the retired name
 *  is `drop`, so the level is a mailbox and not an absent word the shape would replace with a
 *  typed wake. `undefined` when the word is absent. */
function liveWordOf(words: readonly OrderWord[] | null | undefined): readonly DeliveryLeg[] | undefined {
  if (words === undefined || words === null) return undefined;
  const legs = liveOrderWords(words);
  if (legs.length > 0) return legs;
  return words.length > 0 ? ['drop'] : undefined;
}

/** True when a raw delivery word's first name is the retired inbox alias. */
function rawInboxLed(words: readonly string[] | null | undefined): boolean {
  return rawInboxLedValue(words);
}

/** True when a stored policy value's first name is the retired inbox alias. */
function rawInboxLedValue(raw: unknown): boolean {
  if (typeof raw === 'string') return raw.split(',')[0]?.trim() === 'mcp-inbox';
  return Array.isArray(raw) && raw.length > 0 && raw[0] === 'mcp-inbox';
}

/** Whether the signed delivery-order word in force began with the retired inbox name. A silent
 *  or absent record is false: the legacy word, when it still applies, is judged on its own. */
function signedRawInboxLed(source: PolicySourceRead | null, now: Date): boolean {
  if (source === null || !source.ok) return false;
  const spec = getPolicySpec('delivery-order');
  let led = false;
  let saw = false;
  for (const policy of source.policies) {
    if (normalizePolicyName(policy.name) !== 'delivery-order') continue;
    if (!isSignedPolicy(policy)) continue;
    if (expiredPolicy(policy, now)) continue;
    const parsed = spec?.parseValue(policy.value) as readonly DeliveryLeg[] | null | undefined;
    if ((parsed && parsed.length > 0) || (Array.isArray(parsed) && parsed.length === 0)) {
      saw = true;
      led = rawInboxLedValue(policy.value);
    }
  }
  return saw && led;
}

/**
 * A project registry or project policy record this reader cannot read. A project's word can
 * only narrow the order — a drop-only project is the shape — so reading an unreadable record as
 * no word would let the fallback behind it name legs the project keeps out. `deliveryChainOf`
 * throws this instead of widening, and every caller refuses the send or reports it in words of
 * its own. The message is the plain reason.
 */
export class DeliveryChainUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryChainUnreadable';
  }
}

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
 * a file that does not read, or a team two projects name — and a project policy record that
 * exists and does not read throw `DeliveryChainUnreadable`: unlike the team file, whose loss
 * only leaves the default standing, the project's word can only narrow, and its loss would
 * widen the legs a send may travel. A signed word that is expired, or a value the catalogue
 * cannot read, leaves its level silent. The seat's word is the signed settings' or the file's;
 * when neither gives one, the seat's shape supplies one — a human's drop-only order, and a
 * watcherless CLI's order without the drop leg.
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
  const entitySource = readEntityPolicySource(input.home, file?.entity ?? null);
  const entityPolicy = signedOrderOf(entitySource, now);
  const entity = entityPolicy ?? undefined;
  const entityInbox = entity !== undefined && signedRawInboxLed(entitySource, now);
  // The project's word keeps any retired name it still carries; the resolver drops it.
  let project: readonly OrderWord[] | undefined;
  let projectInbox = false;
  let projectId: string | null = null;
  try {
    const record = input.projectOfTeam(teamIdOf(input.root));
    projectId = record?.id ?? null;
    project = liveWordOf(record?.deliveryOrder);
    projectInbox = project !== undefined && rawInboxLed(record?.deliveryOrder);
  } catch (error) {
    // The project's word can only narrow. A registry that cannot name the team's project — an
    // unreadable or corrupt file, or a team two projects name — leaves a bound this reader
    // cannot see, and the default behind it may travel where the project forbids. Refuse.
    throw new DeliveryChainUnreadable(
      `the project registry cannot name this team's project: ${(error as Error).message}`,
    );
  }
  const projectSource = readProjectPolicySource(input.home, projectId);
  if (!projectSource.ok && projectId !== null) {
    // The record names a project whose own delivery-order policies do not read; the legacy word
    // the registry carries is not what the signed record would have said. Refuse for the same
    // reason: no level here may widen on a record that exists and cannot be read.
    throw new DeliveryChainUnreadable(`the project's delivery-order record cannot be read: ${projectSource.why}`);
  }
  const projectPolicy = signedOrderOf(projectSource, now);
  if (projectPolicy !== undefined) {
    project = projectPolicy ?? undefined;
    projectInbox = project !== undefined && signedRawInboxLed(projectSource, now);
  }
  // The team source carries the file's legacy word itself when no signed record is held; the
  // fallback covers a source that cannot be read, where the validated file's word still stands.
  const teamSource = file ? readTeamPolicySource(input.home, input.root, file) : null;
  const teamPolicy = file ? signedOrderOf(teamSource, now) : undefined;
  const team = teamPolicy !== undefined ? (teamPolicy ?? undefined) : liveWordOf(file?.deliveryOrder);
  const teamInbox = teamPolicy !== undefined
    ? team !== undefined && signedRawInboxLed(teamSource, now)
    : team !== undefined && rawInboxLed(file?.deliveryOrder);
  const found: Seat | undefined = file?.seats.find((one) => one.name === input.seat);
  const wider: DeliveryChain = {
    ...(entity !== undefined ? { entity } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(team !== undefined ? { team } : {}),
  };
  const overrideWords = input.overrides?.deliveryOrder;
  const fileWords = found?.deliveryOrder;
  const overrideLive = liveWordOf(overrideWords);
  const seatWord = overrideLive ?? liveWordOf(fileWords);
  const seatRaw = overrideLive !== undefined ? overrideWords : fileWords;
  const seat = seatWord ?? seatDefault(found, wider);
  // The innermost word that actually decides the order. A shape-supplied seat word is not one:
  // the wider level's raw word is what the seat declared.
  const inboxLed = seatWord !== undefined
    ? rawInboxLed(seatRaw)
    : team !== undefined
      ? teamInbox
      : project !== undefined
        ? projectInbox
        : entityInbox;
  const chain: DeliveryChain = { ...wider, ...(seat !== undefined ? { seat } : {}) };
  if (inboxLed) inboxLedChains.set(chain, true);
  return chain;
}

/**
 * One level's signed `delivery-order` word. `undefined` means the level holds no signed record —
 * the legacy word, when it has one, still applies. `null` means it holds one but no word stands:
 * every declaration it holds is expired or a value the catalogue cannot read, so the level is
 * silent and the legacy word it shadows does not come back. A word whose every name is the
 * retired alias is `drop`: the record still shadows the legacy word, and the walk does not type.
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
    // An alias-only signed word is the mailbox. The record still shadows the level's legacy
    // word, and the walk is drop rather than the typed fallback.
    if (parsed && parsed.length > 0) word = parsed;
    else if (Array.isArray(parsed) && parsed.length === 0) word = ['drop'];
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
 * The watcherless shape is read off the chain the wider levels resolve, less the drop leg: the
 * shape says only that this seat reads no drop file, never that a channel leg a word declares is
 * unreachable. Under the default (`typed`, `drop`) the shape is `typed` alone; a team word such
 * as `[socket, typed]` keeps its socket. A word that is only the retired `mcp-inbox` name is
 * already `drop` before this shape is asked (`liveWordOf`), so the shape never types for it.
 */
function seatDefault(seat: Seat | undefined, wider: DeliveryChain): readonly DeliveryLeg[] | undefined {
  if (seat === undefined) return undefined;
  if (seat.human === true) return ['drop'];
  if (cliWatcher(seat.cli, seat.launch) === 'none') {
    return deliveryOrder(wider).filter((leg) => leg !== 'drop');
  }
  return undefined;
}

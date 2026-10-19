// The production reading of a delivery order: the receiving seat's chain — entity, project,
// team, seat — as the files on this machine declare it. The team's own word (`delivery_order`
// at the top level) and the seat's (the same key on a seat) live in the team file; the
// project's is the registry record's `delivery_order`; no record in this build carries an
// entity's word, so that level is always silent here. A seat that declares no word of its own
// takes the one its shape implies: a human's pane walks the drop file alone, and a CLI whose
// launch installs no watcher never walks the drop leg at all. A seat's signed settings, when the
// caller has read them, say `delivery_order` and `human` in the file's place. runSend resolves
// `host.delivery` when a caller hands a chain in — tests do — and this reading otherwise.
import type { SeatOverrides } from '../config/apply.ts';
import { loadTeamFile } from '../file/load.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { cliWatcher } from '../launch/cli-hook.ts';
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
 * The project's word is the registry's record for the project the team sits in, asked through
 * `ofTeam`. A registry that cannot answer — a file that does not read, or a team two projects
 * name — is read as no word rather than failing the send, the same way a team file that cannot
 * be loaded is. The entity level is silent: no record in this build carries an entity's order.
 * The seat's word is the file's; when the file gives none, the seat's shape supplies one — a
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
}): DeliveryChain {
  let file = input.file;
  if (!file) {
    try {
      const loaded = loadTeamFile(input.root, { home: input.home });
      if (loaded.ok) file = loaded.team;
    } catch {
      // A file that cannot even be read declares nothing, as one that does not validate does.
    }
  }
  let project: readonly DeliveryLeg[] | undefined;
  try {
    project = input.projectOfTeam(teamIdOf(input.root))?.deliveryOrder;
  } catch {
    project = undefined;
  }
  const found: Seat | undefined = file?.seats.find((one) => one.name === input.seat);
  const seat = input.overrides?.deliveryOrder ?? found?.deliveryOrder ?? seatDefault(found);
  return {
    ...(project !== undefined ? { project } : {}),
    ...(file?.deliveryOrder ? { team: file.deliveryOrder } : {}),
    ...(seat !== undefined ? { seat } : {}),
  };
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

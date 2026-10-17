// The production reading of a delivery order: the receiving seat's chain — entity, project,
// team, seat — as the files on this machine declare it. The team's own word (`delivery_order`
// at the top level) and the seat's (the same key on a seat) live in the team file; the
// project's is the registry record's `delivery_order`; no record in this build carries an
// entity's word, so that level is always silent here. runSend resolves `host.delivery` when a
// caller hands a chain in — tests do — and this reading otherwise.
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
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
  const seat = file?.seats.find((one) => one.name === input.seat)?.deliveryOrder;
  return {
    ...(project !== undefined ? { project } : {}),
    ...(file?.deliveryOrder ? { team: file.deliveryOrder } : {}),
    ...(seat !== undefined ? { seat } : {}),
  };
}

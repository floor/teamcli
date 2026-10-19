// The runtime reading of a seat's at-once settings: what the next send, admission or name lookup
// sees. The keys are the same signed chain `team settings` prints, resolved nearest first; this
// reading takes only the three a runtime consumer acts on.
//
// A chain that does not verify declares nothing here. Routing decides how a message travels,
// never whether it may, and a send must not fail on a broken record; the read commands answer a
// damaged source loudly, and `team check` names it. A caller that needs the loud answer reads
// `readSeatSettings` instead.

import { teamIdOf } from '../registry/teams.ts';
import type { DeliveryLeg } from '../settings/inherit.ts';
import { agentIdOf } from './read.ts';
import { readConfigSources, resolveConfigChain } from './sources.ts';

/** The signed words a runtime consumer takes from a seat's chain; absent means the chain holds
 *  no such record and the caller keeps reading the source it read before. */
export type SeatOverrides = {
  nickname?: string;
  deliveryOrder?: readonly DeliveryLeg[];
  human?: boolean;
};

/**
 * The at-once settings the signed records hold for one seat, nearest level first. `home` is the
 * registry that holds the records; null reads none of them, as a null home reads the team file
 * alone elsewhere. A seat with no agent record has no signed settings: bootstrap declarations
 * live in the team file and are read by the callers that already read it.
 */
export function seatOverridesOf(input: { home: string | null; root: string; seat: string }): SeatOverrides {
  if (input.home === null) return {};
  try {
    const found = agentIdOf(input.home, input.root, input.seat);
    if (found.agentId === null) return {};
    const chain = resolveConfigChain(readConfigSources({
      home: input.home,
      entity: found.entity,
      projectId: found.projectId,
      teamId: teamIdOf(input.root),
      agentId: found.agentId,
      seatName: input.seat,
    }));
    if (!chain.ok) return {};
    const overrides: SeatOverrides = {};
    for (const setting of chain.settings) {
      if (setting.key === 'nickname' && typeof setting.value === 'string') overrides.nickname = setting.value;
      if (setting.key === 'human' && typeof setting.value === 'boolean') overrides.human = setting.value;
      if (setting.key === 'delivery_order' && Array.isArray(setting.value)) {
        overrides.deliveryOrder = [...(setting.value as readonly DeliveryLeg[])];
      }
    }
    return overrides;
  } catch {
    // An unreadable registry or record declares nothing to a runtime consumer; the read
    // commands and `team check` are where a damaged source is reported.
    return {};
  }
}

// The runtime reading of a seat's at-once settings: what the next send, admission or name lookup
// sees. The keys are the same signed chain `team settings` prints, resolved nearest first; this
// reading takes only the three a runtime consumer acts on.
//
// Two readings of the same chain. `resolveSeatOverrides` / `resolveSeatSettings` hand an acting
// caller the chain's answer whole: verified words, or the reasons a source could not be read or
// verified, so a send refuses a tampered record instead of routing on the declaration. An absent
// record is not a failure: the declaration stands and `ok` carries no overrides. `seatOverridesOf`
// / `seatSettingsOf` are the display reading — a chain that does not verify declares nothing — for
// listings and headers that may degrade with a truthful name; they are never the reading an
// acting caller takes.

import { teamIdOf } from '../registry/teams.ts';
import type { DeliveryLeg } from '../settings/inherit.ts';
import { agentIdOf } from './read.ts';
import { readConfigSources, resolveConfigChain, type ConfigChainResult } from './sources.ts';

/** The signed words a runtime consumer takes from a seat's chain; absent means the chain holds
 *  no such record and the caller keeps reading the source it read before. */
export type SeatOverrides = {
  nickname?: string;
  deliveryOrder?: readonly DeliveryLeg[];
  human?: boolean;
};

/** The chain's answer for a seat: the verified at-once words, or why a source was not readable. */
export type SeatOverridesReading =
  | { ok: true; overrides: SeatOverrides }
  | { ok: false; why: string };

/** The three words a verified chain holds, and nothing else. */
function overridesOf(chain: Extract<ConfigChainResult, { ok: true }>): SeatOverrides {
  const overrides: SeatOverrides = {};
  for (const setting of chain.settings) {
    if (setting.key === 'nickname' && typeof setting.value === 'string') overrides.nickname = setting.value;
    if (setting.key === 'human' && typeof setting.value === 'boolean') overrides.human = setting.value;
    if (setting.key === 'delivery_order' && Array.isArray(setting.value)) {
      overrides.deliveryOrder = [...(setting.value as readonly DeliveryLeg[])];
    }
  }
  return overrides;
}

/** The reasons a chain did not verify, as one sentence an acting caller can print: every refused
 *  level, its target, and the file and failure the reader already named. */
function refusalsOf(chain: Extract<ConfigChainResult, { ok: false }>): string {
  return chain.refusals
    .map((refusal) => `${refusal.level}${refusal.target === null ? '' : ` ${refusal.target}`}: ${refusal.why}`)
    .join('; ');
}

/**
 * The at-once settings the signed records hold for one seat, nearest level first, when the caller
 * already knows the agent — read as an acting caller reads it. `home` is the registry that holds
 * the records. The caller supplies the team, entity and project whose records the chain reads; a
 * caller that has the roster line at hand passes them all, so no lookup repeats. A source that
 * exists and does not verify is a refusal naming it; a seat that signs nothing is `ok` with no
 * words, because the declaration stands where a record is absent.
 */
export function resolveSeatSettings(input: {
  home: string;
  root: string;
  agentId: string;
  seat: string;
  teamId?: string;
  entity?: string | null;
  projectId?: string | null;
}): SeatOverridesReading {
  try {
    const chain = resolveConfigChain(readConfigSources({
      home: input.home,
      entity: input.entity ?? null,
      projectId: input.projectId ?? null,
      teamId: input.teamId ?? teamIdOf(input.root),
      agentId: input.agentId,
      seatName: input.seat,
    }));
    if (!chain.ok) return { ok: false, why: refusalsOf(chain) };
    return { ok: true, overrides: overridesOf(chain) };
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
}

/**
 * The same reading when the caller knows the seat's name and not its agent id: the roster
 * resolves the id first. A seat with no agent record signs nothing, so a send falls back to the
 * declaration; a registry that cannot be read is a refusal, never an absent record.
 */
export function resolveSeatOverrides(input: { home: string | null; root: string; seat: string }): SeatOverridesReading {
  if (input.home === null) return { ok: true, overrides: {} };
  try {
    const found = agentIdOf(input.home, input.root, input.seat);
    if (found.agentId === null) return { ok: true, overrides: {} };
    return resolveSeatSettings({
      home: input.home,
      root: input.root,
      agentId: found.agentId,
      seat: input.seat,
      entity: found.entity,
      projectId: found.projectId,
    });
  } catch (error) {
    return { ok: false, why: (error as Error).message };
  }
}

/** The display reading: a chain that does not verify declares nothing here. Never use for a
 *  decision that routes a message; `resolveSeatSettings` is that reading. */
export function seatSettingsOf(input: {
  home: string;
  root: string;
  agentId: string;
  seat: string;
  teamId?: string;
  entity?: string | null;
  projectId?: string | null;
}): SeatOverrides {
  const read = resolveSeatSettings(input);
  return read.ok ? read.overrides : {};
}

/** The display reading by seat name; see `seatSettingsOf`. */
export function seatOverridesOf(input: { home: string | null; root: string; seat: string }): SeatOverrides {
  const read = resolveSeatOverrides(input);
  return read.ok ? read.overrides : {};
}

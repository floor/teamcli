// One seat's settings as the read verbs print them: the signed records the chain resolver
// verifies at each level (OD-20261018-08), folded with the team file's own words by the
// composition. A record that does not verify refuses the read and names its file; nothing is
// guessed from a broken source.
//
// The seat's registry entry is found through the team record's roster when the team is
// registered, and through the agent registry otherwise. An `undefined` home is the caller's own;
// a `null` home reads no record at all — the team file alone, as the 0.5.0 read did.

import { homedir } from 'node:os';
import { findAgent } from '../registry/agents.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import type { DeliveryLeg } from '../settings/inherit.ts';
import {
  composeSeatConfig,
  type ConfigRecordValue,
  type ConfigRecordValues,
  type ConfigRow,
  type ConfigSeatInput,
} from './compose.ts';
import type { ConfigLevel } from './registry.ts';
import { readConfigSources, resolveConfigChain, type ConfigChainInput } from './sources.ts';

/** One source that does not verify, in the words a refusal prints. */
export type SeatSettingsRefusal = { level: ConfigLevel; target: string | null; why: string };

export type SeatSettingsRead =
  | { ok: true; rows: ConfigRow[] }
  | { ok: false; refusals: readonly SeatSettingsRefusal[] };

export type SeatSettingsInput = {
  /** The home whose registry holds the signed records. Defaults to the caller's home; pass null
   *  to read the team file alone. */
  home?: string | null;
  root: string;
  /** The team's own name (the file's `project:`), which a seat's registry entry carries. */
  project: string;
  seat: ConfigSeatInput & { name: string };
  teamDeliveryOrder: readonly DeliveryLeg[] | null;
};

/** The agent id the team record's roster gives the seat, or the registry's newest agent of that
 *  team and seat; null when neither knows one. */
function agentIdOf(home: string, root: string, project: string, seatName: string): { agentId: string | null; entity: string | null; projectId: string | null } {
  let entity: string | null = null;
  let projectId: string | null = null;
  try {
    const record = getTeam(home, teamIdOf(root));
    if (record !== null) {
      entity = record.entity;
      projectId = record.projectId;
      const line = record.roster.find((entry) => entry.seat === seatName);
      if (line !== undefined) return { agentId: line.agent, entity, projectId };
    }
  } catch {
    // A registry this build cannot read declares no entity, project or roster here; `team check`
    // refuses it. The agent registry below is still consulted.
  }
  const agent = findAgent(home, { team: project, seat: seatName });
  return { agentId: agent?.id ?? null, entity, projectId };
}

export function readSeatSettings(input: SeatSettingsInput): SeatSettingsRead {
  const home = input.home === undefined ? homedir() : input.home;
  if (home === null) {
    return { ok: true, rows: composeSeatConfig(input.seat, input.teamDeliveryOrder) };
  }
  const { agentId, entity, projectId } = agentIdOf(home, input.root, input.project, input.seat.name);
  const chainInput: ConfigChainInput = { home, entity, projectId, teamId: teamIdOf(input.root), agentId, seatName: input.seat.name };
  const sources = readConfigSources(chainInput);
  const chain = resolveConfigChain(sources);
  if (!chain.ok) return { ok: false, refusals: chain.refusals };
  const records: ConfigRecordValues = {};
  for (const setting of chain.settings) {
    const record: ConfigRecordValue = { level: setting.level, value: setting.value };
    const source = sources[setting.level]?.source;
    if (source !== undefined) record.sourceFile = source;
    records[setting.key] = record;
  }
  return { ok: true, rows: composeSeatConfig(input.seat, input.teamDeliveryOrder, records) };
}

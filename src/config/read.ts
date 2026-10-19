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
import { ofTeam } from '../registry/projects.ts';
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
  /** The loaded declaration's `entity:`, when it names one. It is the entity a team file
   *  declares, which a registry that names no entity must not hide: the entity source is still
   *  read, and one that does not verify refuses the read instead of being skipped. */
  entity?: string | null;
};

/** The agent id the team record's roster gives the seat, or the registry's newest agent of that
 *  team and seat; null when neither knows one. The team is named by its stable ID, which is what
 *  an agent record's `reach.team` carries. A roster line names the agent, but it is not the whole
 *  context: the team record can carry a roster and still name no entity or project, and the
 *  project registry is then the declaration the signed sources need. */
export function agentIdOf(home: string, root: string, seatName: string): { agentId: string | null; entity: string | null; projectId: string | null } {
  const teamId = teamIdOf(root);
  let entity: string | null = null;
  let projectId: string | null = null;
  let rosterAgentId: string | null = null;
  try {
    const record = getTeam(home, teamId);
    if (record !== null) {
      entity = record.entity;
      projectId = record.projectId;
      const line = record.roster.find((entry) => entry.seat === seatName);
      if (line !== undefined) rosterAgentId = line.agent;
    }
  } catch {
    // A registry this build cannot read declares no entity, project or roster here; `team check`
    // refuses it. The project and agent registries below are still consulted.
  }
  // The team record can be absent or carry no entity/project while the project registry still
  // names the team. The project record is the declaration then; without it the entity and
  // project signed settings would be skipped and a seat would read as if they said nothing.
  if (entity === null || projectId === null) {
    try {
      const member = ofTeam(home, teamId);
      if (member !== null) {
        if (projectId === null) projectId = member.id ?? null;
        if (entity === null) entity = member.entity;
      }
    } catch {
      // A project registry this build cannot read (or one naming the team twice) declares no
      // single project here; `team check` refuses it.
    }
  }
  // The roster is the team record's own word for this seat, so it wins over the registry's
  // newest agent once the project context has been resolved around it.
  if (rosterAgentId !== null) return { agentId: rosterAgentId, entity, projectId };
  // The agent registry knows an agent by the stable team ID, never by the team's own name.
  const agent = findAgent(home, { team: teamId, seat: seatName });
  return { agentId: agent?.id ?? null, entity, projectId };
}

export function readSeatSettings(input: SeatSettingsInput): SeatSettingsRead {
  const home = input.home === undefined ? homedir() : input.home;
  if (home === null) {
    return { ok: true, rows: composeSeatConfig(input.seat, input.teamDeliveryOrder) };
  }
  const { agentId, entity, projectId } = agentIdOf(home, input.root, input.seat.name);
  // The declaration's own entity wins: a registry that names none must not turn the entity
  // source off, because an entity record that does not verify then refuses the read instead of
  // disappearing from it.
  const resolvedEntity = input.entity ?? entity;
  const chainInput: ConfigChainInput = { home, entity: resolvedEntity, projectId, teamId: teamIdOf(input.root), agentId, seatName: input.seat.name };
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

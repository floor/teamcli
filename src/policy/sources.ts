// Kernel amendment 02 §2.12 & Runtime draft 1 chapter J (commitment 27):
// One signed source per level:
// - entity:  `<home>/.config/team/entities.yaml` under `<entity>.policies`
// - project: `<home>/.config/team/projects.yaml` under `<projectId>.policies`
// - team:    `<teamRoot>/.agents/team.yaml` owner `policies:` section
// - seat:    `<home>/.config/team/agents/<agentId>.yaml` under `policies` (and seat entry)
//
// STEP 1 stub implementation: returns empty verified policy lists so builder-4 (Part B) and
// builder-5 (Part C) can build against the stable signatures while Part A fills in the signed
// YAML/record readers and writers.

import { homedir } from 'node:os';
import type { Seat, TeamFile } from '../file/types.ts';
import {
  resolvePolicyChain,
  type PolicyChainResult,
  type PolicyChainSources,
  type PolicySourceRead,
  type ResolvePolicyOptions,
} from './resolve.ts';

export type PolicyChainInput = {
  home?: string;
  entity?: string | null;
  projectId?: string | null;
  teamRoot?: string | null;
  team?: TeamFile | null;
  agentId?: string | null;
  seat?: Seat | null;
};

/**
 * Reads the entity-level policies for `entity` from `<home>/.config/team/entities.yaml`.
 * An absent file or absent entity entry declares no policies; an unreadable or invalidly signed
 * file returns `{ ok: false, level: 'entity', why }`.
 */
export function readEntityPolicySource(_home: string = homedir(), entity: string | null = null): PolicySourceRead {
  return { ok: true, level: 'entity', target: entity, policies: [] };
}

/**
 * Reads the project-level policies for `projectId` from `<home>/.config/team/projects.yaml`.
 * An absent file or absent project entry declares no policies; an unreadable or invalidly signed
 * record returns `{ ok: false, level: 'project', why }`.
 */
export function readProjectPolicySource(_home: string = homedir(), projectId: string | null = null): PolicySourceRead {
  return { ok: true, level: 'project', target: projectId, policies: [] };
}

/**
 * Reads the team-level owner `policies:` section from `<teamRoot>/.agents/team.yaml` (or the
 * pre-loaded `team` object). An unreadable or invalidly signed section returns
 * `{ ok: false, level: 'team', why }`.
 */
export function readTeamPolicySource(
  _home: string = homedir(),
  teamRoot: string | null = null,
  _team: TeamFile | null = null,
): PolicySourceRead {
  return { ok: true, level: 'team', target: teamRoot, policies: [] };
}

/**
 * Reads the seat-level policies for `agentId` / `seat` from `<home>/.config/team/agents/<id>.yaml`
 * and the seat's inline declarations.
 */
export function readSeatPolicySource(
  _home: string = homedir(),
  agentId: string | null = null,
  seat: Seat | null = null,
): PolicySourceRead {
  return { ok: true, level: 'seat', target: agentId ?? seat?.name ?? null, policies: [] };
}

/**
 * Reads all four policy sources (`entity`, `project`, `team`, `seat`) for a given chain context.
 */
export function readPolicyChain(input: PolicyChainInput = {}): PolicyChainSources {
  const home = input.home ?? homedir();
  return {
    entity: readEntityPolicySource(home, input.entity ?? input.team?.entity ?? null),
    project: readProjectPolicySource(home, input.projectId ?? null),
    team: readTeamPolicySource(home, input.teamRoot ?? null, input.team ?? null),
    seat: readSeatPolicySource(home, input.agentId ?? null, input.seat ?? null),
  };
}

/**
 * Convenience entry point for gates and `team policy`: reads the four sources fresh and resolves
 * the chain outermost-first (`entity → project → team → seat`).
 */
export function loadAndResolvePolicyChain(
  input: PolicyChainInput = {},
  options: ResolvePolicyOptions = {},
): PolicyChainResult {
  return resolvePolicyChain(readPolicyChain(input), options);
}

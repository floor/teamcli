import type { TeamFile } from '../file/types.ts';
import { readPolicyChain } from '../policy/sources.ts';
import { getPolicySpec, POLICY_LEVELS } from '../policy/types.ts';
import type { Agent } from '../registry/agents.ts';
import { get as getProject } from '../registry/projects.ts';
import { getTeam } from '../registry/teams.ts';
import type { SettingLevel } from '../settings/inherit.ts';

export type CrossTeamsChain = Partial<Record<SettingLevel, boolean | undefined>>;

/** Verified declarations, rather than one effective value: the existing admission rules use
 * different defaults for ordinary seats and entity leads. Only the asker's home contributes.
 * No target or served team's file is read, and the reader writes nothing. */
export function crossTeamsFor(
  home: string,
  team: TeamFile,
  fileTeamId: string,
  asker: Agent,
  now: Date,
): { ok: true; declared: CrossTeamsChain } | { ok: false; why: string } {
  const record = getTeam(home, asker.reach.team);
  if (asker.reach.team !== fileTeamId) {
    return { ok: false, why: 'the asker has no matching home-chain team record' };
  }
  const project = record?.projectId ? getProject(home, record.projectId) : null;
  const entity = record?.entity ?? team.entity;
  if (project && (project.entity === null || project.entity !== entity)) {
    return { ok: false, why: 'the asker home project belongs to another entity' };
  }
  const sources = readPolicyChain({
    home,
    entity,
    projectId: project?.id ?? null,
    teamRoot: record?.root ?? null,
    // The command already loaded its own file. Explicit emptiness prevents the source reader
    // from following a registry root to any other team's file when no policies were declared.
    team: { ...team, policies: team.policies ?? {} },
    agentId: asker.id,
    seat: team.seats.find(s => s.name === asker.reach.seat) ?? null,
  });
  const declared: CrossTeamsChain = {};
  const spec = getPolicySpec('seats-cross-teams')!;
  for (const level of POLICY_LEVELS) {
    const source = sources[level];
    if (!source) return { ok: false, why: `the ${level} crossing policy source is absent` };
    if (!source.ok) return { ok: false, why: source.why };
    for (const policy of source.policies) {
      if (policy.name !== 'seats-cross-teams') continue;
      if (policy.expiry !== null && policy.expiry !== undefined) {
        const expiry = Date.parse(policy.expiry);
        if (!Number.isFinite(expiry)) return { ok: false, why: 'the crossing policy has an invalid expiry' };
        if (expiry <= now.getTime()) continue;
      }
      const value = spec.parseValue(policy.value);
      if (!policy.signature || policy.setter !== 'owner' || policy.kind !== spec.kind || (value !== 'on' && value !== 'off')) {
        return { ok: false, why: 'the crossing policy is not a signed boolean declaration' };
      }
      declared[level] = value === 'on';
    }
  }
  return { ok: true, declared };
}

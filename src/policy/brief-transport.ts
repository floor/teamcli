// How a general seat brief travels (OD50): the entity → project → team reading of the enforced
// `brief-transport` policy. `file` is the signed record in the seat's own drop folder, exactly
// as every launch has written it; `message` means the same signed record and claim are delivered
// through the seat's own delivery walk, so a brief earns the same receipts and history a send
// does. The seat level is never read: the policy's levels are entity, project and team.
//
// A chain that cannot be read or verified falls back to `file` — today's behaviour — and says
// why, rather than guessing at a word the owner signed. The fallback never turns an unreadable
// source into an imagined `message`: the launch goes on delivering briefs.
import type { TeamFile } from '../file/types.ts';
import { ofTeam } from '../registry/projects.ts';
import { teamIdOf } from '../registry/teams.ts';
import { loadAndResolvePolicyChain } from './sources.ts';
import type { PolicyLevel } from './types.ts';

/** The words `brief-transport` admits: the durable drop, the receipted send walk, and the
 *  in-memory experiment that never writes the body on either side. */
export type BriefTransport = 'file' | 'message' | 'memory';

/** One resolution: the word in force, the level it came from, and why a fallback happened. */
export type BriefTransportReading = {
  transport: BriefTransport;
  level: PolicyLevel | 'default';
  /** Set only when the chain did not resolve and the reading fell back to `file`. */
  why?: string;
};

/** The project record a team sits in, by the registry, or null when none names it. */
function projectIdOfTeam(home: string, root: string): string | null {
  try {
    return ofTeam(home, teamIdOf(root))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads `brief-transport` across the team's own chain, up to the team level. The team file is
 * the one the caller already holds (its `policies` section is the team's word); the entity and
 * project levels are the registry's signed sources, read fresh.
 */
export function briefTransportOf(input: {
  home: string;
  root: string;
  team: TeamFile;
  now?: Date;
}): BriefTransportReading {
  const chain = loadAndResolvePolicyChain(
    {
      home: input.home,
      entity: input.team.entity,
      projectId: projectIdOfTeam(input.home, input.root),
      teamRoot: input.root,
      team: input.team,
    },
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      upToLevel: 'team',
    },
  );
  if (!chain.ok) {
    const first = chain.refusals[0];
    return {
      transport: 'file',
      level: 'default',
      why: first?.message ?? 'the policy chain cannot be read or verified',
    };
  }
  const effective = chain.policies['brief-transport'];
  const value = effective?.value;
  return {
    transport: value === 'message' || value === 'memory' ? value : 'file',
    level: effective?.level ?? 'default',
  };
}

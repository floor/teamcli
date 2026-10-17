// The `seat-numbering` setting as a team's names read it: the advised policy's signed chain
// (entity → project → team) over the team's own place, or the shipped default when no level
// declares one. An advised format is a word about how names are written, never a reason to
// refuse a run: a source that cannot be read, verified or ordered leaves the default in force,
// the way a file that does not read is no level's word.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { seatNumberingOf, SEAT_NUMBERING_DEFAULT, type SeatNumbering } from './inherit.ts';

export type SeatNumberingContext = {
  /** The home the signed policy sources live under. */
  home: string;
  /** The team root the chain's team level reads `.agents/team.yaml` from. */
  root: string;
  /** The team file in force, its `policies:` section read as the team's word. */
  team: TeamFile;
  /** When the chain is read: an expired declaration is unset at its level. */
  now?: Date;
};

/**
 * The numbering in force for a team's named seats: the effective `seat-numbering` policy, or the
 * shipped `2-` when no level declares one — or when a source on the chain will not load, since
 * the format the default writes is still a name and nothing is renamed by refusing it.
 */
export function seatNumberingInForce(context: SeatNumberingContext): SeatNumbering {
  const team = context.team;
  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, team, context.root),
      teamRoot: context.root,
      team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
  if (!chain.ok) return SEAT_NUMBERING_DEFAULT;
  const effective = chain.policies['seat-numbering'];
  if (effective === undefined) return SEAT_NUMBERING_DEFAULT;
  return seatNumberingOf(effective.value) ?? SEAT_NUMBERING_DEFAULT;
}

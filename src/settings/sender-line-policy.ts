// The `sender-line` policy as the receiving team's chain resolves it: how a typed wake's first
// line opens, set at entity, project or team. A chain that cannot be read, verified or ordered
// leaves the shipped format in force — the floor holds whatever the files say, and a wake is
// still named; a value the vocabulary does not accept is the shipped format too.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { senderLineFormatOf, SENDER_LINE_DEFAULT } from './sender-line.ts';

export type SenderLineContext = {
  /** The home the signed policy sources live under. */
  home: string;
  /** The team root the chain's team level reads `.agents/team.yaml` from. */
  root: string;
  /** The receiving team: its `policies:` section is the team level's word; null declares none. */
  team: TeamFile | null;
  /** When the chain is read: an expired declaration is unset at its level. */
  now?: Date;
};

/**
 * The sender-line format in force for wakes typed into this team's seats. It is read up to the
 * team level (the policy has no seat level) from the signed chain; anything that cannot be read
 * leaves the shipped floor format, never an unnamed line.
 */
export function senderLineFormatInForce(context: SenderLineContext): string {
  if (context.team === null) return SENDER_LINE_DEFAULT;
  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, context.team, context.root),
      teamRoot: context.root,
      team: context.team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
  if (!chain.ok) return SENDER_LINE_DEFAULT;
  const effective = chain.policies['sender-line'];
  if (effective === undefined) return SENDER_LINE_DEFAULT;
  return senderLineFormatOf(effective.value);
}

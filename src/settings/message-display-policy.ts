// The `message-display` policy as the receiving team's chain resolves it: the template a wake
// line's header renders from, set at entity or team. A chain that cannot be read, verified or
// ordered leaves the shipped template in force — a wake always opens with a readable header.
// A legacy custom `sender-line` value, written before this policy existed, is a valid template
// too and stands where `message-display` declares nothing; `on` is the old shipped default and
// is not a template.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { MESSAGE_DISPLAY_DEFAULT, parseMessageDisplayValue } from './message-display.ts';

export type MessageDisplayContext = {
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
 * The template in force for wakes shown in this team's seats. It is read up to the team level
 * (the policy has no project or seat level) from the signed chain; anything that cannot be read
 * leaves the shipped template, never an unbounded or unnamed line.
 */
export function messageDisplayInForce(context: MessageDisplayContext): string {
  if (context.team === null) return MESSAGE_DISPLAY_DEFAULT;
  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, context.team, context.root),
      teamRoot: context.root,
      team: context.team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
  if (!chain.ok) return MESSAGE_DISPLAY_DEFAULT;
  const current = chain.policies['message-display'];
  if (current !== undefined) {
    const parsed = parseMessageDisplayValue(current.value);
    if (parsed !== null) return parsed;
  }
  const legacy = chain.policies['sender-line'];
  if (legacy !== undefined && legacy.value !== 'on' && legacy.value !== true) {
    const parsed = parseMessageDisplayValue(legacy.value);
    if (parsed !== null) return parsed;
  }
  return MESSAGE_DISPLAY_DEFAULT;
}

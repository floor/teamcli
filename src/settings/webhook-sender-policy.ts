// The `webhook-sender-deadline-ms` policy as the receiving team's chain resolves it: how long a
// send's own arrival post waits on the seat's routine, set at entity, project or team. A chain
// that cannot be read, verified or ordered leaves the release default in force — the post is a
// wake beside a record that is already durable, and an unreadable policy never fails the send.
// The bus delivery has its own budget and does not read this value.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { WEBHOOK_SENDER_DEADLINE_MS } from './webhook-sender.ts';

export type WebhookSenderDeadlineContext = {
  /** The home the signed policy sources live under. */
  home: string;
  /** The team root the chain's team level reads `.agents/team.yaml` from. */
  root: string;
  /** The receiving team: its `policies:` section is the team level's word; null declares none. */
  team: TeamFile | null;
  /** When the chain is read: an expired declaration is unset at its level. */
  now?: Date;
};

/** The sender's own answer bound in force for posts to this team's seats, up to the team level
 *  (the policy has no seat level). Anything that cannot be read leaves the release default. */
export function webhookSenderDeadlineMs(context: WebhookSenderDeadlineContext): number {
  if (context.team === null) return WEBHOOK_SENDER_DEADLINE_MS;
  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, context.team, context.root),
      teamRoot: context.root,
      team: context.team,
    },
    { ...(context.now ? { now: context.now } : {}), upToLevel: 'team' },
  );
  if (!chain.ok) return WEBHOOK_SENDER_DEADLINE_MS;
  const effective = chain.policies['webhook-sender-deadline-ms'];
  if (effective === undefined) return WEBHOOK_SENDER_DEADLINE_MS;
  return typeof effective.value === 'number' ? effective.value : WEBHOOK_SENDER_DEADLINE_MS;
}

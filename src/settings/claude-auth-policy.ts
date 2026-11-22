// The `claude-auth` setting as a team's chain resolves it (entity → project → team), and the line
// rule a launch applies with it. A chain that cannot be read, verified or ordered leaves the seat
// on its session login, the behaviour before the setting: the token is handed to a seat only on a
// word that reads.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { secretWord } from '../launch/secret-words.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { leadingAssignments } from '../profiles/profile.ts';
import { CLAUDE_AUTH_DEFAULT, CLAUDE_TOKEN_ENTRY, parseClaudeAuth, type ClaudeAuth } from './claude-auth.ts';

export type ClaudeAuthContext = {
  /** The home the signed policy sources live under. */
  home: string;
  /** The team root the chain's team level reads `.agents/team.yaml` from. */
  root: string;
  /** The team file in force, its `policies:` section read as the team's word. */
  team: TeamFile;
};

/** The word in force for the team's Claude Code seats: `store` when no level declares one. */
export function claudeAuthInForce(context: ClaudeAuthContext): ClaudeAuth {
  const chain = loadAndResolvePolicyChain(
    {
      home: context.home,
      projectId: projectIdOfTeam(context.home, context.team, context.root),
      teamRoot: context.root,
      team: context.team,
    },
    { upToLevel: 'team' },
  );
  if (!chain.ok) return 'login';
  const effective = chain.policies['claude-auth'];
  if (effective === undefined) return CLAUDE_AUTH_DEFAULT;
  return parseClaudeAuth(effective.value) ?? 'login';
}

/** Whether a seat is a Claude Code seat on Anthropic itself, not on another provider's endpoint. */
export function anthropicClaudeSeat(seat: { cli: string; vendor: string | undefined }): boolean {
  return seat.cli === 'claude-code' && seat.vendor?.toLowerCase() === 'anthropic';
}

/** The variables that point a Claude Code line at a credential or an endpoint of its own: a line
 *  that sets one is never handed the subscription token. */
const OWN_CREDENTIAL = new Set([CLAUDE_TOKEN_ENTRY, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);

/**
 * The launch line with the token's secret word in front, or the line unchanged. Only a Claude
 * Code seat on Anthropic takes it, only when the setting is `store` and the store holds the entry,
 * and only on a line whose leading words read and set no credential or endpoint of their own. The
 * word names the entry; the launch fills it with the store's lookup (src/launch/secret-words.ts),
 * so the value reaches the seat's own shell only, never TeamCLI, its records or its logs.
 */
export function withClaudeToken(line: string, seat: { cli: string; vendor: string | undefined; auth: ClaudeAuth; held: boolean | null }): string {
  if (!anthropicClaudeSeat(seat) || seat.auth !== 'store' || seat.held !== true) return line;
  const leading = leadingAssignments(line);
  if (leading === null || leading.some((word) => OWN_CREDENTIAL.has(word.name))) return line;
  return `${secretWord(CLAUDE_TOKEN_ENTRY, CLAUDE_TOKEN_ENTRY)} ${line}`;
}

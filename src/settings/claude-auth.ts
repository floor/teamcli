// The `claude-auth` setting's vocabulary: how a Claude Code seat on Anthropic signs in. `store`
// (the default) gives the seat the subscription token the machine's secret store holds as
// `CLAUDE_CODE_OAUTH_TOKEN`, when it holds one; `login` leaves the seat on the CLI's own session
// login, as before the setting. A machine whose store holds no such entry launches as before
// under either word.
//
// This module holds only the vocabulary: the catalogue reads its parser without importing the
// reader back into itself (src/settings/claude-auth-policy.ts reads the chain and the line rule).

export const CLAUDE_AUTH_VALUES = ['store', 'login'] as const;
export type ClaudeAuth = (typeof CLAUDE_AUTH_VALUES)[number];
export const CLAUDE_AUTH_DEFAULT: ClaudeAuth = 'store';

/** The entry the store keeps the token under, and the variable Claude Code reads it from. */
export const CLAUDE_TOKEN_ENTRY = 'CLAUDE_CODE_OAUTH_TOKEN';

export function parseClaudeAuth(raw: unknown): ClaudeAuth | null {
  return typeof raw === 'string' && (CLAUDE_AUTH_VALUES as readonly string[]).includes(raw) ? raw as ClaudeAuth : null;
}

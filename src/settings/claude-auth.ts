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

/** Anthropic's own endpoint, the one a seat signing in with the subscription token talks to. */
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';

/** The variables that send Claude Code to another provider instead of Anthropic. An empty value
 *  is read as unset for provider selection (Claude Code's environment-variable reference). */
export const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const;

/**
 * The direct route a seat that takes the token is held to in its own generated settings file,
 * which the launch passes with `--settings`: that level stands above the user's, the project's and
 * the project-local settings files, and a settings `env` value replaces the one a shell exported.
 * Only the machine's managed settings stand above it. The endpoint is named, never emptied, and
 * every provider switch is emptied, so no lower file or shell profile can route the CLI elsewhere.
 */
export function claudeRouteEnv(): Record<string, string> {
  return { ANTHROPIC_BASE_URL: ANTHROPIC_ENDPOINT, ...Object.fromEntries(PROVIDER_SWITCHES.map((name) => [name, ''])) };
}

/** The same route on the launch line itself, in front of the CLI: the endpoint named, and the
 *  provider switches and any other Anthropic credential the pane's shell exported emptied, so the
 *  seat's process starts on Anthropic with the token alone even before its settings are read. */
export function claudeRouteWords(): string[] {
  return [
    `ANTHROPIC_BASE_URL=${ANTHROPIC_ENDPOINT}`, 'ANTHROPIC_AUTH_TOKEN=', 'ANTHROPIC_API_KEY=',
    // The host-managed provider mode an embedding app sets, which ignores a settings file's route.
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=',
    ...PROVIDER_SWITCHES.map((name) => `${name}=`),
  ];
}

/** Whether a generated settings file's text holds the direct route (`claudeRouteEnv`). */
export function routedSettingsText(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const env = (parsed as { env?: unknown } | null)?.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return false;
  return Object.entries(claudeRouteEnv()).every(([name, value]) => (env as Record<string, unknown>)[name] === value);
}

// The `claude-auth` setting as a team's chain resolves it (entity → project → team), and the line
// rule a launch applies with it. A chain that cannot be read, verified or ordered leaves the seat
// on its session login, the behaviour before the setting: the token is handed to a seat only on a
// word that reads.
import { projectIdOfTeam } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import { secretWord } from '../launch/secret-words.ts';
import { loadAndResolvePolicyChain } from '../policy/index.ts';
import { shellWords } from '../launch/shell-words.ts';
import { assignmentWordName } from '../profiles/profile.ts';
import { readFileSync } from 'node:fs';
import { systemSecretStore, type SecretStore } from '../secrets/store.ts';
import { CLAUDE_AUTH_DEFAULT, CLAUDE_TOKEN_ENTRY, parseClaudeAuth, routedSettingsText, type ClaudeAuth } from './claude-auth.ts';

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

/** Variables that point Claude Code at a credential, an endpoint or another provider of its own
 *  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, …). */
const ROUTING = /ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN/;

/** What a shell reads as more than one plain command: a separator, a pipe, a redirection, a
 *  backtick or a line break. */
const COMPOUND = /[;&|<>`\n]/;

/**
 * Whether a launch line's effective program is Claude Code itself on Anthropic's own endpoint, as
 * far as the line shows; fail closed. Only leading plain assignments, none of them routing and
 * none computed at run time, then the `claude` binary itself (by name or by path), then words that
 * neither name a routing variable, nor are computed at run time, nor bring a settings file of the
 * line's own (`--settings`, whose `env` could route the CLI elsewhere). A line through `env`, a
 * shell, a wrapper or a launcher script is never proved, whatever it sets inside, and gets nothing.
 */
export function claudeTokenLine(line: string): boolean {
  if (COMPOUND.test(line)) return false;
  const words = shellWords(line);
  if (words === null) return false;
  let at = 0;
  for (; at < words.length; at++) {
    const name = assignmentWordName(words[at]!.text);
    if (name === null) break;
    if (ROUTING.test(name) || words[at]!.expands) return false;
  }
  const program = words[at];
  if (program === undefined || program.expands || program.text.split('/').at(-1) !== 'claude') return false;
  return words.slice(at + 1).every((word) => !word.expands && !ROUTING.test(word.text) && !/^--settings(=|$)/.test(word.text));
}

/** Whether a file's seat would take the token on this machine's launch, as far as its file shows:
 *  a Claude Code seat on Anthropic on the shipped `claude-code` launcher, or on a plain line the
 *  gate proves. Any other launcher is resolved at launch, where the line it resolves to is gated. */
export function claudeTokenSeat(seat: { cli: string; vendor: string | undefined; launch: string; launcher?: string }): boolean {
  if (!anthropicClaudeSeat(seat)) return false;
  if (seat.launcher !== undefined) return seat.launcher === 'claude-code';
  return claudeTokenLine(seat.launch);
}

/**
 * The launch line with the token's secret word in front, or the line unchanged. Only a Claude
 * Code seat on Anthropic takes it, only when the setting is `store` and the store holds the entry,
 * and only on a line `claudeTokenLine` proves runs Claude Code on Anthropic. The word names the
 * entry; the launch fills it with the store's lookup (src/launch/secret-words.ts), so the value
 * reaches the seat's own shell only, never TeamCLI, its records or its logs.
 */
export function withClaudeToken(line: string, seat: { cli: string; vendor: string | undefined; auth: ClaudeAuth; held: boolean | null }): string {
  if (!anthropicClaudeSeat(seat) || seat.auth !== 'store' || seat.held !== true) return line;
  if (!claudeTokenLine(line)) return line;
  return `${secretWord(CLAUDE_TOKEN_ENTRY, CLAUDE_TOKEN_ENTRY)} ${line}`;
}

/**
 * The team's seats the launch hands the store's subscription token: Claude Code seats on
 * Anthropic whose file the gate proves (`claudeTokenSeat`), when `claude-auth` is `store` and the
 * entity's store holds the entry, asked by name. Their settings files are written with the direct
 * route (src/launch/cli-hook.ts), and the plan checks the file before it hands the token. `store`
 * is the caller's injected store; absent, the system's own for the team's entity.
 */
export function claudeTokenSeats(context: ClaudeAuthContext & { store?: SecretStore | null }): Set<string> {
  const seats = context.team.seats.filter((seat) => claudeTokenSeat(seat));
  if (seats.length === 0 || claudeAuthInForce(context) !== 'store') return new Set();
  const entity = context.team.entity;
  const store = context.store !== undefined
    ? context.store
    : systemSecretStore({ home: context.home, ...(typeof entity === 'string' && entity !== '' ? { entity } : {}) });
  return store?.holds?.(CLAUDE_TOKEN_ENTRY) === true ? new Set(seats.map((seat) => seat.name)) : new Set();
}

/** Whether the settings file a seat's launch passes holds the direct route: the token is handed
 *  only to a seat whose file does, so a file that did not land, or was written without it, gives
 *  nothing (fail closed). */
export function routedSettingsFile(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    return routedSettingsText(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

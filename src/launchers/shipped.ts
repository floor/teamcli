// Launchers that ship with TeamCLI: one per vendor CLI, generic, configured by the seat.
// A shipped launcher is code of this package, so it needs no owner cover: nothing in a team's
// folder can change what it runs. The seat's own settings (its role, its effort) choose among
// the options the launcher exposes; they live in the team record and go through `team config`.
import type { LauncherDefinition } from './types.ts';
import type { LaunchAccount } from './accounts.ts';

/** What a seat may ask of a shipped launcher. */
export type ShippedOptions = { role?: string; effort?: string; version?: string; vendor?: string; model?: string; account?: LaunchAccount };

/** The seat roles that only read: they get the CLI's own denials for writes, edits and git. */
const READ_ONLY_ROLES: ReadonlySet<string> = new Set(['reviewer', 'tester', 'assistant']);

/** Grok Build, the Grok CLI. Lines measured on grok 1.0.77 (50ca579fa996) on 2026-11-11:
 *  the builder line ran reads, writes, git and bun unprompted with the footer
 *  `Grok 4.7 (high) · always-approve`; the reviewer line ran reads and `team` commands
 *  unprompted and the CLI itself refused a write, an edit, `git status` and `bun test`.
 *  Only the Bun test runner was measured for the reviewer's denials. The model is named
 *  because 1.0.77's welcome screen asks for it to be selected otherwise. */
function grokBuild(options: ShippedOptions): LauncherDefinition {
  const readOnly = options.role !== undefined && READ_ONLY_ROLES.has(options.role);
  const permission = readOnly
    ? ['--permission-mode', 'dontAsk', '--allow', 'Read', '--allow', 'Bash(team *)',
       '--deny', 'Write', '--deny', 'Edit', '--deny', 'Bash(git *)', '--deny', 'Bash(bun *)']
    : ['--always-approve'];
  const effort = options.effort === undefined || options.effort === '' ? [] : ['--effort', options.effort];
  // The model is the seat's own: `grok-<version>` from its record (`version: "4.7"`), the id
  // `grok models` lists on 1.0.77. A seat that names no version gets 4.7, the account default
  // `grok models` showed on 2026-11-11. A version that is not a plain dotted number is refused
  // by the caller's validation; here it is kept out of the argv.
  const version = options.version !== undefined && /^\d+(\.\d+)*$/.test(options.version) ? options.version : '4.7';
  const model = `grok-${version}`;
  return {
    format: 1,
    name: 'grok-build',
    kind: 'custom',
    summary: readOnly ? `Grok Build, ${model}, read-only seat` : `Grok Build, ${model}, builder seat`,
    // `--trust`: 1.0.77's help does not list it, but the CLI takes it. Measured 2026-11-11 in a
    // fresh empty folder: with it the CLI opened straight on its prompt; without it every fresh
    // start of a seat drew the "Do you trust the contents of this directory?" dialog, in the
    // same folder each time. The folder is the seat's own, made for it by the team.
    argv: ['grok', '--trust', '--model', model, '--no-subagents', ...permission, ...effort],
  };
}

/** The Claude model id for a seat's model and version: `Claude Opus` + `5.5` is `claude-opus-5-5`.
 *  Only the families Claude Code names (Opus, Sonnet, Haiku, Fable) and a plain dotted version. */
function claudeModelId(model: string | undefined, version: string | undefined): string | null {
  const family = /^Claude (Opus|Sonnet|Haiku|Fable)$/.exec(model ?? '')?.[1];
  if (family === undefined || version === undefined || !/^\d+(\.\d+)*$/.test(version)) return null;
  return `claude-${family.toLowerCase()}-${version.replaceAll('.', '-')}`;
}

/** Claude Code's permission words for a seat. A read-only seat (reviewer, tester, assistant)
 *  runs without the bypass: `--permission-mode dontAsk` refuses, with no prompt, every tool not
 *  allowed; it may read, search and run `team`, and writes, edits, git and bun are denied. Each
 *  list is one comma-separated word so no later word of the line is read into it. Every other
 *  seat keeps the bypass the unattended seats have run with. */
function claudePermissions(role: string | undefined): string[] {
  if (role === undefined || !READ_ONLY_ROLES.has(role)) return ['--dangerously-skip-permissions'];
  return [
    '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read,Glob,Grep,Bash(team *)',
    '--disallowedTools', 'Write,Edit,NotebookEdit,Bash(git *),Bash(bun *)',
    // The tool denials alone leave a shell redirection free to write a file (measured
    // 2026-11-11: Write refused, `probe.txt` still written through Bash). Claude Code's sandbox
    // stops that write. `team` reaches its terminal host and its daemon over local sockets,
    // which the sandbox closes by default, so those stay open; it runs outside the sandbox. The
    // excluded command is named in three spellings because `["team"]` alone did not take effect
    // (the seat's send still could not find its team); with these three it was delivered.
    // Measured live 2026-11-11 on Claude Code 2.1.322: team send delivered; `printf … > file`,
    // `git status` and the Write tool were each refused, and no file was written.
    // The sandbox and the edit denials go in the seat's settings file (shippedClaudeSettings),
    // beside TeamCLI's hooks: the CLI reads one --settings, and a second one here would drop the
    // hooks that give the seat its socket route (measured 2026-11-11: "no live route").
  ];
}

/** Claude Code. The CLI's own permission prompts are skipped as on every unattended seat; the
 *  model is the seat's. For Anthropic the model id is built from the seat's model and version.
 *  For another provider (DeepSeek, Moonshot, Z.ai) the provider's env words come from the
 *  claude-code profile's `vendors` table and are set in front of the CLI by `shippedEnv`. */
function claudeCode(options: ShippedOptions): LauncherDefinition {
  const model = claudeModelId(options.model, options.version);
  const provider = options.vendor !== undefined && options.vendor !== 'anthropic' ? ` on ${options.vendor}` : '';
  return {
    format: 1,
    name: 'claude-code',
    kind: 'custom',
    summary: `Claude Code${provider}`,
    argv: ['claude', ...(model === null ? [] : ['--model', model]), ...claudePermissions(options.role)],
  };
}

const SHIPPED: Readonly<Record<string, (options: ShippedOptions) => LauncherDefinition>> = {
  'grok-build': grokBuild,
  'claude-code': claudeCode,
};

/** Shell words a shipped launcher sets in front of its CLI, as `env` assignments; empty when it
 *  needs none. For a provider, everything comes from the entity's launch account
 *  (specs/accounts-and-gates.md §3.3). A key is never a value here: the word is a keychain lookup
 *  of the account's item, run by the pane's shell at start, so the secret never passes through
 *  TeamCLI, its records or its logs. It is one double-quoted word with nothing nested inside, so
 *  the shell and TeamCLI's own line reader split the line the same way. */
export function shippedEnv(name: string | undefined, options: ShippedOptions): string[] {
  if (name !== 'claude-code') return [];
  const words: string[] = [];
  const account = options.account;
  const effort = options.effort ?? account?.effortDefault;
  if (effort !== undefined && /^[a-z]+$/.test(effort)) words.push(`CLAUDE_CODE_EFFORT_LEVEL=${effort}`);
  if (account === undefined) return words;
  const model = account.defaultModel ?? options.model ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/.test(model)) return words;
  words.push(
    `ANTHROPIC_BASE_URL=${account.endpoint}`,
    `ANTHROPIC_AUTH_TOKEN="$(/usr/bin/security find-generic-password -s ${account.keychain} -w)"`,
    `ANTHROPIC_MODEL=${model}`,
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${account.opusModel ?? model}`,
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${account.sonnetModel ?? model}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${account.haikuModel ?? model}`,
    `CLAUDE_CODE_SUBAGENT_MODEL=${account.subagentModel ?? model}`,
    // No Anthropic key reaches a provider endpoint, and the betas and tool search the provider
    // endpoints do not serve are off (the provider scripts this replaces, in use since 2026-10-02).
    'ANTHROPIC_API_KEY=', 'ENABLE_TOOL_SEARCH=false', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
  );
  if (account.fableModel !== undefined) words.push(`ANTHROPIC_DEFAULT_FABLE_MODEL=${account.fableModel}`);
  if (account.autoCompactWindow !== undefined) words.push(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=${account.autoCompactWindow}`);
  if (account.maxContextTokens !== undefined) words.push(`CLAUDE_CODE_MAX_CONTEXT_TOKENS=${account.maxContextTokens}`);
  if (account.timeoutMs !== undefined) words.push(`API_TIMEOUT_MS=${account.timeoutMs}`);
  return words;
}

/** The names a seat can put in `launcher:` with no file anywhere. */
export function shippedLauncherNames(): string[] {
  return Object.keys(SHIPPED).sort();
}

export function isShippedLauncher(name: string | undefined): boolean {
  return name !== undefined && Object.prototype.hasOwnProperty.call(SHIPPED, name);
}

/** True when the seat starts from a shipped launcher in its read-only form: the CLI's own
 *  permission policy holds it, and the launch adds no sandbox profile of its own. */
export function shippedLauncherIsReadOnly(name: string | undefined, role: string | undefined): boolean {
  return isShippedLauncher(name) && role !== undefined && READ_ONLY_ROLES.has(role);
}

/** The shipped launcher `name` as this seat configures it, or null when TeamCLI ships none
 *  by that name. */
export function shippedLauncher(name: string | undefined, options: ShippedOptions): LauncherDefinition | null {
  if (!isShippedLauncher(name)) return null;
  return SHIPPED[name as string]!(options);
}

/** The Claude Code settings a read-only seat on the claude-code launcher adds to its settings
 *  file: Claude Code's sandbox with Edit and Write denied, and `team` run outside it with local
 *  sockets open so the seat can still send (measured live 2026-11-11 on Claude Code 2.1.322:
 *  a shell write, git and the Write tool refused; team send delivered). Undefined for any other
 *  seat. The excluded command is named in three spellings; `["team"]` alone did not take effect. */
export function shippedClaudeSettings(launcher: string | undefined, role: string | undefined): Record<string, unknown> | undefined {
  if (launcher !== 'claude-code' || role === undefined || !READ_ONLY_ROLES.has(role)) return undefined;
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: ['team', 'team *', 'team:*'],
      network: { allowAllUnixSockets: true },
    },
    permissions: { deny: ['Edit(**)', 'Write(**)'] },
  };
}

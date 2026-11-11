// Launchers that ship with TeamCLI: one per vendor CLI, generic, configured by the seat.
// A shipped launcher is code of this package, so it needs no owner cover: nothing in a team's
// folder can change what it runs. The seat's own settings (its role, its effort) choose among
// the options the launcher exposes; they live in the team record and go through `team config`.
import type { LauncherDefinition } from './types.ts';
import { profileFor } from '../profiles/profile.ts';

/** What a seat may ask of a shipped launcher. */
export type ShippedOptions = { role?: string; effort?: string; version?: string; vendor?: string; model?: string };

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
    // Known gap, measured 2026-11-11: the tool denials alone leave a shell redirection free to
    // write a file (Write refused, `probe.txt` still written through Bash). Claude Code's sandbox
    // stops that write, but with it the seat's `team send` could not find its team, even with
    // `team` in `excludedCommands`. Until both hold at once, a Claude Code seat on this line
    // cannot run git, but is not read-only.
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

/** Compact windows by provider, from the provider scripts the launcher replaces. */
const COMPACT_WINDOWS: Readonly<Record<string, number>> = { deepseek: 786432 };

/** Shell words a shipped launcher sets in front of its CLI, as `env` assignments; empty when it
 *  needs none. A provider key is never a value here: the word is the profile's own keychain
 *  lookup, which the pane's shell runs at start, so the secret never passes through TeamCLI,
 *  its records or its logs. */
export function shippedEnv(name: string | undefined, options: ShippedOptions): string[] {
  if (name !== 'claude-code') return [];
  const words: string[] = [];
  if (options.effort !== undefined && /^[a-z]+$/.test(options.effort)) words.push(`CLAUDE_CODE_EFFORT_LEVEL=${options.effort}`);
  const vendor = options.vendor;
  if (vendor === undefined || vendor === 'anthropic') return words;
  const block = profileFor('claude-code')?.vendors.find((one) => one.name === vendor);
  if (block === undefined) return words;
  const found = block.models.find((one) => one.model === options.model && one.version === options.version) ?? block.models[0];
  if (found === undefined) return words;
  const fill = (word: string) => word.replaceAll('{model}', found.id).replaceAll('{credential}', block.credential);
  // A computed value is written as one double-quoted shell word, with no quotes nested inside
  // it, so the launch line stays words a shell and TeamCLI's own line reader split the same way:
  // the item is looked up by its service name alone (`-a "$USER"` dropped; one item per name).
  const oneWord = (word: string): string => {
    const at = word.indexOf('=$(');
    if (at < 0) return word;
    const value = word.slice(at + 1).replace(/\s+-a\s+"\$USER"/, '');
    return `${word.slice(0, at)}="${value}"`;
  };
  for (const word of block.env) words.push(oneWord(fill(word)));
  // As the provider scripts this replaces set them (docs/guides/tools/claude-deepseek.sh, in use
  // since 2026-10-02): no Anthropic key reaches a provider endpoint, and the betas and tool search
  // the provider endpoints do not serve are off.
  words.push('ANTHROPIC_API_KEY=', 'ENABLE_TOOL_SEARCH=false', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1');
  // The compact window the provider's context allows; Claude Code does not know these model
  // ids and otherwise assumes 200k ("Model "deepseek-flash" isn't recognized · context assumed
  // to be 200k tokens", seen 2026-11-11). Source: claude-deepseek.sh, in use since 2026-10-02.
  const window = COMPACT_WINDOWS[vendor];
  if (window !== undefined) words.push(`CLAUDE_CODE_AUTO_COMPACT_WINDOW=${window}`);
  // Every tier the CLI may pick runs the provider's model, as the scripts this replaces set.
  for (const tier of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    words.push(`${tier}=${found.id}`);
  }
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

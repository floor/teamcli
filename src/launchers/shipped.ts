// Launchers that ship with TeamCLI: one per vendor CLI, generic, configured by the seat.
// A shipped launcher is code of this package, so it needs no owner cover: nothing in a team's
// folder can change what it runs. The seat's own settings (its role, its effort) choose among
// the options the launcher exposes; they live in the team record and go through `team config`.
import type { LauncherDefinition } from './types.ts';

/** What a seat may ask of a shipped launcher. */
export type ShippedOptions = { role?: string; effort?: string; version?: string };

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

const SHIPPED: Readonly<Record<string, (options: ShippedOptions) => LauncherDefinition>> = {
  'grok-build': grokBuild,
};

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

// A launch profile, read from the CLI's YAML file. The screen is loaded separately.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REACH_ROSTER_FILE, REACH_ROSTER_TEMP } from '../reach/rules.ts';
import { DialectError, compilePattern } from '../watch/dialect.ts';
import { loadProfileModule } from './module-loader.ts';
import type { ComposeProfile } from './compose.ts';
import { shippedEfforts } from './efforts.ts';
import { WINDOWS, type QuotaPattern, type WindowName } from './quota.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';
import { trustAnswers, type TrustRecord } from './trust-answer.ts';
import { shellWords, type ShellWord } from '../launch/shell-words.ts';

/** How a CLI's input box is emptied and restored, as the one run that measured it saw.
 *  Declared only on the profiles a run covered; a CLI without this block has its unsent text
 *  left alone by every delivery and by a restart. */
export type InputBlock = {
  /** The keys that empty the box on an idle screen, sent in order and repeated until the box
   *  reads empty. */
  clear: readonly string[];
  /** The keys that empty the box during a running turn, measured on a CLI that takes text there.
   *  Null when the CLI's keys were measured only on an idle screen. */
  clearWorking: readonly string[] | null;
  /** How text is put back into the box. */
  paste: 'bracketed';
  /** Whether this CLI takes text into its box while a turn runs. True means `clearWorking` is
   *  the sequence a delivery uses on a working screen; false means a draft found there is left
   *  in place and held, because clearing it was never measured and the idle keys could stop the
   *  turn. */
  midTurn: boolean;
};

/**
 * A launch profile: what `team` knows about one CLI, so a seat can't start
 * blocked. Keyed by the seat's `cli`.
 */
/** The keys `--abandon` may press to answer a prompt: none of them selects a menu option. */
export const ABANDON_SAFE_KEYS = ['escape', 'ctrl+c', 'ctrl+u'] as const;

export interface Profile {
  cli: string;
  /** The CLI's process names, for the caller check. */
  processNames: readonly string[];
  /** Startup screens drawn before the CLI ever started a session (each rule: every pattern
   *  matches some row). `team down` closes such a pane without typing into it: no option is ever
   *  chosen. Empty when the profile names none. */
  notStarted?: readonly (readonly RegExp[])[];
  /** Prompts `team down --abandon` answers itself so the seat can close fully: each rule's
   *  patterns all match the pane, and its keys (only the safe ones: escape, ctrl+c, ctrl+u — never
   *  a digit or an Enter that would pick a menu option) are pressed in order. */
  abandonAnswers?: readonly { all: readonly RegExp[]; keys: readonly string[] }[];
  /** The binary whose version `doctor` reads, with `--version`. */
  binary: string;
  /** The range this profile was tested with, both ends included. */
  tested: { from: string; to: string };
  /** Options that make the CLI run without approvals, added to the launch. */
  unattended: readonly string[];
  /** The option that carries the rules, or null when they go as a first message or are
   *  prepended to each brief. */
  rulesOption: string | null;
  /** How the rules reach the seat: as a launch option, as its first message, or prepended to
   *  every brief a send types into its pane. A seat with no standing session — a fresh one per
   *  brief, like the Jules TUI's — has nowhere to keep a first-message line, so its profile
   *  says `prepend`. */
  rulesMode: 'option' | 'message' | 'prepend';
  /** For a first-message seat: how its launch line carries the one line that points at its rules
   *  file, so the line is never typed into its pane (0.5.9, src/send/no-pane-messaging.ts).
   *  `''` is the CLI's positional initial prompt; any other value is the option that precedes
   *  it (`-i`). Null: the CLI takes no initial prompt at launch, and its rules are not delivered. */
  rulesPrompt: string | null;
  /** Rules the profile carries for every seat of this CLI, over the team file's: a safety line
   *  the CLI itself makes necessary. They ride with the file's rules in every delivery. Empty
   *  when the CLI needs none. */
  standingRules: readonly string[];
  /** Whether herdr reports this CLI's agent status faithfully. `unreliable` when it does not
   *  (it reports the pane as no agent, or `unknown`, while the CLI runs): the profile's own
   *  screen reading is the seat's state there, and a recognised idle screen counts as free
   *  whatever herdr says. */
  herdrStatus: 'reliable' | 'unreliable';
  /** Arguments that exit 0 only when the owner is logged in, or null when the CLI has none. */
  loginCheck: readonly string[] | null;
  /** The command the owner runs to log in. */
  loginHint: string;
  /** What is typed into an idle prompt to make the CLI exit; null when the CLI exits by key. */
  exit: string | null;
  /** The keys that exit the CLI from its idle screen, in order, when it takes no exit text.
   *  Empty when the profile exits by typing `exit`. */
  exitKeys: readonly string[];
  /** A module that drives a typed delivery the CLI's own screens require, or null when the
   *  generic drop-file trigger reaches this CLI. See ComposeProfile. */
  compose: ComposeProfile | null;
  /** The one key that empties the CLI's input box, sent to clear an exit text that did not
   *  read back as typed. Null when no key is established for this CLI: the text is left. */
  exitClear: string | null;
  /** The one key that confirms the CLI's own question after the exit text — its "stop tasks and
   *  exit" one, read as `exit question`. Sent by a stop, and only on that screen; null when no
   *  key is established for this CLI: a seat that asks the question is one that could not be
   *  stopped by asking. */
  exitConfirm: string | null;
  /** The measured way into this CLI's box — its clear keys and paste surface. Null when no run
   *  measured them: a delivery that finds unsent text there holds, and a restart refuses. */
  input: InputBlock | null;
  /** The exact relative paths of regular files this CLI may leave in its working folder.
   *  Empty when no capture has established a path for this CLI. */
  lobbyFiles: readonly string[];
  /** Paths this CLI reads at start in its working folder. A `directory` entry is every file
   *  under that directory. Empty when a run showed this CLI reads none. */
  startupReads: readonly { path: string; directory: boolean }[];
  /** How the team inbox registers with this CLI, from the route a run measured. Null when no
   *  route is measured for this CLI: its seats stay on the drop and typed legs. */
  mcpInbox: InboxBlock | null;
  /** How an idle seat of this CLI can be told it has a message, as the profile's own
   *  measurements show: a push adapter, a runtime queue between turns, an inbox read on a
   *  turn, or nothing. The launch refines it (src/launch/delivery-class.ts). */
  delivery: DeliveryClass;
  /** Seconds to wait for the idle prompt after a launch. */
  idleTimeout: number;
  /** Seconds to wait for the pane's shell after the exit command. */
  exitTimeout: number;
  /** Whether the CLI starts on its last-used model when a launch names none. */
  lastUsedModel: boolean;
  /** What the model column shows when this CLI's screen names no model: `launch` falls back
   *  to the launch line's model, labelled; null marks the display `(declared, unread)`. */
  unreadModel: 'launch' | null;
  /** The model and version a launch line's model id means, or null when unknown. */
  modelOf(launch: string): { model: string; version: string } | null;
  /** The raw model id a launch line names, as this profile's model flags read it; the last
   *  flag in the line wins, as `modelOf` reads one. Null when the line names none. */
  modelIdOf(launch: string): string | null;
  /** A launch that names no model starts on whatever model this CLI used last. */
  startsOnLastModel: boolean;
  /** The model flag, and the id this profile maps to that model and version, when it knows one. */
  modelFlag(model: string, version: string): { option: string; id: string | null };
  /** Trust-answer records. Empty when this version sends no trust key for the CLI. */
  answers: readonly TrustRecord[];
}

/** A version as numbers: `2.1.288 (Claude Code)` is [2, 1, 288]. Null when the text holds none. */
export function parseVersion(text: string): number[] | null {
  const match = /\d+(?:\.\d+)*/.exec(text);
  return match ? match[0].split('.').map(Number) : null;
}

function order(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export type VersionVerdict = 'tested' | 'older' | 'newer' | 'unread';

/** Where a CLI's version sits against the range a profile was tested with. */
export function versionVerdict(text: string, tested: Profile['tested']): VersionVerdict {
  const version = parseVersion(text);
  const from = parseVersion(tested.from);
  const to = parseVersion(tested.to);
  if (!version || !from || !to) return 'unread';
  if (order(version, from) < 0) return 'older';
  if (order(version, to) > 0) return 'newer';
  return 'tested';
}

/** A word quoted for a POSIX shell. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** A profile's measured way of reaching an idle seat. `push`: an event adapter wakes it (the
 *  development channel, the cross-session socket); `between-turns`: its own runtime queue holds
 *  the message for it (a Codex seat on a managed endpoint); `pull-on-turn`: an MCP inbox the
 *  model reads when it takes a turn; `none`: no way to be woken while idle. A seat's effective
 *  class also depends on what its launch installed (src/launch/delivery-class.ts). */
export type DeliveryClass = 'push' | 'between-turns' | 'pull-on-turn' | 'none';

/** The delivery classes a profile may declare, in the order an effective class is chosen. */
export const DELIVERY_CLASSES = ['push', 'between-turns', 'pull-on-turn', 'none'] as const;

/** The team inbox's registration for one CLI, as a run measured it. */
export type InboxBlock = {
  /** Launch-line arguments, appended when a seat launches. `{seat}`, `{session}`, `{command}`
   *  and `{entry}` are filled from the launch; `{command_json}`, `{entry_json}` and
   *  `{seat_json}` are the same values escaped for a double-quoted string inside a structured
   *  word; `{file_args}` is the team file's `--file` pair as array elements inside such a
   *  word, and nothing when the launch read no file. Empty when the CLI takes none. */
  launchArgs: readonly string[];
  /** The CLI's own project-scope `mcp add` subcommand arguments, run in the seat's folder at
   *  launch. Null when the CLI has no measured add command. */
  add: readonly string[] | null;
  /** The file `add` writes, relative to the seat's folder. Null without `add`. */
  target: string | null;
  /** A config file team writes itself, relative to the seat's folder. Null when team writes
   *  none: the CLI's own command writes it, or no file is involved. */
  file: string | null;
};

/** What a launch fills into the profile's `mcp_inbox` words. `command` and `entry` are this
 *  install's runner — the executable and its entry script — which reach the inbox server
 *  whether or not `team` is on the PATH. `file` is the team file the launch read, when it read
 *  one: the server resolves the team from it, whatever folder it starts in. */
export type InboxPlace = { seat: string; session: string; command: string; entry: string; file?: string; epoch?: string };

/** A profile word with the launch's own values filled in.
 *
 *  `{file_args}` is for a launch-line route whose word holds the server's arguments inside a
 *  structured string (codex's `mcp_servers.team_inbox.args=[...]`): it is the `--file` pair as
 *  array elements, the path escaped as a JSON string (which is also a TOML basic string), and
 *  nothing at all when the launch named no team file. `{epoch_args}` is the same for the runtime
 *  epoch the seat's brief was delivered under, and nothing when this launch has no claim. A whole `{file}` word is for a command's
 *  own argv (`mcp add`), where the pair is two words and the shell never sees them.
 *
 *  `{command_json}`, `{entry_json}` and `{seat_json}` are the same values escaped for a
 *  double-quoted string inside such a structured word, for the profile that supplies the
 *  quotes: a quote or a backslash in a path stays part of the value. The plain forms stay raw
 *  for argv words (`mcp add`), where no escaping belongs. */
export function fillInboxPlace(text: string, place: InboxPlace): string {
  const inside = (value: string): string => JSON.stringify(value).slice(1, -1);
  return text
    .replaceAll('{seat}', place.seat)
    .replaceAll('{session}', place.session)
    .replaceAll('{command}', place.command)
    .replaceAll('{entry}', place.entry)
    .replaceAll('{command_json}', inside(place.command))
    .replaceAll('{entry_json}', inside(place.entry))
    .replaceAll('{seat_json}', inside(place.seat))
    .replaceAll('{file_args}', place.file === undefined ? '' : `,"--file",${JSON.stringify(place.file)}`)
    .replaceAll('{epoch_args}', place.epoch === undefined ? '' : `,"--epoch",${JSON.stringify(place.epoch)}`);
}

/** Add defaults as complete options: a line's own flag keeps its value, including when the
 *  flag uses an alias or the value is joined with `=` or attached to a short flag. The line is
 *  read as its shells split it, at every layer — a quoted script included — so a flag inside a
 *  prompt or config value is one word with the value and does not suppress a default, and a
 *  flag whose name is quoted (`"--sandbox"`) is still the flag the CLI reads. */
function unattendedOptions(profile: Profile, launch: string): string[] {
  const aliases: Record<string, string> = profile.cli === 'codex'
    ? { '-a': '--ask-for-approval', '-s': '--sandbox' }
    : {};
  const key = (word: string): string => {
    const flag = word.split('=', 1)[0]!;
    const alias = aliases[flag];
    if (alias !== undefined) return alias;
    // A codex short option takes its value attached as well: measured on codex-cli 0.161.0,
    // `codex -abogus --version` exits 2 with "invalid value 'bogus' for '--ask-for-approval
    // <APPROVAL_POLICY>'" and `codex -aon-request -sworkspace-write completion bash` exits 0.
    const attached = /^-([as]).+$/.exec(flag);
    return (attached === null ? undefined : aliases[`-${attached[1]!}`]) ?? flag;
  };
  // A wrapper's CLI is read inside its trailing quoted script: a `zsh -lc "codex --sandbox
  // read-only"` line set its own sandbox, and adding the profile's default would widen it. The
  // words are the decoded ones, so a quoted flag name still reads as a flag.
  const flags = new Set<string>();
  for (const words of launchWordScopes(launch)) {
    for (const word of words) {
      if (word === '--') break;
      if (word.startsWith('-')) flags.add(key(word));
    }
  }
  const options: string[] = [];
  for (let i = 0; i < profile.unattended.length; i++) {
    const flag = profile.unattended[i]!;
    const next = profile.unattended[i + 1];
    const value = !flag.includes('=') && next !== undefined && !next.startsWith('-') ? next : undefined;
    if (!flags.has(key(flag))) {
      options.push(flag);
      if (value !== undefined) options.push(value);
    }
    if (value !== undefined) i++;
  }
  return options;
}

/**
 * The command a seat's pane runs: the unattended flag in its environment, the
 * file's launch line, then the profile's options and, where the CLI takes
 * them at launch, the rules. A CLI that loads a per-launch settings file also
 * gets that file, named at the end, unless its launch line already names one.
 * A launch with a place adds the profile's measured team-inbox arguments.
 * A launch line whose last word is a quoted script that runs the CLI takes the
 * options inside that script, where the CLI reads them, exactly as a carried
 * resume and a minted session id do. A line whose shape this version cannot
 * prove keeps 0.5.10's placement, the options after the line, and says so
 * through `warn`: it never refuses to launch a line 0.5.10 launched.
 */
export function launchCommand(
  profile: Profile,
  launch: string,
  rules: string,
  cliHook?: string | null,
  place?: InboxPlace,
  displayName?: string,
  runtimePolicies?: { codexDaemon?: 'on' | 'off' },
  rulesLine?: string,
  warn?: (text: string) => void,
): string {
  // Every "does the line already set this" below reads the CLI's own decoded words, so a flag
  // inside a trailing quoted script counts exactly as one written on a plain line, and a quoted
  // flag name is the flag. A line this version cannot prove is asked 0.5.10's questions of the
  // whole line instead: a flag it plainly sets is still seen, and one only a quoted flag name
  // appears to set is not.
  const words = cliWordList(profile.cli, launch);
  const sets = (flags: readonly string[], plain: RegExp): boolean =>
    words === null ? plain.test(launch) : hasFlag(words, flags);
  const hasNoDaemon = words === null
    ? new Set(launch.trim().split(/\s+/)).has('--no-daemon')
    : hasFlag(words, ['--no-daemon']);
  const options = unattendedOptions(profile, launch);
  if (profile.cli === 'codex' && runtimePolicies?.codexDaemon === 'off' && !hasNoDaemon) {
    const altIdx = options.indexOf('--no-alt-screen');
    if (altIdx >= 0) options.splice(altIdx, 0, '--no-daemon');
    else options.push('--no-daemon');
  }
  // The session's own display name, where the CLI takes one and the line names none: a person
  // reading the session — its prompt box, its resume list, its terminal title — sees the seat's
  // readable name rather than an anonymous session.
  if (displayName !== undefined && displayName !== '' && supportsSessionName(profile.cli)
    && !sets(['--name', '-n'], /(^|\s)(--name(=|\s|$)|-n(\s|$))/)) {
    options.push('--name', displayName);
  }
  if (profile.rulesOption !== null) options.push(profile.rulesOption, rules);
  if (place) {
    for (const word of profile.mcpInbox?.launchArgs ?? []) options.push(fillInboxPlace(word, place));
  }
  if (cliHook !== undefined && cliHook !== null && supportsCliHook(profile.cli)
    && !sets(['--settings'], /(^|\s)--settings(=|\s|$)/)) {
    options.push('--settings', cliHook);
  }
  // A first-message seat's rules line rides the launch as the CLI's initial prompt, last, so it
  // is never typed into the pane.
  if (rulesLine !== undefined && profile.rulesMode === 'message' && profile.rulesPrompt !== null) {
    if (profile.rulesPrompt !== '') options.push(profile.rulesPrompt);
    options.push(rulesLine);
  }
  const addition = options.map(shellQuote).join(' ');
  const trimmed = launch.trim();
  if (addition === '') return ['AGENT_UNATTENDED=1', trimmed].join(' ');
  // The options pass through appendOnLaunchLine like a resume does: a wrapper that forwards its
  // arguments takes them at the end of the line, and a quoted script that runs the CLI takes
  // them inside its quotes, no longer after them where the CLI never reads. A line whose shape
  // this version cannot prove keeps 0.5.10's placement after the line, and the seat says so.
  const placed = appendOnLaunchLine(trimmed, addition, profile.binary);
  if (placed.uncertain) {
    warn?.('its launch line could not be read to its end; its profile options are after the line, where the CLI may not read them');
  }
  return ['AGENT_UNATTENDED=1', placed.line].join(' ');
}

/** True when the CLI loads a settings file named on its launch line, and that file may install
 *  command hooks: Claude Code's `--settings <file>`. */
export function supportsCliHook(cli: string): boolean {
  return cli === 'claude-code';
}

/** True when the CLI takes a session display name on its launch line. The one measured is
 *  Claude Code's, from `claude --help` on 2.1.302:
 *
 *      -n, --name <name>                     Set a display name for this session
 *                                            (shown in the prompt box, /resume
 *                                            picker, and terminal title)
 */
export function supportsSessionName(cli: string): boolean {
  return cli === 'claude-code';
}

/** True when the CLI takes the session id on its launch line, so TeamCLI sets it rather than
 *  reading the CLI's own session files afterwards. Measured from `claude --help` on 2.1.303:
 *
 *      --session-id <uuid>                   Use a specific session ID for the conversation
 *                                            (must be a valid UUID)
 */
export function supportsSessionId(cli: string): boolean {
  return cli === 'claude-code';
}

/** True when the CLI keeps its sessions to resume by id, which is what makes a session's id
 *  worth recording. Measured from `claude --help` on 2.1.303:
 *
 *      -r, --resume [value]                  Resume a conversation - provide a session ID
 *                                            or interactively select a conversation
 *
 *  and from Codex's own subcommand, `codex resume --help` (codex-cli 0.161.0):
 *
 *      Resume a previous interactive session (picker by default; use --last to continue the
 *      most recent)
 *
 *      Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]
 *
 *  Codex takes the id as a word after `resume`, not as a flag. `codex -m gpt-6-sol -c
 *  model_reasoning_effort=high resume --help` printed that usage and exited 0 in an empty
 *  synthetic home, so a recorded line's own options stay in front of the subcommand.
 *
 *  Antigravity's form was measured on the owner's Mac: `agy --conversation=<uuid>` resumes
 *  that conversation (for example `agy --conversation=b4b1b021-e8af-4213-9b7e-470b233b712f`).
 *  Conversations live under `~/.gemini/antigravity-cli/conversations/`. The flag is one
 *  `--conversation=<id>` word appended to the seat's launch line, including a wrapper such
 *  as `zsh …/as-floor.sh agy …`, so the wrapper forwards it. This profile does not mint the
 *  id at launch.
 *
 *  Grok's form was measured on Grok CLI 1.0.70: `grok -r <session-id>` resumes that
 *  conversation. The same CLI accepts `--session-id <uuid>` at launch for a new conversation.
 *  TeamCLI does not mint that id; a relaunch appends `-r <id>` from the registry record's
 *  `reach.agent_session`, on the same line a wrapper such as `zsh …/as-floor.sh grok …`
 *  forwards.
 */
export function supportsSessionResume(cli: string): boolean {
  return cli === 'claude-code' || cli === 'codex' || cli === 'antigravity' || cli === 'grok';
}

/** The session id a launch line already names with `--session-id`, if it names one. The line is
 *  read as a shell reads it, through the same proved read every other reader asks
 *  ({@link cliWordListOf}): a quoted flag name is the flag and a quoted value is the value. A
 *  line that runs some other program leaves the script's words to the program the script names,
 *  exactly as a session selection there is not the line's. */
export function launchSessionId(command: string): string | undefined {
  const trimmed = command.trimEnd();
  const words = shellWords(trimmed);
  if (words === null) return undefined;
  const program = words[programWordAt(words)];
  if (program === undefined) return undefined;
  const own = cliWordListOf(program.text.split('/').pop() ?? program.text, trimmed);
  return own === null ? undefined : sessionIdIn(own);
}

/**
 * The command a pane runs, with the session id TeamCLI sets where the CLI takes one. The id is
 * appended after every other argument, so the plan (`team up --dry-run`, `team add`) keeps the
 * deterministic line it had and each launch gets its own id. A wrapper that runs the CLI inside a
 * quoted script takes the id inside that script, where the CLI reads it; a wrapper that forwards
 * its own arguments takes it after them. A line that already names a session id, resumes one
 * (`--resume`/`-r`) or continues one (`--continue`/`-c`) is left as it is: the id it names is the
 * one recorded, and a resumed conversation is not a new session.
 */
export function withLaunchSession(
  cli: string,
  command: string,
): { command: string; sessionId?: string; notice?: string } {
  if (!supportsSessionId(cli)) return { command };
  // Only the CLI's own decoded words are read: a shell's `-c` before a quoted script that runs
  // the CLI is the shell's option, not Claude Code's `--continue`, and a quoted `--session-id`
  // is the flag. A declared id, however it is quoted, is the id this launch records: no mint.
  const words = cliWordList(cli, command);
  const named = words === null ? undefined : sessionIdIn(words);
  if (named !== undefined) return { command, sessionId: named };
  if (words !== null && hasFlag(words, ['--session-id', '--resume', '-r', '--continue', '-c'])) return { command };
  const sessionId = randomUUID();
  // `supportsSessionId` names one CLI, and its launch binary is `claude`: a quoted script that
  // runs it takes the id inside its quotes, where the CLI reads it, never after them. An id that
  // cannot be placed where the CLI reads it is never recorded: the run says so instead.
  const placed = placedOnLaunchLine(command, `--session-id ${sessionId}`, 'claude');
  if (placed === null) {
    return {
      command,
      notice: 'its launch line cannot take a session id where its CLI reads it; launched without one',
    };
  }
  return { command: placed, sessionId };
}

/**
 * The command a pane runs to resume a recorded conversation, where the CLI keeps sessions: the
 * id is appended after every other argument, as `withLaunchSession` appends a new one. The
 * measured lines are Claude Code's (`-r, --resume [value] Resume a conversation - provide a
 * session ID`, `claude --help` 2.1.303), Codex's subcommand (`Usage: codex resume [OPTIONS]
 * [SESSION_ID] [PROMPT]`, `codex resume --help` 0.161.0), Antigravity's
 * `--conversation=<uuid>` (`agy --conversation=b4b1b021-e8af-4213-9b7e-470b233b712f`, measured
 * on the owner's Mac; quoted on {@link supportsSessionResume}) and Grok's `-r <session-id>`
 * (Grok CLI 1.0.70). A Codex line takes the subcommand, so its id is a word after `resume`,
 * never a flag. An Antigravity line takes one `--conversation=<id>` word. A Grok line takes
 * `-r` and the id as the next word. A wrapper whose last word is a quoted script that itself
 * runs the CLI gets that addition inside the script; a wrapper that forwards its own arguments
 * gets it after them. Null when the CLI cannot resume: the caller hands over instead. Null,
 * too, for a launch line that already names a session — the flags below for Claude Code and
 * Grok, the `resume` subcommand for Codex, `--conversation` for Antigravity: appending ours
 * would leave two choices on the line, and the line's own choice is the one the file records.
 * `-c` is a flag's name only on a Claude Code line: Codex's own `-c` is a config override, and
 * a recorded Codex line carries one. Grok's `--session-id` starts a new conversation; it is
 * not rewritten into `-r`.
 */
export function withResume(cli: string, command: string, sessionId: string): string | null {
  if (!supportsSessionResume(cli)) return null;
  // A line's own selection is read from the CLI's decoded words alone: a shell's `-c`, `-lc` or
  // `-ec` before a quoted script that runs the CLI is the shell's option, never a resume of the
  // CLI's, and a quoted flag name is the flag.
  const words = cliWordList(cli, command);
  if (cli === 'codex') {
    if (words?.includes('resume')) return null;
    return placedOnLaunchLine(command, `resume ${sessionId}`, 'codex');
  }
  if (cli === 'antigravity') {
    if (words !== null && hasFlag(words, ['--conversation'])) return null;
    return placedOnLaunchLine(command, `--conversation=${sessionId}`, 'agy');
  }
  if (cli === 'grok') {
    if (words !== null && hasFlag(words, ['--session-id', '--resume', '-r'])) return null;
    return placedOnLaunchLine(command, `-r ${sessionId}`, 'grok');
  }
  if (words !== null && hasFlag(words, ['--session-id', '--resume', '-r', '--continue', '-c'])) return null;
  return placedOnLaunchLine(command, `--resume ${sessionId}`, 'claude');
}

/** The shells that take a command string. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']);

/** The shells whose quoting this tool writes inside: the POSIX shells, whose single quote
 *  splices as `'\''` and whose words split as the tokenizer reads them. A fish or csh command
 *  string is read for its flags but never written into: a line that runs one keeps 0.5.10's
 *  placement after the line, with the warning that says so. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash']);

/** The program word of a line, past its variable assignments and an `env` prefix. */
function programWordAt(words: readonly ShellWord[]): number {
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!.text)) at += 1;
  if (at < words.length && (words[at]!.text.split('/').pop() ?? words[at]!.text) === 'env') {
    at += 1;
    while (at < words.length) {
      const text = words[at]!.text;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || text.startsWith('-')) {
        at += 1;
        continue;
      }
      break;
    }
  }
  return at;
}

/** The program word of a line, when that word is a shell. */
function shellProgramOf(command: string): string | null {
  const words = shellWords(command.trimEnd());
  if (words === null) return null;
  const program = words[programWordAt(words)];
  if (program === undefined) return null;
  const name = program.text.split('/').pop() ?? program.text;
  return SHELLS.has(name) ? name : null;
}

/** A shell's command-string flag: `-c`, or a cluster that ends in one — `-lc`, `-ec`, `-euc`.
 *  A cluster carrying `o` or `O` is not one: those take the rest of the cluster as their own
 *  name, so `-oc` names that option `c`, never the command-string flag. */
function isCommandStringFlag(text: string): boolean {
  return /^-[A-Za-z]*c$/.test(text) && !/[oO]/.test(text.slice(1));
}

/** The word a shell on this line runs as its command string, with the words after it. Null when
 *  the line's program is not a shell, when the shell's options name no command string (a script
 *  file, stdin), and when a command-string flag has no word after it. Only a word right after a
 *  command-string flag is a script: `bash -l ../tools/y.sh` runs a file, and a script file is
 *  never read as a `-c` script. The words after that script are its positional words. */
type ShellScript = { word: ShellWord; trailing: readonly ShellWord[] };
function shellScriptWordOf(command: string): ShellScript | null {
  const trimmed = command.trimEnd();
  const words = shellWords(trimmed);
  if (words === null || words.length === 0) return null;
  const programAt = programWordAt(words);
  const program = words[programAt];
  if (program === undefined) return null;
  if (!SHELLS.has(program.text.split('/').pop() ?? program.text)) return null;
  for (let at = programAt + 1; at < words.length; at += 1) {
    const word = words[at]!;
    if (isCommandStringFlag(word.text)) {
      const script = words[at + 1];
      return script === undefined ? null : { word: script, trailing: words.slice(at + 2) };
    }
    // `--` ends the options and `-` names stdin: neither is a command string.
    if (word.text === '--' || word.text === '-') return null;
    if (word.text === '-o') {
      // `-o` takes its option name as the next word: `sh -o errexit -c 'claude'`.
      at += 1;
      continue;
    }
    if (word.text.startsWith('-')) continue;
    // A script file operand: the words after it are that script's own.
    return null;
  }
  return null;
}

/** The quoting a script word's text can be written into. */
type ScriptQuote = 'double' | 'single';

/** The quote that opens a word's last source character, when that character closes it: the
 *  quote context open just before the word ends. Null when the word ends outside quotes
 *  (`claude`, `"claude"x`), where nothing can be placed inside its text. A `$'…'` word never
 *  reaches this reader: the tokenizer does not read ANSI-C quoting, so its line is unreadable. */
function closingQuoteOf(command: string, word: ShellWord): ScriptQuote | null {
  let quote: ScriptQuote | null = null;
  let at = word.start;
  const last = word.end - 1;
  while (at < last) {
    const char = command[at]!;
    if (quote === null) {
      if (char === '\\') {
        at += 2;
        continue;
      }
      if (char === "'") {
        quote = 'single';
        at += 1;
        continue;
      }
      if (char === '"') {
        quote = 'double';
        at += 1;
        continue;
      }
      at += 1;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === '"') quote = null;
    at += 1;
  }
  if (quote === null) return null;
  const close = command[last];
  if (quote === 'double') return close === '"' ? quote : null;
  return close === "'" ? quote : null;
}

/** The source length of the delimiter a quoted word opens with, when its first source
 *  characters are that delimiter. Null when the word starts with something else (`x"…"`),
 *  whose source this reader cannot rebuild. */
function openingOf(command: string, word: ShellWord, quote: ScriptQuote): number | null {
  return command[word.start] === (quote === 'double' ? '"' : "'") ? 1 : null;
}

type QuotedWord = { quote: ScriptQuote; openLen: number };

/** A word this reader can write inside: one quoted string in source, whose opening delimiter is
 *  the quote that closes its last character. */
function quotedWordOf(command: string, word: ShellWord): QuotedWord | null {
  const quote = closingQuoteOf(command, word);
  if (quote === null) return null;
  const openLen = openingOf(command, word, quote);
  return openLen === null ? null : { quote, openLen };
}

/** Whether a script body runs the CLI as its command: its program word is `<binary>`, by name or
 *  path, given directly or after `exec` or `command` whose own options are none. */
function startsWithCli(binary: string, command: string): boolean {
  const words = shellWords(command);
  if (words === null) return false;
  let at = programWordAt(words);
  let program = words[at];
  if (program !== undefined && (program.text === 'exec' || program.text === 'command')) {
    at += 1;
    program = words[at];
    if (program === undefined || program.text.startsWith('-')) return false;
  }
  return program !== undefined && (program.text.split('/').pop() ?? program.text) === binary;
}

/** Whether a script word's raw source reaches the shell that runs it unchanged. The shell that
 *  parses the command line reads a double-quoted word before any inner shell sees it: inside
 *  those quotes an unescaped `$` or backtick is expanded at that outer layer, whatever quotes
 *  appear inside it, and an unquoted stretch of the word is read there too. So a word whose raw
 *  text holds either hands the inner shell something other than the text this reader decoded.
 *  A single-quoted word is taken literally, and a backslash makes the next character literal.
 *  A word that closes and reopens quotes is followed as the outer shell reads it. */
function outerWordKeepsText(body: string, quote: ScriptQuote): boolean {
  let state: ScriptQuote | null = quote;
  let at = 0;
  while (at < body.length) {
    const char = body[at]!;
    if (state === 'single') {
      if (char === "'") state = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (state === 'double') {
      if (char === '"') {
        state = null;
        at += 1;
        continue;
      }
      if (char === '$' || char === '`') return false;
      at += 1;
      continue;
    }
    if (char === "'") {
      state = 'single';
      at += 1;
      continue;
    }
    if (char === '"') {
      state = 'double';
      at += 1;
      continue;
    }
    if ('$`*?['.includes(char)) return false;
    at += 1;
  }
  return true;
}

/** Whether a script body is one simple command whose words the shell hands on exactly as
 *  written. A lexical reader cannot see what the shell does at run time, so a body holding a
 *  construct the shell changes is not proved: not a top-level operator (`;`, `&`, `|`, `<`, `>`,
 *  `(`, `)`), a newline or a comment, and not an expansion or a substitution (`$` in any form, a
 *  backtick) or a glob (`*`, `?`, `[`), which the shell reads unquoted and inside double quotes
 *  alike. Only single quotes make such characters literal, and a backslash makes the next
 *  character literal. A body with any other such construct is unprovable, and its line keeps the
 *  0.5.10 placement with its notice. */
function isSimpleCommand(text: string): boolean {
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return false;
      at = close + 1;
      continue;
    }
    if (char === '"') {
      at += 1;
      let closed = false;
      while (at < text.length) {
        const inner = text[at]!;
        if (inner === '\\') {
          at += 2;
          continue;
        }
        if (inner === '"') {
          at += 1;
          closed = true;
          break;
        }
        if (inner === '$' || inner === '`') return false;
        at += 1;
      }
      if (!closed) return false;
      continue;
    }
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === '$' || char === '`' || char === '*' || char === '?' || char === '[') return false;
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1]!))) return false;
    if (';|&<>()\n'.includes(char)) return false;
    at += 1;
  }
  return true;
}

/** The one proof a script word carries, asked by every reader: the shell that parses it hands
 *  it on exactly as this reader decoded it — one quoted source word whose raw text keeps every
 *  character that shell reads inside it ({@link outerWordKeepsText}) — and the body it runs is
 *  one simple command for that shell ({@link isSimpleCommand}). A placement never writes inside
 *  a script that fails either proof, and a word read reports no word from one. Both ask this
 *  same function, so they refuse the same lines by construction. Returns the body and the quote
 *  the shell reads inside it, or null when the word proves neither. */
function provenScriptWord(text: string, word: ShellWord): { body: string; layer: QuotedWord } | null {
  const layer = quotedWordOf(text, word);
  if (layer === null) return null;
  if (!outerWordKeepsText(text.slice(word.start + layer.openLen, word.end - 1), layer.quote)) return null;
  if (!isSimpleCommand(word.text)) return null;
  return { body: word.text, layer };
}

/** `text` written so one shell quoting layer hands it on exactly as written: a double-quoted
 *  script's shell reads `\`, `"`, `$` and a backtick back to themselves; a single-quoted one
 *  takes everything literally, with quotes spliced as `'\''`. */
function encodeForQuote(quote: ScriptQuote, text: string): string {
  if (quote === 'double') {
    return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
  }
  return text.replaceAll("'", "'\\''");
}

/** Where an addition belongs on a launch line. `script` is inside the innermost quoted script
 *  that runs the CLI, `at` the source position just before that script's closing quote, and
 *  `layers` the quotes the text passes through, outermost first. `uncertain` is a line whose
 *  shape this version cannot prove: it keeps 0.5.10's placement after the line. */
type Placement =
  | { kind: 'line' }
  | { kind: 'script'; at: number; layers: readonly ScriptQuote[] }
  | { kind: 'uncertain' };

/** Whether a word written after a plain line reaches the command the line runs. A plain line has
 *  no shell command string, so the shell that runs it reads the appended word too — unless the
 *  line swallows the rest of its own text: an unquoted `#` that starts a word is a comment, an
 *  unquoted top-level operator (`;`, `|`, `&`, `<`, `>`) or a newline ends the command, an
 *  unclosed quote takes every later character into the quoted word, and a trailing backslash
 *  escapes the space before the appended word. A `$` expansion or a glob changes its own word
 *  only, so the words written after it still reach the command and it does not count here. */
function takesAppendedWord(text: string): boolean {
  let quote: ScriptQuote | null = null;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (quote === 'single') {
      if (char === "'") quote = null;
      at += 1;
      continue;
    }
    if (char === '\\') {
      if (at + 1 >= text.length) return false;
      at += 2;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      at += 1;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      at += 1;
      continue;
    }
    if (char === '"') {
      quote = 'double';
      at += 1;
      continue;
    }
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1]!))) return false;
    if (';|&<>\n'.includes(char)) return false;
    at += 1;
  }
  return quote === null;
}

/** Where words written for the CLI are read on a launch line. A plain line and a wrapper that
 *  forwards its arguments take them after the line, when the line does not swallow the rest of
 *  its text ({@link takesAppendedWord}). A line ending in a quoted script that runs the CLI takes
 *  them inside that script, and one nested shell is followed to the script it runs. Everything
 *  else — an unreadable line, a script word after positional words, a script file, a bare command
 *  word, a shell whose quoting this tool does not write, a body that is more than one simple
 *  command, a nesting deeper than one shell, or a plain line that swallows an appended word — is
 *  uncertain, and keeps 0.5.10's placement after the line. */
function placementOf(binary: string, command: string): Placement {
  const trimmed = command.trimEnd();
  if (trimmed === '') return { kind: 'line' };
  if (shellWords(trimmed) === null) return { kind: 'uncertain' };
  const found = shellScriptWordOf(trimmed);
  if (found === null) return takesAppendedWord(trimmed) ? { kind: 'line' } : { kind: 'uncertain' };
  if (found.trailing.length > 0) return { kind: 'uncertain' };
  const shell = shellProgramOf(trimmed);
  if (shell === null || !POSIX_SHELLS.has(shell)) return { kind: 'uncertain' };
  const proof = provenScriptWord(trimmed, found.word);
  if (proof === null) return { kind: 'uncertain' };
  if (startsWithCli(binary, proof.body)) {
    return { kind: 'script', at: found.word.end - 1, layers: [proof.layer.quote] };
  }
  return nestedPlacement(binary, trimmed, found.word, proof.layer) ?? { kind: 'uncertain' };
}

/** The script one nested shell runs, when that script runs the CLI: the outer body's source is
 *  normally exactly the text this reader decoded, so a position in the body is a position on the
 *  line. A line this tool has already written into no longer matches character for character —
 *  an addition inside a single-quoted inner script is spliced as `'\''` — but the inner script is
 *  the body's last word, so its closing quote is still the body's last character that is not
 *  whitespace: readable in the source when the outer quote is a double quote (a single quote is
 *  literal there) and that quote is not escaped (an odd backslash run before it). Deeper nesting,
 *  any other shell dialect, an inner double-quoted script and a body that is not one simple
 *  command are left to 0.5.10's placement. */
function nestedPlacement(
  binary: string,
  command: string,
  outer: ShellWord,
  layer: QuotedWord,
): Placement | null {
  const body = outer.text;
  const inner = shellScriptWordOf(body);
  if (inner === null || inner.trailing.length > 0) return null;
  const shell = shellProgramOf(body);
  if (shell === null || !POSIX_SHELLS.has(shell)) return null;
  const proof = provenScriptWord(body, inner.word);
  if (proof === null) return null;
  if (!startsWithCli(binary, proof.body)) return null;
  const source = command.slice(outer.start + layer.openLen, outer.end - 1);
  if (source === body) {
    return {
      kind: 'script',
      at: outer.start + layer.openLen + inner.word.end - 1,
      layers: [layer.quote, proof.layer.quote],
    };
  }
  if (layer.quote !== 'double' || proof.layer.quote === 'double') return null;
  const tail = source.replace(/\s+$/, '');
  if (!tail.endsWith("'")) return null;
  let backslashes = 0;
  for (let index = tail.length - 2; index >= 0 && tail[index] === '\\'; index -= 1) backslashes += 1;
  if (backslashes % 2 === 1) return null;
  return {
    kind: 'script',
    at: outer.start + layer.openLen + tail.length - 1,
    layers: [layer.quote, proof.layer.quote],
  };
}

/**
 * Words appended to a launch line so a wrapper still forwards them. A wrapper that execs
 * `"$@"` (`zsh …/as-floor.sh <binary> …`) takes the words at the end of the line. A quoted
 * script that itself runs `<binary>` (`zsh -lc "grok --model …"`) would drop words written
 * after the quotes: those words go inside that script, still last, and a shell nested one level
 * deep is followed to the script it runs. The words are written so every quoting layer between
 * the line and the CLI reads them back exactly: a double-quoted script still has its text read
 * by the wrapping shell, so `\`, `"`, `$` and a backtick are escaped for it; a single-quoted
 * script takes them through the standard `'\''` splice.
 *
 * Every insertion is proved after the fact: the CLI's decoded words on the new line must be its
 * words on the old line followed by exactly the added words, in order. The separator is always a
 * literal space — a raw newline after a continuation backslash and an escaped space are not
 * separators to the inner shell, a space always is. If the line or the addition cannot be read,
 * or the words do not come back that way, the addition keeps 0.5.10's placement after the line
 * and `uncertain` reports it. This never refuses a line.
 */
function appendOnLaunchLine(
  command: string,
  addition: string,
  binary: string,
): { line: string; uncertain: boolean } {
  const trimmed = command.trimEnd();
  const placement = placementOf(binary, trimmed);
  const after = (): string => (trimmed === '' ? addition : `${trimmed} ${addition}`);
  if (placement.kind === 'uncertain') return { line: after(), uncertain: true };
  if (placement.kind === 'line') return { line: after(), uncertain: false };
  const beforeWords = cliWordListOf(binary, trimmed);
  const addedWords = shellWords(addition);
  if (beforeWords === null || addedWords === null) return { line: after(), uncertain: true };
  let text = addition;
  for (let at = placement.layers.length - 1; at >= 0; at -= 1) text = encodeForQuote(placement.layers[at]!, text);
  const line = `${trimmed.slice(0, placement.at)} ${text}${trimmed.slice(placement.at)}`;
  const afterWords = cliWordListOf(binary, line);
  const want = [...beforeWords, ...addedWords.map((word) => word.text)];
  if (afterWords === null || afterWords.length !== want.length || afterWords.some((word, at) => word !== want[at])) {
    return { line: after(), uncertain: true };
  }
  return { line, uncertain: false };
}

/** The line an addition this version can place, or null when it cannot prove the placement: a
 *  reader that records what it writes (a session id, a resume) never records one the CLI may
 *  not read. */
function placedOnLaunchLine(command: string, addition: string, binary: string): string | null {
  const placed = appendOnLaunchLine(command, addition, binary);
  return placed.uncertain ? null : placed.line;
}

/** Where a line's CLI words sit in the line's source: the innermost shell script that runs the
 *  CLI, with the span of its body text. Every layer's source must be exactly the text this
 *  reader decoded, so a position in the body is a position in the line, and every layer's body
 *  must be one simple command ({@link provenScriptWord}) — a reader that rewrites words inside a
 *  script asks the same proof a placement and a word read ask. Null when the line has no shell
 *  command string, or one this reader cannot read through. */
type CliBody = { text: string; start: number; end: number };
function cliBodyOn(binary: string, command: string): CliBody | null {
  let text = command;
  let offset = 0;
  for (let depth = 0; depth < 4; depth += 1) {
    const found = shellScriptWordOf(text);
    if (found === null) return null;
    const shell = shellProgramOf(text);
    if (shell === null || !POSIX_SHELLS.has(shell)) return null;
    // The proof every reader and every placement asks, before any span is trusted.
    const proof = provenScriptWord(text, found.word);
    if (proof === null) return null;
    // The position guard this reader needs on top: the raw source between the quotes must be
    // exactly the text this reader decoded, so a position in the body is a position in the line.
    const openAt = found.word.start + proof.layer.openLen;
    if (text.slice(openAt, found.word.end - 1) !== proof.body) return null;
    const start = offset + openAt;
    if (startsWithCli(binary, proof.body)) {
      return { text: proof.body, start, end: start + proof.body.length };
    }
    offset = start;
    text = proof.body;
  }
  return null;
}

/** The text of the innermost shell script that runs the CLI, read through the decoded words of
 *  every layer. Null when the line has no shell command string, or none this reader can follow to
 *  the CLI, and null when a script word is not proved on the line ({@link provenScriptWord}): a
 *  word the shell that parses it may rewrite, a body that is more than one simple command, or a
 *  shell whose syntax this reader does not model, names no word of this CLI, whatever its
 *  decoded words appear to say. The proof is the one the placement asks, so a reader is unknown
 *  exactly where a placement refuses. Reading needs no
 *  source positions, so a line this tool has already written into — one whose inner quotes are
 *  spliced as `'\''` — still reads exactly as the CLI receives it. */
function cliTextOf(binary: string, command: string): string | null {
  let text = command.trimEnd();
  for (let depth = 0; depth < 4; depth += 1) {
    const found = shellScriptWordOf(text);
    if (found === null) return null;
    const shell = shellProgramOf(text);
    if (shell === null || !POSIX_SHELLS.has(shell)) return null;
    const proof = provenScriptWord(text, found.word);
    if (proof === null) return null;
    if (startsWithCli(binary, proof.body)) return proof.body;
    if (found.trailing.length > 0) return null;
    text = proof.body;
  }
  return null;
}

/** The CLI's own words on a launch line, decoded by the shell at every layer: the words inside
 *  the innermost shell script that runs it, or the line's own words when there is no shell
 *  command string and the line does not swallow the rest of its text ({@link takesAppendedWord}).
 *  A shell's own options — `-c`, `-lc`, `-ec`, `-l` — are the shell's, never the
 *  CLI's, and a word after the closing quote is a positional word of the script, not the CLI's
 *  either. A shell script that runs some other program, or one this reader cannot read through,
 *  names no word of this CLI at all. A script word the shell that parses the line may rewrite —
 *  an unescaped `$` or backtick inside the double quotes the word opens with — proves no word
 *  either, and a body that is more than one simple command — a comment, an operator, a
 *  substitution, a glob — names none: the words after such a construct are not the argv the
 *  script hands its CLI. Null when the line, or the script that runs the CLI, cannot be proved
 *  ({@link provenScriptWord}, the proof a placement asks too): no caller may treat an unproved
 *  line as a word list. */
function cliWordListOf(binary: string, command: string): string[] | null {
  const trimmed = command.trimEnd();
  const lineWords = shellWords(trimmed);
  if (lineWords === null) return null;
  if (shellScriptWordOf(trimmed) === null) {
    return takesAppendedWord(trimmed) ? lineWords.map((word) => word.text) : null;
  }
  const text = cliTextOf(binary, trimmed);
  if (text === null) return null;
  const words = shellWords(text);
  return words === null ? null : words.map((word) => word.text);
}

/** The CLI's own decoded words on a launch line, as {@link cliWordListOf} reads them. Every
 *  "does the line already set this" question is asked of these words: a quoted flag name is the
 *  flag, and a quoted value is the value. Null when the line cannot be read. */
export function cliWordList(cli: string, command: string): string[] | null {
  const binary = profileFor(cli)?.binary;
  if (binary === undefined) return null;
  return cliWordListOf(binary, command);
}

/** The CLI's own words joined by one space, for a reader whose question is a text pattern. A
 *  reader that needs word boundaries asks {@link cliWordList} instead: a word with a space in it
 *  is one word there and two here. A line this reader cannot read names no words. */
export function cliWordsOf(cli: string, command: string): string {
  return cliWordList(cli, command)?.join(' ') ?? '';
}

/** Whether a decoded word names one of these flags, or one with a value attached (`--flag=…`). */
function isFlagWord(word: string, flags: readonly string[]): boolean {
  return flags.some((flag) => word === flag || word.startsWith(`${flag}=`));
}

/** Whether one of these flags is among the decoded words, bare or carrying a value. A quoted
 *  flag name is the flag, so it counts exactly as a bare one does. */
function hasFlag(words: readonly string[], flags: readonly string[]): boolean {
  return words.some((word) => isFlagWord(word, flags));
}

/** Whether a word can be a flag's value: of `shape`, and never itself an option. A value
 *  starting with `-` is the next flag, not this flag's value. */
function isFlagValue(value: string, shape: RegExp): boolean {
  return !value.startsWith('-') && shape.test(value);
}

/** The value a flag names: attached (`--flag=value`) or the next word. The first flag carrying
 *  a value of `shape` wins; null when no flag names one. An option after a flag is never its
 *  value, so `grok -r --model m` names no conversation. */
function flagValueIn(words: readonly string[], flags: readonly string[], shape: RegExp): string | null {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    for (const flag of flags) {
      if (word === flag) {
        const value = words[at + 1];
        if (value !== undefined && isFlagValue(value, shape)) return value;
      } else if (word.startsWith(`${flag}=`)) {
        const value = word.slice(flag.length + 1);
        if (isFlagValue(value, shape)) return value;
      }
    }
  }
  return null;
}

/** Where a flag's value sits in source: the flag's own word's span, the value's span, and
 *  whether the value is part of the flag's word (`--flag=value`). Spans are positions in the
 *  source the words came from; a whole word's span is used rather than an offset inside it, so a
 *  quoted flag name needs no guess about where its value begins. */
type FlagValueSite = {
  flag: string;
  value: string;
  flagStart: number;
  flagEnd: number;
  valueStart: number;
  valueEnd: number;
  attached: boolean;
};

/** The first flag on a body of decoded words whose value `wanted` accepts, attached
 *  (`--flag=value`) or the next word. */
function flagValueSite(
  words: readonly ShellWord[],
  flags: readonly string[],
  wanted: (value: string) => boolean,
): FlagValueSite | null {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    for (const flag of flags) {
      if (word.text === flag) {
        const next = words[at + 1];
        if (next !== undefined && !next.text.startsWith('-') && wanted(next.text)) {
          return {
            flag,
            value: next.text,
            flagStart: word.start,
            flagEnd: word.end,
            valueStart: next.start,
            valueEnd: next.end,
            attached: false,
          };
        }
      } else if (word.text.startsWith(`${flag}=`)) {
        const value = word.text.slice(flag.length + 1);
        if (!value.startsWith('-') && wanted(value)) {
          return {
            flag,
            value,
            flagStart: word.start,
            flagEnd: word.end,
            valueStart: word.end,
            valueEnd: word.end,
            attached: true,
          };
        }
      }
    }
  }
  return null;
}

/** The session id `--session-id` names in these decoded words. A quoted flag name and a quoted
 *  value are the flag and the value, so a declared id is seen however it is written. */
function sessionIdIn(words: readonly string[]): string | undefined {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    const value = word === '--session-id'
      ? words[at + 1]
      : word.startsWith('--session-id=') ? word.slice('--session-id='.length) : undefined;
    if (value !== undefined && !value.startsWith('-') && /^[A-Za-z0-9._-]+$/.test(value)) return value;
  }
  return undefined;
}

/** The words a launch line gives a shell, at every layer it has: the line itself, then the
 *  script word of each shell's command string, one layer deeper each time. A flag written in
 *  any of them is the line's own. A layer the tokenizer cannot read is split generously, quotes
 *  stripped, so a flag written there still suppresses a default. */
function launchWordScopes(command: string): string[][] {
  const scopes: string[][] = [];
  let text = command.trimEnd();
  for (let depth = 0; depth < 4; depth += 1) {
    const words = shellWords(text);
    if (words === null) {
      scopes.push(
        text
          .replace(/\\\n/g, '')
          .replace(/["'\\]/g, '')
          .split(/\s+/)
          .filter((word) => word !== ''),
      );
      break;
    }
    scopes.push(words.map((word) => word.text));
    const found = shellScriptWordOf(text);
    if (found === null) break;
    text = found.word.text;
  }
  return scopes;
}

/**
 * The conversation a launch line already names to resume, read from the measured grammar above:
 * the id after Claude Code's `--resume`/`-r`, the word after Codex's `resume`, the id of
 * Antigravity's `--conversation=<id>` (a separate `--conversation <id>` word is the same flag),
 * or the id after Grok's `-r` (a `--resume <id>` on that line is the same flag). Null when the
 * line names no resume at all. `''` when it resumes without naming one — `--continue`/`-c`
 * (Claude Code's most recent), `--last`, `--all` or a bare `resume` (Codex's picker), a bare
 * `--conversation`, or a bare `-r` — which cannot be told from the id a record binds. A line
 * this version does not read is null: an unmeasured form is not a resume this tool may reason
 * about. Only the CLI's own words are read — the text inside a trailing quoted script that runs
 * it when the line has one, and never the shell's own `-c`, `-lc` or `-ec` before that script.
 */
export function namedResumeTarget(cli: string, command: string): string | null {
  // The CLI's own decoded words: a quoted flag name is the flag, a quoted value is the value,
  // and the shell's own words are never the CLI's.
  const words = cliWordList(cli, command);
  if (words === null) return null;
  if (cli === 'codex') {
    const at = words.indexOf('resume');
    if (at === -1) return null;
    const next = words[at + 1];
    return next === undefined || next.startsWith('-') ? '' : next;
  }
  if (cli === 'grok') {
    const named = flagValueIn(words, ['--resume', '-r'], /^[A-Za-z0-9._:-]+$/);
    if (named !== null) return named;
    return hasFlag(words, ['--resume', '-r']) ? '' : null;
  }
  if (cli === 'antigravity') {
    const named = flagValueIn(words, ['--conversation'], /^[A-Za-z0-9._:-]+$/);
    if (named !== null) return named;
    return hasFlag(words, ['--conversation']) ? '' : null;
  }
  if (cli !== 'claude-code') return null;
  const named = flagValueIn(words, ['--resume', '-r'], /^[A-Za-z0-9._-]+$/);
  if (named !== null) return named;
  return hasFlag(words, ['--resume', '-r', '--continue', '-c']) ? '' : null;
}

/** How a launch line carries a proven conversation: the line itself when it already names that
 *  id, the line with the id appended where the CLI has a measured form and the line names none,
 *  otherwise the reason it cannot. A line naming another id — or resuming without naming one —
 *  is never rewritten: the id a file records is the file's to keep, and a relaunch that swapped
 *  it silently would resume a conversation nothing proved. */
export function resumeCarry(
  cli: string,
  command: string,
  sessionId: string,
): { kind: 'line'; line: string } | { kind: 'refuse'; why: string } {
  const named = namedResumeTarget(cli, command);
  if (named === sessionId) return { kind: 'line', line: command };
  if (named !== null) {
    return {
      kind: 'refuse',
      why: named === ''
        ? 'its launch line resumes without naming the recorded conversation'
        : 'its launch line resumes a different conversation',
    };
  }
  const line = withResume(cli, command, sessionId);
  if (line !== null) return { kind: 'line', line };
  const words = cliWordList(cli, command);
  return {
    kind: 'refuse',
    why: sessionIdIn(words ?? []) === undefined
      ? 'its launch line has no measured resume form'
      : 'its launch line already sets a new session id',
  };
}

/** True when the CLI accepts an effort override flag on its launch line. */
export function supportsEffortLaunch(cli: string): boolean {
  return cli === 'claude-code' || cli === 'antigravity' || cli === 'grok' || cli === 'codex' || cli === 'muse';
}

/** True when an effort word can exist for this CLI at all: its launch line takes one, or its
 *  screen names one (`cursor`'s row word, read in `src/labels/observe.ts`). */
export function hasEffort(cli: string): boolean {
  return supportsEffortLaunch(cli) || cli === 'cursor';
}

/** The effort word a pane's display line carries for this CLI: the seat's own word, or `default`
 *  when the seat sets none. Null when the CLI has no effort setting — the line is the display
 *  alone, with no `default` token (jules, gemini). */
export function displayEffort(cli: string, effort?: string): string | null {
  if (!hasEffort(cli)) return null;
  return effort || 'default';
}

/**
 * Resolves a `--model` value against a CLI profile. Accepts either a CLI model id
 * (`claude-sonnet-5-5`, `gpt-6-sol`, `gemini-3.1-pro`, `grok-4.7`, `composer-2.5`)
 * or a display string (`Claude Sonnet 5.5`, `GPT Sol 6`, `Gemini Pro 3.1`, `Grok 4.7`).
 */
export function resolveModelOverride(
  profile: Profile,
  rawModel: string,
  defaultVersion?: string,
): { id: string; model: string; version: string } | null {
  const trimmed = rawModel.trim();
  if (!trimmed) return null;
  const option = profile.modelFlag('', '').option;
  if (!/\s/.test(trimmed)) {
    const direct = profile.modelOf(`${option} ${trimmed}`);
    if (direct) return { id: trimmed, model: direct.model, version: direct.version };
    if (profile.cli === 'claude-code' && /^(opus|sonnet|haiku|fable)$/i.test(trimmed) && defaultVersion) {
      const candidate = `claude-${trimmed.toLowerCase()}-${defaultVersion.replaceAll('.', '-')}`;
      const hit = profile.modelOf(`${option} ${candidate}`);
      if (hit) return { id: candidate, model: hit.model, version: hit.version };
    }
    return null;
  }
  const fastGrok = /^Grok\s+(\S+)\s+Fast$/i.exec(trimmed);
  let modelName: string;
  let version: string;
  if (fastGrok && fastGrok[1]) {
    version = fastGrok[1];
    modelName = `Grok ${version} Fast`;
  } else {
    const at = trimmed.lastIndexOf(' ');
    if (at <= 0) return null;
    modelName = trimmed.slice(0, at).trim();
    version = trimmed.slice(at + 1).trim();
  }
  const flagged = profile.modelFlag(modelName, version).id;
  if (flagged) {
    const hit = profile.modelOf(`${option} ${flagged}`);
    if (hit) return { id: flagged, model: hit.model, version: hit.version };
  }
  const candidate = synthesizeModelId(profile.cli, modelName, version);
  if (!candidate) return null;
  const hit = profile.modelOf(`${option} ${candidate}`);
  return hit ? { id: candidate, model: hit.model, version: hit.version } : null;
}

function synthesizeModelId(cli: string, modelName: string, version: string): string | null {
  if (cli === 'claude-code') {
    const match = /^Claude\s+(\S+)$/i.exec(modelName);
    return match?.[1] ? `claude-${match[1].toLowerCase()}-${version.replaceAll('.', '-')}` : null;
  }
  if (cli === 'codex') {
    const match = /^GPT\s+(\S+)$/i.exec(modelName);
    return match?.[1] ? `gpt-${version}-${match[1].toLowerCase()}` : null;
  }
  if (cli === 'antigravity' || cli === 'gemini') {
    const match = /^Gemini\s+(\S+)$/i.exec(modelName);
    return match?.[1] ? `gemini-${version}-${match[1].toLowerCase()}` : null;
  }
  if (cli === 'muse') {
    const match = /^Muse\s+(Wonder(?:\s+Full)?|Spark)$/i.exec(modelName);
    return match?.[1] ? `muse-${match[1].toLowerCase().replace(/\s+/g, '-')}-${version}` : null;
  }
  if (cli === 'grok') {
    if (/Fast$/i.test(modelName)) return `grok-${version}-build-fast`;
    if (/^Grok(?:\s+\S+)?$/i.test(modelName)) return `grok-${version}`;
    return null;
  }
  if (cli === 'cursor') {
    if (/^Grok$/i.test(modelName)) return `grok-${version}`;
    if (/^GPT\s+Sol$/i.test(modelName)) return `gpt-${version}-sol`;
    if (/^Gemini\s+Flash$/i.test(modelName)) return `gemini-${version}-flash`;
    if (/^Composer$/i.test(modelName)) return `composer-${version}`;
  }
  return null;
}

/**
 * Validates a `--effort` value against the seat's CLI and vendor vocabulary.
 */
export function resolveEffortOverride(
  cli: string,
  vendor: string,
  rawEffort: string,
): { effort: string } | { error: string } {
  const trimmed = rawEffort.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return { error: 'effort must be a single word' };
  }
  if (!supportsEffortLaunch(cli)) {
    return { error: `${cli} does not take an --effort flag on launch` };
  }
  const vocab = shippedEfforts();
  if (vocab.ok) {
    const allowed = vocab.labs[vendor];
    if (allowed && allowed.length > 0 && !allowed.includes(trimmed)) {
      return { error: `effort ${JSON.stringify(trimmed)} is not one of ${vendor}'s: ${allowed.join(', ')}` };
    }
  }
  return { effort: trimmed };
}

/** One flag value a launch-line rewrite sets. `flags` are the spellings the flag may have,
 *  `wanted` decides which decoded value is this flag's (a bare model takes any), `value` is the
 *  new value, and `addition` is what a line naming no such flag takes instead. */
type FlagRewrite = {
  flags: readonly string[];
  wanted: (value: string) => boolean;
  value: string;
  addition: string;
};

/** Rewrites one of the CLI's own flags on a launch line, by decoded words: a quoted flag name is
 *  the flag and a quoted value is the value, and the flag's word in source is replaced whole, so
 *  the closing quote of a script is never touched. A line that does not set the flag takes the
 *  addition where the CLI reads it, or after the line when this version cannot prove a place; a
 *  script this version cannot read through keeps 0.5.10's append, which changes no existing word. */
function rewriteOnLaunchLine(profile: Profile, command: string, rewrite: FlagRewrite): string {
  const trimmed = command.trimEnd();
  const body = shellScriptWordOf(trimmed) === null
    ? { text: trimmed, start: 0, end: trimmed.length }
    : cliBodyOn(profile.binary, trimmed);
  if (body === null) return trimmed === '' ? rewrite.addition : `${trimmed} ${rewrite.addition}`;
  const words = shellWords(body.text);
  const site = words === null ? null : flagValueSite(words, rewrite.flags, rewrite.wanted);
  if (site !== null) {
    // An attached value is part of the flag's word, which is rewritten whole; a separate value
    // is its own word, so the flag's word stays exactly as the line wrote it.
    const [start, end, text] = site.attached
      ? [site.flagStart, site.flagEnd, `${site.flag}=${shellQuote(rewrite.value)}`]
      : [site.valueStart, site.valueEnd, shellQuote(rewrite.value)];
    return `${trimmed.slice(0, body.start + start)}${text}${trimmed.slice(body.start + end)}`;
  }
  return placedOnLaunchLine(trimmed, rewrite.addition, profile.binary)
    ?? (trimmed === '' ? rewrite.addition : `${trimmed} ${rewrite.addition}`);
}

/**
 * Rewrites or appends the CLI's model and effort flags on a seat's launch line.
 */
export function withLaunchOverrides(
  profile: Profile,
  launch: string,
  overrides: { modelId?: string; effort?: string },
): string {
  let next = launch.trim();
  if (overrides.modelId) {
    const option = profile.modelFlag('', '').option;
    const flags = profile.cli === 'codex' || profile.cli === 'grok' || profile.cli === 'gemini'
      ? ['--model', '-m']
      : ['--model'];
    // What the line already sets is read from the CLI's own decoded words, inside a quoted
    // script too, and a quoted flag name is the flag.
    next = rewriteOnLaunchLine(profile, next, {
      flags,
      wanted: () => true,
      value: overrides.modelId,
      addition: `${option} ${overrides.modelId}`,
    });
  }
  if (overrides.effort) {
    if (profile.cli === 'codex') {
      next = rewriteOnLaunchLine(profile, next, {
        flags: ['-c', '--config'],
        wanted: (value) => value.startsWith('model_reasoning_effort='),
        value: `model_reasoning_effort=${overrides.effort}`,
        addition: `-c model_reasoning_effort=${overrides.effort}`,
      });
    } else if (supportsEffortLaunch(profile.cli)) {
      next = rewriteOnLaunchLine(profile, next, {
        flags: ['--effort', '--reasoning-effort'],
        wanted: () => true,
        value: overrides.effort,
        addition: `--effort ${overrides.effort}`,
      });
    }
  }
  return next;
}

/**
 * One rule that reads a model off a line. A `status_model` rule also declares what it can read:
 * `yields` is the closed list of exact model names its templates spell, and `versionLike` the
 * version shapes it can spell them with (null: none). An id rule (`models.ids`) declares nothing —
 * `yields` is empty and `versionLike` null — because an id maps a launch, it does not read a screen.
 */
export type ModelRule = {
  match: RegExp;
  model: string;
  version: string;
  flag: string | null;
  yields: readonly string[];
  versionLike: RegExp | null;
};

type Shipped = { profile: Profile; status: ModelRule[]; quota: QuotaPattern[] };

const NAMES = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse', 'jules'] as const;
// The keys every profile carries. `status_model` and `last_used_model` are optional: a profile
// without the first belongs to a CLI whose screen doesn't show its model; the second says the
// CLI starts on its last-used model when a launch names none, and no shipped profile sets it.
// `exit` and `exit_keys` are one or the other: a CLI exits by typing a word or by a key.
// `models` is optional for a CLI that names no model on its screen or its launch line.
const LAUNCH_KEYS = ['binary', 'process_names', 'tested', 'unattended', 'rules', 'delivery', 'login', 'timeouts'] as const;
const OPTIONAL_LAUNCH_KEYS = ['exit', 'exit_keys', 'models', 'compose_module', 'status_model', 'last_used_model', 'unread_model', 'exit_clear', 'exit_confirm', 'input', 'lobby_files', 'startup_reads', 'standing_rules', 'herdr_status', 'mcp_inbox', 'not_started', 'abandon_answers'] as const;
// The keys `pane send-keys` takes that can empty an input box, one of which a profile may name
// to clear an exit text that did not read back as typed. `enter` is not among them on purpose:
// it sends what the box holds. Established by run on herdr 0.7.1 with each CLI's own box.
const CLEAR_KEYS = ['ctrl+c', 'ctrl+u', 'escape', 'backspace'] as const;
// The keys that can confirm the CLI's own exit question, one of which a profile may name as
// `exit_confirm`. Closed like CLEAR_KEYS, and only a key a run established is in it: `enter`
// confirms Claude Code 2.1.291's preselected "Exit and stop tasks" (the capture in
// test/fixtures/exit-typing/), and no other key has been observed to. `enter` is a key here and
// not above on purpose: the rule above keeps a stop from sending what an ordinary box holds;
// this one answers a question the CLI asked on its way out, on a screen read as `exit question`.
const CONFIRM_KEYS = ['enter'] as const;
// The keys a profile may name as `exit_keys`: pressed in order to exit a CLI whose idle screen
// takes no exit text. Closed like the sets above, and only a key a run established is in it:
// `ctrl+c` quits the Jules TUI from its session table (0.1.42; the footer draws `ctrl+c: quit`).
const EXIT_KEYS = ['ctrl+c'] as const;

// The keys a profile may name as `input.clear` and `input.clear_working`: the exit-clearing set
// with `ctrl+k` added, because a measured clear pair is greater than one key (codex empties one
// line per [ctrl+u, ctrl+k] pass at idle). Closed like the sets above: a key no run established
// is refused as the profile loads.
const INPUT_KEYS = ['ctrl+c', 'ctrl+u', 'ctrl+k', 'escape', 'backspace'] as const;

// The paste surfaces a profile may name as `input.paste`. Bracketed paste is the one measured:
// claude 2.1.303, codex 0.161.0 and cursor-agent 2026.10.16 each drew a pasted draft back as its
// own rows. What a delivery pastes is one row: a box drawn over more than one row cannot be told
// from a soft wrap, so it is held (see captureBox in send/deliver.ts).
const PASTE_SURFACES = ['bracketed'] as const;

/** The value of `exit_keys`: a non-empty list of the keys above, spelled as herdr spells them. */
function exitKeysOf(entry: YamlEntry): readonly string[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) {
    fail(entry.line, '"exit_keys" must be a non-empty list of keys');
  }
  return entry.value.items.map((item) => {
    const value = stringOf(item);
    if (value === null) fail(item.line, '"exit_keys" entries must be strings');
    if (!(EXIT_KEYS as readonly string[]).includes(value)) {
      fail(item.line, `"exit_keys" must hold keys among: ${EXIT_KEYS.join(', ')}`);
    }
    return value;
  });
}

/** The value of `exit_clear`: one of the keys above, spelled as herdr spells it. */
function clearKeyOf(entry: YamlEntry): string {
  const value = text(entry, 'exit_clear');
  if (!(CLEAR_KEYS as readonly string[]).includes(value)) {
    fail(entry.line, `"exit_clear" must be one of: ${CLEAR_KEYS.join(', ')}`);
  }
  return value;
}

/** One key list of the `input` block: a non-empty list of the keys above, spelled as herdr
 *  spells them. */
function inputKeysOf(entry: YamlEntry, key: string): readonly string[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) {
    fail(entry.line, `"${key}" must be a non-empty list of keys`);
  }
  return entry.value.items.map((item) => {
    const value = stringOf(item);
    if (value === null) fail(item.line, `"${key}" entries must be strings`);
    if (!(INPUT_KEYS as readonly string[]).includes(value)) {
      fail(item.line, `"${key}" must hold keys among: ${INPUT_KEYS.join(', ')}`);
    }
    return value;
  });
}

/** The value of `input`: the measured clear keys and paste surface for this CLI's box. */
function inputOf(entry: YamlEntry): InputBlock {
  const entries = mapping(entry.value, '"input"');
  only(entries, ['clear', 'clear_working', 'paste', 'mid_turn']);
  const clear = inputKeysOf(required(entries, 'clear', entry.line), 'input.clear');
  const workingEntry = optional(entries, 'clear_working');
  const clearWorking = workingEntry ? inputKeysOf(workingEntry, 'input.clear_working') : null;
  const pasteEntry = required(entries, 'paste', entry.line);
  const paste = text(pasteEntry, 'input.paste');
  if (!(PASTE_SURFACES as readonly string[]).includes(paste)) {
    fail(pasteEntry.line, `"input.paste" must be one of: ${PASTE_SURFACES.join(', ')}`);
  }
  const midTurnEntry = optional(entries, 'mid_turn');
  const midTurn = midTurnEntry ? boolOf(midTurnEntry.value, 'input.mid_turn') : false;
  if (midTurn && clearWorking === null) {
    fail(workingEntry?.line ?? entry.line, '"input.clear_working" is required when "input.mid_turn" is true');
  }
  return { clear, clearWorking, paste: paste as InputBlock['paste'], midTurn };
}

/** The value of `exit_confirm`: one of the keys above, spelled as herdr spells it. */
function confirmKeyOf(entry: YamlEntry): string {
  const value = text(entry, 'exit_confirm');
  if (!(CONFIRM_KEYS as readonly string[]).includes(value)) {
    fail(entry.line, `"exit_confirm" must be one of: ${CONFIRM_KEYS.join(', ')}`);
  }
  return value;
}

/** The value of `unread_model`: the one fallback a profile may name for a screen that names
 *  no model. `launch` shows the launch line's model, labelled; no other word is one. */
function unreadModelOf(entry: YamlEntry): 'launch' {
  const value = text(entry, 'unread_model');
  if (value !== 'launch') fail(entry.line, '"unread_model" must be launch');
  return 'launch';
}

/** The value of `delivery`: one word from the closed set, never a guess. */
function deliveryOf(entry: YamlEntry): DeliveryClass {
  const value = text(entry, 'delivery');
  if (!(DELIVERY_CLASSES as readonly string[]).includes(value)) {
    fail(entry.line, `"delivery" must be one of: ${DELIVERY_CLASSES.join(', ')}`);
  }
  return value as DeliveryClass;
}

/** The value of `herdr_status`: `reliable` (the default when the key is absent) or
 *  `unreliable`, for a CLI herdr cannot report faithfully. */
function herdrStatusOf(entry: YamlEntry): 'reliable' | 'unreliable' {
  const value = text(entry, 'herdr_status');
  if (value !== 'reliable' && value !== 'unreliable') {
    fail(entry.line, '"herdr_status" must be reliable or unreliable');
  }
  return value;
}

/**
 * The value of `lobby_files`: the exact relative paths of regular files this CLI may leave in
 * its working folder. A path is plain components — none `.`, `..` or empty, no absolute path,
 * no trailing `/`, which would declare a folder, no pattern character, which would read as a
 * glob the gate never runs — and no path may run through another, which would declare one
 * path both a file and a folder. The refusal is the profile's own, before any check of the
 * disk: a declaration is a value, not a folder.
 */
function lobbyFilesOf(entry: YamlEntry): readonly string[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) {
    fail(entry.line, '"lobby_files" must be a non-empty list');
  }
  const paths = entry.value.items.map((item) => {
    const value = stringOf(item);
    if (!value) fail(item.line, '"lobby_files" entries must be non-empty strings');
    const parts = value.split('/');
    if (value.startsWith('/') || value.endsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
      fail(item.line, `"lobby_files" holds "${value}": not a relative path of a file inside the lobby`);
    }
    // A declaration is one exact name at one exact place: the gate matches what the folder
    // holds byte for byte, so a pattern character would never be a pattern — but it would
    // read as one, and the grammar stays closed.
    if (parts.some((part) => /[*?\[]/.test(part))) {
      fail(item.line, `"lobby_files" holds "${value}": a path is one exact name, not a pattern`);
    }
    return value;
  });
  for (const one of paths) {
    for (const other of paths) {
      if (other !== one && other.startsWith(`${one}/`)) {
        fail(entry.line, `"lobby_files" holds "${one}" beside "${other}": a file and a folder cannot share a path`);
      }
    }
  }
  return paths;
}

/**
 * The value of `startup_reads`: paths this CLI reads at start. The grammar is `lobby_files`,
 * plus a trailing `/` that names a directory and every file under it. A path the grammar
 * refuses throws.
 */
function startupReadsOf(entry: YamlEntry): readonly { path: string; directory: boolean }[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) {
    fail(entry.line, '"startup_reads" must be a non-empty list');
  }
  return entry.value.items.map((item) => {
    const raw = stringOf(item);
    if (!raw) fail(item.line, '"startup_reads" entries must be non-empty strings');
    const directory = raw.endsWith('/');
    const value = directory ? raw.slice(0, -1) : raw;
    const parts = value.split('/');
    if (!value || value.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
      fail(item.line, `"startup_reads" holds "${raw}": not a relative path inside the lobby`);
    }
    if (parts.some((part) => /[*?\[]/.test(part))) {
      fail(item.line, `"startup_reads" holds "${raw}": a path is one exact name, not a pattern`);
    }
    return { path: value, directory };
  });
}

/**
 * The value of `mcp_inbox`: the team inbox's measured registration for one CLI. One of three
 * routes, never two: launch-line arguments, the CLI's own `mcp add` with the file it writes,
 * or a config file team writes itself. Both file routes carry a relative path inside the seat's
 * folder, in the `lobby_files` grammar; the launch refuses it there when git tracks it.
 */
function inboxOf(entry: YamlEntry): InboxBlock {
  const entries = mapping(entry.value, 'mcp_inbox');
  only(entries, ['launch_args', 'add', 'target', 'file']);
  const launchArgsEntry = optional(entries, 'launch_args');
  const addEntry = optional(entries, 'add');
  const targetEntry = optional(entries, 'target');
  const fileEntry = optional(entries, 'file');
  if (addEntry !== undefined && fileEntry !== undefined) {
    fail(fileEntry.line, '"mcp_inbox" registers with "add" or "file", not both');
  }
  if (addEntry !== undefined && targetEntry === undefined) {
    fail(addEntry.line, '"mcp_inbox" needs "target" beside "add": the file the command writes');
  }
  if (targetEntry !== undefined && addEntry === undefined) {
    fail(targetEntry.line, '"mcp_inbox" needs "add" beside "target"');
  }
  if (launchArgsEntry === undefined && addEntry === undefined && fileEntry === undefined) {
    fail(entry.line, '"mcp_inbox" names launch_args, add or file');
  }
  return {
    launchArgs: launchArgsEntry === undefined ? [] : strings(launchArgsEntry.value, 'launch_args'),
    add: addEntry === undefined ? null : strings(addEntry.value, 'add'),
    target: targetEntry === undefined ? null : relativeFileOf(targetEntry, 'target'),
    file: fileEntry === undefined ? null : relativeFileOf(fileEntry, 'file'),
  };
}

/** A relative path inside the seat's folder: the `lobby_files` grammar, one exact file. */
function relativeFileOf(entry: YamlEntry, key: string): string {
  const value = text(entry, key);
  const parts = value.split('/');
  if (value.startsWith('/') || value.endsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(entry.line, `"${key}" holds "${value}": not a relative path of a file inside the seat's folder`);
  }
  if (parts.some((part) => /[*?\[]/.test(part))) {
    fail(entry.line, `"${key}" holds "${value}": a path is one exact name, not a pattern`);
  }
  return value;
}

/** The `startup_reads` a profile snippet names, by the loader's own rule: for tests. */
export function startupReadsList(text: string): readonly { path: string; directory: boolean }[] {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'startup_reads');
  return entry === undefined ? [] : startupReadsOf(entry);
}

/** The `lobby_files` a profile snippet names, by the loader's own rule: for tests. A path the
 *  grammar refuses throws; an absent key reads as the empty list, as an absent optional key
 *  reads as its default. */
export function lobbyFilesList(text: string): readonly string[] {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'lobby_files');
  return entry === undefined ? [] : lobbyFilesOf(entry);
}
const SHIPPED: Record<string, Shipped> = loadShipped();

/** The profiles this version launches. A `cli` without one is reported and left out. */
export function profileFor(cli: string): Profile | null {
  return Object.hasOwn(SHIPPED, cli) ? (SHIPPED[cli]?.profile ?? null) : null;
}

/** Whether herdr cannot report this CLI's agent status faithfully, so the profile's own screen
 *  reading is the seat's state there. False for a CLI with no shipped profile, and for one whose
 *  profile trusts herdr's word. */
export function herdrUnreliable(cli: string | undefined): boolean {
  return cli !== undefined && profileFor(cli)?.herdrStatus === 'unreliable';
}

/** The files the tool itself keeps in the lobby, beside the profiles' own: the reach projection
 *  `up`, `add` and `remove` regenerate (`src/reach/projection.ts`) and the temporary its atomic
 *  write passes through. Declared below so the closed-tree gate passes a lobby holding them,
 *  whatever team runs; absent from the lobby, they cost nothing. */
export const TOOL_LOBBY_FILES: readonly string[] = [REACH_ROSTER_FILE, REACH_ROSTER_TEMP];

/** Paths a shipped CLI reads at start, one entry per path, `clis` in ship order. The lobby
 *  gate refuses these at any depth. Only a shipped profile can declare the key. */
export function shippedStartupReads(): readonly { path: string; directory: boolean; clis: readonly string[] }[] {
  const byKey = new Map<string, { path: string; directory: boolean; clis: string[] }>();
  for (const name of NAMES) {
    const profile = SHIPPED[name]?.profile;
    if (!profile) continue;
    for (const read of profile.startupReads) {
      const key = `${read.directory ? 'd' : 'f'}:${read.path}`;
      const found = byKey.get(key) ?? { path: read.path, directory: read.directory, clis: [] };
      if (!found.clis.includes(profile.cli)) found.clis.push(profile.cli);
      byKey.set(key, found);
    }
  }
  return [...byKey.values()];
}

/** What a CLI may write in the lobby: the `lobby_files` of every profile the tool ships,
 *  plus the tool's own files. The set cannot depend on which seats a run starts. Only a
 *  shipped profile can declare the key, and `TOOL_LOBBY_FILES` is a constant. */
export function shippedLobbyFiles(): readonly string[] {
  const paths = new Set<string>();
  for (const shipped of Object.values(SHIPPED)) for (const path of shipped.profile.lobbyFiles) paths.add(path);
  for (const path of TOOL_LOBBY_FILES) paths.add(path);
  return [...paths].sort();
}

/** Which shipped profiles declare each lobby file, by the profile's own `cli` name — the tool's
 *  own files name the tool. Two profiles may declare one path; the reader then names them both.
 *  For `doctor`, which says of every declared file present in the lobby whose it is. */
export function lobbyFileOwners(): ReadonlyMap<string, readonly string[]> {
  const owners = new Map<string, string[]>();
  for (const shipped of Object.values(SHIPPED)) {
    for (const path of shipped.profile.lobbyFiles) {
      const named = owners.get(path) ?? [];
      if (!named.includes(shipped.profile.cli)) named.push(shipped.profile.cli);
      owners.set(path, named);
    }
  }
  for (const path of TOOL_LOBBY_FILES) owners.set(path, ['the team tool']);
  return owners;
}

/** The quota patterns shipped with a CLI. An unknown CLI, or one with none, has an empty list. */
export function quotaFor(cli: string): readonly QuotaPattern[] {
  return SHIPPED[cli]?.quota ?? [];
}

/** Every account some shipped profile's quota patterns can read, sorted: the accounts a CLI
 *  screen on this machine can expose a figure for, whatever seats a team happens to run. An
 *  account outside this list, and outside every team's own overrides, is not readable from a
 *  CLI screen — the machine report says so in those words rather than `unknown`. */
export function shippedQuotaAccounts(): string[] {
  const names = new Set<string>();
  for (const name of NAMES) for (const one of SHIPPED[name]?.quota ?? []) names.add(one.account);
  return [...names].sort();
}

/** Patterns from a YAML list, for a profile snippet. A bad pattern throws. */
export function quotaPatterns(text: string): QuotaPattern[] {
  return quotaOf(parseYaml(text));
}

/** The `exit_clear` a profile snippet names, by the loader's own rule: for tests. A key outside
 *  the closed set throws; an absent key reads as null, as an absent optional key does. */
export function exitClearKey(text: string): string | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'exit_clear');
  return entry === undefined ? null : clearKeyOf(entry);
}

/** The `input` block a profile snippet names, by the loader's own rule: for tests. A key outside
 *  the closed sets, or a `mid_turn` with no `clear_working`, throws; an absent block reads as
 *  null, as an absent optional key does. */
export function inputBlockOf(text: string): InputBlock | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'input');
  return entry === undefined ? null : inputOf(entry);
}

/** The `exit_confirm` a profile snippet names, by the loader's own rule: for tests. A key outside
 *  the closed set throws; an absent key reads as null, as an absent optional key does. */
export function exitConfirmKey(text: string): string | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'exit_confirm');
  return entry === undefined ? null : confirmKeyOf(entry);
}

/** Quota patterns from a list already parsed. A bad pattern throws. */
export function quotaList(node: YamlNode): QuotaPattern[] {
  return quotaOf(node);
}

/** The model a status line names. `unreadable` is a line the rules claim that does not name one. */
export function statusOnLine(cli: string, line: string): { model: string; version: string } | 'unreadable' | null {
  const rules = SHIPPED[cli]?.status;
  if (!rules) return null;
  return apply(rules, line);
}

/** The `status_model` rules of a shipped CLI, in reading order. Empty for an unknown CLI. */
export function statusModelRules(cli: string): readonly ModelRule[] {
  return SHIPPED[cli]?.status ?? [];
}

/**
 * The `status_model` rules a YAML list spells, for a profile snippet. A bad rule throws, a
 * `version_like` not anchored at both ends included. A rule without the two declaration keys
 * loads as it always has: it yields no model and spells no version.
 */
export function statusModelRulesOf(text: string): ModelRule[] {
  return modelRules(parseYaml(text), 'status_model');
}

function loadShipped(): Record<string, Shipped> {
  const out: Record<string, Shipped> = {};
  for (const name of NAMES) {
    const text = readFileSync(new URL(`./${name}.yaml`, import.meta.url), 'utf8');
    const shipped = launchOf(parseYaml(text));
    if (out[shipped.profile.cli]) fail(1, `two profiles are named "${shipped.profile.cli}"`);
    out[shipped.profile.cli] = shipped;
  }
  return out;
}

function launchOf(root: YamlNode): Shipped {
  const entries = mapping(root, 'a profile');
  const format = required(entries, 'format', root.line);
  if (format.value.kind !== 'scalar' || format.value.value !== 1) fail(format.line, '"format" must be 1');
  only(entries, ['format', 'cli', 'screen', 'screen_module', 'quota', 'trust_answer', ...LAUNCH_KEYS, ...OPTIONAL_LAUNCH_KEYS]);
  const cli = text(required(entries, 'cli', root.line), 'cli');
  required(entries, 'screen', root.line);
  const quotaEntry = optional(entries, 'quota');
  const statusEntry = optional(entries, 'status_model');
  const lastUsedEntry = optional(entries, 'last_used_model');
  const unreadModelEntry = optional(entries, 'unread_model');
  const exitClearEntry = optional(entries, 'exit_clear');
  const exitConfirmEntry = optional(entries, 'exit_confirm');
  const inputEntry = optional(entries, 'input');
  const lobbyFilesEntry = optional(entries, 'lobby_files');
  const startupReadsEntry = optional(entries, 'startup_reads');
  const mcpInboxEntry = optional(entries, 'mcp_inbox');
  const exitEntry = optional(entries, 'exit');
  const exitKeysEntry = optional(entries, 'exit_keys');
  const composeEntry = optional(entries, 'compose_module');
  const standingRulesEntry = optional(entries, 'standing_rules');
  const herdrStatusEntry = optional(entries, 'herdr_status');
  const modelsEntry = optional(entries, 'models');
  const notStartedEntry = optional(entries, 'not_started');
  const abandonAnswersEntry = optional(entries, 'abandon_answers');
  for (const key of LAUNCH_KEYS) required(entries, key, root.line);
  if (exitEntry !== undefined && exitKeysEntry !== undefined) {
    fail(exitKeysEntry.line, '"exit" and "exit_keys" are one or the other, not both');
  }
  if (exitEntry === undefined && exitKeysEntry === undefined) {
    fail(root.line, 'missing "exit" or "exit_keys": a profile names how its CLI exits');
  }
  const login = loginOf(required(entries, 'login', root.line).value);
  const timeouts = required(entries, 'timeouts', root.line).value;
  const models = modelsEntry ? modelsOf(modelsEntry.value) : { option: [] as string[], ids: [] as ModelRule[], absent: null };
  const rules = rulesOf(required(entries, 'rules', root.line).value);
  return {
    profile: {
      cli,
      binary: text(required(entries, 'binary', root.line), 'binary'),
      processNames: strings(required(entries, 'process_names', root.line).value, 'process_names'),
      notStarted: notStartedEntry ? notStartedOf(notStartedEntry.value) : [],
      abandonAnswers: abandonAnswersEntry ? abandonAnswersOf(abandonAnswersEntry.value) : [],
      tested: testedOf(required(entries, 'tested', root.line).value),
      unattended: stringsOrEmpty(required(entries, 'unattended', root.line).value, 'unattended'),
      rulesOption: rules.option,
      rulesMode: rules.mode,
      rulesPrompt: rules.prompt,
      standingRules: standingRulesEntry ? strings(standingRulesEntry.value, 'standing_rules') : [],
      herdrStatus: herdrStatusEntry ? herdrStatusOf(herdrStatusEntry) : 'reliable',
      loginCheck: login.check,
      loginHint: login.hint,
      exit: exitEntry ? text(exitEntry, 'exit') : null,
      exitKeys: exitKeysEntry ? exitKeysOf(exitKeysEntry) : [],
      compose: composeEntry ? composeOf(composeEntry) : null,
      exitClear: exitClearEntry ? clearKeyOf(exitClearEntry) : null,
      exitConfirm: exitConfirmEntry ? confirmKeyOf(exitConfirmEntry) : null,
      input: inputEntry ? inputOf(inputEntry) : null,
      lobbyFiles: lobbyFilesEntry ? lobbyFilesOf(lobbyFilesEntry) : [],
      startupReads: startupReadsEntry ? startupReadsOf(startupReadsEntry) : [],
      mcpInbox: mcpInboxEntry ? inboxOf(mcpInboxEntry) : null,
      delivery: deliveryOf(required(entries, 'delivery', root.line)),
      idleTimeout: seconds(timeouts, 'idle'),
      exitTimeout: seconds(timeouts, 'exit'),
      lastUsedModel: lastUsedEntry ? boolOf(lastUsedEntry.value, 'last_used_model') : false,
      unreadModel: unreadModelEntry ? unreadModelOf(unreadModelEntry) : null,
      modelOf: (launch) => modelOf(models, launch),
      modelIdOf: (launch) => modelIdOf(models, launch),
      startsOnLastModel: models.absent === 'last-used',
      modelFlag: (model, version) => ({
        option: models.option[0] ?? '--model',
        id: suggestId(models.ids, model, version),
      }),
      answers: trustAnswers(optional(entries, 'trust_answer')),
    },
    status: statusEntry ? modelRules(statusEntry.value, 'status_model') : [],
    quota: quotaEntry ? quotaOf(quotaEntry.value) : [],
  };
}

function notStartedOf(node: YamlNode): RegExp[][] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"not_started" must be a non-empty list of rules');
  return node.items.map((item) => {
    const entries = mapping(item, 'a "not_started" rule');
    only(entries, ['all']);
    return strings(required(entries, 'all', item.line).value, 'all').map((pattern) => {
      try {
        return new RegExp(pattern, 'm');
      } catch {
        return fail(item.line, `"not_started" pattern "${pattern}" is not a valid expression`);
      }
    });
  });
}


function patternsOf(node: YamlNode, line: number, key: string): RegExp[] {
  return strings(node, key).map((pattern) => {
    try {
      return new RegExp(pattern, 'm');
    } catch {
      return fail(line, `"${key}" pattern "${pattern}" is not a valid expression`);
    }
  });
}

function abandonAnswersOf(node: YamlNode): { all: RegExp[]; keys: string[] }[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"abandon_answers" must be a non-empty list of rules');
  return node.items.map((item) => {
    const entries = mapping(item, 'an "abandon_answers" rule');
    only(entries, ['all', 'keys']);
    const keys = strings(required(entries, 'keys', item.line).value, 'keys');
    for (const key of keys) {
      if (!(ABANDON_SAFE_KEYS as readonly string[]).includes(key)) fail(item.line, `"abandon_answers" key "${key}" is not one of ${ABANDON_SAFE_KEYS.join(', ')}: an answer never picks a menu option`);
    }
    return { all: patternsOf(required(entries, 'all', item.line).value, item.line, 'all'), keys };
  });
}

/** The keys the profile answers this pane's prompt with under `--abandon`, or null. */
export function abandonAnswerKeys(profile: Profile | null, text: string | undefined): readonly string[] | null {
  if (profile === null || text === undefined) return null;
  return (profile.abandonAnswers ?? []).find((rule) => rule.all.every((pattern) => pattern.test(text)))?.keys ?? null;
}

/** Whether a pane's text is one of the profile's not-started startup screens. */
export function isNotStartedScreen(profile: Profile | null, text: string | undefined): boolean {
  if (profile === null || text === undefined || (profile.notStarted ?? []).length === 0) return false;
  return (profile.notStarted ?? []).some((rule) => rule.every((pattern) => pattern.test(text)));
}

function quotaOf(node: YamlNode): QuotaPattern[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"quota" must be a non-empty list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a quota pattern');
    only(entries, ['account', 'match', 'left', 'used', 'resets', 'window']);
    const left = optional(entries, 'left');
    const used = optional(entries, 'used');
    if (left && used) fail(left.line, 'a quota pattern has left or used, not both');
    if (!left && !used) fail(item.line, 'a quota pattern needs left or used');
    const side = left ? 'left' : 'used';
    const figure = text((left ?? used) as YamlEntry, side);
    template(figure, (left ?? used)?.line ?? item.line);
    const resetsEntry = optional(entries, 'resets');
    const resets = resetsEntry ? text(resetsEntry, 'resets') : null;
    if (resets !== null) template(resets, resetsEntry?.line ?? item.line);
    const window = text(required(entries, 'window', item.line), 'window');
    if (!(WINDOWS as readonly string[]).includes(window)) fail(item.line, '"window" must be session, daily or weekly');
    const match = required(entries, 'match', item.line);
    return {
      account: text(required(entries, 'account', item.line), 'account'),
      window: window as WindowName,
      match: pattern(text(match, 'match'), false, match.line),
      side,
      figure,
      resets,
    };
  });
}

// The flag's value is the next token, after "=" or any whitespace. The last flag in the line wins.
function modelIdOf(models: { option: string[] }, launch: string): string | null {
  let bestAt = -1;
  let id: string | null = null;
  for (const option of models.option) {
    const found = flagValue(launch, option);
    if (found && found.at > bestAt) {
      bestAt = found.at;
      id = found.id;
    }
  }
  return id;
}

function modelOf(models: { option: string[]; ids: ModelRule[] }, launch: string): { model: string; version: string } | null {
  const id = modelIdOf(models, launch);
  if (id === null) return null;
  const hit = apply(models.ids, id);
  return hit === 'unreadable' ? null : hit;
}

function flagValue(launch: string, option: string): { at: number; id: string } | null {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(\\S+)`, 'gu');
  let found: { at: number; id: string } | null = null;
  for (const match of launch.matchAll(pattern)) {
    if (match[1] === undefined || match.index === undefined) continue;
    found = { at: match.index, id: match[1] };
  }
  return found;
}

function apply(rules: ModelRule[], text: string): { model: string; version: string } | 'unreadable' | null {
  for (const rule of rules) {
    const match = rule.match.exec(text);
    if (!match) continue;
    const model = fill(rule.model, match);
    const version = fill(rule.version, match);
    // A match that cannot fill its template is a line of this shape that names no model.
    if (model === null || version === null) return 'unreadable';
    return { model, version };
  }
  return null;
}

function fill(template: string, match: RegExpMatchArray): string | null {
  let missing = false;
  const out = template.replace(/\{(\d+)(?::(title))?\}/g, (_whole, number: string, mode: string | undefined) => {
    const value = match[Number(number)];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return mode === 'title' ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : value;
  });
  return missing ? null : out;
}

function modelsOf(node: YamlNode): { option: string[]; ids: ModelRule[]; absent: string | null } {
  const entries = mapping(node, 'models');
  only(entries, ['option', 'ids', 'absent']);
  const absentEntry = optional(entries, 'absent');
  const absent = absentEntry ? text(absentEntry, 'absent') : null;
  if (absent !== null && absent !== 'last-used') fail(absentEntry?.line ?? node.line, '"absent" must be last-used');
  return {
    option: strings(required(entries, 'option', node.line).value, 'option'),
    ids: modelRules(required(entries, 'ids', node.line).value, 'ids'),
    absent,
  };
}

// The id a rule suggests for a declared model and version. A literal version suggests its flag
// only for that version; `{version}` in the flag is the seat's version. A model the rules do not
// name has no id, and the caller says so rather than guess one.
function suggestId(rules: ModelRule[], model: string, version: string): string | null {
  for (const rule of rules) {
    if (rule.flag === null || rule.model.includes('{') || rule.model !== model) continue;
    if (!rule.version.includes('{')) {
      if (rule.version !== version) continue;
      return rule.flag.replaceAll('{version}', version);
    }
    if (rule.flag.includes('{version}')) return rule.flag.replaceAll('{version}', version);
  }
  return null;
}

function modelRules(node: YamlNode, key: string): ModelRule[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  // Only a status rule declares what it reads: an id maps a launch line, it never reads a screen.
  const declares = key === 'status_model';
  return node.items.map((item) => {
    const entries = mapping(item, 'a model rule');
    only(entries, ['match', 'ignore_case', 'model', 'version', 'flag', ...(declares ? ['yields', 'version_like'] : [])]);
    const flag = optional(entries, 'ignore_case');
    const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
    const match = required(entries, 'match', item.line);
    const model = text(required(entries, 'model', item.line), 'model');
    const version = text(required(entries, 'version', item.line), 'version');
    template(model, match.line);
    template(version, match.line);
    const suggested = optional(entries, 'flag');
    const suggestedId = suggested ? text(suggested, 'flag') : null;
    if (suggested !== undefined && suggestedId !== null) {
      const rest = suggestedId.replaceAll('{version}', '');
      if (rest.includes('{') || rest.includes('}')) fail(suggested.line, 'a flag template is "{version}"');
    }
    return {
      match: pattern(text(match, 'match'), ignoreCase, match.line),
      model,
      version,
      flag: suggestedId,
      yields: declares ? yieldsOf(optional(entries, 'yields')) : [],
      versionLike: declares ? versionLikeOf(optional(entries, 'version_like')) : null,
    };
  });
}

/**
 * The model names a rule declares it reads. Absent: none — a rule that names no model on purpose
 * says so by leaving the key out or giving the empty list, and both read as yielding nothing.
 * A name twice is refused: the list is a closed set, and a repeat can only be a mistake.
 */
function yieldsOf(entry: YamlEntry | undefined): string[] {
  if (!entry) return [];
  if (entry.value.kind !== 'seq') fail(entry.line, '"yields" must be a list of model names');
  const names: string[] = [];
  for (const item of entry.value.items) {
    const name = stringOf(item);
    if (!name) fail(item.line, '"yields" entries must be non-empty strings');
    if (names.includes(name)) fail(item.line, `"yields" lists ${JSON.stringify(name)} twice`);
    names.push(name);
  }
  return names;
}

/**
 * The version shapes a rule can spell. A plain source, kept anchored at both ends so it can only
 * describe a whole version — `5.5` is one, `5.5.1x` is not — and a source that cannot compile is
 * refused here, where the file's line is still known. Absent: the rule spells no version.
 */
function versionLikeOf(entry: YamlEntry | undefined): RegExp | null {
  if (!entry) return null;
  const source = text(entry, 'version_like');
  if (!source.startsWith('^') || !source.endsWith('$')) {
    fail(entry.line, '"version_like" must be anchored at both ends: start with "^" and end with "$"');
  }
  try {
    return new RegExp(source, 'u');
  } catch {
    fail(entry.line, '"version_like" must be a regular expression');
  }
}

function template(text: string, line: number): void {
  const rest = text.replace(/\{(\d+)(?::title)?\}/g, '');
  if (rest.includes('{') || rest.includes('}')) fail(line, 'a template is "{n}" or "{n:title}"');
}

function rulesOf(node: YamlNode): { mode: 'option' | 'message' | 'prepend'; option: string | null; prompt: string | null } {
  if (node.kind === 'scalar' && node.value === 'first-message') return { mode: 'message', option: null, prompt: null };
  if (node.kind === 'scalar' && node.value === 'prepend') return { mode: 'prepend', option: null, prompt: null };
  const entries = mapping(node, 'rules');
  only(entries, ['option', 'launch_prompt']);
  const prompt = optional(entries, 'launch_prompt');
  if (prompt !== undefined) {
    if (optional(entries, 'option') !== undefined) fail(prompt.line, '"option" and "launch_prompt" are one or the other, not both');
    const word = text(prompt, 'launch_prompt');
    return { mode: 'message', option: null, prompt: word === 'positional' ? '' : word };
  }
  return { mode: 'option', option: text(required(entries, 'option', node.line), 'option'), prompt: null };
}

/** The value of `compose_module`: a module shipped beside the profiles whose `compose` export
 *  drives a typed delivery, loaded by the same path rules as `screen_module`. */
function composeOf(entry: YamlEntry): ComposeProfile {
  const specifier = text(entry, 'compose_module');
  const mod = loadProfileModule(specifier, undefined, entry.line, null, 'compose_module');
  if (typeof mod.compose !== 'function') {
    fail(entry.line, `profile: "compose_module" module "${specifier}" exports no "compose" function`);
  }
  const repos = mod.reposArgs;
  if (repos !== undefined && (!Array.isArray(repos) || repos.some((arg: unknown) => typeof arg !== 'string'))) {
    fail(entry.line, `profile: "compose_module" module "${specifier}" exports "reposArgs" that is not a list of strings`);
  }
  return { module: specifier, compose: mod.compose as ComposeProfile['compose'], repos: (repos as string[] | undefined) ?? [] };
}

function loginOf(node: YamlNode): { check: string[] | null; hint: string } {
  const entries = mapping(node, 'login');
  only(entries, ['check', 'hint']);
  const check = optional(entries, 'check');
  return {
    check: check ? strings(check.value, 'check') : null,
    hint: text(required(entries, 'hint', node.line), 'hint'),
  };
}

function testedOf(node: YamlNode): { from: string; to: string } {
  const entries = mapping(node, 'tested');
  only(entries, ['from', 'to']);
  return { from: text(required(entries, 'from', node.line), 'from'), to: text(required(entries, 'to', node.line), 'to') };
}

function seconds(node: YamlNode, key: string): number {
  const entries = mapping(node, 'timeouts');
  only(entries, ['idle', 'exit']);
  const value = text(required(entries, key, node.line), key);
  const match = /^([0-9]+)s$/.exec(value);
  if (!match || match[1] === undefined) fail(node.line, `"${key}" is a number of seconds, written "90s"`);
  return Number(match[1]);
}

function pattern(source: string, ignoreCase: boolean, line: number): RegExp {
  try {
    return compilePattern(source, ignoreCase);
  } catch (error) {
    if (error instanceof DialectError) fail(line, error.message);
    throw error;
  }
}

function strings(node: YamlNode, key: string): string[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  return stringsOrEmpty(node, key);
}

// A list a profile may carry empty: `unattended: []` is how a CLI whose own screens gate
// nothing is spelled. Every other list a profile declares names at least one value.
function stringsOrEmpty(node: YamlNode, key: string): string[] {
  if (node.kind !== 'seq') fail(node.line, `"${key}" must be a list`);
  return node.items.map((item) => {
    const value = stringOf(item);
    if (!value) fail(item.line, `"${key}" entries must be non-empty strings`);
    return value;
  });
}

function text(entry: YamlEntry, key: string): string {
  const value = stringOf(entry.value);
  if (!value) fail(entry.line, `"${key}" must be a non-empty string`);
  return value;
}

function boolOf(node: YamlNode, key: string): boolean {
  if (node.kind !== 'scalar' || typeof node.value !== 'boolean') fail(node.line, `"${key}" must be true or false`);
  return node.value;
}

function stringOf(node: YamlNode): string | null {
  if (node.kind !== 'scalar' || typeof node.value !== 'string' || node.value === '') return null;
  return node.value;
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}

/**
 * Whether the conversation a resume line names is on disk for its CLI, read before the line
 * runs: a resume of a conversation the CLI never wrote stops at the CLI's own error and leaves
 * the pane at its shell. Claude Code keeps each conversation as
 * `<config>/projects/<cwd with every non-alphanumeric character as "-">/<id>.jsonl`, written on
 * the conversation's first turn (measured on the owner's Mac: a `--session-id` launch that never
 * took a turn left no file, and `claude --resume <id>` then said "No conversation found with
 * session ID"). Null for a CLI whose store is not measured: the resume goes ahead as before.
 */
export function conversationOnDisk(cli: string, cwd: string, id: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (cli !== 'claude-code' || id === '' || cwd === '') return null;
  const config = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
  return existsSync(join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`));
}

/** The same launch line without its resume, for a CLI whose resume form is measured as a flag
 *  and its id (`--resume <id>` / `-r <id>`, Claude Code). Null where it is not. A resume inside
 *  a trailing quoted script is stripped there and the quotes stay: a word after the closing
 *  quote is the script's positional word, not the CLI's. */
export function withoutResume(cli: string, command: string): string | null {
  if (cli !== 'claude-code') return null;
  const trimmed = command.trimEnd();
  // A line whose quoting never closes has no knowable words: nothing may be stripped from it.
  if (shellWords(trimmed) === null) return null;
  const body = shellScriptWordOf(trimmed) === null
    ? { text: trimmed, start: 0, end: trimmed.length }
    : cliBodyOn('claude', trimmed);
  // A script this version cannot read through keeps its words: a resume is never stripped from
  // text whose quoting is not proved.
  if (body === null) return null;
  const words = shellWords(body.text);
  if (words === null) return null;
  // A quoted flag name is the flag and a quoted id is the id: the resume is found in the body's
  // decoded words, and removed by its source span.
  const site = flagValueSite(words, ['--resume', '-r'], (value) => /^[A-Za-z0-9._-]+$/.test(value));
  if (site === null) return null;
  // Remove the resume and one run of spaces or tabs beside it, leaving every other character of
  // the body — quotes, escapes and spacing elsewhere — exactly as it was.
  let start = site.flagStart;
  let end = site.attached ? site.flagEnd : site.valueEnd;
  while (start > 0 && (body.text[start - 1] === ' ' || body.text[start - 1] === '\t')) start -= 1;
  if (start === site.flagStart) {
    while (end < body.text.length && (body.text[end] === ' ' || body.text[end] === '\t')) end += 1;
  }
  const stripped = `${body.text.slice(0, start)}${body.text.slice(end)}`;
  if (body.start === 0 && body.end === trimmed.length) return stripped.trimEnd();
  // The resume is a plain word in the script's body: strip it there and leave the line's own
  // quoting as it was.
  return `${trimmed.slice(0, body.start)}${stripped}${trimmed.slice(body.end)}`;
}

/** The screen a resume of a missing conversation leaves (Claude Code 2.1.x: "No conversation
 *  found with session ID: <id>", then the shell). */
export function conversationMissingOnScreen(cli: string, screen: string): boolean {
  return cli === 'claude-code' && /No conversation found with session ID/.test(screen);
}

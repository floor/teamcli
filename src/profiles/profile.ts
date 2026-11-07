// A launch profile, read from the CLI's YAML file. The screen is loaded separately.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REACH_ROSTER_FILE, REACH_ROSTER_TEMP } from '../reach/rules.ts';
import type { SessionCliSpec } from '../send/session-cli.ts';
import { pinnedWords } from '../launch/features.ts';
import {
  appendOnLaunchLine,
  appendPositionalOnLaunchLine,
  cliBodyOn,
  cliWordListOf,
  isShellName,
  lineDelimiterRisk,
  placedOnLaunchLine,
  plainBodyOf,
  provenScriptWord,
  shellScriptWordOf,
  takesAppendedWord,
} from '../launch/cli-scope.ts';
import { DialectError, compilePattern } from '../watch/dialect.ts';
import { loadProfileModule } from './module-loader.ts';
import type { ComposeProfile } from './compose.ts';
import { shippedEfforts } from './efforts.ts';
import { WINDOWS, type QuotaPattern, type WindowName } from './quota.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';
import { MESSAGE_HINT_MAX } from '../settings/message-display.ts';
import { trustAnswers, type TrustRecord } from './trust-answer.ts';
import { shellWords, type ShellWord } from '../launch/shell-words.ts';
import { questionAnswers, type QuestionAnswerRecord } from './question-answer.ts';

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
/** A model id a vendor offers, with the model and version the seat row records. */
export type VendorModel = { id: string; model: string; version: string; display: string };

/** One provider a CLI can run on: the env words it reads for that provider, the credential item
 *  the machine must hold, and the models the provider offers. Only the adapter that owns the
 *  credential store's naming declares one. */
export type VendorBlock = {
  name: string;
  /** The item this provider's key lives under, in the store the credentials block names. */
  credential: string;
  /** Whole shell words the CLI reads: each one variable assignment, with `{model}` and
   *  `{credential}` filled from the chosen model and the item. */
  env: readonly string[];
  models: readonly VendorModel[];
};

/** The credential store a profile's vendors read: an attribute-only presence check, and the
 *  one-time command a refusal prints — never a secret value and never a prompt. */
export type CredentialsBlock = {
  /** The lookup's program and its words, before `-s <item> -a <account>`: no `-w`, so the
   *  secret is never asked for and never reaches an argument list. */
  check: readonly string[];
  /** The add command, with `{item}` where the item's name goes. The store asks for the secret
   *  itself: nothing is read from stdin, so nothing lands in a shell history. */
  add: string;
  /** What the store answers when the item is not there. */
  missingStatus: number;
};

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
  /** The one feature set every seat of this CLI's launch pins, as `name=value` pairs. Empty for a
   *  CLI whose launch carries none. The pins ride after the seat's own line, so the CLI's own
   *  last-wins config rule makes them the effective values: a seat and the shared background
   *  server it joins then present the same set, whichever value its config file holds. */
  features: readonly string[];
  /** The option that carries the rules, or null when they go as a first message or are
   *  prepended to each brief. */
  rulesOption: string | null;
  /** How the rules reach the seat: as a launch option, as its first message, or prepended to
   *  every brief a send types into its pane. A seat with no standing session — a fresh one per
   *  brief, like the Jules TUI's — has nowhere to keep a first-message line, so its profile
   *  says `prepend`. */
  rulesMode: 'option' | 'message' | 'prepend';
  /** Whether a seat of this CLI is public-only: the team's rules are never prepended to its
   *  briefs, a send scans the whole body with the machine's private lists before the CLI's
   *  session call, and the session's target repository must be proven public by one read of the
   *  forge's own record, so nothing private reaches a public service. False when the profile says
   *  nothing; a team file may mark one seat so (`public_only: true`). */
  publicOnly: boolean;
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
  /** The CLI's own session call, when it creates a remote session from argv and takes the brief
   *  as one argument (the `session` delivery leg), or null when no run measured one. See
   *  SessionCliSpec. */
  sessionCli: SessionCliSpec | null;
  /** The one key that empties the CLI's input box, sent to clear an exit text that did not
   *  read back as typed. Null when no key is established for this CLI: the text is left. */
  exitClear: string | null;
  /** The one key that confirms the CLI's own question after the exit text — its "stop tasks and
   *  exit" one, read as `exit question`. Sent by a stop, and only on that screen; null when no
   *  key is established for this CLI: a seat that asks the question is one that could not be
   *  stopped by asking. */
  exitConfirm: string | null;
  /** Whether the CLI draws its own completion row for the exit text inside the box, so the exit
   *  typing has to wait for that row to settle and an Enter that lands early is drawn as a typed
   *  newline. False where no capture shows one. */
  exitCompletion: boolean;
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
  /** A session-settings option the launch carries, with `{cwd}` filled from the seat's own
   *  launch folder. Null when the CLI takes none. */
  settings: SettingsBlock | null;
  /** The one wake a send may type into this CLI's pane, when the profile declares one
   *  (`typed_wake`). Null, the default, keeps the no-pane-messaging rule: the typed leg never
   *  runs for this CLI. `screen` means one trigger line into an empty idle box the send saw on
   *  two reads, and `delivered` only when the profile's own working screen shows — see
   *  src/send/typed-wake.ts. */
  typedWake: TypedWake | null;
  /** The space between the typed wake's two opening reads, in milliseconds, when the profile
   *  names one (`typed_wake_settle_ms`); null, the default, is the measured
   *  `WAKE_IDLE_SETTLE_MS`. A declared value is never under `WAKE_IDLE_SETTLE_FLOOR_MS`: two
   *  reads closer than one host read cannot catch a screen that changed between them. */
  typedWakeSettleMs: number | null;
  /** The words a typed wake appends after the message's header, so the woken seat takes its
   *  fastest read path: a profile whose seats carry an MCP inbox names the inbox tool, and one
   *  without keeps the shipped sentence. Null, the default, is the shipped
   *  `Read it with: team drops --read.` (src/settings/message-display.ts). */
  readHint: string | null;
  /** How the typed wake is handed to the pane. Null types the line and presses Enter.
   *  `agent-prompt` asks `herdr agent prompt` instead, and still waits for the working screen. */
  wake: WakeWay | null;
  /** Whether the watch's unread pass may type the same wake a send types, when a message has
   *  gone unread past its window. On by default exactly where the profile declares
   *  `typed_wake`; a profile may turn it off (`watch_wake: off`), and may not turn it on
   *  without one. A seat turns it off for itself in the team file. */
  watchWake: boolean;
  /** How many typed wake attempts one message gets from the watch's unread pass, the first at
   *  the window and each later one after a backoff. A bound, never a loop. */
  watchWakeTries: number;
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
  /** The providers this CLI can run on, as the adapter names them; empty when it names none, and
   *  the seats of such a CLI move between providers only by copying a seat. */
  vendors: readonly VendorBlock[];
  /** The credential store the vendor items live in, or null when the profile declares no vendors:
   *  nothing reads a store the profile has not named. */
  credentials: CredentialsBlock | null;
  /** Trust-answer records. Empty when this version sends no trust key for the CLI. */
  answers: readonly TrustRecord[];
  /** The keys this profile presses to dismiss a dialog of each kind, per version. Empty when it
   *  answers none — the answer layer then refuses the seat rather than guessing a key. */
  questionAnswers: readonly QuestionAnswerRecord[];
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

/** The one wake a send may type, when a profile declares `typed_wake`. `screen` is the measured
 *  Muse wake: one trigger line into an empty idle box seen on two reads, and `delivered` only
 *  when the profile's working screen shows (src/send/typed-wake.ts). */
export type TypedWake = 'screen';

/** The typed wakes a profile may declare: a closed set, never a guess. */
export const TYPED_WAKES = ['screen'] as const;

/** How a profile's typed wake is handed to the pane. Absent, the wake types the line and
 *  presses Enter. `agent-prompt` asks `herdr agent prompt` and does not type or press Enter. */
export type WakeWay = 'agent-prompt';

/** The wake hands a profile may declare. */
export const WAKE_WAYS = ['agent-prompt'] as const;

/** The most typed wake attempts the watch's unread pass gives one message: a bound, so a
 *  wake that never lands is a few tries and a report, never a loop. */
export const MAX_WATCH_WAKE_TRIES = 10;

/** The attempts one message gets when a profile names no `watch_wake_tries`. */
export const DEFAULT_WATCH_WAKE_TRIES = 3;

/** The floor under `typed_wake_settle_ms`: the wake's two opening reads are the guard, and two
 *  reads less than one host read on a loaded host apart (~52.7 ms measured) cannot catch a screen
 *  that changed between them. The loader refuses a profile under it, and the walk clamps at it. */
export const WAKE_IDLE_SETTLE_FLOOR_MS = 150;

/** How long the typed wake waits between its two opening reads when a profile names no
 *  `typed_wake_settle_ms`: the measured floor, one host read plus the room the CLI needs to draw.
 *  The native `SETTLE_MS` (1000) was never measured for this path. */
export const WAKE_IDLE_SETTLE_MS = 150;

/** The team inbox's registration for one CLI, as a run measured it. */
export type InboxBlock = {
  /** Launch-line arguments, appended when a seat launches. `{seat}`, `{session}`, `{command}`
   *  and `{entry}` are filled from the launch; `{command_json}`, `{entry_json}` and
   *  `{seat_json}` are the same values escaped for a double-quoted string inside a structured
   *  word; `{file_args}` is the team file's `--file` pair as array elements inside such a
   *  word, and nothing when the launch read no file; `{session_args}` is the `--session` pair,
   *  written only when the launch read no file (the registry's own way of naming the team).
   *  Empty when the CLI takes none. */
  launchArgs: readonly string[];
  /** The CLI's own project-scope `mcp add` subcommand arguments, run in the seat's folder at
   *  launch. Null when the CLI has no measured add command. */
  add: readonly string[] | null;
  /** The file `add` writes, relative to the seat's folder. Null without `add`. */
  target: string | null;
  /** A config file team writes itself, relative to the seat's folder. Null when team writes
   *  none: the CLI's own command writes it, or no file is involved. */
  file: string | null;
  /** The CLI's own command that removes this seat's entry from its user-level store, run by
   *  `team down` for a seat it closes. Null when the route leaves nothing behind to remove:
   *  a project file, a launch-line argument, or a user-level route with no measured remove. */
  remove: readonly string[] | null;
};

/** A session-settings option and the value it carries. `{cwd}` in the value is the seat's own
 *  launch folder, escaped as the inside of a JSON string: Antigravity's `--settings` takes one
 *  inline JSON object, and `trustedWorkspaces` there is an array of absolute paths. */
export type SettingsBlock = { option: string; value: string };

/** What a launch fills into the profile's `mcp_inbox` words. `command` and `entry` are this
 *  install's runner — the executable and its entry script — which reach the inbox server
 *  whether or not `team` is on the PATH. `file` is the team file the launch read, when it read
 *  one: the server resolves the team from it, whatever folder it starts in. */
export type InboxPlace = { seat: string; session: string; command: string; entry: string; file?: string; epoch?: string };

/**
 * This seat's own entry name in a CLI's user-level MCP store:
 * `team-inbox-<session>-<seat>-<hash>`. A CLI whose store is shared by every team on the machine
 * needs the session and the seat in the name, so two seats and two teams never overwrite each
 * other's entry; the characters a team or seat name may not use are folded to `-`, so the name
 * survives any store's parser.
 *
 * The folded parts are readable but not one-to-one — `red-team` with `writer` and `red` with
 * `team-writer` fold alike — so a short hash of the exact pair follows them: pairs a store could
 * confuse stay distinct entries.
 */
export function inboxEntryName(session: string, seat: string): string {
  const slug = (value: string): string => {
    const folded = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return folded === '' ? 'x' : folded;
  };
  const digest = createHash('sha256').update(`${session}\u0000${seat}`).digest('hex').slice(0, 8);
  return `team-inbox-${slug(session)}-${slug(seat)}-${digest}`;
}

/** A profile word with the launch's own values filled in.
 *
 *  `{file_args}` is for a launch-line route whose word holds the server's arguments inside a
 *  structured string (codex's `mcp_servers.team_inbox.args=[...]`): it is the `--file` pair as
 *  array elements, the path escaped as a JSON string (which is also a TOML basic string), and
 *  nothing at all when the launch named no team file. `{epoch_args}` is the same for the runtime
 *  epoch the seat's brief was delivered under, and nothing when this launch has no claim. A whole `{file}` word is for a command's
 *  own argv (`mcp add`), where the pair is two words and the shell never sees them.
 *
 *  `{session_args}` is that array form for the launch's own session, and only when the launch
 *  named no team file: a registry team's server resolves its team from the registry by seat and
 *  session, and the session is what tells two teams holding the same seat name apart. A named
 *  file's own session is the team's, so the word is nothing there, and that line stays
 *  byte-identical to the one it always carried.
 *
 *  `{command_json}`, `{entry_json}` and `{seat_json}` are the same values escaped for a
 *  double-quoted string inside such a structured word, for the profile that supplies the
 *  quotes: a quote or a backslash in a path stays part of the value. The plain forms stay raw
 *  for argv words (`mcp add`), where no escaping belongs.
 *
 *  `{inbox}` is this seat's own entry name in a CLI's user-level store
 *  (`inboxEntryName`): the launch registers that entry, and `team down` removes it by the
 *  same name. */
export function fillInboxPlace(text: string, place: InboxPlace): string {
  const inside = (value: string): string => JSON.stringify(value).slice(1, -1);
  // The replacements are functions: a value holding `$&`, `$'`, `` $` `` or `$$` is a path a
  // profile must fill, never a replacement pattern.
  return text
    .replaceAll('{inbox}', () => inboxEntryName(place.session, place.seat))
    .replaceAll('{seat}', () => place.seat)
    .replaceAll('{session}', () => place.session)
    .replaceAll('{command}', () => place.command)
    .replaceAll('{entry}', () => place.entry)
    .replaceAll('{command_json}', () => inside(place.command))
    .replaceAll('{entry_json}', () => inside(place.entry))
    .replaceAll('{seat_json}', () => inside(place.seat))
    .replaceAll('{session_args}', () => (place.file === undefined ? `,"--session",${JSON.stringify(place.session)}` : ''))
    .replaceAll('{file_args}', () => (place.file === undefined ? '' : `,"--file",${JSON.stringify(place.file)}`))
    .replaceAll('{epoch_args}', () => (place.epoch === undefined ? '' : `,"--epoch",${JSON.stringify(place.epoch)}`));
}

/** Add defaults as complete options: a line's own flag keeps its value, including when the
 *  flag uses an alias or the value is joined with `=` or attached to a short flag. The line is
 *  read as its shells split it, at every layer — a quoted script included — so a flag inside a
 *  prompt or config value is one word with the value and does not suppress a default, and a
 *  flag whose name is quoted (`"--sandbox"`) is still the flag the CLI reads. */
function unattendedOptions(profile: Profile, launch: string): string[] {
  // A wrapper's CLI is read inside its trailing quoted script: a `zsh -lc "codex --sandbox
  // read-only"` line set its own sandbox, and adding the profile's default would widen it. The
  // words are the decoded ones, so a quoted flag name still reads as a flag.
  const flags = new Set<string>();
  for (const words of launchWordScopes(launch)) {
    for (const word of words) {
      if (word === '--') break;
      if (word.startsWith('-')) flags.add(optionKey(profile.cli, word));
    }
  }
  const options: string[] = [];
  for (let i = 0; i < profile.unattended.length; i++) {
    const flag = profile.unattended[i]!;
    const next = profile.unattended[i + 1];
    const value = !flag.includes('=') && next !== undefined && !next.startsWith('-') ? next : undefined;
    if (!flags.has(optionKey(profile.cli, flag))) {
      options.push(flag);
      if (value !== undefined) options.push(value);
    }
    if (value !== undefined) i++;
  }
  return options;
}

/** The long name of one option word, so an alias and the option it stands for are one key. */
function optionKey(cli: string, word: string): string {
  const aliases: Record<string, string> = cli === 'codex'
    ? { '-a': '--ask-for-approval', '-s': '--sandbox' }
    : {};
  const flag = word.split('=', 1)[0]!;
  const alias = aliases[flag];
  if (alias !== undefined) return alias;
  // A codex short option takes its value attached as well: measured on codex-cli 0.161.0,
  // `codex -abogus --version` exits 2 with "invalid value 'bogus' for '--ask-for-approval
  // <APPROVAL_POLICY>'" and `codex -aon-request -sworkspace-write completion bash` exits 0.
  const attached = /^-([as]).+$/.exec(flag);
  return (attached === null ? undefined : aliases[`-${attached[1]!}`]) ?? flag;
}

/**
 * The command a seat's pane runs: the unattended flag in its environment, the
 * file's launch line, then the profile's options and, where the CLI takes
 * them at launch, the rules. A CLI that loads a per-launch settings file also
 * gets that file, named at the end, unless its launch line already names one.
 * A launch with a place adds the profile's measured team-inbox arguments.
 * A launch line whose last word is a quoted script that runs the CLI takes the
 * options inside that script, where the CLI reads them, exactly as a carried
 * resume and a minted session id do. A line that names a positional delimiter
 * takes the options before it, where the CLI still reads them as options, and
 * the line's own words after the delimiter keep their place. A line whose shape
 * this version cannot prove keeps 0.5.10's placement, the options after the
 * line, and says so through `warn`. Two lines are refused rather than launched
 * with the profile's words where the CLI does not read them: one that hands its
 * CLI a word the shell computes — a substitution, a backtick or an unquoted
 * `$name` at or after the command word — or one this reader cannot read to its
 * end whose unread part holds a `--` in any quoting, a backslash or an ANSI-C
 * opening — anything that can spell the CLI's delimiter (`lineDelimiterRisk`) —
 * because every word written after it would be prompt text; and one whose rules
 * line cannot be placed inside it once its options have been. Every other line
 * keeps the old placement with its notice.
 * A sandbox profile is named only when the caller wrote one for this launch and
 * the line names none of its own: the file's choice of profile stands.
 */
export function launchCommandOrRefusal(
  profile: Profile,
  launch: string,
  rules: string,
  cliHook?: string | null,
  place?: InboxPlace,
  displayName?: string,
  runtimePolicies?: { codexDaemon?: 'on' | 'off' },
  rulesLine?: string,
  warn?: (text: string) => void,
  /** The seat's absolute launch folder, filled into a profile settings value's `{cwd}`. Absent:
   *  a profile with settings contributes none, so a caller that launches nothing names no
   *  folder. */
  cwd?: string,
  /** The Grok sandbox profile this run wrote for the seat, named only when the line names none
   *  of its own (`--sandbox`): the file's choice of profile stands. */
  sandboxProfile?: string,
  /** Whether the caller will launch this line. One that will not (a running seat's pane read)
   *  takes 0.5.10's placement even where a launch would be refused: nothing runs it. */
  launching = true,
): { command: string; refusal?: string } {
  // A word the shell computes may be the CLI's delimiter, and a line this reader cannot read to
  // its end may name one in the part it cannot see. Words written after such a line reach the
  // CLI as prompt text, not options, so the launch is refused rather than launched with its
  // configuration misplaced.
  if (launching && lineDelimiterRisk(launch)) {
    return {
      command: '',
      refusal: 'its launch line computes a word where it runs the CLI, or cannot be read where it names, or may name, the CLI\'s delimiter; words added after it would be read as prompt text, not options',
    };
  }
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
  if (sandboxProfile !== undefined && sandboxProfile !== '' && !sets(['--sandbox'], /(^|\s)--sandbox(=|\s|$)/)) {
    options.push('--sandbox', sandboxProfile);
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
  // The CLI's session settings, with the seat's own folder filled in. Antigravity's
  // `--settings` is one inline JSON object, taken for this session only and never saved (its
  // `--help` says so; measured on 1.4.12), and `trustedWorkspaces` there is an array of
  // absolute paths that pre-answers the trust dialog. A line that names its own `--settings`
  // keeps it: the seat's file is the caller's, and nothing is appended.
  if (profile.settings !== null && cwd !== undefined && !/(^|\s)--settings(=|\s|$)/.test(launch)) {
    options.push(
      profile.settings.option,
      // A function replacement: a folder holding `$&`, `$'`, `` $` `` or `$$` is a path, never a
      // replacement pattern.
      profile.settings.value.replaceAll('{cwd}', () => JSON.stringify(cwd).slice(1, -1)),
    );
  }
  if (cliHook !== undefined && cliHook !== null && supportsCliHook(profile.cli)
    && !sets(['--settings'], /(^|\s)--settings(=|\s|$)/)) {
    options.push('--settings', cliHook);
  }
  // The profile's pinned feature set rides after every word the seat's own line carries, ahead
  // of a first-message seat's rules line, which is positional. The CLI reads the last value for
  // a repeated config key (measured on codex-cli 0.161.0 in a scratch CODEX_HOME: a duplicated
  // `-c` for one key took the last value in both orders), so the pin is the seat's effective
  // value whichever its config file holds, and every seat of the CLI presents the same set to
  // the one background server they share.
  options.push(...pinnedWords(profile.features));
  // A first-message seat's rules line rides the launch as the CLI's initial prompt, last, so it
  // is never typed into the pane. It is positional: it stays after the line's own `--`, where a
  // message-mode CLI reads its prompt, never among the options before the delimiter.
  const positional: string[] = [];
  if (rulesLine !== undefined && profile.rulesMode === 'message' && profile.rulesPrompt !== null) {
    if (profile.rulesPrompt !== '') positional.push(profile.rulesPrompt);
    positional.push(rulesLine);
  }
  // The profile's options are options: they stand before the CLI's first positional delimiter,
  // wherever the CLI's words are — on a plain line, after a wrapper, or inside a quoted script
  // that runs the CLI, where the outer shell's own word scan never sees that delimiter.
  // A line whose shape this version cannot prove keeps 0.5.10's placement after the line, and
  // the seat says so.
  const trimmed = launch.trim();
  const addition = options.map(shellQuote).join(' ');
  const optioned = addition === ''
    ? { line: trimmed, uncertain: false }
    : appendOnLaunchLine(trimmed, addition, profile.binary);
  const placed = positional.length === 0
    ? optioned
    : appendPositionalOnLaunchLine(optioned.line, positional.map(shellQuote).join(' '), profile.binary);
  // Once the options were placed inside the line, a rules line that cannot be placed there too
  // is refused: the fallback writes it after the line, where this launch's CLI does not read
  // it, and a seat that carries rules must not launch without them. A line where the options
  // themselves were not placed keeps 0.5.10's placement and says so below.
  if (launching && addition !== '' && !optioned.uncertain && positional.length > 0 && placed.uncertain) {
    return {
      command: '',
      refusal: 'its rules line cannot be placed inside its launch line after its profile options were, and the CLI would not read it',
    };
  }
  // Both are said when both are true: an unreadable line leaves the options after it and the
  // rules line there too, and the seat names each word it could not place.
  if (optioned.uncertain) {
    warn?.('its launch line could not be read to its end; its profile options are after the line, where the CLI may not read them');
  }
  if (positional.length > 0 && placed.uncertain) {
    warn?.('its launch line could not be read to its end; its rules line is after the line, where the CLI may not read it');
  }
  return { command: ['AGENT_UNATTENDED=1', placed.line].join(' ') };
}

/** The command alone, as 0.5.10 built it: for a caller that is not launching this line (a
 *  running seat's pane read). A launch asks {@link launchCommandOrRefusal}, which reports a
 *  line it must not launch instead. */
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
  cwd?: string,
  sandboxProfile?: string,
): string {
  return launchCommandOrRefusal(profile, launch, rules, cliHook, place, displayName, runtimePolicies, rulesLine, warn, cwd, sandboxProfile, false).command;
}

/** True when the CLI loads a settings file named on its launch line, and that file may install
 *  command hooks: Claude Code's `--settings <file>`. */
export function supportsCliHook(cli: string): boolean {
  return cli === 'claude-code';
}

/**
 * The base recipe a launch record stores, with the profile's pins placed where its launch puts
 * them: after every option word the seat's own line carries and before the CLI's first
 * positional delimiter, inside a proven script that runs the CLI. The reader that checks this
 * record ({@link featureSettings}) decodes the same CLI scope, so a pin written here is one the
 * CLI reads, and a pin after a script's closing quote — where no CLI receives it — is never
 * recorded. A line this version cannot prove keeps the pin after the line, exactly where its
 * launch puts the options too; the report then says the line cannot be read rather than claiming
 * the pin took effect.
 */
export function pinnedRecordLine(cli: string, line: string, features: readonly string[]): string {
  const profile = profileFor(cli);
  const addition = pinnedWords(features).map(shellQuote).join(' ');
  if (profile === null || addition === '') return line;
  return appendOnLaunchLine(line, addition, profile.binary).line;
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
 *  read as its CLI reads it, through the same proved words every other reader asks
 *  ({@link cliWordListOf}): a quoted flag name is the flag and a quoted value is the value, and
 *  an id inside a quoted script is read exactly where the launch puts one. The words are asked
 *  for by every shipped profile's binary: a plain line answers the same words for all of them,
 *  and a script line answers only for the profile whose binary the proved chain runs, so a line
 *  that runs some other program, or one this reader cannot prove, names no id. */
export function launchSessionId(command: string): string | undefined {
  const trimmed = command.trimEnd();
  for (const cli of NAMES) {
    const binary = SHIPPED[cli]?.profile.binary;
    if (binary === undefined) continue;
    const own = cliWordListOf(binary, trimmed);
    const id = own === null ? undefined : sessionIdIn(own);
    if (id !== undefined) return id;
  }
  return undefined;
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


/** The variable name an assignment word sets, or null when the word sets none. */
export function assignmentWordName(word: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
  return match ? match[1]! : null;
}

/** Whether an env word is exactly one shell word. A substitution or a quoted value may hold
 *  spaces inside its own word; unquoted whitespace makes two words, and a vendor word that
 *  splits would put the second one where the launch line's program is read. */
function oneShellWord(text: string): boolean {
  return shellWords(text)?.length === 1;
}

/** What a move to another vendor of the same CLI needs from the profile: the vendor's env words
 *  with their placeholders filled, every assignment name any vendor of the CLI supplies (a word
 *  with one of those names belongs to the vendor the line was written for), the CLI's model flag
 *  and the model id to run. */
export type VendorMove = {
  words: readonly string[];
  replaced: readonly string[];
  option: string;
  modelId: string;
};

export type VendorLaunch = { ok: true; launch: string } | { ok: false; why: string };

/**
 * The same CLI's launch line, written for another vendor of it. The line's leading variable
 * assignments are kept unless a vendor supplies that name, and its wrapper prefix — a shell
 * reading a script (`zsh ~/tools/as-floor.sh`) — is kept as written; everything after the CLI's
 * own binary is the launcher's tail and is replaced by the vendor's words, the binary and the
 * model flag. Every assignment word has to precede the command word, so the vendor's words go in
 * front of the wrapper: the wrapper is `exec "$@"`, and a word written after it would be a
 * program name, not an environment variable. A line this reader cannot prove — a `sh -c` script,
 * an `env` or any other prefix, an unclosed quote, a shell option it does not follow — is
 * refused rather than guessed at.
 */
export function launchWithVendorWords(profile: Profile, command: string, move: VendorMove): VendorLaunch {
  const cannot = 'its launch line is not one this version rewrites for another vendor; refused rather than guessing';
  const words = shellWords(command);
  if (words === null) return { ok: false, why: `its launch line has no knowable words; ${cannot}` };
  const kept: string[] = [];
  let at = 0;
  while (at < words.length) {
    const word = words[at]!;
    const name = assignmentWordName(word.text);
    if (name === null) break;
    if (!move.replaced.includes(name)) {
      const source = command.slice(word.start, word.end);
      if (!takesAppendedWord(source)) {
        return { ok: false, why: `its launch line's \`${source}\` swallows the words after it; ${cannot}` };
      }
      kept.push(source);
    }
    at += 1;
  }
  const prefix: string[] = [];
  const first = words[at];
  if (first === undefined) return { ok: false, why: `its launch line names no command; ${cannot}` };
  if (isShellName(first.text.split('/').pop() ?? first.text)) {
    const second = words[at + 1];
    if (second === undefined) return { ok: false, why: `its launch line runs a shell that runs nothing; ${cannot}` };
    if (second.text.startsWith('-')) {
      const script = words[at + 2];
      const proved = script === undefined ? null : provenScriptWord(command, script);
      return {
        ok: false,
        why: proved === null
          ? `its launch line runs a shell option this version does not follow; ${cannot}`
          : `its launch line runs the CLI inside a quoted script this version does not rewrite; ${cannot}`,
      };
    }
    const scriptName = second.text.split('/').pop() ?? second.text;
    if (!/\.(?:z|ba)?sh$/.test(scriptName)) {
      return { ok: false, why: `its launch line starts a shell on \`${second.text}\`, which is no wrapper script; ${cannot}` };
    }
    const scriptSource = command.slice(second.start, second.end);
    if (!takesAppendedWord(scriptSource)) {
      return { ok: false, why: `its launch line's \`${scriptSource}\` swallows the words after it; ${cannot}` };
    }
    prefix.push(command.slice(first.start, first.end), scriptSource);
    at += 2;
  }
  const program = words[at];
  if (program === undefined) return { ok: false, why: `its launch line names no command; ${cannot}` };
  if ((program.text.split('/').pop() ?? program.text) !== profile.binary) {
    return {
      ok: false,
      why: `its launch line starts \`${program.text}\`, not this profile's CLI \`${profile.binary}\`; ${cannot}`,
    };
  }
  for (const word of move.words) {
    if (assignmentWordName(word) === null || !oneShellWord(word) || !takesAppendedWord(word)) {
      return { ok: false, why: "the profile's vendor words are not one assignment word each; refused rather than guessing" };
    }
  }
  const launch = [...kept, ...move.words, ...prefix, profile.binary, move.option, move.modelId].join(' ');
  return { ok: true, launch };
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
 *  line this version cannot prove — a script it cannot read through, or a plain line that
 *  swallows its tail — keeps 0.5.10's append, which changes no existing word. */
function rewriteOnLaunchLine(profile: Profile, command: string, rewrite: FlagRewrite): string {
  const trimmed = command.trimEnd();
  const body = shellScriptWordOf(trimmed) === null ? plainBodyOf(trimmed) : cliBodyOn(profile.binary, trimmed);
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
// Every side's optional keys: `settings` (the settings edit), `session_cli`/`public_only`
// (the delivery CLI a session runs and the public-only declaration the send path proves),
// `features` (the pinned feature set the launch and the recorded line carry) and the watch
// retry (`watch_wake`, `watch_wake_tries`).
const OPTIONAL_LAUNCH_KEYS = ['exit', 'exit_keys', 'models', 'compose_module', 'session_cli', 'status_model', 'last_used_model', 'unread_model', 'exit_clear', 'exit_confirm', 'exit_completion', 'input', 'lobby_files', 'startup_reads', 'standing_rules', 'herdr_status', 'mcp_inbox', 'settings', 'typed_wake', 'typed_wake_settle_ms', 'wake', 'read_hint', 'watch_wake', 'watch_wake_tries', 'not_started', 'abandon_answers', 'public_only', 'features'] as const;
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

/** The value of `typed_wake`: one word from the closed set, never a guess. Only a profile whose
 *  own screens were captured may name one: the wake is read back through those screens. */
function wakeOf(entry: YamlEntry): WakeWay {
  const value = text(entry, 'wake');
  if (!(WAKE_WAYS as readonly string[]).includes(value)) {
    fail(entry.line, `"wake" must be one of: ${WAKE_WAYS.join(', ')}`);
  }
  return value as WakeWay;
}

function typedWakeOf(entry: YamlEntry): TypedWake {
  const value = text(entry, 'typed_wake');
  if (!(TYPED_WAKES as readonly string[]).includes(value)) {
    fail(entry.line, `"typed_wake" must be one of: ${TYPED_WAKES.join(', ')}`);
  }
  return value as TypedWake;
}

/** The value of `typed_wake_settle_ms`: a whole number of milliseconds between the wake's two
 *  opening reads, never below `WAKE_IDLE_SETTLE_FLOOR_MS`. The floor is one host read on a loaded
 *  host: a shorter space cannot catch a screen that changed between the reads, so the guard the
 *  two reads stand for would be gone. A profile may widen it, never narrow it. */
function typedWakeSettleMsOf(entry: YamlEntry): number {
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'number' || !Number.isInteger(node.value)
    || node.value < WAKE_IDLE_SETTLE_FLOOR_MS) {
    fail(entry.line, `"typed_wake_settle_ms" must be a whole number of milliseconds from ${String(WAKE_IDLE_SETTLE_FLOOR_MS)}`);
  }
  return node.value;
}

/** The value of `read_hint`: the one sentence a typed wake appends after the message's header.
 *  It is display, never transport: one printable line with no controls, no padding space, and
 *  short enough that the header still names the sender inside `MESSAGE_LINE_MAX`. The words are
 *  the profile's own — the shipment's `Read it with: team drops --read.` stands when none is
 *  declared — so a profile whose seat reads its MCP inbox names the inbox tool there. */
function readHintOf(entry: YamlEntry): string {
  const value = text(entry, 'read_hint');
  if (value !== value.trim()) fail(entry.line, '"read_hint" must not start or end with whitespace');
  if (/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]/u.test(value)) {
    fail(entry.line, '"read_hint" must be one printable line');
  }
  if (value.length > MESSAGE_HINT_MAX) {
    fail(entry.line, `"read_hint" must be at most ${String(MESSAGE_HINT_MAX)} characters`);
  }
  return value;
}

/** The value of `watch_wake`: `on` or `off`, never a guess. Only a profile that declares a
 *  `typed_wake` may turn it on: the watch retry is the same typed wake. */
function watchWakeOf(entry: YamlEntry): boolean {
  const value = text(entry, 'watch_wake');
  if (value !== 'on' && value !== 'off') fail(entry.line, '"watch_wake" must be on or off');
  return value === 'on';
}

/** The value of `watch_wake_tries`: a whole number of attempts, from 1 to
 *  `MAX_WATCH_WAKE_TRIES`. */
function watchWakeTriesOf(entry: YamlEntry): number {
  const node = entry.value;
  if (node.kind !== 'scalar' || typeof node.value !== 'number' || !Number.isInteger(node.value)
    || node.value < 1 || node.value > MAX_WATCH_WAKE_TRIES) {
    fail(entry.line, `"watch_wake_tries" must be a whole number from 1 to ${String(MAX_WATCH_WAKE_TRIES)}`);
  }
  return node.value;
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
 * routes, never two: launch-line arguments, the CLI's own `mcp add`, or a config file team
 * writes itself. With a `target`, the add writes a file inside the seat's folder — a relative
 * path in the `lobby_files` grammar — and the launch refuses it there when git tracks it.
 * Without one, the add writes the CLI's own user-level store, which belongs to no checkout;
 * `remove` is then the same CLI's command that takes this seat's entry (`{inbox}`) out again
 * on `team down`.
 */
function inboxOf(entry: YamlEntry): InboxBlock {
  const entries = mapping(entry.value, 'mcp_inbox');
  only(entries, ['launch_args', 'add', 'target', 'file', 'remove']);
  const launchArgsEntry = optional(entries, 'launch_args');
  const addEntry = optional(entries, 'add');
  const targetEntry = optional(entries, 'target');
  const fileEntry = optional(entries, 'file');
  const removeEntry = optional(entries, 'remove');
  if (addEntry !== undefined && fileEntry !== undefined) {
    fail(fileEntry.line, '"mcp_inbox" registers with "add" or "file", not both');
  }
  if (targetEntry !== undefined && addEntry === undefined) {
    fail(targetEntry.line, '"mcp_inbox" needs "add" beside "target"');
  }
  if (removeEntry !== undefined && addEntry === undefined) {
    fail(removeEntry.line, '"mcp_inbox" needs "add" beside "remove": the command its entries come from');
  }
  if (removeEntry !== undefined && targetEntry !== undefined) {
    fail(removeEntry.line, '"mcp_inbox" removes an entry only from a route with no "target": a project file is left as it is');
  }
  if (launchArgsEntry === undefined && addEntry === undefined && fileEntry === undefined) {
    fail(entry.line, '"mcp_inbox" names launch_args, add or file');
  }
  return {
    launchArgs: launchArgsEntry === undefined ? [] : strings(launchArgsEntry.value, 'launch_args'),
    add: addEntry === undefined ? null : strings(addEntry.value, 'add'),
    target: targetEntry === undefined ? null : relativeFileOf(targetEntry, 'target'),
    file: fileEntry === undefined ? null : relativeFileOf(fileEntry, 'file'),
    remove: removeEntry === undefined ? null : strings(removeEntry.value, 'remove'),
  };
}

/**
 * The value of `settings`: the option and the one value it carries, with `{cwd}` filled from
 * the seat's launch folder. The value rides the launch as one shell-quoted argument, so the
 * inline JSON a CLI takes there keeps its quotes and spaces.
 */
function settingsOf(node: YamlNode): SettingsBlock {
  const entries = mapping(node, 'settings');
  only(entries, ['option', 'value']);
  return {
    option: text(required(entries, 'option', node.line), 'option'),
    value: text(required(entries, 'value', node.line), 'value'),
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

/** The `typed_wake` a profile snippet names, by the loader's own rule: for tests. A word outside
 *  the closed set throws; an absent key reads as null, as an absent optional key does. */
export function typedWakeKey(text: string): TypedWake | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'typed_wake');
  return entry === undefined ? null : typedWakeOf(entry);
}

/** The `typed_wake_settle_ms` a profile snippet names, by the loader's own rule: for tests. A
 *  value under the floor, or not a whole number, throws; an absent key reads as null, as an
 *  absent optional key does. */
export function typedWakeSettleMsKey(text: string): number | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'typed_wake_settle_ms');
  return entry === undefined ? null : typedWakeSettleMsOf(entry);
}

/** The `read_hint` a profile snippet names, by the loader's own rule: for tests. A value that is
 *  not one printable line inside the bound throws; an absent key reads as null, as an absent
 *  optional key does. */
export function readHintKey(text: string): string | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'read_hint');
  return entry === undefined ? null : readHintOf(entry);
}

/** The `watch_wake` a profile snippet names, by the loader's own rule: for tests. A word outside
 *  the two throws; an absent key reads as null, as an absent optional key does. The rule that
 *  `on` needs a `typed_wake` is the loader's, read with the whole profile. */
export function watchWakeKey(text: string): boolean | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'watch_wake');
  return entry === undefined ? null : watchWakeOf(entry);
}

/** The `watch_wake_tries` a profile snippet names, by the loader's own rule: for tests. A value
 *  outside the bound throws; an absent key reads as null, as an absent optional key does. */
export function watchWakeTriesKey(text: string): number | null {
  const entry = optional(mapping(parseYaml(text), 'a profile'), 'watch_wake_tries');
  return entry === undefined ? null : watchWakeTriesOf(entry);
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
  only(entries, ['format', 'cli', 'screen', 'screen_module', 'quota', 'trust_answer', 'question_answer', 'vendors', 'credentials', ...LAUNCH_KEYS, ...OPTIONAL_LAUNCH_KEYS]);
  const cli = text(required(entries, 'cli', root.line), 'cli');
  required(entries, 'screen', root.line);
  const quotaEntry = optional(entries, 'quota');
  const statusEntry = optional(entries, 'status_model');
  const lastUsedEntry = optional(entries, 'last_used_model');
  const unreadModelEntry = optional(entries, 'unread_model');
  const exitClearEntry = optional(entries, 'exit_clear');
  const exitConfirmEntry = optional(entries, 'exit_confirm');
  const exitCompletionEntry = optional(entries, 'exit_completion');
  const inputEntry = optional(entries, 'input');
  const lobbyFilesEntry = optional(entries, 'lobby_files');
  const startupReadsEntry = optional(entries, 'startup_reads');
  const mcpInboxEntry = optional(entries, 'mcp_inbox');
  const settingsEntry = optional(entries, 'settings');
  const typedWakeEntry = optional(entries, 'typed_wake');
  const typedWakeSettleMsEntry = optional(entries, 'typed_wake_settle_ms');
  const wakeEntry = optional(entries, 'wake');
  const readHintEntry = optional(entries, 'read_hint');
  const watchWakeEntry = optional(entries, 'watch_wake');
  const watchWakeTriesEntry = optional(entries, 'watch_wake_tries');
  const exitEntry = optional(entries, 'exit');
  const exitKeysEntry = optional(entries, 'exit_keys');
  const composeEntry = optional(entries, 'compose_module');
  const sessionCliEntry = optional(entries, 'session_cli');
  const publicOnlyEntry = optional(entries, 'public_only');
  const standingRulesEntry = optional(entries, 'standing_rules');
  const herdrStatusEntry = optional(entries, 'herdr_status');
  const modelsEntry = optional(entries, 'models');
  const notStartedEntry = optional(entries, 'not_started');
  const abandonAnswersEntry = optional(entries, 'abandon_answers');
  const featuresEntry = optional(entries, 'features');
  const vendorsEntry = optional(entries, 'vendors');
  const credentialsEntry = optional(entries, 'credentials');
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
  if (vendorsEntry !== undefined && credentialsEntry === undefined) {
    fail(vendorsEntry.line, '"vendors" needs a "credentials" block: the store its items live in');
  }
  if (credentialsEntry !== undefined && vendorsEntry === undefined) {
    fail(credentialsEntry.line, '"credentials" names a store no vendor uses: declare "vendors" too');
  }
  const rules = rulesOf(required(entries, 'rules', root.line).value);
  const typedWake = typedWakeEntry ? typedWakeOf(typedWakeEntry) : null;
  const wake = wakeEntry ? wakeOf(wakeEntry) : null;
  if (wake !== null && wakeEntry !== undefined && typedWake === null) {
    fail(wakeEntry.line, '"wake" needs "typed_wake": the working screen is still how the wake is confirmed');
  }
  if (typedWakeSettleMsEntry !== undefined && typedWake === null) {
    fail(typedWakeSettleMsEntry.line, '"typed_wake_settle_ms" needs "typed_wake": it spaces the wake\'s two reads');
  }
  const typedWakeSettleMs = typedWakeSettleMsEntry ? typedWakeSettleMsOf(typedWakeSettleMsEntry) : null;
  const watchWake = watchWakeEntry ? watchWakeOf(watchWakeEntry) : typedWake !== null;
  if (watchWakeEntry !== undefined && watchWake && typedWake === null) {
    fail(watchWakeEntry.line, '"watch_wake: on" needs "typed_wake": the watch retries the same wake a send types');
  }
  if (watchWakeTriesEntry !== undefined && !watchWake) {
    fail(watchWakeTriesEntry.line, '"watch_wake_tries" needs "watch_wake: on"');
  }
  const watchWakeTries = watchWakeTriesEntry ? watchWakeTriesOf(watchWakeTriesEntry) : DEFAULT_WATCH_WAKE_TRIES;
  return {
    profile: {
      cli,
      binary: text(required(entries, 'binary', root.line), 'binary'),
      processNames: strings(required(entries, 'process_names', root.line).value, 'process_names'),
      notStarted: notStartedEntry ? notStartedOf(notStartedEntry.value) : [],
      abandonAnswers: abandonAnswersEntry ? abandonAnswersOf(abandonAnswersEntry.value) : [],
      tested: testedOf(required(entries, 'tested', root.line).value),
      unattended: stringsOrEmpty(required(entries, 'unattended', root.line).value, 'unattended'),
      features: featuresEntry ? featuresOf(featuresEntry.value) : [],
      rulesOption: rules.option,
      rulesMode: rules.mode,
      rulesPrompt: rules.prompt,
      publicOnly: publicOnlyEntry ? boolOf(publicOnlyEntry.value, 'public_only') : false,
      standingRules: standingRulesEntry ? strings(standingRulesEntry.value, 'standing_rules') : [],
      herdrStatus: herdrStatusEntry ? herdrStatusOf(herdrStatusEntry) : 'reliable',
      loginCheck: login.check,
      loginHint: login.hint,
      exit: exitEntry ? text(exitEntry, 'exit') : null,
      exitKeys: exitKeysEntry ? exitKeysOf(exitKeysEntry) : [],
      compose: composeEntry ? composeOf(composeEntry) : null,
      sessionCli: sessionCliEntry ? sessionCliOf(sessionCliEntry) : null,
      exitClear: exitClearEntry ? clearKeyOf(exitClearEntry) : null,
      exitConfirm: exitConfirmEntry ? confirmKeyOf(exitConfirmEntry) : null,
      exitCompletion: exitCompletionEntry ? boolOf(exitCompletionEntry.value, 'exit_completion') : false,
      input: inputEntry ? inputOf(inputEntry) : null,
      lobbyFiles: lobbyFilesEntry ? lobbyFilesOf(lobbyFilesEntry) : [],
      startupReads: startupReadsEntry ? startupReadsOf(startupReadsEntry) : [],
      mcpInbox: mcpInboxEntry ? inboxOf(mcpInboxEntry) : null,
      settings: settingsEntry ? settingsOf(settingsEntry.value) : null,
      typedWake,
      typedWakeSettleMs,
      readHint: readHintEntry ? readHintOf(readHintEntry) : null,
      wake,
      watchWake,
      watchWakeTries,
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
      vendors: vendorsEntry ? vendorsOf(vendorsEntry) : [],
      credentials: credentialsEntry ? credentialsOf(credentialsEntry) : null,
      answers: trustAnswers(optional(entries, 'trust_answer')),
      questionAnswers: questionAnswers(optional(entries, 'question_answer')),
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

/** The pinned feature set a profile declares, as `name=value` pairs with `value` the word true
 *  or false. Anything else is refused here, so a launch never carries a pin the CLI would read
 *  as another option or another value. */
function featuresOf(node: YamlNode): string[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"features" must be a non-empty list of name=true or name=false');
  return node.items.map((item) => {
    const pair = stringOf(item);
    if (pair === null || !/^[A-Za-z0-9_]+=(true|false)$/.test(pair)) {
      return fail(item.line, '"features" entries are name=true or name=false');
    }
    return pair;
  });
}

/** The providers a CLI can run on, as the adapter names them. Each env word is one shell word
 *  once its placeholders fill: a word that would split, or set no variable, is refused here. */
function vendorsOf(entry: YamlEntry): VendorBlock[] {
  const node = entry.value;
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"vendors" must be a non-empty list');
  const names = new Set<string>();
  return node.items.map((item) => {
    const fields = mapping(item, 'a vendor');
    only(fields, ['name', 'credential', 'env', 'models']);
    const name = text(required(fields, 'name', item.line), 'name');
    if (names.has(name)) fail(item.line, `two vendors are named "${name}"`);
    names.add(name);
    const credential = text(required(fields, 'credential', item.line), 'credential');
    const env = strings(required(fields, 'env', item.line).value, 'env');
    for (const word of env) {
      const filled = word.replaceAll('{model}', 'an-id').replaceAll('{credential}', 'an-item');
      if (assignmentWordName(filled) === null) {
        fail(item.line, `vendor "${name}" has an env word that sets no variable: "${word}"`);
      }
      if (!oneShellWord(filled)) {
        fail(item.line, `vendor "${name}" has an env word that is not one shell word once its placeholders fill: "${word}"`);
      }
    }
    const modelsNode = required(fields, 'models', item.line).value;
    if (modelsNode.kind !== 'seq' || modelsNode.items.length === 0) fail(modelsNode.line, '"models" must be a non-empty list');
    const ids = new Set<string>();
    const models = modelsNode.items.map((model) => {
      const modelFields = mapping(model, 'a vendor model');
      only(modelFields, ['id', 'model', 'version', 'display']);
      const id = text(required(modelFields, 'id', model.line), 'id');
      if (ids.has(id)) fail(model.line, `vendor "${name}" names the model "${id}" twice`);
      ids.add(id);
      return {
        id,
        model: text(required(modelFields, 'model', model.line), 'model'),
        version: text(required(modelFields, 'version', model.line), 'version'),
        display: text(required(modelFields, 'display', model.line), 'display'),
      };
    });
    return { name, credential, env, models };
  });
}

/** The store a profile's vendor items live in: the attribute-only lookup and the one-time add
 *  command a refusal prints. A store the profile does not name is never read. */
function credentialsOf(entry: YamlEntry): CredentialsBlock {
  const node = entry.value;
  const fields = mapping(node, '"credentials"');
  only(fields, ['check', 'add', 'missing_status']);
  const check = strings(required(fields, 'check', node.line).value, 'check');
  if (check.length === 0) fail(node.line, '"credentials.check" must name the command that reads the store');
  for (const word of check) {
    if (['-w', '--wait', '-g'].includes(word)) {
      fail(node.line, `"credentials.check" asks for the secret ("${word}"): the check is attribute-only`);
    }
  }
  const add = text(required(fields, 'add', node.line), 'add');
  if (!add.includes('{item}')) fail(node.line, '"credentials.add" must name where the item goes with "{item}"');
  const statusEntry = required(fields, 'missing_status', node.line).value;
  if (statusEntry.kind !== 'scalar' || typeof statusEntry.value !== 'number' || !Number.isInteger(statusEntry.value)) {
    fail(statusEntry.line, '"missing_status" must be a whole number');
  }
  return { check, add, missingStatus: statusEntry.value };
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

/** The value of `session_cli`: the CLI's own session-creating and session-pulling calls, as a
 *  run measured them. `argv` and `pull` are non-empty lists of words; `repo_flag` names the
 *  option a repository is passed as, or is absent when the CLI takes none; `created` is the line
 *  prefix the CLI prints once a session exists. */
function sessionCliOf(entry: YamlEntry): SessionCliSpec {
  const entries = mapping(entry.value, 'session_cli');
  only(entries, ['argv', 'repo_flag', 'created', 'pull']);
  const repoFlagEntry = optional(entries, 'repo_flag');
  return {
    argv: strings(required(entries, 'argv', entry.line).value, 'argv'),
    repoFlag: repoFlagEntry ? text(repoFlagEntry, 'repo_flag') : null,
    created: text(required(entries, 'created', entry.line), 'created'),
    pull: strings(required(entries, 'pull', entry.line).value, 'pull'),
  };
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
 *  quote is the script's positional word, not the CLI's. A plain line this version cannot prove
 *  is null too: a word a tokenizer finds after a comment or an operator is not the CLI's. */
export function withoutResume(cli: string, command: string): string | null {
  if (cli !== 'claude-code') return null;
  const trimmed = command.trimEnd();
  // A line whose quoting never closes has no knowable words: nothing may be stripped from it.
  if (shellWords(trimmed) === null) return null;
  const body = shellScriptWordOf(trimmed) === null ? plainBodyOf(trimmed) : cliBodyOn('claude', trimmed);
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

// A launch profile, read from the CLI's YAML file. The screen is loaded separately.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { REACH_ROSTER_FILE, REACH_ROSTER_TEMP } from '../reach/rules.ts';
import { DialectError, compilePattern } from '../watch/dialect.ts';
import { loadProfileModule } from './module-loader.ts';
import type { ComposeProfile } from './compose.ts';
import { shippedEfforts } from './efforts.ts';
import { WINDOWS, type QuotaPattern, type WindowName } from './quota.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';
import { trustAnswers, type TrustRecord } from './trust-answer.ts';

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
export interface Profile {
  cli: string;
  /** The CLI's process names, for the caller check. */
  processNames: readonly string[];
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
  /** Seconds to wait for the idle prompt after a launch. */
  idleTimeout: number;
  /** Seconds to wait for the pane's shell after the exit command. */
  exitTimeout: number;
  /** Whether the CLI starts on its last-used model when a launch names none. */
  lastUsedModel: boolean;
  /** What the model column shows when this CLI's screen names no model: `launch` falls back
   *  to the launch line's model, labelled; null keeps `(unread)`. */
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

/**
 * The command a seat's pane runs: the unattended flag in its environment, the
 * file's launch line, then the profile's options and, where the CLI takes
 * them at launch, the rules. A CLI that loads a per-launch settings file also
 * gets that file, named at the end, unless its launch line already names one.
 * A launch with a place adds the profile's measured team-inbox arguments.
 */
export function launchCommand(
  profile: Profile,
  launch: string,
  rules: string,
  cliHook?: string | null,
  place?: InboxPlace,
  displayName?: string,
  runtimePolicies?: { codexDaemon?: 'on' | 'off' },
): string {
  const words = new Set(launch.trim().split(/\s+/));
  const options = profile.unattended.filter((option) => !words.has(option));
  if (profile.cli === 'codex' && runtimePolicies?.codexDaemon === 'off' && !words.has('--no-daemon')) {
    const altIdx = options.indexOf('--no-alt-screen');
    if (altIdx >= 0) options.splice(altIdx, 0, '--no-daemon');
    else options.push('--no-daemon');
  }
  // The session's own display name, where the CLI takes one and the line names none: a person
  // reading the session — its prompt box, its resume list, its terminal title — sees the seat's
  // readable name rather than an anonymous session.
  if (displayName !== undefined && displayName !== '' && supportsSessionName(profile.cli)
    && !/(^|\s)(--name(=|\s|$)|-n(\s|$))/.test(launch)) {
    options.push('--name', displayName);
  }
  if (profile.rulesOption !== null) options.push(profile.rulesOption, rules);
  if (place) {
    for (const word of profile.mcpInbox?.launchArgs ?? []) options.push(fillInboxPlace(word, place));
  }
  if (cliHook !== undefined && cliHook !== null && supportsCliHook(profile.cli)
    && !/(^|\s)--settings(=|\s|$)/.test(launch)) {
    options.push('--settings', cliHook);
  }
  return ['AGENT_UNATTENDED=1', launch.trim(), ...options.map(shellQuote)].join(' ');
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
 */
export function supportsSessionResume(cli: string): boolean {
  return cli === 'claude-code' || cli === 'codex';
}

/** The session id a launch line already names with `--session-id`, if it names one. */
export function launchSessionId(command: string): string | undefined {
  const match = /(?:^|\s)--session-id(?:=|\s+)([A-Za-z0-9._-]+)(?=\s|$)/.exec(command);
  return match?.[1];
}

/**
 * The command a pane runs, with the session id TeamCLI sets where the CLI takes one. The id is
 * appended after every other argument, so the plan (`team up --dry-run`, `team add`) keeps the
 * deterministic line it had and each launch gets its own id. A line that already names a session
 * id, resumes one (`--resume`/`-r`) or continues one (`--continue`/`-c`) is left as it is: the
 * id it names is the one recorded, and a resumed conversation is not a new session.
 */
export function withLaunchSession(cli: string, command: string): { command: string; sessionId?: string } {
  if (!supportsSessionId(cli)) return { command };
  const named = launchSessionId(command);
  if (named !== undefined) return { command, sessionId: named };
  if (/(^|\s)(--session-id|--resume|-r|--continue|-c)(=|\s|$)/.test(command)) return { command };
  const sessionId = randomUUID();
  return { command: `${command} --session-id ${sessionId}`, sessionId };
}

/**
 * The command a pane runs to resume a recorded conversation, where the CLI keeps sessions: the
 * id is appended after every other argument, as `withLaunchSession` appends a new one. The
 * measured lines are Claude Code's (`-r, --resume [value] Resume a conversation - provide a
 * session ID`, `claude --help` 2.1.303) and Codex's subcommand (`Usage: codex resume [OPTIONS]
 * [SESSION_ID] [PROMPT]`, `codex resume --help` 0.161.0; both quoted on
 * {@link supportsSessionResume}). A Codex line takes the subcommand, so its id is a word after
 * `resume`, never a flag. Null when the CLI cannot resume: the caller hands over instead. Null,
 * too, for a launch line that already names a session — the flags below for Claude Code, the
 * `resume` subcommand for Codex: appending ours would leave two choices on the line, and the
 * line's own choice is the one the file records. `-c` is a flag's name only on a Claude Code
 * line: Codex's own `-c` is a config override, and a recorded Codex line carries one.
 */
export function withResume(cli: string, command: string, sessionId: string): string | null {
  if (!supportsSessionResume(cli)) return null;
  if (cli === 'codex') {
    if (/(^|\s)resume(\s|$)/.test(command)) return null;
    return `${command} resume ${sessionId}`;
  }
  if (/(^|\s)(--session-id|--resume|-r|--continue|-c)(=|\s|$)/.test(command)) return null;
  return `${command} --resume ${sessionId}`;
}

/**
 * The conversation a launch line already names to resume, read from the measured grammar above:
 * the id after Claude Code's `--resume`/`-r`, or the word after Codex's `resume`. Null when the
 * line names no resume at all. `''` when it resumes without naming one — `--continue`/`-c`
 * (Claude Code's most recent), `--last`, `--all` or a bare `resume` (Codex's picker) — which
 * cannot be told from the id a record binds. A line this version does not read is null: an
 * unmeasured form is not a resume this tool may reason about.
 */
export function namedResumeTarget(cli: string, command: string): string | null {
  if (cli === 'codex') {
    const words = command.trim().split(/\s+/);
    const at = words.indexOf('resume');
    if (at === -1) return null;
    const next = words[at + 1];
    return next === undefined || next.startsWith('-') ? '' : next;
  }
  if (cli !== 'claude-code') return null;
  const named = /(?:^|\s)(?:--resume|-r)(?:=|\s+)([A-Za-z0-9._-]+)(?=\s|$)/.exec(command);
  if (named) return named[1] ?? '';
  if (/(?:^|\s)(?:--resume|-r|--continue|-c)(=|\s|$)/.test(command)) return '';
  return null;
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
  return {
    kind: 'refuse',
    why: launchSessionId(command) === undefined
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
    const modelPattern = profile.cli === 'codex' || profile.cli === 'grok' || profile.cli === 'gemini'
      ? /(^|\s)(--model|-m)(=|\s+)(\S+)/
      : /(^|\s)(--model)(=|\s+)(\S+)/;
    if (modelPattern.test(next)) {
      next = next.replace(modelPattern, `$1$2$3${overrides.modelId}`);
    } else {
      next = `${next} ${option} ${overrides.modelId}`;
    }
  }
  if (overrides.effort) {
    if (profile.cli === 'codex') {
      const codexEffort = /(^|\s)(-c|--config)(=|\s+)(['"]?model_reasoning_effort=[^'"\s]+['"]?)/;
      if (codexEffort.test(next)) {
        next = next.replace(codexEffort, `$1$2$3model_reasoning_effort=${overrides.effort}`);
      } else {
        next = `${next} -c model_reasoning_effort=${overrides.effort}`;
      }
    } else if (supportsEffortLaunch(profile.cli)) {
      const effortPattern = /(^|\s)(--effort|--reasoning-effort)(=|\s+)(\S+)/;
      if (effortPattern.test(next)) {
        next = next.replace(effortPattern, `$1$2$3${overrides.effort}`);
      } else {
        next = `${next} --effort ${overrides.effort}`;
      }
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
const LAUNCH_KEYS = ['binary', 'process_names', 'tested', 'unattended', 'rules', 'login', 'timeouts'] as const;
const OPTIONAL_LAUNCH_KEYS = ['exit', 'exit_keys', 'models', 'compose_module', 'status_model', 'last_used_model', 'unread_model', 'exit_clear', 'exit_confirm', 'input', 'lobby_files', 'startup_reads', 'standing_rules', 'herdr_status', 'mcp_inbox'] as const;
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
      tested: testedOf(required(entries, 'tested', root.line).value),
      unattended: stringsOrEmpty(required(entries, 'unattended', root.line).value, 'unattended'),
      rulesOption: rules.option,
      rulesMode: rules.mode,
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

function rulesOf(node: YamlNode): { mode: 'option' | 'message' | 'prepend'; option: string | null } {
  if (node.kind === 'scalar' && node.value === 'first-message') return { mode: 'message', option: null };
  if (node.kind === 'scalar' && node.value === 'prepend') return { mode: 'prepend', option: null };
  const entries = mapping(node, 'rules');
  only(entries, ['option']);
  return { mode: 'option', option: text(required(entries, 'option', node.line), 'option') };
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

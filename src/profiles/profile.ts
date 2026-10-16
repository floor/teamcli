// A launch profile, read from the CLI's YAML file. The screen is loaded separately.
import { readFileSync } from 'node:fs';
import { REACH_ROSTER_FILE, REACH_ROSTER_TEMP } from '../reach/rules.ts';
import { DialectError, compilePattern } from '../watch/dialect.ts';
import { shippedEfforts } from './efforts.ts';
import { WINDOWS, type QuotaPattern, type WindowName } from './quota.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';
import { trustAnswers, type TrustRecord } from './trust-answer.ts';

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
  /** The option that carries the rules, or null when they go as a first message. */
  rulesOption: string | null;
  /** Arguments that exit 0 only when the owner is logged in, or null when the CLI has none. */
  loginCheck: readonly string[] | null;
  /** The command the owner runs to log in. */
  loginHint: string;
  /** What is typed into an idle prompt to make the CLI exit. */
  exit: string;
  /** The one key that empties the CLI's input box, sent to clear an exit text that did not
   *  read back as typed. Null when no key is established for this CLI: the text is left. */
  exitClear: string | null;
  /** The one key that confirms the CLI's own question after the exit text — its "stop tasks and
   *  exit" one, read as `exit question`. Sent by a stop, and only on that screen; null when no
   *  key is established for this CLI: a seat that asks the question is one that could not be
   *  stopped by asking. */
  exitConfirm: string | null;
  /** The exact relative paths of regular files this CLI may leave in its working folder.
   *  Empty when no capture has established a path for this CLI. */
  lobbyFiles: readonly string[];
  /** Paths this CLI reads at start in its working folder. A `directory` entry is every file
   *  under that directory. Empty when a run showed this CLI reads none. */
  startupReads: readonly { path: string; directory: boolean }[];
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

/**
 * The command a seat's pane runs: the unattended flag in its environment, the
 * file's launch line, then the profile's options and, where the CLI takes
 * them at launch, the rules.
 */
export function launchCommand(profile: Profile, launch: string, rules: string): string {
  const words = new Set(launch.trim().split(/\s+/));
  const options = profile.unattended.filter((option) => !words.has(option));
  if (profile.rulesOption !== null) options.push(profile.rulesOption, rules);
  return ['AGENT_UNATTENDED=1', launch.trim(), ...options.map(shellQuote)].join(' ');
}

/** True when the CLI accepts an effort override flag on its launch line. */
export function supportsEffortLaunch(cli: string): boolean {
  return cli === 'claude-code' || cli === 'antigravity' || cli === 'grok' || cli === 'codex' || cli === 'muse';
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

const NAMES = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse'] as const;
// The keys every profile carries. `status_model` and `last_used_model` are optional: a profile
// without the first belongs to a CLI whose screen doesn't show its model; the second says the
// CLI starts on its last-used model when a launch names none, and no shipped profile sets it.
const LAUNCH_KEYS = ['binary', 'process_names', 'tested', 'unattended', 'rules', 'login', 'exit', 'timeouts', 'models'] as const;
const OPTIONAL_LAUNCH_KEYS = ['status_model', 'last_used_model', 'unread_model', 'exit_clear', 'exit_confirm', 'lobby_files', 'startup_reads'] as const;
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

/** The value of `exit_clear`: one of the keys above, spelled as herdr spells it. */
function clearKeyOf(entry: YamlEntry): string {
  const value = text(entry, 'exit_clear');
  if (!(CLEAR_KEYS as readonly string[]).includes(value)) {
    fail(entry.line, `"exit_clear" must be one of: ${CLEAR_KEYS.join(', ')}`);
  }
  return value;
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
  const lobbyFilesEntry = optional(entries, 'lobby_files');
  const startupReadsEntry = optional(entries, 'startup_reads');
  for (const key of LAUNCH_KEYS) required(entries, key, root.line);
  const login = loginOf(required(entries, 'login', root.line).value);
  const timeouts = required(entries, 'timeouts', root.line).value;
  const models = modelsOf(required(entries, 'models', root.line).value);
  return {
    profile: {
      cli,
      binary: text(required(entries, 'binary', root.line), 'binary'),
      processNames: strings(required(entries, 'process_names', root.line).value, 'process_names'),
      tested: testedOf(required(entries, 'tested', root.line).value),
      unattended: strings(required(entries, 'unattended', root.line).value, 'unattended'),
      rulesOption: rulesOf(required(entries, 'rules', root.line).value),
      loginCheck: login.check,
      loginHint: login.hint,
      exit: text(required(entries, 'exit', root.line), 'exit'),
      exitClear: exitClearEntry ? clearKeyOf(exitClearEntry) : null,
      exitConfirm: exitConfirmEntry ? confirmKeyOf(exitConfirmEntry) : null,
      lobbyFiles: lobbyFilesEntry ? lobbyFilesOf(lobbyFilesEntry) : [],
      startupReads: startupReadsEntry ? startupReadsOf(startupReadsEntry) : [],
      idleTimeout: seconds(timeouts, 'idle'),
      exitTimeout: seconds(timeouts, 'exit'),
      lastUsedModel: lastUsedEntry ? boolOf(lastUsedEntry.value, 'last_used_model') : false,
      unreadModel: unreadModelEntry ? unreadModelOf(unreadModelEntry) : null,
      modelOf: (launch) => modelOf(models, launch),
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
function modelOf(models: { option: string[]; ids: ModelRule[] }, launch: string): { model: string; version: string } | null {
  let bestAt = -1;
  let id: string | null = null;
  for (const option of models.option) {
    const found = flagValue(launch, option);
    if (found && found.at > bestAt) {
      bestAt = found.at;
      id = found.id;
    }
  }
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

function rulesOf(node: YamlNode): string | null {
  if (node.kind === 'scalar' && node.value === 'first-message') return null;
  const entries = mapping(node, 'rules');
  only(entries, ['option']);
  return text(required(entries, 'option', node.line), 'option');
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

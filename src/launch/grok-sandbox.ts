// A Grok seat starts inside a sandbox profile TeamCLI writes for it. The profile names that
// seat's worktree, its start folder, and only the seat's own paths under the git common dir and
// under `.agents`. Nothing under the team config directory is granted. `extends = "workspace"`
// is written; what that preset itself grants is unmeasured. Measured on grok 1.0.70
// (f50904eaee6c) in a scratch home:
//   GROK_HOME=<dir> grok --trust --sandbox team-seat-demo -p hi
// found the profile in `<dir>/sandbox.toml` and reached its auth check, while
//   GROK_HOME=<dir> grok --trust --sandbox team-seat-absent -p hi
// printed `warning: sandbox could not be applied: Custom sandbox profile 'team-seat-absent' not
// found. Define it in ~/.grok/sandbox.toml or .grok/sandbox.toml:` and exited 1. `--sandbox`
// takes only a profile name: a path, inline TOML and `GROK_SANDBOX=<path>` are each read as a
// name and refused. The profile's `read_write` entries are taken literally — `~` and `$HOME` are
// not expanded, and a relative entry is anchored at the workspace — so every grant below is
// written as an absolute path. The file is the user-level one (`$GROK_HOME/sandbox.toml`, default
// `~/.grok/sandbox.toml`): a project `.grok/sandbox.toml` would put a machine-specific map
// inside a repository, and the user-level file is read when the project has none.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { syncChildTimeout } from '../child.ts';
import { cliHookSettingsPath, cliHookStatePath } from './cli-hook.ts';
import { tomlString, writePrivateAtomic } from './private-file.ts';
import { parseToml } from './toml.ts';

/** The filesystem root Grok reads beside its own home, and the profile TeamCLI keeps there. */
export interface GrokSandbox {
  /** The `--sandbox` profile name, `team-seat-<project>-<seat>`. */
  profile: string;
  /** The user-level `sandbox.toml` this launch writes or updates. */
  file: string;
  /** The absolute folders the profile grants `read_write`, in file order. */
  readWrite: readonly string[];
  /** The root the link guard walks: the home the file sits under, else the file's parent. */
  guard: string;
}

/** The root Grok reads: `$GROK_HOME` when the environment sets an absolute one, else the
 *  default `~/.grok`. A relative `GROK_HOME` is resolved by Grok against the pane's own
 *  folder, which this launch cannot know, so it is left to Grok and the default is written. */
export function grokHomeFor(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = env.GROK_HOME?.trim();
  return named !== undefined && named !== '' && isAbsolute(named) ? named : join(home, '.grok');
}

/** `team-seat-<project>-<seat>`, the name the profile and the launch line share. Each word is
 *  reduced to TOML bare-key characters so the same string is a table name and a profile name;
 *  a word that reduces to nothing is dropped, and an empty pair still names a profile. */
export function grokSandboxProfileName(project: string, seat: string): string {
  const slug = (word: string) => word.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const parts = [slug(project), slug(seat)].filter((part) => part !== '');
  return parts.length === 0 ? 'team-seat' : `team-seat-${parts.join('-')}`;
}

/** What a Grok seat's launch writes and names. The grant is that seat's worktree, its start
 *  folder, and only these paths of its own: under the git common dir, `objects/`, `refs/`,
 *  `logs/`, `packed-refs` and `worktrees/<that worktree>`; under `.agents`,
 *  `send-drops/<session>/<seat>`, `messages/<seat>`, `seat-state/<session>/<seat>.json` and
 *  `hooks/<session>/<seat>.json`. The team config directory is never granted, nor is a start
 *  folder or worktree inside it, nor the `.agents` folder, nor the common dir, nor that dir's
 *  `hooks/`, `config` or `info/`. A path is resolved when it or an ancestor exists, because the
 *  sandbox takes the path literally and a grant to a link's own name would not cover its target. */
export function grokSandboxOf(input: {
  home: string;
  root: string;
  project: string;
  seat: string;
  session: string;
  /** The folder the seat starts in. Absent when this launch has none. */
  cwd?: string;
  /** The seat's worktree. Absent when the seat has none recorded. */
  worktree?: string;
  /** The resolved Grok home; `grokHomeFor` reads the environment when absent. */
  grokHome?: string;
}): GrokSandbox {
  const grokHome = input.grokHome ?? grokHomeFor(input.home);
  const file = join(grokHome, 'sandbox.toml');
  const folders: string[] = [];
  const worktree = input.worktree === undefined ? undefined : realFolder(input.worktree);
  const start = input.cwd === undefined ? undefined : realFolder(input.cwd);
  placeGrant(input.home, worktree, folders);
  if (start !== worktree) placeGrant(input.home, start, folders);
  for (const grant of gitGrants(input.worktree ?? input.cwd ?? input.root)) placeGrant(input.home, grant, folders);
  for (const grant of agentGrants(input.root, input.session, input.seat)) placeGrant(input.home, grant, folders);
  return {
    profile: grokSandboxProfileName(input.project, input.seat),
    file,
    readWrite: [...new Set(folders)],
    guard: grokHome === input.home || grokHome.startsWith(`${input.home}/`) ? input.home : dirname(grokHome),
  };
}

function placeGrant(home: string, folder: string | undefined, into: string[]): void {
  if (folder === undefined || folder === '') return;
  if (coveredByTeamConfig(home, folder)) return;
  into.push(folder);
}

/** True when `folder` is the team config directory or anything inside it. */
function coveredByTeamConfig(home: string, folder: string): boolean {
  const base = realFolder(join(home, '.config', 'team'));
  const path = realFolder(folder);
  const root = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
  return path === root || path.startsWith(`${root}/`);
}

function oneSegment(word: string): boolean {
  return word !== '' && word !== '.' && word !== '..' && !word.includes('/') && !word.includes('\\') && !word.includes('\0');
}

/** The seat's own files under `.agents`. The folder itself is not a grant. */
function agentGrants(root: string, session: string, seat: string): string[] {
  const agents = join(root, '.agents');
  const grants: string[] = [];
  if (oneSegment(session) && oneSegment(seat)) {
    grants.push(realFolder(join(agents, 'send-drops', session, seat)));
    grants.push(realFolder(join(agents, 'messages', seat)));
  }
  const state = cliHookStatePath(agents, session, seat);
  const hooks = cliHookSettingsPath(agents, session, seat);
  if (state !== null) grants.push(realFolder(state));
  if (hooks !== null) grants.push(realFolder(hooks));
  return grants;
}

/** `objects/`, `refs/`, `logs/`, `packed-refs`, and this worktree's own `worktrees/<name>`
 *  under the git common dir. The common dir itself, `hooks/`, `config` and `info/` are not
 *  grants. A folder that is not a checkout names nothing. */
function gitGrants(folder: string): string[] {
  const common = gitAnswer(folder, '--git-common-dir');
  if (common === undefined) return [];
  const grants = ['objects', 'refs', 'logs', 'packed-refs'].map((name) => realFolder(join(common, name)));
  const gitDir = gitAnswer(folder, '--git-dir');
  const ownPrefix = `${realFolder(common)}/worktrees/`;
  if (gitDir !== undefined) {
    const own = realFolder(gitDir);
    const name = own.startsWith(ownPrefix) ? own.slice(ownPrefix.length) : '';
    if (name !== '' && !name.includes('/')) grants.push(own);
  }
  return grants;
}

function gitAnswer(folder: string, flag: '--git-common-dir' | '--git-dir'): string | undefined {
  if (!existsSync(folder)) return undefined;
  try {
    const said = execFileSync('git', ['rev-parse', '--path-format=absolute', flag], {
      cwd: folder,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: syncChildTimeout(5_000),
    }).trim();
    if (said === '') return undefined;
    return isAbsolute(said) ? said : resolve(folder, said);
  } catch {
    return undefined;
  }
}

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    const parent = dirname(folder);
    if (parent === folder) return folder;
    const resolved = realFolder(parent);
    return resolved === parent ? folder : join(resolved, basename(folder));
  }
}

/** Writes or updates the seat's profile in the user-level `sandbox.toml`. Every other table and
 *  every other key in this one is kept; a line that only looks like a table header or a field
 *  because it sits inside a multi-line string is text, and is never read or rewritten. The file
 *  is replaced whole through a private temporary file in the same folder, so a failed write leaves
 *  the original as it was; the result is 0600 even when the old file was not. A file that already
 *  holds the profile as this launch would write it is not rewritten, and a symbolic link is not
 *  written through at all: the caller launches without the profile rather than failing the seat. */
export function writeGrokSandbox(sandbox: GrokSandbox): { ok: true } | { ok: false; why: string } {
  try {
    const text = existsSync(sandbox.file) ? readFileSync(sandbox.file, 'utf8') : '';
    const next = mergeProfile(text, sandbox.profile, [
      { key: 'extends', value: tomlString('workspace'), parsed: 'workspace' },
      { key: 'read_write', value: arrayValue(sandbox.readWrite), parsed: [...sandbox.readWrite] },
    ]);
    if (next !== null) writePrivateAtomic(sandbox.file, next, sandbox.guard);
    return { ok: true };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/** The shell words of a launch line, each with the quotes and escapes that spell it. A quoted
 *  prompt is one word: the words inside it are text, not options. */
const SHELL_WORD = /(?:[^\s'"\\]+|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g;

/** The launch line without the `--sandbox <profile>` this run appended: what a launch runs when
 *  its sandbox file could not be written, instead of a line Grok would refuse for a profile it
 *  cannot find. The option is removed as the argv pair it is, never as a substring: the same words
 *  inside a quoted prompt are one argument, and the CLI is asked for exactly what it was asked
 *  before. */
export function withoutGrokSandbox(command: string, profile: string): string {
  const words = [...command.matchAll(SHELL_WORD)];
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!;
    const raw = word[0]!;
    const start = word.index!;
    let end = start + raw.length;
    const joined = raw.startsWith('--sandbox=') ? raw.slice('--sandbox='.length) : null;
    if (joined !== null) {
      if (joined !== profile) continue;
    } else if (raw === '--sandbox') {
      const value = words[at + 1];
      if (value === undefined || value[0] !== profile) continue;
      end = value.index! + value[0]!.length;
    } else {
      continue;
    }
    let from = start;
    while (from > 0 && /\s/.test(command[from - 1]!)) from--;
    return command.slice(0, from) + command.slice(end);
  }
  return command;
}

/** A field as it is spelled on its line and as the profile must parse it: the write is checked
 *  against `parsed`, not only against the key being there. */
type Field = { key: string; value: string; parsed: unknown };

function mergeProfile(text: string, profile: string, fields: readonly Field[]): string | null {
  // The table is decided by parsing, never by one spelling of its header. A file that does not
  // parse is left exactly as it is and the launch goes on without the profile: rewriting a broken
  // file is not this launch's repair, and appending to it could not be checked.
  const parsed = parseSandbox(text);
  const exists = Object.prototype.hasOwnProperty.call(profileTables(parsed), profile);
  let next: string | null;
  const lines = text.split('\n');
  // A header or a key spelled inside a multi-line string is text. Every line decision below reads
  // the document's string state, not just the line, so `notes = """` cannot lend its contents a
  // table.
  const outside = lineScopes(lines);
  if (!exists) {
    const block = [`[profiles.${profile}]`, ...fields.map((field) => `${field.key} = ${field.value}`), ''].join('\n');
    if (text === '') next = block;
    else {
      const base = text.endsWith('\n') ? text : `${text}\n`;
      next = base.endsWith('\n\n') ? base + block : `${base}\n${block}`;
    }
  } else {
    const at = lines.findIndex((line, index) => outside[index] === true && isProfileHeader(line, profile));
    if (at < 0) {
      // The parse proves the key exists, but not as a table header this version can edit — an
      // inline value under `[profiles]`, for example. Appending a second definition would make
      // the file unparseable, so nothing is written.
      throw new Error(`the sandbox file defines profiles.${profile} in a form this version cannot rewrite; it was left as it is`);
    }
    let end = at + 1;
    while (end < lines.length && !(outside[end] === true && headerPath(lines[end] ?? '') !== null)) end++;
    const section = lines.slice(at + 1, end);
    const sectionOutside = lineScopes(section);
    let changed = false;
    for (const field of fields) {
      if (upsertField(section, sectionOutside, field)) changed = true;
    }
    if (!changed) return null;
    next = [...lines.slice(0, at + 1), ...section, ...lines.slice(end)].join('\n');
  }
  // The text is re-parsed before anything replaces the file, and the profile's requested values
  // are read back: a rewrite that landed in a look-alike table inside a string, or that left the
  // old grants standing, is refused instead of written.
  const written = parseSandbox(next, 'writing the sandbox profile would leave the file unreadable');
  const table = profileTables(written)[profile];
  if (
    table === null || typeof table !== 'object' || Array.isArray(table) ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(table, field.key) ||
      !sameValue((table as Record<string, unknown>)[field.key], field.parsed))
  ) {
    throw new Error('writing the sandbox profile did not land in the file; it was left as it is');
  }
  return next;
}

function isProfileHeader(line: string, profile: string): boolean {
  const path = headerPath(line);
  return path !== null && path.length === 2 && path[0] === 'profiles' && path[1] === profile;
}

function sameValue(actual: unknown, wanted: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(wanted)) {
    return Array.isArray(actual) && Array.isArray(wanted) && actual.length === wanted.length &&
      actual.every((item, index) => sameValue(item, wanted[index]));
  }
  return actual === wanted;
}

/** A sandbox file parsed as a TOML document. A file that does not parse is not written: the
 *  error tells the caller why, and the launch continues without the profile. */
function parseSandbox(text: string, prefix = 'the sandbox file is not valid TOML'): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(`${prefix} (${said}); it was left as it is`);
  }
}

function profileTables(parsed: Record<string, unknown>): Record<string, unknown> {
  const profiles = parsed.profiles;
  return profiles !== null && typeof profiles === 'object' && !Array.isArray(profiles)
    ? profiles as Record<string, unknown>
    : {};
}

/** The key path a table header line names, decoded. `[profiles.x]`, `[profiles.x] # note`,
 *  `[ profiles . "x" ]` and `[profiles.'x']` all name the same table; a line that is not a table
 *  header (`[[array]]`, a key, a continuation of a multi-line value) names nothing. */
function headerPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null;
  let quote: '"' | "'" | null = null;
  let close = -1;
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    if (quote !== null) {
      if (quote === '"' && char === '\\') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') {
      close = index;
      break;
    }
  }
  if (close < 0) return null;
  const rest = trimmed.slice(close + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return keyPath(trimmed.slice(1, close));
}

function keyPath(inner: string): string[] | null {
  const parts: string[] = [];
  let part = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (quote !== null) {
      part += char;
      if (quote === '"' && char === '\\' && index + 1 < inner.length) part += inner[++index]!;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      part += char;
    } else if (char === '.') {
      parts.push(part);
      part = '';
    } else part += char;
  }
  if (quote !== null) return null;
  parts.push(part);
  const keys: string[] = [];
  for (const raw of parts) {
    const key = bareOrQuoted(raw.trim());
    if (key === null) return null;
    keys.push(key);
  }
  return keys;
}

function bareOrQuoted(raw: string): string | null {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(`"${raw.slice(1, -1)}"`) as string;
    } catch {
      return null;
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

function upsertField(section: string[], outside: readonly boolean[], field: Field): boolean {
  const wanted = `${field.key} = ${field.value}`;
  const pattern = new RegExp(`^${field.key}\\s*=`);
  // Only a line the section begins outside a string can define this field: a line of the value
  // that only looks like `extends = …` is content, not a key.
  const at = section.findIndex((line, index) => outside[index] === true && pattern.test(line.trim()));
  if (at >= 0) {
    const end = valueEnd(section, at);
    if (end === at + 1 && section[at]?.trim() === wanted) return false;
    section.splice(at, end - at, wanted);
    return true;
  }
  let insert = section.length;
  while (insert > 0 && (section[insert - 1] ?? '').trim() === '') insert--;
  section.splice(insert, 0, wanted);
  return true;
}

/** The line after a field's value: an array written over several lines is replaced whole, and a
 *  `#` comment, a quoted bracket or a bracket inside a multi-line string does not end it early. */
function valueEnd(section: string[], at: number): number {
  let open = 0;
  let state: StringState = 'none';
  for (let index = at; index < section.length; index++) {
    const step = scanLine(section[index] ?? '', state);
    open += step.open;
    state = step.state;
    if (open <= 0 && state === 'none') return index + 1;
  }
  return section.length;
}

/** A TOML string that can span lines. A single-line string never carries over, so only the
 *  multi-line forms are states here. */
type StringState = 'none' | 'basic' | 'literal';

/** For each line, whether it begins outside a multi-line string. */
function lineScopes(lines: readonly string[]): boolean[] {
  let state: StringState = 'none';
  return lines.map((line) => {
    const outside = state === 'none';
    state = scanLine(line, state).state;
    return outside;
  });
}

/** One line read with the string state carried from the line before: the brackets the line opens
 *  outside strings and comments, and the state the next line starts in. `#` ends a line only
 *  outside a string; a quoted bracket is text; a multi-line string keeps its contents opaque. */
function scanLine(line: string, state: StringState): { open: number; state: StringState } {
  let open = 0;
  let index = 0;
  if (state !== 'none') {
    const delimiter = state === 'basic' ? '"""' : "'''";
    const close = closingAt(line, 0, delimiter, state === 'basic');
    if (close < 0) return { open, state };
    index = afterQuotes(line, close, state === 'basic' ? '"' : "'");
    state = 'none';
  }
  while (index < line.length) {
    const char = line[index]!;
    if (char === '#') break;
    if (char === '[') {
      open++;
      index++;
      continue;
    }
    if (char === ']') {
      open--;
      index++;
      continue;
    }
    if (char === '"') {
      if (line.startsWith('"""', index)) {
        const close = closingAt(line, index + 3, '"""', true);
        if (close < 0) return { open, state: 'basic' };
        index = afterQuotes(line, close, '"');
        continue;
      }
      index = skipSingle(line, index, '"');
      continue;
    }
    if (char === "'") {
      if (line.startsWith("'''", index)) {
        const close = closingAt(line, index + 3, "'''", false);
        if (close < 0) return { open, state: 'literal' };
        index = afterQuotes(line, close, "'");
        continue;
      }
      index = skipSingle(line, index, "'");
      continue;
    }
    index++;
  }
  return { open, state };
}

/** The index after the single-line string that opens at `at`. A backslash escapes the next
 *  character in a basic string; an unterminated string is a parse error found elsewhere. */
function skipSingle(line: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < line.length) {
    const char = line[index]!;
    if (quote === '"' && char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index++;
  }
  return index;
}

/** The first closing delimiter, skipping a run a backslash escapes (`\"""` is content in a basic
 *  string). */
function closingAt(line: string, from: number, delimiter: string, escaped: boolean): number {
  for (let index = from; index <= line.length - delimiter.length; index++) {
    if (!line.startsWith(delimiter, index)) continue;
    if (escaped) {
      let slashes = 0;
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back--) slashes++;
      if (slashes % 2 === 1) continue;
    }
    return index;
  }
  return -1;
}

/** The index after a run of quote characters that closes a multi-line string. A run of four or
 *  five carries one or two quotes of content before the delimiter. */
function afterQuotes(line: string, at: number, quote: string): number {
  let index = at;
  while (line[index] === quote) index++;
  return index;
}

function arrayValue(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

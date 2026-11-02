// A Grok seat starts inside a sandbox profile TeamCLI writes for it, so the seat may write the
// team's state folder and the project's `.agents` while everything else stays the workspace's
// own grant. Measured on grok 1.0.70 (f50904eaee6c) in a scratch home:
//   GROK_HOME=<dir> grok --trust --sandbox team-seat-demo -p hi
// found the profile in `<dir>/sandbox.toml` and reached its auth check, while
//   GROK_HOME=<dir> grok --trust --sandbox team-seat-absent -p hi
// printed `warning: sandbox could not be applied: Custom sandbox profile 'team-seat-absent' not
// found. Define it in ~/.grok/sandbox.toml or .grok/sandbox.toml:` and exited 1. `--sandbox`
// takes only a profile name: a path, inline TOML and `GROK_SANDBOX=<path>` are each read as a
// name and refused. The profile's `read_write` entries are taken literally — `~` and `$HOME` are
// not expanded, and a relative entry is anchored at the workspace — so the two folders below are
// written as absolute paths. The file is the user-level one (`$GROK_HOME/sandbox.toml`, default
// `~/.grok/sandbox.toml`): a project `.grok/sandbox.toml` would put a machine-specific map
// inside a repository, and the user-level file is read when the project has none.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tomlString, writePrivate } from './private-file.ts';

/** The filesystem root Grok reads beside its own home, and the profile TeamCLI keeps there. */
export interface GrokSandbox {
  /** The `--sandbox` profile name, `team-seat-<project>`. */
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

/** `team-seat-<project>`, the name the profile and the launch line share. The project word is
 *  reduced to TOML bare-key characters so the same string is a table name and a profile name;
 *  an empty project still names a profile. */
export function grokSandboxProfileName(project: string): string {
  const slug = project.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'team-seat' : `team-seat-${slug}`;
}

/** What a Grok seat's launch writes and names: the profile, its file, and the two folders the
 *  seat writes through it — the machine's team config and the project root's `.agents`. The
 *  folders are resolved when they exist, because the sandbox takes the path literally and a
 *  grant to a link's own name would not cover its target. */
export function grokSandboxOf(input: {
  home: string;
  root: string;
  project: string;
  /** The resolved Grok home; `grokHomeFor` reads the environment when absent. */
  grokHome?: string;
}): GrokSandbox {
  const grokHome = input.grokHome ?? grokHomeFor(input.home);
  const file = join(grokHome, 'sandbox.toml');
  return {
    profile: grokSandboxProfileName(input.project),
    file,
    readWrite: [realFolder(join(input.home, '.config', 'team')), realFolder(join(input.root, '.agents'))],
    guard: grokHome === input.home || grokHome.startsWith(`${input.home}/`) ? input.home : dirname(grokHome),
  };
}

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

/** Writes or updates the seat's profile in the user-level `sandbox.toml`. Every other table and
 *  every other key in this one is kept. A file that already holds the profile byte for byte is
 *  not rewritten, and a symbolic link is not written through at all: the caller launches without
 *  the profile rather than failing the seat. */
export function writeGrokSandbox(sandbox: GrokSandbox): { ok: true } | { ok: false; why: string } {
  try {
    const text = existsSync(sandbox.file) ? readFileSync(sandbox.file, 'utf8') : '';
    const next = mergeProfile(text, sandbox.profile, [
      { key: 'extends', value: tomlString('workspace') },
      { key: 'read_write', value: arrayValue(sandbox.readWrite) },
    ]);
    if (next !== null) writePrivate(sandbox.file, next, sandbox.guard);
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

type Field = { key: string; value: string };

function mergeProfile(text: string, profile: string, fields: readonly Field[]): string | null {
  // The table is decided by parsing, never by one spelling of its header. A file that does not
  // parse is left exactly as it is and the launch goes on without the profile: rewriting a broken
  // file is not this launch's repair, and appending to it could not be checked.
  const parsed = parseSandbox(text);
  const exists = Object.prototype.hasOwnProperty.call(profileTables(parsed), profile);
  let next: string | null;
  if (!exists) {
    const block = [`[profiles.${profile}]`, ...fields.map((field) => `${field.key} = ${field.value}`), ''].join('\n');
    if (text === '') next = block;
    else {
      const base = text.endsWith('\n') ? text : `${text}\n`;
      next = base.endsWith('\n\n') ? base + block : `${base}\n${block}`;
    }
  } else {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => {
      const path = headerPath(line);
      return path !== null && path.length === 2 && path[0] === 'profiles' && path[1] === profile;
    });
    if (at < 0) {
      // The parse proves the key exists, but not as a table header this version can edit — an
      // inline value under `[profiles]`, for example. Appending a second definition would make
      // the file unparseable, so nothing is written.
      throw new Error(`the sandbox file defines profiles.${profile} in a form this version cannot rewrite; it was left as it is`);
    }
    let end = at + 1;
    while (end < lines.length && headerPath(lines[end] ?? '') === null) end++;
    const section = lines.slice(at + 1, end);
    let changed = false;
    for (const field of fields) {
      if (upsertField(section, field)) changed = true;
    }
    if (!changed) return null;
    next = [...lines.slice(0, at + 1), ...section, ...lines.slice(end)].join('\n');
  }
  // A file that parsed before this write parses after it. The check is the whole file, so an
  // appended table beside an inline `profiles = {...}` is refused instead of corrupted.
  const written = parseSandbox(next, 'writing the sandbox profile would leave the file unreadable');
  if (!Object.prototype.hasOwnProperty.call(profileTables(written), profile)) {
    throw new Error('writing the sandbox profile did not land in the file; it was left as it is');
  }
  return next;
}

/** A sandbox file parsed as a TOML document. A file that does not parse is not written: the
 *  error tells the caller why, and the launch continues without the profile. */
function parseSandbox(text: string, prefix = 'the sandbox file is not valid TOML'): Record<string, unknown> {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
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

function upsertField(section: string[], field: Field): boolean {
  const wanted = `${field.key} = ${field.value}`;
  const pattern = new RegExp(`^${field.key}\\s*=`);
  const at = section.findIndex((line) => pattern.test(line.trim()));
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
 *  `#` comment or a quoted bracket does not end it early. */
function valueEnd(section: string[], at: number): number {
  let open = 0;
  for (let index = at; index < section.length; index++) {
    open += bracketBalance(section[index] ?? '');
    if (open <= 0) return index + 1;
  }
  return section.length;
}

function bracketBalance(line: string): number {
  let open = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (char === '[') open++;
    else if (char === ']') open--;
  }
  return open;
}

function arrayValue(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

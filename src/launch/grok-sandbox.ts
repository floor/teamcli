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

/** The launch line without the `--sandbox <profile>` this run appended: what a launch runs when
 *  its sandbox file could not be written, instead of a line Grok would refuse for a profile it
 *  cannot find. */
export function withoutGrokSandbox(command: string, profile: string): string {
  const name = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`\\s+--sandbox(?:=|\\s+)${name}(?=\\s|$)`), '');
}

type Field = { key: string; value: string };

function mergeProfile(text: string, profile: string, fields: readonly Field[]): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === `[profiles.${profile}]` || trimmed === `[profiles.${tomlString(profile)}]`;
  });
  if (at < 0) {
    const block = [`[profiles.${profile}]`, ...fields.map((field) => `${field.key} = ${field.value}`), ''].join('\n');
    if (text === '') return block;
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return base.endsWith('\n\n') ? base + block : `${base}\n${block}`;
  }
  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? '').trim().startsWith('[')) end++;
  const section = lines.slice(at + 1, end);
  let changed = false;
  for (const field of fields) {
    if (upsertField(section, field)) changed = true;
  }
  if (!changed) return null;
  return [...lines.slice(0, at + 1), ...section, ...lines.slice(end)].join('\n');
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

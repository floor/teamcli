// The receiving side's cross-session declaration, as the launch line itself carries it.
//
// A Claude Code session surfaces a frame from another session only when its own top-level
// setting `crossSessionInbound` is `accept`; `hold`, `refuse` and unset either hold the frame at
// a dialog or drop it. The word is read from the launch line's own scripts — a wrapper that execs
// the CLI with `--settings '{"crossSessionInbound":"accept"}'`, or with a path to a settings file.
// Nothing under an owner CLI home is ever opened.
//
// The launch command appends this build's generated hook settings file at the end of the line
// (`--settings <file>`), and a CLI keeps its LAST `--settings`: that generated file is therefore
// the effective settings when it is written. The reader of the effective word
// (`declaredInboundOf` in `src/send/inbound.ts`) handles that precedence; this module only reads
// what the scripts themselves say, so the launch side can merge that word into the one file the
// CLI actually loads.
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_FILE_BYTES = 262_144;
const MAX_SCRIPTS = 8;

/** The exact values Claude Code accepts for the top-level receiver setting. */
export type CrossSessionInbound = 'accept' | 'hold' | 'refuse';

/** One launch's word: the policy the last `--settings` in its scripts names, or null for unset. */
export type LaunchInbound = {
  policy: CrossSessionInbound | null;
  /** The file that carried the word — the script for inline JSON, the settings file for a path. */
  source: string | null;
  /** When that file last changed, or null when no script names a settings flag. */
  declaredAt: number | null;
};

const NONE: LaunchInbound = { policy: null, source: null, declaredAt: null };

/** The exact `crossSessionInbound` value in a parsed JSON document, or null. */
export function inboundPolicyOf(value: unknown): CrossSessionInbound | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as { crossSessionInbound?: unknown }).crossSessionInbound;
  return raw === 'accept' || raw === 'hold' || raw === 'refuse' ? raw : null;
}

/** The owner CLI homes this build never opens, as resolved path prefixes. */
function ownerCliHomes(): string[] {
  return ['.claude', '.codex', '.cursor', '.gemini', join('.config', 'muse')].map((one) =>
    resolve(homedir(), one),
  );
}

function underOwnerCliHome(path: string): boolean {
  const real = resolve(path);
  return ownerCliHomes().some((home) => real === home || real.startsWith(`${home}${sep}`));
}

/** A regular file's text, read without following a link and not past the cap. */
function readText(path: string): string | null {
  if (underOwnerCliHome(path)) return null;
  try {
    const held = lstatSync(path);
    if (!held.isFile() || held.size > MAX_FILE_BYTES) return null;
    if (process.getuid !== undefined && held.uid !== process.getuid()) return null;
    const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    try {
      const parts: Buffer[] = [];
      const buf = Buffer.alloc(65_536);
      for (;;) {
        const read = readSync(fd, buf, 0, buf.length, null);
        if (read === 0) break;
        parts.push(Buffer.from(buf.subarray(0, read)));
      }
      return Buffer.concat(parts).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The declaration a JSON settings file holds, or null when it holds none. */
function policyAt(path: string): CrossSessionInbound | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    return inboundPolicyOf(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** A regular settings file's text, read as this user's file without following a link. */
export function readDeclarationText(path: string): string | null {
  return readText(path);
}

/** The modification time of the file a declaration came from, or null. */
function mtimeOf(path: string): number | null {
  try {
    const held = lstatSync(path);
    return held.isFile() ? held.mtimeMs : null;
  } catch {
    return null;
  }
}

/** One launch line's words, with quotes and backslash escapes taken as a shell would. */
export function launchWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const char of line) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/** A word with a leading `~` expanded; other words are returned as written. */
function expandHome(word: string): string {
  if (word === '~') return homedir();
  if (word.startsWith('~/')) return join(homedir(), word.slice(2));
  return word;
}

/** The scripts a launch line names: words with a slash that resolve to a regular file. */
function launchScripts(launch: string, root: string): string[] {
  const out: string[] = [];
  for (const word of launchWords(launch)) {
    if (out.length >= MAX_SCRIPTS) break;
    if (!word.includes('/') && !word.startsWith('~')) continue;
    const path = expandHome(word);
    const full = isAbsolute(path) ? path : resolve(root, path);
    if (underOwnerCliHome(full)) continue;
    try {
      if (!lstatSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/** A `--settings` value parsed to its word: inline JSON, or a path resolved beside the script. */
function wordOfValue(value: string, script: string): { policy: CrossSessionInbound | null; source: string; declaredAt: number | null } {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    let policy: CrossSessionInbound | null = null;
    try {
      policy = inboundPolicyOf(JSON.parse(trimmed) as unknown);
    } catch {
      policy = null;
    }
    return { policy, source: script, declaredAt: mtimeOf(script) };
  }
  const expanded = expandHome(trimmed);
  const full = isAbsolute(expanded) ? expanded : resolve(dirname(script), expanded);
  return { policy: policyAt(full), source: full, declaredAt: mtimeOf(full) };
}

/**
 * The word one script hands the CLI: its LAST `--settings`, or null when it names none. A script
 * with several settings flags passes the last one, so the last one is the declaration.
 */
function scriptWord(path: string): { policy: CrossSessionInbound | null; source: string; declaredAt: number | null } | null {
  const text = readText(path);
  if (text === null) return null;
  const found = [
    ...text.matchAll(/(?:^|[^A-Za-z0-9_-])--settings(?:=|\s+)(?:'([^']*)'|"([^"]*)"|([^\s;|&]+))/g),
  ];
  const last = found.at(-1);
  if (last === undefined) return null;
  const value = last[1] ?? last[2] ?? last[3];
  if (value === undefined || value === '') return null;
  return wordOfValue(value, path);
}

/**
 * The word the launch line itself spells, before any script runs it: its last `--settings`,
 * inline or `=`. A line that names settings hands the CLI that value; the scripts it names are
 * not read past it, because the line's own flag is what decides on the argv as written.
 */
function lineWord(launch: string, root: string): { policy: CrossSessionInbound | null; source: string; declaredAt: number | null } | null {
  const words = launchWords(launch);
  let value: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    if (word === '--settings') {
      value = words[i + 1];
      i += 1;
    } else if (word.startsWith('--settings=')) {
      value = word.slice('--settings='.length);
    }
  }
  if (value === undefined || value === '') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    let policy: CrossSessionInbound | null = null;
    try {
      policy = inboundPolicyOf(JSON.parse(trimmed) as unknown);
    } catch {
      policy = null;
    }
    return { policy, source: root, declaredAt: null };
  }
  const expanded = expandHome(trimmed);
  const full = isAbsolute(expanded) ? expanded : resolve(root, expanded);
  return { policy: policyAt(full), source: full, declaredAt: mtimeOf(full) };
}

/**
 * The word the launch line leaves the CLI with, before this build appends its generated settings
 * file: the line's own `--settings` when it names one, else the last script that names a settings
 * flag (exactly as the last `--settings` on the final argv would). A script that names settings
 * but declares nothing is an unset word — an earlier script's `accept` is not read through it.
 */
export function wrapperInboundOf(input: { root: string; launch: string }): LaunchInbound {
  const own = lineWord(input.launch, input.root);
  if (own !== null) return own;
  let word: { policy: CrossSessionInbound | null; source: string; declaredAt: number | null } | null = null;
  for (const script of launchScripts(input.launch, input.root)) {
    const found = scriptWord(script);
    if (found !== null) word = found;
  }
  if (word === null) return NONE;
  return { policy: word.policy, source: word.source, declaredAt: word.declaredAt };
}

// The receiving seat's own declaration that it accepts cross-session socket frames.
//
// A Claude Code session surfaces a frame from another session only when its own top-level
// setting `crossSessionInbound` is `accept`; `hold`, `refuse` and unset either hold the frame
// at a dialog or drop it, and a held frame blocks the receiving seat's box until a person lets
// it through. A sender that dials on its own guess would do that to a seat that never agreed,
// so the walk reads the declaration the session was launched with and dials on `accept` alone.
//
// Two team-owned places are read, in this order, and nothing under an owner CLI home is ever
// opened:
//   - the launch's own per-seat settings file at `<state>/hooks/<session>/<seat>.json`;
//   - every script the seat's `launch` line names, scanned for `--settings`: an inline JSON
//     value is parsed as written, and a path is read as a JSON file. A launcher wrapper that
//     adds `--settings '{"crossSessionInbound":"accept"}'` before it execs the CLI is the shape
//     this reads.
// The file the declaration came from keeps its modification time: a session started before
// that file changed was launched without the setting in force, and the socket it exposes is
// older than the declaration. `inboundIsLive` compares the two so a not-yet-restarted seat is
// skipped rather than sent a frame its session would hold.
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { cliHookSettingsPath } from '../launch/cli-hook.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_FILE_BYTES = 262_144;
const MAX_SCRIPTS = 8;

/** The exact values Claude Code accepts for the top-level receiver setting. */
export type CrossSessionInbound = 'accept' | 'hold' | 'refuse';

/** The declaration read from the receiving seat's launch, and where it came from. */
export type InboundDeclaration = {
  policy: CrossSessionInbound | null;
  /** When the file that carried the declaration last changed, or null with no declaration. */
  declaredAt: number | null;
  /** The file the declaration came from, for a person to inspect; null when nothing declared one. */
  source: string | null;
};

const NONE: InboundDeclaration = { policy: null, declaredAt: null, source: null };

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

/**
 * The value of the last `--settings` a script names, or null. The value is the JSON itself when
 * it starts with `{`, else a path resolved beside the script and read as JSON. A script with
 * several settings flags hands the last one to the CLI, so the last one is the declaration.
 */
function policyOfScript(path: string): CrossSessionInbound | null {
  const text = readText(path);
  if (text === null) return null;
  const found = [
    ...text.matchAll(/(?:^|[^A-Za-z0-9_-])--settings(?:=|\s+)(?:'([^']*)'|"([^"]*)"|([^\s;|&]+))/g),
  ];
  const last = found.at(-1);
  if (last === undefined) return null;
  const value = last[1] ?? last[2] ?? last[3];
  if (value === undefined || value === '') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    try {
      return inboundPolicyOf(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  const expanded = expandHome(trimmed);
  const full = isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
  return policyAt(full);
}

/**
 * The declaration in force for the receiving seat: the launch's per-seat settings file first,
 * then each script its launch line names, in order. The first declaration found is the one
 * the launched CLI holds; a file that declares nothing is passed over.
 */
export function declaredInboundOf(input: {
  /** The receiving team's state folder (the folder holding the team file). */
  dir: string;
  /** The receiving team's root, for a relative script in the launch line. */
  root: string;
  session: string;
  seat: string;
  launch?: string;
}): InboundDeclaration {
  const settings = cliHookSettingsPath(input.dir, input.session, input.seat);
  if (settings !== null) {
    const policy = policyAt(settings);
    if (policy !== null) return { policy, declaredAt: mtimeOf(settings), source: settings };
  }
  if (input.launch !== undefined && input.launch !== '') {
    for (const script of launchScripts(input.launch, input.root)) {
      const policy = policyOfScript(script);
      if (policy !== null) return { policy, declaredAt: mtimeOf(script), source: script };
    }
  }
  return NONE;
}

/**
 * Whether the running session was launched with the declaration in force: the socket it exposes
 * must not predate the file that declares `accept`. A session older than its launcher's change
 * was started without the setting, and a frame sent to it would be held; the walk skips it and
 * says why. A socket this run cannot stat is not a proof of staleness, so the declaration stands.
 */
export function inboundIsLive(declaration: InboundDeclaration, socketPath: string): boolean {
  if (declaration.policy !== 'accept' || declaration.declaredAt === null) return true;
  try {
    return lstatSync(socketPath).mtimeMs >= declaration.declaredAt;
  } catch {
    return true;
  }
}

/** The line a walk records instead of dialing, by the declaration it read. */
export function inboundSkipReason(policy: CrossSessionInbound | null): string {
  if (policy === 'hold') return 'the receiving Claude session declares crossSessionInbound hold, which would hold the frame at its box';
  if (policy === 'refuse') return 'the receiving Claude session declares crossSessionInbound refuse';
  return 'the receiving Claude session does not declare crossSessionInbound accept';
}

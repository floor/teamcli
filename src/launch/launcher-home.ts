// The launcher home and the line compiled from a declaration. A secret is a reference.
// The identity wrapper is a field of the declaration, never a script path on the line.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Seat } from '../file/types.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../mcp/channel.ts';
import { parseYaml, toValue } from '../yaml.ts';

const INBOUND = '{"crossSessionInbound":"accept"}';
const CONFIGURED_HOME = join('.config', 'team', 'launcher-home');

export type LauncherDecl = {
  name: string;
  harness: 'claude-code' | 'codex' | 'cursor' | 'grok' | 'agy' | 'jules' | string;
  argv: string[];
  env?: Record<string, { ref: string }>;
  endpoint?: string;
  identity?: string;
};

export type LauncherHomeRead =
  | { ok: true; launchers: LauncherDecl[] }
  | { ok: false; problems: string[] };

/** `~/.config/team/launchers`, or the single path written in `launcher-home` when that
 *  file is a private regular file. */
export function launcherHome(home: string): string {
  const pointer = join(home, CONFIGURED_HOME);
  try {
    const info = lstatSync(pointer);
    if (!info.isFile() || (info.mode & 0o022) !== 0) return defaultHome(home);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return defaultHome(home);
    const named = readFileSync(pointer, 'utf8').trim();
    if (named === '' || named.includes('\n') || !isAbsolute(named)) return defaultHome(home);
    return named;
  } catch {
    return defaultHome(home);
  }
}

function defaultHome(home: string): string {
  return join(home, '.config', 'team', 'launchers');
}

/** Reads and validates the launcher home. A missing folder is an empty home. A file that
 *  is group- or world-writable, or not owned by this user, is refused. An env value that
 *  is not `{ ref }` is refused. */
export function readLauncherHome(home: string): LauncherHomeRead {
  const dir = launcherHome(home);
  let names: string[];
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { ok: false, problems: [`${dir} is not a launcher home directory`] };
    }
    if ((info.mode & 0o022) !== 0) {
      return { ok: false, problems: [`${dir} is group- or world-writable`] };
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      return { ok: false, problems: [`${dir} is not owned by this user`] };
    }
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, launchers: [] };
    return { ok: false, problems: [`${dir} cannot be read`] };
  }
  const launchers: LauncherDecl[] = [];
  const problems: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') && !name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const path = join(dir, name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      problems.push(`${name} cannot be read`);
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      problems.push(`${name} is not a regular file`);
      continue;
    }
    if ((info.mode & 0o022) !== 0) {
      problems.push(`${name} is group- or world-writable`);
      continue;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      problems.push(`${name} is not owned by this user`);
      continue;
    }
    let parsed: unknown;
    try {
      const text = readFileSync(path, 'utf8');
      parsed = name.endsWith('.json') ? JSON.parse(text) : toValue(parseYaml(text));
    } catch {
      problems.push(`${name} could not be read`);
      continue;
    }
    const decl = declarationOf(parsed, name.replace(/\.(json|yaml|yml)$/, ''));
    if (typeof decl === 'string') problems.push(decl);
    else launchers.push(decl);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, launchers };
}

/** The lead's built-in Claude Code declaration. The identity wrapper is the `identity`
 *  field. The line compiled from this declaration names no script. */
export function builtinLeadDecl(
  seat: { name: string; model: string; agent_session?: string },
  channel: boolean,
): LauncherDecl {
  const argv = ['claude', '--model', seat.model, '--settings', INBOUND];
  if (seat.agent_session !== undefined && seat.agent_session !== '') argv.push('--resume', seat.agent_session);
  if (channel) argv.push(CHANNEL_FLAG, `server:${CHANNEL_SERVER}`);
  return { name: seat.name, harness: 'claude-code', argv, identity: 'account' };
}

/** The launch line TeamCLI runs. A claude-code declaration gains the seat's model, its
 *  recorded conversation, inbound accept, and the channel flag when the seat carries one.
 *  `identity` stays a field: it is never written as a script path. */
export function compileLauncher(
  decl: LauncherDecl,
  seat: Seat & { agent_session?: string; channel?: boolean },
): string {
  const argv = [...decl.argv];
  if (decl.harness === 'claude-code') {
    if (!hasWord(argv, '--model') && seat.model !== '') argv.push('--model', seat.model);
    if (!argv.some((word) => word.includes('crossSessionInbound'))) argv.push('--settings', INBOUND);
    const session = seat.agent_session;
    if (session !== undefined && session !== '' && !hasWord(argv, '--resume') && !hasWord(argv, '-r')) {
      argv.push('--resume', session);
    }
    if (seat.channel === true && !hasWord(argv, CHANNEL_FLAG)) argv.push(CHANNEL_FLAG, `server:${CHANNEL_SERVER}`);
  }
  return argv.map(quote).join(' ');
}

/** Where a path sits, for the launch-line check. The real one reads the temp roots and walks
 *  for a git directory. A fixture world supplies its own, so the world's own folder is neither. */
export type LaunchPlace = {
  inTemp(path: string): boolean;
  insideRepo(path: string): boolean;
};

/** The temp roots a production check uses: `os.tmpdir()`, `TMPDIR` when it is set, `/tmp`
 *  and `/private/tmp`. Read at the call, so a test that changes `TMPDIR` is what runs. */
export function realLaunchPlace(): LaunchPlace {
  return { inTemp: realInTemp, insideRepo: realInsideRepo };
}

/** A problem when `line` runs a script inside a git repo or a temp folder. An ordinary
 *  program word is not a problem. `place` is the real detection when a caller does not
 *  pass one. */
export function launchLineProblem(
  line: string,
  root: string,
  home: string,
  place: LaunchPlace = realLaunchPlace(),
): string | null {
  for (const word of pathWords(line, home, root)) {
    if (place.inTemp(word)) return `its launch line runs a script from a temp folder (${word})`;
    if (place.insideRepo(word)) return `its launch line runs a script inside a repository (${word})`;
  }
  return null;
}

function pathWords(line: string, home: string, root: string): string[] {
  const out: string[] = [];
  for (const raw of line.split(/\s+/)) {
    const word = raw.replace(/^['"]|['"]$/g, '');
    if (word === '' || word.startsWith('-') || word.includes('://')) continue;
    const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
    if (!value.includes('/') && !value.startsWith('~')) continue;
    const expanded = value.startsWith('~/') ? join(home, value.slice(2)) : value;
    out.push(isAbsolute(expanded) ? expanded : resolve(root, expanded));
  }
  return out;
}

function realInTemp(path: string): boolean {
  const named = [process.env.TMPDIR, tmpdir(), '/tmp', '/private/tmp'];
  const roots = named.filter((dir): dir is string => dir !== undefined && dir !== '').map((dir) => dir.replace(/\/$/, ''));
  return roots.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

function realInsideRepo(path: string): boolean {
  let dir = dirname(path);
  for (let step = 0; step < 64; step += 1) {
    try {
      const git = lstatSync(join(dir, '.git'));
      if (git.isDirectory() || git.isFile()) return true;
    } catch {
      // This directory is not a repository root.
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function declarationOf(value: unknown, stem: string): LauncherDecl | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${stem} is not a launcher declaration`;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['name', 'harness', 'argv', 'env', 'endpoint', 'identity'].includes(key)) {
      return `${stem} has an unknown key ${key}`;
    }
  }
  if (typeof record.name !== 'string' || record.name === '' || record.name !== stem) {
    return `${stem} must be named ${stem}`;
  }
  if (typeof record.harness !== 'string' || record.harness === '') return `${stem} names no harness`;
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.some((word) => typeof word !== 'string' || word === '')) {
    return `${stem} argv is a list of words`;
  }
  const decl: LauncherDecl = { name: record.name, harness: record.harness, argv: record.argv as string[] };
  if (record.endpoint !== undefined) {
    if (typeof record.endpoint !== 'string' || record.endpoint === '') return `${stem} endpoint is a string`;
    decl.endpoint = record.endpoint;
  }
  if (record.identity !== undefined) {
    if (typeof record.identity !== 'string' || record.identity === '') return `${stem} identity is a string`;
    decl.identity = record.identity;
  }
  if (record.env !== undefined) {
    if (record.env === null || typeof record.env !== 'object' || Array.isArray(record.env)) return `${stem} env is a map of references`;
    const env: Record<string, { ref: string }> = {};
    for (const [name, item] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof item === 'string') return `${stem} env ${name} is a value, not a { ref }`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return `${stem} env ${name} is a value, not a { ref }`;
      const keys = Object.keys(item);
      const ref = (item as { ref?: unknown }).ref;
      if (keys.length !== 1 || keys[0] !== 'ref' || typeof ref !== 'string' || ref === '') {
        return `${stem} env ${name} is a value, not a { ref }`;
      }
      env[name] = { ref };
    }
    decl.env = env;
  }
  return decl;
}

function hasWord(argv: readonly string[], word: string): boolean {
  return argv.includes(word);
}

function quote(word: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

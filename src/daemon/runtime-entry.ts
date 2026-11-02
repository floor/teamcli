// The stable program a daemon runtime copy stands for.
//
// The service unit runs a copy of the whole program under the machine folder
// (`daemon-runtime/<sha>/…`), never the package folder a later upgrade rewrites. The daemon's
// restore pass runs `up` in-process, so every hook settings file it installs names the CLI that
// ran the install — the private copy, which the next install may replace or delete. A seat's
// hooks must outlive that copy: they name the installed program the copy was made from instead.
//
// The install writes that origin down once, beside the copies, after the daemon it started
// answered the health probe. `cleanRuntime` only deletes folders named for a content hash, so the
// record survives a refresh; the copy it describes may not. Nothing here reads a file a CLI
// owns: the record lives under the machine folder this module names.
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { daemonRuntimeRoot } from './paths.ts';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_RECORD_BYTES = 65_536;

/** The name of the record inside the runtime folder. A hash is 64 hex characters, so no retained
 *  copy can share this name, and the cleanup that removes copies leaves it alone. */
export const INSTALLED_PROGRAM_FILE = 'installed-program.json';

/** The installed program a runtime copy was made from: the package root the copy reproduces and
 *  the entry the unit would run in place of the copy. */
export type InstalledProgram = { format: 1; entry: string; root: string };

/** `<home>/.config/team/daemon-runtime/installed-program.json`. */
export function installedProgramRecordPath(home: string = homedir()): string {
  return join(daemonRuntimeRoot(home), INSTALLED_PROGRAM_FILE);
}

/** The record this home holds, or null when there is none, it is not this user's regular file,
 *  it cannot be read whole, or it does not name two absolute paths. */
export function readInstalledProgram(home: string = homedir()): InstalledProgram | null {
  const path = installedProgramRecordPath(home);
  let held;
  try {
    held = lstatSync(path);
  } catch {
    return null;
  }
  if (!held.isFile() || (process.getuid !== undefined && held.uid !== process.getuid())) return null;
  if (held.size > MAX_RECORD_BYTES) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  let text: string;
  try {
    const buffer = Buffer.alloc(held.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read !== buffer.length) return null;
    text = buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { format, entry, root } = parsed as { format?: unknown; entry?: unknown; root?: unknown };
  if (format !== 1 || typeof entry !== 'string' || typeof root !== 'string') return null;
  if (!isAbsolute(entry) || !isAbsolute(root)) return null;
  // The entry is one file of the program its root holds, the same invariant the copy enforces:
  // a record whose entry escapes its root describes no program this install could have made.
  const inside = relative(resolve(root), resolve(entry));
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return { format: 1, entry: resolve(entry), root: resolve(root) };
}

/**
 * Records the installed program a service install was made from. Best effort: false on every
 * fault, and the install it follows is not undone — a missing record only means hooks refuse to
 * name a CLI rather than naming a path a refresh can remove. An entry already inside the runtime
 * folder is the copy itself, not its origin, and is never recorded.
 */
export function recordInstalledProgram(
  home: string,
  program: { entry: string; root: string },
): boolean {
  const entry = resolve(program.entry);
  const root = resolve(program.root);
  const runtime = resolve(daemonRuntimeRoot(home));
  if (!isAbsolute(entry) || !isAbsolute(root)) return false;
  if (entry === runtime || entry.startsWith(`${runtime}${sep}`)) return false;
  const record: InstalledProgram = { format: 1, entry, root };
  const path = installedProgramRecordPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    for (let wrote = 0; wrote < buffer.length;) {
      wrote += writeSync(fd, buffer, wrote, buffer.length - wrote);
    }
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * The path a hook command may name: `path` itself when it is already stable (a package install,
 * a checkout), or — when it is inside one of this home's retained runtime copies — the same file
 * under the installed program the copy was made from. Null when the path names a copy whose
 * origin is not recorded, or whose twin is no longer there: a command that names the copy is
 * exactly the one a later refresh breaks, so the caller writes none.
 */
export function stableHookPath(path: string, home: string = homedir()): string | null {
  const absolute = resolve(path);
  const runtime = resolve(daemonRuntimeRoot(home));
  if (absolute !== runtime && !absolute.startsWith(`${runtime}${sep}`)) return absolute;
  const parts = absolute.slice(runtime.length + 1).split(sep);
  const copy = parts[0];
  // A retained copy is the whole first segment, a content hash; a file directly in the runtime
  // folder is not a program file this install wrote.
  if (copy === undefined || copy === '' || !/^[0-9a-f]{64}$/.test(copy) || parts.length < 2) return null;
  const installed = readInstalledProgram(home);
  if (installed === null) return null;
  const twin = resolve(installed.root, ...parts.slice(1));
  if (!existsSync(twin)) return null;
  return twin;
}

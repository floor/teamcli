// The local service-manager adapter. Every platform-specific word, file and command lives here;
// the neutral `team daemon install` interface above it prints none of them to the user. The
// adapter writes a user service unit that starts the daemon at login and restarts it when it
// exits non-zero. A clean exit (the daemon stopped) is not restarted.
//
// A refresh must leave a daemon able to run, not only a unit that names one. A unit runs a
// program, and a built program is a module tree that reads its manifest and the sibling packages
// beside it: restoring one entry file is not restoring a program. So an install copies the whole
// program into a content-addressed folder under the machine config and writes the unit against
// that copy. The package a later upgrade replaces is not the program this unit runs, and the
// earlier unit an undo restores still names the untouched copy it was installed with.
//
// The copy is content-addressed by its paths, modes and bytes. A folder already at the computed
// path is used only after it is verified to be this user's own, owner-only, without a group- or
// world-writable file, and byte-identical to the name it carries; anything else is refused,
// because a retained copy that was changed must never be run.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DAEMON_LABEL, daemonLogPath, daemonRuntimeRoot, machineConfigDir } from './paths.ts';
import type {
  ServiceInstallFailure,
  ServiceInstallResult,
  ServiceJobRecord,
  ServiceManager,
  ServiceManagerOptions,
  ServicePlan,
  ServiceProgram,
  ServiceRestartResult,
  ServiceRunResult,
  ServiceRunner,
  ServiceUnitRecord,
  ServiceUninstallResult,
} from './service.ts';

/** `O_NOFOLLOW` is POSIX: a platform without it gets 0, and the `lstat` check before every open
 *  is what refuses a link; the flag makes the open itself refuse one that appeared after it. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const realRunner: ServiceRunner = (command, args): ServiceRunResult => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? `${result.error.message}\n${result.stderr ?? ''}` : (result.stderr ?? ''),
  };
};

// The waits between load offers, all bounded so `team daemon install` cannot hang. A load
// handed to the manager while the daemon it replaces is still leaving is refused — the race
// that emptied the machine before this fix — so a refused offer is repeated while the waits
// grow, giving that stop time to finish before the install calls the new unit failed. The
// whole retry is over in about five seconds.
const LOAD_RETRY_MS: readonly number[] = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000];

/** A synchronous wait: install is synchronous and the bounded retries pause it. */
function realSleep(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One file of a program: where its bytes are now, the name the copy keeps, and its mode. The
 *  mode is part of the copy's identity: an executable that lost its execute bit is not the same
 *  program, so a folder whose files drifted from it is refused rather than run. */
type RuntimeFile = { relative: string; source: string; mode: number };

/** A file's mode as the copy keeps it: no group or world write, and the owner can read it. */
function keptMode(mode: number): number {
  return (mode & 0o777 & ~0o022) | 0o400;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The first `<key>key</key><string>…</string>` value in a plist text, or null. */
function plistString(text: string, key: string): string | null {
  const found = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(text);
  return found === null ? null : unescapeXml(found[1] ?? '');
}

/** The `<string>` entries of a plist text's named array, or null when it carries none. */
function plistStrings(text: string, key: string): string[] | null {
  const found = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(text);
  if (found === null) return null;
  return [...(found[1] ?? '').matchAll(/<string>([\s\S]*?)<\/string>/g)].map((one) => unescapeXml(one[1] ?? ''));
}

function programOf(program: ServiceProgram): string[] {
  const args = [program.execPath, program.entry, 'daemon', 'run', '--started-by', 'service-manager'];
  for (const root of program.roots) args.push('--root', root);
  // The unit records the same opt-ins a foreground run takes: each flag is written only when the
  // install program asked for it, so a plain unit hosts neither presence nor a watch.
  if (program.presence === true) args.push('--presence');
  // The watch opt-in is separate: a unit may record either, both or neither.
  if (program.watch === true) args.push('--watch');
  // The general grant and client key that admitted the install are never written here: the
  // service-started run is admitted by `--started-by service-manager` itself, and a definition
  // that named either would keep a credential on disk where the service manager reads it.
  return args;
}

/** Whether a written unit's run command names a client key or a general grant — the two
 *  arguments a version before this one persisted, and that an install now rewrites without. */
function namesAuthorization(text: string): boolean {
  return [...text.matchAll(/<string>([^<]*)<\/string>/g)]
    .some((entry) => entry[1] === '--general' || entry[1] === '--key');
}

function unitText(home: string, program: string[], path?: string): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  // The installer's PATH, so the service finds herdr and the CLIs where the owner's shell does.
  const env = path === undefined || path === ''
    ? ''
    : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${escapeXml(path)}</string>\n  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(daemonLogPath(home))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(daemonLogPath(home))}</string>
</dict>
</plist>
`;
}

export function darwinServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const run = options.runner ?? realRunner;
  const sleep = options.sleep ?? realSleep;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

  const unitPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  const domain = `gui/${String(uid)}`;
  const service = `${domain}/${DAEMON_LABEL}`;

  /** Loads the unit at `path`, retrying a refusal with a bounded, growing wait. A refusal while
   *  the job this unit replaces is still leaving is the same answer as a unit the manager will
   *  not take, so both are given the same bounded patience: the manager accepts the load as soon
   *  as the earlier job has left. */
  const loadWithRetry = (path: string): ServiceRunResult => {
    let result = run('launchctl', ['bootstrap', domain, path]);
    for (const wait of LOAD_RETRY_MS) {
      if (result.status === 0) break;
      sleep(wait);
      result = run('launchctl', ['bootstrap', domain, path]);
    }
    return result;
  };

  /** One failed load, in the words the daemon log carries. */
  const loadDetail = (result: ServiceRunResult): string =>
    `the load exited ${String(result.status)}: ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`;

  /**
   * The manager's own record of the job under the daemon's label. The printed job record names
   * the pid, the program and the arguments; the plist-form list is the fallback when the
   * printed record cannot be read. Both texts are parsed here and nowhere else. Null means the
   * manager kept no record this command can read — the start admission refuses closed.
   *
   * The shape was supplied by the owner's read of the manager (2026-11-01): the printed record
   * carries `pid = <n>`, `program = <executable>`, `state = running` and an `arguments = { … }`
   * block with one string per line; the list form is a plist dict with Label, PID, Program,
   * ProgramArguments. This seat could not run the manager's commands itself, so the parser is
   * tolerant of both forms and its exact output is not claimed as measured here.
   */
  const jobRecord = (): ServiceJobRecord | null => {
    const printed = run('launchctl', ['print', service]);
    if (printed.status === 0) {
      const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1];
      // A record with no program line still carries the job's own first argument; either is
      // the executable the job was started from, and the admission compares it by real path.
      const program = /^\s*program = (.+?)\s*$/m.exec(printed.stdout)?.[1]
        ?? /^\s*arguments = \{\s*\n\s*([^\n]+?)\s*$/m.exec(printed.stdout)?.[1];
      return { pid: pid === undefined ? null : Number(pid), program: program ?? null };
    }
    const listed = run('launchctl', ['list', DAEMON_LABEL]);
    if (listed.status !== 0) return null;
    const pid = /^\s*"PID"\s*=\s*(\d+)\s*;/m.exec(listed.stdout)?.[1];
    const quoted = /^\s*"Program"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/m.exec(listed.stdout)?.[1];
    return {
      pid: pid === undefined ? null : Number(pid),
      program: quoted === undefined ? null : quoted.replace(/\\(.)/g, '$1'),
    };
  };

  /**
   * The unit file's own words. A symlink or any other non-regular file is refused, so the
   * record describes the file the job was started from and not a name pointing elsewhere.
   * Unreadable is null: the caller refuses closed.
   */
  const unitRecord = (home: string): ServiceUnitRecord | null => {
    const path = unitPath(home);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      return null;
    }
    if (!stats.isFile()) return null;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    return {
      path,
      label: plistString(text, 'Label'),
      ownerUid: stats.uid,
      mode: stats.mode & 0o777,
      programArguments: plistStrings(text, 'ProgramArguments'),
    };
  };

  const refused = (
    what: string,
    detail: string,
    outcome: ServiceInstallFailure['outcome'],
    kept: boolean,
  ): ServiceInstallFailure => ({ ok: false, why: what, detail, outcome, kept });

  const ownUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : uid);

  /** Where a home's retained runtime copies live: `<home>/.config/team/daemon-runtime`. */
  const runtimeRoot = (home: string): string => daemonRuntimeRoot(home);

  /**
   * The folder the retained copies live in, made or checked before anything is written there.
   * It is made owner-only. One already there must be this user's own directory, and no group or
   * other write may reach it, or the install refuses: a folder another user can write is not a
   * place to keep a program a unit runs. The folder itself is never taken as a symbolic link —
   * a link could name a folder other than the one a unit appears to run — and the copies inside
   * it are checked the same way by `verifiedCopy`.
   */
  const runtimeFolder = (home: string): { ok: true; path: string } | { ok: false; detail: string } => {
    const root = runtimeRoot(home);
    let stats: ReturnType<typeof lstatSync> | null = null;
    try {
      stats = lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, detail: `${root} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (stats === null) {
      try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        chmodSync(root, 0o700);
      } catch (error) {
        return { ok: false, detail: `${root} could not be made: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { ok: true, path: root };
    }
    if (stats.isSymbolicLink()) return { ok: false, detail: `${root} is a symbolic link` };
    if (!stats.isDirectory()) return { ok: false, detail: `${root} is not a directory` };
    if (stats.uid !== ownUid()) return { ok: false, detail: `${root} is not this user's` };
    if ((stats.mode & 0o022) !== 0) return { ok: false, detail: `${root} is writable by the group or the world` };
    return { ok: true, path: root };
  };

  /**
   * The program as the set of files a copy must reproduce. A caller that names a set has it
   * copied as it stands; a synthetic scene's entry names none, and its own directory is then the
   * whole program. The entry is always named relative to the set's root, because that is the
   * name it keeps in the copy.
   */
  const runtimeSet = (program: ServiceProgram): { root: string; include: string[]; entry: string } => {
    const entry = resolve(program.entry);
    const root = program.runtime === undefined ? dirname(entry) : resolve(program.runtime.root);
    const include = program.runtime === undefined ? ['.'] : [...program.runtime.include];
    return { root, include, entry: relative(root, entry) };
  };

  /**
   * Every regular file the program is made of, in a stable order — or why the program cannot be
   * read whole. A symlink, another kind of file, a named path that is missing, or a path that
   * leaves the root is refused: a copy that follows a name out of the tree, or silently lacks a
   * file, is not the program the unit would run. The machine folder the copies live in is never
   * part of a program, so a program whose root is the home folder cannot copy its own copies.
   */
  const runtimeFiles = (
    home: string,
    set: { root: string; include: string[]; entry: string },
  ): { ok: true; files: RuntimeFile[] } | { ok: false; detail: string } => {
    const config = resolve(machineConfigDir(home));
    const skipped = (absolute: string): boolean => absolute === config || absolute.startsWith(`${config}${sep}`);
    if (set.entry === '' || isAbsolute(set.entry) || set.entry === '..' || set.entry.startsWith(`..${sep}`)) {
      return { ok: false, detail: `the entry ${set.entry} is not a file under ${set.root}` };
    }
    const files = new Map<string, RuntimeFile>();
    try {
      for (const include of set.include) {
        const absolute = resolve(set.root, include);
        if (absolute !== set.root && !absolute.startsWith(`${set.root}${sep}`)) {
          return { ok: false, detail: `the program's ${include} is outside ${set.root}` };
        }
        if (!existsSync(absolute)) return { ok: false, detail: `the program's ${include} is not on disk` };
        const collect = (pathNow: string, relativeNow: string): string | null => {
          if (skipped(pathNow)) return null;
          const stats = lstatSync(pathNow);
          if (stats.isSymbolicLink()) return `${relativeNow} is a symbolic link`;
          if (stats.isDirectory()) {
            for (const name of readdirSync(pathNow).sort()) {
              const bad = collect(join(pathNow, name), relativeNow === '' ? name : `${relativeNow}/${name}`);
              if (bad !== null) return bad;
            }
            return null;
          }
          if (!stats.isFile()) return `${relativeNow} is not a regular file`;
          files.set(relativeNow, { relative: relativeNow, source: pathNow, mode: stats.mode & 0o777 });
          return null;
        };
        const bad = collect(absolute, include === '.' ? '' : include);
        if (bad !== null) return { ok: false, detail: bad };
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!files.has(set.entry)) {
      return { ok: false, detail: `the entry ${set.entry} is not one of the files the program is made of` };
    }
    return {
      ok: true,
      files: [...files.values()].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)),
    };
  };

  /**
   * The copy's name: every relative path, the mode the copy keeps, and the file's own hash. The
   * mode is part of the identity — a program whose executable lost its execute bit is not the
   * same program, and a folder whose files drifted from this name is refused rather than run.
   */
  const runtimeHash = (files: readonly RuntimeFile[]): string => {
    const tree = createHash('sha256');
    tree.update('team-daemon-runtime:1\n');
    for (const file of files) {
      tree.update(`${file.relative}\0${keptMode(file.mode).toString(8)}\0${sha256(readFileSync(file.source))}\n`);
    }
    return tree.digest('hex');
  };

  /**
   * Whether the folder at `target` is the copy its name claims: this user's own directory,
   * owner-only at every level, no file writable by the group or the world, the exact file set,
   * and every file byte-identical to the name. Null when it is, otherwise what is wrong. A
   * retained copy that was changed must never be run, so any deviation refuses the install.
   */
  const verifiedCopy = (target: string, sha: string): string | null => {
    let rootStats: ReturnType<typeof lstatSync>;
    try {
      rootStats = lstatSync(target);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (!rootStats.isDirectory()) return `${target} is not a directory`;
    if (rootStats.uid !== ownUid()) return `${target} is not this user's`;
    if ((rootStats.mode & 0o777) !== 0o700) return `${target} is not owner-only`;
    const found = new Map<string, RuntimeFile>();
    const walk = (absolute: string, relativeNow: string): string | null => {
      const here = lstatSync(absolute);
      if (here.isSymbolicLink()) return `${relativeNow} is a symbolic link`;
      if (here.isDirectory()) {
        if (here.uid !== rootStats.uid) return `${relativeNow} is not this user's`;
        if ((here.mode & 0o777) !== 0o700) return `${relativeNow} is not owner-only`;
        for (const name of readdirSync(absolute).sort()) {
          const bad = walk(join(absolute, name), relativeNow === '' ? name : `${relativeNow}/${name}`);
          if (bad !== null) return bad;
        }
        return null;
      }
      if (!here.isFile()) return `${relativeNow} is not a regular file`;
      if (here.uid !== rootStats.uid) return `${relativeNow} is not this user's`;
      if ((here.mode & 0o022) !== 0) return `${relativeNow} is writable by the group or the world`;
      found.set(relativeNow, { relative: relativeNow, source: absolute, mode: here.mode & 0o777 });
      return null;
    };
    const bad = walk(target, '');
    if (bad !== null) return bad;
    const files = [...found.values()].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    return runtimeHash(files) === sha ? null : `${target} does not match the hash it is named by`;
  };

  /**
   * Writes the program's files into `<machine config>/daemon-runtime/<sha>/`, owner-only, under
   * a temporary name and renamed into place, so a folder that carries the name is always whole.
   * The folder those copies live in is made or checked first, and only then is an existing copy
   * at the name used, after `verifiedCopy` accepts it.
   */
  const materialize = (
    home: string,
    files: readonly RuntimeFile[],
    sha: string,
  ): { ok: true; path: string } | { ok: false; detail: string } => {
    const folder = runtimeFolder(home);
    if (!folder.ok) return { ok: false, detail: folder.detail };
    const root = folder.path;
    const target = join(root, sha);
    if (existsSync(target)) {
      const bad = verifiedCopy(target, sha);
      return bad === null ? { ok: true, path: target } : { ok: false, detail: bad };
    }
    let temporary: string | null = null;
    try {
      temporary = join(root, `.${sha}.${String(process.pid)}.tmp`);
      rmSync(temporary, { recursive: true, force: true });
      mkdirSync(temporary, { mode: 0o700 });
      for (const file of files) {
        const destination = join(temporary, file.relative);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const mode = keptMode(file.mode);
        writeFileSync(destination, readFileSync(file.source), { mode });
        chmodSync(destination, mode);
      }
      renameSync(temporary, target);
      temporary = null;
    } catch (error) {
      if (temporary !== null) {
        try {
          rmSync(temporary, { recursive: true, force: true });
        } catch {
          // A leftover temporary folder is never named by a unit and is removed by the next
          // successful install's cleanup.
        }
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const bad = verifiedCopy(target, sha);
    return bad === null ? { ok: true, path: target } : { ok: false, detail: bad };
  };

  /** The runtime folder an earlier unit's own words name under this home's runtime root, or
   *  null when that unit names no copy of ours (a unit written before copies existed). */
  const namedRuntime = (home: string, text: string): string | null => {
    const root = runtimeRoot(home);
    for (const word of plistStrings(text, 'ProgramArguments') ?? []) {
      if (!word.startsWith(`${root}${sep}`)) continue;
      const name = word.slice(root.length + 1).split(sep)[0] ?? '';
      if (/^[0-9a-f]{64}$/.test(name)) return name;
    }
    return null;
  };

  /**
   * Removes the copy this install added — unless the earlier unit names it too, in which case it
   * is the program that unit runs and stays. An undo removes exactly what the install added.
   * Best effort: a copy left behind is never named by the restored unit.
   */
  const dropRuntime = (home: string, sha: string, priorText: string | null): void => {
    const target = join(runtimeRoot(home), sha);
    if (priorText !== null) {
      const words = plistStrings(priorText, 'ProgramArguments') ?? [];
      if (words.some((word) => word === target || word.startsWith(`${target}${sep}`))) return;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort; the next install's cleanup removes it.
    }
  };

  /**
   * Removes runtime folders this tool made that neither the unit on disk nor the unit a rollback
   * may restore names. Only a folder whose name is a content hash is ours; anything else in the
   * runtime folder is left alone. `keepAll` prunes nothing, for a caller that could not prove
   * which copies a seat still needs. Best effort.
   */
  const cleanRuntime = (home: string, keep: readonly (string | null)[], keepAll = false): void => {
    if (keepAll) return;
    const root = runtimeRoot(home);
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    const kept = new Set(keep.filter((one): one is string => one !== null));
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name) || kept.has(name)) continue;
      try {
        rmSync(join(root, name), { recursive: true, force: true });
      } catch {
        // Best effort; the next install tries again.
      }
    }
  };

  /** The hook tree this tool writes is shallow and small; a tree past these bounds is not one it
   *  made, and the install keeps every copy rather than guess that it read the tree whole. */
  const MAX_HOOK_BYTES = 262_144;
  const MAX_HOOK_ENTRIES = 4_096;
  const MAX_HOOK_DEPTH = 8;
  /** A runtime copy's folder name as a hook command embeds it: the command shell-quotes the whole
   *  path, but the name itself is plain text inside the quote. */
  const HOOK_COPY = /daemon-runtime\/([0-9a-f]{64})(?![0-9a-f])/g;

  /**
   * Every runtime copy named by a hook file of any root this install hosts. A seat's hook command
   * runs this tool's entry, and a settings file written from a runtime copy names that copy: the
   * copy is a program a seat still needs after this install returns, even when no unit names it.
   * The walk reads every file under `<root>/.agents/hooks` without following a link; a file it
   * cannot read or parse refuses the whole answer, so the install prunes nothing and says why
   * instead of deleting a copy it could not prove unneeded.
   */
  const hookedCopies = (roots: readonly string[]): { hashes: string[]; fault: string | null } => {
    const found = new Set<string>();
    let entries = 0;
    const walk = (folder: string, depth: number): string | null => {
      let names;
      try {
        names = readdirSync(folder, { withFileTypes: true });
      } catch (error) {
        // A checkout with no hooks folder hosts no hook; any other fault refuses the whole read.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return `the hook files under ${folder} could not be listed`;
      }
      for (const name of names) {
        // This tool never writes a hidden entry under the hooks folder, and skipping them keeps
        // an unrelated browser file from refusing every later install.
        if (name.name.startsWith('.')) continue;
        if (++entries > MAX_HOOK_ENTRIES) return 'the hook files are more than this install reads';
        const path = join(folder, name.name);
        if (name.isSymbolicLink()) return `the hook file ${path} is a symbolic link`;
        if (name.isDirectory()) {
          if (depth >= MAX_HOOK_DEPTH) return `the hook files under ${folder} are nested deeper than this install reads`;
          const fault = walk(path, depth + 1);
          if (fault !== null) return fault;
          continue;
        }
        if (!name.isFile()) return `the hook file ${path} is not a regular file`;
        let held;
        try {
          held = lstatSync(path);
        } catch {
          return `the hook file ${path} could not be read`;
        }
        if (!held.isFile() || held.isSymbolicLink()) return `the hook file ${path} is not a regular file`;
        if (held.size > MAX_HOOK_BYTES) return `the hook file ${path} is larger than this install reads`;
        let fd;
        try {
          fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
        } catch {
          return `the hook file ${path} could not be read`;
        }
        let text: string;
        try {
          const buffer = Buffer.alloc(held.size);
          const read = readSync(fd, buffer, 0, buffer.length, 0);
          if (read !== buffer.length) return `the hook file ${path} could not be read whole`;
          text = buffer.toString('utf8');
        } catch {
          return `the hook file ${path} could not be read`;
        } finally {
          closeSync(fd);
        }
        try {
          JSON.parse(text);
        } catch {
          return `the hook file ${path} does not parse`;
        }
        for (const match of text.matchAll(HOOK_COPY)) {
          const hash = match[1];
          if (hash !== undefined) found.add(hash);
        }
      }
      return null;
    };
    for (const root of roots) {
      const fault = walk(join(root, '.agents', 'hooks'), 0);
      if (fault !== null) return { hashes: [], fault };
    }
    return { hashes: [...found].sort(), fault: null };
  };

  /**
   * The earlier definition goes back and its daemon is started again, so a refresh the service
   * manager refuses leaves a running daemon and a reported failure, never a machine with no
   * daemon and no message. The failed load may have left the label claimed, so it is cleared
   * before the earlier unit is offered; that offer gets the same bounded retries, which also
   * wait out a stop that is still finishing.
   */
  const restore = (
    home: string,
    path: string,
    prior: { text: string; mode: number } | null,
    failDetail: string,
    sha: string,
  ): ServiceInstallResult => {
    // Nothing was installed before this install: the definition it wrote is taken back out, so
    // the manager cannot load an unregistered unit at the next login, and there is no earlier
    // definition to put back. The copy this install added goes with it.
    if (prior === null) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        return refused(
          'the system\'s service manager refused to start the daemon and the service definition could not be removed',
          `${failDetail}; ${error instanceof Error ? error.message : String(error)}`,
          'refused',
          false,
        );
      }
      dropRuntime(home, sha, null);
      return refused(
        'the system\'s service manager refused to start the daemon',
        `${failDetail}; no earlier unit was installed, so no daemon is running`,
        'refused',
        false,
      );
    }
    // The earlier unit text goes back exactly as it was. It names the retained copy it was
    // installed with, which this install never wrote, so nothing else has to be put back: the
    // program a unit runs is its own copy, not the package a later upgrade replaces.
    try {
      writeFileSync(path, prior.text, { mode: prior.mode });
      chmodSync(path, prior.mode);
    } catch (error) {
      return refused(
        'the system\'s service manager refused to start the new daemon, and the earlier service definition could not be put back; no daemon was started',
        `${failDetail}; ${error instanceof Error ? error.message : String(error)}`,
        'lost',
        false,
      );
    }
    dropRuntime(home, sha, prior.text);
    run('launchctl', ['bootout', service]);
    const back = loadWithRetry(path);
    if (back.status === 0) {
      return refused(
        'the system\'s service manager refused to start the new daemon; the previous one was put back and started again',
        `${failDetail}; the earlier unit was put back and its daemon started`,
        'restored',
        true,
      );
    }
    return refused(
      'the system\'s service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
      `${failDetail}; the earlier unit was put back, and ${loadDetail(back)}`,
      'lost',
      true,
    );
  };

  /**
   * Takes back a unit the manager accepted, after the daemon it started did not answer the
   * command's health probe. The job is stopped first, so a restarting one stops competing for
   * the machine socket. With an earlier definition, that definition and the program it was
   * accepted with are put back and offered again (the same bounded retries as a refused load);
   * a fresh install has no earlier definition, so the unit this install wrote is stopped and
   * removed. `restored` still only means "the earlier load was accepted": the command confirms
   * its daemon answers before reporting a rollback.
   */
  const rollback = (
    home: string,
    path: string,
    prior: { text: string; mode: number } | null,
    sha: string,
  ): ServiceInstallFailure => {
    run('launchctl', ['bootout', service]);
    if (prior === null) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        return refused(
          'the daemon the new unit started did not answer, and the service definition could not be removed',
          `the daemon did not answer the health probe; ${error instanceof Error ? error.message : String(error)}`,
          'refused',
          false,
        );
      }
      dropRuntime(home, sha, null);
      return refused(
        'the daemon the new unit started did not answer the health probe',
        'the daemon did not answer the health probe; no earlier unit was installed, so no daemon is running',
        'refused',
        false,
      );
    }
    try {
      writeFileSync(path, prior.text, { mode: prior.mode });
      chmodSync(path, prior.mode);
    } catch (error) {
      return refused(
        'the daemon the new unit started did not answer, and the earlier service definition could not be put back; no daemon was started',
        `the daemon did not answer the health probe; ${error instanceof Error ? error.message : String(error)}`,
        'lost',
        false,
      );
    }
    dropRuntime(home, sha, prior.text);
    const back = loadWithRetry(path);
    if (back.status === 0) {
      return refused(
        'the daemon the new unit started did not answer; the previous one was put back and started again',
        'the daemon did not answer the health probe; the earlier unit was put back and its daemon started',
        'restored',
        true,
      );
    }
    return refused(
      'the daemon the new unit started did not answer, and the previous one could not be started again; no daemon was started',
      `the daemon did not answer the health probe; the earlier unit was put back, and ${loadDetail(back)}`,
      'lost',
      true,
    );
  };

  return {
    kind: 'system-service-manager',
    unitPath,
    plan: (home, program): ServicePlan => {
      const set = runtimeSet(program);
      const listed = runtimeFiles(home, set);
      if (!listed.ok) throw new Error(`the program this unit would run could not be read whole: ${listed.detail}`);
      const sha = runtimeHash(listed.files);
      return {
        unitPath: unitPath(home),
        program: programOf({ ...program, entry: join(runtimeRoot(home), sha, set.entry) }),
      };
    },
    job: (home) => {
      const unit = unitRecord(home);
      if (unit === null || unit.label !== DAEMON_LABEL) return null;
      return jobRecord();
    },
    unit: (home) => unitRecord(home),

    install(home, program): ServiceInstallResult {
      const path = unitPath(home);
      // A failed install must not leave a definition launchd could load at the next login. The
      // unit this install may overwrite is kept first, so a refusal restores the earlier,
      // already-installed definition rather than leaving the unregistered one in its place.
      let prior: { text: string; mode: number } | null = null;
      if (existsSync(path)) {
        try {
          prior = { text: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
        } catch (error) {
          return {
            ok: false,
            why: 'the existing service unit could not be read',
            detail: error instanceof Error ? error.message : null,
            outcome: 'refused',
            // Unreadable is not a definition the command can point the owner at.
            kept: false,
          };
        }
      }
      // A refresh puts the earlier unit text back unchanged, so the program that text names must
      // still be on disk before anything is written: a unit whose program is gone cannot be put
      // back into a running daemon, and an install that wrote anyway would take a working daemon
      // away with nothing to put in its place.
      if (prior !== null) {
        const earlier = plistStrings(prior.text, 'ProgramArguments')?.[1];
        if (earlier === undefined || earlier === '') {
          return refused(
            'the earlier service definition names no program, so this install cannot put the daemon back if the new one does not answer',
            'the earlier unit carries no run words',
            'refused',
            true,
          );
        }
        if (!existsSync(earlier)) {
          return refused(
            'the earlier service definition names a program that is not on disk, so this install cannot put the daemon back if the new one does not answer',
            `the earlier unit runs ${earlier}, which is not on disk`,
            'refused',
            true,
          );
        }
      }
      // A definition written by a version that persisted the install's authorization is
      // rewritten without it; the command says so, so the removal is never silent.
      const droppedAuthorization = prior !== null && namesAuthorization(prior.text);
      // The whole program is copied before the unit is written: the unit names the copy, so a
      // program that cannot be read or kept whole is refused before anything changes.
      const set = runtimeSet(program);
      const listed = runtimeFiles(home, set);
      if (!listed.ok) {
        return refused(
          'the program this install would run could not be read whole, so no service definition was written',
          listed.detail,
          'refused',
          prior !== null,
        );
      }
      const sha = runtimeHash(listed.files);
      const made = materialize(home, listed.files, sha);
      if (!made.ok) {
        return refused(
          'the program this install would run could not be kept whole, so no service definition was written',
          made.detail,
          'refused',
          prior !== null,
        );
      }
      let temporary: string | null = null;
      // Whether the rename put the new definition at `path`, replacing any earlier one: a failure
      // after that point leaves no earlier unit for the command to point the owner at.
      let placed = false;
      const words = programOf({ ...program, entry: join(made.path, set.entry) });
      const text = unitText(home, words, program.path);
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        temporary = `${path}.${String(process.pid)}.tmp`;
        writeFileSync(temporary, text, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
        temporary = null;
        placed = true;
        chmodSync(path, 0o600);
      } catch (error) {
        if (temporary !== null) {
          try {
            unlinkSync(temporary);
          } catch {
            // Nothing of ours is there to take.
          }
        }
        // No unit names the copy this install just made, so it goes: the install changes
        // nothing it could not finish.
        dropRuntime(home, sha, prior?.text ?? null);
        return {
          ok: false,
          why: 'the service unit could not be written',
          detail: error instanceof Error ? error.message : null,
          outcome: 'refused',
          // Before the rename the earlier definition is still on disk; after it, the new one is.
          kept: placed ? false : prior !== null,
        };
      }
      // A job the manager already holds under our label is the daemon a refresh replaces: the
      // load for the new unit is refused while it is loaded. It is stopped, and the load is
      // offered again with a bounded, growing wait while the manager refuses — the earlier stop
      // may still be finishing, and a refusal the install never retries past is the empty
      // machine this install must never leave.
      const undo = (): ServiceInstallFailure => rollback(home, path, prior, sha);
      const succeeded = (): ServiceInstallResult => {
        // The copy the new unit runs, the copy the earlier unit names, and every copy a hosted
        // root's hook file names all stay: the health gate may still ask for the undo, which
        // restores the earlier unit text and needs that program, and a hook command names a copy
        // a seat still runs. A folder from an older install that none of them names is removed.
        // Hook files this install cannot read whole keep every copy and say why.
        const hooked = hookedCopies(program.roots);
        cleanRuntime(
          home,
          [sha, prior === null ? null : namedRuntime(home, prior.text), ...hooked.hashes],
          hooked.fault !== null,
        );
        return {
          ok: true,
          unitPath: path,
          program: words,
          undo,
          ...(hooked.hashes.length > 0 ? { hookedRuntime: hooked.hashes } : {}),
          ...(hooked.fault !== null ? { runtimeKeepFault: hooked.fault } : {}),
          ...(droppedAuthorization ? { droppedAuthorization: true } : {}),
        };
      };
      const first = run('launchctl', ['bootstrap', domain, path]);
      if (first.status === 0) return succeeded();
      run('launchctl', ['bootout', service]);
      const loaded = loadWithRetry(path);
      if (loaded.status === 0) return succeeded();
      // The new unit did not start after every bounded retry: the earlier definition is put
      // back and its daemon started, so a failure is reported and a daemon still runs.
      return restore(home, path, prior, loadDetail(loaded), sha);
    },

    uninstall(home): ServiceUninstallResult {
      const path = unitPath(home);
      const booted = run('launchctl', ['bootout', service]);
      // Removing the unit file does not unload a job the service manager still holds, and a
      // loaded KeepAlive job would start the daemon again. Only a stop the manager accepted
      // permits the file to go; a unit with no accepted stop stays as the recovery state a retry
      // needs. With no unit written at all there is nothing to remove and nothing to hide, so the
      // absent-unit answer is the same whether or not a service manager call failed.
      const present = existsSync(path);
      if (present && booted.status !== 0) {
        return {
          ok: false,
          why: 'the system\'s service manager did not confirm the daemon stopped',
          detail: `bootout exited ${String(booted.status)}: ${booted.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
        };
      }
      let removed = false;
      if (present) {
        try {
          unlinkSync(path);
          removed = true;
        } catch (error) {
          // A unit taken away between the decision and the removal was never ours to remove:
          // nothing is left installed, which is the answer this uninstall was giving.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, unitPath: path, removed: false };
          return {
            ok: false,
            why: 'the service unit could not be removed',
            detail: error instanceof Error ? error.message : null,
          };
        }
      }
      return { ok: true, unitPath: path, removed };
    },

    restart(home): ServiceRestartResult {
      const path = unitPath(home);
      // There is no daemon to restart without the unit: nothing is stopped, and the command
      // names the install that writes one.
      if (!existsSync(path)) {
        return {
          ok: false,
          reason: 'not-installed',
          why: 'no user service unit is installed, so there is no daemon to restart',
          detail: null,
        };
      }
      // A load of a unit under a label the manager already holds is refused while that job is
      // loaded, so the held job is stopped first and the installed unit is offered with the
      // install's own bounded, growing patience: a refusal while the stop is still finishing is
      // not a verdict on the unit.
      const offer = (): ServiceRunResult => {
        run('launchctl', ['bootout', service]);
        return loadWithRetry(path);
      };
      // The command calls this only after the restarted daemon did not answer: the job it just
      // started is stopped and the installed unit offered again, so a restart that left nothing
      // answering is reported with the daemon an install last left running, if it starts.
      const undo = (): ServiceRestartResult => {
        const again = offer();
        return again.status === 0
          ? { ok: true, unitPath: path, undo }
          : {
            ok: false,
            reason: 'refused',
            why: 'the installed daemon could not be started again after a restart that did not answer',
            detail: loadDetail(again),
          };
      };
      const loaded = offer();
      if (loaded.status !== 0) {
        return {
          ok: false,
          reason: 'refused',
          why: 'the system\'s service manager refused to start the installed daemon again',
          detail: loadDetail(loaded),
        };
      }
      return { ok: true, unitPath: path, undo };
    },
  };
}

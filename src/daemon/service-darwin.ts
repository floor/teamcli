// The local service-manager adapter. Every platform-specific word, file and command lives here;
// the neutral `team daemon install` interface above it prints none of them to the user. The
// adapter writes a user service unit that starts the daemon at login and restarts it when it
// exits non-zero. A clean exit (the daemon stopped) is not restarted.
//
// The retained runtime copy the unit runs, its verification, the bounded load retries and the
// rollback bookkeeping are shared with every adapter (`service-runtime.ts`); this file holds only
// the unit's own text, how that text is read back, and the manager's commands.
import { lstatSync, readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { unlinkSync } from '../host/guarded-fs.ts';
import { join } from 'node:path';
import { daemonLabel, daemonLogPath } from './paths.ts';
import {
  accountUnreadInstall,
  accountUnreadRestart,
  accountUnreadUninstall,
  installUnit,
  offerWithRetry,
  realServiceRunner,
  realServiceSleep,
  restartUnit,
  retainedRuntime,
  uninstallUnit,
} from './service-runtime.ts';
import type {
  LoadedServiceProgram,
  ServiceInstallResult,
  ServiceJobRecord,
  ServiceManager,
  ServiceManagerOptions,
  ServicePlan,
  ServiceRestartResult,
  ServiceRunResult,
  ServiceUnitRecord,
  ServiceUninstallResult,
} from './service.ts';

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

/** Whether a written unit's run command names a client key or a general grant — the two
 *  arguments a version before this one persisted, and that an install now rewrites without. */
function namesAuthorization(text: string): boolean {
  return [...text.matchAll(/<string>([^<]*)<\/string>/g)]
    .some((entry) => entry[1] === '--general' || entry[1] === '--key');
}

/** The unit runs as `Interactive`, the class apps run in. `Background` confines the daemon and
 *  every child it starts to the efficiency cores at the lowest priority and throttles its disk
 *  reads: on a loaded machine the event loop then waited seconds for each turn, and every send,
 *  read receipt and wake waited with it. The daemon's own work is small; what it serves is the
 *  seats' delivery, which a person is waiting on. */
function unitText(home: string, label: string, program: string[], path?: string): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  // The unit sets HOME, TMPDIR and the XDG directories to the home it serves so the process and
  // the unit agree on which home they are; the installer's PATH lets the service find herdr and
  // the CLIs where the owner's shell does.
  const entries: [string, string][] = [
    ['HOME', home],
    ['TMPDIR', join(home, 'tmp')],
    ['XDG_CONFIG_HOME', join(home, '.config')],
    ['XDG_DATA_HOME', join(home, '.local', 'share')],
    ['XDG_CACHE_HOME', join(home, '.cache')],
    ['XDG_STATE_HOME', join(home, '.local', 'state')],
  ];
  if (path !== undefined && path !== '') entries.push(['PATH', path]);
  const envBody = entries
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n');
  const env = `  <key>EnvironmentVariables</key>\n  <dict>\n${envBody}\n  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
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
  <string>Interactive</string>
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
  const run = options.runner ?? realServiceRunner;
  const sleep = options.sleep ?? realServiceSleep;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const runtime = retainedRuntime(uid);

  let cachedAccountHome: string | undefined =
    options.accountHome !== undefined && options.accountHome !== '' && options.accountHome.startsWith('/')
      ? options.accountHome
      : undefined;
  const invalidInjectedAccount =
    options.accountHome !== undefined && (options.accountHome === '' || !options.accountHome.startsWith('/'));
  const resolveAccountHome = (): string | null => {
    if (invalidInjectedAccount) return null;
    if (cachedAccountHome !== undefined) return cachedAccountHome;
    const read = run('/usr/bin/id', ['-P', String(uid)]);
    if (read.status !== 0) return null;
    const line = read.stdout.split(/\r?\n/)[0] ?? '';
    const fields = line.split(':');
    const dir = fields[8] ?? '';
    if (fields.length >= 9 && dir.startsWith('/')) {
      cachedAccountHome = dir;
      return dir;
    }
    return null;
  };

  const labelFor = (home: string): string | null => daemonLabel(home, resolveAccountHome());
  const unitPathFor = (home: string, label: string): string => join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const unitPath = (home: string): string => {
    const label = labelFor(home);
    if (label === null) throw new Error('the account home could not be read');
    return unitPathFor(home, label);
  };

  /**
   * Every loaded unit's label and program words: the manager's list for what is loaded (a
   * pid stands in the first column), and each loaded unit's own file for what it runs.
   * Both texts are parsed here and nowhere else. An unreadable list or unit file simply
   * contributes nothing — a folder is held only on a word actually read.
   */
  const loadedPrograms = (home: string): LoadedServiceProgram[] => {
    const listed = run('launchctl', ['list']);
    if (listed.status !== 0) return [];
    const loaded = new Set<string>();
    for (const line of listed.stdout.split('\n')) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 3 && columns[0] !== '-' && columns[0] !== 'PID') loaded.add(columns[2] as string);
    }
    const dir = join(home, 'Library', 'LaunchAgents');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const programs: LoadedServiceProgram[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.plist')) continue;
      let text: string;
      try {
        const path = join(dir, name);
        if (lstatSync(path).isSymbolicLink()) continue;
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const label = plistString(text, 'Label');
      if (label === null || !loaded.has(label)) continue;
      programs.push({ label, program: plistStrings(text, 'ProgramArguments') ?? [] });
    }
    return programs;
  };
  const domain = `gui/${String(uid)}`;
  const serviceForLabel = (label: string): string => `${domain}/${label}`;

  /** Loads the unit at `path`, retrying a refusal with a bounded, growing wait. A refusal while
   *  the job this unit replaces is still leaving is the same answer as a unit the manager will
   *  not take, so both are given the same bounded patience: the manager accepts the load as soon
   *  as the earlier job has left. */
  const loadWithRetry = (path: string): ServiceRunResult =>
    offerWithRetry(() => run('launchctl', ['bootstrap', domain, path]), sleep);

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
  const jobRecord = (home: string): (ServiceJobRecord & { path: string | null }) | null => {
    const label = labelFor(home);
    if (label === null) return null;
    const printed = run('launchctl', ['print', `${domain}/${label}`]);
    if (printed.status === 0) {
      const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout)?.[1];
      const path = /^\s*path = (.+?)\s*$/m.exec(printed.stdout)?.[1];
      // A record with no program line still carries the job's own first argument; either is
      // the executable the job was started from, and the admission compares it by real path.
      const program = /^\s*program = (.+?)\s*$/m.exec(printed.stdout)?.[1]
        ?? /^\s*arguments = \{\s*\n\s*([^\n]+?)\s*$/m.exec(printed.stdout)?.[1];
      return {
        pid: pid === undefined ? null : Number(pid),
        program: program ?? null,
        path: path ?? null,
      };
    }
    const listed = run('launchctl', ['list', label]);
    if (listed.status !== 0) return null;
    const pid = /^\s*"PID"\s*=\s*(\d+)\s*;/m.exec(listed.stdout)?.[1];
    const quoted = /^\s*"Program"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/m.exec(listed.stdout)?.[1];
    return {
      pid: pid === undefined ? null : Number(pid),
      program: quoted === undefined ? null : quoted.replace(/\\(.)/g, '$1'),
      path: null,
    };
  };

  /**
   * The unit file's own words. A symlink or any other non-regular file is refused, so the
   * record describes the file the job was started from and not a name pointing elsewhere.
   * Unreadable is null: the caller refuses closed.
   */
  const unitRecord = (home: string): ServiceUnitRecord | null => {
    const label = labelFor(home);
    if (label === null) return null;
    const path = unitPathFor(home, label);
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

  return {
    kind: 'system-service-manager',
    accountHome: () => resolveAccountHome(),
    unitPath,
    loadedPrograms,
    plan: (home, program): ServicePlan => {
      const label = labelFor(home);
      if (label === null) throw new Error('the account home could not be read');
      return { unitPath: unitPathFor(home, label), program: runtime.plannedWords(home, program) };
    },
    job: (home) => {
      const unit = unitRecord(home);
      if (unit === null || unit.label !== labelFor(home)) return null;
      let expectedPath: string;
      try {
        expectedPath = realpathSync(unitPath(home));
      } catch {
        return null;
      }
      const record = jobRecord(home);
      if (record === null || record.path === null) return null;
      let loadedPath = record.path;
      try {
        loadedPath = realpathSync(record.path);
      } catch {
        // Keep the literal string from the record when it cannot be resolved.
      }
      if (loadedPath !== expectedPath) return null;
      return { pid: record.pid, program: record.program };
    },
    unit: (home) => unitRecord(home),

    install(home, program): ServiceInstallResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadInstall();
      const path = unitPathFor(home, label);
      return installUnit({
        home,
        program,
        path,
        runtime,
        wordsOf: (text) => plistStrings(text, 'ProgramArguments'),
        namesAuthorization,
        text: (words) => unitText(home, label, words, program.path),
        firstOffer: () => run('launchctl', ['bootstrap', domain, path]),
        commands: {
          stop: () => {
            run('launchctl', ['bootout', serviceForLabel(label)]);
          },
          load: () => loadWithRetry(path),
          removeWritten: () => {
            if (existsSync(path)) unlinkSync(path);
          },
        },
      });
    },

    uninstall(home): ServiceUninstallResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadUninstall();
      // A loaded KeepAlive job would start the daemon again after its file is gone, so the file
      // goes only after the manager confirmed the bootout.
      return uninstallUnit({
        path: unitPathFor(home, label),
        stop: () => run('launchctl', ['bootout', serviceForLabel(label)]),
        stopWord: 'bootout',
      });
    },

    restart(home): ServiceRestartResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadRestart();
      const path = unitPathFor(home, label);
      // A load of a unit under a label the manager already holds is refused while that job is
      // loaded, so the held job is stopped first and the installed unit is offered with the
      // install's own bounded, growing patience: a refusal while the stop is still finishing is
      // not a verdict on the unit.
      return restartUnit({
        path,
        offer: () => {
          run('launchctl', ['bootout', serviceForLabel(label)]);
          return loadWithRetry(path);
        },
      });
    },
    retireUnit(home, label) {
      const path = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
      run('launchctl', ['bootout', `${domain}/${label}`]);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        return {
          ok: false as const,
          why: error instanceof Error ? error.message : 'the shuttle unit could not be removed',
        };
      }
      if (existsSync(path)) return { ok: false as const, why: 'the shuttle unit is still on disk' };
      return { ok: true as const };
    },
  };
}

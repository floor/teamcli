// The Linux service-manager adapter: a systemd user service. Every word, file and command of that
// facility lives here; the neutral `team daemon install` interface above it prints none of them
// to the user. The unit starts the daemon with the user's service manager and restarts it when
// it exits non-zero; a clean exit (the daemon stopped) is not restarted — the same contract the
// other platform's unit carries.
//
// The retained runtime copy the unit runs, its verification, the bounded load retries and the
// rollback bookkeeping are shared with every adapter (`service-runtime.ts`); this file holds only
// the unit's own text, how that text is read back, and the manager's commands. Every command
// goes through the injected runner, so a test replaces the manager whole and nothing here runs
// the platform's command unless the live runner is the one in use.
//
// A user service runs while the user's own service manager runs, and that manager stops at the
// user's last logout unless the account lingers. A headless server the owner reaches over a
// remote shell would lose the daemon at every disconnect, so an install reads the account's
// linger setting and says plainly when the daemon will stop at logout. It never changes that
// setting: enabling it needs the system's administrator, and an install does not run as one.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { unlinkSync } from '../host/guarded-fs.ts';
import { basename, join } from 'node:path';
import { DAEMON_LABEL, daemonLabel, daemonLogPath } from './paths.ts';
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

/** The folder of a home's user units, the one the user's service manager reads. */
function unitFolder(home: string): string {
  return join(home, '.config', 'systemd', 'user');
}

/** A word the manager reads as itself without quotes: no space, quote, escape, specifier or
 *  variable. Anything else is quoted. */
const PLAIN_WORD = /^[A-Za-z0-9_./:=+,@-]+$/;

/** A control character, written as a `\xNN` escape inside quotes so the word reads back whole. */
function escapeControl(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * One command-line word, quoted the way the manager splits and unquotes a command line: inside
 * double quotes a backslash and a quote are escaped, `%` (a specifier) is doubled, and `$` (a
 * variable the manager expands when it starts the command) is doubled. The manager reads the
 * word back as exactly this text, and `commandWords` reads it back the same way.
 */
function quoteWord(word: string): string {
  if (word !== '' && PLAIN_WORD.test(word)) return word;
  const escaped = escapeControl(word.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

/** One `Environment=` assignment, quoted whole. The manager resolves specifiers in it but does
 *  not expand variables, so only `%` is doubled. */
function quoteAssignment(key: string, value: string): string {
  return `"${escapeControl(`${key}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')).replace(/%/g, '%%')}"`;
}

/** A path setting's value: the manager takes the rest of the line, resolving specifiers. */
function pathValue(path: string): string {
  return path.replace(/%/g, '%%');
}

const ESCAPES: Record<string, string> = {
  '\\': '\\', '"': '"', '\'': '\'', n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', s: ' ',
};

/**
 * The words of one command line, unquoted the way the manager reads it: whitespace separates
 * words, single or double quotes group them, a backslash escape is resolved, and `%%` and `$$`
 * are a literal `%` and `$`. Null when the line carries a specifier or a variable this reader
 * does not resolve, an escape it does not know, or an unclosed quote: the words such a line runs
 * are decided when the manager starts it, so they are not words this reader can name.
 */
function commandWords(line: string): string[] | null {
  const words: string[] = [];
  let at = 0;
  while (at < line.length) {
    while (at < line.length && /\s/.test(line[at] ?? '')) at += 1;
    if (at >= line.length) break;
    let word = '';
    let quote: string | null = null;
    for (; at < line.length; at += 1) {
      const char = line[at] ?? '';
      if (quote === null && /\s/.test(char)) break;
      if (quote === null && (char === '"' || char === '\'')) {
        quote = char;
        continue;
      }
      if (quote !== null && char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\') {
        const next = line[at + 1] ?? '';
        if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(at + 2, at + 4))) {
          word += String.fromCharCode(Number.parseInt(line.slice(at + 2, at + 4), 16));
          at += 3;
          continue;
        }
        const known = ESCAPES[next];
        if (known === undefined) return null;
        word += known;
        at += 1;
        continue;
      }
      if (char === '%' || char === '$') {
        if (line[at + 1] !== char) return null;
        word += char;
        at += 1;
        continue;
      }
      word += char;
    }
    if (quote !== null) return null;
    words.push(word);
  }
  return words;
}

/**
 * The one command line a unit text's service section starts, as words — or null when the text
 * carries none, more than one, or one this reader cannot name the words of. An empty
 * assignment clears the ones before it, as it does for the manager.
 */
function execStartWords(text: string): string[] | null {
  let section = '';
  const lines: string[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const joined = pending + raw.replace(/\r$/, '');
    // A trailing backslash continues the setting on the next line.
    if (joined.endsWith('\\')) {
      pending = `${joined.slice(0, -1)} `;
      continue;
    }
    pending = '';
    const line = joined.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const assignment = /^ExecStart\s*=\s*(.*)$/.exec(line);
    if (assignment === null) continue;
    const value = assignment[1] ?? '';
    if (value === '') lines.length = 0;
    else lines.push(value);
  }
  if (lines.length !== 1) return null;
  return commandWords(lines[0] ?? '');
}

/** Whether a written unit's run command names a client key or a general grant: the two words an
 *  install never writes into a definition, and rewrites a definition without. */
function namesAuthorization(text: string): boolean {
  return (execStartWords(text) ?? []).some((word) => word === '--general' || word === '--key');
}

function unitText(home: string, words: string[], path?: string): string {
  // The unit sets HOME and the XDG directories to the home it serves so the process and the unit
  // agree on which home they are; the installer's PATH lets the service find herdr and the CLIs
  // where the owner's shell does. The temporary folder stays the system's: the manager sets none
  // for a user service, and a folder named here that nothing makes would fail every temporary file.
  const entries: [string, string][] = [
    ['HOME', home],
    ['XDG_CONFIG_HOME', join(home, '.config')],
    ['XDG_DATA_HOME', join(home, '.local', 'share')],
    ['XDG_CACHE_HOME', join(home, '.cache')],
    ['XDG_STATE_HOME', join(home, '.local', 'state')],
  ];
  if (path !== undefined && path !== '') entries.push(['PATH', path]);
  const environment = entries.map(([key, value]) => `Environment=${quoteAssignment(key, value)}`).join('\n');
  const log = pathValue(daemonLogPath(home));
  // `Type=exec`: a start is answered only once the program was executed, so a unit whose program
  // cannot run is a refused load — the answer the bounded retries and the rollback act on.
  // `Restart=on-failure`: a non-zero exit or a crash is restarted, a clean exit is not.
  // `RestartSec=10`: the other platform restarts a failed job at most every ten seconds and never
  // gives up on it; ten seconds keeps the restarts under the manager's own start limit (five in
  // ten seconds by default), so a daemon that keeps failing keeps being started again.
  // `KillMode=process`: a stop signals the daemon alone. The session server and the CLI servers
  // the daemon starts detach from it and must outlive a restart; the manager's default would end
  // every process the daemon ever started, and with them every seat's pane.
  // `TimeoutStopSec=20`: the other platform's wait before it ends a job that does not stop.
  return `[Unit]
Description=TeamCLI machine daemon

[Service]
Type=exec
ExecStart=${words.map(quoteWord).join(' ')}
${environment}
WorkingDirectory=${pathValue(home)}
Restart=on-failure
RestartSec=10
KillMode=process
TimeoutStopSec=20
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** The `Key=Value` lines of a property listing the manager prints, as a map. */
function properties(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    found.set(line.slice(0, at), line.slice(at + 1).replace(/\r$/, ''));
  }
  return found;
}

/** A pid property: a positive integer, or null — the manager prints 0 for a job with no process. */
function pidOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const pid = Number(value.trim());
  return pid > 0 ? pid : null;
}

/** The executable a printed command record names: `{ path=<executable> ; argv[]=… }`. */
function commandPath(value: string | undefined): string | null {
  const found = /\bpath=(.+?) ; argv\[\]=/.exec(value ?? '')?.[1];
  return found === undefined || found === '' ? null : found;
}

/** The manager's active states in which a unit still has, or is about to have, a process. */
const LIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);

export function linuxServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const run = options.runner ?? realServiceRunner;
  const sleep = options.sleep ?? realServiceSleep;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const runtime = retainedRuntime(uid);
  const systemctl = (...args: string[]): ServiceRunResult => run('systemctl', ['--user', ...args]);

  let cachedAccountHome: string | undefined =
    options.accountHome !== undefined && options.accountHome !== '' && options.accountHome.startsWith('/')
      ? options.accountHome
      : undefined;
  const invalidInjectedAccount =
    options.accountHome !== undefined && (options.accountHome === '' || !options.accountHome.startsWith('/'));
  /** The account home from the account database, never from the shell's HOME: the label of a
   *  home is decided against the login account's own home. */
  const resolveAccountHome = (): string | null => {
    if (invalidInjectedAccount) return null;
    if (cachedAccountHome !== undefined) return cachedAccountHome;
    const read = run('/usr/bin/getent', ['passwd', String(uid)]);
    if (read.status !== 0) return null;
    const line = read.stdout.split(/\r?\n/)[0] ?? '';
    const fields = line.split(':');
    const dir = fields[5] ?? '';
    if (fields.length >= 7 && dir.startsWith('/')) {
      cachedAccountHome = dir;
      return dir;
    }
    return null;
  };

  const labelFor = (home: string): string | null => daemonLabel(home, resolveAccountHome());
  const unitPathFor = (home: string, label: string): string => join(unitFolder(home), `${label}.service`);
  const unitPath = (home: string): string => {
    const label = labelFor(home);
    if (label === null) throw new Error('the account home could not be read');
    return unitPathFor(home, label);
  };

  /**
   * Every loaded unit's name and program words: the manager's list of its services for what has
   * a process, and each such unit's own file in this home's unit folder for what it runs. Both
   * texts are parsed here and nowhere else. An unreadable list or unit file contributes nothing —
   * a folder is held only on a word actually read.
   */
  const loadedPrograms = (home: string): LoadedServiceProgram[] => {
    const listed = systemctl('list-units', '--type=service', '--all', '--no-legend', '--plain');
    if (listed.status !== 0) return [];
    const loaded = new Set<string>();
    for (const line of listed.stdout.split('\n')) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 4 && LIVE_STATES.has(columns[2] ?? '')) loaded.add(columns[0] as string);
    }
    let names: string[];
    try {
      names = readdirSync(unitFolder(home));
    } catch {
      return [];
    }
    const programs: LoadedServiceProgram[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.service') || !loaded.has(name)) continue;
      let text: string;
      try {
        const path = join(unitFolder(home), name);
        if (lstatSync(path).isSymbolicLink()) continue;
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      programs.push({ label: name.slice(0, -'.service'.length), program: execStartWords(text) ?? [] });
    }
    return programs;
  };

  /**
   * The unit file's own words. A symlink or any other non-regular file is refused, so the record
   * describes the file the job was started from and not a name pointing elsewhere. The unit's
   * label is its name: the manager knows a user unit by its file name alone. Unreadable is null:
   * the caller refuses closed.
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
      label: basename(path, '.service'),
      ownerUid: stats.uid,
      mode: stats.mode & 0o777,
      programArguments: execStartWords(text),
    };
  };

  /**
   * The manager's own record of the job under the daemon's unit: its main pid, the executable
   * its command line names, and the file it was loaded from. Null when the unit is not loaded,
   * the record cannot be read, or the loaded file is not this home's unit — the start admission
   * refuses closed. A pid of 0 is no process. The executable describes the process the manager
   * executed; when the main pid is another process than that one, the record names no program.
   */
  const jobRecord = (home: string, label: string): ServiceJobRecord | null => {
    const shown = systemctl(
      'show', `${label}.service`,
      '-p', 'MainPID', '-p', 'ExecMainPID', '-p', 'ExecStart', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath',
    );
    if (shown.status !== 0) return null;
    const record = properties(shown.stdout);
    if (record.get('LoadState') !== 'loaded') return null;
    const fragment = record.get('FragmentPath') ?? '';
    if (fragment === '') return null;
    let expectedPath: string;
    let loadedPath = fragment;
    try {
      expectedPath = realpathSync(unitPathFor(home, label));
    } catch {
      return null;
    }
    try {
      loadedPath = realpathSync(fragment);
    } catch {
      // Keep the literal path from the record when it cannot be resolved.
    }
    if (loadedPath !== expectedPath) return null;
    const pid = pidOf(record.get('MainPID'));
    const executed = pidOf(record.get('ExecMainPID'));
    const program = commandPath(record.get('ExecStart'));
    return { pid, program: pid !== null && executed !== null && executed !== pid ? null : program };
  };

  /**
   * Whether this account's service manager keeps running after its last logout: true or false
   * from the account's own setting, null when it cannot be read — no claim is made then.
   */
  const lingers = (): boolean | null => {
    const read = run('loginctl', ['show-user', String(uid), '-p', 'Linger']);
    if (read.status !== 0) return null;
    const value = /^Linger=(yes|no)\s*$/m.exec(read.stdout)?.[1];
    return value === undefined ? null : value === 'yes';
  };

  /** The manager's commands for one unit. The home's own unit is known to the manager by name;
   *  a unit of another home sits outside the folder the manager reads, so it is enabled by its
   *  path, which links it there, and a disable takes that link back out. */
  const commandsFor = (label: string, path: string) => {
    const unit = `${label}.service`;
    const target = label === DAEMON_LABEL ? unit : path;
    /** One offer: the manager reads its unit files again, the unit is enabled for the next
     *  start of the user's manager, and `verb` starts it. The first refusal is the offer's. */
    const offer = (verb: 'start' | 'restart'): ServiceRunResult => {
      const reloaded = systemctl('daemon-reload');
      if (reloaded.status !== 0) return reloaded;
      const enabled = systemctl('enable', target);
      if (enabled.status !== 0) return enabled;
      return systemctl(verb, unit);
    };
    /** The stop also clears a failed state and its start count, so the next offer is not refused
     *  for the starts that failed before it. */
    const stop = (): void => {
      systemctl('stop', unit);
      systemctl('reset-failed', unit);
    };
    const load = (): ServiceRunResult => offerWithRetry(() => offer('start'), sleep);
    return { unit, target, offer, stop, load };
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
      const label = labelFor(home);
      if (unit === null || label === null || unit.label !== label) return null;
      return jobRecord(home, label);
    },
    unit: (home) => unitRecord(home),

    install(home, program): ServiceInstallResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadInstall();
      const path = unitPathFor(home, label);
      const commands = commandsFor(label, path);
      return installUnit({
        home,
        program,
        path,
        runtime,
        wordsOf: execStartWords,
        namesAuthorization,
        text: (words) => unitText(home, words, program.path),
        // A restart starts a unit that is not running and replaces one that is: a start of a
        // running unit would leave the earlier daemon in place under the new definition.
        firstOffer: () => commands.offer('restart'),
        commands: {
          stop: commands.stop,
          load: commands.load,
          removeWritten: () => {
            // The unit is disabled while its file is still there to name, so no start link is
            // left pointing at a removed file, and the manager then forgets it.
            systemctl('disable', commands.unit);
            if (existsSync(path)) unlinkSync(path);
            systemctl('reset-failed', commands.unit);
            systemctl('daemon-reload');
          },
        },
        accepted: () => {
          if (lingers() !== false) return {};
          return {
            stopsAtLogout: {
              detail: `the user manager of uid ${String(uid)} does not linger (loginctl show-user: Linger=no); \`loginctl enable-linger\` for this user keeps its services running after logout`,
            },
          };
        },
      });
    },

    uninstall(home): ServiceUninstallResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadUninstall();
      const commands = commandsFor(label, unitPathFor(home, label));
      // A unit still enabled or running would be started again after its file is gone, so the
      // file goes only after the manager confirmed the disable and the stop.
      return uninstallUnit({
        path: unitPathFor(home, label),
        stop: () => systemctl('disable', '--now', commands.unit),
        stopWord: 'disable --now',
        forget: () => {
          systemctl('daemon-reload');
          systemctl('reset-failed', commands.unit);
        },
      });
    },

    restart(home): ServiceRestartResult {
      const label = labelFor(home);
      if (label === null) return accountUnreadRestart();
      const path = unitPathFor(home, label);
      const commands = commandsFor(label, path);
      // The held job is stopped first and the installed unit is offered with the install's own
      // bounded, growing patience: a refusal while the stop is still finishing is not a verdict
      // on the unit.
      return restartUnit({
        path,
        offer: () => {
          commands.stop();
          return commands.load();
        },
      });
    },
  };
}

// Synthetic scenes for the Linux service-manager adapter, a user service. An injected runner
// stands in for the user's service manager and the account's login record, so nothing here runs
// a platform command, registers a unit or starts a daemon. The scenes prove the adapter keeps the
// neutral interface's guarantees: the unit's text and its run words read back exactly, a fresh
// install and a refresh offer the unit with the same bounded, growing retries the other platform
// gives, a refresh that still cannot start puts the earlier unit back byte for byte, an undo
// removes exactly what the install added, an uninstall removes the unit only after the manager
// confirmed the stop, the manager's own record names the job the admission compares, an
// install says plainly when the daemon stops at logout, and no user-facing line names the
// platform's facility.
//
// The record forms (`show`, `list-units`, the login record) are the ones a read of the same
// manager version produced; every path and pid in them is synthetic or this process's own.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { DAEMON_LABEL, daemonLogPath, daemonRuntimeRoot } from '../src/daemon/paths.ts';
import { linuxServiceManager } from '../src/daemon/service-linux.ts';
import {
  systemServiceManager,
  type ServiceManager,
  type ServiceProgram,
  type ServiceRunResult,
  type ServiceRunner,
} from '../src/daemon/service.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-service-linux-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const EXEC = '/runtime/bin/bun';
const UID = typeof process.getuid === 'function' ? process.getuid() : 501;

/** A program on disk: an entry and the module it imports, in a folder of their own. The adapter
 *  keeps the entry's own folder as the whole program, so this folder is the program. Each version
 *  carries its own bytes, so a refresh is a different retained copy. */
function programFiles(home: string, name: string, entryBytes = `import "./module.js"; // ${name}\n`): string {
  const folder = join(home, 'app', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'module.js'), 'export const ok = true;\n');
  writeFileSync(join(folder, 'cli.js'), entryBytes);
  return join(folder, 'cli.js');
}

function program(home: string, name: string, extra: Partial<ServiceProgram> = {}): ServiceProgram {
  return { execPath: EXEC, entry: programFiles(home, name), roots: ['/repo'], ...extra };
}

const OK: ServiceRunResult = { status: 0, stdout: '', stderr: '' };
/** The manager's answer for a start it will not make: a job that failed. */
const START_REFUSED: ServiceRunResult = {
  status: 1,
  stdout: '',
  stderr: `Job for ${DAEMON_LABEL}.service failed because the control process exited with error code.`,
};
const LINGERS: ServiceRunResult = { status: 0, stdout: 'Linger=yes\n', stderr: '' };
const NO_LINGER: ServiceRunResult = { status: 0, stdout: 'Linger=no\n', stderr: '' };

/** The offers one install makes before it gives up: the first, then the nine of the bounded
 *  retry — the same count the other platform's install makes. */
const BOUNDED_OFFERS = 10;

type Script = {
  start?: ServiceRunResult[];
  restart?: ServiceRunResult[];
  reload?: ServiceRunResult[];
  enable?: ServiceRunResult[];
  disable?: ServiceRunResult[];
  show?: ServiceRunResult[];
  list?: ServiceRunResult[];
  linger?: ServiceRunResult[];
};

/**
 * One answer per manager call, in order, keyed by the call's verb; the last answer repeats for
 * every call after it. Every call is recorded as its words after `--user`, so a scene can say
 * what the adapter asked the manager to do and in which order. Nothing is executed.
 */
function synthetic(script: Script): { runner: ServiceRunner; calls: string[]; commands: string[] } {
  const queues: Record<string, ServiceRunResult[]> = {
    start: [...(script.start ?? [OK])],
    restart: [...(script.restart ?? [OK])],
    'daemon-reload': [...(script.reload ?? [OK])],
    enable: [...(script.enable ?? [OK])],
    disable: [...(script.disable ?? [OK])],
    show: [...(script.show ?? [OK])],
    'list-units': [...(script.list ?? [OK])],
    'show-user': [...(script.linger ?? [LINGERS])],
  };
  const calls: string[] = [];
  const commands: string[] = [];
  const runner: ServiceRunner = (command, args): ServiceRunResult => {
    commands.push(command);
    const words = command === 'systemctl' && args[0] === '--user' ? args.slice(1) : args;
    calls.push(words.join(' '));
    const queue = queues[words[0] ?? ''] ?? [OK];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    return { ...(answer ?? OK) };
  };
  return { runner, calls, commands };
}

function managerWith(
  home: string,
  script: Script = {},
  sleeps: number[] = [],
): { manager: ServiceManager; calls: string[]; commands: string[] } {
  const { runner, calls, commands } = synthetic(script);
  const manager = linuxServiceManager({ runner, uid: UID, accountHome: home, sleep: (ms) => sleeps.push(ms) });
  return { manager, calls, commands };
}

const UNIT = `${DAEMON_LABEL}.service`;
/** The calls of one offer: the manager reads its units again, enables this one, and starts it. */
const offer = (verb: 'start' | 'restart'): string[] => ['daemon-reload', `enable ${UNIT}`, `${verb} ${UNIT}`];
const STOP = [`stop ${UNIT}`, `reset-failed ${UNIT}`];

/** `count` refused starts, then the accepted one. */
function refusedThenAccepted(count: number): ServiceRunResult[] {
  return [...Array.from({ length: count }, () => START_REFUSED), OK];
}

/** The earlier unit a refresh replaces: one successful install, read back byte for byte. */
function withEarlierUnit(home: string): string {
  const first = managerWith(home).manager;
  expect(first.install(home, program(home, 'v1')).ok).toBe(true);
  return readFileSync(first.unitPath(home), 'utf8');
}

/** A user-facing line must never name the platform's own facility. */
const PLATFORM_WORDS = /systemd|systemctl|loginctl|linger|\.service\b|unit file/i;

describe('the linux adapter is the system\'s service manager on linux', () => {
  test('systemServiceManager on linux is the user-service adapter, and its unit lives in the user unit folder', () => {
    const { home } = scratch();
    const { runner } = synthetic({});
    const manager = systemServiceManager({ platform: 'linux', runner, uid: UID, accountHome: home });
    expect(manager).not.toBeNull();
    expect(manager?.kind).toBe('system-service-manager');
    expect(manager?.unitPath(home)).toBe(join(home, '.config', 'systemd', 'user', UNIT));
  });

  test('the other platforms keep their own answer', () => {
    const { home } = scratch();
    const darwin = systemServiceManager({ platform: 'darwin', runner: synthetic({}).runner, uid: UID, accountHome: home });
    expect(darwin?.unitPath(home)).toBe(join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`));
    expect(systemServiceManager({ platform: 'win32' })).toBeNull();
  });

  test('the account home is read from the account record, not the shell', () => {
    const { home } = scratch();
    const calls: string[] = [];
    const runner: ServiceRunner = (command, args) => {
      calls.push([command, ...args].join(' '));
      if (command === '/usr/bin/getent') return { status: 0, stdout: `admin:x:${String(UID)}:${String(UID)}:,,,:${home}:/bin/bash\n`, stderr: '' };
      return { ...OK };
    };
    const manager = linuxServiceManager({ runner, uid: UID });
    expect(manager.accountHome?.()).toBe(home);
    expect(manager.unitPath(home)).toBe(join(home, '.config', 'systemd', 'user', UNIT));
    expect(calls).toEqual([`/usr/bin/getent passwd ${String(UID)}`]);
  });

  test('an account record with no absolute home fails every verb closed', () => {
    const { home } = scratch();
    const runner: ServiceRunner = () => ({ status: 2, stdout: '', stderr: '' });
    const manager = linuxServiceManager({ runner, uid: UID });
    expect(manager.accountHome?.()).toBeNull();
    const installed = manager.install(home, program(home, 'v1'));
    expect(installed).toMatchObject({ ok: false, outcome: 'refused', kept: false });
    expect(manager.uninstall(home).ok).toBe(false);
    expect(manager.restart(home)).toMatchObject({ ok: false, reason: 'refused' });
    expect(existsSync(join(home, '.config', 'systemd'))).toBe(false);
  });
});

describe('the unit text', () => {
  test('the unit runs the retained copy with the opt-ins, the installer\'s PATH and the daemon log', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);

    const result = manager.install(home, program(home, 'v1', { presence: true, watch: true, path: '/home/u/.bun/bin:/usr/bin:/bin' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = readFileSync(manager.unitPath(home), 'utf8');
    const copy = result.program?.[1] ?? '';
    expect(copy.startsWith(`${daemonRuntimeRoot(home)}/`)).toBe(true);
    expect(copy.endsWith('/cli.js')).toBe(true);
    expect(result.program).toEqual([EXEC, copy, 'daemon', 'run', '--started-by', 'service-manager', '--presence', '--watch']);
    expect(text).toContain(`ExecStart=${EXEC} ${copy} daemon run --started-by service-manager --presence --watch\n`);
    expect(text).toContain('[Service]\nType=exec\n');
    expect(text).toContain(`Environment="HOME=${home}"\n`);
    expect(text).toContain(`Environment="XDG_CONFIG_HOME=${join(home, '.config')}"\n`);
    expect(text).toContain('Environment="PATH=/home/u/.bun/bin:/usr/bin:/bin"\n');
    expect(text).toContain(`WorkingDirectory=${home}\n`);
    // A non-zero exit is restarted, a clean exit is not; a stop signals the daemon alone, so the
    // session server it started survives a restart.
    expect(text).toContain('Restart=on-failure\n');
    expect(text).toContain('KillMode=process\n');
    expect(text).toContain(`StandardOutput=append:${daemonLogPath(home)}\n`);
    expect(text).toContain(`StandardError=append:${daemonLogPath(home)}\n`);
    expect(text.endsWith('[Install]\nWantedBy=default.target\n')).toBe(true);
    // Neither the roots nor a credential is written into the run command.
    expect(text).not.toContain('--root');
    expect(text).not.toContain('--general');
    expect(text).not.toContain('--key');
    // The unit is this user's own and no one else's to write.
    expect(statSync(manager.unitPath(home)).mode & 0o777).toBe(0o600);
  });

  test('a plain install writes neither opt-in and no PATH it was not given', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);
    const result = manager.install(home, program(home, 'v1'));
    expect(result.ok).toBe(true);
    const text = readFileSync(manager.unitPath(home), 'utf8');
    expect(text).not.toContain('--presence');
    expect(text).not.toContain('--watch');
    expect(text).not.toContain('Environment="PATH=');
  });

  test('the unit record reads back the words the unit was written with', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);
    const result = manager.install(home, program(home, 'v1', { presence: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unit = manager.unit(home);

    expect(unit).toEqual({
      path: manager.unitPath(home),
      label: DAEMON_LABEL,
      ownerUid: UID,
      mode: 0o600,
      programArguments: result.program ?? null,
    });
  });

  test('a word with spaces, quotes, a backslash, a specifier or a variable reads back exactly', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);
    const odd = '/opt/odd "runtime" 100% $HOME \\bin\tx/bun';

    const result = manager.install(home, program(home, 'v1', { execPath: odd, path: '/a b/50%:/c"d' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = readFileSync(manager.unitPath(home), 'utf8');
    // The manager's own rules: `%` doubled, `$` doubled, a quote and a backslash escaped inside
    // double quotes, and a control character written as an escape.
    expect(text).toContain('ExecStart="/opt/odd \\"runtime\\" 100%% $$HOME \\\\bin\\x09x/bun" ');
    expect(text).toContain('Environment="PATH=/a b/50%%:/c\\"d"\n');
    expect(manager.unit(home)?.programArguments?.[0]).toBe(odd);
    expect(manager.unit(home)?.programArguments).toEqual(result.program ?? []);
  });

  test('a unit whose command line the reader cannot name is read as carrying no run words', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);
    const path = manager.unitPath(home);
    mkdirSync(dirname(path), { recursive: true });
    // A specifier the manager resolves at load time, a variable it expands at start, an unclosed
    // quote, and two command lines: none is a word list this reader can vouch for.
    for (const line of [
      'ExecStart=/usr/bin/bun %h/cli.js',
      'ExecStart=/usr/bin/bun $ENTRY',
      'ExecStart="/usr/bin/bun /cli.js',
      'ExecStart=/usr/bin/bun /a.js\nExecStart=/usr/bin/bun /b.js',
    ]) {
      writeFileSync(path, `[Service]\n${line}\n`, { mode: 0o600 });
      expect(manager.unit(home)?.programArguments).toBeNull();
    }
    // An empty assignment clears the ones before it, as it does for the manager; a continued
    // line, a single-quoted word and a comment read as the manager reads them.
    writeFileSync(path, `# a note\n[Service]\nExecStart=/old\nExecStart=\nExecStart=/usr/bin/bun \\\n  '/a b/cli.js' daemon\n`, { mode: 0o600 });
    expect(manager.unit(home)?.programArguments).toEqual(['/usr/bin/bun', '/a b/cli.js', 'daemon']);
  });
});

describe('an install offers the unit until the manager takes it', () => {
  test('a fresh install reloads the units, enables this one, starts it, and reads the login record', () => {
    const { home } = scratch();
    const sleeps: number[] = [];
    const { manager, calls } = managerWith(home, {}, sleeps);

    const result = manager.install(home, program(home, 'v1'));

    expect(result).toMatchObject({ ok: true, unitPath: manager.unitPath(home) });
    // A restart starts a unit that is not running and replaces one that is.
    expect(calls).toEqual([...offer('restart'), `show-user ${String(UID)} -p Linger`]);
    expect(sleeps).toEqual([]);
  });

  test('a refresh whose first offer is refused is stopped, cleared and offered again', () => {
    const { home } = scratch();
    withEarlierUnit(home);
    const sleeps: number[] = [];
    const { manager, calls } = managerWith(home, { restart: [START_REFUSED] }, sleeps);

    const result = manager.install(home, program(home, 'v2'));

    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual([...offer('restart'), ...STOP, ...offer('start'), `show-user ${String(UID)} -p Linger`]);
    expect(sleeps).toEqual([]);
  });

  test('the waits between offers grow, the same bounded waits the other platform gives', () => {
    const { home } = scratch();
    withEarlierUnit(home);
    const sleeps: number[] = [];
    const { manager, calls } = managerWith(home, { restart: [START_REFUSED], start: refusedThenAccepted(4) }, sleeps);

    const result = manager.install(home, program(home, 'v2'));

    expect(result).toMatchObject({ ok: true });
    expect(sleeps).toEqual([100, 200, 400, 800]);
    expect(calls.filter((call) => call === `start ${UNIT}`)).toHaveLength(5);
  });

  test('a refused reload or enable is a refused offer, and the start is not asked', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith(home, { reload: [{ status: 1, stdout: '', stderr: 'Failed to connect to bus' }, OK] });

    const result = manager.install(home, program(home, 'v1'));

    expect(result.ok).toBe(true);
    expect(calls.slice(0, 3)).toEqual(['daemon-reload', ...STOP]);
    expect(calls.slice(3, 6)).toEqual(offer('start'));
  });
});

describe('a start that fails every time puts the previous unit back', () => {
  test('the previous unit is restored byte for byte and started again, and the failure names the rollback', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const sleeps: number[] = [];
    const { manager, calls } = managerWith(
      home,
      { restart: [START_REFUSED], start: refusedThenAccepted(BOUNDED_OFFERS - 1) },
      sleeps,
    );

    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('restored');
    expect(result.kept).toBe(true);
    expect(result.why).toBe(
      'the system\'s service manager refused to start the new daemon; the previous one was put back and started again',
    );
    expect(result.why).not.toMatch(PLATFORM_WORDS);
    expect(result.detail).toContain('the load exited 1: Job for');
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    expect(sleeps).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000]);
    // The restored unit is offered after the manager read the restored file again.
    const restoredAt = calls.lastIndexOf('daemon-reload');
    expect(calls.slice(restoredAt - 2)).toEqual([...STOP, ...offer('start')]);
    // The copy the refresh added is gone; the copy the restored unit runs stays.
    const named = readFileSync(manager.unitPath(home), 'utf8').match(/daemon-runtime\/([0-9a-f]{64})\//)?.[1];
    expect(named).toBeDefined();
    expect(readdirSync(daemonRuntimeRoot(home)).filter((name) => /^[0-9a-f]{64}$/.test(name))).toEqual([named ?? '']);
  });

  test('a rollback start that is refused too says no daemon was started and keeps the earlier unit', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith(home, { restart: [START_REFUSED], start: [START_REFUSED] });

    const result = manager.install(home, program(home, 'v2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('lost');
    expect(result.kept).toBe(true);
    expect(result.why).toBe(
      'the system\'s service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
    );
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    // The effort is bounded: the forward offers, then the same bounded offers for the earlier unit.
    expect(calls.filter((call) => call === `restart ${UNIT}` || call === `start ${UNIT}`)).toHaveLength(BOUNDED_OFFERS + 9);
  });

  test('a first install the manager refuses disables and removes its own unit and names no earlier one', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith(home, { restart: [START_REFUSED], start: [START_REFUSED] });

    const result = manager.install(home, program(home, 'v1'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe('refused');
    expect(result.kept).toBe(false);
    expect(result.why).toBe('the system\'s service manager refused to start the daemon');
    expect(existsSync(manager.unitPath(home))).toBe(false);
    // No start link is left pointing at the removed file, and the manager forgets the unit.
    expect(calls.slice(-3)).toEqual([`disable ${UNIT}`, `reset-failed ${UNIT}`, 'daemon-reload']);
    expect(calls.filter((call) => call === `restart ${UNIT}` || call === `start ${UNIT}`)).toHaveLength(BOUNDED_OFFERS);
    // The copy this install made went with it.
    expect(existsSync(daemonRuntimeRoot(home)) ? readdirSync(daemonRuntimeRoot(home)) : []).toEqual([]);
  });
});

describe('the undo after a daemon that did not answer', () => {
  test('a fresh install\'s undo stops the job and removes the unit and its copy', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith(home);
    const result = manager.install(home, program(home, 'v1'));
    expect(result.ok).toBe(true);
    if (!result.ok || result.undo === undefined) throw new Error('the install carried no undo');
    calls.length = 0;

    const undone = result.undo();

    expect(undone).toMatchObject({ ok: false, outcome: 'refused', kept: false });
    expect(undone.why).toBe('the daemon the new unit started did not answer the health probe');
    expect(calls.slice(0, 2)).toEqual(STOP);
    expect(existsSync(manager.unitPath(home))).toBe(false);
  });

  test('a refresh\'s undo puts the earlier unit back and starts it again', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith(home);
    const result = manager.install(home, program(home, 'v2'));
    expect(result.ok).toBe(true);
    if (!result.ok || result.undo === undefined) throw new Error('the install carried no undo');
    expect(readFileSync(manager.unitPath(home), 'utf8')).not.toBe(earlier);
    calls.length = 0;

    const undone = result.undo();

    expect(undone).toMatchObject({ ok: false, outcome: 'restored', kept: true });
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
    expect(calls).toEqual([...STOP, ...offer('start')]);
  });
});

describe('uninstall removes the unit only after the manager confirmed the stop', () => {
  test('a confirmed disable and stop removes the unit, and the manager forgets it', () => {
    const { home } = scratch();
    withEarlierUnit(home);
    const { manager, calls } = managerWith(home);

    const result = manager.uninstall(home);

    expect(result).toEqual({ ok: true, unitPath: manager.unitPath(home), removed: true });
    expect(existsSync(manager.unitPath(home))).toBe(false);
    expect(calls).toEqual([`disable --now ${UNIT}`, 'daemon-reload', `reset-failed ${UNIT}`]);
  });

  test('a stop the manager did not confirm is refused, and the unit stays for the retry', () => {
    const { home } = scratch();
    withEarlierUnit(home);
    const { manager } = managerWith(home, { disable: [{ status: 1, stdout: '', stderr: 'Failed to stop: timed out' }] });

    const result = manager.uninstall(home);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.why).toBe('the system\'s service manager did not confirm the daemon stopped');
    expect(result.why).not.toMatch(PLATFORM_WORDS);
    expect(result.detail).toBe('disable --now exited 1: Failed to stop: timed out');
    expect(existsSync(manager.unitPath(home))).toBe(true);
  });

  test('nothing installed is not a failed stop: the uninstall says so and writes nothing', () => {
    const { home } = scratch();
    const { manager } = managerWith(home, { disable: [{ status: 1, stdout: '', stderr: 'Unit file does not exist.' }] });

    const result = manager.uninstall(home);

    expect(result).toEqual({ ok: true, unitPath: manager.unitPath(home), removed: false });
  });
});

describe('restart stops the held job and starts the installed unit again', () => {
  test('a machine with no unit is not touched', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith(home);
    expect(manager.restart(home)).toMatchObject({ ok: false, reason: 'not-installed' });
    expect(calls).toEqual([]);
  });

  test('the installed unit is stopped and offered again, and nothing is written', () => {
    const { home } = scratch();
    const earlier = withEarlierUnit(home);
    const { manager, calls } = managerWith(home);

    const result = manager.restart(home);

    expect(result).toMatchObject({ ok: true, unitPath: manager.unitPath(home) });
    expect(calls).toEqual([...STOP, ...offer('start')]);
    expect(readFileSync(manager.unitPath(home), 'utf8')).toBe(earlier);
  });

  test('a start refused after every bounded retry is reported with no daemon running', () => {
    const { home } = scratch();
    withEarlierUnit(home);
    const sleeps: number[] = [];
    const { manager } = managerWith(home, { start: [START_REFUSED] }, sleeps);

    const result = manager.restart(home);

    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    if (result.ok) return;
    expect(result.why).not.toMatch(PLATFORM_WORDS);
    expect(sleeps).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000]);
  });
});

/** The manager's printed record of a unit, in the form the same manager version prints. */
function showText(fields: { pid: number; executed?: number; program: string; argv: string; fragment: string; load?: string; active?: string }): string {
  const executed = fields.executed ?? fields.pid;
  return [
    `MainPID=${String(fields.pid)}`,
    `ExecMainPID=${String(executed)}`,
    `ExecStart={ path=${fields.program} ; argv[]=${fields.argv} ; ignore_errors=no ; start_time=[Fri 2026-11-13 19:39:23 CET] ; stop_time=[n/a] ; pid=${String(executed)} ; code=(null) ; status=0/0 }`,
    `LoadState=${fields.load ?? 'loaded'}`,
    `ActiveState=${fields.active ?? 'active'}`,
    `FragmentPath=${fields.fragment}`,
    '',
  ].join('\n');
}

describe('the job record is the manager\'s own', () => {
  function installed(home: string): ServiceManager {
    const manager = managerWith(home).manager;
    expect(manager.install(home, program(home, 'v1')).ok).toBe(true);
    return manager;
  }

  function jobWith(home: string, stdout: string, status = 0): ReturnType<ServiceManager['job']> {
    const { manager, calls } = managerWith(home, { show: [{ status, stdout, stderr: '' }] });
    const job = manager.job(home);
    if (calls.length > 0) {
      expect(calls[0]).toBe(`show ${UNIT} -p MainPID -p ExecMainPID -p ExecStart -p LoadState -p ActiveState -p FragmentPath`);
    }
    return job;
  }

  test('a running job names its main pid and the executable its command line starts', () => {
    const { home } = scratch();
    const manager = installed(home);
    const job = jobWith(home, showText({ pid: 4242, program: EXEC, argv: `${EXEC} /x/cli.js daemon run`, fragment: manager.unitPath(home) }));
    expect(job).toEqual({ pid: 4242, program: EXEC });
  });

  test('a job with no process names no pid', () => {
    const { home } = scratch();
    const manager = installed(home);
    const job = jobWith(home, showText({ pid: 0, program: EXEC, argv: EXEC, fragment: manager.unitPath(home), active: 'inactive' }));
    expect(job).toEqual({ pid: null, program: EXEC });
  });

  test('a main process other than the one the manager executed names no program', () => {
    const { home } = scratch();
    const manager = installed(home);
    const job = jobWith(home, showText({ pid: 4242, executed: 4100, program: EXEC, argv: EXEC, fragment: manager.unitPath(home) }));
    expect(job).toEqual({ pid: 4242, program: null });
  });

  test('a unit loaded from another file, a unit not loaded, and an unreadable record are no record', () => {
    const { home } = scratch();
    installed(home);
    expect(jobWith(home, showText({ pid: 4242, program: EXEC, argv: EXEC, fragment: '/elsewhere/copied.service' }))).toBeNull();
    expect(jobWith(home, 'MainPID=0\nExecMainPID=0\nLoadState=not-found\nActiveState=inactive\nFragmentPath=\n')).toBeNull();
    expect(jobWith(home, '', 1)).toBeNull();
  });

  test('no unit file is no record, and the manager is not asked', () => {
    const { home } = scratch();
    const { manager, calls } = managerWith(home);
    expect(manager.job(home)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('loaded programs are read from the manager\'s list and each unit\'s own file', () => {
  test('a unit with a live process names its run words; an inactive one names nothing', () => {
    const { home } = scratch();
    const { manager } = managerWith(home);
    const result = manager.install(home, program(home, 'v1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const other = join(home, '.config', 'systemd', 'user', 'other.service');
    writeFileSync(other, '[Service]\nExecStart=/usr/bin/other /kits/old\n', { mode: 0o600 });
    const list = [
      'dbus.service                     loaded inactive dead D-Bus User Message Bus',
      `${UNIT}  loaded active   running TeamCLI machine daemon`,
      'other.service                    loaded inactive dead other',
      '',
    ].join('\n');
    const reader = managerWith(home, { list: [{ status: 0, stdout: list, stderr: '' }] });

    const loaded = reader.manager.loadedPrograms?.(home);

    expect(loaded).toEqual([{ label: DAEMON_LABEL, program: result.program ?? [] }]);
    expect(reader.calls).toEqual(['list-units --type=service --all --no-legend --plain']);
  });

  test('an unreadable list holds nothing', () => {
    const { home } = scratch();
    const { manager } = managerWith(home, { list: [{ status: 1, stdout: '', stderr: 'Failed to connect to bus' }] });
    expect(manager.loadedPrograms?.(home)).toEqual([]);
  });
});

describe('a unit of a home other than the account home', () => {
  test('is enabled by its path, which links it where the manager reads units, under a derived name', () => {
    const { home } = scratch();
    const account = join(dirname(home), 'account');
    mkdirSync(account, { recursive: true });
    const { runner, calls } = synthetic({});
    const manager = linuxServiceManager({ runner, uid: UID, accountHome: account, sleep: () => {} });

    const result = manager.install(home, program(home, 'v1'));

    expect(result.ok).toBe(true);
    const path = manager.unitPath(home);
    const name = path.split('/').pop() ?? '';
    expect(name).toMatch(new RegExp(`^${DAEMON_LABEL.replace(/\./g, '\\.')}\\.[0-9a-f]{16}\\.service$`));
    expect(calls.slice(0, 3)).toEqual(['daemon-reload', `enable ${path}`, `restart ${name}`]);
  });
});

describe('an install says when the daemon stops at logout', () => {
  test('a login record that does not linger is carried on the success, in the adapter\'s own words for the log', () => {
    const { home } = scratch();
    const { manager } = managerWith(home, { linger: [NO_LINGER] });
    const result = manager.install(home, program(home, 'v1'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopsAtLogout?.detail).toContain('Linger=no');
  });

  test('a lingering record, or one that cannot be read, makes no claim', () => {
    for (const linger of [LINGERS, { status: 1, stdout: '', stderr: 'Failed to get user: User ID 1000 is not logged in or lingering' }]) {
      const { home } = scratch();
      const { manager } = managerWith(home, { linger: [linger] });
      const result = manager.install(home, program(home, 'v1'));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.stopsAtLogout).toBeUndefined();
    }
  });

  const ANSWERING: DaemonHealth = {
    daemon: 'teamcli',
    socket: '/synthetic/daemon.sock',
    state: 'running',
    running: true,
    pid: 42,
    uid: 501,
    since: '2026-11-13T00:00:00.000Z',
    startedBy: 'system-service-manager',
    version: 'test',
    gitHead: null,
    heartbeatAt: null,
    heartbeatSeconds: null,
    features: null,
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: '2026-11-13T00:00:01.000Z' },
    why: null,
  };

  function sourcesOf(home: string, service: ServiceManager): DaemonCommandSources {
    return {
      home,
      accountHome: home,
      program: { execPath: EXEC, entry: programFiles(home, 'v1') },
      version: 'test',
      service,
      health: async () => ANSWERING,
    };
  }

  test('the command says it in neutral words, and the log keeps the adapter\'s account', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith(home, { linger: [NO_LINGER] });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain('team daemon: installed for ');
    expect(io.out).toContain(
      'team daemon: the system\'s service manager stops this daemon when this user\'s last login session ends',
    );
    expect(io.out + io.err).not.toMatch(PLATFORM_WORDS);
    expect(readFileSync(daemonLogPath(home), 'utf8')).toContain('install: the user manager of uid');
  });

  test('install --json carries it as a field', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith(home, { linger: [NO_LINGER] });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install', '--json'], io, sourcesOf(home, manager));

    expect(code, io.err).toBe(0);
    const document = JSON.parse(io.out) as { installed: boolean; stops_at_logout?: boolean };
    expect(document.installed).toBe(true);
    expect(document.stops_at_logout).toBe(true);
  });

  test('a lingering account gets no such line', async () => {
    const { root, home } = scratch();
    const { manager } = managerWith(home, { linger: [LINGERS] });
    const io = testIo(root, { kind: 'owner' });

    const code = await runDaemon(['install'], io, sourcesOf(home, manager));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain('team daemon: installed for ');
    expect(io.out).not.toContain('login session');
  });
});

/** The launch words this process carries; a unit that runs them is the one it was started from. */
const OWN_WORDS: readonly string[] = [process.execPath, ...process.argv.slice(1)];

/** One word quoted for the unit's command line, by this scene's own rule rather than the
 *  adapter's, so the admission scene does not read back what the adapter wrote. */
function sceneQuote(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

describe('a start by the service manager is admitted from its own record on linux', () => {
  type StartInput = Parameters<NonNullable<DaemonCommandSources['start']>>[0];

  async function startWith(
    record: (unit: string) => string,
    words: readonly string[] = OWN_WORDS,
    mode = 0o600,
  ): Promise<{ code: number; err: string; started: StartInput[] }> {
    const { root, home } = scratch();
    const unit = join(home, '.config', 'systemd', 'user', UNIT);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, `[Unit]\nDescription=scene\n\n[Service]\nType=exec\nExecStart=${words.map(sceneQuote).join(' ')}\n`);
    chmodSync(unit, mode);
    const runner: ServiceRunner = (command, args) =>
      command === 'systemctl' && args[1] === 'show'
        ? { status: 0, stdout: record(unit), stderr: '' }
        : { ...OK };
    const manager = systemServiceManager({ platform: 'linux', uid: UID, accountHome: home, sleep: () => {}, runner });
    if (manager === null) throw new Error('the linux adapter did not answer');
    const io = testIo(root, { kind: 'owner-no-tty' });
    const started: StartInput[] = [];
    const code = await runDaemon(['run', '--started-by', 'service-manager', '--root', root], io, {
      home,
      accountHome: home,
      service: manager,
      start: async (input) => {
        started.push(input);
        return { kind: 'already-running', pid: 42 };
      },
    });
    return { code, err: io.err, started };
  }

  const CHECK_PREFIX = "only the owner or the system's service manager starts the machine daemon: ";
  const ownRecord = (unit: string): string =>
    showText({ pid: process.pid, program: process.execPath, argv: OWN_WORDS.join(' '), fragment: unit });

  test('the record of the running job and the unit\'s own words admit the start', async () => {
    const ran = await startWith(ownRecord);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.started).toHaveLength(1);
    expect(ran.started[0]?.startedBy).toBe('service-manager');
  });

  test('a record naming another process is refused', async () => {
    const ran = await startWith((unit) => showText({ pid: process.pid + 1, program: process.execPath, argv: '', fragment: unit }));
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record of the job does not name this process`);
    expect(ran.started).toHaveLength(0);
  });

  test('a unit whose words are not this process\'s own is refused', async () => {
    const ran = await startWith(ownRecord, [...OWN_WORDS, '--watch']);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record and the unit do not run this executable with these words`);
    expect(ran.started).toHaveLength(0);
  });

  test('a unit another user can write is refused', async () => {
    const ran = await startWith(ownRecord, OWN_WORDS, 0o620);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the unit file is not this daemon's own`);
    expect(ran.started).toHaveLength(0);
  });
});

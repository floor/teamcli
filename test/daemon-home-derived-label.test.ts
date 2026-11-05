import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { DAEMON_LABEL, daemonLabel, daemonSocketPath } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceProgram, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { keyOf } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';

const UID = typeof process.getuid === 'function' ? process.getuid() : 501;

const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 4242,
  uid: UID,
  since: '2026-11-01T00:00:00.000Z',
  startedBy: 'system-service-manager',
  version: 'test',
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'answered', at: '2026-11-01T00:00:01.000Z' },
  why: null,
};

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  discardFixtures(dirs.splice(0, dirs.length));
});

function expectedDerivedLabel(home: string): string {
  const hex = createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
  return `${DAEMON_LABEL}.${hex}`;
}

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

function makeProject(base: string): { root: string; entry: string } {
  const root = join(base, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const srcDir = join(base, 'src');
  mkdirSync(srcDir, { recursive: true });
  const entry = join(srcDir, 'entry.ts');
  writeFileSync(entry, 'export const ok = true;\n');
  return { root, entry };
}

function writeFreshMailboxHeartbeat(home: string): void {
  writeDaemonState(home, {
    format: 1,
    pid: 4242,
    uid: UID,
    since: '2026-11-04T02:00:00.000Z',
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: '2026-11-04T02:00:00.000Z',
    socket: daemonSocketPath(home),
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    mailbox: { heartbeatAt: '2026-11-04T02:00:00.000Z' },
  });
}

function idPasswdLine(uid: number, accountHome: string): string {
  return `tester:********:${String(uid)}:20::0:0:Test User:${accountHome}:/bin/zsh\n`;
}

describe('home-derived daemon label and --home install/uninstall', () => {
  test('a non-account home install skips shuttle retirement and leaves the three shuttle jobs untouched', async () => {
    const accountHome = makeDir('acct-home-');
    const scratchHome = makeDir('scratch-home-');
    const { root, entry } = makeProject(scratchHome);
    writeFreshMailboxHeartbeat(scratchHome);
    writeFreshMailboxHeartbeat(accountHome);

    const calls: string[] = [];
    const retiredLabels: string[] = [];
    const runner: ServiceRunner = (command, args): ServiceRunResult => {
      calls.push([command, ...args].join(' '));
      if (command === '/usr/bin/id') {
        return { status: 0, stdout: idPasswdLine(UID, accountHome), stderr: '' };
      }
      if (args[0] === 'print') {
        return {
          status: 0,
          stdout: `\tstate = running\n\tpid = 4242\n\tprogram = ${process.execPath}\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const manager = darwinServiceManager({ uid: UID, runner, sleep: () => {} });
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(['install', '--root', root, '--json'], io, {
      home: scratchHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
      retireShuttle: (label) => {
        retiredLabels.push(label);
        return { ok: true };
      },
    });

    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(retiredLabels).toEqual([]);

    const viaFlagIo = testIo(root, { kind: 'owner' });
    const viaFlagCode = await runDaemon(['install', '--home', scratchHome, '--root', root, '--json'], viaFlagIo, {
      home: accountHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
      retireShuttle: (label) => {
        retiredLabels.push(label);
        return { ok: true };
      },
    });
    expect(viaFlagIo.err).toBe('');
    expect(viaFlagCode).toBe(0);
    expect(retiredLabels).toEqual([]);
    expect(calls.some((line) => line.includes('iris-shuttle'))).toBe(false);
    expect(calls.some((line) => line.includes('atlas-shuttle'))).toBe(false);
    expect(calls.some((line) => line.includes('desk-shuttle'))).toBe(false);
  });

  test('darwinServiceManager reads the account home from field 9 of /usr/bin/id -P <uid> through its runner, not HOME', () => {
    const accountHome = makeDir('id-acct-');
    const throwawayHome = makeDir('id-throwaway-');
    const calls: string[] = [];
    const runner: ServiceRunner = (command, args): ServiceRunResult => {
      calls.push([command, ...args].join(' '));
      if (command === '/usr/bin/id' && args[0] === '-P' && args[1] === String(UID)) {
        return { status: 0, stdout: idPasswdLine(UID, accountHome), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const savedHome = process.env.HOME;
    process.env.HOME = throwawayHome;
    try {
      const manager = darwinServiceManager({ uid: UID, runner, sleep: () => {} });
      expect(manager.unitPath(accountHome)).toBe(
        join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`),
      );
      const derived = expectedDerivedLabel(throwawayHome);
      expect(manager.unitPath(throwawayHome)).toBe(
        join(throwawayHome, 'Library', 'LaunchAgents', `${derived}.plist`),
      );
      expect(calls).toContain(`/usr/bin/id -P ${String(UID)}`);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test('derived label, unit path, unit environment, and launchctl calls isolate a non-account home from the machine label', () => {
    const accountHome = makeDir('iso-acct-');
    const scratchHome = makeDir('iso-scratch-');
    const { root, entry } = makeProject(scratchHome);
    const derived = expectedDerivedLabel(scratchHome);
    expect(daemonLabel(accountHome, accountHome)).toBe(DAEMON_LABEL);
    expect(daemonLabel(scratchHome, accountHome)).toBe(derived);
    expect(derived).toMatch(/^io\.floor\.teamcli\.daemon\.[0-9a-f]{16}$/);

    const calls: string[] = [];
    const program: ServiceProgram = {
      execPath: process.execPath,
      entry,
      roots: [root],
      path: '/opt/bun/bin:/usr/bin:/bin',
    };
    const runner: ServiceRunner = (command, args): ServiceRunResult => {
      calls.push([command, ...args].join(' '));
      if (command === '/usr/bin/id') {
        return { status: 0, stdout: idPasswdLine(UID, accountHome), stderr: '' };
      }
      if (args[0] === 'print') {
        return {
          status: 0,
          stdout: `\tstate = running\n\tpid = 9191\n\tprogram = ${program.execPath}\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const manager = darwinServiceManager({ uid: UID, runner, sleep: () => {} });
    const installed = manager.install(scratchHome, program);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const expectedPath = join(scratchHome, 'Library', 'LaunchAgents', `${derived}.plist`);
    expect(installed.unitPath).toBe(expectedPath);

    const plist = readFileSync(expectedPath, 'utf8');
    expect(plist).toContain(`<string>${derived}</string>`);
    expect(plist).not.toContain(`<string>${DAEMON_LABEL}</string>`);
    expect(plist).toContain(`<key>HOME</key>\n    <string>${scratchHome}</string>`);
    expect(plist).toContain(`<key>TMPDIR</key>\n    <string>${join(scratchHome, 'tmp')}</string>`);
    expect(plist).toContain(`<key>XDG_CONFIG_HOME</key>\n    <string>${join(scratchHome, '.config')}</string>`);
    expect(plist).toContain(`<key>XDG_DATA_HOME</key>\n    <string>${join(scratchHome, '.local', 'share')}</string>`);
    expect(plist).toContain(`<key>XDG_CACHE_HOME</key>\n    <string>${join(scratchHome, '.cache')}</string>`);
    expect(plist).toContain(`<key>XDG_STATE_HOME</key>\n    <string>${join(scratchHome, '.local', 'state')}</string>`);
    expect(plist).toContain(`<key>PATH</key>\n    <string>${program.path}</string>`);

    const job = manager.job(scratchHome);
    expect(job?.pid).toBe(9191);

    const restarted = manager.restart(scratchHome);
    expect(restarted.ok).toBe(true);

    const removed = manager.uninstall(scratchHome);
    expect(removed.ok).toBe(true);
    expect(existsSync(expectedPath)).toBe(false);

    const launchctlCalls = calls.filter((line) => line.startsWith('launchctl '));
    expect(launchctlCalls.length).toBeGreaterThan(0);
    for (const line of launchctlCalls) {
      expect(line).toContain(derived);
      expect(line).not.toContain(`gui/${String(UID)}/${DAEMON_LABEL} `);
      expect(line).not.toMatch(new RegExp(`gui/${String(UID)}/${DAEMON_LABEL}$`));
    }
  });

  test('serviceManaged checks the label derived for its own home and refuses the machine label in a non-account home', async () => {
    const accountHome = makeDir('sm-acct-');
    const scratchHome = makeDir('sm-scratch-');
    const { root } = makeProject(scratchHome);
    const derived = expectedDerivedLabel(scratchHome);

    const words = [process.execPath, ...process.argv.slice(1)];
    const writeUnitWithLabel = (label: string, unitFile: string): void => {
      mkdirSync(join(scratchHome, 'Library', 'LaunchAgents'), { recursive: true });
      const items = words.map((w) => `    <string>${w}</string>`).join('\n');
      writeFileSync(
        unitFile,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0">',
          '<dict>',
          '  <key>Label</key>',
          `  <string>${label}</string>`,
          '  <key>ProgramArguments</key>',
          '  <array>',
          items,
          '  </array>',
          '</dict>',
          '</plist>',
          '',
        ].join('\n'),
      );
      chmodSync(unitFile, 0o644);
    };

    const runnerForLabel = (expectedServiceLabel: string): ServiceRunner => (command, args) => {
      if (command === '/usr/bin/id') {
        return { status: 0, stdout: idPasswdLine(UID, accountHome), stderr: '' };
      }
      if (command === 'launchctl' && args[0] === 'print' && args[1] === `gui/${String(UID)}/${expectedServiceLabel}`) {
        return {
          status: 0,
          stdout: `\tstate = running\n\tpid = ${String(process.pid)}\n\tprogram = ${process.execPath}\n`,
          stderr: '',
        };
      }
      return { status: 113, stdout: '', stderr: 'not found' };
    };

    // 1. Wrong label in the unit (DAEMON_LABEL instead of derived label) is refused.
    const machineUnitPath = join(scratchHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
    writeUnitWithLabel(DAEMON_LABEL, machineUnitPath);
    const badManager = darwinServiceManager({ uid: UID, runner: runnerForLabel(DAEMON_LABEL), sleep: () => {} });
    const badIo = testIo(root, { kind: 'owner-no-tty' });
    const badCode = await runDaemon(
      ['run', '--started-by', 'service-manager', '--root', root],
      badIo,
      {
        home: scratchHome,
        service: badManager,
        start: async () => ({ kind: 'already-running', pid: 42 }),
      },
    );
    expect(badCode).toBe(1);
    expect(badIo.err).toContain('the unit file is not this daemon\'s own');

    // 2. Matching derived label in the unit and job record is admitted.
    const unitPath = join(scratchHome, 'Library', 'LaunchAgents', `${derived}.plist`);
    writeUnitWithLabel(derived, unitPath);
    const goodManager = darwinServiceManager({ uid: UID, runner: runnerForLabel(derived), sleep: () => {} });
    const goodIo = testIo(root, { kind: 'owner-no-tty' });
    let started = false;
    const goodCode = await runDaemon(
      ['run', '--started-by', 'service-manager', '--root', root],
      goodIo,
      {
        home: scratchHome,
        service: goodManager,
        start: async () => {
          started = true;
          return { kind: 'already-running', pid: 42 };
        },
      },
    );
    expect(goodCode).toBe(0);
    expect(started).toBe(true);
  });

  test('install and uninstall refuse --home when it is the account home, unresolvable, has a trailing slash, or is a symlink', async () => {
    const accountHome = makeDir('refuse-acct-');
    const scratchHome = makeDir('refuse-scratch-');
    const { root, entry } = makeProject(scratchHome);
    const symlinkHome = join(accountHome, 'linked-home');
    symlinkSync(scratchHome, symlinkHome);
    const missingHome = join(accountHome, 'does-not-exist');

    const calls: string[] = [];
    const manager = darwinServiceManager({
      uid: UID,
      accountHome,
      sleep: () => {},
      runner: (command, args) => {
        calls.push([command, ...args].join(' '));
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    for (const verb of ['install', 'uninstall'] as const) {
      for (const badHome of [accountHome, missingHome, `${scratchHome}/`, symlinkHome]) {
        const io = testIo(root, { kind: 'owner' });
        const argv =
          verb === 'install'
            ? ['install', '--home', badHome, '--root', root, '--json']
            : ['uninstall', '--home', badHome, '--json'];
        const code = await runDaemon(argv, io, {
          home: accountHome,
          accountHome,
          service: manager,
          program: { execPath: process.execPath, entry },
        });
        expect(code).not.toBe(0);
        expect(io.out + io.err).not.toContain('unknown option --home');
      }
    }
    expect(calls).toEqual([]);
  });

  test('install and uninstall with --home keep the account HOME for admission while writing and removing the target home unit', async () => {
    const accountHome = makeDir('keep-acct-');
    const scratchHome = makeDir('keep-scratch-');
    const { root, entry } = makeProject(scratchHome);
    const derived = expectedDerivedLabel(scratchHome);
    const now = new Date('2026-11-04T12:00:00Z');

    writeFileSync(
      join(root, '.agents', 'team.state.json'),
      `${JSON.stringify(
        {
          format: 1,
          sessions: {
            acme: {
              seats: {
                clerk: { stage: 'ready', pane: 'pane1' },
                'op-1': { stage: 'ready', pane: 'pane2' },
              },
              worktrees: {},
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const calls: string[] = [];
    const manager = darwinServiceManager({
      uid: UID,
      accountHome,
      sleep: () => {},
      runner: (command, args) => {
        calls.push([command, ...args].join(' '));
        if (args[0] === 'print') {
          return {
            status: 0,
            stdout: `\tstate = running\n\tpid = 5150\n\tprogram = ${process.execPath}\n`,
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const sources: DaemonCommandSources = {
      home: accountHome,
      accountHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
      now: () => now,
    };

    const leadCaller = { kind: 'seat' as const, name: 'clerk', pane: 'pane1', session: 'acme' };

    // Development mode enabled ONLY in scratchHome does not admit the placed lead because admission reads accountHome.
    keyOf(scratchHome);
    const scratchDev = writeDevelopmentMode({ home: scratchHome, mode: 'local-fast', now, caller: 'test' });
    if (!scratchDev.ok) throw new Error(scratchDev.why);
    const deniedIo = testIo(root, leadCaller);
    const deniedCode = await runDaemon(['install', '--home', scratchHome, '--root', root, '--json'], deniedIo, sources);
    expect(deniedCode).toBe(1);
    expect(JSON.parse(deniedIo.out || deniedIo.err).error?.id).toBe('daemon.not-owner');

    // Development mode enabled in accountHome admits the placed lead while writing the unit under scratchHome.
    keyOf(accountHome);
    const acctDev = writeDevelopmentMode({ home: accountHome, mode: 'local-fast', now, caller: 'test' });
    if (!acctDev.ok) throw new Error(acctDev.why);

    const installIo = testIo(root, leadCaller);
    const installCode = await runDaemon(['install', '--home', scratchHome, '--root', root, '--json'], installIo, sources);
    expect(installCode).toBe(0);
    expect(installIo.err).toContain('dev mode continues');

    const expectedUnit = join(scratchHome, 'Library', 'LaunchAgents', `${derived}.plist`);
    expect(existsSync(expectedUnit)).toBe(true);
    expect(existsSync(join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`))).toBe(false);

    const uninstallIo = testIo(root, leadCaller);
    const uninstallCode = await runDaemon(['uninstall', '--home', scratchHome, '--json'], uninstallIo, sources);
    expect(uninstallCode).toBe(0);
    expect(uninstallIo.err).toContain('dev mode continues');
    expect(existsSync(expectedUnit)).toBe(false);
  });

  test('when the account home cannot be read, daemonLabel, install, uninstall, and serviceManaged fail closed with or without --home', async () => {
    const accountHome = makeDir('unreadable-acct-');
    const scratchHome = makeDir('unreadable-scratch-');
    const { root, entry } = makeProject(accountHome);

    expect(daemonLabel(accountHome, null)).toBeNull();
    expect(daemonLabel(scratchHome, null)).toBeNull();
    expect(daemonLabel(accountHome, '')).toBeNull();

    const machineUnit = join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
    const derivedAccountUnit = join(accountHome, 'Library', 'LaunchAgents', `${expectedDerivedLabel(accountHome)}.plist`);
    const derivedScratchUnit = join(scratchHome, 'Library', 'LaunchAgents', `${expectedDerivedLabel(scratchHome)}.plist`);
    mkdirSync(join(accountHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(machineUnit, 'existing machine unit bytes\n', { mode: 0o600 });

    let idWorks = false;
    const calls: string[] = [];
    const manager = darwinServiceManager({
      uid: UID,
      sleep: () => {},
      runner: (command, args) => {
        calls.push([command, ...args].join(' '));
        if (command === '/usr/bin/id') {
          return idWorks
            ? { status: 0, stdout: idPasswdLine(UID, accountHome), stderr: '' }
            : { status: 1, stdout: '', stderr: 'id: no such user' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    const sources: DaemonCommandSources = {
      home: accountHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
    };

    // 1. Machine install (no --home) refuses before writing a derived unit or touching the existing machine unit.
    const installPlainIo = testIo(root, { kind: 'owner' });
    const installPlainCode = await runDaemon(['install', '--root', root, '--json'], installPlainIo, sources);
    expect(installPlainCode).toBe(1);
    expect(JSON.parse(installPlainIo.out || installPlainIo.err).error?.message).toContain('the account home could not be read');
    expect(existsSync(derivedAccountUnit)).toBe(false);
    expect(readFileSync(machineUnit, 'utf8')).toBe('existing machine unit bytes\n');
    expect(calls.some((line) => line.startsWith('launchctl'))).toBe(false);

    // 2. Machine uninstall (no --home) refuses before removing any unit or calling launchctl.
    calls.splice(0);
    const uninstallPlainIo = testIo(root, { kind: 'owner' });
    const uninstallPlainCode = await runDaemon(['uninstall', '--json'], uninstallPlainIo, sources);
    expect(uninstallPlainCode).toBe(1);
    expect(JSON.parse(uninstallPlainIo.out || uninstallPlainIo.err).error?.message).toContain('the account home could not be read');
    expect(existsSync(machineUnit)).toBe(true);
    expect(readFileSync(machineUnit, 'utf8')).toBe('existing machine unit bytes\n');
    expect(calls.some((line) => line.startsWith('launchctl'))).toBe(false);

    // 3. Install and uninstall with --home also refuse before writing or removing any unit.
    calls.splice(0);
    const installFlagIo = testIo(root, { kind: 'owner' });
    const installFlagCode = await runDaemon(['install', '--home', scratchHome, '--root', root, '--json'], installFlagIo, sources);
    expect(installFlagCode).not.toBe(0);
    expect(JSON.parse(installFlagIo.out || installFlagIo.err).error?.message).toContain('the account home could not be read');
    expect(existsSync(derivedScratchUnit)).toBe(false);
    expect(calls.some((line) => line.startsWith('launchctl'))).toBe(false);

    calls.splice(0);
    const uninstallFlagIo = testIo(root, { kind: 'owner' });
    const uninstallFlagCode = await runDaemon(['uninstall', '--home', scratchHome, '--json'], uninstallFlagIo, sources);
    expect(uninstallFlagCode).not.toBe(0);
    expect(JSON.parse(uninstallFlagIo.out || uninstallFlagIo.err).error?.message).toContain('the account home could not be read');
    expect(calls.some((line) => line.startsWith('launchctl'))).toBe(false);

    // 4. serviceManaged stays refused when the account home cannot be read.
    const runIo = testIo(root, { kind: 'owner-no-tty' });
    const runCode = await runDaemon(['run', '--started-by', 'service-manager', '--root', root], runIo, sources);
    expect(runCode).toBe(1);
    expect(runIo.err).toContain('the unit file is not this daemon\'s own');

    // 5. Failed reads are not cached as null: once /usr/bin/id succeeds, the manager resolves the account home.
    idWorks = true;
    expect(manager.accountHome?.()).toBe(accountHome);
    expect(manager.unitPath(accountHome)).toBe(machineUnit);
  });
});

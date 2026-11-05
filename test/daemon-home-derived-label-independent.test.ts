// Independent scenes for the home-derived daemon label and `daemon install/uninstall --home`.
// Written from the seam's public behaviour: the label is a function of the realpaths, the unit
// and its environment belong to the home it serves, and no --home spelling may name the account
// home or travel through a symlink. Every machine here is synthetic: a runner answers for the
// service manager, and no live unit, job or socket is read or touched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
import { runDaemon } from '../src/commands/daemon.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { DAEMON_LABEL, daemonLabel, daemonSocketPath } from '../src/daemon/paths.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import type { ServiceProgram, ServiceRunResult, ServiceRunner } from '../src/daemon/service.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';

const UID = typeof process.getuid === 'function' ? process.getuid() : 501;

const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 5150,
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

const fixtures: string[] = [];

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  discardFixtures(fixtures.splice(0, fixtures.length));
});

function derivedLabel(home: string): string {
  const hex = createHash('sha256').update(realpathSync(home)).digest('hex').slice(0, 16);
  return `${DAEMON_LABEL}.${hex}`;
}

/** A passwd record whose field 9 (index 8) is the login account home. */
function passwdLine(accountHome: string): string {
  return [`indep`, `********`, String(UID), `20`, ``, `0`, `0`, `Independent Tester`, accountHome, `/bin/zsh`].join(':') + '\n';
}

function syntheticRunner(accountHome: string): { calls: string[]; runner: ServiceRunner } {
  const calls: string[] = [];
  const runner: ServiceRunner = (command, args): ServiceRunResult => {
    calls.push([command, ...args].join(' '));
    if (command === '/usr/bin/id') {
      return { status: 0, stdout: passwdLine(accountHome), stderr: '' };
    }
    if (command === 'launchctl' && args[0] === 'print') {
      return { status: 0, stdout: `\tstate = running\n\tpid = 5150\n\tprogram = ${process.execPath}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

/** A manager whose account home is injected, and the runner that would have answered for it. */
function syntheticManager(accountHome: string): ReturnType<typeof syntheticRunner> & { manager: ReturnType<typeof darwinServiceManager> } {
  const { calls, runner } = syntheticRunner(accountHome);
  const manager = darwinServiceManager({ uid: UID, accountHome, runner, sleep: () => {} });
  return { calls, runner, manager };
}

const TEAM = `format: 1
project: indep
coordinator: lead
operator: op
session: indep
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

function makeEntry(base: string): string {
  const src = join(base, 'src');
  mkdirSync(src, { recursive: true });
  const entry = join(src, 'entry.ts');
  writeFileSync(entry, 'export const ok = true;\n');
  return entry;
}

function makeProject(base: string): { root: string; entry: string } {
  const root = join(base, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  const entry = makeEntry(base);
  return { root, entry };
}

/** A heartbeat that is fresh now, so the shuttle-retirement gate would open on its own terms. */
function writeFreshMailboxHeartbeat(home: string): void {
  const at = new Date().toISOString();
  writeDaemonState(home, {
    format: 1,
    pid: 5150,
    uid: UID,
    since: at,
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: at,
    socket: daemonSocketPath(home),
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    mailbox: { heartbeatAt: at },
  });
}

describe('home-derived daemon label and --home (independent scenes)', () => {
  test('the machine label stands for the account home through every spelling of its realpath', () => {
    const accountHome = makeDir('ind-machine-account-');
    const elsewhere = makeDir('ind-machine-elsewhere-');
    mkdirSync(join(accountHome, 'nested'));
    const dotDot = join(accountHome, 'nested', '..');
    const alias = join(elsewhere, 'account-alias');
    symlinkSync(accountHome, alias);
    const throwaway = makeDir('ind-machine-throwaway-');

    const { manager } = syntheticManager(accountHome);
    expect(daemonLabel(accountHome, accountHome)).toBe(DAEMON_LABEL);
    expect(daemonLabel(dotDot, accountHome)).toBe(DAEMON_LABEL);
    expect(daemonLabel(alias, accountHome)).toBe(DAEMON_LABEL);
    expect(manager.unitPath(accountHome)).toBe(
      join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`),
    );
    expect(manager.unitPath(dotDot).endsWith(`${DAEMON_LABEL}.plist`)).toBe(true);
    expect(manager.unitPath(alias).endsWith(`${DAEMON_LABEL}.plist`)).toBe(true);

    // The account home comes from the passwd record through the runner, never from HOME.
    const savedHome = process.env.HOME;
    process.env.HOME = throwaway;
    try {
      const { runner } = syntheticRunner(accountHome);
      const fromRecord = darwinServiceManager({ uid: UID, runner, sleep: () => {} });
      expect(fromRecord.accountHome?.()).toBe(accountHome);
      expect(fromRecord.unitPath(accountHome)).toBe(
        join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`),
      );
      expect(fromRecord.unitPath(throwaway)).toBe(
        join(throwaway, 'Library', 'LaunchAgents', `${derivedLabel(throwaway)}.plist`),
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  test('every home other than the account home derives its own label from that home realpath', () => {
    const accountHome = makeDir('ind-derive-account-');
    const other = makeDir('ind-derive-other-');
    const third = makeDir('ind-derive-third-');
    const links = makeDir('ind-derive-links-');
    const alias = join(links, 'other-alias');
    symlinkSync(other, alias);

    expect(daemonLabel(other, accountHome)).toBe(derivedLabel(other));
    expect(daemonLabel(other, accountHome)).toMatch(/^io\.floor\.teamcli\.daemon\.[0-9a-f]{16}$/);
    expect(daemonLabel(other, accountHome)).not.toBe(daemonLabel(third, accountHome));
    expect(daemonLabel(alias, accountHome)).toBe(derivedLabel(other));
    expect(daemonLabel(other, null)).toBe(derivedLabel(other));
    expect(daemonLabel(other, '')).toBe(derivedLabel(other));

    // With no readable account home, even the account home derives.
    expect(daemonLabel(accountHome, null)).toBe(derivedLabel(accountHome));
    expect(daemonLabel(accountHome, null)).not.toBe(DAEMON_LABEL);
  });

  test('install and uninstall refuse every --home that is empty, trailing-slashed, missing, a symlink, or reached through a symlink', async () => {
    const accountHome = makeDir('ind-refuse-account-');
    const scratchHome = makeDir('ind-refuse-scratch-');
    const links = makeDir('ind-refuse-links-');
    const { root, entry } = makeProject(scratchHome);
    mkdirSync(join(scratchHome, 'real', 'child'), { recursive: true });
    const intermediate = join(links, 'intermediate');
    symlinkSync(join(scratchHome, 'real'), intermediate);
    const toAccount = join(links, 'to-account');
    symlinkSync(accountHome, toAccount);
    const missing = join(scratchHome, 'no-such-home');

    const { calls, manager } = syntheticManager(accountHome);
    const cases = [
      { home: '', why: '--home needs a value' },
      { home: `${scratchHome}/`, why: 'without a trailing slash' },
      { home: missing, why: 'cannot be resolved' },
      { home: accountHome, why: 'may not name the account home' },
      { home: toAccount, why: 'is a symbolic link' },
      { home: join(intermediate, 'child'), why: 'is a symbolic link' },
    ];

    for (const verb of ['install', 'uninstall'] as const) {
      for (const one of cases) {
        calls.splice(0);
        const io = testIo(accountHome, { kind: 'owner' });
        const argv =
          verb === 'install'
            ? ['install', '--home', one.home, '--root', root, '--json']
            : ['uninstall', '--home', one.home, '--json'];
        const code = await runDaemon(argv, io, {
          home: accountHome,
          accountHome,
          service: manager,
          program: { execPath: process.execPath, entry },
        });
        expect(code).not.toBe(0);
        const said = io.out + io.err;
        expect(said).toContain('--home');
        expect(said).toContain(one.why);
        expect(said).not.toContain('unknown option');
        expect(calls).toEqual([]);
      }
    }

    expect(existsSync(join(accountHome, 'Library', 'LaunchAgents'))).toBe(false);
    expect(existsSync(join(scratchHome, 'Library', 'LaunchAgents'))).toBe(false);
    expect(existsSync(join(scratchHome, 'real', 'Library'))).toBe(false);
  });

  test('uninstall --home removes only the throwaway unit and never touches the machine label or unit', async () => {
    const accountHome = makeDir('ind-uninstall-account-');
    const scratchHome = makeDir('ind-uninstall-scratch-');
    const entry = makeEntry(scratchHome);
    const { calls, manager } = syntheticManager(accountHome);
    const program: ServiceProgram = { execPath: process.execPath, entry, roots: [] };

    const machine = manager.install(accountHome, program);
    expect(machine.ok).toBe(true);
    if (!machine.ok) return;
    const scratch = manager.install(scratchHome, program);
    expect(scratch.ok).toBe(true);
    if (!scratch.ok) return;

    const machineUnit = join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
    const scratchUnit = join(scratchHome, 'Library', 'LaunchAgents', `${derivedLabel(scratchHome)}.plist`);
    expect(existsSync(machineUnit)).toBe(true);
    expect(existsSync(scratchUnit)).toBe(true);
    const machineText = readFileSync(machineUnit, 'utf8');

    calls.splice(0);
    const io = testIo(scratchHome, { kind: 'owner' });
    const code = await runDaemon(['uninstall', '--home', scratchHome, '--json'], io, {
      home: accountHome,
      accountHome,
      service: manager,
    });
    expect(code).toBe(0);

    expect(existsSync(scratchUnit)).toBe(false);
    expect(existsSync(machineUnit)).toBe(true);
    expect(readFileSync(machineUnit, 'utf8')).toBe(machineText);
    const machineLabelToken = new RegExp(`io\\.floor\\.teamcli\\.daemon(?!\\.)`);
    for (const line of calls) {
      expect(line).not.toMatch(machineLabelToken);
    }
  });

  test('install --home for a throwaway home with a fresh mailbox heartbeat never retires a shuttle job', async () => {
    const accountHome = makeDir('ind-retire-account-');
    const scratchHome = makeDir('ind-retire-scratch-');
    const { root, entry } = makeProject(scratchHome);
    writeFreshMailboxHeartbeat(scratchHome);

    const { calls, manager } = syntheticManager(accountHome);
    const retired: string[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(['install', '--home', scratchHome, '--root', root, '--json'], io, {
      home: accountHome,
      accountHome,
      service: manager,
      program: { execPath: process.execPath, entry },
      health: async () => ANSWERING,
      sleep: async () => {},
      retireShuttle: (label) => {
        retired.push(label);
        return { ok: true };
      },
    });

    expect(io.err).toBe('');
    expect(code).toBe(0);
    expect(retired).toEqual([]);
    expect(existsSync(join(scratchHome, 'Library', 'LaunchAgents', `${derivedLabel(scratchHome)}.plist`))).toBe(true);
    expect(existsSync(join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`))).toBe(false);
    for (const line of calls) {
      expect(line).not.toContain('shuttle');
    }
  });

  test('the throwaway home unit sets HOME, TMPDIR and every XDG path into that home', () => {
    const accountHome = makeDir('ind-unit-account-');
    const scratchHome = makeDir('ind-unit-scratch-');
    const entry = makeEntry(scratchHome);
    const { manager } = syntheticManager(accountHome);
    const program: ServiceProgram = {
      execPath: process.execPath,
      entry,
      roots: [],
      path: '/opt/bun/bin:/usr/bin:/bin',
    };

    const installed = manager.install(scratchHome, program);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const unitPath = join(scratchHome, 'Library', 'LaunchAgents', `${derivedLabel(scratchHome)}.plist`);
    expect(installed.unitPath).toBe(unitPath);
    const text = readFileSync(unitPath, 'utf8');

    expect(text).toContain(`<string>${derivedLabel(scratchHome)}</string>`);
    const env: [string, string][] = [
      ['HOME', scratchHome],
      ['TMPDIR', join(scratchHome, 'tmp')],
      ['XDG_CONFIG_HOME', join(scratchHome, '.config')],
      ['XDG_DATA_HOME', join(scratchHome, '.local', 'share')],
      ['XDG_CACHE_HOME', join(scratchHome, '.cache')],
      ['XDG_STATE_HOME', join(scratchHome, '.local', 'state')],
    ];
    for (const [key, value] of env) {
      expect(text).toContain(`<key>${key}</key>\n    <string>${value}</string>`);
    }
    expect(text).not.toContain(`<string>${DAEMON_LABEL}</string>`);
    expect(text).not.toContain(accountHome);
    expect(existsSync(join(accountHome, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`))).toBe(false);

    const removed = manager.uninstall(scratchHome);
    expect(removed.ok).toBe(true);
    expect(existsSync(unitPath)).toBe(false);
  });
});

// A daemon install that can see a router heartbeat still leaves the shuttle units loaded
// while the router has no ask path: the child only answers a tick with a heartbeat. A
// heartbeat that is stale, or that is not a beat this daemon writes, is not fresh. The
// service manager and the health reading are the outer edge. Nothing is registered, stopped,
// or removed on a live machine.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { mailboxHeartbeatFresh } from '../src/daemon/mailbox/retire.ts';
import type { ServiceManager } from '../src/daemon/service.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T17:12:00.000Z');
const STALE = '2020-01-01T00:00:00.000Z';

const owned: string[] = [];

afterEach(() => {
  const paths = owned.splice(0);
  if (paths.length > 0) discardFixtures(paths, { roots: [join(paths[0] ?? '.', '..')] });
});

function place(): { scratch: string; root: string; home: string } {
  const scratch = fixtureBase('shuttle-hold-');
  owned.push(scratch);
  const root = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'init', '-q'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
session: scratch
operator: guide
workspace:
  mode: shared
seats:
  - role: coordinator
    name: guide
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  return { scratch, root, home };
}

function record(home: string, heartbeatAt: string): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  writeDaemonState(home, {
    format: 1,
    pid: process.pid,
    uid,
    since: NOW.toISOString(),
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: NOW.toISOString(),
    socket: daemonSocketPath(home),
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    mailbox: { heartbeatAt },
  });
}

function answered(home: string): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: join(home, 'never-opened.sock'),
    state: 'running',
    running: true,
    pid: 4242,
    uid: 1,
    since: NOW.toISOString(),
    startedBy: 'service-manager',
    version: 'test',
    gitHead: null,
    heartbeatAt: NOW.toISOString(),
    heartbeatSeconds: null,
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    why: null,
    probe: { state: 'answered', at: NOW.toISOString() },
  };
}

test('a present heartbeat does not stop or remove the shuttle units when no ask path exists', async () => {
  const { scratch, root, home } = place();
  const entry = join(scratch, 'entry.ts');
  writeFileSync(entry, '// never executed\n');
  const beat = new Date().toISOString();
  record(home, beat);
  expect(mailboxHeartbeatFresh(home)).toBe(true);
  const retired: string[] = [];
  const manager: ServiceManager = {
    kind: 'system-service-manager',
    unitPath: () => join(home, 'unit'),
    plan: (_home, program) => ({
      unitPath: join(home, 'unit'),
      program: [program.execPath, program.entry, 'daemon', 'run'],
    }),
    job: () => null,
    unit: () => null,
    install: () => ({ ok: true, unitPath: join(home, 'unit'), undo: () => {
      throw new Error('the install was not rolled back');
    } }),
    uninstall: () => { throw new Error('uninstall was not part of this scene'); },
    restart: () => { throw new Error('restart was not part of this scene'); },
    retireUnit: (_home, label) => {
      retired.push(label);
      return { ok: true };
    },
  };
  const io = testIo(root, { kind: 'owner' });
  io.env = { HOME: home, PATH: '/usr/bin:/bin' };
  const code = await runDaemon(['install', '--root', root], io, {
    home,
    accountHome: home,
    service: manager,
    program: { execPath: process.execPath, entry },
    now: () => NOW,
    sleep: async () => {},
    health: async () => answered(home),
    runtimeMigration: () => ({
      moved: [],
      alreadyMoved: [],
      held: [],
      refused: [],
      later: [],
      guardLines: [],
      complete: true,
      dryRun: false,
    }),
  });
  expect(code, io.out + io.err).toBe(0);
  expect(retired, io.out + io.err).toEqual([]);
});

test('a stale heartbeat and a foreign heartbeat are not fresh', () => {
  const stale = place();
  record(stale.home, STALE);
  expect(mailboxHeartbeatFresh(stale.home)).toBe(false);
  const foreign = place();
  record(foreign.home, 'other-daemon');
  expect(mailboxHeartbeatFresh(foreign.home)).toBe(false);
});

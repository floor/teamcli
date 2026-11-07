// The machine daemon's start admission, read from the system's service manager and its own record
// of the job.
// Every scene injects a synthetic manager: no scene starts a daemon, reads a real unit or runs a
// service-manager command. The record names a pid and a program; the unit is the file the daemon
// was started from; the daemon admits itself only when all three agree with this process.
//
// The refusal ids are the contract's (`contract/exit-codes.json`), but `daemon run` has no JSON
// face, so a scene reads the check's own sentence on stderr and the exit code.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon, type DaemonCommandSources } from '../src/commands/daemon.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import type {
  ServiceInstallResult,
  ServiceJobRecord,
  ServiceManager,
  ServiceProgram,
  ServiceUninstallResult,
  ServiceUnitRecord,
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-admission-')));
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

/** The record the manager keeps for a job it started: this process, run by its own executable. */
function managedJob(): ServiceJobRecord {
  return { pid: process.pid, program: process.execPath };
}

/** The unit the manager started this process from: the daemon's own label, the owner's file, and
 *  the launch words this process actually carries. */
function managedUnit(): ServiceUnitRecord {
  return {
    path: '/synthetic/Library/agents/daemon.plist',
    label: DAEMON_LABEL,
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: 0o600,
    programArguments: [process.execPath, ...process.argv.slice(1)],
  };
}

type ManagerOverrides = {
  job?: () => ServiceJobRecord | null;
  unit?: () => ServiceUnitRecord | null;
};

function fakeManager(over: ManagerOverrides): ServiceManager {
  return {
    kind: 'system-service-manager',
    unitPath: (home) => join(home, 'unit.plist'),
    plan: (_home, program: ServiceProgram) => ({ unitPath: '/synthetic/unit.plist', program: [program.execPath, program.entry] }),
    install: (): ServiceInstallResult => ({ ok: true, unitPath: '/synthetic/unit.plist' }),
    uninstall: (): ServiceUninstallResult => ({ ok: true, unitPath: '/synthetic/unit.plist', removed: true }),
    restart: () => { throw new Error('a restart is not part of this scene'); },
    job: over.job ?? (() => managedJob()),
    unit: over.unit ?? (() => managedUnit()),
  };
}

type StartInput = Parameters<NonNullable<DaemonCommandSources['start']>>[0];

type Run = { code: number; out: string; err: string; started: StartInput[] };

async function runWith(
  manager: ServiceManager,
  caller: Parameters<typeof testIo>[1],
  argv: string[] = [],
): Promise<Run> {
  const { root, home } = scratch();
  const io = testIo(root, caller);
  const started: StartInput[] = [];
  const code = await runDaemon(
    ['run', '--started-by', 'service-manager', '--root', root, ...argv],
    io,
    {
      home,
      accountHome: home,
      service: manager,
      start: async (input) => {
        started.push(input);
        return { kind: 'already-running', pid: 42 };
      },
    },
  );
  return { code, out: io.out, err: io.err, started };
}

const CHECK_PREFIX = "only the owner or the system's service manager starts the machine daemon: ";

describe('the daemon admits its own start from the service manager\'s record of the job', () => {
  test('a start the service manager placed under the installed unit is admitted', async () => {
    const ran = await runWith(fakeManager({}), { kind: 'owner-no-tty' });
    expect(ran.code, ran.err + ran.out).toBe(0);
    expect(ran.started.length).toBe(1);
    expect(ran.started[0]?.startedBy).toBe('service-manager');
  });

  test('the same binary run by hand from a seat is refused: the record names another pid', async () => {
    const ran = await runWith(
      fakeManager({ job: () => ({ pid: process.pid + 1, program: process.execPath }) }),
      { kind: 'seat', name: 'worker', pane: 'desk-1', session: 'acme' },
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record of the job does not name this process`);
    expect(ran.started.length).toBe(0);
  });

  test('a unit under another label is refused before the job record is consulted', async () => {
    const ran = await runWith(
      fakeManager({
        unit: () => ({ ...managedUnit(), label: 'example.other' }),
        job: () => {
          throw new Error('the job record was consulted before the unit was refused');
        },
      }),
      { kind: 'seat', name: 'worker', pane: 'desk-1', session: 'acme' },
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the unit file is not this daemon's own`);
    expect(ran.started.length).toBe(0);
  });

  test('a unit edited to add a flag is refused: its launch words are not this process\'s', async () => {
    const ran = await runWith(
      fakeManager({
        unit: () => ({ ...managedUnit(), programArguments: [process.execPath, ...process.argv.slice(1), '--presence'] }),
      }),
      { kind: 'owner-no-tty' },
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record and the unit do not run this executable with these words`);
    expect(ran.started.length).toBe(0);
  });

  test('a group-writable unit is refused', async () => {
    const ran = await runWith(
      fakeManager({ unit: () => ({ ...managedUnit(), mode: 0o620 }) }),
      { kind: 'owner-no-tty' },
    );
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the unit file is not this daemon's own`);
    expect(ran.started.length).toBe(0);
  });

  test('the owner\'s terminal start is admitted without reading the service manager', async () => {
    const ran = await runWith(
      fakeManager({
        job: () => {
          throw new Error('the owner start read the job record');
        },
        unit: () => {
          throw new Error('the owner start read the unit');
        },
      }),
      { kind: 'owner' },
    );
    expect(ran.code, ran.err + ran.out).toBe(0);
    expect(ran.started.length).toBe(1);
  });

  test('a manager that answers nothing refuses closed, never falling back to the process walk', async () => {
    const ran = await runWith(fakeManager({ job: () => null }), { kind: 'owner-no-tty' });
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`${CHECK_PREFIX}the record of the job does not name this process`);
    expect(ran.started.length).toBe(0);
  });
});

// A settled home, read by the current line: status, a dry-run up, the daemon's root load,
// and migrate. The team file, the approval, and a drop stay as they were. Nothing is closed,
// relaunched, deleted, or signed again.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { runStatus, standingSource } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { migrateRuntimeHome } from '../src/daemon/runtime-migration.ts';
import { runtimeKitsDir } from '../src/daemon/paths.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { recordTextOf, signedRecordOf, signRecord, verifyRecord } from '../src/send/record.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T17:00:00.000Z');
const SESSION = 'scratch';
const LEAD = 'guide';
const DROP_ID = '11111111-2222-4333-8444-555555555555';

let scratch = '';
let homeDir = '';

afterEach(() => {
  const paths = [scratch, homeDir].filter((path) => path !== '');
  if (paths.length > 0) {
    discardFixtures(paths, { roots: [scratch === '' ? shortSocketBase() : join(scratch, '..'), shortSocketBase()] });
  }
  scratch = '';
  homeDir = '';
});

function bytes(path: string): string {
  return readFileSync(path, 'utf8');
}

function tree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    try {
      const text = readFileSync(path, 'utf8');
      out[rel] = text;
    } catch {
      const nested = tree(path, rel);
      Object.assign(out, nested);
    }
  }
  return out;
}

test('a settled home is read without closing, relaunching, deleting, or signing again', async () => {
  scratch = fixtureBase('upgrade-0514-');
  homeDir = mkdtempSync(join(shortSocketBase(), 'upg-'));
  const home = join(homeDir, 'h');
  const root = join(scratch, 'repo');
  const agents = join(root, '.agents');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(agents, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const text = `format: 1
project: acme
session: ${SESSION}
coordinator: ${LEAD}
operator: ${LEAD}
workspace:
  mode: shared
  base: main
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: example
    model: Example
    version: "1"
    launch: claude
`;
  writeFileSync(join(agents, 'team.yaml'), text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { home });
  expect(loaded.ok, JSON.stringify(loaded.ok ? '' : loaded.errors)).toBe(true);
  if (!loaded.ok) return;
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  const dropDir = join(agents, 'send-drops', SESSION, LEAD);
  mkdirSync(dropDir, { recursive: true });
  const signed = signRecord({
    kind: 'message',
    id: DROP_ID,
    to: LEAD,
    to_id: null,
    root: loaded.root,
    session: SESSION,
    at: NOW.toISOString(),
    body: 'from guide — admitted by: a seat of its own team\n\nkept',
    from: LEAD,
    from_id: null,
    rule: 'a seat of its own team',
    thread: DROP_ID,
  }, home);
  writeFileSync(join(dropDir, DROP_ID), recordTextOf(signed), { mode: 0o600 });
  const kit = join(runtimeKitsDir(home), 'lead-810');
  mkdirSync(kit, { recursive: true, mode: 0o700 });
  writeFileSync(join(kit, 'kept'), 'kept\n', { mode: 0o600 });

  const approvalPath = join(storePath(loaded.team.project, loaded.root, home), 'approval.json');
  const beforeAgents = tree(agents);
  const beforeApproval = bytes(approvalPath);
  const beforeKit = bytes(join(kit, 'kept'));
  const mutations: string[] = [];

  const doctor: DoctorSources = {
    version: () => '1',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
  const launch: Launch = {
    sessionState: () => null,
    startServer: () => {
      mutations.push('start');
      return false;
    },
    sessionUp: () => false,
    createWorkspace: () => {
      mutations.push('workspace');
      return null;
    },
    paneRun: () => {
      mutations.push('run');
      return false;
    },
    renameAgent: () => {
      mutations.push('rename');
      return false;
    },
    closeWorkspace: () => {
      mutations.push('close');
      return false;
    },
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => [],
    sleep: async () => {},
    now: () => NOW,
  };
  const up: UpSources = {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: () => NOW,
    sleep: async () => {},
    doctor,
    launch,
    sockets: join(scratch, 'sockets'),
    terminal: () => ({ key: async () => 'eof', drain() {} }),
  };

  const status = testIo(root, { kind: 'owner' });
  const statusCode = await runStatus([], status, {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
    branch: () => 'main',
    standing: standingSource(home),
    now: () => NOW,
    home,
    alive: () => false,
  });
  expect(statusCode, status.out + status.err).toBe(1);
  expect(status.out).toContain('is not running');
  expect(status.out).not.toContain('closed');

  const dry = testIo(root, { kind: 'owner' });
  const dryCode = await runUp(['--dry-run'], dry, up);
  expect(dryCode, dry.out + dry.err).toBe(0);
  expect(dry.out).toContain('dry run');

  mkdirSync(join(scratch, 'sockets'), { recursive: true });
  const sweeps: string[] = [];
  const started = await startMachineDaemon({
    home,
    roots: [loaded.root],
    startedBy: 'manual',
    version: 'test',
    now: () => NOW,
    heartbeatMs: 60_000,
    restoreRetryBudgetMs: 0,
    restoreSweep: async () => {
      sweeps.push('asked');
      return { kind: 'no-recorded-session' };
    },
    sendStart: async () => ({ kind: 'already-running', socketPath: join(homeDir, 'send.sock'), pid: null }),
    initialBusStart: async () => ({
      kind: 'serving',
      cleared: false,
      handle: {
        close: async () => {},
        reconcileNow: async () => [],
        firstPass: () => ({ running: false, scanned: 0, doneAt: NOW.toISOString(), errors: false }),
      },
    }),
  });
  expect(started.kind).toBe('serving');
  if (started.kind === 'serving') {
    expect(started.daemon.roots.some((row) => row.root === loaded.root)).toBe(true);
    await started.daemon.close();
  }
  expect(sweeps).toEqual(['asked']);

  const migrate = testIo(root, { kind: 'owner' });
  const migrateCode = await runMigrate(['--dry-run'], migrate, { home, now: () => NOW });
  expect(migrateCode, migrate.out + migrate.err).toBe(0);
  const kits = migrateRuntimeHome(home, { now: () => NOW, loadedPrograms: () => [], guardDirsNamed: () => [] });
  expect(kits.moved).toEqual([]);
  expect(kits.alreadyMoved).toContain('lead-810');

  const afterAgents = tree(agents);
  for (const [name, text] of Object.entries(beforeAgents)) expect(afterAgents[name], name).toBe(text);
  expect(Object.keys(afterAgents).filter((name) => beforeAgents[name] === undefined)).toEqual(['team.state.json']);
  expect(bytes(approvalPath)).toBe(beforeApproval);
  expect(bytes(join(kit, 'kept'))).toBe(beforeKit);
  expect(mutations).toEqual([]);
  const drop = signedRecordOf(JSON.parse(bytes(join(dropDir, DROP_ID))));
  expect(drop).not.toBeNull();
  if (drop === null) return;
  expect(verifyRecord(drop, messageKeyOf(home))).toBe(true);
  expect(drop.payload.body).toContain('kept');
});

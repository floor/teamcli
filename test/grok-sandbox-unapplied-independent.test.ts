// A Grok seat whose launch frames show that the sandbox could not be applied is recorded
// stopped in its state, and its workspace is closed with no key typed. The team file stays
// byte for byte as it was. The same words are what team status and team check show. A frame
// after a ready prompt has ended the launch wait is left alone. The pane host is the outer edge.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, recordRenames, testIo } from './helpers.ts';

const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.70/idle.txt', import.meta.url), 'utf8');
const NOW = new Date('2026-11-06T21:30:00Z');
const SESSION = 'sandbox';
const SEAT = 'scout';
const WAIT_MS = 90_000;
const LINE = 'warning: sandbox could not be applied: the profile was not there';
const SHOWN = `stopped: sandbox could not be applied`;

type When = 'first' | 'later' | 'none' | 'bound' | 'after';

let scratch = '';
const ambient = process.env.GROK_HOME;

afterEach(() => {
  if (ambient === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = ambient;
  if (scratch !== '') discardFixtures([scratch], { roots: [dirname(scratch)] });
  scratch = '';
});

function warned(): string {
  return `${LINE}\n`;
}

function scene(when: When): {
  root: string;
  home: string;
  file: string;
  sources: UpSources;
  typed: string[];
  closed: string[];
  frames: () => number;
  settle: () => void;
} {
  scratch = fixtureBase('grok-sandbox-unapplied');
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  const own = join(scratch, 'own-scout');
  const grok = join(home, '.grok');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(grok, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true });
  mkdirSync(own, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q'], {
    cwd: own, env: gitEnv(),
  });
  process.env.GROK_HOME = grok;
  const text = `format: 1
project: acme
session: ${SESSION}
coordinator: captain
operator: captain
workspace:
  mode: shared
  base: main
trust:
  - .
  - ../own-scout
seats:
  - role: coordinator
    name: captain
    label: captain
    cli: codex
    vendor: test
    model: "GPT Terra"
    version: "5.6"
    launch: codex
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: grok
    vendor: test
    model: "Grok"
    version: "4.7"
    launch: grok
    cwd: ../own-scout
`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode: 0o600 });
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );

  const typed: string[] = [];
  const closed: string[] = [];
  let clock = NOW.getTime();
  let seatPane = '';
  let ranAt: number | null = null;
  let reads = 0;
  let settled = false;
  const launch: Launch = {
    sessionState: () => (ranAt === null ? 'absent' : 'running'),
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = label === SEAT ? 'fixture-pane-one' : 'fixture-pane-two';
      if (label === SEAT) seatPane = pane;
      return { pane, workspace: label === SEAT ? 'fixture-ws-scout' : 'fixture-ws-other' };
    },
    paneRun(_session, pane, command) {
      if (pane === seatPane && command.includes('grok')) ranAt = clock;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      if (workspace === 'fixture-ws-scout') closed.push(workspace);
      return true;
    },
    agentPanes: () => [],
    agents: () => [],
    workspacePanes: () => ['fixture-pane-one'],
    paneText(_session, pane) {
      if (pane !== seatPane) return GROK_IDLE;
      if (ranAt === null) return 'grok starting\n';
      reads += 1;
      const elapsed = clock - ranAt;
      if (when === 'none') return GROK_IDLE;
      if (when === 'first') return warned();
      if (when === 'later') return reads <= 3 && elapsed < WAIT_MS ? 'grok starting\n' : warned();
      if (when === 'bound') return elapsed >= WAIT_MS ? warned() : 'grok starting\n';
      return settled ? warned() : GROK_IDLE;
    },
    foreground: () => ['grok'],
    typeText(_session, pane, text) {
      if (pane === seatPane) typed.push(text);
      return true;
    },
    pressEnter(_session, pane) {
      if (pane === seatPane) typed.push('Enter');
      return true;
    },
    sendKey(_session, pane, key) {
      if (pane === seatPane) typed.push(key);
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  recordRenames(launch);
  const doctor: DoctorSources = {
    version: () => '1.0.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.0.0',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
  const sources: UpSources = {
    sessionRunning: () => true,
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    doctor,
    launch,
    sockets: join(scratch, 'no-sockets'),
  };
  return {
    root, home, file, sources, typed, closed,
    frames: () => reads,
    settle: () => { settled = true; },
  };
}

function reports(root: string, home: string, file: string): { status: string; check: string } {
  const standing = () => approvalStanding(root, home);
  const live = () => ({ running: false, agents: [], workspaces: [], screens: {} });
  const statusIo = testIo(root, { kind: 'owner' });
  runStatus(['--all', '--file', file], statusIo, {
    live,
    branch: () => 'main',
    standing,
    now: () => NOW,
    home,
    alive: () => false,
  });
  const checkIo = testIo(root, { kind: 'owner' });
  runTeamCheck({ file }, checkIo, {
    live,
    branch: () => 'main',
    standing,
    now: () => NOW,
    home,
    alive: () => false,
    sockets: join(scratch, 'no-sockets'),
  });
  return { status: statusIo.out + statusIo.err, check: checkIo.out + checkIo.err };
}

function seatRecord(root: string): string {
  return JSON.stringify(readState(join(root, '.agents')).sessions[SESSION]?.seats[SEAT] ?? null);
}

test('the line in the first launch frame stops the seat and closes its workspace', async () => {
  const made = scene('first');
  const before = readFileSync(made.file);
  const io = testIo(made.root, { kind: 'owner' });
  await runUp(['--file', made.file], io, made.sources);
  expect(readFileSync(made.file)).toEqual(before);
  expect(seatRecord(made.root)).toContain('sandbox_unapplied');
  expect(made.closed).toEqual(['fixture-ws-scout']);
  expect(made.typed).toEqual([]);
  const said = reports(made.root, made.home, made.file);
  expect(said.status).toContain(SHOWN);
  expect(said.check).toContain(SHOWN);
});

test('the line in a later frame within the launch wait stops the seat the same way', async () => {
  const made = scene('later');
  const before = readFileSync(made.file);
  const io = testIo(made.root, { kind: 'owner' });
  await runUp(['--file', made.file], io, made.sources);
  expect(readFileSync(made.file)).toEqual(before);
  expect(seatRecord(made.root)).toContain('sandbox_unapplied');
  expect(made.closed).toEqual(['fixture-ws-scout']);
  expect(made.typed).toEqual([]);
  const said = reports(made.root, made.home, made.file);
  expect(said.status).toContain(SHOWN);
  expect(said.check).toContain(SHOWN);
});

test('a launch with no such line is not stopped and nothing is typed', async () => {
  const made = scene('none');
  const before = readFileSync(made.file);
  const io = testIo(made.root, { kind: 'owner' });
  await runUp(['--file', made.file], io, made.sources);
  expect(readFileSync(made.file)).toEqual(before);
  expect(seatRecord(made.root)).not.toContain('sandbox_unapplied');
  expect(made.closed).toEqual([]);
  expect(made.typed).toEqual([]);
  const said = reports(made.root, made.home, made.file);
  expect(said.status).not.toContain(SHOWN);
  expect(said.check).not.toContain(SHOWN);
  expect(made.frames()).toBeGreaterThan(0);
  expect(seatRecord(made.root)).not.toBe('null');
  expect(seatRecord(made.root)).toContain('fixture-pane-one');
});

test('the line drawn at the launch wait bound stops the seat', async () => {
  const made = scene('bound');
  const before = readFileSync(made.file);
  const io = testIo(made.root, { kind: 'owner' });
  await runUp(['--file', made.file], io, made.sources);
  expect(readFileSync(made.file)).toEqual(before);
  expect(seatRecord(made.root)).toContain('sandbox_unapplied');
  expect(made.closed).toEqual(['fixture-ws-scout']);
  expect(made.typed).toEqual([]);
  const said = reports(made.root, made.home, made.file);
  expect(said.status).toContain(SHOWN);
  expect(said.check).toContain(SHOWN);
});

test('the line drawn after the launch wait ended is not acted on and nothing is typed', async () => {
  const made = scene('after');
  const before = readFileSync(made.file);
  const io = testIo(made.root, { kind: 'owner' });
  await runUp(['--file', made.file], io, made.sources);
  const seen = made.frames();
  made.settle();
  expect(made.frames()).toBe(seen);
  expect(readFileSync(made.file)).toEqual(before);
  expect(seatRecord(made.root)).not.toContain('sandbox_unapplied');
  expect(made.closed).toEqual([]);
  expect(made.typed).toEqual([]);
  const said = reports(made.root, made.home, made.file);
  expect(said.status).not.toContain('sandbox could not be applied');
  expect(said.check).not.toContain('sandbox could not be applied');
  expect(seen).toBeGreaterThan(0);
  expect(seatRecord(made.root)).not.toBe('null');
  expect(seatRecord(made.root)).toContain('fixture-pane-one');
});

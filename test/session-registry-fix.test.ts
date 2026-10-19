// The registry behaviour the live-session fix turns on: a seat this run leaves short of ready
// because it is held at a dialog keeps the record its launch wrote (only a real stop ends it),
// a drift repair closes the old record as a swap and links its successor, and a CLI that takes
// no session id and is relaunched in its pane starts a new linked session — never the old one.
// The negative controls are the same rule's other side: a stopped seat still ends its open
// record, and the same launch reported twice writes nothing.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runSessions } from '../src/commands/sessions.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import { beginSession, SESSIONS_FILE, readStoreSessions } from '../src/sessions/registry.ts';
import { readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');
const OWNER = { kind: 'owner' as const };
const PERMISSION = readFileSync(join(import.meta.dir, 'fixtures/codex/0.157.0/permission.txt'), 'utf8');
const CODEX_IDLE = readFileSync(join(import.meta.dir, 'fixtures/codex/0.157.0/idle.txt'), 'utf8');

function teamYaml(root: string, home: string, held: boolean): string {
  return `format: 1
project: acme
entity: acme-entity
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${home}/.config/team/lobbies/acme-entity
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
${held ? `  - role: implementer
    name: held
    cli: codex
    vendor: openai
    model: GPT Terra
    version: "5.6"
    launch: codex -m gpt-5.6-terra
` : ''}  - role: implementer
    name: retired
    stopped: true
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
}

type Fixture = { base: string; root: string; home: string; dir: string; team: TeamFile };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `held: false` leaves the codex seat out: its rules are typed into the pane (a first-message
 *  CLI), and the drift and stopped-seat scenes need only the two Claude seats reaching ready. */
function makeFixture(opts: { held?: boolean } = {}): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-session-fix-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, teamYaml(root, home, opts.held !== false));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
  return { base, root, home, dir, team: loaded.team };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

type Slot = { name: string | null; workspace: string; running: boolean; box: string; cli: string };

type World = {
  launch: Launch;
  slots: Map<string, Slot>;
  procs: Map<string, PaneProcesses>;
  runs: { pane: string; command: string }[];
  session: { state: 'absent' | 'running' };
  /** `up` reads an empty agent list as on a machine whose herdr has none yet; scenes that start
   *  from recorded seats turn it on so herdr lists what the launch left. */
  reporting: { on: boolean };
  /** The screen a seat's launch draws: the seat name is known by the time the line runs. */
  screens: Map<string, string>;
};

function makeWorld(root: string): World {
  const slots = new Map<string, Slot>();
  const procs = new Map<string, PaneProcesses>();
  const runs: { pane: string; command: string }[] = [];
  const session: { state: 'absent' | 'running' } = { state: 'absent' };
  const reporting = { on: false };
  // The codex seat's launch line names no model, so its idle prompt is the screen a capture
  // gives it; a scene that wants it held at a dialog draws that dialog instead.
  const screens = new Map<string, string>([['held', CODEX_IDLE]]);
  let n = 0;
  const agents = (): HerdrAgent[] => (reporting.on ? [...slots]
    .filter(([, slot]) => slot.running)
    .map(([pane, slot]) => ({
      name: slot.name ?? pane,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle',
      cwd: root,
    })) : []);
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    for (const [pane, slot] of slots) {
      if (slot.workspace !== workspace) continue;
      slots.delete(pane);
      procs.delete(pane);
    }
    return true;
  };
  const screenFor = (command: string): string => {
    const named = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(command);
    if (!named) return CLAUDE_IDLE;
    const family = named[1] === 'opus' ? 'Opus' : 'Sonnet';
    return CLAUDE_IDLE.split('Opus 5.5').join(`${family} ${named[2]}.${named[3]}`);
  };
  const launch: Launch = {
    sessionState: () => session.state,
    startServer() {
      session.state = 'running';
      return true;
    },
    sessionUp: () => session.state === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      slots.set(pane, { name: null, workspace: `w${n}`, running: false, box: claudeBox(''), cli: 'zsh' });
      procs.set(pane, { shell: 100 + n, foreground: [101 + n] });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const slot = slots.get(pane);
      if (slot) {
        slot.running = true;
        // The line may start with the run's own environment assignments; the CLI is the first
        // word after them.
        slot.cli = command.split(' ').find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? 'zsh';
        slot.box = (slot.name !== null ? screens.get(slot.name) : undefined) ?? screenFor(command);
      }
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = slots.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => [...slots.keys()],
    workspacePanes: (_session, workspace) => [...slots]
      .filter(([, slot]) => slot.workspace === workspace)
      .map(([pane]) => pane),
    agents,
    processInfo: (_session, pane) => procs.get(pane) ?? null,
    paneText: (_session, pane) => {
      const slot = slots.get(pane);
      return slot?.running ? slot.box : '';
    },
    foreground: (_session, pane) => {
      const slot = slots.get(pane);
      return slot?.running ? [slot.cli] : ['zsh'];
    },
    sleep: async () => {},
    now: () => NOW,
  };
  return { launch, slots, procs, runs, session, reporting, screens };
}

function upSources(fixture: Fixture, world: World, terminal?: Terminal): UpSources {
  return {
    sessionRunning: () => world.session.state === 'running',
    sessionState: () => world.session.state,
    agents: () => world.launch.agents('acme'),
    workspaces: () => [...world.slots.values()].map((slot) => ({ id: slot.workspace, label: '' })),
    home: fixture.home,
    doctor: doctor(fixture.home),
    launch: world.launch,
    now: () => NOW,
    ...(terminal === undefined ? {} : { terminal: () => terminal }),
  };
}

function storeOf(fixture: Fixture): string {
  return storePath('acme', fixture.root, fixture.home);
}

function registryPath(fixture: Fixture): string {
  return join(storeOf(fixture), SESSIONS_FILE);
}

function recordsOf(fixture: Fixture) {
  const read = readStoreSessions(storeOf(fixture), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions;
}

function seatOf(fixture: Fixture, name: string) {
  const seat = fixture.team.seats.find((one) => one.name === name);
  if (!seat) throw new Error(`the fixture has no seat ${name}`);
  return seat;
}

/** A screen that answers nothing: the owner's terminal is there and no key ever arrives. */
function silentTerminal(): Terminal {
  return {
    drain() {},
    async key() {
      return 'timeout';
    },
  };
}

describe('a launch held at a dialog keeps the record its launch wrote', () => {
  test('up times out at the permission dialog and the open record is never ended', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    // The codex seat draws its permission dialog and never reaches a prompt; the two Claude
    // seats reach theirs. No key ever reaches the owner's terminal.
    world.screens.set('held', PERMISSION);

    const io = testIo(fixture.root, OWNER);
    const code = await runUp([], io, upSources(fixture, world, silentTerminal()));
    expect(code, io.out + io.err).toBe(1);
    expect(io.out + io.err).toContain('held: left out: timed out after 90 s waiting for an answer; left as it is');

    // The state this run left says the seat is launched and held, not ready.
    const state = readState(fixture.dir).sessions.acme;
    expect(state?.seats.held).toMatchObject({
      stage: 'launched',
      pane: 'w3:p1',
      workspace: 'w3',
      waiting: { state: 'waiting-owner', classification: 'permission' },
    });
    expect(state?.seats.lead?.stage).toBe('ready');
    expect(state?.seats.worker?.stage).toBe('ready');

    // The registry keeps the seat's one launch record open: the process still fills it, and
    // nothing this run did ended it. The codex launch carries no CLI session id.
    const records = recordsOf(fixture);
    expect(records.map((record) => [record.seat, record.ended])).toEqual([
      ['lead', undefined],
      ['worker', undefined],
      ['held', undefined],
    ]);
    const held = records.find((record) => record.seat === 'held');
    expect(held).toMatchObject({ pane: 'w3:p1', workspace: 'w3', cli: 'codex', lab: 'openai' });
    expect(held?.cli_session).toBeUndefined();
    expect(held?.resumable).toBeUndefined();
    expect(held?.reason).toBeUndefined();
  });

  test('a stopped seat is the exception: its open record still ends', async () => {
    const fixture = makeFixture({ held: false });
    const world = makeWorld(fixture.root);
    // A record left open for the seat the file now stops: the file is the truth this run reads.
    const began = beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme',
      seat: seatOf(fixture, 'retired'),
      pane: 'w9:p1',
      workspace: 'w9',
      cli_session: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      now: NOW,
    });
    if ('note' in began) throw new Error(began.note);

    const io = testIo(fixture.root, OWNER);
    expect(await runUp([], io, upSources(fixture, world)), io.out + io.err).toBe(0);

    const retired = recordsOf(fixture).filter((record) => record.seat === 'retired');
    expect(retired).toHaveLength(1);
    expect(retired[0]?.reason).toBe('owner-stop');
    expect(retired[0]?.ended).toBeDefined();
    // The file stops it, so it is never launched: no second record, no pane, no workspace.
    expect(retired[0]?.pane).toBe('w9:p1');
    expect([...world.slots.values()].flatMap((slot) => slot.name === null ? [] : [slot.name])).toEqual(['lead', 'worker']);
    expect(readState(fixture.dir).sessions.acme?.seats.retired).toBeUndefined();
  });
});

describe('a drift repair closes as a swap and links the new record', () => {
  test('up finds the running model different from the file, relaunches, and links the two', async () => {
    const fixture = makeFixture({ held: false });
    const world = makeWorld(fixture.root);
    // A running session with the worker's pane showing the model the file does not declare:
    // the file says Sonnet, the pane says Opus.
    world.session.state = 'running';
    world.reporting.on = true;
    world.slots.set('w0:p1', { name: 'worker', workspace: 'w0', running: true, box: CLAUDE_IDLE, cli: 'claude' });
    world.procs.set('w0:p1', { shell: 100, foreground: [101] });
    updateState(fixture.dir, (state) => {
      state.sessions.acme = {
        seats: {
          worker: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', launched: { shell: 100, cli: [101] } },
        },
        worktrees: {},
        watch: { pid: 999, heartbeat: NOW.toISOString() },
      };
    });
    const began = beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme',
      seat: seatOf(fixture, 'worker'),
      pane: 'w0:p1',
      workspace: 'w0',
      cli_session: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      now: NOW,
    });
    if ('note' in began) throw new Error(began.note);

    const io = testIo(fixture.root, OWNER);
    expect(await runUp([], io, upSources(fixture, world)), io.out + io.err).toBe(0);
    expect(io.out + io.err).toContain('its model drifted; closed without input and launched again');

    const workerRecords = recordsOf(fixture).filter((record) => record.seat === 'worker');
    expect(workerRecords).toHaveLength(2);
    const [old, next] = workerRecords;
    expect(old?.id).toBe(began.id);
    expect(old).toMatchObject({ pane: 'w0:p1', reason: 'swap', next: next?.id });
    expect(old?.ended).toBeDefined();
    // A swap is a close the run made on purpose: it carries no crash note.
    expect(old?.note).toBeUndefined();
    expect(next).toMatchObject({ previous: old?.id });
    expect(next?.ended).toBeUndefined();
    expect(next?.pane).not.toBe('w0:p1');
    expect(next?.model).toBe('Claude Sonnet');
    // The seeded pane is gone; the seat is ready on its new one.
    expect(world.slots.has('w0:p1')).toBe(false);
    expect(readState(fixture.dir).sessions.acme?.seats.worker).toMatchObject({
      stage: 'ready',
      pane: next?.pane,
      workspace: next?.workspace,
    });
  });
});

describe('an id-less relaunch in the same pane is a new linked session', () => {
  test('two launches with no CLI session id are two records, the old one a crash with its note', async () => {
    const fixture = makeFixture();
    const worker = seatOf(fixture, 'worker');
    const first = beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme',
      seat: worker,
      pane: 'w7:p1',
      workspace: 'w7',
      now: NOW,
    });
    const second = beginSession({
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme',
      seat: worker,
      pane: 'w7:p1',
      workspace: 'w7',
      now: NOW,
    });
    if ('note' in first || 'note' in second) throw new Error('the registry refused a record');
    expect(second.id).not.toBe(first.id);

    const records = recordsOf(fixture);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      seat: 'worker',
      pane: 'w7:p1',
      reason: 'crash',
      note: 'a new launch found this session open',
      next: second.id,
    });
    expect(records[1]).toMatchObject({ id: second.id, previous: first.id });
    expect(records[1]?.ended).toBeUndefined();
    expect(records[1]?.reason).toBeUndefined();

    // The listing reads the same two records and the chain from both sides.
    const io = testIo(fixture.root, OWNER);
    expect(await runSessions(['--json'], io, { home: fixture.home, now: () => NOW })).toBe(0);
    const payload = JSON.parse(io.out) as {
      sessions: { id: string; previous?: string; next?: string; ended: string | null; reason: string | null; note?: string }[];
    };
    expect(payload.sessions).toHaveLength(2);
    const listedFirst = payload.sessions.find((record) => record.id === first.id);
    const listedSecond = payload.sessions.find((record) => record.id === second.id);
    expect(listedFirst).toMatchObject({ next: second.id, reason: 'crash', note: 'a new launch found this session open' });
    expect(listedFirst?.ended).not.toBeNull();
    expect(listedSecond).toMatchObject({ previous: first.id, ended: null, reason: null });
  });

  test('the same defined id on the same pane is the same launch: nothing is written', () => {
    const fixture = makeFixture();
    const worker = seatOf(fixture, 'worker');
    const input = {
      home: fixture.home,
      root: fixture.root,
      team: fixture.team,
      session: 'acme' as const,
      seat: worker,
      pane: 'w7:p1',
      workspace: 'w7',
      cli_session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      now: NOW,
    };
    const first = beginSession(input);
    const before = readFileSync(registryPath(fixture), 'utf8');
    const again = beginSession(input);
    if ('note' in first || 'note' in again) throw new Error('the registry refused a record');

    expect(again.id).toBe(first.id);
    expect(readFileSync(registryPath(fixture), 'utf8')).toBe(before);
    expect(recordsOf(fixture)).toHaveLength(1);

    // The pane is half of the rule: the same id on another pane is a new session, the old one
    // ended as a crash because this caller did not say why it replaced it.
    const elsewhere = beginSession({ ...input, pane: 'w8:p1', workspace: 'w8' });
    if ('note' in elsewhere) throw new Error(elsewhere.note);
    expect(elsewhere.id).not.toBe(first.id);
    const records = recordsOf(fixture);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: first.id, reason: 'crash', next: elsewhere.id });
    expect(records[1]).toMatchObject({ previous: first.id, pane: 'w8:p1' });
    expect(records[1]?.ended).toBeUndefined();
  });
});

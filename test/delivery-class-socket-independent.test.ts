// Independent scenes for the delivery-class lane (0.6, fix/delivery-class-socket-proof), written
// from the lane brief and the source, never from the builder's own tests.
//
// The class counts a cross-session socket only while the seat's pane still carries it. A caller
// that reads the pane (the idle dispatcher here) passes the pane's processes, so a recorded
// address whose pid the pane no longer runs is no evidence; a caller that cannot read the pane
// keeps the conservative rule, where a recorded address that still exists counts. The pane's own
// processes are also how a socket is discovered when the registry recorded no address — and the
// registry's record only speaks for the session it names. Where the class is not push, the idle
// dispatcher spends no attempt on the seat.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import { dispatchIdleWork, forgetIdleEpisodes, type IdleDispatchInput, type WorkPush } from '../src/watch/dispatch.ts';

const CREW = `format: 1
project: acme-web
entity: acme
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker-2
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const MIN = 60_000;
const D_NOW = Date.parse('2026-10-20T03:00:00Z');
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

/** Pids no real session holds: the recorded socket's own pid and one the pane never runs. */
const PANE_A = 'fixture-pane-a';
const PANE_B = 'fixture-pane-b';
const SHELL_PID = 9_910_201;
const SOCKET_PID = 9_910_202;
const OTHER_PID = 9_910_203;

let base: string;
let root: string;
let entityRoot: string;
let home: string;
let seeded: SessionState | undefined;

afterEach(() => {
  forgetIdleEpisodes();
  if (base) rmSync(base, { recursive: true, force: true });
});

function crewTeam(): TeamFile {
  const checked = validateTeamFile(CREW);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

/** The crew's root, the entity's own root and a home whose registry names both. */
function crewScratch(): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delivery-socket-')));
  root = join(base, 'crew');
  entityRoot = join(base, 'entity');
  home = join(base, 'home');
  seeded = undefined;
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  upsertTeam(home, teamIdOf(root), {
    project: 'acme-web',
    entity: 'acme',
    session: 'crew',
    root,
    roster: [{ agent: 'agt_crew000000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: entityRoot,
    roster: [{ agent: 'agt_head000000', seat: 'head-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
}

/** The generated hook settings file a TeamCLI launch leaves, backdated so a socket written after
 *  it is the newer of the two and reads live. */
function declare(seat: string, secondsAgo = 120): string {
  const path = cliHookSettingsPath(join(root, '.agents'), 'crew', seat);
  if (path === null) throw new Error('the fixture session has no generated settings path');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '{"crossSessionInbound":"accept"}\n');
  const past = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, past, past);
  return path;
}

function socketFor(pid: number): string {
  const path = join(base, 'sock', `${pid}.sock`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

/** The registry record a launch leaves for one worker: its reach address in its pane. */
function record(seat: string, pane: string, address: string | null, session = 'crew'): void {
  registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(root), seat, session, pane, address },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

/** The crew's two workers, idle, each with the pane a push would be typed into. A scene that
 *  names a process reading hands in the pane map the watch read. */
function live(processes?: Record<string, { shell: number; foreground: number[] }>): IdleDispatchInput['live'] {
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, space, pane] of [
    ['worker-1', 'fixture-a', PANE_A],
    ['worker-2', 'fixture-b', PANE_B],
  ] as const) {
    agents.push({ name, agent: 'claude', pane, workspace: space, status: 'idle', cwd: null });
    screens[pane] = idleScreen;
  }
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens,
    ...(processes === undefined ? {} : { processes }),
  };
}

function crewState(stamp: string): SessionState {
  const state = emptySession();
  for (const seat of ['worker-1', 'worker-2']) state.seats[seat] = { stage: 'ready', last_active: stamp };
  return state;
}

/** One dispatcher pass. A pass that only moves the clock leaves the state file — claims
 *  included — as the previous pass wrote it; a new snapshot object reseeds it. */
function idleInput(extra: Partial<IdleDispatchInput> = {}): IdleDispatchInput {
  const team = extra.team ?? crewTeam();
  const wanted = extra.state ?? crewState(new Date(D_NOW - 10 * MIN).toISOString());
  if (wanted !== seeded) {
    writeFileSync(
      join(root, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { [team.session]: wanted } }, null, 2)}\n`,
    );
    seeded = wanted;
  }
  // The pass snapshot is the file's session, as the watch reads it fresh each pass.
  const state = readState(join(root, '.agents')).sessions[team.session] ?? emptySession();
  const built: IdleDispatchInput = {
    root,
    dir: join(root, '.agents'),
    team,
    state,
    live: live(),
    now: new Date(D_NOW),
    home,
    body: (seat: string) => `body for ${seat}`,
    ...extra,
  };
  built.state = state;
  built.dir = join(root, '.agents');
  return built;
}

/** A takeable open record, so the pass reaches the push gate at all. */
function openQueue(): void {
  writeFileSync(join(root, '.agents', 'queue.yaml'), '- id: t1\n  title: the open task\n');
}

/** The socket class the worker scenes read: generated settings declare accept, the registry
 *  names a live socket in the pane. */
function socketWorker(): string {
  declare('worker-1');
  const socket = socketFor(SOCKET_PID);
  record('worker-1', PANE_A, socket);
  return socket;
}

/** The mark the box leaves when it held the last socket frame: the declaration in force. */
function holdWorker(): void {
  const dir = join(root, '.agents');
  const declaration = declaredInboundOf({ dir, root, session: 'crew', seat: 'worker-1', launch: 'claude' });
  recordHeldSocket(heldSocketPath(dir, 'crew', 'worker-1'), declaration, new Date(D_NOW - MIN));
}

describe('a socket the pane no longer owns earns no attempt', () => {
  test('a held seat is not pushed', async () => {
    crewScratch();
    openQueue();
    socketWorker();
    holdWorker();
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const pass = await dispatchIdleWork(idleInput({
      push,
      state: crewState(new Date(D_NOW - 10 * MIN).toISOString()),
      live: live({ [PANE_A]: { shell: SHELL_PID, foreground: [SOCKET_PID] } }),
    }));
    expect(pass.pushed).toEqual([]);
  });

  test('a recorded address whose pid the pane no longer runs is not pushed', async () => {
    crewScratch();
    openQueue();
    socketWorker();
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const pass = await dispatchIdleWork(idleInput({
      push,
      state: crewState(new Date(D_NOW - 10 * MIN).toISOString()),
      live: live({ [PANE_A]: { shell: SHELL_PID, foreground: [OTHER_PID] } }),
    }));
    expect(pass.pushed).toEqual([]);
  });

  test('the pane that still runs the recorded socket is pushed (control)', async () => {
    crewScratch();
    openQueue();
    socketWorker();
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const pass = await dispatchIdleWork(idleInput({
      push,
      state: crewState(new Date(D_NOW - 10 * MIN).toISOString()),
      live: live({ [PANE_A]: { shell: SHELL_PID, foreground: [SOCKET_PID] } }),
    }));
    expect(pass.pushed).toEqual([{ seat: 'worker-1', ok: true, outcome: 'typed (unconfirmed)' }]);
  });

  test('a pass with no process reading keeps the conservative rule (control)', async () => {
    crewScratch();
    openQueue();
    socketWorker();
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const pass = await dispatchIdleWork(idleInput({
      push,
      state: crewState(new Date(D_NOW - 10 * MIN).toISOString()),
      live: live(),
    }));
    expect(pass.pushed).toEqual([{ seat: 'worker-1', ok: true, outcome: 'typed (unconfirmed)' }]);
  });
});

describe('the class reads the pane socket the send would dial', () => {
  /** A bare team state folder and registry home, enough for one seat's class read. */
  function classScratch(): { dir: string; sockets: string } {
    if (base) rmSync(base, { recursive: true, force: true });
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delivery-class-')));
    root = join(base, 'crew');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    return { dir: join(root, '.agents'), sockets: join(base, 'cc-socks') };
  }

  function classOf(sockets: string, processes?: { shell: number; foreground: number[] }) {
    return seatDeliveryClass({
      dir: join(root, '.agents'),
      root,
      session: 'crew',
      seat: 'worker-1',
      declared: { cli: 'claude-code', launch: 'claude' },
      home,
      ...(processes === undefined ? {} : { processes }),
      sockets,
    });
  }

  test("a pane's own socket is discovered when the registry recorded no address", () => {
    const { sockets } = classScratch();
    declare('worker-1');
    record('worker-1', PANE_A, null);
    mkdirSync(sockets, { recursive: true });
    writeFileSync(join(sockets, `${SOCKET_PID}.sock`), '');
    const delivery = classOf(sockets, { shell: SHELL_PID, foreground: [SOCKET_PID] });
    expect(delivery.class).toBe('push');
    expect(delivery.evidence.socket).toBe(true);
  });

  test('with no address and no process reading the class stays conservative (control)', () => {
    const { sockets } = classScratch();
    declare('worker-1');
    record('worker-1', PANE_A, null);
    mkdirSync(sockets, { recursive: true });
    writeFileSync(join(sockets, `${SOCKET_PID}.sock`), '');
    const delivery = classOf(sockets);
    expect(delivery.class).toBe('pull-on-turn');
    expect(delivery.evidence.socket).toBe(false);
  });

  test('a stale recorded address falls to the pane socket when the processes are read', () => {
    const { sockets } = classScratch();
    declare('worker-1');
    // The record names a socket that is no longer there; the pane's own pid carries another.
    record('worker-1', PANE_A, join(base, 'gone', `${OTHER_PID}.sock`));
    mkdirSync(sockets, { recursive: true });
    writeFileSync(join(sockets, `${SOCKET_PID}.sock`), '');
    const delivery = classOf(sockets, { shell: SHELL_PID, foreground: [SOCKET_PID] });
    expect(delivery.class).toBe('push');
    expect(delivery.evidence.socket).toBe(true);
  });

  test("another session's recorded address is no evidence for this seat", () => {
    const { sockets } = classScratch();
    declare('worker-1');
    record('worker-1', PANE_A, join(base, 'sock', `${SOCKET_PID}.sock`), 'other');
    mkdirSync(join(base, 'sock'), { recursive: true });
    writeFileSync(join(base, 'sock', `${SOCKET_PID}.sock`), '');
    const delivery = classOf(sockets);
    expect(delivery.class).toBe('pull-on-turn');
    expect(delivery.evidence.socket).toBe(false);
  });
});

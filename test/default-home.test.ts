// The default registry home: a real CLI run passes no sources at all, and `team next` and
// `team plan` must still read the seat's agent record from the same home the configuration read
// used — the machine's `homedir()`. Pointed at a synthetic fixture, this file drives the
// exported commands with no sources and the daemon handler with the host's home, and checks
// that a socket-only seat is offered its time-bound record. The last scenes are the classifier's
// own no-home rule seen through the handler: a caller that names no home proves no address, and
// the conservative reading stands.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as realOs from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { HostedRoute } from '../src/daemon/routes.ts';
import type { TeamFile } from '../src/file/types.ts';

let fakeHome = '';
// Registered before the command modules load (they are imported dynamically below), so every
// `homedir()` in the run answers the fixture home. The real module's other exports are intact.
const realHomedir = realOs.homedir;
mock.module('node:os', () => ({ ...realOs, homedir: () => fakeHome }));
// Bun's module mocks are process-wide, and every test file of a run shares one process: put the
// captured real lookup back when this file ends, so a later file's default home is the machine's
// again rather than this fixture's.
afterAll(() => { mock.module('node:os', () => ({ ...realOs, homedir: realHomedir })); });

const { world } = await import('./send-native-fixtures.ts');
const { testIo } = await import('./helpers.ts');
const { cliHookSettingsPath } = await import('../src/launch/cli-hook.ts');
const { registerAgent } = await import('../src/registry/agents.ts');
const { teamIdOf } = await import('../src/registry/teams.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { readTeamConfig } = await import('../src/file/team-config.ts');
const { runNext } = await import('../src/commands/next.ts');
const { runPlan } = await import('../src/commands/plan.ts');
const { handleNext } = await import('../src/daemon/next.ts');

const PANE = 'fixture-pane-1';

let made: ReturnType<typeof world> | undefined;

afterEach(() => {
  made?.cleanup();
  made = undefined;
  fakeHome = '';
});

/**
 * A world whose `plain` seat was launched with a cross-session socket: generated settings that
 * declare accept, written first, then the socket the registry record names. The queue carries a
 * time-bound record and an ordinary one, so a run that reads the seat as pull-on-turn claims the
 * ordinary record instead of silently claiming nothing.
 */
function socketWorld(): { address: string } {
  const fixture = world(null, [{ name: 'plain', role: 'implementer' }]);
  made = fixture;
  // The machine's home, the way config loading resolves it — `homedir()`, mocked above.
  fakeHome = fixture.home;
  const settings = cliHookSettingsPath(fixture.dir, 'acme', 'plain');
  if (settings === null) throw new Error('the fixture seat has no settings path');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, '{"crossSessionInbound":"accept"}\n');
  const past = new Date(Date.now() - 60_000);
  utimesSync(settings, past, past);
  const address = join(fixture.sockets, '987654.sock');
  writeFileSync(address, '');
  registerAgent(fixture.home, {
    name: 'plain',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(fixture.root), seat: 'plain', session: 'acme', pane: PANE, address },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.plain = { stage: 'ready', pane: PANE, cli: 'claude-code', watcher: 'hook', launch_line: 'claude' };
  });
  writeFileSync(
    join(fixture.dir, 'queue.yaml'),
    '- id: urgent\n  title: the time-bound title\n  deadline: 2026-12-31T00:00:00Z\n- id: plain\n  title: the ordinary title\n',
  );
  return { address };
}

function fixture(): NonNullable<typeof made> {
  if (made === undefined) throw new Error('the fixture world is not built');
  return made;
}

function caller(): Caller {
  return { kind: 'seat', name: 'plain', pane: PANE, session: 'acme' };
}

function leases(): string[] {
  const dir = join(fixture().dir, 'leases');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function route(): HostedRoute {
  return { root: fixture().root, team: 'acme', session: 'acme', seats: ['plain'] };
}

/** The team as the daemon reads it, with no home named: the mocked `homedir()` is the default. */
function loadedTeam(): TeamFile {
  const loaded = readTeamConfig(fixture().root);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

test('a default run reads the machine home and claims the time-bound record', async () => {
  socketWorld();
  const io = testIo(fixture().root, caller());
  const code = await runNext([], io);
  expect(code).toBe(0);
  expect(io.out).toContain('urgent');
  expect(leases()).toEqual(['urgent.json']);
});

test('a default plan reads the machine home: the deadline row carries no un-wakeable note', async () => {
  socketWorld();
  const io = testIo(fixture().root, caller());
  const code = await runPlan([], io);
  expect(code).toBe(0);
  expect(io.out).toContain('the time-bound title');
  expect(io.out).not.toContain('(its seat cannot be woken while idle)');
});

test('the same default run whose recorded socket is gone claims the ordinary record', async () => {
  const { address } = socketWorld();
  rmSync(address);
  const io = testIo(fixture().root, caller());
  const code = await runNext([], io);
  expect(code).toBe(0);
  expect(io.out).toContain('the ordinary title');
  expect(leases()).toEqual(['plain.json']);
});

test('the daemon handler claims the time-bound record with the host home', async () => {
  socketWorld();
  const answer = await handleNext({
    route: route(),
    team: loadedTeam(),
    caller: { seat: 'plain', pane: PANE },
    action: 'claim',
    mine: false,
    now: Date.now(),
    home: fakeHome,
  });
  expect(answer).toMatchObject({ ok: true, kind: 'claimed', record: { id: 'urgent' } });
});

test('the same handler with no home proves no address: the ordinary record, never the time-bound one', async () => {
  socketWorld();
  const answer = await handleNext({
    route: route(),
    team: loadedTeam(),
    caller: { seat: 'plain', pane: PANE },
    action: 'claim',
    mine: false,
    now: Date.now(),
  });
  expect(answer).toMatchObject({ ok: true, kind: 'claimed', record: { id: 'plain' } });
});

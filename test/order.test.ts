// `team order` — the sidebar read in roster order, the orchestrator first, through one
// `team restart` per out-of-order seat. Every scene stands in for the whole pane host and the
// restart the command delegates to: the fake restart moves a workspace exactly as the real one
// does (close, create at the end, record the new pane and workspace in the state), so the
// command's own divergence, ordering and verification are measured, not mocked away.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyApprovalRecord } from './legacy-approval.ts';
import { runOrder, type OrderSources } from '../src/commands/order.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { LEGACY_LINE, storePath } from '../src/store/store.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T21:00:00Z');

function seatBlock(role: string, name: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

// lead is the file's coordinator; ops and worker follow. The seats' file order is the roster
// order after the orchestrator is lifted first.
function teamYaml(seats: [string, string][]): string {
  return `format: 1
project: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
${seats.map(([role, name]) => seatBlock(role, name)).join('\n')}`;
}

const TEAM_YAML = teamYaml([['coordinator', 'lead'], ['operator', 'ops'], ['implementer', 'worker']]);
// The same three seats with the orchestrator listed last: the roster this run aims at still
// lifts the orchestrator first, whatever the file's own order.
const ORCHESTRATOR_LAST_YAML = teamYaml([['implementer', 'worker'], ['operator', 'ops'], ['coordinator', 'lead']]);

type Fixture = { base: string; root: string; home: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(rawYaml = TEAM_YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ord-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(dir, 'team.yaml'), rawYaml);
  return { base, root, home, dir };
}

/** One seat's placement as a real launch records it: the pane and the workspace it runs in, in
 *  the session a run addresses (the file's own `acme` unless a scene says another). */
function place(fixture: Fixture, seats: Record<string, { pane: string; workspace?: string }>, session = 'acme'): void {
  updateState(fixture.dir, (state) => {
    const record = (state.sessions[session] ??= emptySession());
    for (const [name, held] of Object.entries(seats)) {
      record.seats[name] = {
        stage: 'ready',
        pane: held.pane,
        ...(held.workspace !== undefined ? { workspace: held.workspace } : {}),
      };
    }
  });
}

type World = {
  /** The session's workspaces, creation order: the sidebar's order. */
  workspaces: string[];
  /** The pane host's agents, one per live seat. */
  agents: HerdrAgent[];
  /** The restarts the pass delegated, in call order. */
  restarts: string[];
  /** Whether the fake restart moves the workspace, or succeeds without moving it. */
  move: boolean;
  /** Seats whose delegated restart exits nonzero. */
  fail: Set<string>;
  /** The next workspace number the pane host hands out. */
  next: number;
  /** Every restart argv the pass delegated, whole: the seat and any flags forwarded to it. */
  argvs?: string[][];
};

/** The fake pane host + the fake restart: closing removes the workspace, creating pushes the new
 *  one at the end, and the state records the new pane and workspace, as a real relaunch does. */
function makeSources(fixture: Fixture, world: World): OrderSources {
  return {
    home: fixture.home,
    now: () => NOW,
    sessionState: () => 'running',
    workspaces: () => world.workspaces.map((id) => ({ id })),
    agents: () => world.agents,
    state: (dir) => readState(dir),
    restart: async (argv, io) => {
      const name = argv[0] ?? '';
      world.restarts.push(name);
      (world.argvs ??= []).push(argv);
      if (world.fail.has(name)) {
        io.stderr(`team restart: ${name} is working; left as it is\n`);
        return 1;
      }
      // A delegated restart runs with the flags the pass forwarded, so the session it reads and
      // records is the one those flags name — the file's own when none did.
      const flag = argv.indexOf('--session');
      const session = (flag >= 0 ? argv[flag + 1] : undefined) ?? 'acme';
      if (!world.move) return 0;
      const held = readState(fixture.dir).sessions[session]?.seats[name];
      const oldWorkspace = held?.workspace ?? world.agents.find((agent) => agent.name === name)?.workspace;
      const created = `w${String(world.next)}`;
      if (oldWorkspace !== undefined) {
        world.workspaces = world.workspaces.filter((workspace) => workspace !== oldWorkspace);
        const agent = world.agents.find((one) => one.workspace === oldWorkspace);
        if (agent !== undefined) agent.workspace = created;
      }
      world.workspaces.push(created);
      const pane = `pane${String(world.next)}`;
      updateState(fixture.dir, (current) => {
        const record = (current.sessions[session] ??= emptySession());
        record.seats[name] = {
          ...(record.seats[name] ?? { stage: 'ready' }),
          stage: 'ready',
          pane,
          workspace: `w${String(world.next)}`,
        };
      });
      world.next += 1;
      io.stdout(`team restart: restarted ${name}; pane -> ${pane}\n`);
      return 0;
    },
  };
}

/** Idle agents at the panes their workspaces imply (`w2` runs at `pane2`; the fixture's pane ids
 *  are the neutral shape, never the terminal host's own). */
function agentsOver(seats: { name: string; workspace: string }[], status = 'idle'): HerdrAgent[] {
  return seats.map((seat) => ({
    name: seat.name,
    agent: 'claude-code',
    pane: `pane${seat.workspace.slice(1)}`,
    workspace: seat.workspace,
    status,
    cwd: '/tmp',
  }));
}

describe('team order', () => {
  test('a sidebar already reading in roster order closes nothing', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, ops: { pane: 'pane2', workspace: 'w2' }, worker: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'ops', workspace: 'w2' }, { name: 'worker', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(0);
    expect(io.out).toContain('team order: sidebar: lead, ops, worker\n');
    expect(io.out).toContain('team order: roster: lead, ops, worker\n');
    expect(io.out).toContain('team order: the sidebar already reads in roster order; nothing was closed\n');
    expect(world.restarts).toEqual([]);
    expect(world.workspaces).toEqual(['w1', 'w2', 'w3']);
  });

  test('a re-added middle seat is re-created with the seats after it, in roster order', async () => {
    const fixture = makeFixture();
    // ops was re-added: its fresh workspace w3 landed at the end.
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(0);
    // The divergence is at ops' roster position: ops and worker move, lead does not, and the
    // re-creation is in roster order even though the sidebar held worker first.
    expect(world.restarts).toEqual(['ops', 'worker']);
    expect(world.workspaces).toEqual(['w1', 'w4', 'w5']);
    expect(io.out).toContain('team order: closing and re-creating ops, worker in roster order, each through team restart\n');
    expect(io.out).toContain('team order: sidebar: lead, ops, worker\n');
    const state = readState(fixture.dir);
    expect(state.sessions.acme?.seats.ops?.workspace).toBe('w4');
    expect(state.sessions.acme?.seats.worker?.workspace).toBe('w5');
    expect(state.sessions.acme?.seats.lead?.pane).toBe('pane1');
  });

  test('the orchestrator is lifted first even when the file lists it last, through the live agent list when the state predates workspaces', async () => {
    const fixture = makeFixture(ORCHESTRATOR_LAST_YAML);
    // The session was created in the file's own order. No seat's state records a workspace — the
    // mapping goes through the live agent list, the pane each seat's record names.
    place(fixture, { worker: { pane: 'pane1' }, ops: { pane: 'pane2' }, lead: { pane: 'pane3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'worker', workspace: 'w1' }, { name: 'ops', workspace: 'w2' }, { name: 'lead', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(0);
    expect(io.out).toContain('team order: roster: lead, worker, ops\n');
    expect(world.restarts).toEqual(['lead', 'worker', 'ops']);
    expect(world.workspaces).toEqual(['w4', 'w5', 'w6']);
    expect(io.out).toContain('team order: sidebar: lead, worker, ops\n');
  });

  test('a dry run prints the set and closes nothing', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder(['--dry-run'], io, makeSources(fixture, world))).resolves.toBe(0);
    expect(io.out).toContain('team order: would close and re-create ops, worker in roster order, each through team restart; nothing was closed\n');
    expect(world.restarts).toEqual([]);
    expect(world.workspaces).toEqual(['w1', 'w2', 'w3']);
  });

  test('a working seat in the moving set refuses the whole pass before anything closes', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } });
    const agents = agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]);
    const working = agents.find((agent) => agent.name === 'worker');
    if (working !== undefined) working.status = 'working';
    const world: World = { workspaces: ['w1', 'w2', 'w3'], agents, restarts: [], move: true, fail: new Set(), next: 4 };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(1);
    expect(io.err).toContain('team order: worker is working; left as they are, nothing was closed\n');
    expect(world.restarts).toEqual([]);
    expect(world.workspaces).toEqual(['w1', 'w2', 'w3']);
  });

  test("a lead whose own pane is in the moving set is refused: closing it would end the pass", async () => {
    const fixture = makeFixture();
    // The lead's own workspace landed last, so the moving set is the whole sidebar.
    place(fixture, { ops: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, lead: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'ops', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'lead', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane3', session: 'acme' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(1);
    expect(io.err).toContain("team order: this run sits in lead's own pane, and closing it would end the pass; another `leads` seat (or the owner) orders it\n");
    expect(world.restarts).toEqual([]);
  });

  test('a seat that is not `leads` for this team is refused', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, ops: { pane: 'pane2', workspace: 'w2' }, worker: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'ops', workspace: 'w2' }, { name: 'worker', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'seat', name: 'worker', pane: 'pane3', session: 'acme' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(1);
    expect(io.err).toContain('team order: only the owner or `leads` orders the sidebar; this call is worker\n');
    expect(world.restarts).toEqual([]);
  });

  test("an owner run with --session and --file places, reads and restarts in that session and file", async () => {
    const fixture = makeFixture();
    // ops re-added at the end, under the flag-named session: the state the file's own `acme`
    // holds is empty, so a run judged there would see no sidebar at all and move nothing.
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } }, 'night');
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    // The host reads record the session each was asked for: every one must be the flag's own.
    const asked: string[] = [];
    const plain = makeSources(fixture, world);
    const sources: OrderSources = {
      ...plain,
      sessionState: (session) => { asked.push(`state:${session}`); return plain.sessionState(session); },
      workspaces: (session) => { asked.push(`workspaces:${session}`); return plain.workspaces(session); },
      agents: (session) => { asked.push(`agents:${session}`); return plain.agents(session); },
    };
    const file = join(fixture.dir, 'team.yaml');
    await expect(runOrder(['--session', 'night', '--file', file], io, sources)).resolves.toBe(0);
    expect(asked).not.toContain('workspaces:acme');
    expect(asked).toContain('workspaces:night');
    // Each delegated restart carries both flags, so it reads and records in the same session.
    expect(world.argvs).toEqual([
      ['ops', '--session', 'night', '--file', file],
      ['worker', '--session', 'night', '--file', file],
    ]);
    const state = readState(fixture.dir);
    expect(state.sessions.night?.seats.ops?.workspace).toBe('w4');
    expect(state.sessions.night?.seats.worker?.workspace).toBe('w5');
    expect(state.sessions.acme?.seats.lead?.pane).toBeUndefined();
  });

  test('a restart that refuses mid-pass stops there and says how far it got', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(['worker']), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(1);
    expect(world.restarts).toEqual(['ops', 'worker']);
    expect(io.err).toContain('team order: team restart worker exited 1; ops relaunched; run team order again once it clears\n');
  });

  test('a pass whose restarts did not move the workspaces is reported, never assumed', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane2', workspace: 'w2' }, ops: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w2' }, { name: 'ops', workspace: 'w3' }]),
      restarts: [], move: false, fail: new Set(), next: 4,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(1);
    expect(io.err).toContain('team order: the sidebar does not read in roster order after the pass: lead, worker, ops\n');
  });

  test('a session that is not running is refused', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' } });
    const world: World = {
      workspaces: ['w1'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }]),
      restarts: [], move: true, fail: new Set(), next: 2,
    };
    const sources: OrderSources = { ...makeSources(fixture, world), sessionState: () => 'stopped' };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, sources)).resolves.toBe(1);
    expect(io.err).toContain('team order: session "acme" is not running\n');
  });

  test('a pane host that does not answer is refused', async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' } });
    const world: World = {
      workspaces: ['w1'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }]),
      restarts: [], move: true, fail: new Set(), next: 2,
    };
    const sources: OrderSources = { ...makeSources(fixture, world), workspaces: () => null };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, sources)).resolves.toBe(1);
    expect(io.err).toContain('team order: the pane host does not answer\n');
  });

  test("a state record that cannot be read refuses before anything closes", async () => {
    const fixture = makeFixture();
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, ops: { pane: 'pane2', workspace: 'w2' }, worker: { pane: 'pane3', workspace: 'w3' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'ops', workspace: 'w2' }, { name: 'worker', workspace: 'w3' }]),
      restarts: [], move: true, fail: new Set(), next: 4,
    };
    const sources: OrderSources = { ...makeSources(fixture, world), state: () => { throw new Error('torn'); } };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, sources)).resolves.toBe(2);
    expect(io.err).toContain("team order: the team's state record can't be read\n");
  });

  test('an unexpected word is a usage error', async () => {
    const fixture = makeFixture();
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder(['worker'], io, makeSources(fixture, {
      workspaces: [], agents: [], restarts: [], move: true, fail: new Set(), next: 1,
    }))).resolves.toBe(2);
    expect(io.err).toContain('team order: unexpected "worker"');
  });

  test('a watch workspace between seats never moves and does not stop the pass', async () => {
    const fixture = makeFixture();
    // ops re-added at the end; the watch's workspace w2 sits between lead and worker.
    place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, worker: { pane: 'pane3', workspace: 'w3' }, ops: { pane: 'pane4', workspace: 'w4' } });
    const world: World = {
      workspaces: ['w1', 'w2', 'w3', 'w4'],
      agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'worker', workspace: 'w3' }, { name: 'ops', workspace: 'w4' }]),
      restarts: [], move: true, fail: new Set(), next: 5,
    };
    const io = testIo(fixture.root, { kind: 'owner' });
    await expect(runOrder([], io, makeSources(fixture, world))).resolves.toBe(0);
    // The seats' relative order is the roster's; the watch keeps its place between them.
    expect(world.workspaces).toEqual(['w1', 'w2', 'w5', 'w6']);
    expect(io.out).toContain('team order: sidebar: lead, ops, worker\n');
  });
});

const RENEW = 'standing cannot be renewed in this build, and the owner is to be told';

function plantLegacy(fixture: Fixture): void {
  const loaded = readTeamConfig(fixture.root, { home: fixture.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, fixture.home);
  mkdirSync(store, { recursive: true });
  const record = legacyApprovalRecord(loaded.team, loaded.root, TEAM_YAML, NOW);
  writeFileSync(join(store, 'approval.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function ordered(fixture: Fixture): { io: ReturnType<typeof testIo>; sources: OrderSources } {
  place(fixture, { lead: { pane: 'pane1', workspace: 'w1' }, ops: { pane: 'pane2', workspace: 'w2' }, worker: { pane: 'pane3', workspace: 'w3' } });
  const world: World = {
    workspaces: ['w1', 'w2', 'w3'],
    agents: agentsOver([{ name: 'lead', workspace: 'w1' }, { name: 'ops', workspace: 'w2' }, { name: 'worker', workspace: 'w3' }]),
    restarts: [], move: true, fail: new Set(), next: 4,
  };
  return { io: testIo(fixture.root, { kind: 'owner' }), sources: makeSources(fixture, world) };
}

describe('order and a legacy approval', () => {
  test('dev mode names the record and still orders', async () => {
    const fixture = makeFixture();
    plantLegacy(fixture);
    const { io, sources } = ordered(fixture);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runOrder([], io, sources), io.err).toBe(0);
    expect(io.err).toContain(RENEW);
    expect(io.err).toContain('unverified lines');
    expect(io.out).toContain('nothing was closed');
  });

  test('outside dev mode a legacy record still refuses', async () => {
    const fixture = makeFixture();
    plantLegacy(fixture);
    const { io, sources } = ordered(fixture);
    expect(await runOrder([], io, sources)).toBe(1);
    expect(io.err).toContain(LEGACY_LINE);
    expect(io.err).not.toContain(RENEW);
  });
});

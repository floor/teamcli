// The first launch of a seat a registry team's record declares but no launch has run for. The
// seat's inbox registration and the server its launch line starts both resolve the seat by the
// registry's roster, and only a completed launch writes a roster line — so the line is written
// for every planned launch seat before the plan runs. A line is this team's own: a seat name the
// launching record does not declare is never written, even when another registered team's roster
// holds it. Every folder is synthetic and the registry lives under the scene's own home.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerInbox } from '../src/mcp/register.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { findAgent } from '../src/registry/agents.ts';
import { ensureSeatLine } from '../src/registry/sync.ts';
import { getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';

const SESSION = 'acme';
const NOW = new Date('2026-11-04T10:00:00Z');
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.22/idle.txt', import.meta.url), 'utf8');
const DROP = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

let base: string;
let home: string;
let root: string;
let lobby: string;
let dir: string;

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

/** A seat block for the scene's own file. The lead is a person's seat and is never launched; the
 *  helper's screen is the captured idle one, so a launch of it reaches ready on the fixture. */
function seatBlock(name: string): string {
  if (name === 'lead') {
    return `  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;
  }
  return `  - role: worker
    name: helper
    cli: cursor
    vendor: test
    model: Gemini Argon
    version: "4"
    launch: cursor-agent --model gemini-4-argon-high
`;
}

function teamText(input: { root: string; seats: readonly string[]; project?: string; session?: string }): string {
  const project = input.project ?? 'acme';
  const session = input.session ?? SESSION;
  const first = input.seats[0]!;
  return `format: 1
project: ${project}
coordinator: ${first}
operator: ${first}
session: ${session}
trust:
  - ${lobby}
  - ${input.root}
workspace:
  mode: shared
seats:
${input.seats.map(seatBlock).join('')}`;
}

/** A synthetic checkout, its team file moved into the scene's own registry, and an empty roster:
 *  the record declares each seat, and no launch has run for any of them yet. */
function checkout(input: { name: string; seats: readonly string[]; project?: string; session?: string; roster?: readonly string[] }): {
  root: string;
  id: string;
} {
  const at = join(base, input.name);
  mkdirSync(join(at, '.agents'), { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  writeFileSync(join(at, 'README.md'), `${input.name}\n`);
  git(at, 'add', 'README.md');
  git(at, 'commit', '-q', '-m', 'first');
  writeFileSync(join(at, '.agents', 'team.yaml'), teamText({ root: at, seats: input.seats, ...(input.project === undefined ? {} : { project: input.project }), ...(input.session === undefined ? {} : { session: input.session }) }));
  intoRegistry(at, home);
  rmSync(join(at, '.agents', 'team.yaml'));
  const id = teamIdOf(at);
  upsertTeam(home, id, {
    project: input.project ?? 'acme',
    session: input.session ?? SESSION,
    root: at,
    roster: (input.roster ?? []).map((seat, index) => ({ agent: `agt_00000000000${index + 1}`, seat, role: 'worker' })),
  });
  return { root: at, id };
}

/** The scene's own home, lobby folder and checkout. */
function scene(input: { seats: readonly string[] }): { id: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'declared-seat-')));
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  const made = checkout({ name: 'acme', seats: input.seats });
  root = made.root;
  dir = join(root, '.agents');
  return { id: made.id };
}

/** The owner's approval of the record this scene runs, read from the registry the way `up` reads
 *  it: the seat's first launch goes through the same gate as every other. */
function approve(): void {
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const stored = storedTeam(root, home);
  if (stored === null) throw new Error('the scene team is not in the registry');
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: stored.text },
    loaded.team.seats,
    home,
    NOW,
  );
}

type RegisterCall = { seat: string; cwd: string; ok: boolean; reason?: string; rosterAtCall: string[] };

type World = {
  launch: Launch;
  creates: { label: string; cwd: string }[];
  runs: { pane: string; command: string }[];
  registered: RegisterCall[];
  session: 'absent' | 'running';
  workspaces(): { id: string; label: string }[];
};

/** The launch as a fake terminal host: workspaces and panes of its own, every cursor pane at the
 *  captured idle screen, and the seat's inbox registered through the real registration, so the
 *  roster it resolves is the one the run wrote. */
function fake(): World {
  const creates: { label: string; cwd: string }[] = [];
  const runs: { pane: string; command: string }[] = [];
  const registered: RegisterCall[] = [];
  const panes = new Map<string, { text: string; front: string[]; workspace: string }>();
  const spaces = new Map<string, string>();
  let n = 0;
  let clock = NOW.getTime();
  const world: World = {
    launch: {} as Launch,
    creates,
    runs,
    registered,
    session: 'absent',
    workspaces: () => [...spaces].map(([id, label]) => ({ id, label })),
  };
  world.launch = {
    sessionState: () => world.session,
    startServer() {
      world.session = 'running';
      return true;
    },
    sessionUp: () => world.session === 'running',
    createWorkspace(_session, cwd, label) {
      n += 1;
      const pane = `pane${String(n)}`;
      const workspace = `space${String(n)}`;
      panes.set(pane, { text: CURSOR_IDLE, front: [], workspace });
      spaces.set(workspace, label);
      creates.push({ label, cwd });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const held = panes.get(pane);
      // The launch line may carry the unattended environment before the binary.
      if (held) held.front = /(?:^|\s)cursor-agent\b/.test(command) ? ['cursor-agent'] : [];
      return true;
    },
    registerInbox(cli, seat, cwd, session, teamFile) {
      const rosterAtCall = (getTeam(home, teamIdOf(root))?.roster ?? []).map((line) => line.seat);
      const made = registerInbox({
        cli,
        seat,
        cwd,
        session,
        home,
        ...(teamFile === undefined ? {} : { file: teamFile }),
        run: () => ({ code: 0 }),
      });
      registered.push({
        seat,
        cwd,
        ok: made?.ok === true,
        ...(made === null || made.ok ? {} : { reason: made.reason }),
        rosterAtCall,
      });
      return made;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.front.length > 0).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => [...panes].filter(([, pane]) => pane.workspace === workspace).map(([id]) => id),
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: (_session, pane) => panes.get(pane)?.front ?? [],
    focus: () => true,
    deleteSession: () => true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return world;
}

function sources(made: World): UpSources {
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => made.session === 'running',
    now: () => NOW,
    home,
  };
  return {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => made.launch.agents(SESSION),
    workspaces: () => made.workspaces(),
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    alive: () => true,
    doctor,
    launch: made.launch,
  };
}

/** The live picture a later run reads: the seat at the pane this one launched, idle. */
function liveAtItsPane(made: World): void {
  const held = readState(dir).sessions[SESSION]?.seats['helper'];
  if (held?.pane === undefined) throw new Error('the first run left the seat no pane');
  made.launch.agents = (): HerdrAgent[] => [
    { name: 'helper', agent: 'cursor', pane: held.pane!, workspace: held.workspace ?? '', status: 'idle', cwd: null },
  ];
}

const rosterNow = () => (getTeam(home, teamIdOf(root))?.roster ?? []);

/** A signed drop for the seat, in the team's own drop folder. */
function drop(seat: string, id: string): void {
  const folder = join(root, '.agents', 'send-drops', SESSION, seat);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(root),
    session: SESSION,
    at: '2026-11-01T10:00:00.000Z',
    body: `for ${seat}`,
    from: 'lead',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, home);
  writeFileSync(join(folder, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** The server the launch's own arguments start, asked what is unread: the seat's client would
 *  run exactly this, in the seat's folder, with its caller proved by the record the run wrote. */
async function unreadOf(args: readonly string[], caller: { cwd: string; pane: string }): Promise<{ code: number; err: string; unread: string[] }> {
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const seat = value('--seat');
  const session = value('--session') ?? SESSION;
  const io = testIo(caller.cwd, seat === undefined ? undefined : { kind: 'seat', name: seat, pane: caller.pane, session });
  const replies: string[] = [];
  const code = await runMcpServe(
    {
      seat: value('--seat'),
      session: value('--session'),
      ...(value('--file') === undefined ? {} : { file: value('--file') }),
      ...(value('--epoch') === undefined ? {} : { epoch: value('--epoch') }),
    },
    io,
    {
      lines: (async function* () {
        yield JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'inbox_check' } });
      })(),
      write: (line) => replies.push(line),
    },
    { home },
  );
  const unread = code !== 0 || replies[0] === undefined
    ? []
    : (JSON.parse((JSON.parse(replies[0]!) as Record<string, any>).result.content[0].text) as { unread: { id: string }[] })
      .unread.map((one) => one.id);
  return { code, err: io.err, unread };
}

test('a declared seat with no roster line launches: the line is there before its launch runs, and the server it starts serves a send', async () => {
  await underRegistry(async () => {
    scene({ seats: ['lead', 'helper'] });
    approve();
    expect(rosterNow()).toEqual([]);

    const made = fake();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp([], io, sources(made));
    expect(code, io.out + io.err).toBe(0);

    // The registration the launch runs before its command saw the seat already on the roster:
    // the line was written before the plan ran, not by the launch after it.
    expect(made.registered.length).toBeGreaterThan(0);
    expect(made.registered.every((call) => call.ok)).toBe(true);
    expect(made.registered[0]?.rosterAtCall).toEqual(['helper']);
    expect(made.runs.filter((run) => /\bcursor-agent\b/.test(run.command))).toHaveLength(1);

    // One line, for the declared seat, under this team's own agent id.
    const roster = rosterNow();
    expect(roster.map((line) => line.seat)).toEqual(['helper']);
    const agent = findAgent(home, { team: teamIdOf(root), seat: 'helper' });
    expect(agent).not.toBeNull();
    expect(roster[0]?.agent).toBe(agent!.id);
    expect(agent!.reach.team).toBe(teamIdOf(root));

    // The launch line's own arguments start a server that resolves the seat and serves its send.
    const call = made.registered[0]!;
    const written = JSON.parse(readFileSync(join(call.cwd, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const args = written.mcpServers['team-inbox']?.args ?? [];
    expect(args).not.toContain('--file');
    const held = readState(dir).sessions[SESSION]?.seats['helper'];
    expect(held?.stage).toBe('ready');
    drop('helper', DROP);
    const read = await unreadOf(args, { cwd: call.cwd, pane: held!.pane! });
    expect(read).toMatchObject({ code: 0, err: '' });
    // The send this scene wrote is served; the launch's own brief is in the same inbox.
    expect(read.unread).toContain(DROP);
  });
});

test('a second up keeps one line and the same agent id', async () => {
  await underRegistry(async () => {
    scene({ seats: ['lead', 'helper'] });
    approve();
    const first = fake();
    expect(await runUp([], testIo(root, { kind: 'owner' }), sources(first))).toBe(0);
    const before = rosterNow();
    expect(before.map((line) => line.seat)).toEqual(['helper']);
    const id = findAgent(home, { team: teamIdOf(root), seat: 'helper' })?.id;
    expect(id).toBeDefined();

    // The live picture the second run reads, and the watch this run started still running.
    liveAtItsPane(first);
    updateState(dir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.watch = { pid: 4242, heartbeat: NOW.toISOString() } as never;
    });

    const second = fake();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, sources(second)), io.out + io.err).toBe(0);
    // The line is one, and it is still the agent the first run made: a launch keeps its id.
    expect(rosterNow().map((line) => line.seat)).toEqual(['helper']);
    expect(rosterNow()[0]?.agent).toBe(before[0]?.agent);
    expect(findAgent(home, { team: teamIdOf(root), seat: 'helper' })?.id).toBe(id);
  });
});

test('a seat name this team does not declare is never written into its roster, even when another team holds it', async () => {
  await underRegistry(async () => {
    // This team declares its lead only; the other team, in the same home, holds a seat called
    // helper. The name is another team's: this team may not write a line for it.
    const own = scene({ seats: ['lead'] });
    const other = checkout({ name: 'other', seats: ['helper'], project: 'other', session: 'other', roster: ['helper'] });
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const otherBefore = getTeam(home, other.id)?.roster ?? [];
    expect(otherBefore.map((line) => line.seat)).toEqual(['helper']);

    const refused = ensureSeatLine({ home, team: loaded.team, root, by: 'the test' }, { name: 'helper' });
    expect(refused).toEqual({ note: 'registry not written: the team does not declare seat "helper"' });
    // This team's roster gained nothing, this team's registry names no agent for the seat, and
    // the team that holds it is exactly as it was.
    expect(rosterNow()).toEqual([]);
    expect(findAgent(home, { team: teamIdOf(root), seat: 'helper' })).toBeNull();
    expect(getTeam(home, other.id)?.roster).toEqual(otherBefore);

    // Its own declared seat is this team's to line, under this team's id.
    const lined = ensureSeatLine({ home, team: loaded.team, root, by: 'the test' }, { name: 'lead' });
    if ('note' in lined) throw new Error(lined.note);
    expect(rosterNow().map((line) => line.seat)).toEqual(['lead']);
    expect(rosterNow()[0]?.agent).toBe(lined.id);
    expect(findAgent(home, { team: own.id, seat: 'lead' })?.id).toBe(lined.id);
    expect(getTeam(home, other.id)?.roster).toEqual(otherBefore);
  });
});

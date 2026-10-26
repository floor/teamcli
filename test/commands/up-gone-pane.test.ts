import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { type HerdrAgent } from '../../src/herdr.ts';
import { readState, type SeatState } from '../../src/state.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';

// The boundaries of the waiting-seat heal: a pane the host no longer lists is replaced, and
// nothing else is. These tests pin the other side of each line the heal draws — the seats whose
// gone pane is not a waiting one, the pane that still exists however unknown its process, the
// run that mixes a heal with a refusal, and the watchdog pane beside it all. The harness is
// `live.test.ts`'s, in miniature: the same fake Launch, recording what it does.

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;

let base: string;
let root: string;
let home: string;

function makeExample(basePath: string, rootPath: string): string {
  return EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-gone-pane-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

function agent(name: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

type World = {
  launch: Launch;
  starts: number;
  creates: string[];
  runs: { pane: string; command: string }[];
  renames: string[];
  closes: string[];
  session: 'absent' | 'running' | 'stopped';
  /** The workspaces this run created, as herdr's list would return them: id and label. */
  workspaceList(): { id: string; label: string }[];
  seed(pane: string, text: string, agent: boolean): void;
};

function world(text: string = IDLE): World {
  const state: World = {
    launch: {} as Launch,
    starts: 0,
    creates: [],
    runs: [],
    renames: [],
    closes: [],
    session: 'absent',
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
    seed(pane, shown, agent) {
      panes.set(pane, { text: shown, agent });
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean }>();
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.starts++;
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text, agent: false });
      spaces.set(`w${n}`, label);
      state.creates.push(label);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      state.runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      state.renames.push(name);
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      return true;
    },
    agentPanes() {
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText(_session, pane) {
      return panes.get(pane)?.text ?? '';
    },
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    focus: () => true,
    deleteSession() {
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return state;
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    workspaces: () => made.workspaceList(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    ...extra,
  };
}

/** The state file as a run before this one would have written it: seats at their recorded
 * stages, an alive watch, and nothing else. */
function seedState(
  seats: Record<string, SeatState>,
  watch: { pid: number; heartbeat: string } | null = { pid: 4242, heartbeat: '2026-10-03T14:01:00Z' },
) {
  writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify({
    format: 1,
    sessions: { 'acme-web': { seats, worktrees: {}, ...(watch ? { watch } : {}) } },
  }));
}

const stateOf = () => readState(join(root, '.agents'));

describe('team up, a pane that is gone or unknown', () => {
  test.each(['launched', 'named', 'ready'] as const)(
    'a %s seat whose recorded pane is gone is launched fresh, with no replaced notice',
    async (stage) => {
      await approve();
      seedState({
        'claude-coordinator-acme': { stage, pane: 'w9:p1', workspace: 'w9', launched: { shell: 400, cli: [401] } },
        'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
        'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
      });
      const made = world();
      made.session = 'running';
      // The host lists the two ready seats and nothing on the gone pane, whose workspace is
      // gone with it. A process read of a pane that no longer exists is null.
      const listed = () => [agent('deepseek-acme', 'w2:p1'), agent('deepseek-acme-2', 'w3:p1')];
      made.launch.agents = listed;
      made.launch.processInfo = (_session, pane) =>
        pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
        pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
      const io = testIo(root, { kind: 'owner' });
      const code = await runUp(FILE, io, sources({
        sessionState: () => 'running',
        alive: () => true,
        workspaces: () => [{ id: 'w2', label: 'deepseek-acme · implementer' }, { id: 'w3', label: 'deepseek-acme-2 · implementer' }],
        agents: listed,
      }, made));
      expect(code).toBe(0);
      // The seat is launched again the ordinary way: a fresh workspace, the recorded pane and
      // stage replaced by the new run's own — and none of the waiting heal's words.
      expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
      expect(made.closes).toEqual([]);
      expect(made.runs.map((run) => run.pane)).toEqual(['w1:p1']);
      expect(`${io.out}${io.err}`).not.toContain('was gone and was replaced');
      expect(`${io.out}${io.err}`).not.toContain('left out');
      const seat = stateOf().sessions['acme-web']?.seats['claude-coordinator-acme'];
      expect(seat?.pane).toBe('w1:p1');
      expect(seat?.stage).toBe('ready');
      expect(seat?.waiting).toBeUndefined();
      const seats = stateOf().sessions['acme-web']?.seats ?? {};
      expect(seats['deepseek-acme']?.pane).toBe('w2:p1');
      expect(seats['deepseek-acme-2']?.pane).toBe('w3:p1');
    },
  );

  test('a waiting seat whose pane holds another process is left and launched fresh', async () => {
    await approve();
    seedState({
      'claude-coordinator-acme': {
        stage: 'launched',
        pane: 'w9:p1',
        workspace: 'w9',
        launched: { shell: 400, cli: [401] },
        waiting: { state: 'waiting-owner', classification: 'trust' },
      },
      'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
      'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
    });
    const made = world();
    made.session = 'running';
    made.seed('w9:p1', IDLE, true);
    // The pane is still listed and named, but a foreign CLI holds it. The old workspace stays
    // and is not typed into; the seat is launched again in a new workspace.
    const typed: string[] = [];
    made.launch.typeText = (_session, pane, text) => { typed.push(`${pane}:${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { typed.push(`${pane}:Enter`); return true; };
    const listed = () => [
      agent('claude-coordinator-acme', 'w9:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w9:p1' ? { shell: 400, foreground: [777] } :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [
        { id: 'w9', label: 'claude-coordinator-acme · project coordinator' },
        { id: 'w2', label: 'deepseek-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme-2 · implementer' },
      ],
      agents: listed,
    }, made));
    expect(code).toBe(0);
    expect(`${io.out}${io.err}`).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced; its workspace w9 was left\n');
    expect(made.closes).not.toContain('w9');
    expect(typed.filter((line) => line.startsWith('w9:'))).toEqual([]);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator']);
    const seat = stateOf().sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(seat?.pane).not.toBe('w9:p1');
    expect(seat?.waiting).toBeUndefined();
    expect(seat?.launched).not.toEqual({ shell: 400, cli: [401] });
    expect(stateOf().sessions['acme-web']?.seats['deepseek-acme']?.pane).toBe('w2:p1');
  });

  test('a waiting seat whose pane cannot be read is never closed or replaced', async () => {
    await approve();
    seedState({
      'claude-coordinator-acme': {
        stage: 'launched',
        pane: 'w9:p1',
        workspace: 'w9',
        launched: { shell: 400, cli: [401] },
        waiting: { state: 'waiting-owner', classification: 'trust' },
      },
      'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
      'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
    });
    const made = world();
    made.session = 'running';
    made.seed('w9:p1', IDLE, true);
    // The pane is listed and named, but no process reading can be made of it.
    const listed = () => [
      agent('claude-coordinator-acme', 'w9:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w9:p1' ? null :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [
        { id: 'w9', label: 'claude-coordinator-acme · project coordinator' },
        { id: 'w2', label: 'deepseek-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme-2 · implementer' },
      ],
      agents: listed,
    }, made));
    expect(code).toBe(1);
    expect(io.out).toContain('claude-coordinator-acme: left out: its waiting pane could not be read\n');
    expect(`${io.out}${io.err}`).not.toContain('was gone and was replaced');
    expect(made.creates).toEqual([]);
    expect(made.closes).toEqual([]);
    expect(made.runs).toEqual([]);
    expect(stateOf().sessions['acme-web']?.seats['claude-coordinator-acme']).toMatchObject({
      pane: 'w9:p1',
      waiting: { state: 'waiting-owner', classification: 'trust' },
    });
  });

  test('a lead seat and another waiting seat whose process was replaced are both launched fresh', async () => {
    await approve();
    seedState({
      'claude-coordinator-acme': {
        stage: 'launched',
        pane: 'w9:p1',
        workspace: 'w9',
        launched: { shell: 400, cli: [401] },
        waiting: { state: 'waiting-owner', classification: 'trust' },
      },
      'deepseek-acme': {
        stage: 'launched',
        pane: 'w7:p1',
        workspace: 'w7',
        launched: { shell: 700, cli: [701] },
        waiting: { state: 'waiting-owner', classification: 'trust' },
      },
      'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
    });
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    // The lead's recorded pane is gone from the host; the other waiting seat's pane is listed,
    // named, and holds a foreign process. One run meets both.
    const listed = () => [
      agent('deepseek-acme', 'w7:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w7:p1' ? { shell: 700, foreground: [700, 888] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [
        { id: 'w7', label: 'deepseek-acme · implementer' },
        { id: 'w3', label: 'deepseek-acme-2 · implementer' },
      ],
      agents: listed,
    }, made));
    // Both waiting processes are gone: each seat is launched again, and neither old workspace is closed.
    expect(code).toBe(0);
    expect(`${io.out}${io.err}`).toContain('claude-coordinator-acme: its recorded pane w9:p1 was gone and was replaced\n');
    expect(`${io.out}${io.err}`).toContain('deepseek-acme: its recorded pane w7:p1 was gone and was replaced; its workspace w7 was left\n');
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer']);
    expect(made.closes).toEqual([]);
    const lead = stateOf().sessions['acme-web']?.seats['claude-coordinator-acme'];
    expect(lead?.pane).toBe('w1:p1');
    expect(lead?.waiting).toBeUndefined();
    const worker = stateOf().sessions['acme-web']?.seats['deepseek-acme'];
    expect(worker?.pane).not.toBe('w7:p1');
    expect(worker?.waiting).toBeUndefined();
    expect(worker?.launched).not.toEqual({ shell: 700, cli: [701] });
  });
});

describe('team up, two runs and the watchdog', () => {
  test('two runs from nothing: the second changes nothing, the watchdog included', async () => {
    await approve();
    const made = world();
    const first = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, first, sources({}, made));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', 'Watch · acme-web']);
    expect(first.err).toContain('watch: started\n');
    // `up` starts the watch in its own workspace and records where it runs; the pid arrives
    // with the watch's own first pass. This run plays that pid as still alive.
    const after = stateOf();
    expect(after.sessions['acme-web']?.watch).toMatchObject({ pane: 'w4:p1', workspace: 'w4' });
    const seeded = JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
    seeded.sessions['acme-web'].watch = { pid: 4242, heartbeat: '2026-10-03T14:01:30Z' };
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(seeded));
    // The first run's own watch start is a pane-run in this same list: the second run
    // adds none to it.
    const runsAfterFirst = made.runs.length;

    const named = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = named;
    const second = testIo(root, { kind: 'owner' });
    const code2 = await runUp(FILE, second, sources({
      sessionState: () => 'running',
      alive: () => true,
      agents: named,
    }, made));
    expect(code2).toBe(0);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', 'Watch · acme-web']);
    expect(made.runs.slice(runsAfterFirst).filter((run) => run.command.includes('watch'))).toHaveLength(0);
    expect(second.err).not.toContain('watch: started');
    expect(`${second.out}${second.err}`).not.toContain('was gone and was replaced');
    // Nothing moved: the whole session record is the same down to its JSON.
    const beforeSecond = JSON.parse(JSON.stringify(seeded.sessions['acme-web']));
    expect(stateOf().sessions['acme-web']).toEqual(beforeSecond);
  });

  test('a recordless seat whose claim is gone is delivered again', async () => {
    await approve();
    const made = world();
    const first = testIo(root, { kind: 'owner' });
    expect(await runUp(FILE, first, sources({}, made))).toBe(0);
    const firstClaims = stateOf().sessions['acme-web']?.briefs ?? {};
    const was = firstClaims['codex-acme']?.id;
    expect(typeof was).toBe('string');
    // The seat was never launched, so its claim is the only record of the delivery: without one,
    // the next run must write a fresh claim and its drop rather than treat the seat as served.
    const seeded = JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
    delete seeded.sessions['acme-web'].briefs['codex-acme'];
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(seeded));

    const named = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = named;
    const second = testIo(root, { kind: 'owner' });
    const code2 = await runUp(FILE, second, sources({
      sessionState: () => 'running',
      alive: () => true,
      agents: named,
    }, made));
    expect(code2).toBe(0);
    const claim = stateOf().sessions['acme-web']?.briefs?.['codex-acme'];
    expect(claim?.stage).toBe('ready');
    expect(claim?.id).not.toBe(was);
  });

  test('the watchdog pane is recorded when a flagless watch would miss the file, and survives the next run', async () => {
    // A git root above the project: a watch started in `root` with no `--file` would load the
    // git root's own file, not this one, so the resolved path is recorded for the pane. The
    // home moves out of `base` first — a lobby inside the repository is refused on its own.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'team-gone-home-')));
    await approve();
    execFileSync('git', ['init', '--quiet', base]);
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({}, made));
    expect(code).toBe(0);
    expect(made.creates).toEqual(['claude-coordinator-acme · project coordinator', 'deepseek-acme · implementer', 'deepseek-acme-2 · implementer', 'Watch · acme-web']);
    expect(stateOf().sessions['acme-web']?.watchdog).toEqual({
      file: join(root, '.agents/team.yaml'),
      pane: 'w4:p1',
    });
    expect(stateOf().sessions['acme-web']?.watch).toMatchObject({ pane: 'w4:p1', workspace: 'w4' });

    const seeded = JSON.parse(readFileSync(join(root, '.agents/team.state.json'), 'utf8'));
    seeded.sessions['acme-web'].watch = { pid: 4242, heartbeat: '2026-10-03T14:01:30Z' };
    writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(seeded));
    const named = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = named;
    const second = testIo(root, { kind: 'owner' });
    const code2 = await runUp(FILE, second, sources({
      sessionState: () => 'running',
      alive: () => true,
      agents: named,
    }, made));
    expect(code2).toBe(0);
    // The three seat workspaces and the watch's, which the first run made.
    expect(made.creates).toHaveLength(4);
    expect(stateOf().sessions['acme-web']?.watchdog).toEqual({
      file: join(root, '.agents/team.yaml'),
      pane: 'w4:p1',
    });
  });

  test('a watch whose pid is dead is started again, and only it', async () => {
    await approve();
    seedState({
      'claude-coordinator-acme': { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 400, cli: [401] } },
      'deepseek-acme': { stage: 'ready', pane: 'w2:p1', workspace: 'w2', launched: { shell: 500, cli: [501] } },
      'deepseek-acme-2': { stage: 'ready', pane: 'w3:p1', workspace: 'w3', launched: { shell: 510, cli: [511] } },
    }, { pid: 4242, heartbeat: '2026-10-03T13:00:00Z' });
    const made = world();
    made.session = 'running';
    const listed = () => [
      agent('claude-coordinator-acme', 'w1:p1'),
      agent('deepseek-acme', 'w2:p1'),
      agent('deepseek-acme-2', 'w3:p1'),
    ];
    made.launch.agents = listed;
    made.launch.processInfo = (_session, pane) =>
      pane === 'w1:p1' ? { shell: 400, foreground: [400, 401] } :
      pane === 'w2:p1' ? { shell: 500, foreground: [500, 501] } :
      pane === 'w3:p1' ? { shell: 510, foreground: [510, 511] } : null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(FILE, io, sources({
      sessionState: () => 'running',
      alive: () => false,
      agents: listed,
      watchCommand: () => 'team watch',
    }, made));
    expect(code).toBe(0);
    // Only the watch's workspace is made, and the watch is typed into it: the seats
    // stay where they are.
    expect(made.creates).toEqual(['Watch · acme-web']);
    expect(made.runs.find((run) => run.command === 'team watch')).toBeDefined();
    expect(io.err).toContain('watch: started\n');
    expect(made.renames).toEqual([]);
    const seats = stateOf().sessions['acme-web']?.seats ?? {};
    expect(seats['claude-coordinator-acme']?.pane).toBe('w1:p1');
    expect(seats['deepseek-acme']?.pane).toBe('w2:p1');
    expect(seats['deepseek-acme-2']?.pane).toBe('w3:p1');
  });
});

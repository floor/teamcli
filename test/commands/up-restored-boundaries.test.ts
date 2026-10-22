// Adversarial boundaries for a restored session (#324): the promise is that a live seat is
// never closed, and that liveness is proven by the stored agent session over a pid mismatch —
// never by the surviving name alone, and never on the wrong pane. These scenes try to break it
// from both sides: a matching session that must NOT be adopted (wrong pane, or absent from this
// session's agent list), a surviving name on a dead shell that must STILL be closed, a restored
// seat whose screen reads working that must still not be closed or typed, and a dry run that
// closes nothing and prints the leave-it line for restored and doubt. No live herdr: every
// reading is a fixture. The happy paths live in live.test.ts; these are only the edges.
//
// Every scene starts from four seats recorded ready, each reading `same`, so the only seat that
// takes a recovery path is the one the scene breaks. The other three are never launched, closed
// or read for a screen: `same` leaves them be. deepseek-acme is the seat under test throughout.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { upFingerprint, OWNER_APPROVAL_ENV } from '../../src/approve/owner-token.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { approvalStanding } from '../../src/store/store.ts';
import { setHerdrRun, type HerdrAgent, type HerdrWorkspace, type PaneProcesses } from '../../src/herdr.ts';
import { readState, updateState } from '../../src/state.ts';
import { findAgent, registerAgent, updateAgent } from '../../src/registry/agents.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import type { Key } from '../../src/launch/terminal.ts';
import { UP_OUTPUT_SCHEMA } from '../../src/output/schema.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from '../helpers/output.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = CLAUDE_IDLE;

let base: string;
let root: string;
let home: string;

function makeExample(basePath: string, rootPath: string, text: string = EXAMPLE): string {
  return text.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restored-boundaries-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

/** A delegated run with the standing approval: its timeout is reported, never asked. */
function quietIo() {
  const standing = approvalStanding(root, home);
  if (standing.kind !== 'verified') throw new Error('the no-prompt run needs a verified approval');
  const io = testIo(root, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w91:p1', session: 'acme-web' });
  io.env[OWNER_APPROVAL_ENV] = upFingerprint(standing.record.approval.fingerprints, standing.generation);
  return io;
}

function agent(name: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

function doctor(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

type World = {
  launch: Launch;
  creates: string[];
  runs: { pane: string; command: string }[];
  renames: string[];
  closes: string[];
  deletes: string[];
  workspaceList(): HerdrWorkspace[];
  terminal: { keys: Key[]; reads: number; drains: number; key(ms: number): Promise<Key>; drain(): void };
  session: 'absent' | 'running' | 'stopped';
};

// A trimmed `world`: enough to launch fresh panes and record every close, run, create and key,
// so a scene can prove that none of them touched a seat that must be left as it is.
function world(): World {
  const state: World = {
    launch: {} as Launch,
    creates: [],
    runs: [],
    renames: [],
    closes: [],
    deletes: [],
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
    terminal: {
      keys: [],
      reads: 0,
      drains: 0,
      async key() {
        state.terminal.reads += 1;
        const next = state.terminal.keys.shift();
        if (next === undefined) throw new Error('the pause read the terminal, and no key was queued');
        return next;
      },
      drain() {
        state.terminal.drains += 1;
      },
    },
    session: 'running',
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { agent: boolean }>();
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { agent: false });
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
      return [`${workspace}:p1`];
    },
    paneText: () => IDLE,
    foreground: () => ['claude'],
    focus: () => true,
    deleteSession(session) {
      state.deletes.push(session);
      state.session = 'absent';
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
    terminal: () => made.terminal,
    ...extra,
  };
}

const seatsOf = () => readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};

// The four seats recorded ready, each with its pane, workspace and pids. Only deepseek-acme's
// record carries an agent session, and only when a scene stores one; the others read `same` and
// are left untouched. Pids and labels match the fixtures the close-path tests use.
const SEATS = {
  'claude-coordinator-acme': { pane: 'w91:p1', workspace: 'w91', label: 'Claude Opus 5.5', shell: 420, cli: 421, kind: 'claude' },
  'codex-acme': { pane: 'w92:p1', workspace: 'w92', label: 'GPT-6 Sol', shell: 410, cli: 411, kind: 'codex' },
  'deepseek-acme': { pane: 'w93:p1', workspace: 'w93', label: 'DeepSeek V4.1 Flash', shell: 430, cli: 431, kind: 'claude' },
  'deepseek-acme-2': { pane: 'w94:p1', workspace: 'w94', label: 'DeepSeek V4.1 Flash', shell: 440, cli: 441, kind: 'claude' },
} as const;

/** Writes the four-seat state alone. `session` is deepseek-acme's stored agent session, when a
 *  scene stores one; the other three never carry one (they read `same`, which does not need it). */
function writeSeats(session?: string): void {
  const seats: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(SEATS)) {
    seats[name] = {
      stage: 'ready',
      pane: s.pane,
      workspace: s.workspace,
      launched: { shell: s.shell, cli: [s.cli] },
      ...(name === 'deepseek-acme' && session ? { agent_session: session } : {}),
    };
  }
  writeFileSync(
    join(root, '.agents/team.state.json'),
    JSON.stringify({ format: 1, sessions: { 'acme-web': { seats, worktrees: {} } } }),
  );
}

/** deepseek-acme's registry record, written through the registry's own writer. */
function registerSeat(
  session: string,
  fields: { model?: string; version?: string; lab?: string; launch?: string; cli?: string } = {},
) {
  return registerAgent(home, {
    name: 'deepseek-acme',
    signing: {
      model: fields.model ?? 'Claude Opus',
      version: fields.version ?? '5.5',
      role: 'implementer',
    },
    lab: fields.lab ?? 'anthropic',
    cli: fields.cli ?? 'claude-code',
    launcher: null,
    launch: fields.launch ?? 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'deepseek-acme', session: 'acme-web', agent_session: session, pane: 'w93:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
}

/** The state and its record together, as most scenes need them. */
function writeState(session?: string, drift = false): void {
  writeSeats(session);
  if (session) {
    const registered = registerSeat(session, drift
      ? { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek' }
      : {});
    if (drift) updateAgent(home, registered.id, { reach: { pane: 'w93:p1' } });
  }
}

/** The readings for the three seats that must stay `same`, plus the agent list and workspaces
 *  herdr returns. A scene overlays the one reading that breaks deepseek-acme. */
function baseline() {
  const sameProcess = (pane: string): PaneProcesses | null => {
    for (const s of Object.values(SEATS)) if (s.pane === pane) return { shell: s.shell, foreground: [s.shell, s.cli] };
    return { shell: 700, foreground: [700, 701] };
  };
  const list = (): HerdrAgent[] => Object.entries(SEATS).map(([name, s]) => agent(name, s.pane, 'idle', s.kind));
  const workspaces = (): HerdrWorkspace[] => Object.values(SEATS).map((s) => ({ id: s.workspace, label: s.label }));
  return { sameProcess, list, workspaces };
}

describe('team up, a restored session: boundaries', () => {
  // Scene 4 — the stored session matches, but the live agent that carries it is on another pane.
  // `namedOnPane` is false, so this is doubt, not restored: the seat is not adopted onto the new
  // pane, nothing is closed, and the recorded pids are left exactly as they were.
  test('a matching session on a different pane is not adopted', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, workspaces } = baseline();
    const made = world();
    // A program is in front of the recorded pane (a pid mismatch → replaced).
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          // deepseek-acme's name, with the matching session, is on w99 — never the recorded w93.
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
            { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(keys).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    // The non-working doubt is refused and held: the plan's record says left out, the owner
    // summary counts one refusal with the seat's reason, and nothing was touched.
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    // Not adopted: the record still names the pane it was launched on, with its original pids
    // and session; the stray pane's pids never reach it.
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // Scene 4 — the stored session is present, but this session's agent list does not name the
  // seat at all (it lives in another herdr session). A program is in front: doubt, not restored.
  test("a matching session absent from this session's agent list is not adopted", async () => {
    await approve();
    writeState('kept');
    const { sameProcess, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces,
          // deepseek-acme is simply not in this session's list.
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // Scene 3 — the shell is in front (the program is gone). The seat's name survives on the
  // recorded pane and the stored session equals the live one: none of that is liveness. The
  // bare-shell close and the fresh launch still happen.
  test('a surviving name and a matching session on a bare shell is still closed and relaunched', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    // The shell is in front on the recorded pane: gone, whatever the agent list and session say.
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [900] } : sameProcess(pane));
    // The name is still listed on the recorded pane, carrying the stored session. The execute
    // close re-reads herdr through `launch.agents`, so planning and the close see the same list.
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    // Closed before its fresh launch — the matching name and session did not save a dead shell.
    expect(made.closes).toEqual(['w93']);
    expect(made.creates).toContain('deepseek-acme · implementer');
    expect(io.err).toContain('  its pane held no CLI; closed without input and launched again\n');
    expect(io.out).toContain('deepseek-acme: ready\n');
    // The fresh pane's identity replaces the record; it is not the old one.
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', launched: { shell: 700, cli: [701] } });
  });

  // Scene 5, under the restored verdict — the stored session matches, and the pane's screen
  // reads working. A restored seat is left on the strength of the session, screen notwithstanding:
  // nothing is closed, nothing is typed, and the record takes the pids the pane holds now.
  test('a restored seat whose screen reads working is still not closed or typed', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    made.launch.paneText = (_session, pane) => (pane === 'w93:p1' ? 'esc to interrupt' : IDLE);
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces,
          agents: () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, status: 'working', session: 'kept' } : a)),
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(keys).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(io.err).toContain('  restored; left as it is\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({
      stage: 'ready',
      pane: 'w93:p1',
      launched: { shell: 900, cli: [901] },
      agent_session: 'kept',
    });
  });

  test('a bare resume and one team up restore the signed model and the seat conversation without typing', async () => {
    await approve();
    writeState('kept', true);
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) =>
      pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane);
    const live = () => {
      const launched = made.runs.find((run) => run.command.includes('team-deepseek'));
      return launched
        ? [...list().filter((a) => a.name !== 'deepseek-acme'), { ...agent('deepseek-acme', launched.pane), session: 'kept' }]
        : list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    };
    made.launch.agents = live;
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual(['w93']);
    const seatLaunches = made.runs.filter((run) => run.command.includes('team-deepseek'));
    expect(seatLaunches).toHaveLength(1);
    expect(seatLaunches[0]?.command).toContain('--resume kept');
    expect(keys).toEqual([]);
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', agent_session: 'kept' });
    const record = findAgent(home, { team: teamIdOf(root), seat: 'deepseek-acme' });
    expect(record?.signing).toMatchObject({ model: 'DeepSeek Flash', version: 'V4.1' });
    expect(record?.reach.agent_session).toBe('kept');
  });

  // The release's recognition gap, closed through `up`: the state copy names no session (an
  // older record, or one written before the id was known), and the registry's binding is the
  // only proof the pane is the seat. The pane is adopted, nothing is closed or typed, and the
  // state heals to the conversation the record holds.
  test('a restored seat is recognized from the registry record when the state names no session', async () => {
    await approve();
    writeSeats();
    registerSeat('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    made.launch.agents = live;
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(keys).toEqual([]);
    expect(io.err).toContain('  restored; left as it is\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({
      stage: 'ready',
      pane: 'w93:p1',
      launched: { shell: 900, cli: [901] },
      agent_session: 'kept',
    });
    // The record the adoption read is still the seat's own, on the pane it was launched on.
    expect(findAgent(home, { team: teamIdOf(root), seat: 'deepseek-acme' })?.reach.agent_session).toBe('kept');
  });

  // The registry id alone never adopts a pane: the live session must be that id. A record
  // naming 'kept' beside a pane running 'other' is a doubt, and the state is not written.
  test('a registry record naming another session than the pane runs is not adopted', async () => {
    await approve();
    writeSeats();
    registerSeat('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'other' } : a));
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] } });
    expect(seatsOf()['deepseek-acme']?.agent_session).toBeUndefined();
  });

  // The state copy and the record disagree on the conversation. The state copy happens to equal
  // the live pane; that is not enough: neither record may speak for the seat, and nothing is
  // adopted, closed or written.
  test('a state copy naming another session than the record is still refused', async () => {
    await approve();
    writeSeats('state-copy');
    registerSeat('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'state-copy' } : a));
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({
      stage: 'ready',
      pane: 'w93:p1',
      launched: { shell: 430, cli: [431] },
      agent_session: 'state-copy',
    });
  });

  // The record belongs to another CLI. It is not this seat's record, so the state copy is not
  // allowed to overrule it either: no adoption, no write.
  test('a record for another CLI refuses even when the state copy matches the pane', async () => {
    await approve();
    writeSeats('kept');
    registerSeat('kept', { cli: 'codex' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('  its pane holds a process this record cannot tie to the launch\n');
    expect(io.err).toContain('0 seats repaired, 0 skipped (working), 1 refused (deepseek-acme: its pane holds a process this record cannot tie to the launch)\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // Item 3 through `up` with no state copy: a restored seat whose model drifted is closed
  // without input and relaunched through the record's launcher, never the bare CLI. The state
  // names no session, but the pane's live agent carries the record's id: the live proof is what
  // the relaunch resumes, so the conversation comes back with the model.
  test("a drifted restored seat relaunches through the record's launcher and resumes the conversation the pane proves", async () => {
    await approve();
    writeSeats();
    registerSeat('kept', { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => {
      const launched = made.runs.find((run) => run.command.includes('team-deepseek'));
      return launched
        ? [...list().filter((a) => a.name !== 'deepseek-acme'), { ...agent('deepseek-acme', launched.pane), session: 'kept' }]
        : list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    };
    made.launch.agents = live;
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual(['w93']);
    const seatLaunches = made.runs.filter((run) => run.command.includes('team-deepseek'));
    expect(seatLaunches).toHaveLength(1);
    // The record's launcher, then the id the live pane proved next to it.
    expect(seatLaunches[0]?.command).toContain('team-deepseek --resume kept');
    expect(keys).toEqual([]);
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', agent_session: 'kept' });
    expect(findAgent(home, { team: teamIdOf(root), seat: 'deepseek-acme' })?.signing).toMatchObject({
      model: 'DeepSeek Flash',
      version: 'V4.1',
    });
  });

  // The repair closes the old pane and takes the seat's state entry away; the fresh install had
  // already put the successor binding into that entry, and its settings file names it. The line
  // ran, so the state must name the incarnation the launched process loaded — never none.
  test('a repaired restored seat keeps the binding its fresh install minted once its line runs', async () => {
    await approve();
    writeSeats();
    updateState(join(root, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['deepseek-acme']!.presence_binding = 'prs_aaaaaaaaaaaa';
    });
    registerSeat('kept', { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => {
      const launched = made.runs.find((run) => run.command.includes('team-deepseek'));
      return launched
        ? [...list().filter((a) => a.name !== 'deepseek-acme'), { ...agent('deepseek-acme', launched.pane), session: 'kept' }]
        : list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    };
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual(['w93']);
    const settings = readFileSync(join(root, '.agents/hooks/acme-web/deepseek-acme.json'), 'utf8');
    const minted = /prs_[0-9a-f]{12}/.exec(settings)?.[0];
    expect(minted).toBeDefined();
    expect(minted).not.toBe('prs_aaaaaaaaaaaa');
    expect(seatsOf()['deepseek-acme']?.presence_binding).toBe(minted);
    expect(seatsOf()['deepseek-acme']?.stage).toBe('ready');
  });

  // The repair's line runs and the wait then reaches its deadline without a ready record: the
  // process still loaded the settings naming the successor, so the seat keeps it — attendance is
  // the paneRun, never the ready stage.
  test('a repaired seat whose line runs and then times out keeps the minted binding', async () => {
    await approve();
    writeSeats();
    updateState(join(root, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['deepseek-acme']!.presence_binding = 'prs_aaaaaaaaaaaa';
    });
    registerSeat('kept', { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => {
      const launched = made.runs.find((run) => run.command.includes('team-deepseek'));
      return launched
        ? [...list().filter((a) => a.name !== 'deepseek-acme'), { ...agent('deepseek-acme', launched.pane), session: 'kept' }]
        : list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    };
    made.launch.agents = live;
    // The new pane never draws the idle prompt: the wait goes to its deadline after the line ran.
    made.launch.paneText = (_session, pane) => (made.runs.some((run) => run.pane === pane) ? 'startup still drawing\n' : IDLE);
    // What the state says at every sleep of the readiness wait: the successor must already be
    // persisted there, while the stage is still launched, not only after the run ends.
    const duringWait: { stage: string | undefined; binding: string | undefined }[] = [];
    const rawSleep = made.launch.sleep;
    made.launch.sleep = async (ms) => {
      duringWait.push({ stage: seatsOf()['deepseek-acme']?.stage, binding: seatsOf()['deepseek-acme']?.presence_binding });
      await rawSleep(ms);
    };
    const io = quietIo();
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual(['w93']);
    expect(io.out).toContain('deepseek-acme: left out: timeout\n');
    const settings = readFileSync(join(root, '.agents/hooks/acme-web/deepseek-acme.json'), 'utf8');
    const minted = /prs_[0-9a-f]{12}/.exec(settings)?.[0];
    expect(minted).toBeDefined();
    expect(minted).not.toBe('prs_aaaaaaaaaaaa');
    expect(seatsOf()['deepseek-acme']?.stage).toBe('launched');
    expect(seatsOf()['deepseek-acme']?.presence_binding).toBe(minted);
    expect(duringWait.length).toBeGreaterThan(0);
    expect(duringWait.every((read) => read.stage === 'launched')).toBe(true);
    expect(duringWait.every((read) => read.binding === minted)).toBe(true);
  });

  // The same repair whose workspace is never made: the old pane was closed and its record
  // dropped, so no process carries the old binding any more, and the line never ran to load the
  // successor. The record the plan left says `launched` with no binding — not the dead old one.
  test('a repair whose relaunch never runs leaves the dropped record with no binding', async () => {
    await approve();
    writeSeats();
    updateState(join(root, '.agents'), (state) => {
      state.sessions['acme-web']!.seats['deepseek-acme']!.presence_binding = 'prs_aaaaaaaaaaaa';
    });
    registerSeat('kept', { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    made.launch.agents = live;
    made.launch.createWorkspace = () => null;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual(['w93']);
    expect(seatsOf()['deepseek-acme']?.stage).toBe('launched');
    expect(seatsOf()['deepseek-acme']?.presence_binding).toBeUndefined();
  });

  // The record's launcher names a conversation of its own. A repair through it would resume
  // something nothing proved and lose the one the pane does: the repair stops before its close,
  // the record stays as it was, and the fresh start is named as the caller's explicit choice.
  test('a drifted restored seat whose launcher selects another conversation is left as it is, never closed', async () => {
    await approve();
    writeSeats();
    registerSeat('kept', { model: 'DeepSeek Flash', version: 'V4.1', lab: 'deepseek', launch: 'team-deepseek --resume other' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const live = () => list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a));
    made.launch.agents = live;
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources({ sessionState: () => 'running', workspaces, agents: live, doctor: doctor() }, made),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
    expect(keys).toEqual([]);
    expect(io.err).toContain('  its recorded conversation cannot be resumed: its launch line resumes a different conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', launched: { shell: 430, cli: [431] } });
    expect(seatsOf()['deepseek-acme']?.agent_session).toBeUndefined();
  });

  // Scene 6 — a dry run touches nothing. deepseek-acme restored, deepseek-acme-2 doubt, and the
  // coordinator gone: the plan prints the leave-it line for the first two and the close line only
  // for the gone one, and the state file is byte for byte what it was.
  test('a dry run closes nothing and prints the leave-it line for restored and doubt', async () => {
    await approve();
    // deepseek-acme carries the stored session; a second record for deepseek-acme-2 does not.
    writeState('kept');
    const before = readFileSync(join(root, '.agents/team.state.json'), 'utf8');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w93:p1') return { shell: 900, foreground: [901] }; // restored: program, session kept
      if (pane === 'w94:p1') return { shell: 940, foreground: [941] }; // doubt: program, no session
      if (pane === 'w91:p1') return { shell: 910, foreground: [910] }; // gone: shell in front
      return sameProcess(pane);
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      ['--dry-run', ...FILE],
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces,
          agents: () =>
            list().map((a) => (a.name === 'deepseek-acme' ? { ...a, session: 'kept' } : a)),
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    // A dry run performs nothing: no close, no create, no run.
    expect(made.closes).toEqual([]);
    expect(made.creates).toEqual([]);
    expect(made.runs).toEqual([]);
    // The plan names the two leave-it lines, and the close only for the gone seat.
    expect(io.out).toContain('deepseek-acme: restored; left as it is');
    expect(io.out).toContain('deepseek-acme-2: its pane holds a process this record cannot tie to the launch');
    expect(io.out).toContain('closed without input: its pane no longer holds the process team launched');
    // Nothing was written: the restored seat's pids are still the stored ones, not re-recorded.
    expect(readFileSync(join(root, '.agents/team.state.json'), 'utf8')).toBe(before);
    expect(seatsOf()['deepseek-acme']).toMatchObject({ launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // Gap 4A — the host moved a ready seat onto another pane. The recorded pane holds no process
  // at all; the pane naming the seat is the seat only while its live session is the recorded
  // conversation. A free drifted model there is closed and relaunched, resuming it.
  test('a moved pane tied to the recorded session is repaired there and resumed', async () => {
    await approve();
    writeState('kept', true);
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w93:p1') return null; // the recorded pane is gone
      if (pane === 'w99:p1') return { shell: 750, foreground: [751] };
      return sameProcess(pane);
    };
    const live = () => [
      ...list().filter((item) => item.name !== 'deepseek-acme'),
      { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
    ];
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: live,
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    // Closed on the pane the seat actually holds now, and relaunched with its conversation.
    expect(made.closes).toEqual(['w99']);
    expect(made.runs.map((run) => run.command).some((command) => command.includes('--resume kept'))).toBe(true);
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready' });
  });

  // Gap 4A — the same moved pane on the recorded model: nothing is closed, and the record moves
  // to the pane the seat holds now, with that pane's process identity.
  test('a moved pane on the recorded model is adopted with its process identity', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w93:p1') return null;
      if (pane === 'w99:p1') return { shell: 750, foreground: [751] };
      return sameProcess(pane);
    };
    const live = () => [
      ...list().filter((item) => item.name !== 'deepseek-acme'),
      { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
    ];
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: live,
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
    expect(io.out).toContain('deepseek-acme: ready\n');
    expect(io.err).toContain('  restored; left as it is\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({
      stage: 'ready',
      pane: 'w99:p1',
      workspace: 'w99',
      launched: { shell: 750, cli: [751] },
      agent_session: 'kept',
    });
  });

  // Gap 4A — the moved pane cannot be tied to the recorded conversation: a doubt, held, and
  // nothing is closed or launched.
  test('a moved pane on another conversation is doubted, never closed', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'w93:p1') return null;
      if (pane === 'w99:p1') return { shell: 750, foreground: [751] };
      return sameProcess(pane);
    };
    const live = () => [
      ...list().filter((item) => item.name !== 'deepseek-acme'),
      { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'ses-foreign' },
    ];
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: live,
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
    expect(io.out).toContain('deepseek-acme: left out: its recorded pane is gone and the pane naming this seat cannot be tied to its recorded conversation; nothing closed\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1' });
  });

  // Gap 4A — the pane is gone and no name survived: the recorded conversation is resumed on a
  // fresh pane, and the recorded workspace, still listed by the host, is named and left.
  test('a missing pane resumes the recorded conversation on a fresh pane', async () => {
    await approve();
    writeState('kept', true);
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? null : sameProcess(pane));
    const live = () => list().filter((item) => item.name !== 'deepseek-acme');
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces,
          agents: live,
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    const resumed = made.runs.filter((run) => run.command.includes('--resume kept'));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.pane).toBe('w1:p1');
    expect(io.err).toContain('deepseek-acme: its recorded pane w93:p1 was gone and was replaced; its workspace w93 was left\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w1:p1' });
  });

  // Gap 4A — a proven conversation this seat's launch line cannot carry stops before anything
  // is launched: the record stays ready and the run exits 1 with the reason.
  test('a missing pane whose launch line cannot carry the conversation is left as it is', async () => {
    await approve();
    writeSeats('kept');
    registerSeat('kept', { launch: 'team-deepseek --continue' });
    const { sameProcess, list, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? null : sameProcess(pane));
    const live = () => list().filter((item) => item.name !== 'deepseek-acme');
    made.launch.agents = live;
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces,
          agents: live,
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(made.closes).toEqual([]);
    // Only the mandatory watch workspace exists; nothing was created for the seat.
    expect(made.creates.filter((label) => !label.startsWith('Watch · '))).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
    expect(io.err).toContain('  its recorded conversation cannot be resumed');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1' });
  });

  // The other side of the same doubt: the process in front of the record reads working. That
  // seat is left to finish its turn — a successful skip, exit 0, nothing closed or typed, its
  // record untouched — and the summary counts it as skipped working, not refused. The scene is
  // row 312's (a matching session on another pane); only the recorded pane's screen differs.
  test('a doubtful pane whose screen reads working is skipped, not refused', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    made.launch.paneText = (_session, pane) => (pane === 'w93:p1' ? 'esc to interrupt' : IDLE);
    const keys: string[] = [];
    made.launch.typeText = () => { keys.push('type'); return true; };
    made.launch.pressEnter = () => { keys.push('enter'); return true; };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
            { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(made.closes).toEqual([]);
    expect(keys).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    // The record is the working skip, not a left-out refusal.
    expect(io.out).toContain('deepseek-acme: ready\n');
    expect(io.err).toContain('  the process in its pane is working; nothing closed (stop it there, or run team remove deepseek-acme)\n');
    expect(io.err).toContain('0 seats repaired, 1 skipped (working), 0 refused\n');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // The refusal contract under `--json`: the non-working doubt (row 312's scene, a free screen)
  // is the run's own failure document, `up.pending`, whose message carries the refused count and
  // the seat's reason. Stderr stays empty, the record is left ready, and nothing is touched.
  test('a non-working doubt under --json is the up.pending error with the seat reason', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      ['--json', ...FILE],
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
            { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(1);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, {
      id: 'up.pending',
      messageContains: 'deepseek-acme: its pane holds a process this record cannot tie to the launch',
      repair: null,
    });
    expect(doc.error.message).toContain('1 refused');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });

  // And the working skip under `--json`: a success document, `team.up`, whose action summary and
  // restore buckets count the seat as skipped working — the same doubt, resolved the other way.
  test('a working doubt under --json is a team.up success counting it skipped', async () => {
    await approve();
    writeState('kept');
    const { sameProcess, workspaces } = baseline();
    const made = world();
    made.launch.processInfo = (_session, pane) => (pane === 'w93:p1' ? { shell: 900, foreground: [901] } : sameProcess(pane));
    made.launch.paneText = (_session, pane) => (pane === 'w93:p1' ? 'esc to interrupt' : IDLE);
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      ['--json', ...FILE],
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [...workspaces(), { id: 'w99', label: 'DeepSeek V4.1 Flash' }],
          agents: () => [
            agent('claude-coordinator-acme', 'w91:p1', 'idle'),
            agent('codex-acme', 'w92:p1', 'idle', 'codex'),
            agent('deepseek-acme-2', 'w94:p1', 'idle'),
            { ...agent('deepseek-acme', 'w99:p1', 'idle'), session: 'kept' },
          ],
          doctor: doctor(),
        },
        made,
      ),
    );
    expect(code).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      status: string;
      action_summary: string;
      notes: string[];
      restore_summary: { repaired: number; skipped_working: number; refused: number; line: string };
    }>(io.out, UP_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.action_summary).toBe('0 seats repaired, 1 skipped (working), 0 refused');
    expect(doc.restore_summary).toMatchObject({ repaired: 0, skipped_working: 1, refused: 0 });
    expect(doc.notes).toContain('deepseek-acme: ready');
    expect(made.closes).toEqual([]);
    expect(made.creates).not.toContain('deepseek-acme · implementer');
    expect(seatsOf()['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'w93:p1', launched: { shell: 430, cli: [431] }, agent_session: 'kept' });
  });
});

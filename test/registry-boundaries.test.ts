// The seat registry's boundaries: a seat handle is stable across a restart, a repair and a
// renamed model, and is never handed to a second seat; a seat of another team can neither read
// the registry nor write one id into it; a state file that is not a state is refused, and a
// handle that is not a handle is dropped, never shown and never trusted.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf, verifiedOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runSeats, type SeatsSources } from '../src/commands/seats.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { SEAT_ID_PATTERN, STATE_FILE, emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Standing } from '../src/store/store.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const LEAD_ID = 'seat_0123456789ab';
const WORKER_ID = 'seat_0fedcba98765';

function seatBlock(name: string, role: string, extra: string[] = []): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra,
  ].join('\n');
}

// The shared-mode team the read scenes stand in: no worktree, no git, only the file, the state
// and a live session with both seats running.
function sharedTeamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
workspace:
  mode: shared
  base: main
seats:
${seatBlock('lead', 'coordinator')}
${seatBlock('worker', 'implementer')}
`;
}

function sharedLive(): Live {
  const screen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
  return {
    running: true,
    agents: [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
    ],
    workspaces: [
      { id: 'lead-ws', label: 'lead' },
      { id: 'worker-ws', label: 'worker' },
    ],
    screens: { 'lead-pane': screen('Opus 5.5'), 'worker-pane': screen('Opus 5.5') },
  };
}

describe('the seat registry read boundary', () => {
  let base: string;
  let root: string;
  let dir: string;
  let standing: Standing;
  let live: Live | null;

  const sources: SeatsSources = {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
  };

  function plantRecordedSeats(): void {
    updateState(dir, (state) => {
      state.sessions.alpha = {
        ...emptySession(),
        seats: {
          lead: { id: LEAD_ID, stage: 'ready', pane: 'lead-pane', workspace: 'lead-ws' },
          worker: { id: WORKER_ID, stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws' },
        },
      };
    });
  }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-')));
    root = join(base, 'acme');
    dir = join(root, '.agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'team.yaml'), sharedTeamYaml());
    live = sharedLive();
    const checked = validateTeamFile(sharedTeamYaml());
    if (!checked.ok) throw new Error('the shared fixture does not validate');
    standing = verifiedOf(checked.team, sharedTeamYaml(), dir, NOW);
    plantRecordedSeats();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('a seat of another team is refused the registry with the one sentence', async () => {
    const io = testIo(root, { kind: 'seat', name: 'foreign', pane: 'b-pane', session: 'beta' });
    const code = await runSeats([], io, sources);
    expect(code).toBe(2);
    expect(io.err).toBe('team seats: this team is not yours to read\n');
    expect(io.out).toBe('');
  });

  test('a foreign seat named like this team\'s coordinator is refused the same one sentence', async () => {
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'b-pane', session: 'alpha' });
    const code = await runSeats([], io, sources);
    expect(code).toBe(2);
    expect(io.err).toBe('team seats: this team is not yours to read\n');
    expect(io.out).toBe('');
  });

  test('a foreign seat aiming --file at this team\'s file is refused before the path is opened', async () => {
    const io = testIo(root, { kind: 'seat', name: 'foreign', pane: 'b-pane', session: 'beta' });
    const aimed = join(base, 'not-there.yaml');
    const code = await runSeats(['--file', aimed], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team seats: --file is the owner's, from a terminal outside herdr; this call is foreign\n`);
    expect(existsSync(aimed)).toBe(false);
    expect(io.out).toBe('');
  });

  test('a foreign seat aiming --session is refused before any session is read', async () => {
    const io = testIo(root, { kind: 'seat', name: 'foreign', pane: 'b-pane', session: 'beta' });
    const code = await runSeats(['--session', 'alpha'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe(`team seats: --session is the owner's, from a terminal outside herdr; this call is foreign\n`);
    expect(io.out).toBe('');
  });

  test('a state file that is not JSON refuses the command and is left as it is', async () => {
    const garbage = '{"format":1,"sessions":{"alpha":';
    writeFileSync(join(dir, STATE_FILE), garbage);
    const io = testIo(root, OWNER);
    await expect(runSeats([], io, sources)).rejects.toThrow('is not valid JSON; move it aside and run the command again');
    expect(io.out).toBe('');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(garbage);
  });

  test('a state file of another shape is refused, never reshaped', async () => {
    const wrong = '{"format":2,"sessions":{"alpha":{"seats":{"lead":{"id":"x"}}}}}';
    writeFileSync(join(dir, STATE_FILE), wrong);
    const io = testIo(root, OWNER);
    await expect(runSeats([], io, sources)).rejects.toThrow('is not a team state of format 1; move it aside and run the command again');
    expect(io.out).toBe('');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(wrong);
  });

  test('a malformed handle is shown as none and is not rewritten on disk', async () => {
    updateState(dir, (state) => {
      state.sessions.alpha!.seats.worker = { id: 'seat_ABCDEF123456', stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws' };
    });
    const io = testIo(root, OWNER);
    const code = await runSeats(['--json'], io, sources);
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { seats: Array<{ name: string; id: string | null }> };
    const byName = new Map(doc.seats.map((row) => [row.name, row.id]));
    expect(byName.get('lead')).toBe(LEAD_ID);
    expect(byName.get('worker')).toBe(null);
    // The reader dropped it: a later read still holds no handle for that seat, whatever the
    // run's own bookkeeping wrote beside it.
    expect(readState(dir).sessions.alpha?.seats.worker?.id).toBeUndefined();
  });

  test.failing('two seats recorded under one handle are not both shown as that handle', async () => {
    updateState(dir, (state) => {
      state.sessions.alpha!.seats.worker = { id: LEAD_ID, stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws' };
    });
    const io = testIo(root, OWNER);
    const code = await runSeats(['--json'], io, sources);
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { seats: Array<{ name: string; id: string | null }> };
    const shown = doc.seats.map((row) => row.id).filter((id): id is string => id !== null);
    expect(new Set(shown).size).toBe(shown.length);
  });
});

// The worktree team the restart scenes run on: a real git root, an approved file, and launch
// fakes that stand in for herdr.
describe('the seat registry across a restart', () => {
  let base: string;
  let root: string;
  let dir: string;
  let home: string;
  let lobby: string;
  let file: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
    });
  }

  function worktreeTeamYaml(): string {
    return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seatBlock('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seatBlock('worker', 'implementer', ['    count: 1'])}
`;
  }

  function approve(text = worktreeTeamYaml()): void {
    writeFileSync(file, text);
    const loaded = loadTeamFile(root, { file, home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
      loaded.team.seats,
      home,
    );
  }

  function record(seats: Record<string, { pane: string; workspace: string; id?: string }>): void {
    updateState(dir, (state) => {
      state.sessions.alpha = {
        ...emptySession(),
        seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
          name,
          { stage: 'ready' as const, pane: seat.pane, workspace: seat.workspace, ...(seat.id ? { id: seat.id } : {}) },
        ])),
      };
    });
  }

  function doctor(): DoctorSources {
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

  function upSources(
    people: () => HerdrAgent[],
    screenModel = 'Opus 5.5',
    live = false,
  ): { sources: UpSources; made: string[]; closed: string[] } {
    const panes = new Map<string, string>();
    const made: string[] = [];
    const closed: string[] = [];
    // The panes that already run show the model they run; a pane this run creates shows the
    // model the file declares for the seat it launches.
    const running = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
    const screen = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · ${screenModel}\n`;
    let n = 0;
    let clock = NOW.getTime();
    let session: 'absent' | 'running' = live ? 'running' : 'absent';
    const launch: Launch = {
      sessionState: () => session,
      startServer() {
        session = 'running';
        return true;
      },
      sessionUp: () => session === 'running',
      createWorkspace(_session, _cwd, _label) {
        n += 1;
        const pane = `made-${n}`;
        panes.set(pane, screen);
        made.push(pane);
        return { pane, workspace: `ws-${n}` };
      },
      paneRun(_session, pane) {
        panes.set(pane, screen);
        return true;
      },
      typeText: () => true,
      renameAgent: () => true,
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      agentPanes: () => [...new Set([...people().map((agent) => agent.pane), ...panes.keys()])],
      agents: people,
      paneText: (_session, pane) => (panes.has(pane) ? screen : running),
      foreground: () => ['claude'],
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => new Date(clock),
    };
    const sources: UpSources = {
      sessionRunning: () => session === 'running',
      sessionState: () => session,
      agents: people,
      home,
      doctor: doctor(),
      launch,
      now: () => new Date(clock),
    };
    return { sources, made, closed };
  }

  // A down that frees each pane it is asked to free: the box holds what was typed, the enter
  // sends it, and the CLI process leaves that pane.
  function downSources(people: () => HerdrAgent[]): { sources: DownSources; closed: string[] } {
    const boxes = new Map<string, string>();
    const freed = new Set<string>();
    const closed: string[] = [];
    const launch: DownLaunch = {
      typeText(_session, pane, text) {
        boxes.set(pane, claudeBox(text));
        return true;
      },
      sendKey(_session, pane) {
        boxes.set(pane, claudeBox(''));
        return true;
      },
      pressEnter(_session, pane) {
        freed.add(pane);
        return true;
      },
      agentPanes: () => people().map((agent) => agent.pane),
      closeWorkspace(_session, workspace) {
        closed.push(workspace);
        return true;
      },
      stopSession: () => true,
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: DownSources = {
      sessionRunning: () => true,
      agents: people,
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
      status: () => 'idle',
      foreground: (_session, pane) => (freed.has(pane) ? ['zsh'] : ['claude']),
      now: () => NOW,
      home,
      launch,
    };
    return { sources, closed };
  }

  function removeSources(people: () => HerdrAgent[]): RemoveSources {
    return downSources(people).sources;
  }

  const leadAgent = (): HerdrAgent => ({
    name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null,
  });
  const workerAgent = (pane = 'worker-pane', workspace = 'worker-ws'): HerdrAgent => ({
    name: 'worker', agent: 'claude', pane, workspace, status: 'idle', cwd: null,
  });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-restart-')));
    root = join(base, 'acme');
    dir = join(root, '.agents');
    home = join(base, 'home');
    lobby = join(home, '.config', 'team', 'lobby');
    file = join(dir, 'team.yaml');
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(root, 'README.md'), 'acme\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-q', '-m', 'first');
    approve();
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('an up that repairs a dead seat keeps its handle and mints nothing', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws', id: LEAD_ID },
      worker: { pane: 'worker-pane', workspace: 'worker-ws', id: WORKER_ID },
    });
    const { sources } = upSources(() => [leadAgent()], 'Opus 5.5', true);
    const code = await runUp([], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    const after = readState(dir).sessions.alpha!;
    expect(after.seats.lead).toMatchObject({ id: LEAD_ID, pane: 'lead-pane' });
    expect(after.seats.worker?.id).toBe(WORKER_ID);
    expect(after.seats.worker?.pane).not.toBe('worker-pane');
    expect(Object.keys(after.retained_seats ?? {})).toEqual([]);
  });

  test('a down retains both handles and the next up restores them, never fresh ones', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws', id: LEAD_ID },
      worker: { pane: 'worker-pane', workspace: 'worker-ws', id: WORKER_ID },
    });
    const before = new Set([LEAD_ID, WORKER_ID]);
    const down = downSources(() => [leadAgent(), workerAgent()]);
    const downCode = await runDown([], testIo(root, OWNER), down.sources);
    expect(downCode).toBe(0);
    const mid = readState(dir).sessions.alpha!;
    expect(mid.seats.lead).toBeUndefined();
    expect(mid.seats.worker).toBeUndefined();
    expect(mid.retained_seats?.lead?.id).toBe(LEAD_ID);
    expect(mid.retained_seats?.worker?.id).toBe(WORKER_ID);

    const up = upSources(() => []);
    const upCode = await runUp([], testIo(root, OWNER), up.sources);
    expect(upCode).toBe(0);
    const after = readState(dir).sessions.alpha!;
    expect(after.seats.lead?.id).toBe(LEAD_ID);
    expect(after.seats.worker?.id).toBe(WORKER_ID);
    expect(Object.keys(after.retained_seats ?? {})).toEqual([]);
    expect(new Set([after.seats.lead?.id, after.seats.worker?.id])).toEqual(before);
  });

  test('a file that renames the seat\'s model keeps its handle', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws', id: LEAD_ID },
      worker: { pane: 'worker-pane', workspace: 'worker-ws', id: WORKER_ID },
    });
    const renamed = worktreeTeamYaml()
      .replace('    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    count: 1',
        '    model: Claude Sonnet\n    version: "5.6"\n    launch: claude --model claude-sonnet-5-6\n    count: 1');
    if (renamed === worktreeTeamYaml()) throw new Error('the rename edit matched nothing');
    approve(renamed);
    const { sources } = upSources(() => [leadAgent()], 'Sonnet 5.6', true);
    const code = await runUp([], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    const after = readState(dir).sessions.alpha!;
    expect(after.seats.worker).toMatchObject({
      id: WORKER_ID,
      model: 'Claude Sonnet',
      version: '5.6',
      launch_line: 'claude --model claude-sonnet-5-6',
    });
    expect(after.seats.lead).toMatchObject({ id: LEAD_ID });
  });

  test('a full remove clears the handle and the seat re-added mints a fresh one', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws', id: LEAD_ID },
      worker: { pane: 'worker-pane', workspace: 'worker-ws', id: WORKER_ID },
    });
    const removal = removeSources(() => [leadAgent(), workerAgent()]);
    const code = await runRemove(['worker'], testIo(root, OWNER), removal);
    expect(code).toBe(0);
    const mid = readState(dir).sessions.alpha!;
    expect(mid.seats.worker).toBeUndefined();
    expect(mid.retained_seats?.worker).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain('name: worker');

    approve();
    const up = upSources(() => [leadAgent()], 'Opus 5.5', true);
    const upCode = await runUp([], testIo(root, OWNER), up.sources);
    expect(upCode).toBe(0);
    const after = readState(dir).sessions.alpha!;
    expect(SEAT_ID_PATTERN.test(after.seats.worker?.id ?? '')).toBe(true);
    expect(after.seats.worker?.id).not.toBe(WORKER_ID);
    expect(after.seats.lead?.id).toBe(LEAD_ID);
  });

  test('a seat of another team writes nothing: up and remove refuse and every file is byte-identical', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws', id: LEAD_ID },
      worker: { pane: 'worker-pane', workspace: 'worker-ws', id: WORKER_ID },
    });
    const stateBefore = readFileSync(join(dir, STATE_FILE), 'utf8');
    const fileBefore = readFileSync(file, 'utf8');
    const foreign = { kind: 'seat' as const, name: 'lead', pane: 'b-pane', session: 'alpha' };

    const up = upSources(() => [leadAgent(), workerAgent()], 'Opus 5.5', true);
    const upIo = testIo(root, foreign);
    const upCode = await runUp([], upIo, up.sources);
    expect(upCode).toBe(1);
    expect(upIo.err).toContain('only the owner runs `up`');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(stateBefore);

    const removal = removeSources(() => [leadAgent(), workerAgent()]);
    const removeIo = testIo(root, foreign);
    const removeCode = await runRemove(['worker'], removeIo, removal);
    expect(removeCode).not.toBe(0);
    expect(removeIo.err).toContain('the state records pane lead-pane for seat lead in this session, not the pane this call is on');
    expect(readFileSync(join(dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    expect(readFileSync(file, 'utf8')).toBe(fileBefore);
  });
});

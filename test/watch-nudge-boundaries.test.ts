// The watch types a nudge into an idle seat's pane itself. The boundaries of that typing, at the
// pass and at the command: a working seat, a seat holding text, a dialog, a question or a shell is
// never typed into; a lead, a parked or stopped seat and a temporary one are never the seat the
// nudge means; the pane is the seat's live one, never a renamed stranger's; the thresholds hold —
// the fallback fires once at nudge_wait and a delivered nudge never repeats; and `up` starts the
// watch as a process with no pane of its own, never over a live one, while a second watch is
// refused and the recorded pid runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, NUDGE_TEXT, pass } from '../src/watch/pass.ts';
import { testIo } from './helpers.ts';

// The example with an operator seat of its own, so the leads are two named seats and the workers
// stand apart: the file's `operator` names the operator, not the coordinator.
const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`).replace('  seats: 6', '  seats: 8');

// Both deepseek seats parked, and both stopped: the one seat block the count expands from.
const COUNT = '    count: 2                   # deepseek-acme, deepseek-acme-2';
const parkedDeepseek = example.replace(COUNT, `${COUNT}\n    parked: true`);
const stoppedDeepseek = example.replace(COUNT, `${COUNT}\n    stopped: true`);

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

// Screens of Claude Code, as the live team shows them.
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const unsent = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

function agent(name: string | null, workspace: string, status: string, kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team: the operator idle at an empty prompt, the coordinator — a lead — blocked
// at a question (its report is what waits for a nudge), the parked codex seat listed, both
// deepseek seats working.
function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-operator-acme', 'w0', 'idle', idle],
    ['claude-coordinator-acme', 'w1', 'blocked', question],
    ['codex-acme', 'w2', 'working', ''],
    ['deepseek-acme', 'w3', 'working', busy],
    ['deepseek-acme-2', 'w4', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status, name.startsWith('codex') ? 'codex' : 'claude'));
    screens[`${workspace}:p1`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

// The report that asks for a nudge, in every scene below: the coordinator's question. Its word is
// the operator's to act on, and the nudge it raises is typed into a worker, never back into it.
const blocked = live();
const ASKED = 'claude-coordinator-acme asked a question: the operator\'s to act on';

function nudgeOf(team: TeamFile, scene: Live, memory: ReturnType<typeof newMemory>, now: number) {
  return pass({ team, watch: team.watch, state: emptySession(), live: scene, machine: fine, now, memory }).nudge;
}

describe('the seat the nudge is typed into', () => {
  test('a working seat is never the nudge; the idle seat beside it is', () => {
    const scene = live({
      'deepseek-acme': { status: 'working', screen: busy },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(nudgeOf(teamOf(example), scene, newMemory(), 0)).toEqual({
      pane: 'w4:p1', seat: 'deepseek-acme-2', cli: 'claude-code', text: NUDGE_TEXT, pending: [ASKED],
    });
  });

  test('the seat idle longest is chosen; a tie goes to the name', () => {
    // Both idle from the start: nothing tells them apart, and the name decides.
    const tied = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(nudgeOf(teamOf(example), tied, newMemory(), 0)?.seat).toBe('deepseek-acme');
    // The second seat stopped working a pass before the first: it is idle the longer.
    const memory = newMemory();
    nudgeOf(teamOf(example), live(), memory, 0);
    nudgeOf(teamOf(example), live({
      'deepseek-acme': { status: 'working', screen: busy },
      'deepseek-acme-2': { status: 'idle', screen: question },
    }), memory, MIN);
    const later = live({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(nudgeOf(teamOf(example), later, memory, 2 * MIN)?.seat).toBe('deepseek-acme-2');
  });

  test('an idle lead is never the nudge: nothing is typed, and the fallback fires once, at nudge_wait and never before', () => {
    const memory = newMemory();
    // The operator sits idle at an empty prompt — free to any eye but the watch's, which never
    // types into a lead; every worker works.
    expect(pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: blocked, machine: fine, now: 0, memory }).nudge).toBeNull();
    const before = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: blocked, machine: fine, now: 10 * MIN - 1000, memory });
    expect(before.nudge).toBeNull();
    expect(before.fallback).toBeNull();
    const at = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: blocked, machine: fine, now: 10 * MIN, memory });
    expect(at.nudge).toBeNull();
    expect(at.fallback).toBe(`no idle seat could be nudged for 10 minutes; 1 report(s) wait: ${ASKED}`);
    // The fallback said it, the report was answered for, and neither repeats.
    const again = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: blocked, machine: fine, now: 12 * MIN, memory });
    expect(again.nudge).toBeNull();
    expect(again.fallback).toBeNull();
  });

  test('a parked seat at an empty prompt is never the nudge; unparked, the same scene is typed into', () => {
    const scene = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    expect(nudgeOf(teamOf(parkedDeepseek), scene, newMemory(), 0)).toBeNull();
    expect(nudgeOf(teamOf(example), scene, newMemory(), 0)?.seat).toBe('deepseek-acme');
  });

  test('a stopped seat started by hand is never the nudge; running, the same scene is typed into', () => {
    const scene = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    expect(nudgeOf(teamOf(stoppedDeepseek), scene, newMemory(), 0)).toBeNull();
    expect(nudgeOf(teamOf(example), scene, newMemory(), 0)?.seat).toBe('deepseek-acme');
  });

  test('a temporary seat is never the nudge; the file\'s own seat is', () => {
    const state = emptySession();
    state.seats['deepseek-tmp'] = {
      stage: 'ready', pane: 'w9:p1', workspace: 'w9',
      temporary: { like: 'deepseek-acme', until: '2026-10-03T20:00:00Z' },
    };
    const withTemp = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    withTemp.agents.push(agent('deepseek-tmp', 'w9', 'idle'));
    withTemp.screens['w9:p1'] = idle;
    const chosen = pass({ team: teamOf(example), watch: teamOf(example).watch, state, live: withTemp, machine: fine, now: 0, memory: newMemory() });
    expect(chosen.nudge?.seat).toBe('deepseek-acme');
    expect(chosen.nudge?.pane).toBe('w3:p1');
    // The temporary seat idle alone, every file seat busy: still never it.
    const only = live({ 'deepseek-acme': { status: 'working', screen: busy } });
    only.agents.push(agent('deepseek-tmp', 'w9', 'idle'));
    only.screens['w9:p1'] = idle;
    expect(pass({ team: teamOf(example), watch: teamOf(example).watch, state, live: only, machine: fine, now: 0, memory: newMemory() }).nudge).toBeNull();
  });

  test('a question is never typed into, and neither is a shell prompt', () => {
    // herdr calls both idle; the screen says a key would answer a dialog, or land in a shell.
    const atQuestion = live({ 'deepseek-acme': { status: 'idle', screen: question } });
    expect(nudgeOf(teamOf(example), atQuestion, newMemory(), 0)).toBeNull();
    const atShell = live({ 'deepseek-acme': { status: 'idle', screen: 'dev@mac acme % ' } });
    expect(nudgeOf(teamOf(example), atShell, newMemory(), 0)).toBeNull();
  });

  test('a seat holding unsent text is passed over for the idle seat, never typed into', () => {
    const scene = live({
      'deepseek-acme': { status: 'idle', screen: unsent },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(nudgeOf(teamOf(example), scene, newMemory(), 0)?.seat).toBe('deepseek-acme-2');
  });

  test('herdr\'s idle word is not enough: a screen mid-turn is never typed into', () => {
    const scene = live({
      'deepseek-acme': { status: 'idle', screen: busy },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(nudgeOf(teamOf(example), scene, newMemory(), 0)?.seat).toBe('deepseek-acme-2');
    const alone = live({
      'deepseek-acme': { status: 'idle', screen: busy },
      'deepseek-acme-2': { status: 'working', screen: busy },
    });
    expect(nudgeOf(teamOf(example), alone, newMemory(), 0)).toBeNull();
  });
});

describe('the pane the nudge means', () => {
  test('a renamed pane is never the seat: the name gone from herdr, nothing is typed into it', () => {
    const scene = live();
    // The seat's pane keeps its idle prompt, but answers to another name now.
    scene.agents = scene.agents.map((one) => (one.name === 'deepseek-acme' ? { ...one, name: 'somebody-else' } : one));
    scene.screens['w3:p1'] = idle;
    const memory = newMemory();
    const result = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: scene, machine: fine, now: 0, memory });
    expect(result.nudge).toBeNull();
    // The pane was noticed — as somebody else's, running and not in the file — and its report
    // waits with the rest rather than being typed anywhere.
    expect(result.reports.map((report) => report.text).join('\n')).toContain('somebody-else');
    expect(memory.pending.length).toBeGreaterThan(0);
  });

  test('the nudge aims at the seat\'s live pane, never the pane recorded at launch', () => {
    const scene = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    scene.agents = scene.agents.map((one) => (one.name === 'deepseek-acme' ? { ...one, workspace: 'w8', pane: 'w8:p1' } : one));
    scene.screens['w8:p1'] = idle;
    const state = emptySession();
    state.seats['deepseek-acme'] = { stage: 'ready', pane: 'w3:p1', workspace: 'w3' };
    const result = pass({ team: teamOf(example), watch: teamOf(example).watch, state, live: scene, machine: fine, now: 0, memory: newMemory() });
    expect(result.nudge?.seat).toBe('deepseek-acme');
    expect(result.nudge?.pane).toBe('w8:p1');
  });
});

describe('its thresholds', () => {
  test('a delivered nudge clears its reports: the same report never nudges again', () => {
    const memory = newMemory();
    const scene = live({ 'deepseek-acme': { status: 'idle', screen: idle } });
    const first = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: scene, machine: fine, now: 0, memory });
    expect(first.nudge?.pending).toEqual([ASKED]);
    expect(memory.pending).toEqual([]);
    // The condition still holds — the report-once rule keeps it quiet — and nothing is owed.
    const second = pass({ team: teamOf(example), watch: teamOf(example).watch, state: emptySession(), live: scene, machine: fine, now: 2 * MIN, memory });
    expect(second.nudge).toBeNull();
    expect(second.fallback).toBeNull();
  });
});

// `up` and the watch command: the watch is a process now, with no pane of its own.
const NOW = new Date('2026-10-03T14:02:00Z');
const SESSION = 'acme-web';
// The screen a launched seat settles at: an idle prompt, ready for the operator.
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function fresh(): { base: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-nudge-bounds-')));
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  chmodSync(lobbyDir(home), 0o700);
  return { base, home };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function teamText(root: string): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: claude-coordinator-acme
operator: claude-operator-acme
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
seats:
  - role: coordinator
    name: claude-coordinator-acme
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: claude-operator-acme
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

function approve(cwd: string, file: string, home: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(cwd, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

// The launch as a fake herdr: workspaces it created, commands its panes ran, and watches it
// spawned — with no pane, because the plan gives the watch none.
function world(): {
  launch: Launch;
  creates: { label: string; cwd: string }[];
  watches: { command: string; cwd: string }[];
} {
  const creates: { label: string; cwd: string }[] = [];
  const watches: { command: string; cwd: string }[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false });
      creates.push({ label, cwd });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, _command) {
      panes.get(pane)!.agent = true;
      return true;
    },
    spawnWatch(command, cwd) {
      watches.push({ command, cwd });
      return 4242;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { launch, creates, watches };
}

function upSources(home: string, made: ReturnType<typeof world>, alive?: (pid: number) => boolean): UpSources {
  return {
    sessionRunning: () => made.launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: made.launch.now,
    sleep: made.launch.sleep,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home,
    },
    launch: made.launch,
    ...(alive ? { alive } : {}),
  };
}

function watchSources(home: string, over: Partial<WatchSources> = {}): WatchSources {
  return {
    live: () => ({ running: false, agents: [], workspaces: [], screens: {}, processes: {} }),
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }) as Standing,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
    ...over,
  };
}

describe('the watch `up` starts', () => {
  test('no workspace of its own: spawned in the folder, file and pid recorded in the state', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    approve(root, custom, home, teamText(customDir));

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made));
    expect(code, io.out + io.err).toBe(0);
    // The watch is a process: the only workspaces made are seats', and no pane is recorded for it.
    expect(made.creates.map((one) => one.label)).toEqual(['coordinator', 'operator']);
    const watch = made.watches[0];
    expect(watch?.cwd).toBe(customDir);
    expect(watch?.command).toContain(' watch');
    expect(watch?.command).toContain(`--session ${SESSION}`);
    expect(watch?.command).not.toContain('--file');
    expect(io.err).toContain('watch: started\n');
    const state = readState(customDir).sessions[SESSION];
    expect(state?.watchdog).toEqual({ file: custom });
    expect(state?.watch?.pid).toBe(4242);
    expect(state?.watch?.heartbeat).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('a watch whose pid is alive is never spawned over', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    approve(root, custom, home, teamText(customDir));
    updateState(customDir, (state) => {
      (state.sessions[SESSION] ??= emptySession()).watch = { pid: 99, heartbeat: '2026-10-03T14:01:00Z' };
    });

    const made = world();
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(['--file', custom], io, upSources(home, made, (pid) => pid === 99));
    expect(code, io.out + io.err).toBe(0);
    expect(made.watches).toEqual([]);
    expect(io.err).not.toContain('watch: started');
    expect(readState(customDir).sessions[SESSION]?.watch?.pid).toBe(99);
  });
});

describe('a second watch', () => {
  test('is refused, and the recorded pid itself runs with no pane of its own', async () => {
    const { home } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    const customDir = join(root, 'custom');
    const custom = join(customDir, 'team.yaml');
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root));
    approve(root, custom, home, teamText(customDir));
    updateState(customDir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.watchdog = { file: custom };
      session.watch = { pid: 99, heartbeat: '2026-10-03T14:01:00Z' };
    });

    // A second watch — a process with no pane and not the recorded pid — types nothing and reads
    // nothing: a run outside herdr with no terminal is the owner's to make, and this one is not.
    const second = testIo(customDir, { kind: 'owner-no-tty' });
    const refused = await runWatch(['--session', SESSION], second, watchSources(home, { alive: () => true }));
    expect(refused).toBe(1);
    expect(second.err).toContain('only the owner runs this, from a terminal outside herdr');

    // The recorded pid itself: no pane, no terminal, and the pid is the whole of its grant.
    updateState(customDir, (state) => {
      const session = state.sessions[SESSION];
      if (session?.watch) session.watch.pid = process.pid;
    });
    const own = testIo(customDir, { kind: 'owner-no-tty' });
    const ran = await runWatch(['--session', SESSION], own, watchSources(home, { alive: () => true, pid: process.pid }));
    expect(ran, own.out + own.err).toBe(0);
    expect(own.out).toContain(`watching the session "${SESSION}"`);
    expect(readState(customDir).sessions[SESSION]?.watchdog).toEqual({ file: custom });
  });
});

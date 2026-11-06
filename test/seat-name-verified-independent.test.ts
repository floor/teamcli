// Naming is verified from the agent list, and an unnamed pane is placed only by
// its recorded shell. The host, the process table and the clock are synthetic.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { agentRename, setHerdrCapture, setHerdrRun } from '../src/herdr.ts';
import type { CallerSources } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type UpSeat } from '../src/launch/plan.ts';
import { placementAtStart, placementOf, SERVE_PLACEMENT_WAIT_MS } from '../src/mcp/serve.ts';
import { updateState, type SeatState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, testIo } from './helpers.ts';

const SESSION = 'home-session';
const SEAT = 'keeper';
const OTHER = 'worker';
const PANE = 'fixture-pane-one';
const OTHER_PANE = 'fixture-pane-two';
const WORKSPACE = 'fixture-workspace';
const SHELL = 7001;
const CLI = 7002;
const START = 1_760_000_000_000;
const UNNAMED = 'whose agent has no herdr name';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function seat(): UpSeat {
  return {
    name: SEAT,
    cli: 'claude-code',
    launch: 'claude --model claude-sonnet-5-5',
    cwd: '.',
    label: SEAT,
    repairLine: '',
    stopped: false,
    rules: '',
  };
}

type Recorded = { seat: string; stage: string };
type Event = { kind: 'record'; stage: string } | { kind: 'rename' } | { kind: 'list' };

function launchWorld(nameOf: (taken: boolean) => string | null): {
  host: Host;
  renames: () => number;
  records: Recorded[];
  events: Event[];
  said: string[];
} {
  let clock = 0;
  let renames = 0;
  let taken = false;
  const records: Recorded[] = [];
  const events: Event[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      events.push({ kind: 'rename' });
      renames += 1;
      taken = true;
      return true;
    },
    agentList: () => {
      events.push({ kind: 'list' });
      return [{
        name: nameOf(taken),
        agent: 'claude',
        pane: PANE,
        workspace: WORKSPACE,
        status: 'idle',
        cwd: null,
      }];
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['claude'],
    processInfo: () => ({ shell: SHELL, foreground: [CLI] }),
    classify: () => 'idle',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    allow: () => null,
    record: (name, patch) => {
      records.push({ seat: name, stage: patch.stage });
      events.push({ kind: 'record', stage: patch.stage });
    },
    running: () => {},
    drop: () => {},
    say: (line) => { said.push(line); },
    log: () => {},
  };
  return { host, renames: () => renames, records, events, said };
}

type Live = {
  name: string | null;
  ancestors: { pid: number; name: string }[];
  root: number | null;
  shell: number;
  start: number | null;
  hint: string;
};

function placeWorld(
  seats: Record<string, SeatState>,
  extra: Partial<Live> = {},
): { dir: string; live: Live; io: Io } {
  const base = fixtureBase('seat-name-');
  scratchParent ??= dirname(base);
  made.push(base);
  const dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
  updateState(dir, (state) => {
    state.sessions[SESSION] = { seats, worktrees: {} };
  });
  const live: Live = {
    name: null,
    ancestors: [
      { pid: CLI, name: 'claude' },
      { pid: SHELL, name: 'shell' },
      { pid: 8100, name: 'herdr' },
      { pid: 1, name: 'init' },
    ],
    root: SHELL,
    shell: SHELL,
    start: START,
    hint: PANE,
    ...extra,
  };
  const io = testIo(dir);
  io.env = { HERDR_PANE_ID: live.hint };
  io.callerSources = (): CallerSources => ({
    ancestors: () => live.ancestors,
    agents: () => [{
      name: live.name,
      agent: 'claude',
      pane: PANE,
      workspace: WORKSPACE,
      status: 'idle',
      cwd: null,
    }],
    paneRootPid: (pane) => (pane === PANE ? live.root : null),
    env: io.env,
    stdinIsTTY: false,
    paneProcesses: (pane) => (pane === PANE ? { shell: live.shell, foreground: [CLI] } : null),
    processStartOf: () => live.start,
  });
  return { dir, live, io };
}

function anchored(): SeatState {
  return { stage: 'launched', pane: PANE, pane_shell: SHELL, pane_shell_start: START };
}

describe('verified naming', () => {
  test('a rename the host accepts is a name only after the list shows it', async () => {
    const world = launchWorld((taken) => (taken ? SEAT : null));
    await executePlan(upPlan({
      root: 'fixture-root',
      session: SESSION,
      sessionRunning: true,
      seats: [seat()],
      watchLabel: 'Watch',
      startWatch: false,
    }), SESSION, world.host);
    const launchedAt = world.events.findIndex((event) => event.kind === 'record' && event.stage === 'launched');
    const renameAt = world.events.findIndex((event) => event.kind === 'rename');
    expect(launchedAt).toBeGreaterThanOrEqual(0);
    expect(renameAt).toBeGreaterThan(launchedAt);
    expect(world.events.slice(renameAt + 1).some((event) => event.kind === 'list')).toBe(true);
    expect(world.records.some((record) => record.stage === 'ready')).toBe(true);
  });

  test('a rename the host accepts but never lists leaves the seat unnamed', async () => {
    const world = launchWorld(() => null);
    await executePlan(upPlan({
      root: 'fixture-root',
      session: SESSION,
      sessionRunning: true,
      seats: [seat()],
      watchLabel: 'Watch',
      startWatch: false,
    }), SESSION, world.host);
    expect(world.renames()).toBe(2);
    expect(world.records.some((record) => record.stage === 'ready')).toBe(false);
    expect(world.said.join('\n')).toContain('its name was not listed after the rename; left at launched');
  });

  test('an unparseable rename answer is not a name, and a success envelope still needs the list', () => {
    const listed: { name: string | null } = { name: null };
    const captured: string[] = [];
    setHerdrRun(() => ({
      agents: [{
        pane_id: PANE,
        name: listed.name,
        agent: 'claude',
        workspace_id: WORKSPACE,
        agent_status: 'idle',
      }],
    }));
    setHerdrCapture((args) => {
      captured.push(args.join(' '));
      return captured.length === 1 ? 'not json\n' : '{"id":1,"result":{}}\n';
    });
    expect(agentRename(PANE, SEAT, SESSION)).toBe(false);
    expect(agentRename(PANE, SEAT, SESSION)).toBe(false);
    expect(captured).toEqual([`agent rename ${PANE} ${SEAT}`, `agent rename ${PANE} ${SEAT}`]);
    listed.name = SEAT;
    expect(agentRename(PANE, SEAT, SESSION)).toBe(true);
    expect(captured).toHaveLength(2);
  });
});

describe('an unnamed pane', () => {
  test('the recorded shell, its start, and the caller ancestry place the seat', () => {
    const world = placeWorld({ [SEAT]: anchored() });
    expect(placementOf(world.io, world.dir, SESSION, SEAT)).toEqual({ ok: true });
  });

  test('a reused pane with a new shell is refused, including after the start wait', async () => {
    const world = placeWorld({ [SEAT]: anchored() }, { shell: SHELL + 1 });
    const once = placementOf(world.io, world.dir, SESSION, SEAT);
    expect(once.ok).toBe(false);
    if (!once.ok) expect(once.why).toContain(UNNAMED);
    let clock = 0;
    const waited = await placementAtStart(world.io, world.dir, SESSION, SEAT, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(waited.ok).toBe(false);
    expect(clock).toBe(SERVE_PLACEMENT_WAIT_MS);
    expect(placementOf(world.io, world.dir, SESSION, SEAT).ok).toBe(false);
  });

  test('a recycled pid with a different start time is refused', async () => {
    const world = placeWorld({ [SEAT]: anchored() }, { start: START + 5000 });
    const once = placementOf(world.io, world.dir, SESSION, SEAT);
    expect(once.ok).toBe(false);
    if (!once.ok) expect(once.why).toContain(UNNAMED);
    let clock = 0;
    const waited = await placementAtStart(world.io, world.dir, SESSION, SEAT, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(waited.ok).toBe(false);
    expect(clock).toBe(SERVE_PLACEMENT_WAIT_MS);
  });

  test('two seats recording the pane prove nothing', () => {
    const world = placeWorld({ [SEAT]: anchored(), [OTHER]: anchored() });
    const placed = placementOf(world.io, world.dir, SESSION, SEAT);
    expect(placed.ok).toBe(false);
    if (!placed.ok) expect(placed.why).toContain(UNNAMED);
  });

  test('a caller that is not under the recorded shell is refused', () => {
    const world = placeWorld({ [SEAT]: anchored() }, {
      ancestors: [
        { pid: CLI, name: 'claude' },
        { pid: 8100, name: 'herdr' },
        { pid: 1, name: 'init' },
      ],
      root: CLI,
    });
    const placed = placementOf(world.io, world.dir, SESSION, SEAT);
    expect(placed.ok).toBe(false);
    if (!placed.ok) expect(placed.why).toContain(UNNAMED);
  });

  test('a hint for another pane does not wait', async () => {
    const world = placeWorld({ [SEAT]: { ...anchored(), pane: OTHER_PANE } }, { hint: PANE });
    let clock = 0;
    let slept = 0;
    const placed = await placementAtStart(world.io, world.dir, SESSION, SEAT, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; slept += 1; },
    });
    expect(placed.ok).toBe(false);
    expect(slept).toBe(0);
    expect(clock).toBe(0);
  });
});

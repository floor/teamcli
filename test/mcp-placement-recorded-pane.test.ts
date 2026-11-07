// The placement scenes: a seat's MCP server starts during its CLI's boot, before herdr has named
// the pane. The state's create-time pane shell is the anchor that places such a caller as its
// seat, and the start instant refuses a pid the OS handed to another process. A record written
// before create-time shells existed stands at the named-pane strength, and a named pane takes the
// ordinary name path. The state, the process table and the clock are synthetic; no live herdr is
// read.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import type { Io } from '../src/io.ts';
import { placementAtStart, placementOf, SERVE_PLACEMENT_WAIT_MS } from '../src/mcp/serve.ts';
import { testIo } from './helpers.ts';

const SESSION = 'placement-scene';
const SEAT = 'alpha';
const OTHER_SEAT = 'beta';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-workspace';
const SHELL = 7001;
const CLI = 7002;
const START = 1_760_000_000_000;

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

type SeatRecord = {
  stage: string;
  pane?: string;
  workspace?: string;
  launched?: { shell: number; cli: number[] };
  pane_shell?: number;
  pane_shell_start?: number;
};

type Vars = {
  /** The name herdr lists on the pane: null is the boot window this placement covers. */
  name: string | null;
  ancestors: { pid: number; name: string }[];
  /** What herdr reports as the pane's root process. */
  root: number | null;
  /** The pane's live shell pid and foreground pids, as herdr reports them. */
  shell: number;
  foreground: number[];
  /** The live shell's start instant, from the process table. */
  start: number | null;
};

const DEFAULT_ANCESTORS = [
  { pid: CLI, name: 'claude' },
  { pid: SHELL, name: 'shell' },
  { pid: 8100, name: 'herdr' },
  { pid: 1, name: 'init' },
];

/** The record a create writes now: the pane's shell and that process's start, before the CLI. */
function created(extra: Partial<SeatRecord> = {}): SeatRecord {
  return {
    stage: 'launched',
    pane: PANE,
    workspace: WORKSPACE,
    pane_shell: SHELL,
    pane_shell_start: START,
    ...extra,
  };
}

function scene(seats: Record<string, SeatRecord>, vars: Partial<Vars> = {}): { io: Io; stateDir: string; vars: Vars } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-placement-')));
  owned.push(root);
  writeFileSync(
    join(root, 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats, worktrees: {} } } })}\n`,
  );
  const live: Vars = {
    name: null,
    ancestors: DEFAULT_ANCESTORS,
    root: SHELL,
    shell: SHELL,
    foreground: [CLI],
    start: START,
    ...vars,
  };
  const io = testIo(root);
  io.env = { HERDR_PANE_ID: PANE };
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
    paneProcesses: (pane) => (pane === PANE ? { shell: live.shell, foreground: live.foreground } : null),
    processStartOf: () => live.start,
  });
  return { io, stateDir: root, vars: live };
}

const UNNAMED = 'whose agent has no herdr name';

test('F: an unnamed pane is placed as the seat its record anchors with the live shell', () => {
  const made = scene({ [SEAT]: created() });
  expect(placementOf(made.io, made.stateDir, SESSION, SEAT)).toEqual({ ok: true });
});

test('G: a live shell that differs from the record refuses the pane', () => {
  const made = scene({ [SEAT]: created() }, { shell: SHELL + 1 });
  const placed = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
});

test('G: no seat recording the pane refuses it', () => {
  const made = scene({ [OTHER_SEAT]: { ...created(), pane: 'fixture-other-pane' } });
  const placed = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
});

test('G: two seats recording the pane prove nothing', () => {
  const made = scene({ [SEAT]: created(), [OTHER_SEAT]: created() });
  const placed = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
});

test("G: a recorded shell that is not one of the caller's ancestors refuses the pane", () => {
  const made = scene({ [SEAT]: created() }, {
    ancestors: [{ pid: CLI, name: 'claude' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }],
    // The pane is still one herdr lists under this caller: its root is an ancestor, but the
    // shell the record anchors is not in the chain. The ancestor test is the proof's last rule.
    root: CLI,
  });
  const placed = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
});

test('H: the start wait places the caller when herdr names the pane within the bound', async () => {
  // A record with no shell anchor (a build from before create-time shells, after its launch
  // identity was cleared): the name is the only proof, and it arrives while the server waits.
  const made = scene({ [SEAT]: { stage: 'ready', pane: PANE, workspace: WORKSPACE } });
  let clock = 0;
  let polls = 0;
  const placed = await placementAtStart(made.io, made.stateDir, SESSION, SEAT, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      polls += 1;
      if (polls === 2) made.vars.name = SEAT;
    },
  });
  expect(placed).toEqual({ ok: true });
  expect(clock).toBeGreaterThan(0);
  expect(clock).toBeLessThanOrEqual(SERVE_PLACEMENT_WAIT_MS);
});

test('H: a name that never arrives is refused after the whole bound', async () => {
  const made = scene({ [SEAT]: { stage: 'ready', pane: PANE, workspace: WORKSPACE } });
  let clock = 0;
  const placed = await placementAtStart(made.io, made.stateDir, SESSION, SEAT, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
  expect(clock).toBe(SERVE_PLACEMENT_WAIT_MS);
});

test('I: a resumed pane keeps the seat when its recorded CLI pid is gone', () => {
  // The pane is back at a new CLI pid; the shell is the anchor, so the launched pids are not read.
  const made = scene({ [SEAT]: created({ launched: { shell: SHELL, cli: [9999] } }) });
  expect(placementOf(made.io, made.stateDir, SESSION, SEAT)).toEqual({ ok: true });
});

test('J: a pid reused after the shell exited is refused, and the wait still runs to its bound', async () => {
  // Same pid, another start instant: the OS handed the pid to a different process.
  const made = scene({ [SEAT]: created() }, { start: START + 5000 });
  const once = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(once.ok).toBe(false);
  expect(once.ok ? '' : once.why).toContain(UNNAMED);

  let clock = 0;
  const waited = await placementAtStart(made.io, made.stateDir, SESSION, SEAT, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(waited.ok).toBe(false);
  expect(clock).toBe(SERVE_PLACEMENT_WAIT_MS);
});

test('J: an unreadable start instant refuses the pane', () => {
  const made = scene({ [SEAT]: created() }, { start: null });
  const placed = placementOf(made.io, made.stateDir, SESSION, SEAT);
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
});

test('K: a record from before create-time shells is placed at the named-pane strength', () => {
  const made = scene({
    [SEAT]: { stage: 'ready', pane: PANE, workspace: WORKSPACE, launched: { shell: SHELL, cli: [CLI] } },
  }, {
    // No start instant to compare, so nothing reads one: a reading that would refuse a
    // create-time record leaves this record standing.
    start: START + 5000,
  });
  expect(placementOf(made.io, made.stateDir, SESSION, SEAT)).toEqual({ ok: true });
});

test('K: a record the pane is named for still takes the ordinary name path', () => {
  const made = scene({
    [SEAT]: { stage: 'ready', pane: PANE, workspace: WORKSPACE, launched: { shell: SHELL, cli: [CLI] } },
  }, {
    name: SEAT,
    // The name alone places the caller: no shell is compared, so a disagreeing reading is mute.
    shell: SHELL + 1,
    start: null,
  });
  expect(placementOf(made.io, made.stateDir, SESSION, SEAT)).toEqual({ ok: true });
});

// The start placement read while the handshake is served (scene helpers shared with
// mcp-placement-recorded-pane.test.ts). The placement scenes: a seat's MCP server starts during its CLI's boot, before herdr has named
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
import { setHerdrCapture, setHerdrRun } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { proveWhileServing, SERVE_PLACEMENT_SLOW_POLL_MS, SERVE_PLACEMENT_WAIT_MS } from '../src/mcp/serve.ts';
import { testIo } from './helpers.ts';

const SESSION = 'placement-scene';
const SEAT = 'alpha';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-workspace';
const SHELL = 7001;
const CLI = 7002;
const START = 1_760_000_000_000;

const owned: string[] = [];
afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
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
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
const CHECK = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inbox_check' } });

/** A client the scene feeds: `push` one line, `end` closes the input. */
function client(): { lines: AsyncIterator<string>; push(line: string): void; end(): void } {
  const waiting: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const lines = (async function* () {
    for (;;) {
      if (waiting.length > 0) {
        yield waiting.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    push: (line) => {
      waiting.push(line);
      bump();
    },
    end: () => {
      ended = true;
      bump();
    },
  };
}

/** A record with no shell anchor: the herdr name is the only proof, as after a machine restart
 *  restores the pane before the agent in it is named. */
const UNANCHORED = { stage: 'ready', pane: PANE, workspace: WORKSPACE };

test('an unnamed recorded pane is served while unproven, and the inbox opens when herdr names it past the start bound', async () => {
  const made = scene({ [SEAT]: UNANCHORED });
  const peer = client();
  peer.push(INITIALIZE);
  let clock = 0;
  const answered: string[] = [];
  const refusals: string[] = [];
  const proof = proveWhileServing({
    io: made.io,
    stateDir: made.stateDir,
    session: SESSION,
    name: SEAT,
    lines: peer.lines,
    write: (line) => answered.push(line),
    pending: (line) => `pending:${line}`,
    onRefusal: (why) => refusals.push(why),
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // A call while unplaced is answered by the pending serving, never held.
        if (clock === SERVE_PLACEMENT_WAIT_MS + SERVE_PLACEMENT_SLOW_POLL_MS) peer.push(CHECK);
        // herdr names the pane well past the old 5 s bound; the client is still connected.
        if (clock >= SERVE_PLACEMENT_WAIT_MS + 3 * SERVE_PLACEMENT_SLOW_POLL_MS) made.vars.name = SEAT;
        await Promise.resolve();
      },
    },
  });
  const placed = await proof;
  expect(placed.ok).toBe(true);
  expect(answered[0]).toBe(`pending:${INITIALIZE}`);
  expect(answered).toContain(`pending:${CHECK}`);
  expect(refusals.length).toBeGreaterThan(0);
  expect(refusals[0]).toContain(UNNAMED);
  expect(clock).toBeGreaterThan(SERVE_PLACEMENT_WAIT_MS);
  // The input is still open: the line the serving loop is owed is the client's next one.
  peer.push('{"jsonrpc":"2.0","id":3,"method":"ping"}');
  if (placed.ok) expect((await placed.first()).value).toBe('{"jsonrpc":"2.0","id":3,"method":"ping"}');
});

test('a caller placed on the first reading has every line served by the inbox, none by the pending serving', async () => {
  const made = scene({ [SEAT]: created() });
  const peer = client();
  peer.push(INITIALIZE);
  peer.push(CHECK);
  const answered: string[] = [];
  const placed = await proveWhileServing({
    io: made.io,
    stateDir: made.stateDir,
    session: SESSION,
    name: SEAT,
    lines: peer.lines,
    write: (line) => answered.push(line),
    pending: (line) => `pending:${line}`,
    deps: { now: () => 0, sleep: async () => {} },
  });
  expect(placed.ok).toBe(true);
  expect(answered).toEqual([]);
  if (placed.ok) expect((await placed.first()).value).toBe(INITIALIZE);
});

test('a client that has gone ends the wait at once, and the last refusal is returned', async () => {
  const made = scene({ [SEAT]: UNANCHORED });
  const peer = client();
  peer.push(INITIALIZE);
  peer.end();
  let clock = 0;
  const answered: string[] = [];
  const placed = await proveWhileServing({
    io: made.io,
    stateDir: made.stateDir,
    session: SESSION,
    name: SEAT,
    lines: peer.lines,
    write: (line) => answered.push(line),
    pending: (line) => `pending:${line}`,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  });
  expect(placed.ok).toBe(false);
  expect(placed.ok ? '' : placed.why).toContain(UNNAMED);
  // Past the input's end nothing more is waited for.
  expect(clock).toBeLessThanOrEqual(500);
  expect(answered).toEqual([`pending:${INITIALIZE}`]);
});

test('a caller in a pane the seat does not record is refused at once, without waiting', async () => {
  const made = scene({ [SEAT]: { ...UNANCHORED, pane: 'fixture-elsewhere' } });
  const peer = client();
  let slept = 0;
  const placed = await proveWhileServing({
    io: made.io,
    stateDir: made.stateDir,
    session: SESSION,
    name: SEAT,
    lines: peer.lines,
    write: () => {},
    pending: () => null,
    deps: {
      now: () => 0,
      sleep: async (ms) => {
        slept += ms;
      },
    },
  });
  expect(placed.ok).toBe(false);
  // The refusal is answered at once: no wait, and no line served.
  expect(slept).toBe(0);
});

test('a wait whose record moves the seat to another pane ends at once', async () => {
  const made = scene({ [SEAT]: UNANCHORED });
  const peer = client();
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io,
    stateDir: made.stateDir,
    session: SESSION,
    name: SEAT,
    lines: peer.lines,
    write: () => {},
    pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= SERVE_PLACEMENT_WAIT_MS + SERVE_PLACEMENT_SLOW_POLL_MS) {
          writeFileSync(
            join(made.stateDir, 'team.state.json'),
            `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { [SEAT]: { ...UNANCHORED, pane: 'fixture-relaunched' } }, worktrees: {} } } })}\n`,
          );
        }
      },
    },
  });
  expect(placed.ok).toBe(false);
  expect(clock).toBe(SERVE_PLACEMENT_WAIT_MS + SERVE_PLACEMENT_SLOW_POLL_MS);
});

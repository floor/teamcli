// The team channel across a machine restart. herdr restores a lead's Claude pane and resumes its
// conversation itself: the CLI starts its MCP servers before herdr names the agent in the pane,
// and the restored process can carry no pane variable. A server that is that CLI's own child in
// the seat's recorded pane waits, bounded, serving nothing, and opens the inbox once the same
// placement proves the seat and the lineage still holds. Anything else under the pane's shell is
// refused at once. Status says when a restored process leaves the channel flag unproven, and the
// restore pass keeps a present pair out of the checkout's untracked files. The state, the process
// table and the clock are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { excludePresentPairs } from '../src/launch/restore-channel.ts';
import {
  placementReading,
  proveWhileServing,
  SERVE_RESTORED_PLACEMENT_WAIT_MS,
  type StartReading,
} from '../src/mcp/serve.ts';
import { emptySession } from '../src/state.ts';
import { channelPushUnprovenNote, compare, type Live as StatusLive } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const SESSION = 'reboot-scene';
const SEAT = 'lead';
const PANE = 'fixture-pane-restored';
const SHELL = 7101;
const CLI = 7102;
const CLAUDE = ['claude'];

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Live = {
  name: string | null;
  listed: boolean;
  root: number;
  foreground: number[];
  /** The conversation herdr reports on the pane, once it lists it. */
  session?: string;
  ancestors: { pid: number; name: string }[];
};

const OWN_CHILD = [{ pid: CLI, name: 'claude' }, { pid: SHELL, name: 'zsh' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }];

function scene(env: Record<string, string>, live: Partial<Live> = {}, recordedSession?: string): { io: Io; stateDir: string; live: Live } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-reboot-')));
  owned.push(root);
  const record = { stage: 'ready', pane: PANE, workspace: 'fixture-ws', ...(recordedSession === undefined ? {} : { agent_session: recordedSession }) };
  writeFileSync(join(root, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { [SEAT]: record }, worktrees: {} } },
  })}\n`);
  const state: Live = { name: null, listed: false, root: SHELL, foreground: [CLI], ancestors: OWN_CHILD, ...live };
  const io = testIo(root);
  io.env = env;
  io.callerSources = (): CallerSources => ({
    ancestors: () => state.ancestors,
    // Before herdr detects the CLI the pane is not listed as an agent at all.
    agents: () => (state.listed
      ? [{
        name: state.name, agent: 'claude', pane: PANE, workspace: 'fixture-ws', status: 'idle', cwd: null,
        ...(state.session === undefined ? {} : { session: state.session }),
      }]
      : []),
    paneRootPid: (pane) => (pane === PANE ? state.root : null),
    env: io.env,
    stdinIsTTY: false,
    paneProcesses: (pane) => (pane === PANE ? { shell: SHELL, foreground: state.foreground } : null),
    processStartOf: () => null,
  });
  return { io, stateDir: root, live: state };
}

const never = (): AsyncIterator<string> => ({ next: () => new Promise<IteratorResult<string>>(() => {}) });

function reading(made: ReturnType<typeof scene>, names: readonly string[] = CLAUDE): StartReading {
  return placementReading(made.io, made.stateDir, SESSION, SEAT, names);
}

function refusedAtOnce(made: ReturnType<typeof scene>, names: readonly string[] = CLAUDE): void {
  const read = reading(made, names);
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.wait).toBe(false);
    expect(read.waitBoundMs).toBeUndefined();
  }
}

test('the seat CLI\'s own child in the recorded pane, with no pane variable, is waited for with a bound', () => {
  const read = reading(scene({}));
  expect(read.ok).toBe(false);
  if (!read.ok) {
    expect(read.wait).toBe(true);
    expect(read.waitBoundMs).toBe(SERVE_RESTORED_PLACEMENT_WAIT_MS);
  }
});

test('outside herdr with no pane variable, an unplaced start is refused at once', () => {
  refusedAtOnce(scene({}, { ancestors: [{ pid: CLI, name: 'claude' }, { pid: 900, name: 'zsh' }, { pid: 1, name: 'init' }] }));
});

test('a pane variable naming another pane than the record is still refused at once', () => {
  const read = reading(scene({ HERDR_PANE_ID: 'fixture-pane-other' }));
  expect(read.ok).toBe(false);
  if (!read.ok) expect(read.wait).toBe(false);
});

test('a process in another herdr pane, with no pane variable, is refused at once', () => {
  refusedAtOnce(scene({}, { root: 999 }));
});

test('shell-only ancestry in the recorded pane is refused at once', () => {
  // Started by the pane's shell directly: no CLI between the server and the shell.
  refusedAtOnce(scene({}, { ancestors: [{ pid: SHELL, name: 'zsh' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }] }));
});

test('a sibling job under the pane\'s shell is refused at once, whatever its name', () => {
  // Another program the shell started beside the CLI.
  refusedAtOnce(scene({}, { ancestors: [{ pid: 7200, name: 'bun' }, { pid: SHELL, name: 'zsh' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }] }));
  // A second claude under the same shell that is not the pane's foreground CLI.
  refusedAtOnce(scene({}, { ancestors: [{ pid: 7300, name: 'claude' }, { pid: SHELL, name: 'zsh' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }] }));
});

test('a seat whose CLI names no process never opens the window', () => {
  refusedAtOnce(scene({}), []);
});

test('a pane whose listed conversation is not the record\'s is refused at once', () => {
  refusedAtOnce(scene({}, { listed: true, name: null, session: 'conversation-other' }, 'conversation-kept'));
});

test('the restored pane is served pending, then proven once herdr names the agent two minutes in', async () => {
  const made = scene({}, {}, 'conversation-kept');
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    check: () => reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 120_000) Object.assign(made.live, { listed: true, name: SEAT, session: 'conversation-kept' });
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(true);
  expect(clock).toBeGreaterThanOrEqual(120_000);
  expect(clock).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS);
});

test('a waiter whose CLI left the pane\'s foreground is refused when herdr later names the agent', async () => {
  const made = scene({});
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    check: () => reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // The legitimate agent appears and is named; this server's parent is no longer in front.
        if (clock >= 30_000) Object.assign(made.live, { listed: true, name: SEAT, foreground: [7999] });
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(false);
  if (!placed.ok) expect(placed.why).toContain('no longer proven');
});

test('a waiter whose pane comes back under another conversation is refused, never bound', async () => {
  const made = scene({}, {}, 'conversation-kept');
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    check: () => reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 30_000) Object.assign(made.live, { listed: true, name: SEAT, session: 'conversation-other' });
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(false);
});

test('a pane herdr names as another seat ends the wait with a refusal, never a binding', async () => {
  const made = scene({});
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    check: () => reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 30_000) Object.assign(made.live, { listed: true, name: 'someone-else' });
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(false);
  expect(clock).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS);
});

test('the bounded wait ends with the last refusal when herdr never names the pane', async () => {
  const made = scene({});
  let clock = 0;
  let sleeps = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    check: () => reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: { now: () => clock, sleep: async (ms) => { clock += ms; sleeps += 1; await Promise.resolve(); } },
  });
  expect(placed.ok).toBe(false);
  expect(clock).toBeGreaterThanOrEqual(SERVE_RESTORED_PLACEMENT_WAIT_MS);
  // Backed off past the first minute: far fewer readings than a 2 s pace for ten minutes.
  expect(sleeps).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS / 2000);
});

test('the bound holds when the refusal turns into an unbounded launch-proof wait', async () => {
  const made = scene({});
  let clock = 0;
  let placedNow = false;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    // Placed at 60 s, after which the launch proof keeps waiting with no bound of its own.
    check: (): StartReading => placedNow
      ? { ok: false, wait: true, why: 'the seat has a current brief claim of a launch this server is not part of' }
      : reading(made),
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 60_000) placedNow = true;
        if (clock > 3 * SERVE_RESTORED_PLACEMENT_WAIT_MS) throw new Error('the bound was lost');
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(false);
  if (!placed.ok) expect(placed.why).toContain('brief claim');
  expect(clock).toBeGreaterThanOrEqual(SERVE_RESTORED_PLACEMENT_WAIT_MS);
  expect(clock).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS + 10_000);
});

// Status, through the real compare: a lead whose line loads the channel, recorded as launched
// (shell 400, CLI 401) with its conversation, and a pane whose process is not that one.
const CHANNEL_LINE = 'claude --model opus --dangerously-load-development-channels server:team-inbox';
const NOW = new Date('2026-11-16T13:00:00Z');

function statusTeam(launch: string): TeamFile {
  const text = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
`;
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function statusNotes(launch: string, liveSession: string | undefined, foreground: number[]): string[] {
  const team = statusTeam(launch);
  const state = emptySession();
  state.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 400, cli: [401] }, agent_session: 'conversation-kept' };
  const live: StatusLive = {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null, ...(liveSession === undefined ? {} : { session: liveSession }) }],
    workspaces: [{ id: 'w1', label: 'lead' }],
    screens: { 'w1:p1': CLAUDE_IDLE },
    processes: { 'w1:p1': { shell: 500, foreground },
    },
  };
  const sockets = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-reboot-sockets-')));
  owned.push(sockets);
  return compare(team, team.session, state, live, NOW, team.watch, sockets).notes;
}

const UNPROVEN = 'channel push not confirmed: the process in its pane was not started from its launch line';

test('a recognized restored conversation on a process team did not launch says the channel is not confirmed', () => {
  const notes = statusNotes(CHANNEL_LINE, 'conversation-kept', [501]);
  expect(notes.some((note) => note.includes(UNPROVEN))).toBe(true);
  expect(notes.join('\n')).not.toContain('channel push off');
});

test('an untied process says the channel is not confirmed, never that push is off', () => {
  // Another conversation, or a process started by hand with the flag: nothing here can tell.
  const notes = statusNotes(CHANNEL_LINE, 'conversation-other', [501]);
  expect(notes.some((note) => note.includes(UNPROVEN))).toBe(true);
  expect(notes.join('\n')).not.toContain('channel push off');
  expect(notes.join('\n')).not.toContain('without the channel flag');
});

test('the process team launched, or a line with no channel, draws no channel note', () => {
  expect(statusNotes(CHANNEL_LINE, 'conversation-kept', [401]).join('\n')).not.toContain('channel push');
  expect(statusNotes('claude --model opus', 'conversation-kept', [501]).join('\n')).not.toContain('channel push');
});

function seat(name: string, launch: string, cli = 'claude-code'): Seat {
  return { name, cli, launch, cwd: '.' } as unknown as Seat;
}

function team(seats: Seat[]): TeamFile {
  return { orchestrator: 'lead', operator: 'operator', seats, session: SESSION } as unknown as TeamFile;
}

test('the note names the repair for a lead and for an ordinary seat', () => {
  const lead = seat('lead', CHANNEL_LINE);
  expect(channelPushUnprovenNote(lead, team([lead]))).toContain('another lead or the owner runs team restart lead --resume');
  const builder = seat('builder', CHANNEL_LINE);
  expect(channelPushUnprovenNote(builder, team([lead, builder]))).toContain('team restart builder --resume');
  const codex = seat('lead', CHANNEL_LINE, 'codex');
  expect(channelPushUnprovenNote(codex, team([codex]))).toBeUndefined();
});

test('the restore pass excludes a present lead pair locally, and nothing when none is present', () => {
  const lead = seat('lead', CHANNEL_LINE);
  const calls: string[][] = [];
  expect(excludePresentPairs(team([lead]), '/fixture/root', () => true, (_root, names) => { calls.push([...names]); })).toBe(true);
  expect(calls).toEqual([['.mcp.json', '.claude/settings.local.json', '.team-channel-setup.json']]);
  calls.length = 0;
  expect(excludePresentPairs(team([lead]), '/fixture/root', () => false, (_root, names) => { calls.push([...names]); })).toBe(false);
  expect(calls).toEqual([]);
});

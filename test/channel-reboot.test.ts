// The team channel across a machine restart. herdr restores a lead's Claude pane and resumes its
// conversation itself: the CLI starts its MCP servers before herdr names the agent in the pane,
// and the restored process can carry no pane variable. The server waits, bounded, serving
// nothing, and opens the inbox once the same placement proves the seat. Status says when such a
// resume dropped the channel flag, and the restore pass keeps a present pair out of the
// checkout's untracked files. The state, the process table and the clock are synthetic.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import type { Io } from '../src/io.ts';
import { excludePresentPairs } from '../src/launch/restore-channel.ts';
import { placementReading, proveWhileServing, SERVE_RESTORED_PLACEMENT_WAIT_MS } from '../src/mcp/serve.ts';
import { channelPushOffNote } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const SESSION = 'reboot-scene';
const SEAT = 'lead';
const PANE = 'fixture-pane-restored';
const SHELL = 7101;
const CLI = 7102;

const owned: string[] = [];
afterEach(() => {
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Live = { name: string | null; listed: boolean; root: number; ancestors: { pid: number; name: string }[] };

function scene(env: Record<string, string>, live: Partial<Live> = {}): { io: Io; stateDir: string; live: Live } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-reboot-')));
  owned.push(root);
  writeFileSync(join(root, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', pane: PANE, workspace: 'fixture-ws' } }, worktrees: {} } },
  })}\n`);
  const state: Live = {
    name: null,
    listed: false,
    root: SHELL,
    ancestors: [{ pid: CLI, name: 'claude' }, { pid: SHELL, name: 'shell' }, { pid: 8100, name: 'herdr' }, { pid: 1, name: 'init' }],
    ...live,
  };
  const io = testIo(root);
  io.env = env;
  io.callerSources = (): CallerSources => ({
    ancestors: () => state.ancestors,
    // Before herdr detects the CLI the pane is not listed as an agent at all.
    agents: () => (state.listed
      ? [{ name: state.name, agent: 'claude', pane: PANE, workspace: 'fixture-ws', status: 'idle', cwd: null }]
      : []),
    paneRootPid: (pane) => (pane === PANE ? state.root : null),
    env: io.env,
    stdinIsTTY: false,
    paneProcesses: (pane) => (pane === PANE ? { shell: SHELL, foreground: [CLI] } : null),
    processStartOf: () => null,
  });
  return { io, stateDir: root, live: state };
}

const never = (): AsyncIterator<string> => ({ next: () => new Promise<IteratorResult<string>>(() => {}) });

test('under herdr with no pane variable, an unplaced start is waited for with a bound', () => {
  const made = scene({});
  const reading = placementReading(made.io, made.stateDir, SESSION, SEAT);
  expect(reading.ok).toBe(false);
  if (!reading.ok) {
    expect(reading.wait).toBe(true);
    expect(reading.waitBoundMs).toBe(SERVE_RESTORED_PLACEMENT_WAIT_MS);
  }
});

test('outside herdr with no pane variable, an unplaced start is refused at once', () => {
  const made = scene({}, { ancestors: [{ pid: CLI, name: 'claude' }, { pid: 900, name: 'zsh' }, { pid: 1, name: 'init' }] });
  const reading = placementReading(made.io, made.stateDir, SESSION, SEAT);
  expect(reading.ok).toBe(false);
  if (!reading.ok) {
    expect(reading.wait).toBe(false);
    expect(reading.waitBoundMs).toBeUndefined();
  }
});

test('a process in another herdr pane, with no pane variable, is refused at once', () => {
  const made = scene({}, { root: 999 });
  const reading = placementReading(made.io, made.stateDir, SESSION, SEAT);
  expect(reading.ok).toBe(false);
  if (!reading.ok) expect(reading.wait).toBe(false);
});

test('a pane variable naming another pane than the record is still refused at once', () => {
  const made = scene({ HERDR_PANE_ID: 'fixture-pane-other' });
  const reading = placementReading(made.io, made.stateDir, SESSION, SEAT);
  expect(reading.ok).toBe(false);
  if (!reading.ok) expect(reading.wait).toBe(false);
});

test('the restored pane is served pending, then proven once herdr names the agent two minutes in', async () => {
  const made = scene({});
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 120_000) { made.live.listed = true; made.live.name = SEAT; }
        await Promise.resolve();
      },
    },
  });
  expect(placed.ok).toBe(true);
  expect(clock).toBeGreaterThanOrEqual(120_000);
  expect(clock).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS);
});

test('a pane herdr names as another seat ends the wait with a refusal, never a binding', async () => {
  const made = scene({});
  let clock = 0;
  const placed = await proveWhileServing({
    io: made.io, stateDir: made.stateDir, session: SESSION, name: SEAT,
    lines: never(), write: () => {}, pending: () => null,
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 30_000) { made.live.listed = true; made.live.name = 'someone-else'; }
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
    lines: never(), write: () => {}, pending: () => null,
    deps: { now: () => clock, sleep: async (ms) => { clock += ms; sleeps += 1; await Promise.resolve(); } },
  });
  expect(placed.ok).toBe(false);
  expect(clock).toBeGreaterThanOrEqual(SERVE_RESTORED_PLACEMENT_WAIT_MS);
  // Backed off past the first minute: far fewer readings than a 2 s pace for ten minutes.
  expect(sleeps).toBeLessThan(SERVE_RESTORED_PLACEMENT_WAIT_MS / 2000);
});

const CHANNEL_LINE = 'claude --model opus --dangerously-load-development-channels server:team-inbox';

function seat(name: string, launch: string, cli = 'claude-code'): Seat {
  return { name, cli, launch, cwd: '.' } as unknown as Seat;
}

function team(seats: Seat[]): TeamFile {
  return { orchestrator: 'lead', operator: 'operator', seats, session: SESSION } as unknown as TeamFile;
}

test('a restored Claude seat whose line loads the channel is reported with channel push off', () => {
  const lead = seat('lead', CHANNEL_LINE);
  const note = channelPushOffNote(lead, team([lead]));
  expect(note).toContain('channel push off: resumed without the channel flag');
  expect(note).toContain('another lead or the owner runs team restart lead --resume');
  const builder = seat('builder', CHANNEL_LINE);
  expect(channelPushOffNote(builder, team([lead, builder]))).toContain('team restart builder --resume');
});

test('a seat with no channel on its line, or another CLI, gets no channel note', () => {
  const plain = seat('lead', 'claude --model opus');
  expect(channelPushOffNote(plain, team([plain]))).toBeUndefined();
  const codex = seat('lead', CHANNEL_LINE, 'codex');
  expect(channelPushOffNote(codex, team([codex]))).toBeUndefined();
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

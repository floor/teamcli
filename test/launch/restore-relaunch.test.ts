// The restore's relaunch and reach check (src/launch/restore-relaunch.ts): a Claude seat the
// terminal host resumed without its launch line comes back through `team restart --resume` when
// it is idle, and a restored seat whose channel is not proven in time is said once to the lead
// and fails `team doctor`. The restart, the proof, the probe and the notice are stand-ins.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpSources } from '../../src/commands/up.ts';
import { blocksLaunch } from '../../src/commands/doctor.ts';
import type { TeamFile } from '../../src/file/types.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { relaunchRestoredSeats, unreachableAfterRestore, type RestoreRelaunchDeps } from '../../src/launch/restore-relaunch.ts';
import { CHANNEL_OVERDUE_MS, type ChannelUnproven } from '../../src/queue/resend.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE } from '../helpers.ts';

const SESSION = 'relaunch';
const UNSENT = readFileSync(new URL('../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt', import.meta.url), 'utf8');
const FLAGGED = 'claude --dangerously-load-development-channels server:team-inbox';
const T0 = new Date('2026-11-22T06:00:00Z');
const LIMITS = { loadStart: 1, memoryStart: 5, diskMin: 1, swapGrowthMax: 1e15, swapGrowthWindow: 600 };
const CALM: Machine = { loadPerCore: 0.2, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9 };

let base: string;
let dir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restore-relaunch-')));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
  // The lead's channel pair in the project folder it starts in: its channel start has no fallback.
  writeFileSync(join(base, '.mcp.json'), JSON.stringify({ mcpServers: { 'team-inbox': { command: 'team', args: ['mcp', 'serve', '--seat', 'lead'] } } }));
  mkdirSync(join(base, '.claude'), { recursive: true });
  writeFileSync(join(base, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['team-inbox'] }));
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

type SeatSpec = { name: string; launch?: string; channel?: boolean; channelOff?: boolean };

function team(seats: SeatSpec[], entity: string | null = null, trust: string[] = []): TeamFile {
  return {
    project: 'proj', entity, orchestrator: 'lead', operator: 'lead', trust, machine: LIMITS,
    seats: seats.map((one) => ({ name: one.name, cli: 'claude-code', launch: one.launch ?? FLAGGED, cwd: '.', ...(one.channelOff === true ? { channelOff: true } : {}) })),
  } as unknown as TeamFile;
}

/** The state a restore re-tie leaves: each seat on its pane, its conversation, no channel flag. */
function restoredState(seats: SeatSpec[]): void {
  const records = Object.fromEntries(seats.map((one, at) => [one.name, {
    stage: 'ready', pane: `w${String(at)}:p1`, workspace: `w${String(at)}`,
    launched: { shell: 700 + at, cli: [800 + at] }, agent_session: `conv-${one.name}`, channel_launch: one.channel ?? false,
  }]));
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: records, worktrees: {} } } }));
}

/** The restart's own effect on the record: a new launch through the line, with the flag. */
function relaunchedRecord(seat: string): void {
  const state = JSON.parse(readFileSync(join(dir, 'team.state.json'), 'utf8'));
  const held = state.sessions[SESSION].seats[seat];
  held.launched = { shell: held.launched.shell + 1000, cli: [held.launched.cli[0] + 1000] };
  held.channel_launch = true;
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify(state));
}

type World = {
  clock: Date; status: Record<string, string>; screen: string; machine: Machine;
  restarts: string[][]; probes: string[]; notices: { lead: string; body: string; id: string }[];
  unproven: Record<string, ChannelUnproven | null>;
};

function world(): World {
  return { clock: T0, status: {}, screen: CLAUDE_IDLE, machine: CALM, restarts: [], probes: [], notices: [], unproven: {} };
}

function sourcesOf(w: World): UpSources {
  return {
    home: base,
    now: () => w.clock,
    machine: () => w.machine,
    sessionRunning: () => true,
    agents: () => Object.entries(w.status).map(([pane, status]): HerdrAgent => ({ name: null, agent: 'claude', pane, workspace: pane.split(':')[0]!, status, cwd: null })),
    launch: { paneText: () => w.screen } as unknown as UpSources['launch'],
  } as UpSources;
}

function depsOf(w: World): RestoreRelaunchDeps {
  return {
    restart: async (argv) => { w.restarts.push(argv); relaunchedRecord(argv[0]!); return 0; },
    unproven: (seat) => (seat in w.unproven ? w.unproven[seat]! : 'unproven since launch'),
    probe: (seat) => { w.probes.push(seat); },
    notify: (one) => { w.notices.push(one); return true; },
  };
}

const pass = (w: World, file: TeamFile) => relaunchRestoredSeats({
  root: base, dir, session: SESSION, team: file, sources: sourcesOf(w), caller: { kind: 'owner' }, deps: depsOf(w),
});

describe('a restored Claude seat comes back through its launch line', () => {
  test('idle at an empty prompt: one restart with its conversation, then the probe and the proof wait', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    const first = await pass(w, team(seats));
    expect(w.restarts).toEqual([['worker', '--resume', 'conv-worker', '--session', SESSION]]);
    expect(first.lines.join('\n')).toContain('worker: relaunched through its launch line with its conversation conv-worker');
    expect(w.probes).toEqual(['worker']);
    expect(first.pending).toContain('worker waits for its channel proof');
    // A second pass inside the bound restarts nothing again.
    w.clock = new Date(T0.getTime() + 10_000);
    await pass(w, team(seats));
    expect(w.restarts).toHaveLength(1);
    expect(w.notices).toEqual([]);
  });

  test('proven after the relaunch: reachable, nothing reported, nothing pending', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    await pass(w, team(seats));
    w.unproven.worker = null;
    w.clock = new Date(T0.getTime() + 20_000);
    const second = await pass(w, team(seats));
    expect(second.pending).toBeNull();
    w.clock = new Date(T0.getTime() + CHANNEL_OVERDUE_MS * 3);
    const third = await pass(w, team(seats));
    expect(third.lines).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  test('still unproven past the bound: said once to the lead, and doctor fails it without blocking a restart', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    await pass(w, team(seats));
    w.clock = new Date(T0.getTime() + CHANNEL_OVERDUE_MS + 1_000);
    const late = await pass(w, team(seats));
    expect(late.lines).toContain('worker: unreachable after restore: unproven since launch');
    expect(late.pending).toBeNull();
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.lead).toBe('lead');
    await pass(w, team(seats));
    expect(w.notices).toHaveLength(1);
    expect(w.restarts).toHaveLength(1);
    const line = unreachableAfterRestore(dir, SESSION, 'worker', 'unproven since launch', w.clock);
    expect(line).toBe('worker: unreachable after restore: unproven since launch');
    expect(blocksLaunch({ level: 'miss', text: line! })).toBe(false);
    expect(unreachableAfterRestore(dir, SESSION, 'worker', null, w.clock)).toBeNull();
    expect(unreachableAfterRestore(dir, SESSION, 'worker', 'unproven since launch', new Date(T0.getTime() + 1_000))).toBeNull();
  });

  test('a working seat is not interrupted: retried on a later pass, restarted once idle', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'working';
    const first = await pass(w, team(seats));
    expect(w.restarts).toEqual([]);
    expect(first.pending).toContain('worker is not idle at an empty prompt');
    w.status['w0:p1'] = 'idle';
    // Unsent text in the box is not an empty prompt either.
    w.screen = UNSENT;
    await pass(w, team(seats));
    expect(w.restarts).toEqual([]);
    w.screen = CLAUDE_IDLE;
    await pass(w, team(seats));
    expect(w.restarts).toHaveLength(1);
  });

  test('the load guard holds the relaunch; the route is passed again', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    w.machine = { ...CALM, loadPerCore: 3 };
    const held = await pass(w, team(seats));
    expect(w.restarts).toEqual([]);
    expect(held.pending).toContain('worker waits for the load guard');
  });

  test('the entity\'s main orchestrator is not restarted: the owner is told the one restart to approve, once', async () => {
    const seats = [{ name: 'lead' }, { name: 'other-lead' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    w.status['w1:p1'] = 'idle';
    const file = team(seats, 'proj');
    const first = await pass(w, file);
    expect(w.restarts.map((argv) => argv[0])).toEqual(['other-lead']);
    expect(first.lines.join('\n')).toContain('the owner approves `team restart lead --resume conv-lead`');
    expect(w.notices.filter((one) => one.body.includes('owner approves'))).toHaveLength(1);
    await pass(w, file);
    expect(w.notices.filter((one) => one.body.includes('owner approves'))).toHaveLength(1);
  });

  test('a seat whose launch carries no channel flag (it declines the channel), or launched with it, is left as it is', async () => {
    const seats = [{ name: 'plain', launch: 'claude', channelOff: true }, { name: 'live', channel: true }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    w.status['w1:p1'] = 'idle';
    const out = await pass(w, team(seats));
    expect(w.restarts).toEqual([]);
    expect(out).toEqual({ lines: [], pending: null });
  });

  test('a plain line the launch planning puts the flag on is relaunched like a flagged one', async () => {
    const seats = [{ name: 'plain', launch: 'claude' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    await pass(w, team(seats));
    expect(w.restarts).toEqual([['plain', '--resume', 'conv-plain', '--session', SESSION]]);
  });

  test('a notice that was not written stays owed and is written on a later pass under the same id', async () => {
    for (const orchestrator of [true, false]) {
      const seats = [{ name: orchestrator ? 'lead' : 'worker' }];
      restoredState(seats);
      const w = world();
      w.status['w0:p1'] = 'idle';
      const file = team(seats, orchestrator ? 'proj' : null);
      const failing = { ...depsOf(w), notify: (one: { lead: string; body: string; id: string }) => { w.notices.push(one); return false; } };
      const run = (deps: RestoreRelaunchDeps) => relaunchRestoredSeats({ root: base, dir, session: SESSION, team: file, sources: sourcesOf(w), caller: { kind: 'owner' }, deps });
      if (!orchestrator) {
        await run(failing);
        w.clock = new Date(T0.getTime() + CHANNEL_OVERDUE_MS + 1_000);
      }
      const first = await run(failing);
      expect(w.notices).toHaveLength(1);
      expect(first.pending).toContain('its notice to the lead was not written');
      const second = await run(depsOf(w));
      expect(w.notices).toHaveLength(2);
      expect(w.notices[1]!.id).toBe(w.notices[0]!.id);
      expect(second.pending).toBeNull();
      await run(depsOf(w));
      expect(w.notices).toHaveLength(2);
    }
  });

  test('the fallback decision comes first: a flagged line whose channel start falls back is not relaunched', async () => {
    const seats = [{ name: 'worker' }];
    restoredState(seats);
    const w = world();
    w.status['w0:p1'] = 'idle';
    // A legacy trust form: the planning launches the seat without its channel, even its own flag.
    const out = await pass(w, team(seats, null, ['src/**']));
    expect(w.restarts).toEqual([]);
    expect(out).toEqual({ lines: [], pending: null });
  });
});

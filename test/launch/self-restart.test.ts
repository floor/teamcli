// A seat's queued restart of itself (src/launch/self-restart.ts): the daemon's pass runs the
// ordinary `team restart --resume` only once the seat is idle at an empty prompt, once, and gives
// a request up past its bound with a notice to the lead. The restart and the notice are stand-ins.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpSources } from '../../src/commands/up.ts';
import type { TeamFile } from '../../src/file/types.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import {
  hasSelfRestartRequests, runSelfRestarts, SELF_RESTART_BOUND_MS, selfRestartPath, writeSelfRestartRequest, type SelfRestartDeps,
} from '../../src/launch/self-restart.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE } from '../helpers.ts';

const SESSION = 'selfrestart';
const UNSENT = readFileSync(new URL('../fixtures/claude-code/2.1.289/unsent-typed-ansi.txt', import.meta.url), 'utf8');
const T0 = new Date('2026-11-22T06:00:00Z');
const LIMITS = { loadStart: 1, memoryStart: 5, diskMin: 1, swapGrowthMax: 1e15, swapGrowthWindow: 600 };
const CALM: Machine = { loadPerCore: 0.2, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9 };
const BUSY: Machine = { ...CALM, loadPerCore: 9 };
const LAUNCHED = { shell: 700, cli: [800] };

let base: string;
let dir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-self-restart-')));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: {
    lead: { stage: 'ready', pane: 'w0:p1', workspace: 'w0', launched: LAUNCHED, agent_session: 'conv-lead' },
  }, worktrees: {} } } }));
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

// The entity's main orchestrator: the seat today's rules never restart from its own pane.
const TEAM = {
  project: 'acme', entity: 'acme', orchestrator: 'lead', operator: 'lead', trust: [], machine: LIMITS, session: SESSION,
  seats: [{ name: 'lead', cli: 'claude-code', launch: 'claude', cwd: '.' }],
} as unknown as TeamFile;

type World = { clock: Date; status: string; screen: string; machine: Machine; restarts: string[][]; notices: { lead: string; body: string }[]; exit: number };
const world = (): World => ({ clock: T0, status: 'working', screen: CLAUDE_IDLE, machine: CALM, restarts: [], notices: [], exit: 0 });

function sourcesOf(w: World): UpSources {
  return {
    home: base,
    now: () => w.clock,
    machine: () => w.machine,
    agents: () => [{ name: 'lead', agent: 'claude', pane: 'w0:p1', workspace: 'w0', status: w.status, cwd: null } as HerdrAgent],
    launch: { paneText: () => w.screen } as unknown as UpSources['launch'],
  } as unknown as UpSources;
}

function depsOf(w: World): SelfRestartDeps {
  return {
    restart: async (argv, io) => { w.restarts.push(argv); if (w.exit !== 0) io.stderr('team restart: the seat did not come back\n'); return w.exit; },
    notify: (one) => { w.notices.push({ lead: one.lead, body: one.body }); return true; },
  };
}

const queue = (at = T0): void => {
  writeSelfRestartRequest({ home: base, dir, session: SESSION, seat: 'lead', conversation: 'conv-lead', pane: 'w0:p1', launched: LAUNCHED, now: at });
};
const pass = (w: World) => runSelfRestarts({ home: base, root: base, dir, team: TEAM, sources: sourcesOf(w), caller: { kind: 'owner' }, deps: depsOf(w) });
const queued = (): boolean => existsSync(selfRestartPath(dir, SESSION, 'lead'));

describe('the daemon runs a queued self-restart', () => {
  test('waits while the seat works, holds unsent text, or shows a dialog, then restarts once with its conversation', async () => {
    queue();
    expect(hasSelfRestartRequests(dir)).toBe(true);
    const w = world();
    await pass(w);
    expect(w.restarts).toEqual([]);
    // Its turn ended but text sits unsent in the box.
    w.status = 'idle';
    w.screen = UNSENT;
    await pass(w);
    expect(w.restarts).toEqual([]);
    // Herdr reads it blocked at a dialog.
    w.status = 'blocked';
    w.screen = CLAUDE_IDLE;
    await pass(w);
    // The load guard holds every launch.
    w.status = 'idle';
    w.machine = BUSY;
    await pass(w);
    expect(w.restarts).toEqual([]);
    expect(queued()).toBe(true);
    w.machine = CALM;
    const lines = await pass(w);
    expect(w.restarts).toEqual([['lead', '--resume', 'conv-lead', '--session', SESSION]]);
    expect(lines).toEqual(['lead: restarted itself with its conversation conv-lead']);
    expect(queued()).toBe(false);
    expect(hasSelfRestartRequests(dir)).toBe(false);
    await pass(w);
    expect(w.restarts).toHaveLength(1);
    expect(w.notices).toEqual([]);
  });

  test('a failed restart is tried once and said to the lead', async () => {
    queue();
    const w = world();
    w.status = 'done';
    w.exit = 1;
    await pass(w);
    await pass(w);
    expect(w.restarts).toHaveLength(1);
    expect(w.notices).toEqual([{ lead: 'lead', body: 'lead: self-restart failed (team restart: the seat did not come back)' }]);
  });

  test('gives up past the bound with a report to the lead', async () => {
    queue();
    const w = world();
    w.clock = new Date(T0.getTime() + SELF_RESTART_BOUND_MS + 1_000);
    w.status = 'idle';
    await pass(w);
    expect(w.restarts).toEqual([]);
    expect(queued()).toBe(false);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.body).toStartWith('lead: self-restart given up: it did not come idle with an empty input line within 30 min');
  });

  test('a request for an earlier launch, or one that does not verify, is dropped unrun', async () => {
    queue();
    const state = JSON.parse(readFileSync(join(dir, 'team.state.json'), 'utf8'));
    state.sessions[SESSION].seats.lead.launched = { shell: 701, cli: [801] };
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify(state));
    const w = world();
    w.status = 'idle';
    expect(await pass(w)).toEqual(['lead: its self-restart request names an earlier launch; dropped unrun']);
    // A request written by hand, or edited after signing, names no signature this key made.
    queue();
    const path = selfRestartPath(dir, SESSION, 'lead');
    const forged = { ...JSON.parse(readFileSync(path, 'utf8')), conversation: 'conv-other' };
    writeFileSync(path, JSON.stringify(forged));
    expect((await pass(w))[0]).toContain('does not verify; dropped unrun');
    expect(w.restarts).toEqual([]);
    expect(queued()).toBe(false);
  });
});

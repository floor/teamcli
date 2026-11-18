// E7b round 11: the launch line and its launch-level record, through the real executePlan.
// A launch whose pending record cannot be published never types its line; a terminal host that
// reports false (ambiguous: it also does so when only its capture failed) keeps the pending record;
// a retirement removes only the pending record carrying its own attempt's nonce; and each
// (session, seat) pair has a file of its own. Panes, processes and the clock are synthetic.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';
import { launchPending, launchRetire, readLaunchRecord } from '../src/queue/launch-level.ts';
import { queuesFolder } from '../src/queue/floor.ts';
import { acquireLockAt } from '../src/launch/seat-lock.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const SESSION = 'launch-submit';
const SEAT = 'alpha';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-workspace';

function place(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-submit-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  return { root, home };
}

function steps(root: string): Step[] {
  const seat: UpSeat = {
    name: SEAT, cli: 'claude-code', launch: 'claude --model claude-sonnet-5-5', cwd: '.', label: SEAT,
    repairLine: '', stopped: false, rules: '',
  };
  return upPlan({ root, session: SESSION, sessionRunning: true, seats: [seat], watchLabel: `Watch · ${SESSION}`, startWatch: false });
}

function host(at: { root: string; home: string }, paneRun: () => boolean): { host: Host; typed: () => number; said: string[] } {
  let typed = 0;
  let clock = 0;
  const said: string[] = [];
  const made: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => { typed += 1; return paneRun(); },
    typeLine: async () => false,
    renameAgent: () => true,
    agentList: () => [{ name: SEAT, agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: at.root }],
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['claude'],
    processInfo: () => null,
    classify: () => 'idle',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => { said.push(line); },
    log: () => {},
    launchLevelAt: { root: at.root, home: at.home },
  };
  return { host: made, typed: () => typed, said };
}

test('a pending record that cannot be published (activation lock held): the line is never typed, the seat is reported not run', async () => {
  const at = place();
  const made = host(at, () => true);
  // The activation proof holds its lock for the whole run (as `team queues activate` does).
  const folder = queuesFolder(at.root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const lock = acquireLockAt(join(folder, 'activation.lock'), folder, undefined, { waitMs: 2000, pollMs: 25 });
  if (!('release' in lock)) throw new Error('the fixture could not take the activation lock');
  let report: unknown;
  try {
    report = await executePlan(steps(at.root), SESSION, made.host);
  } finally {
    lock.release();
  }
  expect(made.typed()).toBe(0);
  expect(JSON.stringify(report) + made.said.join('\n')).toContain('its launch record could not be published');
  expect(readLaunchRecord(at.root, at.home, SESSION, SEAT).kind).toBe('absent');
}, 30_000);

test('a terminal host that reports false keeps the pending record: the seat stays unknown (in flight)', async () => {
  const at = place();
  const made = host(at, () => false);
  await executePlan(steps(at.root), SESSION, made.host);
  expect(made.typed()).toBe(1);
  expect(readLaunchRecord(at.root, at.home, SESSION, SEAT).kind).toBe('pending');
}, 30_000);

test('a typed launch leaves its pending record for the idle-prompt proof', async () => {
  const at = place();
  const made = host(at, () => true);
  await executePlan(steps(at.root), SESSION, made.host);
  expect(made.typed()).toBe(1);
  expect(['pending', 'proven']).toContain(readLaunchRecord(at.root, at.home, SESSION, SEAT).kind);
}, 30_000);

test('a retirement carrying another attempt\'s nonce leaves the record; its own nonce removes it', () => {
  const at = place();
  const first = launchPending(at.root, at.home, SESSION, SEAT, null) as string;
  const second = launchPending(at.root, at.home, SESSION, SEAT, null) as string;
  expect(first).not.toBe(second);
  expect(launchRetire(at.root, at.home, SESSION, SEAT, first)).toBe(true);
  const standing = readLaunchRecord(at.root, at.home, SESSION, SEAT);
  expect(standing.kind === 'pending' && standing.nonce).toBe(second);
  expect(launchRetire(at.root, at.home, SESSION, SEAT, second)).toBe(true);
  expect(readLaunchRecord(at.root, at.home, SESSION, SEAT).kind).toBe('absent');
});

test('team.one/builder and team/one.builder have separate records that do not interfere', async () => {
  const { launchRecordSeats } = await import('../src/queue/launch-level.ts');
  const at = place();
  const a = launchPending(at.root, at.home, 'team.one', 'builder', null) as string;
  const b = launchPending(at.root, at.home, 'team', 'one.builder', null) as string;
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(launchRecordSeats(at.root, at.home)).toEqual([{ session: 'team', seat: 'one.builder' }, { session: 'team.one', seat: 'builder' }]);
  expect(launchRetire(at.root, at.home, 'team.one', 'builder', a)).toBe(true);
  expect(readLaunchRecord(at.root, at.home, 'team.one', 'builder').kind).toBe('absent');
  const other = readLaunchRecord(at.root, at.home, 'team', 'one.builder');
  expect(other.kind === 'pending' && other.nonce).toBe(b);
});

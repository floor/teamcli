// S0b acceptance: `team check` reports the pane watch that owns the session, through the same
// sitting `up` plans from. A healthy watch leaves no trace (as a healthy hosted one does), a
// dead or stale one names the next `up`'s repair, a missing one is named only when the daemon
// reading proves no hosted watch exists, and a standing-by hosted watch does not claim a live
// pane watch that is not there. Notes only: no scene changes an exit or a total.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck, type CheckSources } from '../../src/check/team.ts';
import type { DaemonHealth } from '../../src/daemon/health.ts';
import type { DaemonRootState } from '../../src/daemon/state.ts';
import { workspaceLabel } from '../../src/file/sections/seats.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { updateState } from '../../src/state.ts';
import { approvalStanding } from '../../src/store/store.ts';
import type { Live } from '../../src/status/compare.ts';
import type { HostedWatchState } from '../../src/watch/hosted.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const AT = NOW.toISOString();
const FRESH = new Date(NOW.getTime() - 30_000).toISOString();
const OLD = new Date(NOW.getTime() - 5 * 60_000).toISOString();

const TEXT = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

type Place = { root: string; dir: string; home: string };

function place(watch: { pid?: number; heartbeat: string } | undefined): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b2-check-watch-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEXT);
  updateState(dir, (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } },
      worktrees: {},
      ...(watch === undefined ? {} : { watch }),
    };
  });
  deliverBriefs({ dir, root, session: 'acme', seats: ['lead'], home, at: AT });
  return { root, dir, home };
}

function live(): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: workspaceLabel(seat) }],
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

function sources(at: Place, reading: DaemonHealth | undefined, alive?: (pid: number) => boolean): CheckSources {
  return {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    pendingGreen: () => [],
    ...(alive ? { alive } : {}),
    ...(reading === undefined ? {} : { daemon: reading }),
  };
}

function notes(at: Place, reading: DaemonHealth | undefined, alive?: (pid: number) => boolean): string[] {
  const io = testIo(at.root, { kind: 'owner' });
  // The check's own differences already count a missing or old watch; this scene reads only the
  // notes the S0b reading adds, so the exit it reaches is not part of the assertion.
  runTeamCheck({ file: '.agents/team.yaml', json: true }, io, sources(at, reading, alive));
  return (JSON.parse(io.out) as { notes: string[] }).notes;
}

function route(over: Partial<DaemonRootState> = {}): DaemonRootState {
  return { root: '', team: 'acme', send: 'serving', bus: 'serving', why: null, ...over };
}

function hosted(over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: 'route-acme',
    root: '',
    team: 'acme',
    session: 'acme',
    phase: 'running',
    startedAt: '2026-10-21T11:00:00Z',
    lastCycleAt: '2026-10-21T11:59:30Z',
    lastCycleOutcome: 'pass',
    cycles: 12,
    failures: 0,
    effects: 'open',
    required: true,
    why: null,
    ...over,
  };
}

function health(over: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: '/work/daemon.sock',
    state: 'running',
    running: true,
    pid: 42,
    uid: 501,
    since: '2026-10-21T10:00:00Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    heartbeatAt: '2026-10-21T11:59:58Z',
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: AT },
    why: null,
    ...over,
  };
}

function watched(at: Place, watch: HostedWatchState): DaemonHealth {
  return health({ roots: [route({ root: realpathSync(at.root), watch: { ...watch, root: realpathSync(at.root) } })] });
}

const unknown = () => health({
  state: 'unknown',
  running: null,
  probe: { state: 'unknown', at: AT, reason: 'the state record is unreadable' },
  why: 'the state record is unreadable',
});

test('no record with a known daemon says the next up starts one', () => {
  const at = place(undefined);
  expect(notes(at, health())).toContain('watch: none running; the next team up starts one');
});

test('no daemon reading makes no missing claim', () => {
  const at = place(undefined);
  expect(notes(at, undefined).filter((line) => line.startsWith('watch:'))).toEqual([]);
});

test('an unknown reading makes no missing claim either', () => {
  const at = place(undefined);
  const all = notes(at, unknown());
  expect(all.some((line) => line.includes('none running'))).toBe(false);
  expect(all.some((line) => line.includes('cannot tell whether it is running'))).toBe(true);
});

test('an unknown reading names a stale pane watch without promising a repair up will not make', () => {
  const at = place({ pid: 4242, heartbeat: OLD });
  const all = notes(at, unknown(), (pid) => pid === 4242);
  expect(all).toContain(
    'watch: process 4242 is alive but its heartbeat is old; the daemon health cannot say whether a hosted watch owns the route',
  );
  expect(all.some((line) => line.includes('next team up'))).toBe(false);
});

test('a recorded process that is gone names the start the next up makes', () => {
  const at = place({ pid: 4242, heartbeat: FRESH });
  expect(notes(at, health(), () => false))
    .toContain('watch: the recorded process 4242 is gone; the next team up starts one');
});

test('a live process behind an old beat is stale and names the replacement', () => {
  const at = place({ pid: 4242, heartbeat: OLD });
  expect(notes(at, health(), (pid) => pid === 4242))
    .toContain('watch: process 4242 is alive but its heartbeat is old; the next team up replaces it');
});

test('a healthy pane watch leaves no trace', () => {
  const at = place({ pid: 4242, heartbeat: FRESH });
  expect(notes(at, health(), (pid) => pid === 4242).filter((line) => line.startsWith('watch:')))
    .toEqual([]);
});

test('a running hosted watch says nothing and suppresses the pane note', () => {
  const at = place(undefined);
  expect(notes(at, watched(at, hosted())).filter((line) => line.startsWith('watch:'))).toEqual([]);
});

test('a standing-by hosted watch over a missing pane names the missing pane, not a live one', () => {
  const at = place(undefined);
  const all = notes(at, watched(at, hosted({ phase: 'standby', why: 'a pane watch owns the session' })));
  expect(all).toContain('watch: none running; the next team up starts one');
  expect(all.some((line) => line.includes('standing by'))).toBe(false);
});

test('a standing-by hosted watch over a live pane keeps its line and adds no pane note', () => {
  const at = place({ pid: 4242, heartbeat: FRESH });
  const all = notes(at, watched(at, hosted({ phase: 'standby', why: 'a pane watch owns the session' })), (pid) => pid === 4242);
  expect(all.some((line) => line.includes('standing by; a live pane watch owns this session'))).toBe(true);
  expect(all.some((line) => line.includes('next team up'))).toBe(false);
});

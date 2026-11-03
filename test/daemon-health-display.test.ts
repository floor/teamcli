// The machine daemon's one neutral reading, as `team status` and `team check` print it. The
// renderer is pure, so these scenes pin the words without a socket; the two integration scenes
// pin the single probe at each command's boundary, the JSON field, and that the idle and green
// readings keep their lines beside it. No scene reads the owner's real home or daemon.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { check } from '../src/commands/check.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { daemonStatePath } from '../src/daemon/paths.ts';
import { readDaemonState, type DaemonRootState } from '../src/daemon/state.ts';
import { daemonHealthy, daemonNotes, daemonProblemNotes, daemonReading, firstPassPhrases } from '../src/daemon/health_display.ts';
import { hostedWatchCheckNotes, hostedWatchDifferences, hostedWatchNotes } from '../src/daemon/watch_display.ts';
import { whoOfDifference } from '../src/output/text.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const AT = NOW.toISOString();
const SOCKET = '/home/someone/.config/team/daemon.sock';
const HEALTHY_LINE = `machine daemon: running since 2026-10-19T08:00:00.000Z (pid 42), started by the system's service manager`;

function health(over: Partial<DaemonHealth> = {}): DaemonHealth {
  return {
    daemon: 'teamcli',
    socket: SOCKET,
    state: 'running',
    running: true,
    pid: 42,
    uid: 501,
    since: '2026-10-19T08:00:00.000Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    gitHead: null,
    heartbeatAt: '2026-10-19T08:59:58.000Z',
    heartbeatSeconds: null,
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    probe: { state: 'answered', at: AT },
    why: null,
    ...over,
  };
}

function root(over: Partial<DaemonRootState> = {}): DaemonRootState {
  return { root: '/work/acme', team: 'acme', send: 'serving', bus: 'serving', why: null, ...over };
}

function watch(over: Partial<HostedWatchState> = {}): HostedWatchState {
  return {
    routeId: 'route-acme',
    root: '/work/acme',
    team: 'acme',
    session: 'acme',
    phase: 'running',
    startedAt: '2026-10-19T08:00:00.000Z',
    lastCycleAt: '2026-10-19T08:57:00.000Z',
    lastCycleOutcome: 'pass',
    cycles: 12,
    failures: 0,
    effects: 'open',
    required: true,
    why: null,
    ...over,
  };
}

function watched(over: Partial<HostedWatchState> = {}): DaemonHealth {
  return health({ roots: [root({ watch: watch(over) })] });
}

/** A reading whose one watched route is the checkout a check scene placed, so the check's own
 *  sitting names it: the difference is the check's own route's, never another checkout's. */
function atWatch(at: { root: string }, over: Partial<HostedWatchState> = {}): DaemonHealth {
  const routeRoot = realpathSync(at.root);
  return health({ roots: [root({ root: routeRoot, watch: watch({ root: routeRoot, ...over }) })] });
}

function notRunning(): DaemonHealth {
  return health({
    state: 'not-running',
    running: false,
    pid: null,
    uid: null,
    since: null,
    startedBy: null,
    version: null,
    heartbeatAt: null,
    features: null,
    probe: { state: 'unanswered', at: AT, reason: 'closed' },
  });
}

function unknown(why = 'the daemon state record cannot be read'): DaemonHealth {
  return health({
    state: 'unknown',
    running: null,
    pid: null,
    uid: null,
    since: null,
    startedBy: null,
    version: null,
    heartbeatAt: null,
    features: null,
    probe: { state: 'unknown', at: AT, reason: why },
    why,
  });
}

test('the reading carried in the document leaves out the socket path and the uid', () => {
  const reading = daemonReading(health({
    stuck: [{ id: 'req-1', op: 'dispatch', since: '2026-10-19T08:59:00.000Z', ageMs: 60000 }],
  }));
  expect(reading).toEqual({
    state: 'running',
    running: true,
    pid: 42,
    since: '2026-10-19T08:00:00.000Z',
    startedBy: 'service-manager',
    version: '0.5.4',
    heartbeatAt: '2026-10-19T08:59:58.000Z',
    features: { broker: 'absent' },
    stuck: [{ id: 'req-1', op: 'dispatch', since: '2026-10-19T08:59:00.000Z', ageMs: 60000 }],
    probe: { state: 'answered', at: AT },
    roots: [],
    why: null,
  });
  const loose = reading as Record<string, unknown>;
  expect(loose.socket).toBeUndefined();
  expect(loose.uid).toBeUndefined();
  expect(loose.daemon).toBeUndefined();
});

test('a healthy daemon is one line, and every line stays neutral', () => {
  expect(daemonNotes(null)).toEqual([]);
  expect(daemonNotes(health())).toEqual([HEALTHY_LINE]);
  expect(daemonNotes(health({ startedBy: 'manual' }))).toEqual([
    `machine daemon: running since 2026-10-19T08:00:00.000Z (pid 42), started manually`,
  ]);
  expect(daemonNotes(health({ startedBy: 'team-up' }))).toEqual([
    'machine daemon: running since 2026-10-19T08:00:00.000Z (pid 42), started by `team up`',
  ]);
  expect(daemonNotes(health({ startedBy: null }))).toEqual([
    'machine daemon: running since 2026-10-19T08:00:00.000Z (pid 42), started by an unrecorded launcher',
  ]);
  expect(daemonNotes(health({ since: null }))).toEqual([
    "machine daemon: running (pid 42), started by the system's service manager",
  ]);
  const lines = [
    ...daemonNotes(health()),
    ...daemonNotes(notRunning()),
    ...daemonNotes(unknown()),
    ...daemonNotes(health({ probe: { state: 'unanswered', at: AT, reason: 'timeout' } })),
  ];
  for (const line of lines) {
    expect(line).not.toContain(SOCKET);
    expect(line).not.toContain('.sock');
    expect(line).not.toContain('uid');
    expect(line.toLowerCase()).not.toContain('launchd');
    expect(line.toLowerCase()).not.toContain('systemd');
    expect(line.toLowerCase()).not.toContain('launchagent');
  }
});

test('a running daemon that does not answer reads as possibly hung, never as healthy', () => {
  expect(daemonNotes(health({ probe: { state: 'unanswered', at: AT, reason: 'timeout' } }))).toEqual([
    `${HEALTHY_LINE}; it did not answer the health probe (timeout), so it may be hung`,
  ]);
  expect(daemonNotes(health({ probe: { state: 'unanswered', at: AT, reason: 'closed' } }))).toEqual([
    `${HEALTHY_LINE}; it did not answer the health probe (closed), so it may be hung`,
  ]);
  expect(daemonNotes(health({
    probe: { state: 'refused', at: AT, code: 'daemon.unsupported', message: 'health is not answered yet' },
  }))).toEqual([
    `${HEALTHY_LINE}; it refused the health probe (daemon.unsupported: health is not answered yet)`,
  ]);
  expect(daemonNotes(health({
    stuck: [
      { id: 'req-1', op: 'dispatch', since: '2026-10-19T08:59:00.000Z', ageMs: 60000 },
      { id: 'req-2', op: 'health', since: '2026-10-19T08:59:30.000Z', ageMs: 30000 },
    ],
  }))).toEqual([
    `${HEALTHY_LINE}; 2 requests held past the stuck threshold (dispatch since 2026-10-19T08:59:00.000Z, health since 2026-10-19T08:59:30.000Z)`,
  ]);
});

test('absence and an unreadable record are different readings', () => {
  expect(daemonNotes(notRunning())).toEqual([
    "machine daemon: not running; `team daemon install` starts it from the system's service manager",
  ]);
  expect(daemonNotes(unknown())).toEqual([
    'machine daemon: cannot tell whether it is running (the daemon state record cannot be read)',
  ]);
  expect(daemonNotes(unknown())).not.toEqual(daemonNotes(notRunning()));
  expect(daemonNotes(unknown())[0]).not.toContain('not running');
});

test('check hears only an actionable reading, and absence is not one', () => {
  expect(daemonProblemNotes(null)).toEqual([]);
  expect(daemonProblemNotes(health())).toEqual([]);
  expect(daemonProblemNotes(notRunning())).toEqual([]);
  expect(daemonProblemNotes(unknown())).toEqual([
    'machine daemon: cannot tell whether it is running (the daemon state record cannot be read)',
  ]);
  expect(daemonProblemNotes(health({ probe: { state: 'unanswered', at: AT, reason: 'timeout' } }))).toEqual([
    `${HEALTHY_LINE}; it did not answer the health probe (timeout), so it may be hung`,
  ]);
  expect(daemonProblemNotes(health({
    stuck: [{ id: 'req-1', op: 'dispatch', since: '2026-10-19T08:59:00.000Z', ageMs: 60000 }],
  }))).toEqual([
    `${HEALTHY_LINE}; 1 request held past the stuck threshold (dispatch since 2026-10-19T08:59:00.000Z)`,
  ]);
  expect(daemonHealthy(health())).toBe(true);
  expect(daemonHealthy(notRunning())).toBe(false);
  expect(daemonHealthy(unknown())).toBe(false);
});

test('a running daemon says what it hosted, and a failed endpoint is never full health', () => {
  expect(daemonNotes(health({ roots: [root(), root({ root: '/work/beta', team: 'beta' })] }))).toEqual([
    `${HEALTHY_LINE}; roots 2 (send 2, bus 2)`,
  ]);
  const failed = health({
    roots: [root(), root({ root: '/work/beta', team: 'beta', send: 'failed', why: 'address in use' })],
  });
  expect(daemonNotes(failed)).toEqual([
    `${HEALTHY_LINE}; roots 2 (send 1, bus 2); 1 endpoint did not start here (send for /work/beta: address in use)`,
  ]);
  expect(daemonHealthy(failed)).toBe(false);
  expect(daemonProblemNotes(failed)).toEqual(daemonNotes(failed));
  expect(daemonNotes(health({ roots: [root({ bus: 'failed', why: null })] }))).toEqual([
    `${HEALTHY_LINE}; roots 1 (send 1, bus 0); 1 endpoint did not start here (bus for /work/acme: no reason recorded)`,
  ]);
  // An endpoint another process already serves is not a failure, but it is not hosted here either.
  const elsewhere = health({ roots: [root({ send: 'already-running' })] });
  expect(daemonNotes(elsewhere)).toEqual([
    `${HEALTHY_LINE}; roots 1 (send 0, bus 1); 1 endpoint not hosted here`,
  ]);
  expect(daemonHealthy(elsewhere)).toBe(true);
  expect(daemonProblemNotes(elsewhere)).toEqual([]);
  // A record written before roots were recorded says nothing about hosting.
  expect(daemonNotes(health())).toEqual([HEALTHY_LINE]);
  expect(daemonReading(failed).roots).toHaveLength(2);
});

test('a bus serving while its first pass runs says how far the scan got, then when it finished', () => {
  // A daemon-hosted bus is serving once its listener is bound, while the first pass still scans:
  // the row carries the pass's progress so "serving" is never read as caught up.
  const running = health({
    roots: [root({ firstPass: { running: true, scanned: 12_345, doneAt: null } })],
  });
  expect(daemonNotes(running)).toEqual([
    `${HEALTHY_LINE}; roots 1 (send 1, bus 1); first pass running for /work/acme (12,345 files scanned)`,
  ]);
  expect(daemonHealthy(running)).toBe(true);
  const done = health({
    roots: [root({ firstPass: { running: false, scanned: 45_871, doneAt: '2026-11-03T19:14:37.449Z' } })],
  });
  expect(daemonNotes(done)).toEqual([
    `${HEALTHY_LINE}; roots 1 (send 1, bus 1); first pass done at 2026-11-03T19:14:37.449Z for /work/acme`,
  ]);
  // Every checkout's pass is named by its own root, so a multi-root record is not ambiguous.
  const both = health({
    roots: [
      root({ firstPass: { running: true, scanned: 3, doneAt: null } }),
      root({
        root: '/work/beta',
        team: 'beta',
        firstPass: { running: false, scanned: 10, doneAt: '2026-11-03T19:20:00.000Z' },
      }),
    ],
  });
  expect(daemonNotes(both)).toEqual([
    `${HEALTHY_LINE}; roots 2 (send 2, bus 2); first pass running for /work/acme (3 files scanned); first pass done at 2026-11-03T19:20:00.000Z for /work/beta`,
  ]);
  // A starting endpoint is said once: it is not counted again as "not hosted here".
  expect(daemonNotes(health({ roots: [root({ bus: 'starting' })] }))).toEqual([
    `${HEALTHY_LINE}; roots 1 (send 1, bus 0); 1 endpoint starting`,
  ]);
});

const TEXT = `format: 1
project: acme
coordinator: lead
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

function place(): { root: string; dir: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-display-')));
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
      watch: { pid: 1, heartbeat: AT },
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

function statusSources(at: { root: string; home: string }, probe: StatusSources['daemonHealth']): StatusSources {
  return {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    idleWork: () => ({
      format: 1,
      at: AT,
      threshold_seconds: 300,
      takeable: 1,
      idle: [{ seat: 'lead', since: '2026-10-19T08:50:00.000Z' }],
    }),
    pendingGreen: () => [],
    ...(probe === undefined ? {} : { daemonHealth: probe }),
  };
}

function checkSources(at: { root: string; home: string }, probe: CheckSources['daemonHealth']): CheckSources {
  return {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    pendingGreen: () => [],
    ...(probe === undefined ? {} : { daemonHealth: probe }),
  };
}

const IDLE_LINE = 'idle with work: 1 idle seat past 5 minutes, 1 takeable; lead idle since 2026-10-19T08:50:00.000Z';

test('status probes the daemon once and prints one line beside the idle reading', async () => {
  const at = place();
  let probes = 0;
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runStatus(['--json'], io, statusSources(at, async () => {
    probes += 1;
    return health();
  }));
  const doc = JSON.parse(io.out) as {
    notes: string[];
    idle_work: { takeable: number };
    daemon: Record<string, unknown>;
  };
  expect(code).toBe(0);
  expect(probes).toBe(1);
  expect(doc.notes).toContain(HEALTHY_LINE);
  expect(doc.notes).toContain(IDLE_LINE);
  expect(doc.idle_work.takeable).toBe(1);
  expect(doc.daemon.state).toBe('running');
  expect(doc.daemon.socket).toBeUndefined();
  expect(doc.daemon.uid).toBeUndefined();
  expect(doc.notes.filter((note) => note.startsWith('machine daemon:'))).toHaveLength(1);

  const text = testIo(at.root, { kind: 'owner' });
  expect(await runStatus([], text, statusSources(at, async () => health()))).toBe(0);
  expect(text.out).toContain(HEALTHY_LINE);
  expect(text.out).toContain(IDLE_LINE);
  expect(text.out.split('machine daemon:')).toHaveLength(2);
  expect(text.out).not.toContain(SOCKET);
});

test('status says an unreadable daemon as cannot tell, never as not running', async () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  await runStatus(['--json'], io, statusSources(at, async () => unknown()));
  const doc = JSON.parse(io.out) as { notes: string[]; daemon: { state: string } };
  expect(doc.daemon.state).toBe('unknown');
  expect(doc.notes).toContain('machine daemon: cannot tell whether it is running (the daemon state record cannot be read)');
  expect(doc.notes.join('\n')).not.toContain('machine daemon: not running');
});

test('a watch record its daemon left behind never reads as the current watch', async () => {
  const at = place();
  // The state one daemon (pid 4242) wrote before it stopped: a hosted record carries the epoch
  // fence, and this one is 90 minutes stale at the reading's instant.
  updateState(at.dir, (state) => {
    state.sessions.acme = {
      ...state.sessions.acme!,
      watch: { pid: 4242, epoch: 'watch_0123456789abcdef0123456789abcdef', heartbeat: '2026-10-19T07:30:00.000Z' },
    };
  });
  const alive = (pid: number) => pid !== 4242;
  const read = async (probe: () => Promise<DaemonHealth>): Promise<string[]> => {
    const io = testIo(at.root, { kind: 'owner' });
    const code = await runStatus(['--json'], io, { ...statusSources(at, async () => probe()), alive });
    // The 90-minute heartbeat is its own difference; this scene reads the notes.
    expect(code).toBe(1);
    return (JSON.parse(io.out) as { notes: string[] }).notes;
  };
  // The live daemon has not reached this checkout yet and is still in a first pass over an
  // earlier one: the note says what is happening now, and names the old process for what it is.
  const notYet = await read(async () => health({
    pid: 5151,
    roots: [root({ root: '/work/demo', team: 'acme', firstPass: { running: true, scanned: 1234, doneAt: null } })],
  }));
  expect(notYet).toContain('root not yet hosted by daemon 5151 (first pass running)');
  expect(notYet).toContain('watch record names a stopped daemon (pid 4242)');
  expect(notYet.some((note) => note.includes('pid 4242, last heartbeat'))).toBe(false);
  // The daemon hosts the checkout now, so nothing is said about a root on its way; the record is
  // still a dead process and still says so. With no first pass running, the parenthetical is not
  // claimed.
  const hosted = await read(async () => health({ pid: 5151, roots: [root({ root: realpathSync(at.root) })] }));
  expect(hosted).toContain('watch record names a stopped daemon (pid 4242)');
  expect(hosted.some((note) => note.startsWith('root not yet hosted'))).toBe(false);
  const behind = await read(async () => health({ pid: 5151, roots: [root({ root: '/work/demo', team: 'acme' })] }));
  expect(behind).toContain('root not yet hosted by daemon 5151');
  expect(behind.some((note) => note.includes('(first pass running)'))).toBe(false);
  // The record names the live daemon, but that daemon has no row for this checkout: it is not
  // the watch here either, and the process is alive, so nothing calls it stopped.
  updateState(at.dir, (state) => {
    state.sessions.acme = {
      ...state.sessions.acme!,
      watch: { pid: 5151, epoch: 'watch_0123456789abcdef0123456789abcdef', heartbeat: '2026-10-19T07:30:00.000Z' },
    };
  });
  const otherRoots = await read(async () => health({ pid: 5151, roots: [root({ root: '/work/demo', team: 'acme' })] }));
  expect(otherRoots).toContain('root not yet hosted by daemon 5151');
  expect(otherRoots.some((note) => note.includes('stopped daemon'))).toBe(false);
  // A pane watch record names a watch process, not a daemon's: its own line stands.
  updateState(at.dir, (state) => {
    state.sessions.acme = { ...state.sessions.acme!, watch: { pid: 4242, pane: 'lead-pane', heartbeat: '2026-10-19T07:30:00.000Z' } };
  });
  const pane = await read(async () => health({ pid: 5151, roots: [] }));
  expect(pane).toContain('watch: pane lead-pane, pid 4242, last heartbeat 90 min ago');
});

test('the command wrapper probes once and the report only reads the snapshot', async () => {
  const at = place();
  let probes = 0;
  const io = testIo(at.root, { kind: 'owner' });
  const code = await check(['--json'], io, undefined, checkSources(at, async () => {
    probes += 1;
    return unknown();
  }));
  const doc = JSON.parse(io.out) as { notes: string[]; daemon: { state: string } };
  expect(code).toBe(0);
  expect(probes).toBe(1);
  expect(doc.daemon.state).toBe('unknown');
  expect(doc.notes).toContain('machine daemon: cannot tell whether it is running (the daemon state record cannot be read)');
});

test('check is silent for a healthy daemon and still carries its reading in the document', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: health(),
  });
  expect(code).toBe(0);
  expect(io.out).not.toContain('machine daemon:');
  const asJson = testIo(at.root, { kind: 'owner' });
  expect(runTeamCheck({ file: '.agents/team.yaml', json: true }, asJson, {
    ...checkSources(at, undefined),
    daemon: health(),
  })).toBe(0);
  const doc = JSON.parse(asJson.out) as { notes: string[]; daemon: { state: string; socket?: string } };
  expect(doc.daemon.state).toBe('running');
  expect(doc.daemon.socket).toBeUndefined();
  expect(doc.notes).not.toContain(HEALTHY_LINE);
});

test('a hung daemon is a check note that changes no total and no exit', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: health({ probe: { state: 'unanswered', at: AT, reason: 'timeout' } }),
  });
  expect(code).toBe(0);
  expect(io.out).toContain(
    `${HEALTHY_LINE}; it did not answer the health probe (timeout), so it may be hung`,
  );
  expect(io.out).toContain('no differences');
});

test('a hosted endpoint that did not start is a check note and a difference, and machine health alone is not health', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: health({ roots: [root({ send: 'failed', why: 'address in use' })] }),
  });
  // A record written before failures kept their instant still names the failure; only its age
  // is missing, and the row is counted like any other failed endpoint.
  expect(code).toBe(1);
  expect(io.out).toContain('roots 1 (send 0, bus 1)');
  expect(io.out).toContain('1 endpoint did not start here (send for /work/acme: address in use)');
  expect(io.out).toContain('machine daemon send endpoint for /work/acme: address in use');
  expect(io.out).toContain('team daemon install');
});

const BLOCKED = 'watch: outbound effects blocked; it is not enforcing anything';
const WATCH_REPAIR = 'team daemon install with the same roots and --watch';

test('a hosted watch is silent when the record carries none, and says its own phase when it does', () => {
  const RUNNING = 'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version 0.5.4';
  expect(hostedWatchNotes(health(), NOW)).toEqual([]);
  expect(hostedWatchNotes(watched(), NOW)).toEqual([RUNNING]);
  // A running watch names the instant it started and the daemon's build, never a borrowed
  // last-cycle time; a reading with no version says so rather than inventing one.
  expect(hostedWatchNotes(watched({ lastCycleAt: null, lastCycleOutcome: null, cycles: 0 }), NOW)).toEqual([
    RUNNING,
  ]);
  expect(hostedWatchNotes(health({ version: null, roots: [root({ watch: watch() })] }), NOW)).toEqual([
    'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version unknown',
  ]);
  expect(hostedWatchNotes(watched({ phase: 'starting', lastCycleAt: null }), NOW)).toEqual([
    'watch: starting in the daemon, not yet cycled',
  ]);
  expect(hostedWatchNotes(watched({ phase: 'stopping' }), NOW)).toEqual(['watch: stopping in the daemon']);
  expect(hostedWatchNotes(watched({ phase: 'stopped', why: 'the daemon is closing' }), NOW)).toEqual([
    'watch: stopped in the daemon (the daemon is closing)',
  ]);
  expect(hostedWatchNotes(watched({ phase: 'stopped', why: null }), NOW)).toEqual([
    'watch: stopped in the daemon (no reason recorded)',
  ]);
  expect(hostedWatchNotes(watched({ phase: 'failed', why: 'the first pass threw' }), NOW)).toEqual([
    'watch: failed in the daemon (the first pass threw)',
  ]);
});

test('a standing-down watch names the pane watch and claims no daemon cycle', () => {
  const lines = hostedWatchNotes(
    watched({ phase: 'standby', lastCycleAt: null, lastCycleOutcome: null, why: 'the session is watched from a pane' }),
    NOW,
  );
  expect(lines).toEqual([
    'watch: standing by; a live pane watch owns this session (the session is watched from a pane)',
  ]);
  expect(lines[0]).not.toContain('last cycle');
  expect(lines[0]).not.toContain('not yet cycled');
  expect(lines[0]).not.toContain('in daemon');
});

test('a closed outbound gate is said as blocked, never as enforcing', () => {
  expect(hostedWatchNotes(watched({ effects: 'blocked' }), NOW)).toEqual([
    'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version 0.5.4',
    BLOCKED,
  ]);
  expect(BLOCKED).toContain('not enforcing anything');
  expect(BLOCKED).not.toContain('in daemon,');
});

test('several watched routes each name their own root, so one failure reads beside a good one', () => {
  const two = health({
    roots: [
      root({ watch: watch() }),
      root({
        root: '/work/beta',
        team: 'beta',
        watch: watch({
          routeId: 'route-beta',
          root: '/work/beta',
          team: 'beta',
          session: 'beta',
          phase: 'failed',
          why: 'the send endpoint failed',
        }),
      }),
    ],
  });
  expect(hostedWatchNotes(two, NOW)).toEqual([
    'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version 0.5.4 (/work/acme)',
    'watch: failed in the daemon (the send endpoint failed) (/work/beta)',
  ]);
});

test('check hears a running watch only when its last cycle failed', () => {
  expect(hostedWatchCheckNotes(health({ roots: [root()] }), NOW)).toEqual([]);
  expect(hostedWatchCheckNotes(watched(), NOW)).toEqual([]);
  expect(hostedWatchCheckNotes(watched({ lastCycleOutcome: 'failed', failures: 1 }), NOW)).toEqual([
    'watch: the last cycle failed 3m ago',
  ]);
  expect(hostedWatchCheckNotes(watched({ lastCycleAt: null, lastCycleOutcome: 'failed', failures: 1 }), NOW)).toEqual([
    'watch: the last cycle failed',
  ]);
  // Starting and stopping are transient, not something to act on.
  expect(hostedWatchCheckNotes(watched({ phase: 'starting', lastCycleAt: null }), NOW)).toEqual([]);
  expect(hostedWatchCheckNotes(watched({ phase: 'stopping' }), NOW)).toEqual([]);
});

test('check names a required stopped or failed watch, and stays quiet for one never required', () => {
  // A watched route the check's own sitting does not name — another checkout beside this one —
  // keeps today's note: only this team's watch is this check's difference.
  expect(hostedWatchCheckNotes(watched({ phase: 'stopped', why: 'the daemon is closing' }), NOW)).toEqual([
    'watch: stopped in the daemon (the daemon is closing)',
  ]);
  expect(hostedWatchCheckNotes(watched({ phase: 'failed', why: 'the first pass threw' }), NOW)).toEqual([
    'watch: failed in the daemon (the first pass threw)',
  ]);
  expect(
    hostedWatchCheckNotes(watched({ phase: 'stopped', required: false, why: 'the daemon is closing' }), NOW),
  ).toEqual([]);
});

test('a stopped, a failed and a blocked watch are the check\'s difference, with its repair', () => {
  const row = (over: Partial<HostedWatchState>) =>
    hostedWatchDifferences({ kind: 'hosted', root: '/work/acme', watch: watch(over) });
  // A pane watch, a healthy cycle, a single failed cycle beside a running one, the transient
  // phases, a standing-down watch and one never required are not differences: only a watch that
  // is not enforcing anything is.
  expect(hostedWatchDifferences({ kind: 'pane', health: { state: 'missing' } })).toEqual([]);
  expect(row({})).toEqual([]);
  expect(row({ lastCycleOutcome: 'failed', failures: 1 })).toEqual([]);
  expect(row({ phase: 'starting', lastCycleAt: null })).toEqual([]);
  expect(row({ phase: 'stopping' })).toEqual([]);
  expect(row({ phase: 'standby', why: 'a pane watch holds the session "acme"' })).toEqual([]);
  expect(row({ phase: 'failed', required: false })).toEqual([]);
  const failed = row({ phase: 'failed', why: 'the first pass threw' });
  expect(failed).toEqual([{ what: 'watch: failed in the daemon (the first pass threw)', repair: WATCH_REPAIR }]);
  // The repair is the owner's own command, derived from the gate map rather than a word here.
  expect(whoOfDifference(failed[0]!)).toBe('the owner');
  expect(row({ phase: 'stopped', why: 'the daemon is closing' })).toEqual([
    { what: 'watch: stopped in the daemon (the daemon is closing)', repair: WATCH_REPAIR },
  ]);
  expect(row({ effects: 'blocked' })).toEqual([{ what: BLOCKED, repair: WATCH_REPAIR }]);
});

test('a difference is not said twice as a note, and another route\'s watch keeps its note', () => {
  const failed = watched({ phase: 'failed', why: 'the first pass threw' });
  // The route this check's difference names is not repeated as a note...
  expect(hostedWatchCheckNotes(failed, NOW, { differing: '/work/acme' })).toEqual([]);
  expect(hostedWatchCheckNotes(watched({ effects: 'blocked' }), NOW, { differing: '/work/acme' })).toEqual([]);
  // ...while a route the difference does not name keeps its line.
  expect(hostedWatchCheckNotes(failed, NOW, { differing: '/work/beta' })).toEqual([
    'watch: failed in the daemon (the first pass threw)',
  ]);
  // The failed cycle beside a blocked gate is still the note its own line carries.
  expect(
    hostedWatchCheckNotes(watched({ lastCycleOutcome: 'failed', failures: 1, effects: 'blocked' }), NOW, {
      differing: '/work/acme',
    }),
  ).toEqual(['watch: the last cycle failed 3m ago']);
});

test('check says standing by and a blocked gate as quiet honest notes', () => {
  expect(
    hostedWatchCheckNotes(
      watched({ phase: 'standby', lastCycleAt: null, why: 'the session is watched from a pane' }),
      NOW,
    ),
  ).toEqual(['watch: standing by; a live pane watch owns this session (the session is watched from a pane)']);
  expect(hostedWatchCheckNotes(watched({ effects: 'blocked' }), NOW)).toEqual([BLOCKED]);
});

test('status prints a watched route beside the daemon line, and the document carries the watch', async () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  await runStatus(
    ['--json'],
    io,
    statusSources(at, async () => health({ roots: [root({ watch: watch() })] })),
  );
  const doc = JSON.parse(io.out) as {
    notes: string[];
    daemon: { roots: Array<{ watch?: { phase: string; lastCycleAt: string | null } }> };
  };
  const RUNNING = 'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version 0.5.4';
  expect(doc.notes).toContain(RUNNING);
  expect(doc.daemon.roots[0]?.watch?.phase).toBe('running');
  expect(doc.daemon.roots[0]?.watch?.lastCycleAt).toBe('2026-10-19T08:57:00.000Z');

  const text = testIo(at.root, { kind: 'owner' });
  expect(
    await runStatus([], text, statusSources(at, async () => health({ roots: [root({ watch: watch() })] }))),
  ).toBe(0);
  expect(text.out).toContain(
    'watch: running in the daemon since 2026-10-19T08:00:00.000Z, version 0.5.4',
  );
});

test('a failed required watch is a check difference with its repair, and a healthy one leaves no trace', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: atWatch(at, { phase: 'failed', why: 'the first pass threw' }),
  });
  expect(code).toBe(1);
  expect(io.out).toContain('difference: watch: failed in the daemon (the first pass threw)');
  expect(io.out).toContain(`  repair: ${WATCH_REPAIR}`);
  expect(io.out).toContain('  who: the owner');
  expect(io.out).not.toContain('no differences');
  // The phase line stands once, in the difference: the note does not say it again.
  expect(io.out.split('watch: failed in the daemon (the first pass threw)')).toHaveLength(2);

  const quiet = testIo(at.root, { kind: 'owner' });
  expect(
    runTeamCheck({ file: '.agents/team.yaml' }, quiet, {
      ...checkSources(at, undefined),
      daemon: atWatch(at),
    }),
  ).toBe(0);
  expect(quiet.out).not.toContain('watch:');
});

test('a blocked outbound gate is a check difference with its repair', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: atWatch(at, { effects: 'blocked' }),
  });
  expect(code).toBe(1);
  expect(io.out).toContain(`difference: ${BLOCKED}`);
  expect(io.out).toContain(`  repair: ${WATCH_REPAIR}`);
  expect(io.out).toContain('  who: the owner');
  expect(io.out).not.toContain('no differences');
});

test('a running watch whose last cycle failed is a note and changes no exit', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: atWatch(at, { lastCycleOutcome: 'failed', failures: 1 }),
  });
  expect(code).toBe(0);
  expect(io.out).toContain('watch: the last cycle failed 3m ago');
  expect(io.out).toContain('no differences');
});

test('malformed firstPass state records are dropped at load and never print a false or timeless done phrase', () => {
  const at = place();
  const stateFile = daemonStatePath(at.home);
  mkdirSync(join(at.home, '.config', 'team'), { recursive: true });
  const rawRoots = [
    { root: '/work/no-time', team: 'a', send: 'serving', bus: 'serving', why: null, firstPass: { running: false, scanned: 10, doneAt: null } },
    { root: '/work/empty-time', team: 'b', send: 'serving', bus: 'serving', why: null, firstPass: { running: false, scanned: 10, doneAt: '' } },
    { root: '/work/contradict', team: 'c', send: 'serving', bus: 'serving', why: null, firstPass: { running: true, scanned: 10, doneAt: AT } },
    { root: '/work/negative', team: 'd', send: 'serving', bus: 'serving', why: null, firstPass: { running: true, scanned: -1, doneAt: null } },
    { root: '/work/float', team: 'e', send: 'serving', bus: 'serving', why: null, firstPass: { running: true, scanned: 1.5, doneAt: null } },
    { root: '/work/array', team: 'f', send: 'serving', bus: 'serving', why: null, firstPass: [] },
    { root: '/work/valid-running', team: 'g', send: 'serving', bus: 'serving', why: null, firstPass: { running: true, scanned: 0, doneAt: null } },
    { root: '/work/valid-done', team: 'h', send: 'serving', bus: 'serving', why: null, firstPass: { running: false, scanned: 1_000_000, doneAt: AT } },
  ];
  writeFileSync(
    stateFile,
    `${JSON.stringify({
      format: 1,
      pid: 42,
      uid: 501,
      since: '2026-10-19T08:00:00.000Z',
      startedBy: 'service-manager',
      version: '0.5.4',
      gitHead: null,
      heartbeatAt: '2026-10-19T08:59:58.000Z',
      socket: SOCKET,
      features: { broker: 'absent' },
      stuck: [],
      roots: rawRoots,
    })}\n`,
  );
  const parsed = readDaemonState(at.home);
  expect(parsed.kind).toBe('ok');
  if (parsed.kind !== 'ok') return;
  expect(parsed.state.roots).toHaveLength(8);
  for (let i = 0; i < 6; i += 1) {
    expect(parsed.state.roots[i]?.firstPass).toBeUndefined();
  }
  expect(parsed.state.roots[6]?.firstPass).toEqual({ running: true, scanned: 0, doneAt: null });
  expect(parsed.state.roots[7]?.firstPass).toEqual({ running: false, scanned: 1_000_000, doneAt: AT });
  expect(firstPassPhrases(parsed.state.roots)).toEqual([
    'first pass running for /work/valid-running (0 files scanned)',
    `first pass done at ${AT} for /work/valid-done`,
  ]);
});

test('stale watch record with dead pid is never shown as current across plain-text status, stopped daemon, and live hosted watch', async () => {
  const at = place();
  updateState(at.dir, (state) => {
    state.sessions.acme = {
      ...state.sessions.acme!,
      watch: { pid: 4242, epoch: 'watch_0123456789abcdef0123456789abcdef', heartbeat: '2026-10-19T08:59:50.000Z' },
    };
  });
  const alive = (pid: number) => pid !== 4242;

  // 1. Plain-text `team status` when daemon is not running (`state: 'not-running'`):
  //    never prints `pid 4242, last heartbeat` and never prints `root not yet hosted by daemon null`.
  const stoppedDaemonHealth: DaemonHealth = {
    ...notRunning(),
    pid: 4242,
  };
  const plainIo = testIo(at.root, { kind: 'owner' });
  await runStatus([], plainIo, { ...statusSources(at, async () => stoppedDaemonHealth), alive });
  expect(plainIo.out).toContain('watch record names a stopped daemon (pid 4242)');
  expect(plainIo.out).not.toContain('pid 4242, last heartbeat');
  expect(plainIo.out).not.toContain('root not yet hosted');

  // 2. When the recorded pid IS alive (`pid: 5151`) and the live daemon hosts this root,
  //    even if another root on the same daemon has `firstPass.running === true`, the current
  //    watch note stands as-is.
  updateState(at.dir, (state) => {
    state.sessions.acme = {
      ...state.sessions.acme!,
      watch: { pid: 5151, epoch: 'watch_0123456789abcdef0123456789abcdef', heartbeat: '2026-10-19T08:59:50.000Z' },
    };
  });
  const liveIo = testIo(at.root, { kind: 'owner' });
  await runStatus([], liveIo, {
    ...statusSources(at, async () =>
      health({
        pid: 5151,
        roots: [
          root({ root: realpathSync(at.root) }),
          root({ root: '/work/demo', team: 'acme', firstPass: { running: true, scanned: 500, doneAt: null } }),
        ],
      }),
    ),
    alive,
  });
  expect(liveIo.out).toContain('watch: pane not recorded, pid 5151, last heartbeat 10s ago');
  expect(liveIo.out).not.toContain('stopped daemon');
  expect(liveIo.out).not.toContain('root not yet hosted');
});


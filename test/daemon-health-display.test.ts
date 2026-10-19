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
import type { DaemonRootState } from '../src/daemon/state.ts';
import { daemonHealthy, daemonNotes, daemonProblemNotes, daemonReading } from '../src/daemon/health_display.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const AT = NOW.toISOString();
const SOCKET = '/Users/someone/.config/team/daemon.sock';
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
    heartbeatAt: '2026-10-19T08:59:58.000Z',
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

test('a hosted endpoint that did not start is a check note, and machine health alone is not health', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...checkSources(at, undefined),
    daemon: health({ roots: [root({ send: 'failed', why: 'address in use' })] }),
  });
  expect(code).toBe(0);
  expect(io.out).toContain('roots 1 (send 0, bus 1)');
  expect(io.out).toContain('1 endpoint did not start here (send for /work/acme: address in use)');
  expect(io.out).toContain('no differences');
});

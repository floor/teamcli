// The daemon's per-route restore entry (Gap 4C): it decides from the route's
// own state whether a restore pass may run, holds the session's run lock for the whole pass, and
// never cold-starts a team. These scenes drive the real `runUp` against a synthetic world, so the
// grants the sweep hands it (the owner caller, the held lock, the detached dialog mode) are
// exercised exactly as the daemon uses them, and nothing here reaches a live herdr.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { saveReadings, type Seen } from '../../src/budgets/readings.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { Launch, UpSources } from '../../src/commands/up.ts';
import { setHerdrRun, type HerdrAgent, type HerdrWorkspace, type PaneProcesses } from '../../src/herdr.ts';
import { runRestoreSweepForRoute } from '../../src/launch/restore-sweep.ts';
import { acquireRunLock, runLockText } from '../../src/launch/run-lock.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';
import { intoRegistry, underRegistry } from '../helpers/registry-team.ts';

const NOW = new Date('2026-10-21T15:00:00Z');
const AMPLE: Machine = {
  loadPerCore: 0.3, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};
const SEAT = { name: 'worker', pane: 'w1:p1', workspace: 'w1', shell: 500, cli: 501, label: 'Claude Opus 5.5' };
const TRUST_SCREEN = readFileSync(new URL('../fixtures/claude-code/2.1.289/trust-plain.txt', import.meta.url), 'utf8');

let base: string;
let root: string;
let home: string;
let teamFile: string;
let stateDir: string;

function teamText(): string {
  return `format: 1
project: sweep
coordinator: worker
operator: worker
session: sweep
workspace:
  mode: shared
trust:
  - ~/.config/team/lobby
  - ${root}
seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

/** The same file with the worker's account under a budget that the stored reading spends past. */
function budgetText(): string {
  return teamText().replace(
    'seats:',
    'budgets:\n  accounts:\n    anthropic: { kind: subscription, reserve: 10%, sources: [status_line] }\nseats:',
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restore-sweep-')));
  root = join(base, 'repo');
  home = join(base, 'home');
  stateDir = join(root, '.agents');
  teamFile = join(stateDir, 'team.yaml');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(teamFile, teamText());
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

/** The route's record: one seat recorded ready on its pane, with the identity the close reads. */
function recordSeat(): void {
  writeFileSync(
    join(stateDir, 'team.state.json'),
    JSON.stringify({
      format: 1,
      sessions: {
        sweep: {
          seats: {
            [SEAT.name]: {
              stage: 'ready',
              pane: SEAT.pane,
              workspace: SEAT.workspace,
              launched: { shell: SEAT.shell, cli: [SEAT.cli] },
            },
          },
          worktrees: {},
        },
      },
    }),
  );
}

type Made = {
  launch: Launch;
  session: 'running' | 'stopped' | 'absent';
  starts: number;
  creates: string[];
  runs: { pane: string; command: string }[];
  closes: string[];
  /** What `acquireRunLock` answered while the run was planning, if a scene asked. */
  lockDuring: ReturnType<typeof acquireRunLock> | null;
};

/** A world where the one recorded seat is alive on its recorded pane: the pass has nothing to
 *  repair, and every act the plan could take is counted. */
function world(): Made {
  const made: Made = {
    launch: {} as Launch,
    session: 'running',
    starts: 0,
    creates: [],
    runs: [],
    closes: [],
    lockDuring: null,
  };
  let clock = NOW.getTime();
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.starts += 1;
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      made.creates.push(label);
      return { pane: `${SEAT.workspace}:p2`, workspace: 'w2' };
    },
    paneRun(_session, pane, command) {
      made.runs.push({ pane, command });
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      made.closes.push(workspace);
      return true;
    },
    agentPanes: () => [SEAT.pane],
    agents: (): HerdrAgent[] => [{
      name: SEAT.name,
      agent: 'claude',
      pane: SEAT.pane,
      workspace: SEAT.workspace,
      status: 'idle',
      cwd: null,
    }],
    workspacePanes: () => [SEAT.pane],
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    processInfo: (): PaneProcesses => ({ shell: SEAT.shell, foreground: [SEAT.shell, SEAT.cli] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
}

function sources(made: Made, extra: Partial<UpSources> = {}): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => made.launch.agents('sweep'),
    workspaces: (): HerdrWorkspace[] => [{ id: SEAT.workspace, label: SEAT.label }],
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    doctor: doctor(),
    machine: () => AMPLE,
    ...extra,
  };
}

/** The owner approval a real `up` requires before it launches anything. */
async function approve(): Promise<void> {
  const code = await runApprove(['--file', teamFile], testIo(root, { kind: 'owner' }), {
    ask: async () => '5',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(code).toBe(0);
}

describe('the daemon restore sweep for one route', () => {
  test('a route with no recorded session is left alone without even reading the session', async () => {
    const made = world();
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result).toEqual({ kind: 'no-recorded-session' });
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
    expect(made.creates).toEqual([]);
  });

  test('a session-mutating run holding the lock is never launched over', async () => {
    recordSeat();
    const made = world();
    const held = acquireRunLock(stateDir, 'sweep');
    if ('held' in held) throw new Error('the scene could not take the run lock');
    try {
      const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
      expect(result).toEqual({ kind: 'lock-held', holder: process.pid });
      expect(runLockText(process.pid, 'sweep', stateDir)).toContain('another session-mutating run');
      expect(made.starts).toBe(0);
      expect(made.runs).toEqual([]);
    } finally {
      held.release();
    }
  });

  test('a recorded session the host does not have running is never cold-started', async () => {
    recordSeat();
    const made = world();
    made.session = 'absent';
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result).toEqual({ kind: 'not-running', state: 'absent' });
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
  });

  test('a healthy recorded seat runs the pass under the held lock and repairs nothing', async () => {
    recordSeat();
    await approve();
    const made = world();
    const listener = sources(made, {
      // `up`'s plan reads the agent list; asking for the lock here answers from inside the run.
      agents: () => {
        made.lockDuring ??= acquireRunLock(stateDir, 'sweep');
        return made.launch.agents('sweep');
      },
    });
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: listener });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.summary.line).toBe('0 seats repaired, 0 skipped (working), 0 refused');
    expect(result.failed).toBe(false);
    expect(made.lockDuring).not.toBeNull();
    expect(made.lockDuring !== null && 'held' in made.lockDuring ? made.lockDuring.held : null).toBe(process.pid);
    expect(made.starts).toBe(0);
    expect(made.closes).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
  });

  test('a healthy pass that launches no seat leaves the running seat\'s hook file untouched', async () => {
    recordSeat();
    await approve();
    // The settings file a launch installed earlier, as this build would not write it now. The
    // pass finds the seat healthy and launches nothing, so the file is not its to rewrite: its
    // mtime is the seat's declaration, and a running session must not be made stale by a pass
    // that repaired nothing.
    const hooks = join(stateDir, 'hooks', 'sweep');
    mkdirSync(hooks, { recursive: true, mode: 0o700 });
    const settings = join(hooks, 'worker.json');
    writeFileSync(settings, '{"hooks":{},"crossSessionInbound":"accept"}\n', { mode: 0o600 });
    const declaredAt = new Date('2026-10-20T09:00:00Z');
    utimesSync(settings, declaredAt, declaredAt);
    const before = statSync(settings).mtimeMs;
    const made = world();
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.summary.line).toBe('0 seats repaired, 0 skipped (working), 0 refused');
    expect(readFileSync(settings, 'utf8')).toBe('{"hooks":{},"crossSessionInbound":"accept"}\n');
    expect(statSync(settings).mtimeMs).toBe(before);
  });

  test('a refusal on a seat whose record says ready is held, and its record is left as it is', async () => {
    recordSeat();
    writeFileSync(teamFile, budgetText());
    const reading: Seen = {
      account: 'anthropic',
      window: 'weekly',
      left: 5,
      used: 95,
      changedAt: NOW.getTime() - 60_000,
      resetsAt: NOW.getTime() + 3_600_000,
      seat: 'anthropic',
      source: 'status_line',
      confirmed: true,
    };
    saveReadings(stateDir, [reading], NOW.getTime());
    await approve();
    const made = world();
    // The recorded pane is gone and no agent is named: the pass has to launch the seat, and the
    // budget refuses it before any workspace is made. The record it found still says ready.
    made.launch.agentPanes = () => [];
    made.launch.agents = () => [];
    made.launch.workspacePanes = () => [];
    made.launch.processInfo = () => null;
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.summary.refused_seats).toEqual([
      { seat: 'worker', reason: expect.stringContaining('left 5%') },
    ]);
    expect(result.failed).toBe(true);
    // Only the watch workspace is made: the refused seat starts nowhere.
    expect(made.creates).toEqual(['Watch · sweep']);
    expect(made.closes).toEqual([]);
    // The refusal is the run's, not the record's: the state is left exactly as it was found.
    const state = JSON.parse(readFileSync(join(stateDir, 'team.state.json'), 'utf8')) as {
      sessions: { sweep: { seats: Record<string, { stage?: string }> } };
    };
    expect(state.sessions.sweep.seats.worker?.stage).toBe('ready');
  });

  test('a dialog at a seat with no terminal is recorded waiting, never prompted or closed', async () => {
    recordSeat();
    await approve();
    const made = world();
    // The recorded pane is gone from the host, so the pass launches the seat fresh into w2; that
    // pane's screen reads a trust dialog. The daemon's run has no terminal to ask or close from.
    made.launch.agentPanes = () => [];
    made.launch.agents = () => [];
    made.launch.workspacePanes = () => [];
    made.launch.createWorkspace = (_session, _cwd, label) => {
      made.creates.push(label);
      return { pane: 'w2:p2', workspace: 'w2' };
    };
    made.launch.processInfo = (_session, pane) =>
      pane === SEAT.pane ? null : { shell: SEAT.shell, foreground: [SEAT.shell, SEAT.cli] };
    made.launch.paneText = () => TRUST_SCREEN;
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    // The seat is a refusal the owner reads, not a silent survivor, and the run itself failed.
    expect(result.summary.refused_seats).toEqual([{ seat: 'worker', reason: 'trust' }]);
    expect(result.failed).toBe(true);
    // Nothing is closed and no key or text is sent: the wait is recorded for a lead to finish,
    // exactly as `team add` and `team restart` leave a seat found at a dialog.
    expect(made.closes).toEqual([]);
    const state = JSON.parse(readFileSync(join(stateDir, 'team.state.json'), 'utf8')) as {
      sessions: { sweep: { seats: Record<string, { pane?: string; waiting?: { state: string; classification: string } }> } };
    };
    expect(state.sessions.sweep.seats.worker?.waiting).toEqual({ state: 'waiting-owner', classification: 'trust' });
    expect(state.sessions.sweep.seats.worker?.pane).toBe('w2:p2');
  });

  test('a run that refuses before it plans a seat reports refused, not a false 0/0/0', async () => {
    recordSeat();
    // A disk too full to launch on: the real run refuses before the host is built, so no report
    // exists and the sweep must not invent a summary for it. (A legacy trust block no longer
    // refuses: the run trusts the lobby and the project root and says so.)
    const made = world();
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made, { machine: () => ({ ...AMPLE, diskFree: 1e6 }) }) });
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('the run should have been refused');
    expect(result.exit).toBe(1);
    // The daemon's log line carries the run's own last line, so it names the refusal rather
    // than only its exit code.
    expect(result.detail).toContain('disk');
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
    expect(made.creates).toEqual([]);
  });

  test('a team file that cannot be read is reported, never launched', async () => {
    const made = world();
    rmSync(teamFile);
    const result = await runRestoreSweepForRoute({ home, root, teamFile, sources: sources(made) });
    expect(result.kind).toBe('unreadable');
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
  });

  test('a closing host stops the pass before any seat is planned into action', async () => {
    recordSeat();
    await approve();
    const made = world();
    const result = await runRestoreSweepForRoute({
      home,
      root,
      teamFile,
      sources: sources(made),
      isClosing: () => true,
    });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
    expect(made.creates).toEqual([]);
    expect(made.closes).toEqual([]);
  });
});

describe('a route whose team lives in the registry', () => {
  test('is read through the registry when no file stands at the conventional path', async () => {
    recordSeat();
    intoRegistry(root, home);
    rmSync(teamFile);
    const made = world();
    made.session = 'absent';
    // The daemon-shaped call no longer names the conventional path: the route resolves its root
    // through the one seam, so the registry's team and its recorded session are found. Naming
    // the absent path would have answered `unreadable` ("no team file at ...").
    const result = await underRegistry(() => runRestoreSweepForRoute({ home, root, sources: sources(made) }));
    expect(result).toEqual({ kind: 'not-running', state: 'absent' });
  });

  test('is read from the registry, not from a stale file left at the conventional path', async () => {
    recordSeat();
    intoRegistry(root, home);
    writeFileSync(
      teamFile,
      teamText().replace('project: sweep', 'project: retired').replace('session: sweep', 'session: retired'),
    );
    const made = world();
    made.session = 'absent';
    // The leftover names session "retired", which records no seat; reading it would stop at
    // `no-recorded-session`. The registry names "sweep", whose recorded seat is judged.
    const result = await underRegistry(() => runRestoreSweepForRoute({ home, root, sources: sources(made) }));
    expect(result).toEqual({ kind: 'not-running', state: 'absent' });
  });

  test('restores its recorded seats when the registry is the only copy of the team', async () => {
    recordSeat();
    intoRegistry(root, home);
    rmSync(teamFile);
    const made = world();
    // The daemon-shaped call names no file. Its pass reads the team from the registry, and the
    // run it hands the plan to must resolve the same way: naming the conventional path would
    // stop `up` on a file that does not exist, with exit 2, and restore nothing.
    const result = await underRegistry(async () => {
      const approved = await runApprove([], testIo(root, { kind: 'owner' }), {
        ask: async () => '5',
        waiting: () => 'empty',
        now: () => NOW,
        home,
      });
      expect(approved).toBe(0);
      return runRestoreSweepForRoute({ home, root, sources: sources(made) });
    });
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') return;
    expect(result.summary.line).toBe('0 seats repaired, 0 skipped (working), 0 refused');
    expect(result.failed).toBe(false);
    expect(made.starts).toBe(0);
    expect(made.closes).toEqual([]);
    expect(made.runs.filter((run) => run.command.includes('team-deepseek'))).toEqual([]);
  });

  test('a root with neither a registry record nor a file is reported with the reason, never launched', async () => {
    recordSeat();
    rmSync(teamFile);
    const made = world();
    const result = await underRegistry(() => runRestoreSweepForRoute({ home, root, sources: sources(made) }));
    expect(result.kind).toBe('unreadable');
    if (result.kind !== 'unreadable') return;
    expect(result.reason).toContain('no team is registered');
    expect(made.starts).toBe(0);
    expect(made.runs).toEqual([]);
    expect(made.creates).toEqual([]);
  });
});

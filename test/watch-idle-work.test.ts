import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { BrokerWorkSnapshot } from '../src/idle_work.ts';
import { idleWorkNotes } from '../src/idle_work.ts';
import type { PauseRecord, SessionState } from '../src/state.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { idleThresholdReading, idleThresholdSeconds, idleWorkReport } from '../src/watch/idle-work.ts';

// The example's team, with the operator named as the lead it is: the workers below are the two
// deepseek seats and the codex seat.
const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8')
  .replace('operator: claude-coordinator-acme', 'operator: claude-operator-acme')
  .replace('seats:\n', `seats:
  - role: operator
    name: claude-operator-acme
    label: claude-operator-acme
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
`);

const WORKER = 'deepseek-acme';
const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const prompt = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const asked = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function live(status = 'idle', screen = prompt): Live {
  return {
    running: true,
    agents: [{ name: WORKER, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null }],
    workspaces: [{ id: 'w1', label: WORKER }],
    screens: { 'w1:p1': screen },
  };
}

function stateWith(lastActive: string | undefined, seat = WORKER): SessionState {
  const state = emptySession();
  state.seats[seat] = { stage: 'ready', last_active: lastActive };
  return state;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'idle-work-'));
  mkdirSync(join(root, '.agents'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function queue(records: { id: string; title: string }[]): void {
  writeFileSync(join(root, '.agents', 'queue.yaml'), records.map((record) => `- id: ${record.id}\n  title: "${record.title}"\n`).join(''));
}

function read(team: TeamFile, state: SessionState, scene: Live | null = live(), now = NOW, extra: { pause?: PauseRecord; seatPauses?: Record<string, PauseRecord>; swaps?: string[]; broker?: BrokerWorkSnapshot } = {}) {
  return idleWorkReport({ root, team, state, live: scene, now: new Date(now), ...extra });
}

/** The example with its task source moved to a tracker: the reading cannot read it itself. */
function linearTeam(extra = ''): TeamFile {
  return teamOf(`${example}tasks:
  source: linear
  linear:
    project: 01234567-89ab-cdef-0123-456789abcdef
    keychainService: team.linear.acme
${extra}`);
}

describe('the idle clock', () => {
  test('the threshold is the idle-threshold policy: 300 seconds when nothing declares it', () => {
    expect(idleThresholdSeconds(teamOf(example), root, undefined, new Date(NOW))).toBe(300);
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(report.threshold_unknown).toBeUndefined();
  });

  test('an unreadable signed chain is an unknown threshold, not the default', () => {
    // A hand-written entry has no signature the chain can verify: the window in force is
    // unknown, so the reading says so and a dispatcher must not act on the default.
    const broken = teamOf(`${example}\npolicies:\n  idle-threshold: 90s\n`);
    const reading = idleThresholdReading(broken, root, undefined, new Date(NOW));
    expect(reading.seconds).toBe(300);
    expect(reading.unknown).toBeDefined();
    const report = read(broken, stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(report.threshold_unknown).toBeDefined();
  });

  test('a worker past the window with work queued is idle with one takeable record', () => {
    queue([{ id: 't1', title: 'First' }]);
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(report.threshold_seconds).toBe(300);
    expect(report.takeable).toBe(1);
    expect(report.idle).toEqual([{ seat: WORKER, since: new Date(NOW - 10 * MIN).toISOString() }]);
    expect(idleWorkNotes(report)).toEqual([
      `idle with work: 1 idle seat past 5 minutes, 1 takeable; ${WORKER} idle since ${new Date(NOW - 10 * MIN).toISOString()}`,
    ]);
  });

  test('a worker inside the window, with no stamp, or holding a dialog is not counted', () => {
    queue([{ id: 't1', title: 'First' }]);
    const inside = read(teamOf(example), stateWith(new Date(NOW - 60_000).toISOString()));
    expect(inside.idle).toEqual([]);
    const unstamped = read(teamOf(example), stateWith(undefined));
    expect(unstamped.idle).toEqual([]);
    expect(unstamped.takeable).toBe(0);
    const dialog = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), live('blocked', asked));
    expect(dialog.idle).toEqual([]);
    const working = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), live('working', busy));
    expect(working.idle).toEqual([]);
  });

  test('an empty queue is zero takeable and says nothing; a paused team claims nothing', () => {
    writeFileSync(join(root, '.agents', 'queue.yaml'), '[]\n');
    const empty = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(empty.takeable).toBe(0);
    expect(idleWorkNotes(empty)).toEqual([]);
    queue([{ id: 't1', title: 'First' }]);
    const paused: PauseRecord = { at: new Date(NOW - MIN).toISOString(), by: 'owner', reason: 'holding', stops: [] };
    expect(read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { pause: paused }).takeable).toBe(0);
  });

  test('a seat holding a queued swap is not an idle worker, and the seat beside it still is', () => {
    queue([{ id: 't1', title: 'First' }]);
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { swaps: [WORKER] });
    expect(report.idle).toEqual([]);
    expect(report.takeable).toBe(0);
  });

  test('a seat paused on its own is not an idle worker, and its own record is enough', () => {
    queue([{ id: 't1', title: 'First' }]);
    const since = new Date(NOW - 10 * MIN).toISOString();
    const healthy = read(teamOf(example), stateWith(since));
    expect(healthy.idle.map((worker) => worker.seat)).toEqual([WORKER]);
    expect(healthy.takeable).toBe(1);
    const seatPause: PauseRecord = { at: new Date(NOW - MIN).toISOString(), by: 'owner', stops: [{ seat: WORKER }] };
    const paused = read(teamOf(example), stateWith(since), live(), NOW, { seatPauses: { [WORKER]: seatPause } });
    expect(paused.idle).toEqual([]);
    expect(paused.takeable).toBe(0);
  });

  test('a record a live lease holds is not counted; an expired one is', () => {
    queue([{ id: 't1', title: 'First' }]);
    const state = stateWith(new Date(NOW - 10 * MIN).toISOString());
    mkdirSync(join(root, '.agents', 'leases'), { recursive: true });
    const lease = (until: string): string => JSON.stringify({
      format: 1, id: 't1', seat: 'codex-acme', pane: 'w2:p1',
      acquiredAt: new Date(NOW - MIN).toISOString(), renewedAt: new Date(NOW - MIN).toISOString(), until,
    });
    writeFileSync(join(root, '.agents', 'leases', 't1.json'), lease(new Date(NOW + MIN).toISOString()));
    expect(read(teamOf(example), state).takeable).toBe(0);
    writeFileSync(join(root, '.agents', 'leases', 't1.json'), lease(new Date(NOW - MIN).toISOString()));
    expect(read(teamOf(example), state).takeable).toBe(1);
  });

  test('a named file source that is missing is a refusal, never an empty queue', () => {
    const team = teamOf(`${example}\ntasks:\n  source: file\n  path: .agents/tasks.yaml\n`);
    const report = read(team, stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(report.takeable).toBeNull();
    expect(report.refused).toBe('.agents/tasks.yaml is missing');
    expect(idleWorkNotes(report)).toEqual([
      'the task source cannot be read, so the idle reading is unknown (.agents/tasks.yaml is missing)',
    ]);
  });

  test('a declared tracker with no broker snapshot is unknown, not zero work', () => {
    const report = read(linearTeam(), stateWith(new Date(NOW - 10 * MIN).toISOString()));
    expect(report.takeable).toBeNull();
    expect(report.refused).toBe('the team declares a linear task source and no broker snapshot is available here');
  });

  test('a supplied broker snapshot is counted by the picker and honours live leases', () => {
    const team = linearTeam();
    const at = new Date(NOW).toISOString();
    const records = [
      { id: 't1', title: 'Unassigned' },
      { id: 't2', title: 'Another seat’s', assignee: 'codex-acme' },
      { id: 't3', title: 'Blocked', blockedBy: ['t1'] },
    ];
    const snapshot: BrokerWorkSnapshot = { kind: 'records', at, records };
    expect(read(team, stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { broker: snapshot }).takeable).toBe(1);
    // The declared pull is the picker's own rule, exactly as `team next` reads it.
    const any = read(linearTeam("  pull: any\n"), stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { broker: snapshot });
    expect(any.takeable).toBe(2);
    // A live local lease removes its record from the count, as it does for a file source.
    mkdirSync(join(root, '.agents', 'leases'), { recursive: true });
    writeFileSync(join(root, '.agents', 'leases', 't1.json'), JSON.stringify({
      format: 1, id: 't1', seat: 'codex-acme', pane: 'w2:p1',
      acquiredAt: new Date(NOW - MIN).toISOString(), renewedAt: new Date(NOW - MIN).toISOString(),
      until: new Date(NOW + MIN).toISOString(),
    }));
    expect(read(team, stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { broker: snapshot }).takeable).toBe(0);
  });

  test('a refused broker snapshot carries the broker’s own sentence', () => {
    const snapshot: BrokerWorkSnapshot = { kind: 'refused', at: new Date(NOW).toISOString(), why: 'the broker is not running' };
    const report = read(linearTeam(), stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { broker: snapshot });
    expect(report.takeable).toBeNull();
    expect(report.refused).toBe('the broker is not running');
    expect(idleWorkNotes(report)).toEqual([
      'the task source cannot be read, so the idle reading is unknown (the broker is not running)',
    ]);
  });

  test('a broker snapshot never overrides a file team’s own source', () => {
    queue([{ id: 't1', title: 'First' }]);
    const snapshot: BrokerWorkSnapshot = {
      kind: 'records',
      at: new Date(NOW).toISOString(),
      records: [{ id: 'x1', title: 'One' }, { id: 'x2', title: 'Two' }],
    };
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), live(), NOW, { broker: snapshot });
    expect(report.takeable).toBe(1);
  });

  test('a no-live reading never calls a seat idle', () => {
    queue([{ id: 't1', title: 'First' }]);
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), null);
    expect(report.idle).toEqual([]);
    expect(report.takeable).toBe(0);
  });
});

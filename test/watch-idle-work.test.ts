import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { idleWorkNotes } from '../src/idle_work.ts';
import type { PauseRecord, SessionState } from '../src/state.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { idleThresholdSeconds, idleWorkReport } from '../src/watch/idle-work.ts';

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

function read(team: TeamFile, state: SessionState, scene: Live | null = live(), now = NOW, extra: { pause?: PauseRecord; swaps?: string[] } = {}) {
  return idleWorkReport({ root, team, state, live: scene, now: new Date(now), ...extra });
}

describe('the idle clock', () => {
  test('the threshold is the idle-threshold policy: 300 seconds by default', () => {
    expect(idleThresholdSeconds(teamOf(example), root, undefined, new Date(NOW))).toBe(300);
    // A chain that cannot be read resolves nothing: the reading takes the documented default
    // rather than throwing or guessing a value, and never writes the expired-policy markers.
    const broken = teamOf(`${example}\npolicies:\n  idle-threshold: 90s\n`);
    expect(idleThresholdSeconds(broken, root, undefined, new Date(NOW))).toBe(300);
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

  test('a no-live reading never calls a seat idle', () => {
    queue([{ id: 't1', title: 'First' }]);
    const report = read(teamOf(example), stateWith(new Date(NOW - 10 * MIN).toISOString()), null);
    expect(report.idle).toEqual([]);
    expect(report.takeable).toBe(0);
  });
});

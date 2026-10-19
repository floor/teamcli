// The idle-with-work and ready-but-uninstalled readings `status` and `check` print. The watch owns
// the snapshot and the green journal owns its pending reader; these scenes stand in for both, so
// they pin the presentation alone: the exact lines, the silences, the refused reads that must
// never read as "nothing to do", and the two JSON fields. Every world is synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { runStatus } from '../src/commands/status.ts';
import type { StatusSources } from '../src/commands/status.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  greenNotes,
  idleWorkNotes,
  readPendingGreen,
  type IdleWorkReport,
  type PendingGreenSlice,
} from '../src/idle_work.ts';
import { updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { greenSlicesPath, pendingGreenSlices, recordGreenSliceReady } from '../src/tasks/green-slices.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const AT = NOW.toISOString();

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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-idle-status-')));
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

function report(over: Partial<IdleWorkReport> = {}): IdleWorkReport {
  return {
    format: 1,
    at: AT,
    threshold_seconds: 300,
    takeable: 3,
    idle: [
      { seat: 'lead', since: '2026-10-19T08:50:00.000Z' },
      { seat: 'helper', since: null },
    ],
    ...over,
  };
}

const GREEN: PendingGreenSlice[] = [
  { task: 'slice-alpha', seat: 'writer-01', commit: '0123456', version: '0.5.4', readyAt: '2026-10-19T08:55:00.000Z' },
];

test('the idle line names the count, the threshold, the work and each seat since', () => {
  expect(idleWorkNotes(report())).toEqual([
    'idle with work: 2 idle seats past 5 minutes, 3 takeable; lead idle since 2026-10-19T08:50:00.000Z, helper idle since the watch started',
  ]);
  expect(idleWorkNotes(report({ threshold_seconds: 45, idle: [{ seat: 'lead', since: '2026-10-19T08:59:15.000Z' }], takeable: 1 }))).toEqual([
    'idle with work: 1 idle seat past 45 seconds, 1 takeable; lead idle since 2026-10-19T08:59:15.000Z',
  ]);
  expect(idleWorkNotes(report({ threshold_seconds: 60, idle: [{ seat: 'lead', since: null }], takeable: 2 }))).toEqual([
    'idle with work: 1 idle seat past 1 minute, 2 takeable; lead idle since the watch started',
  ]);
  expect(idleWorkNotes(report({ threshold_seconds: 7200, idle: [{ seat: 'lead', since: null }], takeable: 1 }))).toEqual([
    'idle with work: 1 idle seat past 2 hours, 1 takeable; lead idle since the watch started',
  ]);
  expect(idleWorkNotes(report({ threshold_seconds: 3600, idle: [{ seat: 'lead', since: null }], takeable: 1 }))).toEqual([
    'idle with work: 1 idle seat past 1 hour, 1 takeable; lead idle since the watch started',
  ]);
});

test('nothing is said when seats are busy or the queue is empty', () => {
  expect(idleWorkNotes(report({ takeable: 0 }))).toEqual([]);
  expect(idleWorkNotes(report({ idle: [] }))).toEqual([]);
});

test('a source that cannot be read is said, never read as no work', () => {
  expect(idleWorkNotes(report({ takeable: null, refused: 'the file is not a list' }))).toEqual([
    'the task source cannot be read, so the idle reading is unknown (the file is not a list)',
  ]);
  expect(idleWorkNotes(report({ takeable: null }))).toEqual([
    'the task source cannot be read, so the idle reading is unknown',
  ]);
});

test('the green lines list pending slices oldest first, and a refused read is explicit', () => {
  expect(greenNotes(null)).toEqual([]);
  expect(greenNotes({ kind: 'slices', slices: [] })).toEqual([]);
  expect(greenNotes({ kind: 'slices', slices: [GREEN[0]!] })).toEqual([
    'green slice ready and not installed: slice-alpha since 2026-10-19T08:55:00.000Z',
  ]);
  const second = { ...GREEN[0]!, task: 'slice-beta', readyAt: '2026-10-19T08:58:00.000Z' };
  expect(greenNotes({ kind: 'slices', slices: [GREEN[0]!, second] })).toEqual([
    'green slices ready and not installed: slice-alpha since 2026-10-19T08:55:00.000Z, slice-beta since 2026-10-19T08:58:00.000Z',
  ]);
  expect(greenNotes({ kind: 'refused', why: 'the journal is not JSON' })).toEqual([
    'the green journal cannot be read, so ready slices are unknown (the journal is not JSON)',
  ]);
});

test('the pending reader turns a malformed journal into a refusal, not an empty list', () => {
  expect(readPendingGreen(() => GREEN, 'd')).toEqual({ kind: 'slices', slices: GREEN });
  expect(readPendingGreen(() => { throw new Error('repair the journal'); }, 'd')).toEqual({
    kind: 'refused',
    why: 'repair the journal',
  });
});

test('status prints both readings and carries them in its document', async () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const sources: StatusSources = {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    idleWork: () => report(),
    pendingGreen: () => GREEN,
  };
  await runStatus(['--json'], io, sources);
  const doc = JSON.parse(io.out) as {
    notes: string[];
    idle_work: IdleWorkReport;
    green_slices: PendingGreenSlice[];
  };
  expect(doc.notes).toContain('idle with work: 2 idle seats past 5 minutes, 3 takeable; lead idle since 2026-10-19T08:50:00.000Z, helper idle since the watch started');
  expect(doc.notes).toContain('green slice ready and not installed: slice-alpha since 2026-10-19T08:55:00.000Z');
  expect(doc.idle_work.takeable).toBe(3);
  expect(doc.green_slices).toEqual(GREEN);
});

test('check prints both readings, names a corrupt journal, and keeps its exit', () => {
  const at = place();
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    idleWork: () => report({ idle: [{ seat: 'lead', since: '2026-10-19T08:50:00.000Z' }], takeable: 1 }),
    pendingGreen: () => {
      throw new Error('the journal is not JSON');
    },
  });
  expect(io.out).toContain('idle with work: 1 idle seat past 5 minutes, 1 takeable; lead idle since 2026-10-19T08:50:00.000Z');
  expect(io.out).toContain('the green journal cannot be read, so ready slices are unknown (the journal is not JSON)');
  expect(code).toBe(0);
});

const realCheck = (at: { dir: string; home: string }): CheckSources => ({
  live: () => live(),
  branch: () => 'main',
  standing: (root) => approvalStanding(root, at.home),
  now: () => NOW,
  home: at.home,
  pendingGreen: pendingGreenSlices,
});

test('status and check read a real journal through its own pending reader', async () => {
  const at = place();
  const recorded = recordGreenSliceReady(at.dir, {
    task: 'slice-alpha', seat: 'writer-01', commit: '0123456', version: '0.5.4', at: NOW,
  });
  if (!recorded.ok) throw new Error(recorded.why);
  const io = testIo(at.root, { kind: 'owner' });
  await runStatus(['--json'], io, {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    pendingGreen: pendingGreenSlices,
  });
  const doc = JSON.parse(io.out) as { notes: string[]; green_slices: PendingGreenSlice[] };
  expect(doc.notes).toContain(`green slice ready and not installed: slice-alpha since ${AT}`);
  expect(doc.green_slices).toEqual([
    { task: 'slice-alpha', seat: 'writer-01', commit: '0123456', version: '0.5.4', readyAt: AT },
  ]);
  const checked = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, checked, realCheck(at));
  expect(checked.out).toContain(`green slice ready and not installed: slice-alpha since ${AT}`);
  expect(code).toBe(0);
  const asJson = testIo(at.root, { kind: 'owner' });
  const jsonCode = runTeamCheck({ file: '.agents/team.yaml', json: true }, asJson, {
    ...realCheck(at),
    idleWork: () => report(),
  });
  const doc2 = JSON.parse(asJson.out) as {
    notes: string[];
    idle_work: IdleWorkReport;
    green_slices: PendingGreenSlice[];
  };
  expect(doc2.idle_work.takeable).toBe(3);
  expect(doc2.green_slices).toEqual([
    { task: 'slice-alpha', seat: 'writer-01', commit: '0123456', version: '0.5.4', readyAt: AT },
  ]);
  expect(doc2.notes).toContain(`green slice ready and not installed: slice-alpha since ${AT}`);
  expect(jsonCode).toBe(0);
});

test('a corrupt journal is named with its path, and changes no exit', async () => {
  const at = place();
  writeFileSync(greenSlicesPath(at.dir), '{ not json');
  const why = `${greenSlicesPath(at.dir)} is not valid JSON; move it aside and run the command again`;
  const checked = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, checked, realCheck(at));
  expect(checked.out).toContain(`the green journal cannot be read, so ready slices are unknown (${why})`);
  expect(code).toBe(0);
  const asJson = testIo(at.root, { kind: 'owner' });
  const jsonCode = runTeamCheck({ file: '.agents/team.yaml', json: true }, asJson, realCheck(at));
  const checkedDoc = JSON.parse(asJson.out) as { notes: string[]; green_slices?: unknown; green_notice?: string };
  expect(checkedDoc.green_slices).toBeUndefined();
  expect(checkedDoc.green_notice).toBe(why);
  expect(checkedDoc.notes).toContain(`the green journal cannot be read, so ready slices are unknown (${why})`);
  expect(jsonCode).toBe(0);
  const io = testIo(at.root, { kind: 'owner' });
  await runStatus(['--json'], io, {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    pendingGreen: pendingGreenSlices,
  });
  const doc = JSON.parse(io.out) as { notes: string[]; green_slices?: unknown; green_notice?: string };
  expect(doc.green_slices).toBeUndefined();
  expect(doc.green_notice).toBe(why);
  expect(doc.notes).toContain(`the green journal cannot be read, so ready slices are unknown (${why})`);
});

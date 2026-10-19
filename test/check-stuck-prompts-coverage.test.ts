// Independent coverage of `team check`'s stuck-prompt pass, from the guarantee's side rather
// than the builder's examples: the three ways a pane can stop being the seat it was recorded as
// (herdr no longer naming it, a process the record does not name, a pane back at its shell), the
// safety floor's live region (no rule line at all; several rule lines), control sequences and a
// carriage return on the rows the check quotes — in text and in `--json` — two held seats on one
// pass, the same line for a seat caller, the age the state's own clock gives, and a run that
// writes nothing. A final scene drives the production live read for a temporary seat in its own
// process (`test/check-stuck-live-coverage-run.ts`), which is where the pane collection lives.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { STATE_FILE, emptySession, updateState, type SeatState } from '../src/state.ts';
import type { Standing } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { testIo } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');
const AT = '2026-10-03T14:06:00Z'; // four minutes before NOW

const PERMISSION = readFileSync(new URL('./fixtures/claude-code/2.1.302/permission.txt', import.meta.url), 'utf8');
const CODEX_PERMISSION = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
const RATE_LIMIT = readFileSync(new URL('./fixtures/claude-code/rate-limit.txt', import.meta.url), 'utf8');
const FLOOR_ONLY = 'A new dialog the profile never saw\nDo you want to continue?';

function agent(name: string | null, workspace: string, status = 'working', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

function built(): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'w1'),
      agent('codex-acme', 'w2', 'idle', 'codex'),
      agent('deepseek-acme', 'w3', 'working'),
      agent('deepseek-acme-2', 'w4', 'idle'),
    ],
    workspaces: [],
    screens: {},
  };
}

let dir: string;
let standing: Standing;
let live: Live;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-check-prompts-coverage-'));
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), example);
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recordSeat(
  name: string,
  pane: string,
  workspace: string,
  cli: string,
  lastActive = AT,
  extra: Partial<SeatState> = {},
): void {
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane, workspace, cli, last_active: lastActive, ...extra };
  });
}

function recordTemporary(name: string, pane: string, extra: Partial<SeatState> = {}): void {
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats[name] = {
      stage: 'ready',
      pane,
      workspace: 'w6',
      last_active: AT,
      temporary: { like: 'deepseek-acme', until: 'merged:fix/select-width' },
      ...extra,
    };
  });
}

function run(args: { json?: boolean } = {}, caller?: { kind: 'owner' } | { kind: 'seat'; name: string; pane: string; session: string }) {
  const io = testIo(dir, caller ?? { kind: 'owner' });
  const code = runTeamCheck(args.json ? { file: '.agents/team.yaml', json: true } : { file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home: dir,
  });
  return { code, out: io.out, err: io.err };
}

// The three ways the pane stops being the seat: herdr no longer lists it, it runs a process the
// record does not name, and it is back at its shell. Each screen still shows the permission
// dialog the CLI drew before it ended; none may become a prompt line.

test('a seat herdr no longer lists keeps its process row, and the dialog in the pane is not quoted', () => {
  live = {
    ...built(),
    agents: built().agents.filter((candidate) => candidate.name !== 'deepseek-acme'),
    screens: { 'w3:p1': PERMISSION },
    processes: { 'w3:p1': { shell: 10, foreground: [10] } },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', AT, { launched: { shell: 10, cli: [11] } });
  const { out } = run();
  expect(out).toContain('deepseek-acme: its pane runs no CLI (the CLI ended or the session was restored)');
  expect(out).not.toContain('stuck at a permission prompt');
  expect(out).not.toContain('Write(synthetic-note.txt)');
});

test('a pane running a process the record does not name keeps its process row, and its dialog is not read', () => {
  live = {
    ...built(),
    screens: { 'w3:p1': PERMISSION },
    processes: { 'w3:p1': { shell: 20, foreground: [30] } },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', AT, { launched: { shell: 10, cli: [11] } });
  const { out } = run();
  expect(out).toContain('deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched');
  expect(out).not.toContain('stuck at a permission prompt');
  expect(out).not.toContain('Write(synthetic-note.txt)');
});

test('a temporary seat whose pane is back at its shell makes no stuck line of the check\'s own', () => {
  live = {
    ...built(),
    agents: [...built().agents, agent('claude-acme-tmp-1', 'w6')],
    screens: { 'w6:p1': PERMISSION },
    processes: { 'w6:p1': { shell: 10, foreground: [10] } },
  };
  // No recorded identity: the bare-shell branch, not the pid verdict, is what excludes this one.
  recordTemporary('claude-acme-tmp-1', 'w6:p1');
  const { out } = run();
  expect(out).not.toContain('stuck at a permission prompt');
  expect(out).not.toContain('Write(synthetic-note.txt)');
});

// The safety floor's live region. A window with no rule line is a dialog that fills the pane and
// is live whole; with several rule lines only the rows below the last are.

test('a window with no rule line is a dialog that fills the pane, and its floor row is quoted', () => {
  live = { ...built(), screens: { 'w3:p1': FLOOR_ONLY } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out } = run();
  expect(out).toContain('deepseek-acme: stuck at an unrecognised prompt (last active 4m ago): matched "Do you want to continue?"');
});

test('with several rule lines only the rows below the last one are the live dialog', () => {
  live = {
    ...built(),
    screens: { 'w3:p1': 'Do you want to continue?\n────────\nolder turn\n────────\nstill typing something' },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out } = run();
  // The floor phrase sits above the last rule: transcript, never the dialog, never quoted.
  expect(out).not.toContain('stuck at an unrecognised prompt');
  expect(out).not.toContain('Do you want to continue?');
});

// Every detail the line quotes is text the screen showed, and both renderers get the cleaned one.

test('an OSC and a carriage return on the quoted floor row reach neither the text nor the JSON', () => {
  live = { ...built(), screens: { 'w3:p1': 'A new dialog the profile never saw\nDo you want to \x1b]0;title\x07continue?\r' } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const text = run();
  expect(text.out).toContain('matched "Do you want to continue?"');
  for (const control of ['\x1b', '\x07', '\r']) expect(text.out).not.toContain(control);

  const json = run({ json: true });
  expect(json.code).toBe(1);
  for (const control of ['\x1b', '\x07', '\r']) expect(json.out).not.toContain(control);
  const doc = JSON.parse(json.out) as { differences: Array<Record<string, unknown>> };
  const row = doc.differences.find((candidate) => String(candidate.what).includes('stuck at an unrecognised prompt'));
  expect(row?.what).toBe('deepseek-acme: stuck at an unrecognised prompt (last active 4m ago): matched "Do you want to continue?"');
  expect(JSON.stringify(row)).not.toMatch(/[\u0000-\u001f]/);
});

test('a style sequence around the reset time is removed from the quota line in text and in JSON', () => {
  live = { ...built(), screens: { 'w3:p1': RATE_LIMIT.replace('reset at 11:00', 'reset at \x1b[1m11:00\x1b[0m') } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const text = run();
  expect(text.out).toContain('deepseek-acme: stuck at a quota prompt (last active 4m ago): resets at 11:00\n');
  expect(text.out).not.toContain('\x1b');

  const json = run({ json: true });
  const doc = JSON.parse(json.out) as { differences: Array<Record<string, unknown>> };
  const row = doc.differences.find((candidate) => String(candidate.what).includes('stuck at a quota prompt'));
  expect(row?.what).toBe('deepseek-acme: stuck at a quota prompt (last active 4m ago): resets at 11:00');
});

// Two held seats on one pass: each line names its own seat once, and neither keeps the watch's
// plainer row beside it.

test('two seats held on one pass are each named once, and no plain prompt row stands beside either', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION, 'w2:p1': CODEX_PERMISSION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  recordSeat('codex-acme', 'w2:p1', 'w2', 'codex');
  const { out } = run();
  expect(out).toContain('deepseek-acme: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
  expect(out).toContain('codex-acme: stuck at a permission prompt (last active 4m ago)\n');
  expect(out.split('stuck at a permission prompt').length - 1).toBe(2);
  expect(out).not.toContain('waits at a permission prompt');
});

// Who reads it: a seat of the team sees the same line, and the run writes nothing.

test('a seat caller reads the same line, and the reading leaves the state file untouched', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION } };
  recordSeat('claude-coordinator-acme', 'w1:p1', 'w1', 'claude-code');
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const path = join(dir, '.agents', STATE_FILE);
  const before = readFileSync(path, 'utf8');
  const io = testIo(dir, { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' });
  const code = runTeamCheck({}, io, {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home: dir,
  });
  expect(code).toBe(1);
  expect(io.out).toContain('deepseek-acme: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
  expect(io.err).toBe('');
  expect(readFileSync(path, 'utf8')).toBe(before);
});

// The age is the record's own instant, read through the check's clock.

test('a last_active the clock cannot read gives no age clause; a day-old one gives days', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', 'not-a-date');
  expect(run().out).toContain('deepseek-acme: stuck at a permission prompt: Write(synthetic-note.txt)');

  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', '2026-10-02T14:10:00Z');
  expect(run().out).toContain('deepseek-acme: stuck at a permission prompt (last active 1d ago): Write(synthetic-note.txt)');
});

// A temporary seat held on an unrecognised screen: named, and the reading still writes nothing.

test('a temporary seat at an unrecognised prompt is named, and the run writes no drop and no state', () => {
  live = { ...built(), agents: [...built().agents, agent('claude-acme-tmp-1', 'w6')], screens: { 'w6:p1': FLOOR_ONLY } };
  recordTemporary('claude-acme-tmp-1', 'w6:p1');
  const path = join(dir, '.agents', STATE_FILE);
  const before = readFileSync(path, 'utf8');
  const { out } = run({ json: true });
  const doc = JSON.parse(out) as { differences: Array<Record<string, unknown>> };
  const row = doc.differences.find((candidate) => String(candidate.what).includes('claude-acme-tmp-1'));
  expect(row?.what).toBe('claude-acme-tmp-1: stuck at an unrecognised prompt (last active 4m ago): matched "Do you want to continue?"');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(existsSync(join(dir, '.agents', 'send-drops'))).toBe(false);
});

// The production live read end to end, in its own process: `realCheckSources` collects a
// temporary seat's recorded pane, and the check's gate decides whether its screen is read as a
// prompt — the two paths that only exist outside a scene that hands the check its screens.

test('the real live read reads a temporary seat\'s pane, and only while the recorded process is in it', async () => {
  const proc = Bun.spawn(['bun', 'test/check-stuck-live-coverage-run.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as {
    stale: { code: number; out: string; reads: string[] };
    shell: { out: string; reads: string[] };
    held: { out: string; reads: string[] };
  };
  // Herdr names the seat on another pane: the state's pane is not read, and nothing is named.
  expect(parsed.stale.reads).toEqual([]);
  expect(parsed.stale.out).not.toContain('stuck at');
  // The pane is read as the temporary seat's own, and the shell in it keeps the dialog out.
  expect(parsed.shell.reads).toContain('w6:p1');
  expect(parsed.shell.out).not.toContain('stuck at a permission prompt');
  expect(parsed.shell.out).not.toContain('Write(synthetic-note.txt)');
  // The recorded CLI pids are in front: read, and named.
  expect(parsed.held.reads).toContain('w6:p1');
  expect(parsed.held.out).toContain('claude-acme-tmp-1: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
});

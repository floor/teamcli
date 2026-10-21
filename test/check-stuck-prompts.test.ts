// `team check` names each seat held at a prompt it can read: the seat, the prompt's kind
// (permission, trust, quota, confirm, or an unrecognised screen the safety floor caught, quoting
// the floor's matched line), the command the screen shows when the profile's trace reader finds
// one, and the age the state's own clock gives the seat. The reading is the watch's own
// (`readScreen` + the floor), it is read-only, and `compare()`'s plain prompt row for the seat is
// replaced, never doubled.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const TRUST = readFileSync(new URL('./fixtures/claude-code/2.1.289/trust-plain.txt', import.meta.url), 'utf8');
const RATE_LIMIT = readFileSync(new URL('./fixtures/claude-code/rate-limit.txt', import.meta.url), 'utf8');
const EXIT_QUESTION = readFileSync(new URL('./fixtures/exit-typing/claude-code-exit-question-below-quote.txt', import.meta.url), 'utf8');
const CODEX_PERMISSION = readFileSync(new URL('./fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
const FLOOR_ONLY = 'A new dialog the profile never saw\nDo you want to continue?';

function agent(name: string | null, workspace: string, status = 'working', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// Every declared running seat has an agent, as it would on a live session; each test sets the
// one screen it is about.
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
let file: string;
let live: Live;
let standing: Standing;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-check-prompts-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});

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
    session.seats[name] = {
      stage: 'ready',
      pane,
      workspace,
      cli,
      ...(lastActive === '' ? {} : { last_active: lastActive }),
      ...extra,
    };
  });
}

// The scene's own scratch directory is test-created and owned here.
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function check() {
  const io = testIo(dir, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home: dir,
  });
  return { code, out: io.out, err: io.err };
}

test('a permission prompt names the seat, its kind, the command on screen and the age', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).toContain('difference: deepseek-acme: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)\n');
  expect(out).toContain('  repair: its lead answers it in the pane\n');
  // One line, never `compare()`'s plain row beside it.
  expect(out.split('stuck at a permission prompt').length - 1).toBe(1);
  expect(out).not.toContain('waits at a permission prompt');
  expect(code).toBe(1);
});

test('a trust prompt is the owner\'s, and is named once', () => {
  live = { ...built(), screens: { 'w3:p1': TRUST } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).toContain('difference: deepseek-acme: stuck at a trust prompt (last active 4m ago)\n');
  expect(out).toContain('  repair: the owner answers it in the pane\n');
  expect(out).toContain('  who: the owner\n');
  expect(out).not.toContain('waits at a trust prompt');
  expect(out).toContain('1 for the owner');
  expect(code).toBe(1);
});

test('a quota screen is named with the reset time it shows', () => {
  live = { ...built(), screens: { 'w3:p1': RATE_LIMIT } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).toContain('difference: deepseek-acme: stuck at a quota prompt (last active 4m ago): resets at 11:00\n');
  expect(out).toContain('  repair: the owner waits for the reset; team never types into that screen\n');
  expect(code).toBe(1);
});

// The exhausted Codex screen: a synthetic frame built from the wording Codex's own upstream source
// prints at the tested tags (no capture exists), drawn where the CLI draws it — the block directly
// above the composer. The row is inserted there in the retained idle capture's own frame.
const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8');
const codexScreen = (row: string): string => {
  const lines = CODEX_IDLE.split('\n');
  const at = lines.findIndex((line) => line.startsWith('›'));
  return [...lines.slice(0, at), row, ...lines.slice(at)].join('\n');
};

test('a quota screen is named with the clock it shows, as the screen words it', () => {
  live = {
    ...built(),
    screens: {
      'w2:p1': codexScreen('You’ve hit your usage limit for 5h. Switch to another model now, or try again at 3:05 PM.'),
    },
  };
  recordSeat('codex-acme', 'w2:p1', 'w2', 'codex');
  const { out, code } = check();
  expect(out).toContain('difference: codex-acme: stuck at a quota prompt (last active 4m ago): resets at 3:05 PM\n');
  expect(out).toContain('  repair: the owner waits for the reset; team never types into that screen\n');
  expect(code).toBe(1);
});

test('a quota screen that names no reset says so, rather than leaving the time to guess', () => {
  live = {
    ...built(),
    screens: { 'w2:p1': codexScreen('Quota exceeded. Check your plan and billing details.') },
  };
  recordSeat('codex-acme', 'w2:p1', 'w2', 'codex');
  const { out, code } = check();
  expect(out).toContain('difference: codex-acme: stuck at a quota prompt (last active 4m ago): the screen names no reset time\n');
  expect(code).toBe(1);
});

test('the CLI\'s own exit question is a confirm prompt, repaired by the owner or an abandon', () => {
  live = { ...built(), screens: { 'w3:p1': EXIT_QUESTION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).toContain('difference: deepseek-acme: stuck at a confirm prompt (last active 4m ago)\n');
  expect(out).toContain('  repair: the owner answers it in the pane, or team down --abandon closes it\n');
  expect(code).toBe(1);
});

test('an unknown screen the floor caught quotes the matched line, and no blocked line is added', () => {
  live = { ...built(), screens: { 'w3:p1': FLOOR_ONLY } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).toContain('difference: deepseek-acme: stuck at an unrecognised prompt (last active 4m ago): matched "Do you want to continue?"\n');
  expect(out).toContain('  repair: the owner looks at the pane\n');
  expect(out).not.toContain('its screen is not one the watch recognises');
  expect(code).toBe(1);
});

test('a record with no last_active names no age, and a screen with no tool row names no command', () => {
  live = { ...built(), screens: { 'w2:p1': CODEX_PERMISSION } };
  recordSeat('codex-acme', 'w2:p1', 'w2', 'codex', '');
  const { out } = check();
  expect(out).toContain('difference: codex-acme: stuck at a permission prompt\n  repair: its lead answers it in the pane\n');
  expect(out).not.toContain('(last active');
});

test('a temporary seat reads its like-seat\'s CLI and is named too', () => {
  live = { ...built(), agents: [...built().agents, agent('claude-acme-tmp-1', 'w6')], screens: { 'w6:p1': PERMISSION } };
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['claude-acme-tmp-1'] = {
      stage: 'ready',
      pane: 'w6:p1',
      workspace: 'w6',
      last_active: AT,
      temporary: { like: 'deepseek-acme', until: 'merged:fix/select-width' },
    };
  });
  const { out, code } = check();
  expect(out).toContain('difference: claude-acme-tmp-1: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)\n');
  expect(out.split('stuck at a permission prompt').length - 1).toBe(1);
  expect(out).not.toContain('waits at a permission prompt');
  expect(code).toBe(1);
});

test('a launch\'s waiting record names the seat once, not beside a stuck line', () => {
  live = { ...built(), screens: { 'w3:p1': TRUST } };
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['deepseek-acme'] = {
      stage: 'launched',
      pane: 'w3:p1',
      workspace: 'w3',
      cli: 'claude-code',
      waiting: { state: 'waiting-owner', classification: 'trust' },
    };
  });
  const { out } = check();
  expect(out).toContain('waiting for owner (trust)');
  expect(out).not.toContain('stuck at a trust prompt');
});

test('the JSON document carries the line and nothing of the suppression mark', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const io = testIo(dir, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', json: true }, io, {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home: dir,
  });
  expect(code).toBe(1);
  const doc = JSON.parse(io.out) as { differences: Array<Record<string, unknown>> };
  const rows = doc.differences.filter((row) => String(row.what).includes('stuck at a permission prompt'));
  expect(rows).toHaveLength(1);
  expect(Object.keys(rows[0]!).sort()).toEqual(['repair', 'what', 'who']);
  expect(rows[0]!.what).toBe('deepseek-acme: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
});

test('a pane back at its shell keeps the process row, and its old dialog is not a prompt', () => {
  live = {
    ...built(),
    screens: { 'w3:p1': PERMISSION },
    processes: { 'w3:p1': { shell: 10, foreground: [10] } },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', AT, { launched: { shell: 10, cli: [11] } });
  const { out } = check();
  expect(out).toContain('deepseek-acme: its pane runs no CLI (the CLI ended or the session was restored)');
  expect(out).not.toContain('stuck at a permission prompt');
});

test('a record with no identity whose pane holds a shell reads no prompt either', () => {
  live = {
    ...built(),
    screens: { 'w3:p1': PERMISSION },
    processes: { 'w3:p1': { shell: 10, foreground: [10] } },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out, code } = check();
  expect(out).not.toContain('stuck at a permission prompt');
  expect(code).toBe(1);
});

test('a temporary seat whose pane holds a shell keeps no prompt row from its scrollback', () => {
  live = {
    ...built(),
    agents: [...built().agents, agent('claude-acme-tmp-1', 'w6')],
    screens: { 'w6:p1': PERMISSION },
    processes: { 'w6:p1': { shell: 10, foreground: [10] } },
  };
  updateState(join(dir, '.agents'), (state) => {
    const session = (state.sessions['acme-web'] ??= emptySession());
    session.seats['claude-acme-tmp-1'] = {
      stage: 'ready',
      pane: 'w6:p1',
      workspace: 'w6',
      last_active: AT,
      temporary: { like: 'deepseek-acme', until: 'merged:fix/select-width' },
    };
  });
  const { out } = check();
  // Neither the check's line nor `compare()`'s plain temporary row: the pane is a shell.
  expect(out).not.toContain('stuck at a permission prompt');
  expect(out).not.toContain('waits at a permission prompt');
});

test('a replaced pane whose stored session is the live one is still read for its prompt', () => {
  live = {
    ...built(),
    agents: built().agents.map((candidate) => (candidate.name === 'deepseek-acme' ? { ...candidate, session: 'sess-1' } : candidate)),
    screens: { 'w3:p1': PERMISSION },
    processes: { 'w3:p1': { shell: 20, foreground: [30] } },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code', AT, {
    launched: { shell: 10, cli: [11] },
    agent_session: 'sess-1',
  });
  const { out } = check();
  expect(out).toContain('stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
});

test('a floor row above the composer rule is transcript, not the live dialog', () => {
  // The same words, above the rule line: a turn the pane has scrolled past.
  live = {
    ...built(),
    agents: built().agents.map((candidate) => (candidate.name === 'deepseek-acme' ? { ...candidate, status: 'blocked' } : candidate)),
    screens: { 'w3:p1': 'Do you want to continue?\n────────\nA new dialog the profile never saw' },
  };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out } = check();
  expect(out).not.toContain('stuck at an unrecognised prompt');
  expect(out).toContain('deepseek-acme is blocked, and its screen is not one the watch recognises');
});

test('a floor row below the composer rule is the live dialog and is quoted', () => {
  live = { ...built(), screens: { 'w3:p1': 'A new dialog the profile never saw\n────────\nDo you want to continue?' } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const { out } = check();
  expect(out).toContain('stuck at an unrecognised prompt (last active 4m ago): matched "Do you want to continue?"');
});

test('control sequences on the screen never reach the JSON document', () => {
  // A tool row and a floor row as a pane may carry them, styling and control bytes included.
  const polluted = `${PERMISSION.replace('⏺ Write(synthetic-note.txt)', '⏺ Write(synthetic-note.txt)\x1b]0;title\x07\r')}`;
  live = { ...built(), screens: { 'w3:p1': polluted } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const io = testIo(dir, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', json: true }, io, {
    live: () => live,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home: dir,
  });
  expect(code).toBe(1);
  expect(io.out).not.toContain('\x07');
  expect(io.out).not.toContain('\r');
  expect(io.out).not.toContain('\x1b');
  const doc = JSON.parse(io.out) as { differences: Array<Record<string, unknown>> };
  const row = doc.differences.find((candidate) => String(candidate.what).includes('stuck at a permission prompt'));
  expect(row?.what).toBe('deepseek-acme: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
});

test('a real live read reaches a temporary seat\'s pane and names it', async () => {
  const proc = Bun.spawn(['bun', 'test/check-live-temp-seat-run.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const parsed = JSON.parse(out) as { code: number; out: string };
  expect(parsed.code).toBe(1);
  expect(parsed.out).toContain('claude-acme-tmp-1: stuck at a permission prompt (last active 4m ago): Write(synthetic-note.txt)');
  expect(parsed.out).not.toContain('waits at a permission prompt');
});

test('the reading writes nothing: the state file is byte-identical after the check', () => {
  live = { ...built(), screens: { 'w3:p1': PERMISSION } };
  recordSeat('deepseek-acme', 'w3:p1', 'w3', 'claude-code');
  const path = join(dir, '.agents', STATE_FILE);
  const before = readFileSync(path, 'utf8');
  check();
  expect(readFileSync(path, 'utf8')).toBe(before);
});

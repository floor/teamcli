// The trace sources behind a seat's own state (src/labels/traces.ts): the worktree's last
// commit, the send history's last ack or message for the seat, and the last tool row its pane
// shows — the commit and the history entries carrying their own timestamps, the tool row none
// (a screen carries no clock), each null rather than guessed when its source cannot
// say. The commit scenes run against a real repository (a fixed author date proves the trace
// carries the commit's own date, not the read's moment); the history scenes write real
// messages.jsonl entries through the send history's own writer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTrace, messageTrace, newestTraceAt, seatTraces, seatWorktree, toolTrace, type SeatTrace } from '../src/labels/traces.ts';
import { appendHistory, historyPath } from '../src/send/history.ts';
import { emptySession } from '../src/state.ts';
import type { SessionState } from '../src/state.ts';
import { gitEnv } from './helpers.ts';

const claudeAnsi = readFileSync(new URL('./fixtures/claude-code/2.1.289/permission-create-wide-ansi.txt', import.meta.url), 'utf8');
const claudeWide = readFileSync(new URL('./fixtures/claude-code/2.1.289/permission-read-wide-plain.txt', import.meta.url), 'utf8');
const claudeProse = readFileSync(new URL('./fixtures/claude-code/2.1.299/working.txt', import.meta.url), 'utf8');
const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');
const agyPermission = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission.txt', import.meta.url), 'utf8');
const agyCommand54 = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission-command-54.txt', import.meta.url), 'utf8');
const agyEdit54 = readFileSync(new URL('./fixtures/antigravity/1.2.16/permission-edit-54.txt', import.meta.url), 'utf8');
const agyQuestion135 = readFileSync(new URL('./fixtures/antigravity/1.3.5/question.txt', import.meta.url), 'utf8');

function git(cwd: string, when: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...gitEnv(), GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

let base: string;
let root: string;
let home: string;
let worktree: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-traces-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  worktree = join(base, 'worktrees', 'task-1');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

// A session holding one worktree for builder-2, the way `team worktree --seat` records it.
function sessionWith(records: Record<string, { path: string; seat?: string }>, task?: string): SessionState {
  const session = emptySession();
  for (const [name, record] of Object.entries(records)) {
    session.worktrees[name] = { path: record.path, branch: `feat/${name}`, setup: 'ok', ...(record.seat ? { seat: record.seat } : {}) };
  }
  if (task !== undefined) {
    session.seats['builder-2'] = { stage: 'ready', temporary: { like: 'builder-2', until: 'release:', task } };
  }
  return session;
}

function message(from: string, to: string, outcome: string, ts: string) {
  appendHistory('acme-web', root, home, { ts, from, to, body: 'the body', id: `msg_${ts}`, outcome });
}

describe('the seat traces', () => {
  test("a worktree's last commit is its subject, its short hash, and the commit's own date", () => {
    mkdirSync(worktree, { recursive: true });
    git(worktree, '2026-10-16T09:00:00+02:00', 'init', '-q');
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    git(worktree, '2026-10-16T09:00:00+02:00', 'add', 'a.txt');
    git(worktree, '2026-10-16T09:00:00+02:00', 'commit', '-q', '-m', 'first');
    writeFileSync(join(worktree, 'b.txt'), 'b\n');
    git(worktree, '2026-10-16T11:30:00+02:00', 'add', 'b.txt');
    git(worktree, '2026-10-16T11:30:00+02:00', 'commit', '-q', '-m', 'second');
    const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktree, encoding: 'utf8', env: gitEnv() }).trim();
    expect(commitTrace(worktree)).toEqual({ kind: 'commit', at: '2026-10-16T11:30:00+02:00', what: 'second', ref: short });
  });

  test('a worktree with no commits yet, or no repository at all, has no trace', () => {
    mkdirSync(worktree, { recursive: true });
    git(worktree, '2026-10-16T09:00:00+02:00', 'init', '-q');
    expect(commitTrace(worktree)).toBeNull();
    expect(commitTrace(root)).toBeNull();
  });

  test('the seat\'s worktree is its task\'s record, else the last one naming the seat', () => {
    const session = sessionWith(
      { 'team-list': { path: '../worktrees/team-list', seat: 'builder-1' }, 'task-a': { path: '../worktrees/task-a', seat: 'builder-2' }, 'task-b': { path: '../worktrees/task-b', seat: 'builder-2' } },
    );
    // No temporary task: the last record naming the seat stands, resolved against the root.
    expect(seatWorktree(session, 'builder-2', root)).toBe(join(base, 'worktrees', 'task-b'));
    expect(seatWorktree(session, 'builder-1', root)).toBe(join(base, 'worktrees', 'team-list'));
    expect(seatWorktree(session, 'tester-1', root)).toBeNull();
    // The task its seat record names wins over the scan.
    const tasked = sessionWith({ 'task-a': { path: '../worktrees/task-a', seat: 'builder-2' }, 'task-b': { path: '../worktrees/task-b', seat: 'builder-2' } }, 'task-a');
    expect(seatWorktree(tasked, 'builder-2', root)).toBe(join(base, 'worktrees', 'task-a'));
  });

  test('the send history answers with the seat\'s last message, and an answered one is its ack', () => {
    message('orchestrator', 'builder-2', 'delivered', '2026-10-17T08:00:00Z');
    expect(messageTrace('acme-web', root, 'builder-2', home)).toEqual({
      kind: 'message',
      at: '2026-10-17T08:00:00Z',
      what: 'a message from orchestrator (delivered)',
    });
    message('builder-2', 'builder-1', 'delivered', '2026-10-17T08:30:00Z');
    expect(messageTrace('acme-web', root, 'builder-2', home)).toEqual({
      kind: 'message',
      at: '2026-10-17T08:30:00Z',
      what: 'a message to builder-1 (delivered)',
    });
    message('orchestrator', 'builder-2', 'answered', '2026-10-17T09:00:00Z');
    expect(messageTrace('acme-web', root, 'builder-2', home)).toEqual({
      kind: 'ack',
      at: '2026-10-17T09:00:00Z',
      what: 'answered a message from orchestrator',
    });
    // The history's own outcome word stands even when the message never arrived.
    message('orchestrator', 'builder-2', 'unreachable', '2026-10-17T09:15:00Z');
    expect(messageTrace('acme-web', root, 'builder-2', home)).toEqual({
      kind: 'message',
      at: '2026-10-17T09:15:00Z',
      what: 'a message from orchestrator (unreachable)',
    });
  });

  test('a seat the history never names, or a history that cannot be read, has no trace', () => {
    message('orchestrator', 'builder-1', 'delivered', '2026-10-17T08:00:00Z');
    expect(messageTrace('acme-web', root, 'builder-2', home)).toBeNull();
    expect(messageTrace('other-project', root, 'builder-1', home)).toBeNull();
    // The log exists and holds builder-1's message, but a symbolic link stands in its place:
    // the read refuses it rather than following it, so the message is not a trace either.
    const log = historyPath('acme-web', root, home);
    writeFileSync(join(base, 'elsewhere.jsonl'), '');
    rmSync(log);
    symlinkSync(join(base, 'elsewhere.jsonl'), log);
    expect(messageTrace('acme-web', root, 'builder-1', home)).toBeNull();
  });

  test('no home named: the send history is skipped rather than read from somewhere else', () => {
    message('orchestrator', 'builder-2', 'delivered', '2026-10-17T08:00:00Z');
    const session = sessionWith({});
    const seat = { name: 'builder-2', cli: 'claude-code' };
    // The entry above sits in the store; a caller that names no home reads none of it (the way
    // status.ts's store-backed differences take an absent home as no store at all)...
    expect(seatTraces({ seat, session, project: 'acme-web', root })).toEqual([]);
    // ...while the same call with the home reads it.
    expect(seatTraces({ seat, session, project: 'acme-web', root, home })).toHaveLength(1);
  });

  test("a tool row is the pane's last one, read through its colours", () => {
    // The captured permission screen's own row: `⏺ Write(notes.txt)` under Claude Code 2.1.289,
    // wrapped in SGR sequences that the read strips.
    expect(toolTrace('claude-code', claudeAnsi)).toEqual({
      kind: 'tool',
      what: 'Write(notes.txt)',
    });
    const two = '❯ hi\n⏺ Bash(bun test)\n  ⎿  ok\n⏺ Read(src/state.ts)\n';
    expect(toolTrace('claude-code', two)?.what).toBe('Read(src/state.ts)');
  });

  test('the tool row of a real capture stands even when prose rows follow it', () => {
    // `permission-read-wide-plain.txt`: `⏺ Explore(Survey project for README)` is the capture's
    // one tool call, and every later `⏺` line is the assistant's prose. A read that took the
    // last line carrying the glyph would answer with prose; the row's own `Tool(args)` shape is
    // what tells the two apart.
    expect(toolTrace('claude-code', claudeWide)).toEqual({
      kind: 'tool',
      what: 'Explore(Survey project for README)',
    });
  });

  test('an assistant\'s prose row is not a tool call, and prose that mentions one is not the row', () => {
    // The 2.1.299 capture is `⏺ One, two, three,…` — the glyph marks prose too, and only the
    // `Tool(args)` row shape is read.
    expect(toolTrace('claude-code', claudeProse)).toBeNull();
    expect(toolTrace('claude-code', '⏺ Result(foo) is what the row said\n')).toBeNull();
  });

  test('a CLI whose captures hold no such row, or a screen with none, has no trace', () => {
    expect(toolTrace('codex', codexIdle)).toBeNull();
    expect(toolTrace('claude-code', undefined)).toBeNull();
    expect(toolTrace('claude-code', '')).toBeNull();
  });

  test("antigravity's rows are read too, the expand hint trimmed, the last row standing", () => {
    // 1.2.16 prints `● Read(…)` then `● Bash(…) (ctrl+o to expand)`: the last row is the tool
    // call, and the hint is not part of its own words.
    expect(toolTrace('antigravity', agyPermission)).toEqual({
      kind: 'tool',
      what: 'Bash(ls -la ~/project/worktrees/team/)',
    });
    expect(toolTrace('antigravity', agyCommand54)?.what).toBe('Bash(ls)');
    expect(toolTrace('antigravity', agyEdit54)?.what).toBe('Edit(<project-dir>/README.md)');
    // 1.3.5 prints `● Ran (ls) (ctrl+o to expand)`.
    expect(toolTrace('antigravity', agyQuestion135)?.what).toBe('Ran(ls)');
  });

  test('a bullet that is neither shape is not a tool row', () => {
    expect(toolTrace('antigravity', '● Here (I think) it went well\n')).toBeNull();
    expect(toolTrace('antigravity', '● Ran it by hand\n')).toBeNull();
  });

  test('the three sources together, and nothing when none of them can speak', () => {
    mkdirSync(worktree, { recursive: true });
    git(worktree, '2026-10-16T09:00:00+02:00', 'init', '-q');
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    git(worktree, '2026-10-16T09:00:00+02:00', 'add', 'a.txt');
    git(worktree, '2026-10-16T09:00:00+02:00', 'commit', '-q', '-m', 'first');
    message('orchestrator', 'builder-2', 'answered', '2026-10-17T09:00:00Z');
    const session = sessionWith({ 'task-a': { path: worktree, seat: 'builder-2' } });
    const screen = '❯ hi\n⏺ Bash(bun test)\n';
    expect(seatTraces({ seat: { name: 'builder-2', cli: 'claude-code' }, session, project: 'acme-web', root, home, screen })).toEqual([
      { kind: 'commit', at: '2026-10-16T09:00:00+02:00', what: 'first', ref: expect.any(String) },
      { kind: 'ack', at: '2026-10-17T09:00:00Z', what: 'answered a message from orchestrator' },
      { kind: 'tool', what: 'Bash(bun test)' },
    ]);
    const empty = seatTraces({ seat: { name: 'tester-1', cli: 'codex' }, session, project: 'acme-web', root, home });
    expect(empty).toEqual([]);
  });
});

describe('the newest instant', () => {
  const trace = (at: string): SeatTrace => ({ kind: 'commit', at, what: 'a commit' });

  test('instants decide, never the text: an offset form is never misread as older or newer', () => {
    // 11:30+02:00 and 09:31Z are instants a minute apart; as text the offset form sorts after
    // the Z form and would read as newer, which it is not.
    expect(newestTraceAt([trace('2026-10-16T11:30:00+02:00')], '2026-10-16T09:31:00Z')).toBe('2026-10-16T09:31:00Z');
    expect(newestTraceAt([trace('2026-10-16T11:30:00+02:00')], '2026-10-16T09:29:00Z')).toBe('2026-10-16T11:30:00+02:00');
    // Among the traces themselves, the newest instant wins whatever their order.
    expect(newestTraceAt([trace('2026-10-16T09:29:00Z'), trace('2026-10-16T11:30:00+02:00')])).toBe('2026-10-16T11:30:00+02:00');
  });

  test('carried strings holding no instant are ignored, and nothing to compare answers null', () => {
    expect(newestTraceAt([trace('2026-10-16T11:30:00+02:00')], null, undefined, 'not an instant', ''))
      .toBe('2026-10-16T11:30:00+02:00');
    expect(newestTraceAt([], null)).toBeNull();
    expect(newestTraceAt([])).toBeNull();
  });

  test('a tool row carries no instant, so it is never weighed as the newest trace', () => {
    // A screen carries no clock: the row sits in the scrollback long after the work it shows,
    // and an idle seat whose pane keeps an old row must not read as working. Only the commit's
    // own date may decide.
    const row: SeatTrace = { kind: 'tool', what: 'Bash(ls)' };
    expect(newestTraceAt([row])).toBeNull();
    expect(newestTraceAt([row], null, undefined)).toBeNull();
    expect(newestTraceAt([row, trace('2026-10-16T09:29:00Z')])).toBe('2026-10-16T09:29:00Z');
    expect(newestTraceAt([row], '2026-10-16T09:31:00Z')).toBe('2026-10-16T09:31:00Z');
  });
});

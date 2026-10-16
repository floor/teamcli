// The trace sources behind a seat's own state (src/labels/traces.ts): the worktree's last
// commit, the send history's last ack or message for the seat, and the last tool row its pane
// shows — each with its own timestamp, each null rather than guessed when its source cannot
// say. The commit scenes run against a real repository (a fixed author date proves the trace
// carries the commit's own date, not the read's moment); the history scenes write real
// messages.jsonl entries through the send history's own writer.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitTrace, messageTrace, seatTraces, seatWorktree, toolTrace } from '../src/labels/traces.ts';
import { appendHistory } from '../src/send/history.ts';
import { emptySession } from '../src/state.ts';
import type { SessionState } from '../src/state.ts';
import { gitEnv } from './helpers.ts';

const claudeAnsi = readFileSync(new URL('./fixtures/claude-code/2.1.289/permission-create-wide-ansi.txt', import.meta.url), 'utf8');
const claudeProse = readFileSync(new URL('./fixtures/claude-code/2.1.299/working.txt', import.meta.url), 'utf8');
const codexIdle = readFileSync(new URL('./fixtures/codex/0.157.0/idle.txt', import.meta.url), 'utf8');

const AT = new Date('2026-10-17T10:00:00Z');

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
  worktree = join(base, 'worktrees', 'p0b-builder-2');
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
  });

  test("a tool row is the pane's last one, read through its colours", () => {
    // The captured permission screen's own row: `⏺ Write(notes.txt)` under Claude Code 2.1.289,
    // wrapped in SGR sequences that the read strips.
    expect(toolTrace('claude-code', claudeAnsi, AT)).toEqual({
      kind: 'tool',
      at: '2026-10-17T10:00:00.000Z',
      what: 'Write(notes.txt)',
    });
    const two = '❯ hi\n⏺ Bash(bun test)\n  ⎿  ok\n⏺ Read(src/state.ts)\n';
    expect(toolTrace('claude-code', two, AT)?.what).toBe('Read(src/state.ts)');
  });

  test('an assistant\'s prose row is not a tool call, and prose that mentions one is not the row', () => {
    // The 2.1.299 capture is `⏺ One, two, three,…` — the glyph marks prose too, and only the
    // `Tool(args)` row shape is read.
    expect(toolTrace('claude-code', claudeProse, AT)).toBeNull();
    expect(toolTrace('claude-code', '⏺ Result(foo) is what the row said\n', AT)).toBeNull();
  });

  test('a CLI whose captures hold no such row, or a screen with none, has no trace', () => {
    expect(toolTrace('codex', codexIdle, AT)).toBeNull();
    expect(toolTrace('claude-code', undefined, AT)).toBeNull();
    expect(toolTrace('claude-code', '', AT)).toBeNull();
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
    expect(seatTraces({ seat: { name: 'builder-2', cli: 'claude-code' }, session, project: 'acme-web', root, home, screen, at: AT })).toEqual([
      { kind: 'commit', at: '2026-10-16T09:00:00+02:00', what: 'first', ref: expect.any(String) },
      { kind: 'ack', at: '2026-10-17T09:00:00Z', what: 'answered a message from orchestrator' },
      { kind: 'tool', at: '2026-10-17T10:00:00.000Z', what: 'Bash(bun test)' },
    ]);
    const empty = seatTraces({ seat: { name: 'tester-1', cli: 'codex' }, session, project: 'acme-web', root, home, at: AT });
    expect(empty).toEqual([]);
  });
});

// The hand-over request between a daemon-hosted watch and the live pane watch it replaces: the
// file's own shape and scope, who may act on it, and the real pane watch loop leaving through its
// own seam. Everything is synthetic: a scratch checkout, a scratch home, a named fake daemon pid
// and recorder sources. No pane is read or typed into, no daemon runs, and no process is signalled.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readState, updateState, emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import {
  actingWatchHandover,
  clearWatchHandover,
  handoverPath,
  readWatchHandover,
  writeWatchHandover,
  WATCH_HANDOVER_FUTURE_SKEW_MS,
  WATCH_HANDOVER_MAX_AGE_MS,
} from '../src/watch/handover.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: keeper
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude
  - role: operator
    name: keeper
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude
  - role: builder
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude
tasks:
  source: file
  path: .agents/tasks.yaml
`;

const RULE = '─'.repeat(40);
const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`;
const FINE: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const NOW = Date.parse('2026-10-21T04:00:00Z');
const DAEMON_PID = 9_137;

let root = '';
let agents = '';
let home = '';
let file = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-watch-handover-'));
  agents = join(root, '.agents');
  home = join(root, 'home');
  file = join(agents, 'team.yaml');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execSync('git init -q', { cwd: root });
  writeFileSync(file, TEAM);
  writeFileSync(join(agents, 'tasks.yaml'), '- id: t1\n  title: first\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(over: Partial<{ root: string; session: string; pid: number; now: Date; requestedAt: string }> = {}) {
  return writeWatchHandover(agents, {
    root,
    session: 'acme',
    pid: DAEMON_PID,
    now: new Date(NOW),
    ...over,
  });
}

describe('the hand-over request file', () => {
  test('round-trips atomically at 0600 and is cleared idempotently', () => {
    const written = request();
    expect(readFileSync(handoverPath(agents), 'utf8')).toContain('"kind": "watch-handover"');
    expect(statSync(handoverPath(agents)).mode & 0o777).toBe(0o600);
    expect(readWatchHandover(agents)).toEqual({ kind: 'request', request: written });
    clearWatchHandover(agents);
    expect(readWatchHandover(agents)).toEqual({ kind: 'none' });
    expect(clearWatchHandover(agents)).toBeUndefined();
    expect(existsSync(handoverPath(agents))).toBe(false);
  });

  test('keeps the first requestedAt across refreshes and never invents a field', () => {
    const first = request();
    const refreshed = request({ now: new Date(NOW + 5_000), requestedAt: first.requestedAt });
    expect(refreshed.requestedAt).toBe(first.requestedAt);
    expect(refreshed.heartbeat).toBe(new Date(NOW + 5_000).toISOString());
  });

  test('an unreadable or another format is named, never repaired', () => {
    writeFileSync(handoverPath(agents), 'not json');
    expect(readWatchHandover(agents).kind).toBe('unreadable');
    writeFileSync(handoverPath(agents), JSON.stringify({ format: 2, kind: 'watch-handover' }));
    expect(readWatchHandover(agents).kind).toBe('unreadable');
    writeFileSync(handoverPath(agents), JSON.stringify({ ...request(), pid: -1 }));
    expect(readWatchHandover(agents).kind).toBe('unreadable');
  });
});

describe('who may act on a request', () => {
  test('the same checkout and session, a live daemon and a fresh beat', () => {
    const written = request();
    const acted = actingWatchHandover({
      read: readWatchHandover(agents),
      root,
      session: 'acme',
      alive: (pid) => pid === DAEMON_PID,
      now: NOW + 1_000,
    });
    expect(acted).toEqual(written);
  });

  test('another session, another checkout, a dead daemon, an old or future beat are all ignored', () => {
    request();
    const read = readWatchHandover(agents);
    const base = { read, root, session: 'acme', alive: (pid: number) => pid === DAEMON_PID, now: NOW };
    expect(actingWatchHandover({ ...base, session: 'other' })).toBeUndefined();
    expect(actingWatchHandover({ ...base, root: join(root, 'elsewhere') })).toBeUndefined();
    expect(actingWatchHandover({ ...base, alive: () => false })).toBeUndefined();
    expect(actingWatchHandover({ ...base, now: NOW + WATCH_HANDOVER_MAX_AGE_MS + 1 })).toBeUndefined();
    expect(actingWatchHandover({ ...base, now: NOW - WATCH_HANDOVER_FUTURE_SKEW_MS - 1 })).toBeUndefined();
    // The two edges count: exactly the window's age and exactly the allowed skew still act.
    expect(actingWatchHandover({ ...base, now: NOW + WATCH_HANDOVER_MAX_AGE_MS })).toBeDefined();
    expect(actingWatchHandover({ ...base, now: NOW - WATCH_HANDOVER_FUTURE_SKEW_MS })).toBeDefined();
  });
});

/* ------------------------------------------------------------------------------------------- */
/* The real pane watch loop                                                                    */
/* ------------------------------------------------------------------------------------------- */

function live(): Live {
  const agents: HerdrAgent[] = [];
  return { running: true, agents, workspaces: [], screens: {} };
}

function sources(over: Partial<WatchSources> = {}, count = { passes: 0 }): WatchSources {
  return {
    live: () => {
      count.passes += 1;
      return live();
    },
    machine: () => FINE,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => IDLE,
    status: () => 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(NOW),
    wait: async () => false,
    alive: (pid) => pid === DAEMON_PID,
    pid: 4_242,
    home,
    ...over,
  };
}

describe('the pane watch loop', () => {
  test('leaves through its own seam when the live daemon asks, and deletes only its own record', async () => {
    updateState(agents, (state) => {
      (state.sessions.acme ??= emptySession()).watch = { pid: 4_242, heartbeat: new Date(NOW).toISOString() };
    });
    request();
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources({ ownPane: () => 'gone' }));
    expect(code).toBe(0);
    expect(io.out).toContain('handing over the session "acme"');
    // The loop left before its first pass: no effect, no reading, no record of its own.
    expect(readState(agents).sessions.acme?.watch).toBeUndefined();
    expect(existsSync(handoverPath(agents))).toBe(true);
  });

  test('a request from a dead process or another session is not a reason to leave', async () => {
    const count = { passes: 0 };
    request({ pid: 5_555, session: 'other' });
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources({ ownPane: () => 'gone' }, count));
    expect(code).toBe(0);
    expect(io.out).not.toContain('handing over');
    expect(count.passes).toBeGreaterThan(0);
    request({ pid: 5_555 });
    const second = { passes: 0 };
    const other = testIo(root, { kind: 'owner' });
    expect(await runWatch(['--file', file], other, sources({ ownPane: () => 'gone' }, second))).toBe(0);
    expect(other.out).not.toContain('handing over');
    expect(second.passes).toBeGreaterThan(0);
  });
});

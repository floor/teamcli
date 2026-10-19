// The pause as the commands hand it to each other, not as each command's own fixture fakes it:
// `team pause` writes the record `team next` then reads and refuses under, `team resume` clears
// that same record and the queue moves once, and a watch started after the pause reads the record
// from the state and types the pause notice instead of the work nudge. The per-command edge tests
// stand in a hand-written record; these run the record through the commands that write and read it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runNext } from '../src/commands/next.ts';
import { runPause } from '../src/commands/pause.ts';
import { runResume } from '../src/commands/resume.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { readState, updateState, emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import type { WorkPush, WorkPushRequest } from '../src/watch/dispatch.ts';
import { claudeBox, testIo } from './helpers.ts';

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

const CTX = 'team acme, session "acme"\n';
const NOW = new Date('2026-10-19T03:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };

let root: string;
let home: string;
let now: number;

function project(): void {
  root = mkdtempSync(join(tmpdir(), 'team-pause-flow-'));
  home = join(root, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= { seats: {}, worktrees: {} });
    for (const seat of ['lead', 'keeper', 'worker']) session.seats[seat] = { stage: 'ready', pane: 'w1:p1' };
  });
  now = NOW.getTime();
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Reading = { code: number; out: string; err: string };

async function pause(argv: string[] = [], caller: Caller = OWNER): Promise<Reading> {
  const io = testIo(root, caller);
  const code = await runPause(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

async function resume(argv: string[] = [], caller: Caller = OWNER): Promise<Reading> {
  const io = testIo(root, caller);
  const code = await runResume(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

async function next(argv: string[] = [], caller: Caller = LEAD): Promise<Reading> {
  const io = testIo(root, caller);
  const code = await runNext(argv, io, { home, now: () => now });
  return { code, out: io.out, err: io.err };
}

function stateText(): string {
  return readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
}

function leases(): string[] {
  const dir = join(root, '.agents', 'leases');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

function lease(): { acquiredAt: string; renewedAt: string; seat: string; pane: string } {
  return JSON.parse(readFileSync(join(root, '.agents', 'leases', 'm1.json'), 'utf8')) as {
    acquiredAt: string; renewedAt: string; seat: string; pane: string;
  };
}

describe('the pause the command writes is the one next reads', () => {
  test('a pause holds the claim, and the resume after it moves the queue once', async () => {
    project();
    const at = NOW.toISOString();

    const placed = await pause();
    expect(placed.code).toBe(0);
    expect(placed.out).toContain(`paused since ${at} by owner`);
    expect(placed.out).toContain('stop lead: ready');
    expect(placed.out).toContain('stop keeper: ready');
    expect(placed.out).toContain('stop worker: ready');
    expect(readState(join(root, '.agents')).pause?.at).toBe(at);

    // The claim the command the pause is for refuses: the record `team pause` wrote is the one
    // `team next` reads, and nothing is claimed while it stands.
    const held = await next();
    expect(held.code).toBe(1);
    expect(held.err).toBe(
      `team next: the team is paused (paused since ${at} by owner); nothing new is claimed until \`team resume\`\n`,
    );
    expect(held.out).toBe('');
    expect(leases()).toEqual([]);
    // A refusal writes nothing: the state the pause left is the state the claim found.
    const before = stateText();
    expect(await next()).toMatchObject({ code: 1 });
    expect(stateText()).toBe(before);

    const resumed = await resume();
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`resumed acme (paused since ${at} by owner)`);
    expect(resumed.out).toContain('stop lead: ready');
    expect(resumed.out).toContain('stop worker: ready');
    expect(readState(join(root, '.agents')).pause).toBeUndefined();

    // The queue that was held moves once: one lease, the same acquisition when the seat renews.
    const claimed = await next();
    expect(claimed).toEqual({ code: 0, out: `${CTX}m1  the task title\nteam next: claimed m1\n`, err: '' });
    expect(leases()).toEqual(['m1.json']);
    const first = lease();
    expect(first).toMatchObject({ seat: 'lead', pane: 'w1:p1' });
    now += 60_000;
    expect(await next()).toMatchObject({ code: 0 });
    expect(leases()).toEqual(['m1.json']);
    const renewed = lease();
    expect(renewed.acquiredAt).toBe(first.acquiredAt);
    expect(renewed.renewedAt > first.renewedAt).toBe(true);
  });

  test('a lease a seat holds under the pause is released without a resume', async () => {
    project();
    expect(await next()).toMatchObject({ code: 0 });
    expect(leases()).toEqual(['m1.json']);

    expect(await pause()).toMatchObject({ code: 0 });
    expect(await next()).toMatchObject({ code: 1 });
    const released = await next(['--release']);
    expect(released).toEqual({ code: 0, out: `${CTX}team next: released m1\n`, err: '' });
    expect(leases()).toEqual([]);
    // The pause still stands after the release: the seat gave back its lease, not the stop.
    expect(readState(join(root, '.agents')).pause?.by).toBe('owner');
    expect(await next()).toMatchObject({ code: 1 });
  });
});

// The watch reads the pause from the project's state, not from a value a test handed its pass:
// the same file example the nudge tests use, with the record `team pause` would have written.
const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const PROMPT = 'Take the next unfinished item in your queue and start it.';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:pane`, workspace, status, cwd: null };
}

/** One idle worker on the second pane and its lead on the first, the scene the nudge test uses. */
function scene(idleSeat: { status: string; screen: string }): Live {
  const agents = [
    agent('claude-coordinator-acme', 'lead', 'working'),
    agent('deepseek-acme', 'first', 'working'),
    agent('deepseek-acme-2', 'second', idleSeat.status),
  ];
  const screens: Record<string, string> = {
    'lead:pane': busy,
    'first:pane': busy,
    'second:pane': idleSeat.screen,
  };
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

describe('the watch reads the pause from the state', () => {
  let dir: string;
  let file: string;
  let typed: string[];
  let screenNow: string;
  let clock: number;

  function sources(over: Partial<WatchSources> = {}): WatchSources {
    let left = 2;
    return {
      live: () => scene({ status: 'idle', screen: idle }),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => screenNow,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = claudeBox(text); return true; },
      pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
      sleep: async (ms) => { clock += ms; },
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => { clock += 10 * MIN; return --left > 0; },
      alive: () => false,
      pid: 4242,
      home: dir,
      ...over,
    };
  }

  /** Every drop the watch typed as a trigger, as its path. */
  function triggers(): string[] {
    return typed
      .filter((line) => /^second:pane Read .+ and do that\.$/.test(line))
      .map((line) => line.replace(/^second:pane Read (.*) and do that\.$/, '$1'));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-pause-watch-'));
    execSync('git init -q', { cwd: dir });
    mkdirSync(join(dir, '.agents'));
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`));
    typed = [];
    screenNow = idle;
    clock = Date.parse('2026-10-03T14:00:00Z');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedPause(at = '2026-10-03T13:00:00.000Z'): void {
    updateState(join(dir, '.agents'), (state) => {
      state.pause = { by: 'owner', at, stops: [] };
    });
  }

  function watchOnce(over: Partial<WatchSources> = {}): Promise<number> {
    // A fresh watch process reads a fresh screen: what the previous run typed is not there.
    screenNow = idle;
    const io = testIo(dir, { kind: 'owner' });
    return runWatch(['--file', file], io, sources({
      ownPane: () => ({ pane: 'watch:pane', workspace: 'watch' }),
      ...over,
    }));
  }

  test('the notice, not the work nudge, is typed, and a restarted watch reads the pause again', async () => {
    const at = '2026-10-03T13:00:00.000Z';
    seedPause(at);
    const notice = `Team watch: paused since ${at} by owner — finish the step you are on, take nothing new, and hold no lock until \`team resume\``;

    expect(await watchOnce()).toBe(0);
    const first = triggers();
    expect(first).toHaveLength(1);
    expect(readFileSync(first[0] as string, 'utf8')).toBe(notice);
    expect(typed.some((line) => line.includes(PROMPT))).toBe(false);

    // A restart is a new process: the pause is still in the state, so its watch notices again
    // rather than falling back to nudging work under a stop.
    typed = [];
    expect(await watchOnce()).toBe(0);
    const restarted = triggers();
    expect(restarted).toHaveLength(1);
    expect(readFileSync(restarted[0] as string, 'utf8')).toBe(notice);
    expect(typed.some((line) => line.includes(PROMPT))).toBe(false);
  });

  test('the resume restores the ordinary direct dispatch', async () => {
    seedPause();
    expect(await watchOnce()).toBe(0);
    expect(typed.some((line) => line.includes(PROMPT))).toBe(false);

    updateState(join(dir, '.agents'), (state) => {
      delete state.pause;
      const seats = (state.sessions['acme-web'] ??= emptySession()).seats;
      for (const seat of ['deepseek-acme', 'deepseek-acme-2']) {
        seats[seat] = { stage: 'ready', last_active: '2026-10-03T13:00:00.000Z' };
      }
    });
    writeFileSync(join(dir, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
    const pushed: WorkPushRequest[] = [];
    const pushWork: WorkPush = async (request) => {
      pushed.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    typed = [];
    expect(await watchOnce({ pushWork })).toBe(0);
    // The ordinary route after a resume is the dispatcher's direct push; nothing is typed.
    expect(pushed.map((one) => one.seat)).toEqual(['deepseek-acme-2']);
    expect(triggers()).toHaveLength(0);
    expect(typed.some((line) => line.includes(PROMPT))).toBe(false);
  });
});

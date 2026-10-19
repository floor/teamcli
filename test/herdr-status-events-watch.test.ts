// Seat status events where the watch itself raises them: one pass maps herdr's statuses through
// the injected status source to signed records in the event log, once per transition, and a
// status waiter is started for exactly the seats that may have one (never a human seat, never a
// profile whose herdr status is unreliable).
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { readEvents, verifySignedEvent } from '../src/bus/log.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import { createSeatStatusEngine, type StatusSource, type StatusTarget } from '../src/watch/status-events.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
entity: floor
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: worker-1
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - name: jules-1
    role: builder
    cli: jules
    vendor: google
    model: Gemini Pro
    version: "4.0"
    launch: jules
  - name: owner-pane
    role: human-observer
    human: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const PANES: Record<string, string> = {
  'crew-lead': 'w1',
  'worker-1': 'w2',
  'jules-1': 'w3',
  'owner-pane': 'w4',
};

const fine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

type Fixture = { base: string; root: string; home: string; file: string; team: TeamFile };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-status-events-watch-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execSync('git init -q -b main', { cwd: root, stdio: 'ignore' });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return { base, root, home, file, team: parsed.team };
}

/** One live scene: the named seats at the given herdr statuses, in their fixed panes. */
function scene(statuses: Record<string, string>): Live {
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, status] of Object.entries(statuses)) {
    const workspace = PANES[name] ?? name;
    agents.push({
      name,
      agent: name.startsWith('jules') ? 'jules' : 'claude',
      pane: `${workspace}:p1`,
      workspace,
      status,
      cwd: null,
    });
    screens[`${workspace}:p1`] = '';
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

function watchSources(fixture: Fixture, scenes: Live[], statusSource: StatusSource, typed: string[], notified: string[]): WatchSources {
  let index = 0;
  let clock = Date.parse('2026-10-19T05:00:00Z');
  return {
    live: () => scenes[Math.min(index, scenes.length - 1)]!,
    machine: () => fine,
    standing: (root) => verifiedOf(fixture.team, TEAM, root),
    readChecks: () => [],
    screen: () => '',
    status: () => 'idle',
    foreground: () => ['claude'],
    typeText: (pane, text) => {
      typed.push(`${pane} ${text}`);
      return true;
    },
    pressEnter: (pane) => {
      typed.push(`${pane} enter`);
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    notify: (text) => notified.push(text),
    now: () => new Date(clock),
    wait: async (seconds) => {
      clock += seconds * 1000;
      index += 1;
      return index < scenes.length;
    },
    alive: () => false,
    pid: 4242,
    home: fixture.home,
    statusSource,
  };
}

function readLog(fixture: Fixture) {
  const read = readEvents(fixture.team.project, fixture.root, fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read;
}

describe('the watch pass raises seat status events', () => {
  test('blocked then working raise seat.at-prompt and seat.unblocked, signed, and only for that seat', async () => {
    const fixture = makeFixture();
    const typed: string[] = [];
    const notified: string[] = [];
    const statusSource: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: 0 };
      },
      promptKind: () => 'permission',
    };
    const sources = watchSources(
      fixture,
      [
        scene({ 'crew-lead': 'idle', 'worker-1': 'blocked', 'jules-1': 'working', 'owner-pane': 'working' }),
        scene({ 'crew-lead': 'idle', 'worker-1': 'working', 'jules-1': 'working', 'owner-pane': 'working' }),
      ],
      statusSource,
      typed,
      notified,
    );

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runWatch(['--file', fixture.file], io, sources), io.err).toBe(0);

    const log = readLog(fixture);
    expect(log.unverified).toBe(0);
    for (const record of log.events) expect(verifySignedEvent(record, fixture.home)).toBe(true);

    const worker = log.events.filter((record) => record.payload.seat === 'worker-1');
    expect(worker.map((record) => record.payload.kind)).toEqual(['seat.at-prompt', 'seat.unblocked']);
    expect(worker[0]?.payload.prompt).toBe('permission');
    // The human seat and the profile with an unreliable herdr status raise nothing.
    expect(log.events.some((record) => record.payload.seat === 'owner-pane')).toBe(false);
    expect(log.events.some((record) => record.payload.seat === 'jules-1')).toBe(false);
    // The pass is read-only: nothing was typed or pressed into a pane.
    expect(typed).toEqual([]);
  });

  test('unknown raises nothing, and repeated identical statuses raise one event each', async () => {
    const fixture = makeFixture();
    const typed: string[] = [];
    const statusSource: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: 0 };
      },
      promptKind: () => 'question',
    };
    const sources = watchSources(
      fixture,
      [
        scene({ 'crew-lead': 'idle', 'worker-1': 'unknown', 'jules-1': 'working', 'owner-pane': 'idle' }),
        scene({ 'crew-lead': 'idle', 'worker-1': 'done', 'jules-1': 'working', 'owner-pane': 'idle' }),
        scene({ 'crew-lead': 'idle', 'worker-1': 'done', 'jules-1': 'working', 'owner-pane': 'idle' }),
      ],
      statusSource,
      typed,
      [],
    );

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runWatch(['--file', fixture.file], io, sources), io.err).toBe(0);

    const log = readLog(fixture);
    const worker = log.events.filter((record) => record.payload.seat === 'worker-1');
    expect(worker.map((record) => record.payload.kind)).toEqual(['seat.done']);
    expect(typed).toEqual([]);
  });

  test('a human seat is never asked for a prompt kind and never waited on', async () => {
    const fixture = makeFixture();
    let promptReads = 0;
    const statusSource: StatusSource = {
      async waitStatus() {
        return { outcome: 'timeout', at: 0 };
      },
      promptKind: () => {
        promptReads += 1;
        return 'trust';
      },
    };
    const sources = watchSources(
      fixture,
      [scene({ 'crew-lead': 'idle', 'worker-1': 'working', 'jules-1': 'working', 'owner-pane': 'blocked' })],
      statusSource,
      [],
      [],
    );

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runWatch(['--file', fixture.file], io, sources), io.err).toBe(0);
    expect(promptReads).toBe(0);
    expect(readLog(fixture).events.some((record) => record.payload.seat === 'owner-pane')).toBe(false);
  });
});

describe('a status waiter is started for eligible seats', () => {
  test('one waiter per eligible seat: no human seat, no herdr-unreliable profile', async () => {
    const fixture = makeFixture();
    const waits: { seat: string; target: string }[] = [];
    const engine = createSeatStatusEngine({
      team: fixture.team,
      root: fixture.root,
      home: fixture.home,
      source: {
        async waitStatus(seat, target: StatusTarget) {
          waits.push({ seat: seat.name, target: 'is' in target ? `is:${target.is}` : `not:${target.not}` });
          return { outcome: 'timeout', at: 0 };
        },
      },
    });

    const pool = engine.startWaiters(
      { 'crew-lead': 'w1:p1', 'worker-1': 'w2:p1', 'jules-1': 'w3:p1', 'owner-pane': 'w4:p1' },
      { maxIterations: 1, timeoutMs: 10 },
    );
    await pool.done;

    expect(waits.map((one) => one.seat).sort()).toEqual(['crew-lead', 'worker-1']);
    expect(waits.every((one) => one.target === 'not:unknown')).toBe(true);
    expect(readLog(fixture).events).toEqual([]);
  });
});

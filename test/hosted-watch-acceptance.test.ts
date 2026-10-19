// Acceptance: the machine daemon's hosted watch, exercised through the real host on a virtual
// clock. A hosted route is the shared `runWatch` loop running inside the daemon: the host owns
// the liveness tick, the wait and the cancellation; the loop owns one serial pass. This file
// proves, independently of B5's focused tests, that a tick never awaits or doubles a pass, two
// routes cycle on their own ticks and one failure stays on its route (a fresh host, never an
// automatic restart, recovers), a pass waits the team file's own 10-second rhythm, a stop
// resolves the current and every later wait false and leaves ticks inert, a live recorded pane
// watch makes the loop stand down without touching it, a route with no injected admitted sender
// runs with blocked effects and zero mutations, and an injected admitted sender pushes through
// the production direct sender into the real read-once gate and a real `team next` claim.
// No live service, no pane action, no typing: every mutating source is a recorder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runNext } from '../src/commands/next.ts';
import { sendDirect, type SendHost } from '../src/commands/send.ts';
import { workPushResultOf, type WatchSources } from '../src/commands/watch.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { createHostedWatch, type HostedWatch, type HostedWatchInput } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import { forgetIdleEpisodes, type WorkPush, type WorkPushRequest } from '../src/watch/dispatch.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { readRecord, verifyRecord, type SignedRecord } from '../src/send/record.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Machine } from '../src/watch/machine.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const SEAT = 'deepseek-acme';
const PANE = 'first:pane';
const START = Date.parse('2026-10-20T03:00:00Z');
// The owner's watch-rhythm minimum, and the host's own liveness cadence. They are deliberately
// different: a tick never decides a pass, and a pass never sets the tick.
const INTERVAL_MS = 10_000;
const TICK_MS = 5_000;
const THRESHOLD_MS = 300_000;

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
watch:
  interval: 10s
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: deepseek-acme
    label: deepseek-acme
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
`;

const QUEUE = `- id: t1
  title: first queued slice
- id: t2
  title: second queued slice
- id: t3
  title: third queued slice
`;

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let base: string;
let root: string;
let home: string;
let sockets: string;
let clock: number;

type Spies = { typed: number; entered: number; keys: number; notified: number; paneRuns: number };

function spies(): Spies {
  return { typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 };
}

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:pane`, workspace, status, cwd: null };
}

function live(workerStatus = 'idle'): Live {
  const agents = [agent('lead', 'lead', 'working'), agent(SEAT, 'first', workerStatus)];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'lead:pane': IDLE, [PANE]: IDLE },
  };
}

function route(): HostedRoute {
  return routeOf(root, 'acme', SESSION, ['lead', SEAT]);
}

/** The read sources a hosted pass runs over. Reads stand in for herdr; every mutating source
 *  records the call instead of performing it, so a typed line, a key, a notice or a pane run
 *  observed here is a product fault. The hosted source set closes them anyway; recording in the
 *  base makes that closure observable. */
function baseSources(options: { workerStatus?: string; spy?: Spies } = {}): WatchSources {
  const spy = options.spy ?? spies();
  const sources: WatchSources = {
    live: () => live(options.workerStatus ?? 'idle'),
    machine: () => fine,
    standing: () => verifiedOf(teamOf(TEAM), TEAM, root),
    readChecks: () => [],
    screen: () => IDLE,
    status: () => options.workerStatus ?? 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => {
      spy.typed += 1;
      return false;
    },
    pressEnter: () => {
      spy.entered += 1;
      return false;
    },
    sendKey: () => {
      spy.keys += 1;
      return false;
    },
    paneRun: () => {
      spy.paneRuns += 1;
      return false;
    },
    sleep: async () => {},
    notify: () => {
      spy.notified += 1;
    },
    now: () => new Date(clock),
    wait: async () => false,
    // A recorded pane watch on pid 222 is live; the hosted loop is a different identity.
    alive: (pid) => pid === 222,
    pid: 4242,
    home,
  };
  return sources;
}

/** The production binding: the shared watch loop inside the host, over the recording reads. */
function runHosted(options: { pushWork?: WorkPush; effects?: 'blocked' | 'open'; spy?: Spies; workerStatus?: string } = {}): HostedWatch {
  const input: HostedWatchInput = {
    route: route(),
    now: () => new Date(clock),
    run: hostedWatchRun({
      route: route(),
      log: () => {},
      base: baseSources({ workerStatus: options.workerStatus, spy: options.spy }),
      pid: 4242,
      ...(options.pushWork !== undefined ? { pushWork: options.pushWork } : {}),
    }),
    ...(options.effects !== undefined ? { effects: options.effects } : {}),
  };
  return createHostedWatch(input);
}

function leases(): Array<{ id: string; seat: string; pane: string; acquiredAt: string; until: string }> {
  const dir = join(root, '.agents', 'leases');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ id: name.slice(0, -'.json'.length), ...JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

function workerDropDir(): string {
  return join(root, '.agents', 'send-drops', SESSION, SEAT);
}

function dropNames(): string[] {
  const dir = workerDropDir();
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The signed message records the worker's inbox holds, each verified against the home's
 *  message key: a message that does not verify is not a durable signed copy. */
function workerInbox(): SignedRecord[] {
  const dir = workerDropDir();
  if (!existsSync(dir)) return [];
  const key = messageKeyState(home);
  if (key.kind !== 'key') return [];
  const records: SignedRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const read = readRecord(join(dir, name));
    if (!read.ok || read.record === null) continue;
    if (read.record.payload.to !== SEAT) continue;
    if (!verifyRecord(read.record, key.key)) continue;
    records.push(read.record);
  }
  return records;
}

/** The worker's runtime: the real read-once gate serves the delivered message and writes its
 *  signed receipt, and only then does a real `team next` receiver run as the worker. Only the
 *  transport's own delivery signal calls the pump; the staged copy alone is not a wake. */
function workerRuntime(): { pump: () => Promise<void>; claims: string[]; wake: () => void } {
  const claims: string[] = [];
  let woken = 0;
  const wake = () => {
    woken += 1;
  };
  const pump = async () => {
    if (woken === 0) return;
    woken = 0;
    for (const record of workerInbox()) {
      const read = readMessage({ dropDir: workerDropDir(), root, seat: SEAT, session: SESSION }, record.payload.id, home);
      if (!read.ok) continue;
      const io = testIo(root, { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
      await runNext([], io, { home, now: () => clock });
      claims.push(io.out.trim());
    }
  };
  return { pump, claims, wake };
}

/** The worker's session accepts cross-session frames and exposes a socket for its pane. */
function directRoute(): void {
  const settings = cliHookSettingsPath(join(root, '.agents'), SESSION, SEAT);
  if (settings === null) throw new Error(`${SEAT}: no settings path for the fixture`);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(settings, past, past);
  writeFileSync(join(sockets, '222.sock'), '');
}

/** The push the hosted pass makes, wired to the REAL production direct sender and the watch's
 *  own ending mapping: only a delivered ending is a success. */
function pushViaSend(options: { direct: boolean; onDeliver?: () => void }): {
  push: WorkPush;
  pushed: WorkPushRequest[];
  frames: string[];
  typed: string[];
} {
  const frames: string[] = [];
  const typed: string[] = [];
  const pushed: WorkPushRequest[] = [];
  let seat = SEAT;
  let pane = PANE;
  let cli = 'claude-code';
  const host: SendHost = {
    agents: () => [{ name: seat, pane, cli }],
    processInfo: () => (options.direct ? { shell: 111, foreground: [222] } : null),
    socketsDir: sockets,
    deliver: async (_socketPath, frame) => {
      frames.push(frame);
      options.onDeliver?.();
      return { ok: true };
    },
    native: {
      typeText: (_session, _pane, text) => {
        typed.push(text);
        return true;
      },
      pressEnter: () => {
        typed.push('<enter>');
        return true;
      },
      status: () => 'idle',
      wait: async () => {},
    },
    now: () => new Date(clock),
    home,
    delivery: { team: ['socket'] },
  };
  const push: WorkPush = async (request) => {
    pushed.push(request);
    seat = request.seat;
    pane = request.pane;
    cli = request.cli;
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'lead:pane', session: SESSION });
    const run = await sendDirect(io, host, { seat: request.seat, pane: request.pane, cli: request.cli, body: request.body });
    return workPushResultOf(run.result, io.err);
  };
  return { push, pushed, frames, typed };
}

/** Lets a resolved continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  // The dispatcher keeps its idle episodes per process; a pass in another test must not spend
  // this world's one attempt.
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-acceptance-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  mkdirSync(sockets);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), QUEUE);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: PANE, last_active: new Date(START - THRESHOLD_MS - 5_000).toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'lead:pane', last_active: new Date(START).toISOString() };
  });
  clock = START;
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

describe('hosted watch lifecycle', () => {
  test('a liveness tick returns before any pass and never starts a second one', async () => {
    let started = 0;
    let loopSeen: HostedLoop | undefined;
    const host = createHostedWatch({
      route: route(),
      now: () => new Date(clock),
      run: async (loop) => {
        loopSeen = loop;
        started += 1;
        await loop.wait(60_000);
        return 0;
      },
    });
    // The pass starts with the host and is blocked on its own wait.
    expect(started).toBe(1);
    for (let index = 0; index < 5; index += 1) {
      // A tick is synchronous and void: the heartbeat is never held by a pass.
      expect(host.tick(new Date(clock + index * TICK_MS))).toBeUndefined();
    }
    await flush();
    expect(host.state()).toMatchObject({ phase: 'starting', cycles: 0, failures: 0 });
    expect(started).toBe(1);
    expect(loopSeen?.signal.aborted).toBe(false);
    const stopping = host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopping');
    await stopping;
    expect(host.state()).toMatchObject({ phase: 'stopped', cycles: 0 });
    await host.done;

    // Once a pass completes, many ticks at one due instant still release exactly one more:
    // passes are serial and one flight.
    let passes = 0;
    const serial = createHostedWatch({
      route: route(),
      now: () => new Date(clock),
      run: async (loop) => {
        for (;;) {
          passes += 1;
          loop.cycled(new Date(clock));
          if (!(await loop.wait(INTERVAL_MS))) return 0;
        }
      },
    });
    expect(serial.state().cycles).toBe(1);
    const due = new Date(clock + INTERVAL_MS);
    for (let index = 0; index < 5; index += 1) serial.tick(due);
    await flush();
    expect(serial.state().cycles).toBe(2);
    expect(passes).toBe(2);
    await serial.stop('the daemon is closing');
  });

  test('two routes cycle only on their own ticks, and one failure stays on its route', async () => {
    const cycling = (count: { passes: number }) => async (loop: HostedLoop) => {
      for (;;) {
        count.passes += 1;
        loop.cycled(new Date(clock));
        if (!(await loop.wait(INTERVAL_MS))) return 0;
      }
    };
    const aCount = { passes: 0 };
    const bCount = { passes: 0 };
    const a = createHostedWatch({ route: routeOf('/repo/a', 'a', 'a', ['one']), now: () => new Date(clock), run: cycling(aCount) });
    const b = createHostedWatch({ route: routeOf('/repo/b', 'b', 'b', ['two']), now: () => new Date(clock), run: cycling(bCount) });
    expect(a.state().cycles).toBe(1);
    expect(b.state().cycles).toBe(1);

    clock += INTERVAL_MS;
    a.tick(new Date(clock));
    await flush();
    expect(a.state().cycles).toBe(2);
    expect(b.state().cycles).toBe(1); // B was not ticked and has its own wait

    clock += INTERVAL_MS;
    b.tick(new Date(clock));
    await flush();
    expect(b.state().cycles).toBe(2);
    expect(a.state().cycles).toBe(2);

    let threw = false;
    const bad = createHostedWatch({
      route: routeOf('/repo/bad', 'bad', 'bad', ['three']),
      now: () => new Date(clock),
      run: async () => {
        await Promise.resolve();
        threw = true;
        throw new Error('the route read failed');
      },
    });
    await flush();
    expect(threw).toBe(true);
    expect(bad.state()).toMatchObject({
      phase: 'failed', failures: 1, lastCycleOutcome: 'failed', cycles: 0, why: 'the route read failed',
    });

    // The failed host is terminal and its tick is inert; the other two keep cycling.
    clock += INTERVAL_MS;
    bad.tick(new Date(clock));
    a.tick(new Date(clock));
    b.tick(new Date(clock));
    await flush();
    expect(bad.state().phase).toBe('failed');
    expect(bad.state().cycles).toBe(0);
    expect(a.state().cycles).toBe(3);
    expect(b.state().cycles).toBe(3);

    // There is no automatic restart; a fresh host on the same route recovers explicitly.
    const fresh = createHostedWatch({
      route: routeOf('/repo/bad', 'bad', 'bad', ['three']),
      now: () => new Date(clock),
      run: async (loop) => {
        loop.cycled(new Date(clock));
        return 0;
      },
    });
    await flush();
    expect(fresh.state()).toMatchObject({
      phase: 'stopped', cycles: 1, failures: 0, lastCycleOutcome: 'pass',
    });
    await fresh.done;
    await bad.stop('the daemon is closing');
    expect(bad.state().phase).toBe('failed'); // a failure is not written over by a close
    await a.stop('the daemon is closing');
    await b.stop('the daemon is closing');
    expect(a.state().phase).toBe('stopped');
    expect(b.state().phase).toBe('stopped');
  });

  test('a hosted pass waits the file\'s own 10-second rhythm, not the tick cadence', async () => {
    const host = runHosted();
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state().lastCycleAt).toBe(new Date(START).toISOString());

    // One millisecond early: the tick releases nothing, even though it is the same liveness
    // cadence the daemon uses.
    clock = START + INTERVAL_MS - 1;
    host.tick(new Date(clock));
    await flush();
    expect(host.state().cycles).toBe(1);

    clock = START + INTERVAL_MS;
    host.tick(new Date(clock));
    await waitUntil(() => host.state().cycles === 2);
    expect(host.state().lastCycleAt).toBe(new Date(clock).toISOString());

    // The next wait is due one interval after this completed pass, not after the first.
    clock = START + 2 * INTERVAL_MS - 1;
    host.tick(new Date(clock));
    await flush();
    expect(host.state().cycles).toBe(2);
    clock = START + 2 * INTERVAL_MS;
    host.tick(new Date(clock));
    await waitUntil(() => host.state().cycles === 3);
    expect(host.state().lastCycleAt).toBe(new Date(clock).toISOString());
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });

  test('stop cancels the current wait and every later one, and later ticks do nothing', async () => {
    let loopSeen: HostedLoop | undefined;
    let sawWait: boolean | undefined;
    const host = createHostedWatch({
      route: route(),
      now: () => new Date(clock),
      run: async (loop) => {
        loopSeen = loop;
        sawWait = await loop.wait(60_000);
        return sawWait ? 1 : 0;
      },
    });
    clock += TICK_MS;
    host.tick(new Date(clock));
    await flush();
    expect(host.state().phase).toBe('starting');

    const stopping = host.stop('the transfer was cancelled');
    expect(host.state().phase).toBe('stopping');
    // Registered while the stop is already in effect: the next pass never starts.
    expect(await loopSeen?.wait(1)).toBe(false);
    await stopping;
    expect(sawWait).toBe(false);
    expect(host.state()).toMatchObject({
      phase: 'stopped',
      why: 'the transfer was cancelled',
      cycles: 0,
      failures: 0,
      lastCycleAt: null,
      lastCycleOutcome: null,
    });

    const atStop = host.state();
    for (let index = 0; index < 5; index += 1) host.tick(new Date(clock + index * INTERVAL_MS));
    await flush();
    expect(host.state()).toEqual(atStop);
    await host.done;
  });

  test('a recorded live pane watch makes the hosted loop stand down without touching it', async () => {
    updateState(join(root, '.agents'), (state) => {
      (state.sessions[SESSION] ??= emptySession()).watch = {
        pid: 222,
        pane: 'watch:pane',
        workspace: 'watch',
        heartbeat: new Date(clock).toISOString(),
      };
    });
    const spy = spies();
    const host = runHosted({ spy });
    await waitUntil(() => host.state().phase === 'standby');
    expect(host.state()).toMatchObject({
      phase: 'standby',
      cycles: 0,
      failures: 0,
      lastCycleAt: null,
      lastCycleOutcome: null,
    });
    expect(host.state().why).toContain('a watch already runs for the session "acme" (pid 222)');
    // A standby host never cycles and never writes over the live watch's record.
    clock += 3 * INTERVAL_MS;
    host.tick(new Date(clock));
    await flush();
    expect(host.state().cycles).toBe(0);
    expect(readState(join(root, '.agents')).sessions[SESSION]?.watch?.pid).toBe(222);
    expect(spy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });

  test('with no admitted sender the loop runs, but every outbound effect stays blocked', async () => {
    const spy = spies();
    const host = runHosted({ spy });
    await waitUntil(() => host.state().cycles === 1);
    expect(host.state()).toMatchObject({ phase: 'running', effects: 'blocked', failures: 0 });
    clock += INTERVAL_MS;
    host.tick(new Date(clock));
    await waitUntil(() => host.state().cycles === 2);

    // Zero observable mutation calls: the recording reads were never reached.
    expect(spy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });
    // Zero world artifacts of automatic work: no work drop, no durable copy, no lease.
    expect(dropNames().filter((name) => name.startsWith('work-'))).toEqual([]);
    expect(workerInbox()).toEqual([]);
    expect(leases()).toEqual([]);
    // A hosted pass never records itself as the session's pane watch.
    expect(readState(join(root, '.agents')).sessions[SESSION]?.watch).toBeUndefined();
    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');

    // The queued work survived for a later entitled claim.
    const io = testIo(root, { kind: 'seat', name: SEAT, pane: PANE, session: SESSION });
    expect(await runNext([], io, { home, now: () => clock })).toBe(0);
    expect(io.out).toContain('claimed t1');
  });

  test('an injected admitted sender drives the real receiver and team next claims one item', async () => {
    directRoute();
    const runtime = workerRuntime();
    const sent = pushViaSend({ direct: true, onDeliver: () => { runtime.wake(); void runtime.pump(); } });
    const spy = spies();
    const host = runHosted({ pushWork: sent.push, effects: 'open', spy });
    await waitUntil(() => host.state().cycles === 1 && runtime.claims.length === 1);

    expect(host.state()).toMatchObject({ phase: 'running', effects: 'open', failures: 0 });
    expect(sent.pushed).toHaveLength(1);
    expect(sent.pushed[0]).toMatchObject({ seat: SEAT, pane: PANE, cli: 'claude-code' });
    expect(sent.frames).toHaveLength(1);
    expect(sent.typed).toEqual([]);
    expect(spy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });
    expect(runtime.claims).toHaveLength(1);
    expect(runtime.claims[0]).toContain('claimed t1');
    const held = leases();
    expect(held.map((lease) => lease.id)).toEqual(['t1']);
    expect(held[0]?.seat).toBe(SEAT);
    expect(held[0]?.pane).toBe(PANE);
    expect(Date.parse(held[0]?.acquiredAt ?? '')).toBeLessThanOrEqual(START + 60_000);

    await host.stop('the daemon is closing');
    expect(host.state().phase).toBe('stopped');
  });
});

// Independent coverage for the send endpoint's off-loop host reads (`fix/daemon-loop-sync-host`).
//
// The endpoint's four real host reads — the agent list, the pane's processes, the pane's agent
// status and the pane's text — are awaited, with a ten-second bound enforced by the read child's
// own kill. These scenes, written independently of the lane's own probe file, hold the four
// claims the fix makes:
//
//   1. A send handled while a host read is slow keeps the endpoint's own probe answering, judged
//      in-process (this file's process hosts the daemon's loop): no sampler interval grows to the
//      read's own span, and every probe answers far inside the product's 2,000 ms budget. The
//      host's READ members are async-only here and their synchronous twins THROW — so the scene
//      also proves no synchronous host read remains anywhere on the endpoint's send path.
//   2. Every outcome, refusal and history line is byte-identical between the two host shapes the
//      endpoint accepts — the synchronous shape a test host supplies and the asynchronous shape
//      the real host now has — across the endpoint's paths: the admission refusals, the busy
//      check's `queued` answers (a held seat lock, a working status), the queued walk's typed
//      delivery, and the socket leg's delivery.
//   3. A terminal-host read that never answers is killed by the ten-second bound: the send ends
//      `unreachable` after the bound, and the endpoint's probe answered throughout the hang.
//
// Every world is synthetic: a temporary home, checkout and team file, a fake terminal host on
// PATH where a child is needed — never the real one — and no live session, credential file, seat
// or pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { acquireSeatLock, type SeatLock } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import {
  probeDaemonSocket, realDaemonHost, requestDaemon, startSendDaemon,
  type DaemonHost, type DaemonResponse, type SendDaemonHandle,
} from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { claudeBox } from './helpers.ts';

const PROJECT = 'acme';
const SESSION = 'acme';
const FROM = 'lead';
const TO = 'helper';
/** The budget the machine daemon gives its own probe of a hosted send endpoint. */
const PROBE_BUDGET_MS = 2_000;
/** One slow host read in the async-only scene: long enough that a held loop would eat a probe. */
const SLOW_READ_MS = 150;
/** The bound the endpoint puts on one awaited host read (`HOST_READ_TIMEOUT_MS` in the product). */
const HOST_READ_BOUND_MS = 10_000;
const RULE = '─'.repeat(30);

let base = '';
let pathBefore: string | undefined;
let logBefore: string | undefined;
const handles: SendDaemonHandle[] = [];
const samplers: Array<ReturnType<typeof setInterval>> = [];
const locks: SeatLock[] = [];

afterEach(async () => {
  for (const sampler of samplers.splice(0)) clearInterval(sampler);
  for (const lock of locks.splice(0)) if ('release' in lock) lock.release();
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* the scene already closed it */ }
  }
  if (pathBefore !== undefined) process.env.PATH = pathBefore;
  pathBefore = undefined;
  if (logBefore === undefined) delete process.env.RHAD_FAKE_LOG;
  else process.env.RHAD_FAKE_LOG = logBefore;
  logBefore = undefined;
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string, order: string, helperExtra = ''): string {
  return `format: 1
project: ${PROJECT}
coordinator: ${FROM}
operator: ${FROM}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${FROM}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${TO}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${helperExtra}${order}`;
}

type World = {
  home: string;
  root: string;
  dir: string;
  team: Extract<ReturnType<typeof loadTeamFile>, { ok: true }>['team'];
};

function setupWorld(order = 'delivery_order: [typed]\n', helperExtra = ''): World {
  const short = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  base = realpathSync(mkdtempSync(join(short, 'rhad-dloop-')));
  const home = join(base, 'home');
  const root = join(base, PROJECT);
  const dir = join(root, '.agents');
  mkdirSync(join(base, 'sockets'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home), order, helperExtra));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { home, root, dir, team: loaded.team };
}

/** The send every scene makes, over the endpoint's own socket — the transport the daemon serves. */
function sendFrame(
  socketPath: string,
  over: Partial<{ to: string; session: string; wait: boolean; timeout_s: number }> = {},
): Promise<DaemonResponse | null> {
  return requestDaemon(socketPath, {
    v: 1, op: 'send', from: FROM, to: over.to ?? TO, body: 'an independent scene body',
    ...(over.session !== undefined ? { session: over.session } : {}),
    ...(over.wait !== undefined ? { wait: over.wait } : {}),
    ...(over.timeout_s !== undefined ? { timeout_s: over.timeout_s } : {}),
  }, 60_000);
}

async function start(world: World, host: DaemonHost, name: string): Promise<string> {
  const socketPath = join(base, `${name}.sock`);
  const started = await startSendDaemon({
    root: world.root, dir: world.dir, team: world.team, host,
    socketPath, lockPath: join(base, `${name}.lock`),
  });
  if (started.kind !== 'serving') throw new Error(`the endpoint did not start: ${started.kind}`);
  handles.push(started.handle);
  return socketPath;
}

/** The in-process loop judge: one wall sample per 10 ms tick. A held loop skips ticks, so the
 *  interval that covers the hold is the evidence; a free loop keeps every sample small. */
function sampleLoop(): number[] {
  const gaps: number[] = [];
  let last = performance.now();
  samplers.push(setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 10));
  return gaps;
}

/** Probes the endpoint at the product budget until the given promise settles; every answer is
 *  recorded with its own latency, so a probe that only answered at its budget shows its ms. */
async function probeWhile<T>(socketPath: string, until: Promise<T>): Promise<{ ok: boolean; ms: number }[]> {
  const probes: { ok: boolean; ms: number }[] = [];
  let settled = false;
  void until.finally(() => { settled = true; });
  while (!settled) {
    const sent = performance.now();
    const ok = await probeDaemonSocket(socketPath, PROBE_BUDGET_MS);
    probes.push({ ok, ms: performance.now() - sent });
    if (!settled) await new Promise((tick) => setTimeout(tick, 25));
  }
  return probes;
}

describe('the send endpoint reads its host off the loop (independent scenes)', () => {
  test('a slow read never holds the loop, and no synchronous host read remains on the send path', async () => {
    // A world the endpoint can answer two ways: a plain send, whose busy check and queued walk
    // read every host surface the fix moved and end at the build's typed-policy refusal; and a
    // waited send, which rides the socket leg (the seat's team-file word and its own hook
    // settings declare it eligible, and the pane's foreground pid holds a socket in the host's
    // sockets dir) and is answered at its own one-second reply window.
    const world = setupWorld('delivery_order: [typed]\n', '    inbound: accept\n');
    const settings = cliHookSettingsPath(world.dir, SESSION, TO);
    if (settings === null) throw new Error('the hook settings path could not be named');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ crossSessionInbound: 'accept' })}\n`);
    writeFileSync(join(base, 'sockets', '222.sock'), '');

    const frames: string[] = [];
    const reads: string[] = [];
    const slow = async <T>(what: string, value: T): Promise<T> => {
      reads.push(what);
      await new Promise((tick) => setTimeout(tick, SLOW_READ_MS));
      return value;
    };
    const host: DaemonHost = {
      // The async reads the endpoint must take: each one slow enough that holding the loop across
      // it would eat a probe outright.
      agents: () => slow('agents', [
        { name: FROM, pane: 'pane-lead' }, { name: TO, pane: 'pane-helper' },
      ]),
      processInfo: () => slow('processInfo', { shell: 111, foreground: [222] }),
      nativeAsync: {
        status: () => slow('status', 'idle'),
        paneText: () => slow('paneText', claudeBox('')),
      },
      // The synchronous twins THROW: any code path still reading a host member in place fails the
      // send here, which is exactly what this scene is here to catch. Actions (typing, waiting)
      // are not reads and stay synchronous members, as the product's own host shape has them.
      native: {
        typeText: () => { throw new Error('nothing is typed in this scene'); },
        pressEnter: () => { throw new Error('nothing is typed in this scene'); },
        status: () => { throw new Error('a synchronous native.status read ran on the send endpoint'); },
        paneText: () => { throw new Error('a synchronous native.paneText read ran on the send endpoint'); },
        wait: async (ms) => { await new Promise((tick) => setTimeout(tick, ms)); },
      } satisfies NativePane,
      socketsDir: join(base, 'sockets'),
      deliver: async (_socketPath, frame) => { frames.push(frame); return { ok: true }; },
      now: () => new Date('2026-11-04T12:00:00.000Z'),
      home: world.home,
      deliverWaitMs: 50,
      pollReadyMs: 5,
    };

    const socketPath = await start(world, host, 'slow');
    const gaps = sampleLoop();
    const plain = sendFrame(socketPath);
    const plainProbes = await probeWhile(socketPath, plain);
    const plainResponse = await plain;
    const waited = sendFrame(socketPath, { wait: true, timeout_s: 1 });
    const waitedProbes = await probeWhile(socketPath, waited);
    const waitedResponse = await waited;

    // The plain send completed its whole walk — busy check, queued walk, the typed policy's
    // refusal — and the waited send dialed the socket leg and was answered at its window.
    expect(plainResponse?.ok).toBe(false);
    if (plainResponse?.ok !== false) return;
    expect(plainResponse.outcome).toBe('unreachable');
    expect(String(plainResponse.detail)).toContain("typing into a seat's pane is never a delivery");
    expect(waitedResponse?.ok).toBe(false);
    if (waitedResponse?.ok !== false) return;
    expect(waitedResponse.outcome).toBe('timeout');
    expect(String(waitedResponse.detail)).toContain('no reply within 1s');
    expect(frames.length).toBe(1);
    // Every host read was the async seam, and enough of them ran to hold the loop had they been
    // taken in place.
    expect(reads.filter((what) => what === 'agents').length).toBeGreaterThanOrEqual(3);
    expect(reads.filter((what) => what === 'paneText').length).toBeGreaterThanOrEqual(2);
    expect(reads.includes('status')).toBe(true);
    expect(reads.includes('processInfo')).toBe(true);
    // The loop stayed free: no sampled interval grew toward a read's span, let alone the budget.
    expect(gaps.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...gaps)).toBeLessThan(1_000);
    // The endpoint's own probe answered every time, well inside its budget.
    const probes = [...plainProbes, ...waitedProbes];
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(probes.every((probe) => probe.ok)).toBe(true);
    expect(Math.max(...probes.map((probe) => probe.ms))).toBeLessThan(1_000);
  }, 30_000);

  test('outcomes, refusals and history lines are identical across the two host shapes on every endpoint path', async () => {
    type Case = {
      name: string;
      seatExtra?: string;
      over?: Partial<{ to: string; session: string; wait: boolean; timeout_s: number }>;
      holdLock?: boolean;
      working?: boolean;
      plantSocket?: boolean;
    };
    const cases: Case[] = [
      { name: 'admission-wrong-session', over: { session: 'elsewhere' } },
      { name: 'admission-undeclared-seat', over: { to: 'ghost' } },
      { name: 'busy-held-seat-lock', holdLock: true },
      { name: 'busy-working-status', working: true },
      { name: 'queued-walk-typed' },
      {
        name: 'socket-leg-waited',
        over: { wait: true, timeout_s: 1 },
        seatExtra: '    inbound: accept\n',
        plantSocket: true,
      },
    ];

    /** One host shape: `sync` is every read a value in place with no `nativeAsync` at all — the
     *  shape a test host has always supplied and the endpoint still accepts; `async` is every
     *  read a promise with the pane reads on the `nativeAsync` seam — the real host's new shape.
     *  Both answer the same values; only the seam differs. */
    const makeHost = (
      world: World, working: boolean, shape: 'sync' | 'async', frames: string[],
    ): DaemonHost => {
      const typed: { pane: string; text: string }[] = [];
      const enters: string[] = [];
      const status = (): string => (working || enters.includes('pane-helper') ? 'working' : 'idle');
      const paneText = (): string => claudeBox(enters.includes('pane-helper') ? '' : typed.at(-1)?.text ?? '');
      const native: NativePane = shape === 'sync'
        ? {
            typeText: (_session, pane, text) => { typed.push({ pane, text }); return true; },
            pressEnter: (_session, pane) => { enters.push(pane); return true; },
            status,
            paneText,
            wait: async (ms) => { await new Promise((tick) => setTimeout(tick, ms)); },
          }
        : {
            typeText: (_session, pane, text) => { typed.push({ pane, text }); return true; },
            pressEnter: (_session, pane) => { enters.push(pane); return true; },
            status: () => { throw new Error('the async shape reads status on nativeAsync only'); },
            paneText: () => { throw new Error('the async shape reads paneText on nativeAsync only'); },
            wait: async (ms) => { await new Promise((tick) => setTimeout(tick, ms)); },
          };
      return {
        agents: () => (shape === 'sync'
          ? [{ name: FROM, pane: 'pane-lead' }, { name: TO, pane: 'pane-helper' }]
          : Promise.resolve([{ name: FROM, pane: 'pane-lead' }, { name: TO, pane: 'pane-helper' }])),
        processInfo: () => (shape === 'sync'
          ? { shell: 111, foreground: [222] }
          : Promise.resolve({ shell: 111, foreground: [222] })),
        socketsDir: join(base, 'sockets'),
        deliver: async (_socketPath, frame) => { frames.push(frame); return { ok: true }; },
        native,
        ...(shape === 'async'
          ? { nativeAsync: { status: async () => status(), paneText: async () => paneText() } }
          : {}),
        now: () => new Date('2026-11-04T12:00:00.000Z'),
        home: world.home,
        deliverWaitMs: 50,
        pollReadyMs: 5,
      };
    };

    for (const one of cases) {
      const run = async (shape: 'sync' | 'async'): Promise<{ response: unknown; lines: unknown[]; frames: string[] }> => {
        const world = setupWorld('delivery_order: [typed]\n', one.seatExtra ?? '');
        const worldBase = base;
        if (one.plantSocket === true) {
          // The socket leg's eligibility: the seat's own hook settings declare the inbound word,
          // and the pane's foreground pid has a socket in the host's sockets dir.
          const settings = cliHookSettingsPath(world.dir, SESSION, TO);
          if (settings === null) throw new Error('the hook settings path could not be named');
          mkdirSync(dirname(settings), { recursive: true });
          writeFileSync(settings, `${JSON.stringify({ crossSessionInbound: 'accept' })}\n`);
          writeFileSync(join(base, 'sockets', '222.sock'), '');
        }
        let lock: SeatLock | null = null;
        if (one.holdLock === true) {
          lock = acquireSeatLock(world.dir, SESSION, TO);
          if (!('release' in lock)) throw new Error('the fixture could not hold the seat lock');
          locks.push(lock);
        }
        const frames: string[] = [];
        const host = makeHost(world, one.working === true, shape, frames);
        const socketPath = await start(world, host, `${one.name}-${shape}`);
        const response = await sendFrame(socketPath, one.over);
        const history = readHistory(PROJECT, world.root, world.home);
        const lines = history.ok
          ? history.entries.map(({ from, to, body, outcome, via }) => ({ from, to, body, outcome, via }))
          : [];
        // Per-scene state the next run must not inherit: the lock, the daemon, the world.
        if (lock !== null && 'release' in lock) { lock.release(); locks.splice(locks.indexOf(lock), 1); }
        const handle = handles.pop();
        if (handle !== undefined) await handle.close();
        rmSync(base, { recursive: true, force: true });
        base = '';
        const scrub = (text: string): string => text
          // Words that name this run's own world and records, not the endpoint's answer: the
          // staged drop's path and id, the world's temp folder and its salted store inside it.
          .replaceAll(worldBase, '<base>')
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
          .replace(/team (reply|ack|show) [0-9a-f]{8,}/g, 'team $1 <id>')
          .replace(/acme-[0-9a-f]{8,}/g, 'acme-<store>');
        return { response: response === null ? null : scrub(JSON.stringify(response)), lines, frames: frames.map(scrub) };
      };

      const syncRun = await run('sync');
      const asyncRun = await run('async');
      expect(asyncRun.response).toBe(syncRun.response);
      expect(asyncRun.lines).toEqual(syncRun.lines);
      // The frame a waited send dials embeds the display header the endpoint rendered: the two
      // shapes must render it identically too.
      expect(asyncRun.frames.length).toBe(syncRun.frames.length);
      expect(asyncRun.frames).toEqual(syncRun.frames);
    }
  }, 60_000);

  test('a terminal-host read that never answers is killed by the ten-second bound', async () => {
    const world = setupWorld();
    // A fake terminal host on PATH — never the real one — that logs its call and then sleeps far
    // past the endpoint's bound. The read child's own kill is what must end it.
    mkdirSync(join(base, 'bin'), { recursive: true });
    const log = join(base, 'fake-herdr.log');
    writeFileSync(join(base, 'bin', 'herdr'), `#!/bin/sh
stamp() { ${JSON.stringify(process.execPath)} -e 'process.stdout.write(String(Date.now()))'; }
printf '%s\\t%s\\t%s\\n' "$(stamp)" start "$*" >> "${log}"
sleep 300
`, { mode: 0o755 });
    pathBefore = process.env.PATH;
    process.env.PATH = `${join(base, 'bin')}:${pathBefore ?? ''}`;

    const socketPath = await start(world, { ...realDaemonHost, home: world.home }, 'hung');
    const gaps = sampleLoop();
    const began = performance.now();
    const sent = sendFrame(socketPath);
    const probes = await probeWhile(socketPath, sent);
    const response = await sent;
    const elapsed = performance.now() - began;

    // The read was made, and the bound — not the sleep — ended it: the send answers after the
    // bound's span and nowhere near the fake's three hundred seconds.
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(calls).toContain('agent list');
    expect(response).not.toBeNull();
    expect(response?.ok).toBe(false);
    if (response?.ok !== false) return;
    expect(response.outcome).toBe('unreachable');
    expect(String(response.detail)).toContain('could not be read');
    expect(elapsed).toBeGreaterThanOrEqual(HOST_READ_BOUND_MS - 1_000);
    expect(elapsed).toBeLessThan(30_000);
    // Through the whole hang the endpoint's loop was free and its probe answered.
    expect(gaps.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...gaps)).toBeLessThan(1_000);
    expect(probes.length).toBeGreaterThanOrEqual(3);
    expect(probes.every((probe) => probe.ok)).toBe(true);
  }, 60_000);
});

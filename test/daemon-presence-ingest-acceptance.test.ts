// Independent acceptance for the presence path at the actual source: a runtime's spool folder, the
// daemon's ingester, the log, the projection and the sequenced feed a consumer reads. Every scene
// builds its own temporary state folder and writes records exactly as a stage-call would; no pane,
// screen, socket, CLI home or live team file is touched. The ingester and the readers are the
// product's own entry points, not stand-ins.
//
// A red assertion here is the measured behaviour of this source, not a weakened expectation: the
// comment on each scene names the contract property, and the assertion states that property whole.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRESENCE_FUTURE_SKEW_MS, presenceId, presenceLive, readPresenceLogLine, readPresenceReading,
  type PresenceEvent, type PresenceLogLine, type PresenceState, type PresenceWriterSource,
} from '../src/daemon/presence/contract.ts';
import { createPresenceIngester, type PresenceIngestInput, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { presencePaths, presenceSessionDir, presenceStatusPath, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { readPresenceChannel, readPresenceCurrent, readPresenceTransitions } from '../src/daemon/presence/read.ts';
import { STATE_FILE } from '../src/state.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-7';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';
/** A fixed daemon clock for every scene that does not measure wall time; event instants are
 *  expressed relative to it so ordering and recovery assertions are exact. */
const CLOCK = Date.parse('2026-10-20T03:00:00Z');

function at(secondsAgo: number): string {
  return new Date(CLOCK - secondsAgo * 1000).toISOString();
}

type World = { base: string; stateDir: string; binding: string | null };

let cleanups: Array<() => void | Promise<void>> = [];
function later(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}
afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
  cleanups = [];
});

let revision = 0;
/** Writes the seat-state record the ingester reads a resident seat's binding from. The forced,
 *  increasing mtime makes the ingester's stat cache observe every rewrite even when the byte size
 *  is unchanged (the successor's binding has the same length as the predecessor's). */
function writeSeats(world: World, bindings: Record<string, string | null>, session = SESSION): void {
  const seats: Record<string, unknown> = {};
  for (const [seat, binding] of Object.entries(bindings)) {
    seats[seat] = binding === null ? { stage: 'ready' } : { stage: 'ready', presence_binding: binding };
  }
  const path = join(world.stateDir, STATE_FILE);
  writeFileSync(path, JSON.stringify({ format: 1, sessions: { [session]: { seats, worktrees: {} } } }));
  revision += 1;
  const stamp = new Date(1700000000000 + revision * 1000);
  utimesSync(path, stamp, stamp);
  world.binding = bindings[SEAT] ?? world.binding;
}

function makeWorld(bindings: Record<string, string | null> = { [SEAT]: BINDING }): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-acceptance-')));
  const stateDir = join(base, '.agents');
  mkdirSync(stateDir);
  const world: World = { base, stateDir, binding: bindings[SEAT] ?? null };
  writeSeats(world, bindings);
  later(() => rmSync(base, { recursive: true, force: true }));
  return world;
}

function ingesterFor(world: World, extra: Partial<PresenceIngestInput> = {}): PresenceIngester {
  const ingester = createPresenceIngester({ stateDir: world.stateDir, session: SESSION, ...extra });
  later(async () => {
    if (!ingester.isClosed()) await ingester.close();
  });
  return ingester;
}

function fixedClock(): { now: () => Date; set: (instant: number) => void } {
  let instant = CLOCK;
  return { now: () => new Date(instant), set: (next: number) => { instant = next; } };
}

let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(8, '0');
}

type StageOptions = {
  ts?: string;
  binding?: string;
  source?: PresenceWriterSource;
  raw?: string;
  id?: string;
  seat?: string;
  session?: string;
};

function stage(world: World, event: PresenceEvent, options: StageOptions = {}): { id: string; ts: string } {
  const ts = options.ts ?? new Date().toISOString();
  const id = options.id ?? presenceId(ts, nonce());
  if (id === null) throw new Error('the scene supplied an invalid event instant');
  const staged = stagePresenceRecord(world.stateDir, {
    session: options.session ?? SESSION,
    seat: options.seat ?? SEAT,
    binding: options.binding ?? world.binding ?? BINDING,
    source: options.source ?? 'runtime-hook',
    event,
    ...(options.raw === undefined ? {} : { raw: options.raw }),
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

function pathsOf(world: World, seat = SEAT) {
  const paths = presencePaths(world.stateDir, SESSION, seat);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return paths;
}

function spoolNames(world: World, seat = SEAT): string[] {
  const folder = pathsOf(world, seat).spool;
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

/** Every newline-terminated line, parsed strictly. A scene that expects a readable log calls this
 *  and therefore fails loudly on a fragment instead of silently skipping it. */
function logLines(world: World, seat = SEAT): PresenceLogLine[] {
  const path = pathsOf(world, seat).log;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((text) => text !== '').map((text) => {
    const line = readPresenceLogLine(text);
    if ('why' in line) throw new Error(line.why);
    return line;
  });
}

function logText(world: World, seat = SEAT): string {
  const path = pathsOf(world, seat).log;
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function current(world: World, seat = SEAT) {
  const read = await readPresenceCurrent(world.stateDir, SESSION, seat);
  if (read.kind !== 'ok') throw new Error(`no projection: ${read.kind === 'bad' ? read.why : 'absent'}`);
  return read.value;
}

function projectionText(world: World, seat = SEAT): string {
  return readFileSync(pathsOf(world, seat).current, 'utf8');
}

async function until<T>(read: () => Promise<T | null>, timeoutMs = 1500): Promise<{ value: T; elapsedMs: number }> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== null) return { value, elapsedMs: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error('the projection did not arrive in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A raw spool file, written without the writer's validation, for refusal scenes. */
function plant(world: World, name: string, body: string): void {
  mkdirSync(pathsOf(world).spool, { recursive: true, mode: 0o700 });
  writeFileSync(join(pathsOf(world).spool, name), body, { mode: 0o600 });
}

describe('measured acceptance: a real spool reaches the projection in under a second, no screen', () => {
  test('each state reaches the projection within one second and no terminal tool is run', async () => {
    const world = makeWorld();
    const oldPath = process.env.PATH;
    const bin = join(world.base, 'bin');
    mkdirSync(bin);
    const markers: string[] = [];
    for (const tool of ['herdr', 'tmux', 'screen', 'osascript']) {
      const marker = join(world.base, `${tool}-was-called`);
      markers.push(marker);
      writeFileSync(join(bin, tool), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    }
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    later(() => { process.env.PATH = oldPath; });

    const ingester = ingesterFor(world);
    const timer = setInterval(() => { void ingester.step(); }, 250);
    later(() => { clearInterval(timer); });
    try {
      const sequence: Array<[PresenceEvent, PresenceState, string]> = [
        ['turn-start', 'working', 'UserPromptSubmit'],
        ['turn-end', 'idle', 'Stop'],
        ['human-wait', 'waiting-for-a-person', 'Notification'],
        ['turn-start', 'working', 'UserPromptSubmit'],
        ['session-end', 'gone', 'SessionEnd'],
      ];
      for (const [event, state, raw] of sequence) {
        const staged = stage(world, event, { raw });
        const seen = await until(async () => {
          const read = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
          return read.kind === 'ok' && read.value.id === staged.id ? read.value : null;
        });
        expect(seen.value.state).toBe(state);
        expect(seen.value.event).toBe(event);
        expect(seen.value.source).toBe('runtime-hook');
        expect(seen.value.binding).toBe(BINDING);
        // The projection's `since` is the event's own instant, never the ingest instant.
        expect(seen.value.since).toBe(staged.ts);
        expect(seen.elapsedMs).toBeLessThan(1000);
      }

      const channel = await readPresenceChannel(world.stateDir, SESSION);
      expect(channel.kind).toBe('ok');
      if (channel.kind === 'ok') expect(channel.value.state).toBe('serving');

      const lines = logLines(world);
      expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(lines.map((line) => line.state)).toEqual(sequence.map(([, state]) => state));
      for (const line of lines) {
        const lag = Date.parse(line.observedAt) - Date.parse(line.ts);
        expect(lag).toBeGreaterThanOrEqual(0);
        expect(lag).toBeLessThan(1000);
      }
      expect(spoolNames(world)).toEqual([]);
      for (const marker of markers) expect(existsSync(marker)).toBe(false);
    } finally {
      clearInterval(timer);
      await ingester.close();
    }
  }, 20_000);
});

describe('durable dedupe by every id, not only the newest', () => {
  test('a byte-identical replay of every staged record appends nothing, in this process and the next', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    const staged = [
      stage(world, 'turn-start', { ts: at(60), raw: 'UserPromptSubmit' }),
      stage(world, 'human-wait', { ts: at(50), raw: 'Notification' }),
      stage(world, 'turn-start', { ts: at(40), raw: 'UserPromptSubmit' }),
      stage(world, 'turn-end', { ts: at(30), raw: 'Stop' }),
    ];
    const saved = staged.map(({ id }) => ({
      id, name: `${id}.json`, body: readFileSync(join(pathsOf(world).spool, `${id}.json`), 'utf8'),
    }));
    const first = await ingester.step();
    expect(first.ingested.map((line) => line.id)).toEqual(staged.map(({ id }) => id));
    expect(logLines(world).map((line) => line.seq)).toEqual([1, 2, 3, 4]);
    expect(await current(world)).toMatchObject({ id: staged[3]!.id, state: 'idle', seq: 4 });
    const logAfter = logText(world);
    const projectionAfter = projectionText(world);

    // The whole spool comes back, byte for byte, after every record was consumed.
    for (const entry of saved) plant(world, entry.name, entry.body);
    const replay = await ingester.step();
    expect(replay.ingested).toEqual([]);
    expect(replay.rejected).toEqual([]);
    expect(replay.stale).toEqual([]);
    expect(logText(world)).toBe(logAfter);
    expect(projectionText(world)).toBe(projectionAfter);
    expect(spoolNames(world)).toEqual([]);

    // A restart rebuilds the dedupe set from the log; the replay is still consumed, not appended.
    await ingester.close();
    const next = ingesterFor(world, { now: clock.now });
    for (const entry of saved) plant(world, entry.name, entry.body);
    const afterRestart = await next.step();
    expect(afterRestart.ingested).toEqual([]);
    expect(logText(world)).toBe(logAfter);
    expect(projectionText(world)).toBe(projectionAfter);
    expect(spoolNames(world)).toEqual([]);

    // The feed a consumer walks reports each event exactly once.
    const feed = await readPresenceTransitions({ stateDir: world.stateDir, session: SESSION, seat: SEAT });
    expect(feed.kind).toBe('ok');
    if (feed.kind === 'ok') {
      expect(feed.transitions.map((line) => line.id)).toEqual(staged.map(({ id }) => id));
      expect(feed.nextSeq).toBe(4);
      expect(feed.more).toBe(false);
    }
  });

  test('a line that landed before a crash is consumed on restart without a second line', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    const staged = stage(world, 'turn-start', { ts: at(30) });
    const body = readFileSync(join(pathsOf(world).spool, `${staged.id}.json`), 'utf8');
    await ingester.step();
    const logAfter = logText(world);

    // The crash window the spool's consume-after-fsync recipe leaves: the line is in the log, the
    // spool record was not unlinked, and the projection was not written. A restart must finish the
    // consumption and rebuild the projection, never append the event again.
    plant(world, `${staged.id}.json`, body);
    unlinkSync(pathsOf(world).current);
    await ingester.close();
    const next = ingesterFor(world, { now: clock.now });
    const result = await next.step();
    expect(result.ingested).toEqual([]);
    expect(result.repaired.some((entry) => entry.includes('rebuilt the projection'))).toBe(true);
    expect(logText(world)).toBe(logAfter);
    expect(spoolNames(world)).toEqual([]);
    expect(await current(world)).toMatchObject({ id: staged.id, state: 'working', seq: 1 });
  });
});

describe('crash projection recovery', () => {
  test('a projection deleted after its record was consumed is rebuilt with no spool work at all', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    const staged = stage(world, 'turn-end', { ts: at(20) });
    await ingester.step();
    const logAfter = logText(world);
    unlinkSync(pathsOf(world).current);

    const next = ingesterFor(world, { now: clock.now });
    const result = await next.step();
    expect(result.ingested).toEqual([]);
    expect(result.repaired.some((entry) => entry.includes('rebuilt the projection'))).toBe(true);
    expect(logText(world)).toBe(logAfter);
    expect(await current(world)).toMatchObject({ id: staged.id, state: 'idle', since: staged.ts });
  });

  test('a projection with no log line is removed, never shown as a reading', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-start', { ts: at(20) });
    await ingester.step();
    await ingester.close();
    unlinkSync(pathsOf(world).log);

    const next = ingesterFor(world, { now: clock.now });
    const result = await next.step();
    expect(result.repaired.some((entry) => entry.includes('removed a projection'))).toBe(true);
    expect(existsSync(pathsOf(world).current)).toBe(false);
    expect((await readPresenceCurrent(world.stateDir, SESSION, SEAT)).kind).toBe('absent');
  });
});

describe('the runtime incarnation: predecessor records and a successor behind the clock', () => {
  test('a predecessor record staged after the successor binding cannot move the seat', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-start', { ts: at(60), binding: BINDING });
    await ingester.step();
    expect(await current(world)).toMatchObject({ state: 'working', binding: BINDING });

    writeSeats(world, { [SEAT]: SUCCESSOR });
    const late = stage(world, 'turn-end', { ts: at(50), binding: BINDING });
    const result = await ingester.step();
    expect(result.stale.map((entry) => entry.id)).toEqual([late.id]);
    expect(logLines(world)).toHaveLength(1);
    expect(await current(world)).toMatchObject({ state: 'working', binding: BINDING, seq: 1 });
    expect(readdirSync(pathsOf(world).stale)).toContain(`${late.id}.json`);
  });

  test('a successor whose clock is behind its predecessor becomes the projection', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-start', { ts: at(60), binding: BINDING });
    stage(world, 'turn-end', { ts: at(50), binding: BINDING });
    await ingester.step();
    expect(await current(world)).toMatchObject({ state: 'idle', binding: BINDING, since: at(50) });

    // The seat is relaunched. Its process clock is behind the predecessor's last event: the
    // successor's first turn starts at an instant the predecessor already passed.
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const fresh = stage(world, 'turn-start', { ts: at(52), binding: SUCCESSOR });
    const ingested = await ingester.step();
    expect(ingested.ingested.map((line) => line.id)).toEqual([fresh.id]);
    expect(await current(world)).toMatchObject({ id: fresh.id, state: 'working', binding: SUCCESSOR, since: at(52) });

    // A late predecessor event with a later clock is set aside; it cannot move the successor.
    const late = stage(world, 'human-wait', { ts: at(30), binding: BINDING });
    const stale = await ingester.step();
    expect(stale.stale.map((entry) => entry.id)).toEqual([late.id]);
    expect(await current(world)).toMatchObject({ id: fresh.id, state: 'working', binding: SUCCESSOR });
  });

  test('the successor line is applied, so a consumer advancing on applied lines sees it', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-start', { ts: at(60), binding: BINDING });
    stage(world, 'turn-end', { ts: at(50), binding: BINDING });
    await ingester.step();
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const fresh = stage(world, 'turn-start', { ts: at(52), binding: SUCCESSOR });
    const ingested = await ingester.step();
    const freshLine = ingested.ingested.find((line) => line.id === fresh.id);
    expect(freshLine).toBeDefined();
    expect(freshLine!.applied).toBe(true);
    // The feed carries it with its incarnation, so a consumer can qualify it against the seat's
    // current binding instead of trusting a predecessor's stamp.
    const feed = await readPresenceTransitions({ stateDir: world.stateDir, session: SESSION, seat: SEAT });
    expect(feed.kind).toBe('ok');
    if (feed.kind === 'ok') {
      const successorLines = feed.transitions.filter((line) => line.id === fresh.id);
      expect(successorLines).toHaveLength(1);
      expect(successorLines[0]!.binding).toBe(SUCCESSOR);
      expect(successorLines[0]!.seq).toBe(3);
    }
  });

  test('the rebuild after a restart keeps the successor, not the predecessor with the later clock', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-start', { ts: at(60), binding: BINDING });
    stage(world, 'turn-end', { ts: at(50), binding: BINDING });
    await ingester.step();
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const fresh = stage(world, 'turn-start', { ts: at(52), binding: SUCCESSOR });
    await ingester.step();

    // The rebuild after a restart reads the same order: the successor's earlier instant is still
    // the current incarnation's state, not the predecessor's later one.
    await ingester.close();
    const next = ingesterFor(world, { now: clock.now });
    const rebuilt = await next.step();
    expect(rebuilt.ingested).toEqual([]);
    expect(await current(world)).toMatchObject({ id: fresh.id, state: 'working', binding: SUCCESSOR, since: at(52) });
    const channel = await readPresenceChannel(world.stateDir, SESSION);
    expect(channel.kind).toBe('ok');
    if (channel.kind === 'ok') expect(channel.value.state).toBe('serving');
  });
});

describe('event instants: the future skew, age, and the projection id agreement', () => {
  test('a far-future instant is rejected, a near-future one within the skew is accepted, age is never a refusal', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });

    const far = stage(world, 'turn-start', {
      ts: new Date(CLOCK + PRESENCE_FUTURE_SKEW_MS + 1).toISOString(),
    });
    const rejected = await ingester.step();
    expect(rejected.rejected.map((entry) => entry.id)).toEqual([far.id]);
    expect(rejected.rejected[0]!.why).toContain('future');
    expect(logLines(world)).toEqual([]);
    expect(readdirSync(pathsOf(world).rejected)).toContain(`${far.id}.json`);

    const near = stage(world, 'turn-start', {
      ts: new Date(CLOCK + PRESENCE_FUTURE_SKEW_MS - 1).toISOString(),
    });
    expect((await ingester.step()).ingested.map((line) => line.id)).toEqual([near.id]);
    expect(await current(world)).toMatchObject({ id: near.id, state: 'working', since: near.ts });

    // Twelve hours old is evidence, not an expiry: it is logged for the audit without becoming
    // the projection over the newer event.
    const old = stage(world, 'turn-end', { ts: new Date(CLOCK - 12 * 3600 * 1000).toISOString() });
    const aged = await ingester.step();
    expect(aged.rejected).toEqual([]);
    expect(aged.ingested.map((line) => line.id)).toEqual([old.id]);
    expect(aged.ingested[0]!.applied).toBe(false);
    expect(await current(world)).toMatchObject({ id: near.id, state: 'working' });
  });

  test('the projection reader refuses a since the id does not encode, and the ingester repairs it', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    const staged = stage(world, 'turn-end', { ts: at(20) });
    await ingester.step();
    const good = await current(world);
    expect(good.since).toBe(staged.ts);
    expect(good.id.startsWith(`${good.since}-`)).toBe(true);

    // A projection whose since is the ingest instant is not a reading this build can mean: the id
    // carries the event instant, and a reader that served a different one would report the wrong
    // "since" for the state it shows.
    const wrong = `${JSON.stringify({ ...good, since: good.observedAt })}\n`;
    writeFileSync(pathsOf(world).current, wrong, { mode: 0o600 });
    // A projection is reconciled from the log when an index is loaded, so a restart is what
    // repairs a projection that was replaced under a loaded index.
    await ingester.close();
    const next = ingesterFor(world, { now: clock.now });
    const rebuilt = await next.step();
    expect(rebuilt.repaired.some((entry) => entry.includes('rebuilt the projection'))).toBe(true);
    expect((await current(world)).since).toBe(staged.ts);

    // The pure reader, with no ingester to repair it, must refuse that projection whole.
    writeFileSync(pathsOf(world).current, wrong, { mode: 0o600 });
    expect(readPresenceReading(wrong).kind).toBe('bad');
    expect((await readPresenceCurrent(world.stateDir, SESSION, SEAT)).kind).toBe('bad');
  });
});

describe('liveness is qualified by incarnation and channel, never by elapsed time', () => {
  test('a long-idle reading from the current incarnation stays live across an hour of empty steps', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    stage(world, 'turn-end', { ts: new Date(CLOCK - 12 * 3600 * 1000).toISOString() });
    await ingester.step();
    const reading = await current(world);
    expect(reading.state).toBe('idle');
    expect(presenceLive(reading, BINDING, true)).toBe(true);

    // Six hours pass with no event. The projection is neither rewritten nor aged out.
    const projectionBefore = projectionText(world);
    clock.set(CLOCK + 6 * 3600 * 1000);
    for (let index = 0; index < 4; index += 1) await ingester.step();
    expect(projectionText(world)).toBe(projectionBefore);
    expect(presenceLive(await current(world), BINDING, true)).toBe(true);

    // The same bytes are last-known under a predecessor's binding or an unhealthy channel.
    expect(presenceLive(reading, SUCCESSOR, true)).toBe(false);
    expect(presenceLive(reading, null, true)).toBe(false);
    expect(presenceLive(reading, BINDING, false)).toBe(false);
  });
});

describe('close quiesces', () => {
  test('close awaits the in-flight step, and no append or spool consumption follows it', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world, { now: fixedClock().now });
    const staged = Array.from({ length: 120 }, (_, index) => stage(world, 'turn-start', { ts: at(300 - index) }));

    const running = ingester.step();
    const second = ingester.step();
    expect(second).toBe(running);
    // Let the step reach its append loop, then close over it (bounded, so a failed step cannot
    // wedge the scene).
    const logPath = pathsOf(world).log;
    const deadline = Date.now() + 10_000;
    while (!existsSync(logPath) || readFileSync(logPath, 'utf8').split('\n').length < 3) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let stepSettledAt = 0;
    void running.then(() => { stepSettledAt = Date.now(); });
    const closed = ingester.close();
    await closed;
    const closedAt = Date.now();
    // Close resolved only after the step had settled: the in-flight write was awaited, not raced.
    expect(stepSettledAt).toBeGreaterThan(0);
    expect(stepSettledAt).toBeLessThanOrEqual(closedAt);

    const result = await running;
    const lines = logLines(world);
    const spool = spoolNames(world);
    const loggedIds = new Set(lines.map((line) => line.id));
    const spooledIds = new Set(spool.map((name) => name.replace(/\.json$/, '')));
    // Every staged record is in exactly one place: the log (consumed) or the spool (not started).
    expect(loggedIds.size + spooledIds.size).toBe(staged.length);
    expect([...loggedIds].filter((id) => spooledIds.has(id))).toEqual([]);
    expect(result.ingested.length).toBe(loggedIds.size);
    expect(new Set(result.ingested.map((line) => line.id))).toEqual(loggedIds);

    // After close: a new step refuses, the log does not grow and the new record stays spooled.
    const before = logText(world);
    const late = stage(world, 'turn-end');
    const refused = await ingester.step();
    expect(refused.closed).toBe(true);
    expect(refused.ingested).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logText(world)).toBe(before);
    expect(spoolNames(world)).toContain(`${late.id}.json`);
    const channel = await readPresenceChannel(world.stateDir, SESSION);
    expect(channel.kind).toBe('ok');
    if (channel.kind === 'ok') {
      expect(channel.value.state).toBe('stopped');
      expect(channel.value.stoppedAt).not.toBeNull();
    }
  });

  test('a route with no presence seat creates no presence tree, even when closed', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world, { now: fixedClock().now });
    expect((await ingester.step()).ingested).toEqual([]);
    await ingester.close();
    const sessionDir = presenceSessionDir(world.stateDir, SESSION);
    expect(sessionDir).not.toBeNull();
    expect(existsSync(sessionDir!)).toBe(false);
    expect(presenceStatusPath(world.stateDir, SESSION)).not.toBeNull();
    expect(existsSync(presenceStatusPath(world.stateDir, SESSION)!)).toBe(false);
    expect((await readPresenceCurrent(world.stateDir, SESSION, SEAT)).kind).toBe('absent');
    expect((await readPresenceChannel(world.stateDir, SESSION)).kind).toBe('absent');
  });
});

describe('the sequenced feed a consumer reads', () => {
  test('a working to idle pair between two beats is delivered as two ordered transitions, and only applied lines advance it', async () => {
    const world = makeWorld();
    const clock = fixedClock();
    const ingester = ingesterFor(world, { now: clock.now });
    const working = stage(world, 'turn-start', { ts: at(20), raw: 'UserPromptSubmit' });
    const idle = stage(world, 'turn-end', { ts: at(10), raw: 'Stop' });
    // One bounded batch sees both events, so no consumer beat falls between the pair.
    const step = await ingester.step();
    expect(step.ingested.map((line) => line.id)).toEqual([working.id, idle.id]);

    const feed = await readPresenceTransitions({ stateDir: world.stateDir, session: SESSION, seat: SEAT });
    expect(feed.kind).toBe('ok');
    if (feed.kind !== 'ok') return;
    expect(feed.transitions.map((line) => [line.id, line.state, line.seq, line.applied])).toEqual([
      [working.id, 'working', 1, true],
      [idle.id, 'idle', 2, true],
    ]);
    for (const line of feed.transitions) expect(line.binding).toBe(BINDING);
    expect(feed.more).toBe(false);

    // An older event that arrives after both is in the log for the audit, applied false, so a
    // consumer advancing activity on applied lines is not moved backwards.
    const older = stage(world, 'session-end', { ts: at(30) });
    const late = await ingester.step();
    expect(late.ingested.map((line) => [line.id, line.applied])).toEqual([[older.id, false]]);
    const tail = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT,
      afterSeq: feed.nextSeq, afterOffset: feed.nextOffset,
    });
    expect(tail.kind).toBe('ok');
    if (tail.kind === 'ok') {
      expect(tail.transitions.map((line) => [line.id, line.applied])).toEqual([[older.id, false]]);
      expect(tail.more).toBe(false);
    }
  });
});

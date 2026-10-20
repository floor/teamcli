// The daemon's presence ingester against a synthetic world: a temporary project state folder, a
// team state file with one (or two) seats, and spool records written exactly as a runtime hook
// would write them. Every scene is local; no live CLI home, pane, socket or screen is touched.
//
// The first test is the measured acceptance the task asked for: with the driver's 250 ms beat, each
// of the four states reaches the projection in under a second, the log is ordered and the ingest
// lag is visible, while a fake `herdr` on PATH that would leave a marker is never run.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRESENCE_STATE_OF, presenceId, readPresenceLogLine,
  type PresenceEvent, type PresenceLogLine, type PresenceState, type PresenceWriterSource,
} from '../src/daemon/presence/contract.ts';
import {
  createPresenceIngester, type PresenceIngestInput, type PresenceIngester,
} from '../src/daemon/presence/ingest.ts';
import {
  presencePaths, presenceSessionDir, presenceStatusPath, stagePresenceRecord,
} from '../src/daemon/presence/spool.ts';
import {
  readPresenceChannel, readPresenceCurrent, readPresenceTransitions,
} from '../src/daemon/presence/read.ts';
import { STATE_FILE } from '../src/state.ts';

const SESSION = 'teamcli';
const SEAT = 'builder-4';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';

type World = {
  base: string;
  stateDir: string;
  binding: string | null;
};

let cleanups: Array<() => void | Promise<void>> = [];
function later(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}
afterEach(async () => {
  const fns = cleanups.reverse();
  cleanups = [];
  for (const fn of fns) {
    try { await fn(); } catch { /* one failed cleanup must not hide another */ }
  }
});

let revision = 0;
/** Writes the team state record the ingester reads a seat's binding from. The forced, increasing
 *  mtime makes the ingester's stat cache observe every rewrite even when the bytes have one size. */
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-presence-')));
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
  if (id === null) throw new Error('the test supplied an invalid event instant');
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
  if (paths === null) throw new Error('the test seat cannot name a presence folder');
  return paths;
}

function spoolNames(world: World, seat = SEAT): string[] {
  const folder = pathsOf(world, seat).spool;
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function logLines(world: World, seat = SEAT): PresenceLogLine[] {
  const path = pathsOf(world, seat).log;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((text) => text !== '').map((text) => {
    const line = readPresenceLogLine(text);
    if ('why' in line) throw new Error(line.why);
    return line;
  });
}

async function current(world: World, seat = SEAT) {
  const read = await readPresenceCurrent(world.stateDir, SESSION, seat);
  if (read.kind !== 'ok') throw new Error(`no projection: ${read.kind === 'bad' ? read.why : 'absent'}`);
  return read.value;
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

function past(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/** A raw spool file, written without the writer's validation, for refusal scenes. */
function plant(world: World, name: string, body: string): void {
  mkdirSync(pathsOf(world).spool, { recursive: true, mode: 0o700 });
  writeFileSync(join(pathsOf(world).spool, name), body, { mode: 0o600 });
}

describe('measured acceptance: four states from synthetic hook records', () => {
  test('each state reaches the projection within one second and no screen read happens', async () => {
    const world = makeWorld();
    const oldPath = process.env.PATH;
    const marker = join(world.base, 'herdr-was-called');
    const bin = join(world.base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'herdr'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    later(() => { process.env.PATH = oldPath; });

    const ingester = ingesterFor(world);
    const timer = setInterval(() => { void ingester.step(); }, 250);
    later(() => { clearInterval(timer); });
    try {
      const sequence: Array<[PresenceEvent, PresenceState, string]> = [
        ['turn-start', 'working', 'UserPromptSubmit'],
        ['human-wait', 'waiting-for-a-person', 'Notification'],
        ['turn-start', 'working', 'UserPromptSubmit'],
        ['turn-end', 'idle', 'Stop'],
        ['session-end', 'gone', 'SessionEnd'],
      ];
      for (const [event, state, raw] of sequence) {
        const staged = stage(world, event, { raw });
        const seen = await until(async () => {
          const read = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
          return read.kind === 'ok' && read.value.id === staged.id ? read.value : null;
        });
        expect(seen.value.state).toBe(state);
        expect(seen.value.source).toBe('runtime-hook');
        expect(seen.value.event).toBe(event);
        expect(seen.value.binding).toBe(BINDING);
        expect(seen.value.since).toBe(staged.ts);
        expect(seen.elapsedMs).toBeLessThan(1000);
      }

      const channel = await readPresenceChannel(world.stateDir, SESSION);
      expect(channel.kind).toBe('ok');
      if (channel.kind === 'ok') expect(channel.value.state).toBe('serving');

      const lines = logLines(world);
      expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(lines.map((line) => line.state)).toEqual([
        'working', 'waiting-for-a-person', 'working', 'idle', 'gone',
      ]);
      expect(lines.map((line) => line.event)).toEqual(sequence.map(([event]) => event));
      for (const line of lines) {
        expect(Date.parse(line.observedAt) - Date.parse(line.ts)).toBeLessThan(1000);
      }
      expect(spoolNames(world)).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      clearInterval(timer);
      await ingester.close();
    }
    const stopped = await readPresenceChannel(world.stateDir, SESSION);
    expect(stopped.kind).toBe('ok');
    if (stopped.kind === 'ok') {
      expect(stopped.value.state).toBe('stopped');
      expect(stopped.value.stoppedAt).not.toBeNull();
    }
  }, 15_000);

  test('a state stands without new events: no expiry and no rewrite on an empty step', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-end');
    const first = await ingester.step();
    expect(first.ingested.map((line) => line.id)).toEqual([staged.id]);
    const before = await current(world);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const empty = await ingester.step();
    expect(empty.ingested).toEqual([]);
    const after = await current(world);
    expect(after).toEqual(before);
    expect(after.state).toBe('idle');
    expect(after.seq).toBe(1);
  });
});

describe('durable dedupe and recovery', () => {
  test('an old replay after a newer event never appends twice, in this process or the next', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const first = stage(world, 'turn-start', { ts: past(20) });
    expect((await ingester.step()).ingested.map((line) => line.id)).toEqual([first.id]);
    const second = stage(world, 'turn-end', { ts: past(10) });
    expect((await ingester.step()).ingested.map((line) => line.id)).toEqual([second.id]);
    expect(await current(world)).toMatchObject({ id: second.id, state: 'idle', seq: 2 });

    // The first event reappears after the newer one was applied.
    stage(world, 'turn-start', { ts: first.ts, id: first.id });
    const replay = await ingester.step();
    expect(replay.ingested).toEqual([]);
    expect(replay.rejected).toEqual([]);
    expect(logLines(world).map((line) => line.id)).toEqual([first.id, second.id]);
    expect(await current(world)).toMatchObject({ id: second.id, state: 'idle', seq: 2 });

    // A restart loads every id in the log, not only the last one.
    await ingester.close();
    const next = ingesterFor(world);
    stage(world, 'turn-start', { ts: first.ts, id: first.id });
    expect((await next.step()).ingested).toEqual([]);
    expect(logLines(world)).toHaveLength(2);
    expect(await current(world)).toMatchObject({ id: second.id, state: 'idle' });
    expect(spoolNames(world)).toEqual([]);
  });

  test('a projection deleted after its record was consumed is rebuilt from the log on restart', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start', { ts: past(5) });
    await ingester.step();
    await ingester.close();
    unlinkSync(pathsOf(world).current);
    const next = ingesterFor(world);
    const result = await next.step();
    expect(result.repaired.some((entry) => entry.includes('rebuilt the projection'))).toBe(true);
    expect(await current(world)).toMatchObject({ id: staged.id, state: 'working', seq: 1 });
  });

  test('a projection with no log line is removed rather than shown', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(5) });
    await ingester.step();
    await ingester.close();
    unlinkSync(pathsOf(world).log);
    const next = ingesterFor(world);
    const result = await next.step();
    expect(result.repaired.some((entry) => entry.includes('removed a projection'))).toBe(true);
    expect(existsSync(pathsOf(world).current)).toBe(false);
    const read = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
    expect(read.kind).toBe('absent');
  });

  test('an incomplete trailing log line is truncated before the next append', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const first = stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    const second = stage(world, 'turn-end', { ts: past(9) });
    await ingester.step();
    await ingester.close();
    const log = pathsOf(world).log;
    writeFileSync(log, `${readFileSync(log, 'utf8')}{"v":1,`);
    const next = ingesterFor(world);
    const result = await next.step();
    expect(result.repaired.some((entry) => entry.includes('truncated an incomplete'))).toBe(true);
    expect(logLines(world).map((line) => line.id)).toEqual([first.id, second.id]);
    const third = stage(world, 'turn-end', { ts: past(1) });
    const appended = await next.step();
    expect(appended.ingested.map((line) => line.id)).toEqual([third.id]);
    expect(appended.ingested[0]!.seq).toBe(3);
    expect(readFileSync(log, 'utf8').endsWith('\n')).toBe(true);
  });

  test('a structurally corrupt log is faulted, the channel says failed, and the spool is untouched', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    await ingester.close();
    const log = pathsOf(world).log;
    writeFileSync(log, `${readFileSync(log, 'utf8')}not a presence line\n`);
    const pending = stage(world, 'turn-end', { ts: past(1) });
    const next = ingesterFor(world);
    const result = await next.step();
    expect(result.errors.some((entry) => entry.why.includes('not a presence line'))).toBe(true);
    expect(spoolNames(world)).toContain(`${pending.id}.json`);
    const channel = await readPresenceChannel(world.stateDir, SESSION);
    expect(channel.kind).toBe('ok');
    if (channel.kind === 'ok') expect(channel.value.state).toBe('failed');
    // A later beat does not retry a structurally corrupt log or consume its spool.
    const again = await next.step();
    expect(again.ingested).toEqual([]);
    expect(spoolNames(world)).toContain(`${pending.id}.json`);
  });

  test('a failed append does not consume the spool record; a later append does', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(20) });
    await ingester.step();
    const log = pathsOf(world).log;
    const kept = readFileSync(log, 'utf8');
    unlinkSync(log);
    mkdirSync(log);
    const pending = stage(world, 'turn-end', { ts: past(10) });
    const failed = await ingester.step();
    expect(failed.ingested).toEqual([]);
    expect(failed.errors.some((entry) => entry.why.includes('append failed'))).toBe(true);
    expect(spoolNames(world)).toContain(`${pending.id}.json`);
    rmdirSync(log);
    writeFileSync(log, kept);
    const recovered = await ingester.step();
    expect(recovered.ingested.map((line) => line.id)).toEqual([pending.id]);
    expect(spoolNames(world)).toEqual([]);
  });

  test('an append whose bytes landed before fsync failed is not appended twice', async () => {
    const world = makeWorld();
    let attempts = 0;
    const ingester = ingesterFor(world, {
      append: async (path, line) => {
        attempts += 1;
        // The write reached the file; the failure is the sync after it. The bytes are durable
        // in the log even though the writer could not report success.
        writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: 'a' });
        if (attempts === 1) throw new Error('fsync failed after the bytes landed');
      },
    });
    const staged = stage(world, 'turn-start', { ts: past(5) });
    const first = await ingester.step();
    expect(first.ingested).toEqual([]);
    expect(first.errors.some((entry) => entry.why.includes('outcome is unknown'))).toBe(true);
    expect(spoolNames(world)).toContain(`${staged.id}.json`);
    expect(logLines(world).map((line) => line.id)).toEqual([staged.id]);

    // The replay finds the id in the durable log: the spool file is consumed, no second line.
    const recovered = await ingester.step();
    expect(recovered.errors).toEqual([]);
    expect(recovered.ingested).toEqual([]);
    expect(logLines(world)).toHaveLength(1);
    expect(logLines(world)[0]!.id).toBe(staged.id);
    expect(spoolNames(world)).toEqual([]);
    expect(await current(world)).toMatchObject({ id: staged.id, seq: 1, binding: BINDING });
  });

  test('a torn append is truncated, then the record is appended exactly once', async () => {
    const world = makeWorld();
    let attempts = 0;
    const ingester = ingesterFor(world, {
      append: async (path, line) => {
        attempts += 1;
        if (attempts === 1) {
          // Half a line, no newline: the crash-mid-append shape.
          writeFileSync(path, JSON.stringify(line).slice(0, 20), { flag: 'a' });
          throw new Error('the write stopped half way');
        }
        writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: 'a' });
      },
    });
    const staged = stage(world, 'turn-start', { ts: past(5) });
    const first = await ingester.step();
    expect(first.ingested).toEqual([]);
    expect(spoolNames(world)).toContain(`${staged.id}.json`);
    const recovered = await ingester.step();
    expect(recovered.repaired.some((entry) => entry.includes('truncated an incomplete'))).toBe(true);
    expect(recovered.ingested.map((line) => line.id)).toEqual([staged.id]);
    const lines = logLines(world);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(staged.id);
    expect(lines[0]!.seq).toBe(1);
    expect(spoolNames(world)).toEqual([]);
  });

  test('an uncertain append stops the seat batch; no later record is appended against the unknown tail', async () => {
    const world = makeWorld();
    let failNext = true;
    const ingester = ingesterFor(world, {
      append: async (path, line) => {
        writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: 'a' });
        if (failNext) {
          failNext = false;
          throw new Error('the sync failed after the bytes landed');
        }
      },
    });
    const first = stage(world, 'turn-start', { ts: past(20) });
    const second = stage(world, 'turn-end', { ts: past(10) });
    const failed = await ingester.step();
    expect(failed.ingested).toEqual([]);
    expect(failed.pending).toBe(true);
    expect(spoolNames(world).sort()).toEqual([`${first.id}.json`, `${second.id}.json`].sort());
    // Only the attempted line is in the log; the second record was never committed against it.
    expect(logLines(world).map((line) => line.id)).toEqual([first.id]);

    const recovered = await ingester.step();
    expect(recovered.ingested.map((line) => line.id)).toEqual([second.id]);
    expect(logLines(world).map((line) => line.id)).toEqual([first.id, second.id]);
    expect(logLines(world).map((line) => line.seq)).toEqual([1, 2]);
    expect(spoolNames(world)).toEqual([]);
  });
});

describe('the runtime incarnation binding', () => {
  test('a predecessor record is set aside; a successor event applies', async () => {
    const world = makeWorld({ [SEAT]: BINDING });
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(20), binding: BINDING });
    await ingester.step();
    expect((await current(world)).state).toBe('working');

    // The seat is relaunched: the managed state now names a new incarnation.
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const late = stage(world, 'turn-end', { ts: past(10), binding: BINDING });
    const result = await ingester.step();
    expect(result.stale.map((entry) => entry.id)).toEqual([late.id]);
    expect(logLines(world)).toHaveLength(1);
    expect(await current(world)).toMatchObject({ state: 'working', binding: BINDING, seq: 1 });
    expect(readdirSync(pathsOf(world).stale)).toContain(`${late.id}.json`);

    const fresh = stage(world, 'turn-start', { ts: past(5), binding: SUCCESSOR });
    const applied = await ingester.step();
    expect(applied.ingested.map((line) => line.id)).toEqual([fresh.id]);
    expect(await current(world)).toMatchObject({ state: 'working', binding: SUCCESSOR, seq: 2 });
  });

  test('a successor with an earlier clock is not gated by a predecessor event that sorts later', async () => {
    const world = makeWorld({ [SEAT]: BINDING });
    const ingester = ingesterFor(world);
    // The predecessor's last event is two seconds old.
    stage(world, 'turn-start', { ts: past(2), binding: BINDING });
    await ingester.step();
    expect(await current(world)).toMatchObject({ binding: BINDING, seq: 1 });

    // The relaunch mints a successor whose clock is ten seconds behind that event. The order of
    // the two incarnations is not comparable: the successor starts from its own projection.
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const earlier = stage(world, 'turn-end', { ts: past(10), binding: SUCCESSOR });
    const applied = await ingester.step();
    expect(applied.ingested.map((line) => line.id)).toEqual([earlier.id]);
    expect(applied.ingested[0]!.applied).toBe(true);
    expect(applied.ingested[0]!.seq).toBe(2);
    expect(await current(world)).toMatchObject({ id: earlier.id, state: 'idle', binding: SUCCESSOR, seq: 2 });

    // A restart rebuilds the same projection: only the current binding's newest applied line.
    await ingester.close();
    const next = ingesterFor(world);
    const restarted = await next.step();
    expect(restarted.errors).toEqual([]);
    expect(await current(world)).toMatchObject({ id: earlier.id, binding: SUCCESSOR, seq: 2 });
  });

  test('a restart before the successor emits keeps the predecessor projection as last-known', async () => {
    const world = makeWorld({ [SEAT]: BINDING });
    const ingester = ingesterFor(world);
    const predecessor = stage(world, 'turn-start', { ts: past(20), binding: BINDING });
    await ingester.step();
    await ingester.close();

    // The successor owns the seat but has not emitted an event: the old projection stays on
    // disk as last-known (the reader sees its binding differ from the state), never as the
    // successor's current reading and never with a fabricated line.
    writeSeats(world, { [SEAT]: SUCCESSOR });
    const next = ingesterFor(world);
    const step = await next.step();
    expect(step.ingested).toEqual([]);
    expect(step.repaired).toEqual([]);
    const read = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.value).toMatchObject({ id: predecessor.id, binding: BINDING, seq: 1 });
      expect(read.value.binding).not.toBe(SUCCESSOR);
    }
  });

  test('a seat with no current binding sets records aside instead of guessing', async () => {
    const world = makeWorld({ [SEAT]: BINDING });
    const ingester = ingesterFor(world);
    writeSeats(world, { [SEAT]: null });
    const staged = stage(world, 'turn-start', { ts: past(5), binding: BINDING });
    const result = await ingester.step();
    expect(result.stale.map((entry) => entry.id)).toEqual([staged.id]);
    expect(logLines(world)).toEqual([]);
    const read = await readPresenceCurrent(world.stateDir, SESSION, SEAT);
    expect(read.kind).toBe('absent');
  });

  test('a malformed state record leaves the spool in place and writes no line', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start', { ts: past(5) });
    writeFileSync(join(world.stateDir, STATE_FILE), '{"format":1,');
    const result = await ingester.step();
    expect(result.errors.some((entry) => entry.why.includes('not JSON'))).toBe(true);
    expect(result.ingested).toEqual([]);
    expect(spoolNames(world)).toContain(`${staged.id}.json`);
  });
});

describe('refusals', () => {
  test('a far-future instant is rejected and cannot pin the projection', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start', {
      ts: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const result = await ingester.step();
    expect(result.rejected.map((entry) => entry.id)).toEqual([staged.id]);
    expect(result.rejected[0]!.why).toContain('future');
    expect(logLines(world)).toEqual([]);
    expect(readdirSync(pathsOf(world).rejected)).toContain(`${staged.id}.json`);
  });

  test('malformed, foreign, terminal-host, misnamed and oversized records are rejected whole', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const ts = past(30);
    const id = presenceId(ts, nonce())!;
    const base = {
      v: 1, id, ts, session: SESSION, seat: SEAT, binding: BINDING,
      source: 'runtime-hook', event: 'turn-start',
    };
    plant(world, 'broken.json', 'this is not json');
    const unknownTs = past(29);
    const unknownEvent = `${presenceId(unknownTs, nonce())!}.json`;
    plant(world, unknownEvent, JSON.stringify({ ...base, ts: unknownTs, id: unknownEvent.slice(0, -5), event: 'thinking' }));
    const terminalTs = past(28);
    const terminal = `${presenceId(terminalTs, nonce())!}.json`;
    plant(world, terminal, JSON.stringify({ ...base, ts: terminalTs, id: terminal.slice(0, -5), source: 'terminal-host' }));
    const foreignTs = past(27);
    const foreign = `${presenceId(foreignTs, nonce())!}.json`;
    plant(world, foreign, JSON.stringify({ ...base, ts: foreignTs, id: foreign.slice(0, -5), session: 'other-team' }));
    const misnamedTs = past(26);
    const misnamedContentId = presenceId(misnamedTs, nonce())!;
    const misnamed = `${presenceId(past(25), nonce())!}.json`;
    plant(world, misnamed, JSON.stringify({ ...base, ts: misnamedTs, id: misnamedContentId }));
    const oversizedTs = past(24);
    const oversized = `${presenceId(oversizedTs, nonce())!}.json`;
    plant(world, oversized, JSON.stringify({ ...base, ts: oversizedTs, id: oversized.slice(0, -5), raw: 'x'.repeat(70 * 1024) }));

    const result = await ingester.step();
    const rejected = new Set(result.rejected.map((entry) => entry.why));
    expect(result.rejected).toHaveLength(6);
    expect(rejected.has('the record is not JSON')).toBe(true);
    expect([...rejected].some((why) => why.includes('no contract event'))).toBe(true);
    expect([...rejected].some((why) => why.includes('not a runtime or daemon source'))).toBe(true);
    expect([...rejected].some((why) => why.includes('another session or seat'))).toBe(true);
    expect([...rejected].some((why) => why.includes('name is not the record id'))).toBe(true);
    expect([...rejected].some((why) => why.includes('larger than'))).toBe(true);
    expect(logLines(world)).toEqual([]);
    expect(spoolNames(world)).toEqual([]);
    expect(readdirSync(pathsOf(world).rejected)).toHaveLength(6);
  });
});

describe('bounded work per step', () => {
  test('maxRecords bounds one step, and the next step continues where it stopped', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world, { maxRecords: 2 });
    const staged = [
      stage(world, 'turn-start', { ts: past(50) }),
      stage(world, 'turn-end', { ts: past(40) }),
      stage(world, 'turn-start', { ts: past(30) }),
      stage(world, 'human-wait', { ts: past(20) }),
      stage(world, 'turn-end', { ts: past(10) }),
    ];
    const first = await ingester.step();
    expect(first.ingested.map((line) => line.id)).toEqual(staged.slice(0, 2).map((entry) => entry.id));
    expect(first.pending).toBe(true);
    expect(spoolNames(world)).toHaveLength(3);
    const second = await ingester.step();
    expect(second.ingested.map((line) => line.id)).toEqual(staged.slice(2, 4).map((entry) => entry.id));
    expect(spoolNames(world)).toHaveLength(1);
    const third = await ingester.step();
    expect(third.ingested.map((line) => line.id)).toEqual([staged[4]!.id]);
    expect(spoolNames(world)).toEqual([]);
    const idle = await ingester.step();
    expect(idle.ingested).toEqual([]);
    expect(idle.pending).toBe(false);
    expect(logLines(world).map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('seats advance independently: one seat per bounded step, rotating', async () => {
    const other = 'reviewer-2';
    const world = makeWorld({ [SEAT]: BINDING, [other]: SUCCESSOR });
    const ingester = ingesterFor(world, { maxRecords: 1 });
    stage(world, 'turn-start', { ts: past(20) });
    stage(world, 'turn-start', { ts: past(10), seat: other, binding: SUCCESSOR });
    await ingester.step();
    await ingester.step();
    expect(logLines(world)).toHaveLength(1);
    expect(logLines(world, other)).toHaveLength(1);
    expect(spoolNames(world)).toEqual([]);
    expect(spoolNames(world, other)).toEqual([]);
  });
});

describe('no spool, the first spool, and close', () => {
  test('a seat with no spool folder stays absent: nothing is created for it', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const result = await ingester.step();
    expect(result.ingested).toEqual([]);
    const sessionDir = presenceSessionDir(world.stateDir, SESSION);
    expect(sessionDir).not.toBeNull();
    expect(existsSync(sessionDir!)).toBe(false);
    expect(existsSync(presenceStatusPath(world.stateDir, SESSION)!)).toBe(false);
    await ingester.close();
    expect(existsSync(presenceStatusPath(world.stateDir, SESSION)!)).toBe(false);
    expect((await readPresenceCurrent(world.stateDir, SESSION, SEAT)).kind).toBe('absent');
    expect((await readPresenceChannel(world.stateDir, SESSION)).kind).toBe('absent');
  });

  test('the first valid spool permits the ingester to create the log, projection and channel', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start');
    await ingester.step();
    expect(existsSync(pathsOf(world).log)).toBe(true);
    expect(existsSync(pathsOf(world).current)).toBe(true);
    expect(existsSync(presenceStatusPath(world.stateDir, SESSION)!)).toBe(true);
    expect(await current(world)).toMatchObject({ id: staged.id, state: 'working' });
    const channel = await readPresenceChannel(world.stateDir, SESSION);
    expect(channel.kind).toBe('ok');
    if (channel.kind === 'ok') expect(channel.value.state).toBe('serving');
  });

  test('close awaits the in-flight step, writes stopped, and refuses every later write', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    for (let index = 0; index < 8; index += 1) stage(world, 'turn-start', { ts: past(40 - index) });
    const running = ingester.step();
    const closed = ingester.close();
    await expect(closed).resolves.toEqual({ quiesced: true });
    await running;
    expect(ingester.isClosed()).toBe(true);
    const channel = await readPresenceChannel(world.stateDir, SESSION);
    expect(channel.kind).toBe('ok');
    if (channel.kind === 'ok') expect(channel.value.state).toBe('stopped');
    const before = logLines(world).length;
    const late = stage(world, 'turn-end');
    const refused = await ingester.step();
    expect(refused.closed).toBe(true);
    expect(refused.ingested).toEqual([]);
    expect(logLines(world)).toHaveLength(before);
    expect(spoolNames(world)).toContain(`${late.id}.json`);
  });
});

describe('the sequenced transitions a 5-second consumer reads', () => {
  test('bounded batches, resume by (seq, offset), and no regression on an older event', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = [
      stage(world, 'turn-start', { ts: past(30) }),
      stage(world, 'turn-end', { ts: past(20) }),
      stage(world, 'turn-start', { ts: past(10) }),
    ];
    await ingester.step();
    // An older event is logged for the audit but never becomes the projection.
    stage(world, 'session-end', { ts: past(40) });
    const older = await ingester.step();
    expect(older.ingested).toHaveLength(1);
    expect(await current(world)).toMatchObject({ id: staged[2]!.id, state: 'working', seq: 3 });
    expect(older.ingested[0]!.applied).toBe(false);

    const first = await readPresenceTransitions({ stateDir: world.stateDir, session: SESSION, seat: SEAT, maxRecords: 2 });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.transitions.map((line) => line.id)).toEqual([staged[0]!.id, staged[1]!.id]);
    expect(first.nextSeq).toBe(2);
    expect(first.more).toBe(true);

    const second = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT,
      afterSeq: first.nextSeq, afterOffset: first.nextOffset, maxRecords: 1,
    });
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.transitions.map((line) => line.id)).toEqual([staged[2]!.id]);
    expect(second.more).toBe(true); // the older fourth line is still complete and unread

    const third = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT,
      afterSeq: second.nextSeq, afterOffset: second.nextOffset,
    });
    expect(third.kind).toBe('ok');
    if (third.kind !== 'ok') return;
    expect(third.transitions.map((line) => line.seq)).toEqual([4]);
    expect(third.transitions[0]!.applied).toBe(false);
    expect(third.more).toBe(false);

    // afterSeq skips without needing a matching offset, and every line carries binding+seq.
    const skipped = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT, afterSeq: 1, maxRecords: 2,
    });
    expect(skipped.kind).toBe('ok');
    if (skipped.kind !== 'ok') return;
    expect(skipped.transitions.map((line) => line.seq)).toEqual([2, 3]);
    for (const line of skipped.transitions) expect(line.binding).toBe(BINDING);
  });

  test('an incomplete trailing line is left unconsumed until it is complete', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    const log = pathsOf(world).log;
    const complete = readFileSync(log, 'utf8');
    const baseLine = logLines(world)[0]!;
    const nextTs = past(5);
    const nextLine: PresenceLogLine = {
      ...baseLine, seq: 2, id: presenceId(nextTs, nonce())!, ts: nextTs, observedAt: nextTs,
      event: 'turn-end', state: PRESENCE_STATE_OF['turn-end'],
    };
    writeFileSync(log, `${complete}${JSON.stringify(nextLine).slice(0, 40)}`);
    const partial = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT, afterSeq: 1,
    });
    expect(partial.kind).toBe('ok');
    if (partial.kind !== 'ok') return;
    expect(partial.transitions).toEqual([]);
    expect(partial.more).toBe(false);
    expect(partial.nextOffset).toBe(Buffer.byteLength(complete));

    writeFileSync(log, `${complete}${JSON.stringify(nextLine)}`);
    const noNewline = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT, afterSeq: 1,
    });
    expect(noNewline.kind).toBe('ok');
    if (noNewline.kind !== 'ok') return;
    expect(noNewline.transitions).toEqual([]);

    writeFileSync(log, `${complete}${JSON.stringify(nextLine)}\n`);
    const done = await readPresenceTransitions({
      stateDir: world.stateDir, session: SESSION, seat: SEAT, afterSeq: 1,
    });
    expect(done.kind).toBe('ok');
    if (done.kind !== 'ok') return;
    expect(done.transitions.map((line) => line.id)).toEqual([nextLine.id]);
    expect(done.nextOffset).toBe(Buffer.byteLength(readFileSync(log, 'utf8')));
  });
});

describe('the channel verdict the daemon consumes', () => {
  test('an absent route, and a route with no events, never read healthy', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    expect((await ingester.step()).healthy).toBe(false);
    await ingester.close();
    // The second beat proves it is not a first-step artifact: still no spool, still no projection.
    const next = ingesterFor(world);
    expect((await next.step()).healthy).toBe(false);
  });

  test('a caught-up route with a native projection is healthy, with or without new events', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start', { ts: past(5) });
    const first = await ingester.step();
    expect(first.healthy).toBe(true);
    expect(await current(world)).toMatchObject({ id: staged.id });
    // A state persists without a new event: the next beat is still healthy and ingests nothing.
    const idle = await ingester.step();
    expect(idle.healthy).toBe(true);
    expect(idle.ingested).toEqual([]);
  });

  test('a fatal log fault keeps the verdict false on later quiet steps, not only where it was reported', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(10) });
    await ingester.step();
    await ingester.close();
    const log = pathsOf(world).log;
    writeFileSync(log, `${readFileSync(log, 'utf8')}not a presence line\n`);
    const pending = stage(world, 'turn-end', { ts: past(1) });
    const next = ingesterFor(world);
    const found = await next.step();
    expect(found.healthy).toBe(false);
    expect(found.errors.some((entry) => entry.why.includes('not a presence line'))).toBe(true);
    const quiet = await next.step();
    expect(quiet.errors).toEqual([]);
    expect(quiet.healthy).toBe(false);
    expect(spoolNames(world)).toContain(`${pending.id}.json`);
  });

  test('an uncertain append stays false until the reload consumes the replay', async () => {
    const world = makeWorld();
    let attempts = 0;
    const ingester = ingesterFor(world, {
      append: async (path, line) => {
        attempts += 1;
        writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: 'a' });
        if (attempts === 1) throw new Error('the sync failed after the bytes landed');
      },
    });
    const staged = stage(world, 'turn-start', { ts: past(5) });
    const failed = await ingester.step();
    expect(failed.healthy).toBe(false);
    expect(failed.pending).toBe(true);
    const recovered = await ingester.step();
    expect(recovered.errors).toEqual([]);
    expect(recovered.healthy).toBe(true);
    expect(spoolNames(world)).toEqual([]);
    expect(await current(world)).toMatchObject({ id: staged.id });
  });

  test('a backlog keeps the verdict false until a step has nothing left', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world, { maxRecords: 1 });
    const first = stage(world, 'turn-start', { ts: past(20) });
    const second = stage(world, 'turn-end', { ts: past(10) });
    const one = await ingester.step();
    expect(one.ingested.map((line) => line.id)).toEqual([first.id]);
    expect(one.pending).toBe(true);
    expect(one.healthy).toBe(false);
    const two = await ingester.step();
    expect(two.ingested.map((line) => line.id)).toEqual([second.id]);
    // The batch spent its budget, so caught-up is not yet known either.
    expect(two.healthy).toBe(false);
    const three = await ingester.step();
    expect(three.healthy).toBe(true);
  });

  test('an unreadable seat state is unhealthy until the next state read answers', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    const staged = stage(world, 'turn-start', { ts: past(5) });
    writeFileSync(join(world.stateDir, STATE_FILE), 'not json\n');
    const failed = await ingester.step();
    expect(failed.healthy).toBe(false);
    expect(failed.errors.some((entry) => entry.why.includes('not JSON'))).toBe(true);
    writeSeats(world, { [SEAT]: BINDING });
    const recovered = await ingester.step();
    expect(recovered.ingested.map((line) => line.id)).toEqual([staged.id]);
    expect(recovered.healthy).toBe(true);
  });

  test('a rejected record is refused as before and does not by itself fail health', async () => {
    const world = makeWorld();
    const ingester = ingesterFor(world);
    stage(world, 'turn-start', { ts: past(5) });
    await ingester.step();
    plant(world, 'bad.json', '{"v":1}\n');
    const refused = await ingester.step();
    expect(refused.rejected).toHaveLength(1);
    expect(refused.healthy).toBe(true);
  });
});

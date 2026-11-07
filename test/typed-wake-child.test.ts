// The wake child: the daemon hands one admitted typed wake to a second process, and that process
// owns the walk's outcome — the history line, the trace step and the log line the send no longer
// waits for. These scenes drive `serveWakeChild` directly (its reservation, its live-seat guards,
// its two records) and the one-use token it reads. The walk is the scene's own: no live seat is
// touched and no pane is typed into.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../src/bus/log.ts';
import { machineConfigDir, wakeInheritPath } from '../src/daemon/paths.ts';
import { serveWakeChild, type WakeChildDeps } from '../src/daemon/wake/child.ts';
import { wakeEntryOf } from '../src/daemon/wake/spawn.ts';
import { readWakeInherit, writeWakeInherit, type WakeChildRequest } from '../src/daemon/wake/token.ts';
import { acquireSeatLock } from '../src/launch/seat-lock.ts';
import { readHistory } from '../src/send/history.ts';
import { markWake, reserveWake, wakeMarkAt, wakePath } from '../src/send/wake-marker.ts';
import type { TypedWakeHost, TypedWakeResult } from '../src/send/typed-wake.ts';
import { LOG_FILE } from '../src/state.ts';
import { world, type World } from './send-native-fixtures.ts';

const ID = '0b7c8e0e-3f5a-4e2b-9d1c-2a6f4b8c1d3e';
const LINE = 'Read /t/mail/abc and do that.';
const STAGED_AT = Date.parse('2026-11-05T11:59:59.000Z');
const NOW = new Date('2026-11-05T12:00:00.000Z');
const MS = NOW.getTime() - STAGED_AT;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): World {
  const made = world(['typed'], [{ name: 'muse', role: 'implementer', cli: 'muse', launch: 'muse' }]);
  cleanups.push(made.cleanup);
  return made;
}

/** One staged copy, in a folder of the scene's own, and the request the daemon's token carries. */
function staged(made: World): WakeChildRequest {
  const drops = join(made.dir, 'wake-drops');
  mkdirSync(drops, { recursive: true });
  const dropPath = join(drops, ID);
  writeFileSync(dropPath, 'staged\n', { mode: 0o600 });
  return {
    version: 1,
    id: ID,
    seat: 'muse',
    session: 'acme',
    cli: 'muse',
    line: LINE,
    dropPath,
    dir: made.dir,
    root: made.root,
    project: 'acme',
    home: made.home,
    from: 'owner',
    body: 'hello',
    from_team: 'acme',
    stagedAt: STAGED_AT,
  };
}

function reserve(request: WakeChildRequest): void {
  expect(reserveWake(wakePath(dirname(request.dropPath), request.id), { id: request.id, at: NOW.toISOString(), state: 'reserved' })).toBe(true);
}

const dummyHost: TypedWakeHost = {
  read: () => null,
  type: () => false,
  enter: () => false,
  wait: async () => {},
};

type Call = { pane: string; line: string; cli: string };

/** The child's answers, with the walk it runs recorded. A scene names the walk's result, or any
 *  guard's answer, and nothing else has to exist. */
function deps(overrides: Partial<WakeChildDeps> & { result?: TypedWakeResult } = {}): WakeChildDeps & { calls: Call[] } {
  const calls: Call[] = [];
  const result = overrides.result ?? { delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' };
  return {
    calls,
    agents: () => [{ name: 'muse', pane: 'pane-1' }],
    processes: () => null,
    walk: async (_host, pane, line, cli) => {
      calls.push({ pane, line, cli });
      return result;
    },
    wakeHost: () => dummyHost,
    now: () => NOW,
    ...overrides,
  };
}

function entriesOf(made: World) {
  const read = readHistory('acme', made.root, made.home);
  if (!read.ok) throw new Error(read.reason);
  return read.entries;
}

/** Every event filed under the message id, in the log's own order. */
function stepsOf(made: World) {
  const read = readEvents('acme', made.root, made.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((one) => one.payload).filter((payload) => payload.record_id === ID || payload.record_id.startsWith(`${ID}:`));
}

function logOf(made: World): string {
  const path = join(made.dir, LOG_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('the wake child runs one wake and records what it saw', () => {
  test('a delivered wake marks the reservation sent and writes the history, trace and log lines', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const walked = deps();

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'delivered', reason: 'the working screen showed after 1 Enter' });
    expect(walked.calls).toEqual([{ pane: 'pane-1', line: LINE, cli: 'muse' }]);
    // The reservation becomes the record of what the wake was seen to become.
    expect(wakeMarkAt(wakePath(dirname(request.dropPath), ID))).toEqual({ at: NOW.toISOString(), state: 'sent', evidence: 'typed-wake' });
    const entries = entriesOf(made);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'muse',
      from_team: 'acme',
      body: 'hello',
      id: ID,
      outcome: 'delivered (typed wake)',
      note: 'the working screen showed after 1 Enter',
      ms: MS,
      via: 'typed',
    });
    const steps = stepsOf(made);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: 'leg.tried',
      record_id: `${ID}:leg.tried:typed`,
      session: 'acme',
      from: 'owner',
      to: 'muse',
      via: 'typed',
      outcome: 'delivered',
      ms: MS,
      reason: 'the working screen showed after 1 Enter',
    });
    expect(logOf(made)).toContain('send [owner] muse: delivered (typed wake) (drop 5 characters, typed; the working screen showed after 1 Enter)');
  });

  test('a walk that saw its two times writes both on the trace step, counted from staging', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    // The walk marks on its own clock; the child is the one that knows when the message was
    // staged, so the two times are the marks minus that base, not the raw instants.
    const walked = deps({
      result: {
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: STAGED_AT + 400,
        workingAt: STAGED_AT + 900,
      },
    });

    await serveWakeChild(request, walked);

    const step = stepsOf(made)[0];
    expect(step).toMatchObject({
      kind: 'leg.tried',
      record_id: `${ID}:leg.tried:typed`,
      outcome: 'delivered',
      submit_ms: 400,
      working_ms: 900,
      // The step's own cost still counts the whole walk, not either mark.
      ms: MS,
    });
  });

  test('a walk that does not deliver gives the reservation back and records an unreachable line', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const walked = deps({ result: { delivered: false, typed: true, tries: 1, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' } });

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    // The message keeps its one wake: the reservation is gone, not marked sent.
    expect(existsSync(wakePath(dirname(request.dropPath), ID))).toBe(false);
    const entries = entriesOf(made);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: ID, outcome: 'unreachable', note: 'the box held text other than the line after the line was typed; no Enter was pressed', ms: MS, via: 'typed' });
    expect(stepsOf(made)[0]).toMatchObject({ kind: 'leg.tried', outcome: 'unreachable', reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    // A walk that observed no mark writes no time: the step carries neither field.
    expect(stepsOf(made)[0]?.submit_ms).toBeUndefined();
    expect(stepsOf(made)[0]?.working_ms).toBeUndefined();
    expect(logOf(made)).toContain(`muse: the typed wake did not land (the box held text other than the line after the line was typed; no Enter was pressed); the drop is at ${request.dropPath}`);
  });

  test('a key that went out with an unreadable acknowledgement keeps the reservation', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const reason = 'the screen could not be read and no working screen showed; no further Enter was pressed';
    const walked = deps({ result: { delivered: false, typed: true, tries: 1, reason } });

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason });
    expect(walked.calls).toHaveLength(1);
    const marker = wakePath(dirname(request.dropPath), ID);
    expect(existsSync(marker)).toBe(true);
    expect(wakeMarkAt(marker)?.state).toBe('reserved');
    expect(reserveWake(marker, { id: ID, at: NOW.toISOString(), state: 'reserved' })).toBe(false);
    expect(entriesOf(made)[0]).toMatchObject({ id: ID, outcome: 'unreachable', note: reason, via: 'typed' });
  });

  test('a session that cannot be read refuses before the walk, releases the reservation, and records the reason', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const walked = deps({ agents: () => null });

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason: 'the session "acme" could not be read' });
    expect(walked.calls).toEqual([]);
    expect(existsSync(wakePath(dirname(request.dropPath), ID))).toBe(false);
    expect(entriesOf(made)[0]).toMatchObject({ outcome: 'unreachable', note: 'the session "acme" could not be read', via: 'typed' });
    expect(stepsOf(made)[0]).toMatchObject({ outcome: 'unreachable', reason: 'the session "acme" could not be read' });
  });

  test('a pane back at its shell refuses before the walk', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const walked = deps({ processes: () => ({ shell: 501, foreground: [501] }) });

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason: 'the seat is back at its shell; nothing was typed' });
    expect(walked.calls).toEqual([]);
    expect(entriesOf(made)[0]).toMatchObject({ outcome: 'unreachable', note: 'the seat is back at its shell; nothing was typed' });
  });

  test('a held seat lock refuses before the walk; the next request after the release wakes', async () => {
    const made = scratch();
    const request = staged(made);
    reserve(request);
    const held = acquireSeatLock(request.dir, request.session, request.seat);
    if (!('release' in held)) throw new Error('the scene expected to take the seat lock');
    try {
      const refused = deps();
      const out = await serveWakeChild(request, refused);
      expect(out).toEqual({ outcome: 'failed', reason: `another command holds the seat (pid ${String(process.pid)}); nothing was typed` });
      expect(refused.calls).toEqual([]);
      expect(existsSync(wakePath(dirname(request.dropPath), ID))).toBe(false);
      expect(entriesOf(made)[0]).toMatchObject({ outcome: 'unreachable', note: `another command holds the seat (pid ${String(process.pid)}); nothing was typed` });
    } finally {
      held.release();
    }
    // The lock is gone and a fresh reservation is the message's one wake again.
    reserve(request);
    const walked = deps();
    expect(await serveWakeChild(request, walked)).toEqual({ outcome: 'delivered', reason: 'the working screen showed after 1 Enter' });
    expect(walked.calls).toHaveLength(1);
    expect(entriesOf(made)).toHaveLength(2);
  });
});

describe('the wake child coalesces on the marker a reservation already carries', () => {
  test('a marker already sent is the same wake asked twice: no walk and no second record', async () => {
    const made = scratch();
    const request = staged(made);
    wakeMarkAt(wakePath(dirname(request.dropPath), ID));
    markWake(wakePath(dirname(request.dropPath), ID), { id: ID, at: NOW.toISOString(), state: 'sent', evidence: 'typed-wake' });
    const walked = deps();

    expect(await serveWakeChild(request, walked)).toEqual({ outcome: 'coalesced' });

    expect(walked.calls).toEqual([]);
    expect(entriesOf(made)).toEqual([]);
    expect(stepsOf(made)).toEqual([]);
    expect(logOf(made)).toBe('');
    expect(wakeMarkAt(wakePath(dirname(request.dropPath), ID))?.state).toBe('sent');
  });

  test('a marker the seat already read coalesces the same way', async () => {
    const made = scratch();
    const request = staged(made);
    markWake(wakePath(dirname(request.dropPath), ID), { id: ID, at: NOW.toISOString(), state: 'read' });
    const walked = deps();

    expect(await serveWakeChild(request, walked)).toEqual({ outcome: 'coalesced' });
    expect(walked.calls).toEqual([]);
    expect(entriesOf(made)).toEqual([]);
  });

  test('a child with no reservation types nothing and records the refusal', async () => {
    const made = scratch();
    const request = staged(made);
    const walked = deps();

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason: 'the wake reservation for this id was not found; nothing was typed' });
    expect(walked.calls).toEqual([]);
    expect(existsSync(wakePath(dirname(request.dropPath), ID))).toBe(false);
    expect(entriesOf(made)[0]).toMatchObject({ outcome: 'unreachable', note: 'the wake reservation for this id was not found; nothing was typed' });
  });

  test('a marker that cannot be read is never typed over and never removed', async () => {
    const made = scratch();
    const request = staged(made);
    const marker = wakePath(dirname(request.dropPath), ID);
    writeFileSync(marker, 'not json\n');
    const walked = deps();

    const out = await serveWakeChild(request, walked);

    expect(out).toEqual({ outcome: 'failed', reason: 'the wake reservation could not be read; nothing was typed' });
    expect(walked.calls).toEqual([]);
    expect(readFileSync(marker, 'utf8')).toBe('not json\n');
    expect(entriesOf(made)[0]).toMatchObject({ outcome: 'unreachable', note: 'the wake reservation could not be read; nothing was typed' });
  });
});

describe("the wake token is the child's whole authority", () => {
  test('the daemon writes it 0600 and reading it consumes it', () => {
    const made = scratch();
    const request = staged(made);
    const nonce = writeWakeInherit(request);
    const path = wakeInheritPath(made.home, nonce);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readWakeInherit(made.home, nonce)).toEqual({ kind: 'ok', request });
    // One token starts one wake: the read unlinked it.
    expect(existsSync(path)).toBe(false);
    expect(readWakeInherit(made.home, nonce)).toEqual({ kind: 'refused', why: 'no one-use token names this child' });
  });

  test('a name this program never writes, an unknown format and a missing field all refuse by name', () => {
    const made = scratch();
    const request = staged(made);
    expect(readWakeInherit(made.home, 'not-a-token')).toEqual({ kind: 'refused', why: 'the token name is not one this daemon writes' });
    expect(readWakeInherit(made.home, '../daemon.state.json')).toEqual({ kind: 'refused', why: 'the token name is not one this daemon writes' });
    mkdirSync(machineConfigDir(made.home), { recursive: true, mode: 0o700 });
    const unknown = 'b'.repeat(32);
    writeFileSync(wakeInheritPath(made.home, unknown), `${JSON.stringify({ ...request, version: 2 })}\n`, { mode: 0o600 });
    expect(readWakeInherit(made.home, unknown)).toEqual({ kind: 'refused', why: 'the token names an unknown format' });
    const noSeat = 'c'.repeat(32);
    const rest = { ...request } as Record<string, unknown>;
    delete rest.seat;
    writeFileSync(wakeInheritPath(made.home, noSeat), `${JSON.stringify(rest)}\n`, { mode: 0o600 });
    expect(readWakeInherit(made.home, noSeat)).toEqual({ kind: 'refused', why: 'the token names no seat' });
  });

  test('the spawner resolves the real entry beside it', () => {
    expect(wakeEntryOf()).toBe(fileURLToPath(new URL('../src/daemon/wake/entry.ts', import.meta.url)));
  });
});

// The daemon's held-frame step (src/daemon/presence/held.ts): after a socket delivery the sender
// reported, the step looks at the receiving seat's pane on the presence beat and raises `held`
// when the frame sat at its dialog. The scenes pin the rules the sender no longer keeps:
//   - only this route's own `delivered` + `via: 'socket'` lines are watched, within the window;
//   - a candidate is bound to its signed record (id, seat, session, checkout, signature) and a
//     record the seat already read is never watched;
//   - a look happens only for a seat the session lists exactly once, and a session that cannot be
//     read is retried, never looked at;
//   - the raise writes the `held` history line from the signed record's fields and the socket
//     mark bound to the declaration in force, once per id across daemon restarts;
//   - looks stop at the window, leaving the record unread for the watch's retry.
// A synthetic home and checkout, an injected screen and agent list: no pane host is called and
// no owner session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createPresenceHeld, HELD_FIRST_LOOK_MS, HELD_LAST_LOOK_MS, HELD_LOOK_EVERY_MS,
  type PresenceHeldInput, type PresenceHeldStep,
} from '../src/daemon/presence/held.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { appendHistory, readHistory, type HistoryEntry } from '../src/send/history.ts';
import { heldSocketPath } from '../src/send/inbound.ts';
import {
  recordFile, signReceiptPayload, signRecord, writeReceipt, writeRecord,
  type RecordPayload,
} from '../src/send/record.ts';
import { NOW } from './send-native-fixtures.ts';

const SESSION = 'acme';
const SEAT = 'lead';
const BODY = 'from orchestrator\n\nthe body of the note\n';
const HELD_DIALOG = 'Held message from another session\nPress enter to view';
const CLEAR_BOX = '❯ \n';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

type Scene = {
  root: string;
  dir: string;
  home: string;
  drop: string;
  recordPath: (id: string) => string;
};

function scene(): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-held-')));
  cleanup = () => rmSync(base, { recursive: true, force: true });
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  const drop = join(dir, 'send-drops', SESSION, SEAT);
  mkdirSync(drop, { recursive: true });
  return { root: realpathSync(root), dir, home, drop, recordPath: (id: string) => recordFile(drop, id) };
}

function payloadOf(made: Scene, id: string, patch: Partial<RecordPayload> = {}): RecordPayload {
  return {
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root: made.root,
    session: SESSION,
    at: NOW.toISOString(),
    body: BODY,
    from: 'orchestrator',
    from_id: null,
    rule: 'a synthetic admission',
    thread: id,
    ...patch,
  };
}

/** One signed drop record, written the way a send writes it. */
function recordOf(made: Scene, id: string, patch: Partial<RecordPayload> = {}): void {
  const written = writeRecord(made.drop, signRecord(payloadOf(made, id, patch), made.home));
  if (!written.ok) throw new Error(written.reason);
}

/** The line a non-wait socket delivery appends, the trigger the step watches. */
function deliveredAt(made: Scene, id: string, at: Date, patch: Partial<HistoryEntry> = {}): void {
  const written = appendHistory('acme', made.root, made.home, {
    ts: at.toISOString(),
    from: 'orchestrator',
    to: SEAT,
    body: BODY,
    id,
    outcome: 'delivered',
    via: 'socket',
    thread: id,
    ...patch,
  });
  if (!written.ok) throw new Error(written.reason);
}

/** The receiving seat's generated settings file, carrying the declaration the mark binds to. */
function declareSeat(made: Scene, declaredAt = Date.now() - 60_000): string {
  const path = cliHookSettingsPath(made.dir, SESSION, SEAT);
  if (path === null) throw new Error('the fixture declares no settings path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  utimesSync(path, new Date(declaredAt), new Date(declaredAt));
  return path;
}

type Look = { pane: string; session: string };

function stepOf(made: Scene, options: {
  screen?: (pane: string, session: string) => Promise<string | null>;
  agents?: PresenceHeldInput['agents'];
  seats?: PresenceHeldInput['seats'];
} = {}): { step: PresenceHeldStep; looks: Look[] } {
  const looks: Look[] = [];
  const step = createPresenceHeld({
    stateDir: made.dir,
    project: 'acme',
    root: made.root,
    session: SESSION,
    home: made.home,
    seats: options.seats ?? [{ name: SEAT, launch: 'claude' }],
    screen: async (pane, session) => {
      looks.push({ pane, session });
      return (options.screen ?? (async () => CLEAR_BOX))(pane, session);
    },
    agents: options.agents ?? (async () => [{ name: SEAT, pane: 'fixture-pane-lead' }]),
  });
  return { step, looks };
}

function instant(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe('a socket delivery seen at its dialog', () => {
  test('is raised once from the signed record, and the socket is marked under the declaration in force', async () => {
    const made = scene();
    const id = '3f2a1b4c-0000-4000-8000-000000000001';
    recordOf(made, id);
    deliveredAt(made, id, NOW);
    const settings = declareSeat(made);
    const { step, looks } = stepOf(made, { screen: async () => HELD_DIALOG });

    const at = instant(HELD_FIRST_LOOK_MS + 10);
    const first = await step(at);

    expect(first.failed).toBeNull();
    expect(first.raised).toEqual([id]);
    expect(first.watching).toBe(0);
    expect(looks).toEqual([{ pane: 'fixture-pane-lead', session: SESSION }]);

    // The line's own fields are the signed record's; only the outcome and the instant are the
    // step's, and the instant is when the dialog was seen.
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.find((entry) => entry.id === id && entry.outcome === 'held')).toMatchObject({
      ts: at.toISOString(),
      from: 'orchestrator',
      to: SEAT,
      body: BODY,
      id,
      outcome: 'held',
      via: 'socket',
      thread: id,
    });

    // The mark binds the hold to the declaration the sender will compare: the same file and its
    // own mtime, so only a rewritten declaration re-confirms the word.
    const mark = JSON.parse(readFileSync(heldSocketPath(made.dir, SESSION, SEAT), 'utf8')) as {
      at: string; declaredAt: number | null; source: string | null;
    };
    expect(mark.at).toBe(at.toISOString());
    expect(mark.source).toBe(settings);
    expect(typeof mark.declaredAt).toBe('number');

    // Raised once: a later beat looks at nothing and writes nothing.
    const again = await step(instant(HELD_FIRST_LOOK_MS + 500));
    expect(again.raised).toEqual([]);
    expect(again.watching).toBe(0);
    expect(looks).toHaveLength(1);
  });

  test('is not raised twice by a daemon that started after the hold', async () => {
    const made = scene();
    const id = '3f2a1b4c-0000-4000-8000-000000000002';
    recordOf(made, id);
    deliveredAt(made, id, NOW);
    declareSeat(made);
    const held = appendHistory('acme', made.root, made.home, {
      ts: instant(200).toISOString(), from: 'orchestrator', to: SEAT, body: BODY, id, outcome: 'held', via: 'socket', thread: id,
    });
    expect(held.ok).toBe(true);

    // A fresh step instance is a restarted daemon: its memory is empty, the log is not.
    const { step, looks } = stepOf(made, { screen: async () => HELD_DIALOG });
    const result = await step(instant(400));

    expect(result.raised).toEqual([]);
    expect(result.watching).toBe(0);
    expect(looks).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.filter((entry) => entry.id === id && entry.outcome === 'held')).toHaveLength(1);
  });
});

describe('what is never watched', () => {
  test('a frame the seat already read, whatever the box shows', async () => {
    const made = scene();
    const id = '3f2a1b4c-0000-4000-8000-000000000003';
    recordOf(made, id);
    deliveredAt(made, id, NOW);
    const receipt = signReceiptPayload(
      { kind: 'receipt', status: 'read', id, to: SEAT, root: made.root, session: SESSION, at: NOW.toISOString() },
      made.home,
    );
    const written = writeReceipt(made.drop, receipt, made.home);
    expect(written.ok).toBe(true);

    const { step, looks } = stepOf(made, { screen: async () => HELD_DIALOG });
    const result = await step(instant(HELD_FIRST_LOOK_MS + 10));
    expect(result.raised).toEqual([]);
    expect(result.watching).toBe(0);
    expect(looks).toEqual([]);
  });

  test("another seat, another leg, another checkout's record, an unsigned change and a missing record", async () => {
    const made = scene();
    // Another seat of the session, a line with no socket leg, and a line that is not a delivery:
    // none of them is a socket frame this step may speak for.
    recordOf(made, 'other-seat', { to: 'helper' });
    deliveredAt(made, 'other-seat', NOW, { to: 'helper' });
    const typedId = '3f2a1b4c-0000-4000-8000-000000000004';
    recordOf(made, typedId);
    deliveredAt(made, typedId, NOW, { via: 'typed' });
    const waitId = '3f2a1b4c-0000-4000-8000-000000000005';
    recordOf(made, waitId);
    deliveredAt(made, waitId, NOW, { outcome: 'timeout' });

    // A record written for another checkout is not this route's to raise.
    const foreignId = '3f2a1b4c-0000-4000-8000-000000000006';
    recordOf(made, foreignId, { root: join(made.root, '..', 'elsewhere') });
    deliveredAt(made, foreignId, NOW);

    // A record whose body was changed after signing proves nothing.
    const tamperedId = '3f2a1b4c-0000-4000-8000-000000000007';
    recordOf(made, tamperedId);
    const signed = signRecord(payloadOf(made, tamperedId), made.home);
    writeFileSync(made.recordPath(tamperedId), `${JSON.stringify({ payload: { ...signed.payload, body: 'changed' }, signature: signed.signature }, null, 2)}\n`);
    deliveredAt(made, tamperedId, NOW);

    // A delivered line whose id names no record file.
    deliveredAt(made, '3f2a1b4c-0000-4000-8000-000000000008', NOW);

    const { step, looks } = stepOf(made, { screen: async () => HELD_DIALOG });
    const result = await step(instant(HELD_FIRST_LOOK_MS + 10));
    expect(result.raised).toEqual([]);
    expect(result.watching).toBe(0);
    expect(looks).toEqual([]);
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries.some((entry) => entry.outcome === 'held')).toBe(false);
  });

  test('a delivered line older than the window, or stamped ahead of the pass', async () => {
    const made = scene();
    const oldId = '3f2a1b4c-0000-4000-8000-000000000009';
    recordOf(made, oldId);
    deliveredAt(made, oldId, new Date(NOW.getTime() - 10_000));
    const aheadId = '3f2a1b4c-0000-4000-8000-00000000000a';
    recordOf(made, aheadId);
    deliveredAt(made, aheadId, new Date(NOW.getTime() + 10_000));

    const { step, looks } = stepOf(made);
    const result = await step(instant(1000));
    expect(result.raised).toEqual([]);
    expect(result.watching).toBe(0);
    expect(looks).toEqual([]);
  });
});

describe('the looks', () => {
  test('stop at the window, leaving the record unread for the watch retry', async () => {
    const made = scene();
    const id = '3f2a1b4c-0000-4000-8000-00000000000b';
    recordOf(made, id);
    deliveredAt(made, id, NOW);
    const { step, looks } = stepOf(made);

    const first = await step(instant(HELD_FIRST_LOOK_MS + 10));
    expect(first.raised).toEqual([]);
    expect(first.watching).toBe(1);
    expect(looks).toHaveLength(1);

    // Before the next look is due, the pass does not read the pane again.
    const early = await step(instant(HELD_FIRST_LOOK_MS + 100));
    expect(early.watching).toBe(1);
    expect(looks).toHaveLength(1);

    const second = await step(instant(HELD_FIRST_LOOK_MS + HELD_LOOK_EVERY_MS + 10));
    expect(second.watching).toBe(1);
    expect(looks).toHaveLength(2);

    // The last look closes the window: no dialog, so the frame stays delivered and unread.
    const last = await step(instant(HELD_LAST_LOOK_MS + 20));
    expect(last.raised).toEqual([]);
    expect(last.watching).toBe(0);
    expect(looks).toHaveLength(3);

    const after = await step(instant(HELD_LAST_LOOK_MS + 1000));
    expect(after.watching).toBe(0);
    expect(looks).toHaveLength(3);
  });

  test('a session that cannot be read is retried, and a seat listed twice is never looked at', async () => {
    const made = scene();
    const id = '3f2a1b4c-0000-4000-8000-00000000000c';
    recordOf(made, id);
    deliveredAt(made, id, NOW);
    let live: Awaited<ReturnType<NonNullable<PresenceHeldInput['agents']>>> = null;
    const { step, looks } = stepOf(made, {
      agents: async () => live,
      screen: async () => HELD_DIALOG,
    });

    const unread = await step(instant(HELD_FIRST_LOOK_MS + 10));
    expect(unread.raised).toEqual([]);
    expect(unread.watching).toBe(1);
    expect(unread.failed).toContain('could not be read');
    expect(looks).toEqual([]);

    // Two live agents of the seat's name: neither pane is certainly the seat's.
    live = [{ name: SEAT, pane: 'fixture-pane-a' }, { name: SEAT, pane: 'fixture-pane-b' }];
    const ambiguous = await step(instant(HELD_FIRST_LOOK_MS + 100));
    expect(ambiguous.raised).toEqual([]);
    expect(looks).toEqual([]);

    // One live agent again: the next due look reads its pane and raises.
    live = [{ name: SEAT, pane: 'fixture-pane-lead' }];
    const raised = await step(instant(HELD_FIRST_LOOK_MS + 2 * HELD_LOOK_EVERY_MS + 10));
    expect(raised.raised).toEqual([id]);
    expect(looks).toEqual([{ pane: 'fixture-pane-lead', session: SESSION }]);
  });

  test('one pane look per seat raises held for all due unread frames of that seat and writes no read receipt', async () => {
    const made = scene();
    const id1 = '3f2a1b4c-0000-4000-8000-00000000000d';
    const id2 = '3f2a1b4c-0000-4000-8000-00000000000e';
    recordOf(made, id1);
    recordOf(made, id2);
    deliveredAt(made, id1, NOW);
    deliveredAt(made, id2, NOW);
    declareSeat(made);
    const { step, looks } = stepOf(made, { screen: async () => HELD_DIALOG });

    const out = await step(instant(HELD_FIRST_LOOK_MS + 10));
    expect(out.failed).toBeNull();
    expect(out.raised).toEqual([id1, id2]);
    expect(out.watching).toBe(0);
    expect(looks).toEqual([{ pane: 'fixture-pane-lead', session: SESSION }]);
    expect(readdirSync(made.drop).filter((name) => name.endsWith('.read.json'))).toEqual([]);
  });
});

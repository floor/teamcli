// The send path's cost is its own, not the tree's (send gate, ADR `zeus-message-path`, D3).
//
// A seat's `team send` settles the newest message its recipient delivered to it. Finding that
// message by reading every record in the session's tree made every send wait tens of seconds on a
// large tree. The recipient folder now carries an unread index — one small file naming, per
// sending seat, that seat's newest few staged records — and the send reads and verifies them
// newest first until one holds. These scenes hold that cost to a bound on a 40,000-file tree, and
// hold the ways an index can be wrong: absent, and naming a record that no longer qualifies. Both
// mark nothing, and neither sends the sweep back to the tree.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { markAnsweredBySend } from '../src/send/answered-by-send.ts';
import { appendHistory } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const ASK_LEAD = 'a2000000-0000-4000-8000-000000000001';
const ASK_WORKER = 'a2000000-0000-4000-8000-000000000002';
const READ_ALREADY = 'a2000000-0000-4000-8000-000000000003';
const MISSING = 'a2000000-0000-4000-8000-000000000004';
const OTHER_SENDER = 'a2000000-0000-4000-8000-000000000005';
const LATE = 'a2000000-0000-4000-8000-000000000006';
const REPLY = 'a2000000-0000-4000-8000-000000000009';

const PANE_LEAD = 'pane-lead';
const PANE_WORKER = 'pane-worker';
const PANE_HELPER = 'pane-helper';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = { root: string; home: string; sockets: string };

/** The file's three seats, all placed; the sends these scenes run travel the drop leg. */
function makeWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'answered-by-send-index-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
delivery_order: [drop]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`,
  );
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE_LEAD };
    session.seats.worker = { stage: 'ready', pane: PANE_WORKER };
    session.seats.helper = { stage: 'ready', pane: PANE_HELPER };
  });
  return { root, home, sockets };
}

function makeHost(w: World): SendHost {
  return {
    agents: () => [
      { name: 'lead', pane: PANE_LEAD },
      { name: 'worker', pane: PANE_WORKER },
      { name: 'helper', pane: PANE_HELPER },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} } satisfies NativePane,
    now: () => NOW,
    home: w.home,
  };
}

const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: PANE_LEAD, session: 'acme' };
const workerCaller: Caller = { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' };

function delivered(w: World, seat: string, id: string, fields: Parameters<typeof plantRecord>[6]): void {
  plantRecord(w.home, w.root, 'acme', seat, id, 'a question', fields);
}

function line(w: World, id: string, from: string, to: string, via: string, ts: string): void {
  appendHistory('acme', w.root, w.home, { ts, from, to, body: 'a question', id, outcome: 'delivered', via });
}

function readReceiptExists(w: World, seat: string, id: string): boolean {
  return existsSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`));
}

/** One signed record in a seat's folder, written the way a send writes it but with no unread
 *  index entry beside it — the tree an older build, or a lost hint, leaves. */
function deliveredWithoutIndex(w: World, seat: string, id: string, fields: { from: string; at: string }): void {
  const signed = signRecord(
    {
      kind: 'message',
      id,
      to: seat,
      to_id: null,
      root: realpathSync(w.root),
      session: 'acme',
      at: fields.at,
      body: 'a question',
      from: fields.from,
      from_id: null,
      rule: 'the owner',
      thread: id,
    },
    w.home,
  );
  const dir = recordDir(w.root, 'acme', seat);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, id), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
}

/** Fills one seat's folder with plain body files — names and bodies the transport tree holds but
 *  no reader takes for a record. */
function filler(seatDir: string, count: number): void {
  mkdirSync(seatDir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(seatDir, `body-${String(index).padStart(6, '0')}`), 'a plain body, not a record\n');
  }
}

describe('the unread index is what a send reads, and a big tree is never walked', () => {
  test('a send settles the indexed message inside 300 ms, and a reply reads its thread folders', async () => {
    const w = makeWorld();
    delivered(w, 'lead', ASK_LEAD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, ASK_LEAD, 'worker', 'lead', 'socket', '2026-11-03T09:00:01.000Z');
    delivered(w, 'worker', ASK_WORKER, { from: 'lead', at: '2026-11-03T09:30:00.000Z' });
    line(w, ASK_WORKER, 'lead', 'worker', 'socket', '2026-11-03T09:30:01.000Z');
    // The tree the live fleet carried: forty thousand files in a seat folder neither command may
    // read on this path.
    const helperDir = recordDir(w.root, 'acme', 'helper');
    filler(helperDir, 40_000);

    const sendStart = performance.now();
    const sendIo = testIo(w.root, leadCaller);
    const sendCode = await runSend(['worker', 'the answer'], sendIo, makeHost(w));
    const sendMs = performance.now() - sendStart;

    const replyStart = performance.now();
    const replyIo = testIo(w.root, workerCaller);
    const replyCode = await runReply([ASK_WORKER, 'the answer'], replyIo, { home: w.home, now: () => NOW, newId: () => REPLY });
    const replyMs = performance.now() - replyStart;

    expect(sendCode).toBe(0);
    expect(readReceiptExists(w, 'lead', ASK_LEAD)).toBe(true);
    expect(sendMs).toBeLessThan(300);
    expect(replyCode).toBe(0);
    expect(existsSync(join(recordDir(w.root, 'acme', 'lead'), REPLY))).toBe(true);
    expect(replyMs).toBeLessThan(2_000);
    // The tree comes down inside the scene: a folder of forty thousand files costs this run
    // seconds to remove, and the scene's budget is its own.
    rmSync(helperDir, { recursive: true, force: true });
  }, 120_000);

  test('an absent index marks nothing and never falls back to the tree', () => {
    const w = makeWorld();
    deliveredWithoutIndex(w, 'lead', ASK_LEAD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, ASK_LEAD, 'worker', 'lead', 'socket', '2026-11-03T09:00:01.000Z');

    const outcome = markAnsweredBySend({
      seat: 'lead',
      sender: 'worker',
      senderId: null,
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });

    expect(outcome).toEqual({ kind: 'none' });
    expect(readReceiptExists(w, 'lead', ASK_LEAD)).toBe(false);
  });

  test('an index naming a read, missing, foreign or late record marks nothing', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');

    // (a) The index still names a message that is already read: the clear was lost.
    delivered(w, 'lead', READ_ALREADY, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, READ_ALREADY, 'worker', 'lead', 'socket', '2026-11-03T09:00:01.000Z');
    const key = messageKeyState(w.home);
    if (key.kind !== 'key') throw new Error(key.kind);
    publishRecordRead({ dropDir: leadDir, id: READ_ALREADY, to: 'lead', root: w.root, session: 'acme', home: w.home, key: key.key, at: NOW_ISO });
    expect(readReceiptExists(w, 'lead', READ_ALREADY)).toBe(true);

    // (b) The index names an id no file holds.
    // (c) The index names a record another sender wrote.
    delivered(w, 'lead', OTHER_SENDER, { from: 'helper', at: '2026-11-03T09:20:00.000Z' });
    line(w, OTHER_SENDER, 'helper', 'lead', 'socket', '2026-11-03T09:20:01.000Z');
    // (d) The index names a record delivered after this send's own instant.
    delivered(w, 'lead', LATE, { from: 'worker', at: '2026-11-03T11:30:00.000Z' });
    line(w, LATE, 'worker', 'lead', 'socket', '2026-11-03T12:00:01.000Z');

    const sweep = (id: string): ReturnType<typeof markAnsweredBySend> => {
      writeFileSync(
        join(leadDir, '.unread.json'),
        `${JSON.stringify({ v: 1, unread: { worker: { entries: [{ id, at: NOW_ISO }] } } })}\n`,
      );
      return markAnsweredBySend({
        seat: 'lead',
        sender: 'worker',
        senderId: null,
        root: w.root,
        session: 'acme',
        project: 'acme',
        home: w.home,
        at: NOW_ISO,
      });
    };

    expect(sweep(READ_ALREADY)).toEqual({ kind: 'none' });
    expect(sweep(MISSING)).toEqual({ kind: 'none' });
    expect(sweep(OTHER_SENDER)).toEqual({ kind: 'none' });
    expect(sweep(LATE)).toEqual({ kind: 'none' });
    // None of the four was marked by any of the four sweeps.
    expect(readReceiptExists(w, 'lead', LATE)).toBe(false);
    expect(readReceiptExists(w, 'lead', OTHER_SENDER)).toBe(false);
    expect(readReceiptExists(w, 'lead', MISSING)).toBe(false);
  });

  test('a read clears the sender entry the index holds', () => {
    const w = makeWorld();
    const leadDir = recordDir(w.root, 'acme', 'lead');
    delivered(w, 'lead', ASK_LEAD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    const readIndex = (): { unread?: Record<string, { entries: { id: string }[] }> } =>
      JSON.parse(readFileSync(join(leadDir, '.unread.json'), 'utf8')) as { unread?: Record<string, { entries: { id: string }[] }> };
    expect(readIndex().unread?.worker?.entries.map((entry) => entry.id)).toEqual([ASK_LEAD]);

    const key = messageKeyState(w.home);
    if (key.kind !== 'key') throw new Error(key.kind);
    publishRecordRead({ dropDir: leadDir, id: ASK_LEAD, to: 'lead', root: w.root, session: 'acme', home: w.home, key: key.key, at: NOW_ISO });

    expect(readIndex().unread?.worker).toBeUndefined();
  });
});

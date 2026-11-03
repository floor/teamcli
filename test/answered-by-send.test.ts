// A seat's `team send` is its own answer (ADR `zeus-message-path`, D3). The send settles the
// NEWEST message the addressed seat delivered to the sending seat before the send's own instant,
// and only that one: a recipient that sent three messages and is answered once keeps the other
// two waiting. Only a delivery the history names as a frame, a channel push or a native handoff
// counts — a typed wake is that leg's own act and a webhook post is the sender's — and the
// receipt is the answering seat's own signed record, never the sender's.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { listUnackedMessages, plantRecord, recordDir } from '../src/commands/messages.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { markAnsweredBySend } from '../src/send/answered-by-send.ts';
import { appendHistory } from '../src/send/history.ts';
import { signedReceiptOf, verifyReceipt } from '../src/send/record.ts';
import type { NativePane } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const OLD = 'a1000000-0000-4000-8000-000000000001';
const NEW = 'a1000000-0000-4000-8000-000000000002';
const TYPED = 'a1000000-0000-4000-8000-000000000003';
const CHANNEL = 'a1000000-0000-4000-8000-000000000004';
const WEBHOOK = 'a1000000-0000-4000-8000-000000000005';
const LATE = 'a1000000-0000-4000-8000-000000000006';

const PANE_LEAD = 'pane-lead';
const PANE_WORKER = 'pane-worker';
const PANE_HELPER = 'pane-helper';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = { root: string; home: string; sockets: string };

/** The file's three seats, all placed: a coordinator and two implementers. The send these scenes
 *  run travels the drop leg, so nothing is typed and no socket is opened. */
function makeWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'answered-by-send-')));
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

/** A message `team send` would have delivered to `seat`, signed by its sender. */
function delivered(w: World, seat: string, id: string, fields: Parameters<typeof plantRecord>[6]): void {
  plantRecord(w.home, w.root, 'acme', seat, id, 'a question', fields);
}

/** The sender's own history line: the first line about a message names the leg that carried it. */
function line(w: World, id: string, via: string, ts: string): void {
  appendHistory('acme', w.root, w.home, {
    ts,
    from: 'worker',
    to: 'lead',
    body: 'a question',
    id,
    outcome: 'delivered',
    via,
  });
}

function readReceiptOf(w: World, seat: string, id: string): ReturnType<typeof signedReceiptOf> {
  return signedReceiptOf(JSON.parse(readFileSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`), 'utf8')));
}

function readReceiptExists(w: World, seat: string, id: string): boolean {
  return existsSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`));
}

describe('a seat’s send is the read it signs', () => {
  test('it settles the newest delivered message from the addressed seat and leaves the older one waiting', async () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    delivered(w, 'lead', NEW, { from: 'worker', at: '2026-11-03T10:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');
    line(w, NEW, 'socket', '2026-11-03T10:00:01.000Z');

    const io = testIo(w.root, leadCaller);
    const code = await runSend(['worker', 'the answer'], io, makeHost(w));

    expect(code).toBe(0);
    expect(readReceiptExists(w, 'lead', NEW)).toBe(true);
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
    const read = readReceiptOf(w, 'lead', NEW);
    if (read === null) throw new Error('no read receipt was written');
    const { writer, ...fields } = read.payload;
    expect(fields).toEqual({
      kind: 'receipt',
      status: 'read',
      id: NEW,
      to: 'lead',
      root: w.root,
      session: 'acme',
      at: NOW_ISO,
      read_by: 'answered-by-send',
    });
    expect(writer?.pid).toBe(process.pid);
    const key = messageKeyState(w.home);
    if (key.kind !== 'key') throw new Error(key.kind);
    expect(verifyReceipt(read, key.key)).toBe(true);
    // The older question still waits, and the sent message's own copy in the recipient's folder
    // carries no read: the answering seat's act settles what it received, never what it sent.
    expect(listUnackedMessages(w.root, 'acme', w.home).filter((message) => message.to === 'lead').map((message) => message.id)).toEqual([OLD]);
    expect(readdirSync(recordDir(w.root, 'acme', 'worker')).filter((name) => name.endsWith('.read.json'))).toEqual([]);
  });

  test('only a frame, a channel push or a native handoff is evidence enough to answer', async () => {
    const w = makeWorld();
    delivered(w, 'lead', CHANNEL, { from: 'worker', at: '2026-11-03T08:00:00.000Z' });
    delivered(w, 'lead', TYPED, { from: 'worker', at: '2026-11-03T10:00:00.000Z' });
    delivered(w, 'lead', WEBHOOK, { from: 'worker', at: '2026-11-03T11:00:00.000Z' });
    delivered(w, 'lead', LATE, { from: 'worker', at: '2026-11-03T11:30:00.000Z' });
    line(w, CHANNEL, 'channel', '2026-11-03T08:00:01.000Z');
    line(w, TYPED, 'typed', '2026-11-03T10:00:01.000Z');
    line(w, WEBHOOK, 'webhook', '2026-11-03T11:00:01.000Z');
    // A frame delivered after this send is not answered by it, however the send is timed.
    line(w, LATE, 'socket', '2026-11-03T12:00:01.000Z');

    const code = await runSend(['worker', 'the answer'], testIo(w.root, leadCaller), makeHost(w));

    expect(code).toBe(0);
    // The channel push is older than the typed and webhook messages and still the one settled:
    // those two are not deliveries this rule counts, and a newer one never blocks an older.
    expect(readReceiptExists(w, 'lead', CHANNEL)).toBe(true);
    expect(readReceiptExists(w, 'lead', TYPED)).toBe(false);
    expect(readReceiptExists(w, 'lead', WEBHOOK)).toBe(false);
    expect(readReceiptExists(w, 'lead', LATE)).toBe(false);
    expect(
      listUnackedMessages(w.root, 'acme', w.home).filter((message) => message.to === 'lead').map((message) => message.id).sort(),
    ).toEqual([LATE, TYPED, WEBHOOK].sort());
  });

  test('a message signed by another agent under the addressed name is not settled by the name', () => {
    const w = makeWorld();
    const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000007';
    const THIS_AGENT = 'a1000000-0000-4000-8000-000000000008';
    delivered(w, 'lead', OLD, { from: 'worker', from_id: THIS_AGENT, at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');

    const sweep = (senderId: string | null): ReturnType<typeof markAnsweredBySend> =>
      markAnsweredBySend({
        seat: 'lead',
        sender: 'worker',
        senderId,
        root: w.root,
        session: 'acme',
        project: 'acme',
        home: w.home,
        at: NOW_ISO,
      });

    // The address resolved to another registered agent: the same display name is another person.
    expect(sweep(OTHER_AGENT)).toEqual({ kind: 'none' });
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
    // The resolved id is the one the message's own signature names: this is that sender's message.
    expect(sweep(THIS_AGENT)).toEqual({ kind: 'marked', id: OLD });
    expect(readReceiptExists(w, 'lead', OLD)).toBe(true);
    expect(readReceiptOf(w, 'lead', OLD)?.payload.read_by).toBe('answered-by-send');
  });

  test('when no registry id resolved, the signed seat name is all the evidence there is', () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', from_id: 'a1000000-0000-4000-8000-000000000009', at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'native', '2026-11-03T09:00:01.000Z');

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

    expect(outcome).toEqual({ kind: 'marked', id: OLD });
  });
});

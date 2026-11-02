// Independent scenes for the bus-nudge fix and the reconcile pass's verified read
// (writer-04, private lane, d6ce0bcef on b6f1d18bb). Written against the fix's claims, not the
// builder's tests: a raw publish of message.arrived is held to the signed drop record it names;
// the reconcile pass puts every drop record through the same checked read — a linked record,
// a linked folder, an unsigned record, or one addressed to another seat, session or checkout
// raises nothing and is named once — and the mailbox messages and read receipts answer to the
// same envelope; a seat.* event never reaches an adapter; a bus that is down or silent never
// fails a send and the record is delivered when the bus can take it.
// Fixtures only: a synthetic checkout and home under short /tmp paths (the socket name limit),
// a bus this file starts and closes, a loopback HTTP receiver. No live session, pane or CLI.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { busSocket, publishToBus, startBus, type BusHandle } from '../src/bus/server.ts';
import { readEvents, type EventAppendInput } from '../src/bus/log.ts';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readSealedRecord, recordAuthOfSealed, signRecord, type RecordPayload } from '../src/send/record.ts';
import { markPending } from '../src/send/pending.ts';
import { messageKeyOf, messageKeyState, RECEIPT_DOMAIN, signDomain } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const SECRET = 'writer04-synthetic-secret-value';
const NOW = new Date('2026-11-02T12:00:00.000Z');

type Place = { base: string; root: string; home: string; dir: string; urlFile: string; secretFile: string };
type Refusal = { where: string; reason: string };
const places: Place[] = [];
const buses: BusHandle[] = [];
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const place of places.splice(0)) rmSync(place.base, { recursive: true, force: true });
});

function teamText(place: Place): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${join(place.home, '.config', 'team', 'lobby')}
  - ${place.root}
delivery_order: [drop]
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    leads: true
    inbound: accept
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    inbound: accept
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    inbound: accept
    webhook:
      url_file: ${JSON.stringify(place.urlFile)}
      secret_file: ${JSON.stringify(place.secretFile)}
`;
}

/** One synthetic world on a SHORT path (the bus socket's name limit). */
function place(): Place {
  const base = mkdtempSync(join(realpathSync('/tmp'), 'bn-'));
  const root = join(base, 'r');
  const home = join(base, 'h');
  const dir = join(root, '.agents');
  mkdirSync(join(dir), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, 'http://127.0.0.1:1/not-listening\n');
  writeFileSync(secretFile, SECRET + '\n', { mode: 0o600 });
  const made: Place = { base, root, home, dir, urlFile, secretFile };
  // The checkout's message key, as any world that ever signed a message holds it: a pass with
  // no key verifies nothing and refuses nothing, which is not the world under test.
  messageKeyOf(home);
  writeFileSync(join(dir, 'team.yaml'), teamText(made));
  const seats = Object.fromEntries(['lead', 'helper', 'iris'].map((name) => [name, { stage: 'ready', pane: `pane-${name}` }]));
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats, workspaces: {}, worktrees: {} } } })}\n`);
  places.push(made);
  return made;
}

function teamOf(place: Place) {
  const parsed = validateTeamFile(readFileSync(join(place.dir, 'team.yaml'), 'utf8'));
  if (!parsed.ok) throw new Error('the fixture team does not validate: ' + JSON.stringify(parsed.errors));
  return parsed.team;
}

async function bus(place: Place): Promise<BusHandle> {
  const started = await startBus({ root: place.root, team: teamOf(place), home: place.home, stderr: () => {}, reconcileIntervalMs: 0 });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') throw new Error('the bus did not start');
  buses.push(started.handle);
  return started.handle;
}

type Post = { at: number; body: string; authorization: string | null };
function receiver(): { posts: Post[]; url: string } {
  const posts: Post[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      posts.push({ at: performance.now(), body: await request.text(), authorization: request.headers.get('authorization') });
      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  return { posts, url: 'http://127.0.0.1:' + server.port + '/hook' };
}

function host(place: Place): SendHost {
  return {
    agents: () => [{ name: 'lead', pane: 'pane-live' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(place.base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} },
    now: () => NOW,
    home: place.home,
  };
}

/** The sealed record files a folder holds: uuid names, no staging suffix. */
function recordIds(place: Place, seat: string): string[] {
  const folder = join(place.dir, 'send-drops', SESSION, seat);
  return readdirSync(folder).filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
}

/** One real owner send to a seat; returns the drop record's id. */
async function send(place: Place, seat: string, body: string): Promise<string> {
  const io = testIo(place.root, { kind: 'owner' });
  const code = await runSend([seat, body], io, host(place));
  expect(code, io.err).toBe(0);
  const ids = recordIds(place, seat);
  expect(ids.length).toBe(1);
  return ids[0]!;
}

function dropPath(place: Place, seat: string, id: string): string {
  return join(place.dir, 'send-drops', SESSION, seat, id);
}

/** One drop record's payload, addressed the way a send to this seat would address it. */
function dropPayload(at: Place, seat: string, id: string, overrides: Partial<RecordPayload> = {}): RecordPayload {
  return {
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: at.root,
    session: SESSION,
    at: NOW.toISOString(),
    body: `from lead — admitted by: lead\n\nhello ${id}`,
    from: 'lead',
    from_id: null,
    rule: 'a writer04 scene',
    thread: id,
    ...overrides,
  };
}

function signedBytes(at: Place, payload: RecordPayload): string {
  return `${JSON.stringify(signRecord(payload, at.home), null, 2)}\n`;
}

/** One hand-signed record planted in a seat's drop folder: no send, no history line, nothing
 *  but the pass's own checked read can raise it. */
function signedDrop(at: Place, seat: string, id: string, overrides: Partial<RecordPayload> = {}): void {
  mkdirSync(join(at.dir, 'send-drops', SESSION, seat), { recursive: true });
  writeFileSync(dropPath(at, seat, id), signedBytes(at, dropPayload(at, seat, id, overrides)));
}

/** One reconcile pass over a fixture world, collecting refusals when asked. */
function pass(
  at: Place,
  options: { state?: ReturnType<typeof createReconcileState>; refusals?: Refusal[] } = {},
): ReturnType<typeof reconcilePass> {
  return reconcilePass({
    project: 'acme',
    root: at.root,
    session: SESSION,
    home: at.home,
    now: NOW,
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.refusals !== undefined ? { onRefused: (refusal: Refusal) => { options.refusals!.push(refusal); } } : {}),
  });
}

function payloadOf(record: { payload: unknown }): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function arrival(id: string, seat: string, overrides: Partial<EventAppendInput> = {}): EventAppendInput {
  return { kind: 'message.arrived', ts: NOW.toISOString(), session: SESSION, record_id: id, from: 'lead', to: seat, ...overrides };
}

function logIds(place: Place): string[] {
  const read = readEvents('acme', place.root, place.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((event) => (event.payload as { record_id?: string }).record_id ?? '');
}

async function until(check: () => boolean, budget = 5000): Promise<void> {
  const end = performance.now() + budget;
  while (!check()) {
    if (performance.now() >= end) throw new Error('the loopback receiver did not observe the expected request');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function decoded(place: Place, seat: string, id: string): Record<string, unknown> {
  const read = readSealedRecord(dropPath(place, seat, id));
  if (!read.ok || read.sealed === null) throw new Error('the fixture record does not read');
  const key = messageKeyState(place.home);
  if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
  const auth = recordAuthOfSealed(read.sealed, key.key);
  if (auth.kind !== 'ok') throw new Error('the fixture record does not authenticate');
  return auth.value.payload as unknown as Record<string, unknown>;
}

test('a raw publish naming a record that does not exist posts and appends nothing', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  const answer = await publishToBus(at.root, arrival('no-such-record', 'iris'));
  expect(answer.kind).toBe('refused');
  if (answer.kind === 'refused') expect(answer.message).toContain('names no signed drop record');
  expect(held.posts).toHaveLength(0);
  expect(logIds(at)).not.toContain('no-such-record');
});

test('a raw publish naming an unsigned record posts and appends nothing', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  mkdirSync(join(at.dir, 'send-drops', SESSION, 'iris'), { recursive: true });
  writeFileSync(dropPath(at, 'iris', 'unsigned-one'), JSON.stringify({ from: 'lead', body: 'not sealed' }));
  const answer = await publishToBus(at.root, arrival('unsigned-one', 'iris'));
  expect(answer.kind).toBe('refused');
  expect(held.posts).toHaveLength(0);
  expect(logIds(at)).not.toContain('unsigned-one');
});

test('a raw publish claiming another seat record, or another session, posts nothing', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  // helper carries no webhook, so its own arrival posts nothing on its own.
  const helpers = await send(at, 'helper', 'for helper only');
  // The record exists and is signed, but it is helper's: the claim says iris holds it.
  const wrongSeat = await publishToBus(at.root, arrival(helpers, 'iris'));
  expect(wrongSeat.kind).toBe('refused');
  // This session's bus does not serve another session's claim.
  const wrongSession = await publishToBus(at.root, arrival(helpers, 'helper', { session: 'not-this-session' }));
  expect(wrongSession.kind).toBe('refused');
  expect(held.posts).toHaveLength(0);
  // The one arrival in the log is helper's own valid nudge; a refused publish appends no second.
  expect(logIds(at).filter((id) => id === helpers)).toHaveLength(1);
});

test('a linked record is refused by the publish and by the reconcile pass', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  const lines: string[] = [];
  // A hand-signed record, no send: nothing but the drop scan could raise it.
  signedDrop(at, 'iris', 'linked-pass-rec', { at: '2026-11-02T11:00:00.000Z' });
  const path = dropPath(at, 'iris', 'linked-pass-rec');
  const elsewhere = join(at.base, 'elsewhere-copy');
  writeFileSync(elsewhere, readFileSync(path));
  rmSync(path);
  symlinkSync(elsewhere, path);
  // The startup pass refuses the link: nothing appended, nothing posted, one line on stderr.
  const started = await startBus({ root: at.root, team: teamOf(at), home: at.home, stderr: (line) => lines.push(line), reconcileIntervalMs: 0 });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') throw new Error('the bus did not start');
  buses.push(started.handle);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(held.posts).toHaveLength(0);
  expect(logIds(at)).not.toContain('linked-pass-rec');
  expect(lines.join('\n')).toContain('iris/linked-pass-rec was not raised: the record is a symbolic link');
  // The verified path refuses the linked record and the traversal-shaped name too.
  const linked = await publishToBus(at.root, arrival('linked-pass-rec', 'iris'));
  expect(linked.kind).toBe('refused');
  const escape = await publishToBus(at.root, arrival('..%2Fescape', 'iris'));
  expect(escape.kind).toBe('refused');
  expect(held.posts).toHaveLength(0);
}, 10_000);

test('a raw publish the bus accepts carries the record fields, never the caller ones', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  const id = await send(at, 'iris', 'the true body');
  const record = decoded(at, 'iris', id);
  const answer = await publishToBus(at.root, arrival(id, 'iris', {
    from: 'impostor-sender', thread: 'impostor-thread', ts: '2030-01-01T00:00:00.000Z',
  }));
  expect(answer.kind).toBe('published');
  await until(() => held.posts.length === 1);
  const payload = (JSON.parse(held.posts[0]!.body) as { event: { payload: Record<string, unknown> } }).event.payload;
  expect(payload.from).toBe(record.from);
  expect(payload.to).toBe('iris');
  expect(payload.ts).toBe(record.at);
  expect(JSON.stringify(payload)).not.toContain('impostor');
});

test('a seat.working publish is appended and never posted to the adapter', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  const answer = await publishToBus(at.root, {
    kind: 'seat.working', ts: NOW.toISOString(), session: SESSION,
    record_id: 'watch:working:iris-1', seat: 'iris', to: 'iris', reason: 'synthetic state change',
  });
  expect(answer.kind).toBe('published');
  expect(logIds(at)).toContain('watch:working:iris-1');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(held.posts).toHaveLength(0);
});

test('a send with no bus running still lands its record', async () => {
  const at = place();
  const id = await send(at, 'iris', 'no bus is listening');
  expect(existsSync(dropPath(at, 'iris', id))).toBe(true);
});

test('a silent bus socket never fails the send, and the real bus delivers the record later', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  // A listener that accepts the connection and never answers: the nudge's deadline is the bound.
  const silent = Bun.listen({ unix: busSocket(at.root), socket: { data: () => {}, open: () => {}, close: () => {} } });
  const started = performance.now();
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runSend(['iris', 'the bus is silent'], io, host(at));
  const elapsed = performance.now() - started;
  expect(code, io.err).toBe(0);
  expect(elapsed).toBeLessThan(3000);
  const folder = join(at.dir, 'send-drops', SESSION, 'iris');
  const id = recordIds(at, 'iris')[0]!;
  expect(existsSync(dropPath(at, 'iris', id))).toBe(true);
  expect(held.posts).toHaveLength(0);
  // The safety net: once the real bus serves the root, its pass posts the unseen arrival.
  silent.stop(true);
  rmSync(busSocket(at.root), { force: true });
  await bus(at);
  await until(() => held.posts.length === 1);
  const payload = (JSON.parse(held.posts[0]!.body) as { event: { payload: Record<string, unknown> } }).event.payload;
  expect(payload.record_id).toBe(id);
  expect(payload.kind).toBe('message.arrived');
}, 15_000);

test('a valid send reaches the local webhook inside five seconds, secret only in its header', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  await bus(at);
  const t0 = performance.now();
  const id = await send(at, 'iris', 'the gate is green');
  await until(() => held.posts.length === 1, 5000);
  expect(held.posts[0]!.at - t0).toBeLessThan(5000);
  const payload = (JSON.parse(held.posts[0]!.body) as { event: { payload: Record<string, unknown> } }).event.payload;
  expect(payload.record_id).toBe(id);
  expect(payload.kind).toBe('message.arrived');
  expect(payload.to).toBe('iris');
  expect(held.posts[0]!.authorization).toBe('Bearer ' + SECRET);
  expect(held.posts[0]!.body).not.toContain(SECRET);
  // The bus reads the record; it never rewrites it.
  expect(readSealedRecord(dropPath(at, 'iris', id)).ok).toBe(true);
});

test('an unsigned drop record raises nothing; its refusal is said once and never re-read', () => {
  const at = place();
  mkdirSync(join(at.dir, 'send-drops', SESSION, 'iris'), { recursive: true });
  writeFileSync(dropPath(at, 'iris', 'unsigned-pass'), JSON.stringify({ from: 'lead', body: 'not sealed' }));
  const refusals: Refusal[] = [];
  const state = createReconcileState();
  const first = pass(at, { state, refusals });
  expect(first.ok).toBe(true);
  expect(refusals).toEqual([{ where: 'iris/unsigned-pass', reason: 'the record is not a signed record' }]);
  expect(logIds(at)).not.toContain('unsigned-pass');
  const second = pass(at, { state, refusals });
  expect(second.ok).toBe(true);
  // Once: the unchanged refusal is not reported again, and the file is not even read.
  expect(refusals).toHaveLength(1);
  expect(state.stats.filesRead).toBe(0);
});

test('a signed record addressed to another seat, session or checkout is refused; the right one is raised', () => {
  const at = place();
  const elsewhereRoot = join(at.base, 'other-checkout');
  mkdirSync(elsewhereRoot, { recursive: true });
  signedDrop(at, 'iris', 'right-rec');
  signedDrop(at, 'iris', 'wrong-seat-rec', { to: 'helper' });
  signedDrop(at, 'iris', 'wrong-session-rec', { session: 'some-other-session' });
  signedDrop(at, 'iris', 'wrong-root-rec', { root: elsewhereRoot });
  const refusals: Refusal[] = [];
  const result = pass(at, { refusals });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.raised.map((record) => payloadOf(record).record_id)).toEqual(['right-rec']);
  expect(refusals).toEqual([
    { where: 'iris/wrong-root-rec', reason: 'the signed record belongs to another checkout' },
    { where: 'iris/wrong-seat-rec', reason: 'the signed record is addressed to another seat or session' },
    { where: 'iris/wrong-session-rec', reason: 'the signed record is addressed to another seat or session' },
  ]);
  for (const id of ['wrong-seat-rec', 'wrong-session-rec', 'wrong-root-rec']) {
    expect(logIds(at)).not.toContain(id);
  }
});

test('a drop tree reached through a link is not this checkout to raise from, however valid its records', () => {
  const at = place();
  // A valid record for iris, signed for THIS checkout, living in another tree.
  const other = join(at.base, 'other-tree', 'acme', 'iris');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'via-folder-link'), signedBytes(at, dropPayload(at, 'iris', 'via-folder-link')));
  // The checkout's whole send-drops tree is a link into that other tree.
  symlinkSync(join(at.base, 'other-tree'), join(at.dir, 'send-drops'));
  const refusals: Refusal[] = [];
  const state = createReconcileState();
  const result = pass(at, { state, refusals });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  // The folder is named once and nothing inside it is read.
  expect(refusals).toEqual([{ where: 'iris (drop folder)', reason: "the folder is not this checkout's" }]);
  expect(state.stats.filesRead).toBe(0);
  expect(result.raised).toHaveLength(0);
  expect(logIds(at)).not.toContain('via-folder-link');
});

test('a pending marker whose record is a link raises neither arrival nor held, until the record is real', () => {
  const at = place();
  signedDrop(at, 'iris', 'pending-linked');
  const path = dropPath(at, 'iris', 'pending-linked');
  const bytes = readFileSync(path);
  const elsewhere = join(at.base, 'copy-pending');
  writeFileSync(elsewhere, bytes);
  markPending(join(at.dir, 'send-drops', SESSION, 'iris'), {
    id: 'pending-linked', from: 'lead', to: 'iris', body: 'held body',
    ts: '2026-11-02T10:00:00.000Z', leg: 'drop',
  });
  rmSync(path);
  symlinkSync(elsewhere, path);
  const refusals: Refusal[] = [];
  const state = createReconcileState();
  const first = pass(at, { state, refusals });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.reason);
  expect(first.raised).toHaveLength(0);
  expect(logIds(at)).not.toContain('pending-linked');
  expect(logIds(at)).not.toContain('pending-linked:held');
  // Both the scan and the marker name it, each with its own reason.
  expect(refusals).toEqual([
    { where: 'iris/pending-linked', reason: 'the record is a symbolic link' },
    { where: 'iris/pending-linked', reason: 'a symbolic link was found and not followed' },
  ]);
  // The record restored: the next pass raises the arrival and, past the threshold, the held event.
  rmSync(path);
  writeFileSync(path, bytes);
  const second = pass(at, { state, refusals });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.reason);
  const ids = second.raised.map((record) => payloadOf(record).record_id);
  expect(ids).toContain('pending-linked');
  expect(ids).toContain('pending-linked:held');
  expect(refusals).toHaveLength(2);
});

test('mailbox messages answer to the envelope: the valid one is raised from its signed fields', () => {
  const at = place();
  plantMessage(at.home, at.root, 'iris', 'mb-ok', {
    kind: 'message', id: 'mb-ok', from: 'lead', to: 'iris', root: at.root, session: SESSION,
    at: '2026-11-02T11:30:00.000Z', body: 'mailbox body',
  });
  // Signed by nobody.
  plantMessage(at.home, at.root, 'iris', 'mb-bad', {
    kind: 'message', id: 'mb-bad', from: 'lead', to: 'iris', root: at.root, session: SESSION,
    at: '2026-11-02T11:31:00.000Z', body: 'bad signature',
  }, 'not-a-signature');
  // Validly signed, but another checkout's record.
  plantMessage(at.home, at.root, 'iris', 'mb-elsewhere', {
    kind: 'message', id: 'mb-elsewhere', from: 'lead', to: 'iris', root: join(at.base, 'elsewhere-root'), session: SESSION,
    at: '2026-11-02T11:32:00.000Z', body: 'another checkout',
  });
  // The sealed bytes are this checkout's own; the path to them is a link.
  plantMessage(at.home, at.root, 'iris', 'mb-link', {
    kind: 'message', id: 'mb-link', from: 'lead', to: 'iris', root: at.root, session: SESSION,
    at: '2026-11-02T11:33:00.000Z', body: 'linked mailbox record',
  });
  const realPath = join(at.dir, 'messages', 'iris', 'mb-link.json');
  const staged = join(at.base, 'mb-link-copy.json');
  writeFileSync(staged, readFileSync(realPath));
  rmSync(realPath);
  symlinkSync(staged, realPath);
  const refusals: Refusal[] = [];
  const result = pass(at, { refusals });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  // The valid record is raised, with the time and sender its signature covered.
  expect(result.raised.map((record) => `${payloadOf(record).kind}:${payloadOf(record).record_id}`)).toEqual(['message.arrived:mb-ok']);
  expect(payloadOf(result.raised[0]!).ts).toBe('2026-11-02T11:30:00.000Z');
  expect(payloadOf(result.raised[0]!).from).toBe('lead');
  expect(refusals).toEqual([
    { where: 'iris/mb-bad', reason: "the record is not signed with this checkout's message key" },
    { where: 'iris/mb-elsewhere', reason: 'the signed record belongs to another checkout' },
  ]);
  // The linked record raises nothing; in the mailbox tree it is not named, unlike the drop tree.
  expect(logIds(at)).not.toContain('mb-link');
  expect(refusals.map((refusal) => refusal.where)).not.toContain('iris/mb-link');
});

test('mailbox read receipts answer to the same envelope', () => {
  const at = place();
  plantMessage(at.home, at.root, 'iris', 'mb-ok', {
    kind: 'message', id: 'mb-ok', from: 'lead', to: 'iris', root: at.root, session: SESSION,
    at: '2026-11-02T11:30:00.000Z', body: 'mailbox body',
  });
  const receiptPayload = {
    kind: 'receipt' as const, id: 'mb-ok', to: 'iris', root: at.root, session: SESSION,
    at: '2026-11-02T11:40:00.000Z',
  };
  const goodSig = signDomain(RECEIPT_DOMAIN, receiptPayload, messageKeyOf(at.home));
  // A valid receipt: raised as a read.
  writeFileSync(receiptFile(at.root, 'iris', 'mb-ok'), JSON.stringify({ payload: receiptPayload, signature: goodSig }));
  // A signature that covers another payload: refused.
  const otherPayload = { ...receiptPayload, id: 'mb-bad' };
  writeFileSync(receiptFile(at.root, 'iris', 'mb-bad'), JSON.stringify({ payload: otherPayload, signature: goodSig }));
  // A linked receipt: valid bytes, reached through a link.
  const linkedPayload = { ...receiptPayload, id: 'mb-link' };
  const linkedSig = signDomain(RECEIPT_DOMAIN, linkedPayload, messageKeyOf(at.home));
  const stagedReceipt = join(at.base, 'mb-receipt-copy.json');
  writeFileSync(stagedReceipt, JSON.stringify({ payload: linkedPayload, signature: linkedSig }));
  symlinkSync(stagedReceipt, receiptFile(at.root, 'iris', 'mb-link'));
  const refusals: Refusal[] = [];
  const result = pass(at, { refusals });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const raisedIds = result.raised.map((record) => payloadOf(record).record_id);
  expect(raisedIds).toContain('mb-ok');
  expect(raisedIds).toContain('mb-ok:read');
  expect(raisedIds).not.toContain('mb-bad:read');
  expect(raisedIds).not.toContain('mb-link:read');
  expect(refusals).toEqual([
    { where: 'iris/mb-bad:read', reason: "the receipt is not signed with this checkout's message key" },
  ]);
});

test('a record with unsigned fields beside the envelope raises nothing: verified fields or none', () => {
  const at = place();
  // The envelope is valid, but the file carries impostor fields the signature does not cover.
  const payload = dropPayload(at, 'iris', 'signed-only', { at: '2026-11-02T11:20:00.000Z', from: 'true-sender' });
  const sealed = JSON.parse(signedBytes(at, payload)) as Record<string, unknown>;
  const file = { ...sealed, from: 'impostor-sender', at: '2030-01-01T00:00:00.000Z' };
  mkdirSync(join(at.dir, 'send-drops', SESSION, 'iris'), { recursive: true });
  writeFileSync(dropPath(at, 'iris', 'signed-only'), `${JSON.stringify(file, null, 2)}\n`);
  const refusals: Refusal[] = [];
  const result = pass(at, { refusals });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  // The envelope rule refuses the whole record: no arrival, so no field the signature did not
  // cover can reach an event. What a verified record does carry is the signed fields alone.
  expect(result.raised).toHaveLength(0);
  expect(logIds(at)).not.toContain('signed-only');
  expect(refusals).toEqual([{ where: 'iris/signed-only', reason: 'the record is not a signed record' }]);
  // The same record without the impostor bytes is raised, with the signed time and sender.
  writeFileSync(dropPath(at, 'iris', 'signed-only'), signedBytes(at, payload));
  const second = pass(at);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(second.reason);
  const raisedOne = second.raised.find((record) => payloadOf(record).record_id === 'signed-only');
  expect(raisedOne).toBeDefined();
  if (raisedOne === undefined) throw new Error('the pass raised no arrival for signed-only');
  expect(payloadOf(raisedOne).from).toBe('true-sender');
  expect(payloadOf(raisedOne).ts).toBe('2026-11-02T11:20:00.000Z');
  expect(JSON.stringify(payloadOf(raisedOne))).not.toContain('impostor');
});

test('the bus says each refused record once on stderr, and posts none of them', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  const lines: string[] = [];
  mkdirSync(join(at.dir, 'send-drops', SESSION, 'iris'), { recursive: true });
  writeFileSync(dropPath(at, 'iris', 'unsigned-pass'), JSON.stringify({ from: 'lead', body: 'not sealed' }));
  signedDrop(at, 'iris', 'wrong-seat-rec', { to: 'helper' });
  const started = await startBus({ root: at.root, team: teamOf(at), home: at.home, stderr: (line) => lines.push(line), reconcileIntervalMs: 0 });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') throw new Error('the bus did not start');
  buses.push(started.handle);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(held.posts).toHaveLength(0);
  const said = lines.filter((line) => line.includes('was not raised'));
  expect(said).toHaveLength(2);
  expect(said.join('\n')).toContain('iris/unsigned-pass was not raised: the record is not a signed record');
  expect(said.join('\n')).toContain('iris/wrong-seat-rec was not raised: the signed record is addressed to another seat or session');
}, 10_000);

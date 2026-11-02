// Independent scenes for the bus-nudge fix (writer-04, FLO lane fix/send-bus-nudge b6f1d18bb).
// Written against the fix's claims, not the builder's tests: a raw publish of message.arrived
// is held to the signed drop record it names; a seat.* event never reaches an adapter; a bus
// that is down or silent never fails a send and the record is delivered when the bus can take
// it; a valid send reaches a local webhook inside five seconds.
// Fixtures only: a synthetic checkout and home under short /tmp paths (the socket name limit),
// a bus this file starts and closes, a loopback HTTP receiver. No live session, pane or CLI.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { busSocket, publishToBus, startBus, type BusHandle } from '../src/bus/server.ts';
import { readEvents, type EventAppendInput } from '../src/bus/log.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readSealedRecord, recordAuthOfSealed } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const SECRET = 'writer04-synthetic-secret-value';
const NOW = new Date('2026-11-02T12:00:00.000Z');

type Place = { base: string; root: string; home: string; dir: string; urlFile: string; secretFile: string };
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
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
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

test('a raw publish naming a linked record is refused; the reconcile pass posts it — FINDING', async () => {
  const at = place(); const held = receiver();
  writeFileSync(at.urlFile, held.url + '\n');
  // The send runs with no bus, so nothing is posted while the record is a real file.
  const id = await send(at, 'iris', 'to be linked');
  const path = dropPath(at, 'iris', id);
  const elsewhere = join(at.base, 'elsewhere-copy');
  writeFileSync(elsewhere, readFileSync(path));
  rmSync(path);
  symlinkSync(elsewhere, path);
  // FINDING (pre-existing, unchanged by this fix): the startup reconcile reads the drop folder
  // with a plain file read — no linked-file refusal, unlike verifiedArrival — so it posts the
  // symlinked record's arrival to the webhook. Asserted here to document the observed
  // behavior; whether the safety net should refuse links the way the verified path does is
  // the coordinator's call.
  await bus(at);
  await until(() => held.posts.length === 1);
  expect((JSON.parse(held.posts[0]!.body) as { event: { payload: { record_id?: string } } }).event.payload.record_id).toBe(id);
  // The verified path still refuses the linked record: one post (reconcile's), never a second.
  const linked = await publishToBus(at.root, arrival(id, 'iris'));
  expect(linked.kind).toBe('refused');
  const escape = await publishToBus(at.root, arrival('..%2Fescape', 'iris'));
  expect(escape.kind).toBe('refused');
  expect(held.posts).toHaveLength(1);
  expect(logIds(at).filter((one) => one === id)).toHaveLength(1);
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

// Synthetic loopback listeners, signed drops and HOME only; no terminal or service calls.
import { afterEach, expect, test } from 'bun:test';
import { discardFixtures } from '../fixture-cleanup.ts';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverWebhook, makeWebhookDelivery } from '../../src/bus/webhook.ts';
import type { SignedEventRecord } from '../../src/bus/log.ts';
import { startBus } from '../../src/bus/server.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { SeatWebhook } from '../../src/file/types.ts';
import { signRecord, type RecordPayload } from '../../src/send/record.ts';
const SECRET = 'SYNTHETIC_WEBHOOK_HEADER_BODY_PRIVATE_VALUE';
const bases: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const reports: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  try {
    expect(reports.splice(0).join('\n').includes(SECRET)).toBe(false);
    for (const base of bases) {
      const walk = (dir: string): void => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory()) walk(path);
          else if (item.isFile() && item.name !== 'secret-value') {
            expect(fs.readFileSync(path, 'utf8').includes(SECRET)).toBe(false);
          }
        }
      }; walk(base);
    }
  } finally { const owned = bases.splice(0); if (owned.length) discardFixtures(owned); }
});
const EVENT: SignedEventRecord = { payload: {
  v: 1, seq: 7, ts: '2026-11-01T00:00:00.000Z', kind: 'message.arrived',
  session: 'hooks', record_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', from: 'sender', to: 'routine', seat: 'routine',
}, signature: 'synthetic-event-signature' };
// Pinned against the requested pre-feature base with the same real receiver.
const LEGACY_BODY = '{"v":1,"event":{"payload":{"v":1,"seq":7,"ts":"2026-11-01T00:00:00.000Z","kind":"message.arrived","session":"hooks","record_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","from":"sender","to":"routine","seat":"routine"},"signature":"synthetic-event-signature"}}';
type Hook = SeatWebhook & { header?: string; body?: 'event' | 'inbox' };
function receiver(reply: (request: Request) => Response = () => new Response(null, { status: 204 })) {
  const posts: { headers: Headers; body: string; method: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    posts.push({ headers: request.headers, body: await request.text(), method: request.method });
    return reply(request);
  } }); servers.push(server);
  return { posts, url: `http://127.0.0.1:${server.port}/receiver` };
}
function world(url: string) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'whb-'))); bases.push(base);
  const root = join(base, 'r'); fs.mkdirSync(root);
  const hook: Hook = { urlFile: join(base, 'url-value'), secretFile: join(base, 'secret-value') };
  fs.writeFileSync(hook.urlFile, url + '\n', { mode: 0o600 });
  fs.writeFileSync(hook.secretFile, SECRET + '\r\n', { mode: 0o600 });
  return { base, root, hook };
}
type World = ReturnType<typeof world>;
function team(w: World, extra: Record<string, unknown> = {}) {
  const webhook = { url_file: w.hook.urlFile, secret_file: w.hook.secretFile, ...extra };
  return validateTeamFile(`format: 1
project: hook-contract
session: hooks
operator: sender
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: sender
    leads: true
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
  - role: worker
    name: routine
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: fixture
    webhook: ${JSON.stringify(webhook)}
`);
}
function accepted(w: World, extra: Record<string, unknown> = {}) {
  const result = team(w, extra); expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('synthetic team row was refused');
  const hook = result.team.seats.find(seat => seat.name === 'routine')!.webhook!;
  return { hook, team: result.team };
}
function signedDrop(w: World, overrides: Partial<RecordPayload> = {}) {
  const payload: RecordPayload = { kind: 'message', id: EVENT.payload.record_id, to: 'routine', to_id: null,
    root: w.root, session: 'hooks', at: '2026-11-01T00:00:00.000Z', body: 'from sender\n\nsynthetic body: \"quoted\" and π\n',
    from: 'sender', from_id: null, rule: 'synthetic independent fixture', thread: EVENT.payload.record_id, ...overrides };
  const signed = signRecord(payload, homedir());
  const dir = join(w.root, '.agents', 'send-drops', 'hooks', 'routine'); fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, payload.id); fs.writeFileSync(path, JSON.stringify(signed) + '\n', { mode: 0o600 });
  return { path, signed, bytes: fs.readFileSync(path), ino: fs.statSync(path).ino, names: fs.readdirSync(dir) };
}
async function deliver(w: World, hook: Hook = w.hook, extra: Partial<Parameters<typeof deliverWebhook>[0]> = {}) {
  return deliverWebhook({ seat: 'routine', webhook: hook, record: EVENT,
    ...{ root: w.root }, policy: { timeoutMs: 500, attempts: 1, backoffMs: [0] },
    report: text => reports.push(text), ...extra });
}
/** The record is never consumed or rewritten. The delivery holds a claim beside it and leaves the
 *  `posted` note a 2xx ends it as — bookkeeping about the delivery, not the record, and the same
 *  two names the adapter and the reconciler skip by design. */
function unchanged(drop: ReturnType<typeof signedDrop>) {
  expect(fs.readFileSync(drop.path).equals(drop.bytes)).toBe(true);
  expect(fs.statSync(drop.path).ino).toBe(drop.ino);
  const id = drop.signed.payload.id;
  const beside = fs.readdirSync(join(drop.path, '..')).filter((name) => name !== `${id}.posting` && name !== `${id}.posted`);
  expect(beside).toEqual(drop.names);
}
for (const header of ['X-Routine-Key', 'Authorization', '__proto__', 'constructor', 'prototype']) {
  test('configured header ' + header + ' sends the secret line verbatim', async () => {
    const r = receiver(); const w = world(r.url); const { hook } = accepted(w, { header });
    expect(await deliver(w, hook)).toBe('delivered'); expect(r.posts).toHaveLength(1);
    const p = r.posts[0]!; expect(p.headers.get(header) === SECRET).toBe(true);
    if (header !== 'Authorization') expect(p.headers.get('authorization')).toBeNull();
    expect(p.headers.get('content-type')).toBe('application/json'); expect(p.method).toBe('POST');
    expect(p.body).toBe(LEGACY_BODY);
  });
}
for (const explicit of [false, true]) {
  test('legacy row ' + (explicit ? 'with event body' : 'without new fields') + ' preserves exact base bytes and Bearer header', async () => {
    const r = receiver(); const w = world(r.url);
    const hook = explicit ? accepted(w, { body: 'event' }).hook : accepted(w).hook;
    expect(await deliver(w, hook)).toBe('delivered'); expect(r.posts).toHaveLength(1);
    expect(r.posts[0]!.body).toBe(LEGACY_BODY);
    expect(r.posts[0]!.headers.get('authorization') === 'Bearer ' + SECRET).toBe(true);
  });
}
for (const header of ['content-type', 'Content-Type', 'CONTENT-TYPE', '', 'bad name', 'bad:field', 'bad\r\nfield', 'é', 'x'.repeat(65)]) {
  test('team row refuses invalid or reserved header ' + JSON.stringify(header), () => {
    const w = world('http://127.0.0.1:1/unused'); const result = team(w, { header });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(JSON.stringify(result.errors).includes(SECRET)).toBe(false); expect(JSON.stringify(result.errors)).toContain('header'); }
  });
}
for (const body of ['event', 'inbox'] as const) {
  test('the config parser preserves accepted header and ' + body + ' shape', () => {
    const w = world('http://127.0.0.1:1/unused'); const { hook } = accepted(w, { header: 'X-Routine-Key', body });
    const expected: Hook = { ...w.hook, header: 'X-Routine-Key', body };
    expect(hook).toEqual(expected);
  });
}
test('inbox posts the exact flattened signed record and leaves its drop unconsumed', async () => {
  const r = receiver(); const w = world(r.url); const drop = signedDrop(w);
  const hook = accepted(w, { header: 'X-Routine-Key', body: 'inbox' }).hook;
  expect(await deliver(w, hook)).toBe('delivered'); expect(r.posts).toHaveLength(1);
  expect(r.posts[0]!.headers.get('X-Routine-Key') === SECRET).toBe(true);
  expect(JSON.parse(r.posts[0]!.body)).toEqual({ id: drop.signed.payload.id, from: 'sender', kind: 'message',
    created_at: drop.signed.payload.at, body: drop.signed.payload.body, signature: drop.signed.signature });
  unchanged(drop);
});
test('a missing inbox record refuses with no POST or consumed receipt', async () => {
  const r = receiver(); const w = world(r.url); const hook = accepted(w, { body: 'inbox' }).hook;
  expect(await deliver(w, hook)).toBe('refused'); expect(r.posts).toHaveLength(0);
  expect(reports.join('\n')).toContain('drop folder');
  expect(fs.existsSync(join(w.root, '.agents', 'send-drops'))).toBe(false);
});
test('the bus delivery factory forwards root and parsed inbox/header fields', async () => {
  const r = receiver(); const w = world(r.url); const drop = signedDrop(w);
  const parsed = accepted(w, { body: 'inbox', header: 'X-Routine-Key' });
  makeWebhookDelivery({ team: parsed.team, ...{ root: w.root }, policy: { attempts: 1, timeoutMs: 500 }, stderr: text => reports.push(text) })(EVENT);
  for (let i = 0; i < 100 && !r.posts.length && !reports.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(r.posts).toHaveLength(1); expect(JSON.parse(r.posts[0]!.body).signature).toBe(drop.signed.signature);
  expect(r.posts[0]!.headers.get('X-Routine-Key') === SECRET).toBe(true); unchanged(drop);
});
test('a running synthetic bus posts the signed inbox body using the parsed custom header', async () => {
  const r = receiver(); const w = world(r.url); const drop = signedDrop(w);
  const parsed = accepted(w, { body: 'inbox', header: 'X-Routine-Key' });
  const bus = await startBus({ root: w.root, home: homedir(), team: parsed.team, reconcileIntervalMs: 0, stderr: text => reports.push(text) });
  expect(bus.kind).toBe('serving'); if (bus.kind !== 'serving') throw new Error('synthetic bus refused');
  try {
    for (let i = 0; i < 200 && !r.posts.length && !reports.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(r.posts).toHaveLength(1); expect(r.posts[0]!.headers.get('X-Routine-Key') === SECRET).toBe(true);
    expect(JSON.parse(r.posts[0]!.body)).toEqual({ id: drop.signed.payload.id, from: 'sender', kind: 'message',
      created_at: drop.signed.payload.at, body: drop.signed.payload.body, signature: drop.signed.signature });
    unchanged(drop);
  } finally { await bus.handle.close(); }
});
for (const ancestor of ['.agents', 'send-drops', 'hooks', 'routine']) {
  test('a linked ' + ancestor + ' drop-folder ancestor cannot post another project record', async () => {
    const r = receiver(); const w = world(r.url); const foreign = world(r.url); const drop = signedDrop(foreign);
    const parts = ['.agents', 'send-drops', 'hooks', 'routine']; const depth = parts.indexOf(ancestor);
    const parent = join(w.root, ...parts.slice(0, depth)); fs.mkdirSync(parent, { recursive: true });
    const link = join(parent, ancestor); fs.symlinkSync(join(foreign.root, ...parts.slice(0, depth + 1)), link);
    const outcome = await deliver(w, { ...w.hook, body: 'inbox' });
    expect(r.posts).toHaveLength(0); expect(outcome).toBe('refused');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); unchanged(drop);
  });
}
for (const field of ['root', 'session', 'to'] as const) {
  test('an inbox record bound to a different ' + field + ' is refused without posting', async () => {
    const r = receiver(); const w = world(r.url); const foreign = world(r.url);
    const overrides = field === 'root' ? { root: foreign.root } : field === 'session' ? { session: 'other-session' } : { to: 'other-routine' };
    const drop = signedDrop(w, overrides);
    expect(await deliver(w, { ...w.hook, body: 'inbox' })).toBe('refused');
    expect(r.posts).toHaveLength(0); unchanged(drop);
  });
}
for (const status of [200, 201, 202, 204, 206, 299]) {
  test('HTTP ' + status + ' counts as delivered for the inbox shape', async () => {
    const r = receiver(() => new Response(null, { status })); const w = world(r.url); const drop = signedDrop(w);
    expect(await deliver(w, { ...w.hook, body: 'inbox' })).toBe('delivered'); expect(r.posts).toHaveLength(1);
    expect(JSON.parse(r.posts[0]!.body).signature).toBe(drop.signed.signature); unchanged(drop);
  });
}
for (const status of [301, 302, 303, 307, 308]) {
  test('HTTP ' + status + ' redirects are refused without contacting their target', async () => {
    const target = receiver(); const redirect = receiver(() => new Response(null, { status, headers: { location: target.url } }));
    const w = world(redirect.url); const drop = signedDrop(w);
    const outcome = await deliver(w, { ...w.hook, header: 'X-Routine-Key', body: 'inbox' });
    // Check the target first: a redirect followed to a 2xx must not masquerade as a delivery.
    expect(target.posts.length).toBe(0); expect(outcome).toBe('failed'); expect(redirect.posts).toHaveLength(1); unchanged(drop);
  });
}
for (const mode of ['http-failure', 'throwing-fetch', 'invalid-secret']) {
  test('secret is absent from captured reports, errors and persisted files after ' + mode, async () => {
    const r = receiver(() => new Response(null, { status: 503 })); const w = world(r.url);
    const drop = signedDrop(w); let outcome: string;
    if (mode === 'invalid-secret') fs.writeFileSync(w.hook.secretFile, SECRET + '\nsecond-line');
    if (mode === 'throwing-fetch') outcome = await deliver(w, { ...w.hook, header: 'X-Routine-Key', body: 'inbox' }, {
      fetch: (() => { throw new Error('synthetic failure ' + SECRET); }) as unknown as typeof fetch,
    });
    else outcome = await deliver(w, { ...w.hook, header: 'X-Routine-Key', body: 'inbox' });
    // A 503 was answered (failed); a bare error proves nothing about the body (sent-unknown);
    // a secret this build cannot use is refused before any POST.
    const expected = mode === 'invalid-secret' ? 'refused' : mode === 'throwing-fetch' ? 'sent-unknown' : 'failed';
    expect(outcome).toBe(expected);
    expect(reports.length).toBeGreaterThan(0); expect(reports.join('\n').includes(SECRET)).toBe(false); unchanged(drop);
  });
}

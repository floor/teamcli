// The bus adapter: every accepted signed arrival for a webhook seat is POSTed to the seat's
// routine. A 2xx is delivered; anything else, a timeout or a network error leaves the drop file
// in place and is retried within a fixed bound. The secret is read from its file at POST time and
// reaches exactly one place: the request's authentication carrier.
//
// Every receiver here is a synthetic listener on a loopback port. No real URL, no real secret, no
// live seat.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignedEventRecord } from '../src/bus/log.ts';
import { startBus } from '../src/bus/server.ts';
import { WEBHOOK_POLICY, deliverWebhook, makeWebhookDelivery, webhookRoutesOf } from '../src/bus/webhook.ts';
import { signRecord, type RecordPayload, type SignedRecord } from '../src/send/record.ts';
import { webhookRouteOf } from '../src/send/webhook.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const made: string[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-webhook-')));
  made.push(base);
  return base;
}

/** What the synthetic receiver saw, in order. */
type Hit = { url: string; method: string; headers: Record<string, string>; authorization: string; body: string };
type Receiver = { url: string; hits: Hit[]; respond: (hit: Hit) => Response | Promise<Response> };

/** A listener on a loopback port that records every request and answers with `respond`. */
function receiver(answer: (hit: Hit) => Response | Promise<Response>): Receiver {
  const hits: Hit[] = [];
  const seen = { respond: answer } as Receiver;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const hit: Hit = {
        url: new URL(request.url).pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
      };
      hits.push(hit);
      return seen.respond(hit);
    },
  });
  servers.push(server);
  seen.url = `http://127.0.0.1:${server.port}/routine`;
  seen.hits = hits;
  return seen;
}

/** Two files: the routine's URL, and the secret only the POST may carry. */
function files(base: string, url: string, secret = 'synthetic-secret-value'): { urlFile: string; secretFile: string } {
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, url + '\n');
  writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

/** The team file the bus is started with: one webhook seat. */
function teamWith(base: string, webhook: { urlFile: string; secretFile: string; header?: string; body?: string } | null) {
  const row = webhook === null ? '' : [
    '    webhook:',
    `      url_file: ${JSON.stringify(webhook.urlFile)}`,
    `      secret_file: ${JSON.stringify(webhook.secretFile)}`,
    ...(webhook.header === undefined ? [] : [`      header: ${JSON.stringify(webhook.header)}`]),
    ...(webhook.body === undefined ? [] : [`      body: ${webhook.body}`]),
    '',
  ].join('\n');
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: iris
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${row}`;
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(parsed.errors.map((problem) => problem.message).join('; '));
  return parsed.team;
}

let seq = 0;
/** An accepted arrival for iris, shaped like the record the bus writes. */
function arrival(to = 'iris', recordId?: string): SignedEventRecord {
  seq += 1;
  return {
    signature: `sig-${seq}`,
    payload: {
      v: 1,
      seq,
      ts: '2026-11-01T00:00:00.000Z',
      kind: 'message.arrived',
      session: 'acme',
      record_id: recordId ?? `msg-${seq}`,
      from: 'lead',
      to,
      seat: to,
    },
  };
}

const MESSAGE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** One message record as a send writes it, for the arrival at `id` to name. */
function messagePayload(root: string, id: string): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'iris',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-01T00:00:00.000Z',
    body: 'from lead\n\nhello from the bus scene\n',
    from: 'lead',
    from_id: null,
    rule: 'a synthetic admission',
    thread: id,
  };
}

/** Writes that record where the seat's pull reads it, signed with the scratch home's key. A
 *  patch changes the record's own fields while it still sits in the folder it was written to. */
function signedDrop(home: string, root: string, id: string, patch: Partial<RecordPayload> = {}): SignedRecord {
  const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(dir, { recursive: true });
  const signed = signRecord({ ...messagePayload(root, id), ...patch }, home);
  writeFileSync(join(dir, id), `${JSON.stringify(signed, null, 2)}\n`);
  return signed;
}

/** A drop file the seat's pull would read: the backup that must survive every refusal. */
function dropFile(base: string): string {
  const dir = join(base, 'acme', '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'msg-1');
  writeFileSync(path, 'hello from the bus scene\n');
  return path;
}

function quiet(): { lines: string[]; report: (text: string) => void } {
  const lines: string[] = [];
  return { lines, report: (text) => lines.push(text) };
}

const FAST = { timeoutMs: 1000, attempts: 3, backoffMs: [1, 1] };

test('the policy states the retry bound the shape note promised', () => {
  expect(WEBHOOK_POLICY.attempts).toBe(3);
  expect(WEBHOOK_POLICY.timeoutMs).toBe(5000);
  expect([...WEBHOOK_POLICY.backoffMs]).toEqual([1000, 4000]);
});

test('a 2xx answer is delivered, in one POST, and the drop file is left to the seat', async () => {
  const base = scratch();
  const hook = files(base, 'http://127.0.0.1:1/routine');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const drop = dropFile(base);
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('delivered');
  expect(get.hits.length).toBe(1);
  expect(get.hits[0]?.method).toBe('POST');
  expect(said.lines).toEqual([]);
  expect(existsSync(drop)).toBe(true);
  expect(readFileSync(drop, 'utf8')).toBe('hello from the bus scene\n');
});

test('the POST carries the arrival and authenticates from the secret file, nowhere else', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 204 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const record = arrival();

  await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record,
    policy: FAST,
    report: () => {},
  });

  const hit = get.hits[0];
  expect(hit).toBeDefined();
  if (!hit) return;
  // The placeholder authentication carrier, pinned here only until the routine's own contract
  // replaces this one function; the body is the record and nothing else.
  expect(hit.authorization).toBe('Bearer synthetic-secret-value');
  const body = JSON.parse(hit.body) as { v: number; event: SignedEventRecord };
  expect(body.v).toBe(1);
  expect(body.event.payload.record_id).toBe(record.payload.record_id);
  expect(hit.body).not.toContain('synthetic-secret-value');
});

test('a seat row that names a header sends the secret verbatim there, and no Bearer header', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 204 }));
  writeFileSync(hook.urlFile, get.url + '\n');

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, header: 'x-synthetic-auth' },
    record: arrival(),
    policy: FAST,
    report: () => {},
  });

  expect(outcome).toBe('delivered');
  const hit = get.hits[0];
  expect(hit).toBeDefined();
  if (!hit) return;
  // The secret file's whole line is the header's value: no scheme word is added, and the
  // default Authorization header is not written beside it.
  expect(hit.headers['x-synthetic-auth']).toBe('synthetic-secret-value');
  expect(hit.headers.authorization).toBeUndefined();
  expect(hit.headers['content-type']).toBe('application/json');
  expect(hit.body).not.toContain('synthetic-secret-value');
});

test('the inbox body shape carries the signed message the arrival names, under the front\'s names', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const root = join(base, 'acme');
  const signed = signedDrop(base, root, MESSAGE_ID);

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, body: 'inbox' },
    record: arrival('iris', MESSAGE_ID),
    root,
    policy: FAST,
    report: () => {},
  });

  expect(outcome).toBe('delivered');
  const hit = get.hits[0];
  expect(hit).toBeDefined();
  if (!hit) return;
  const body = JSON.parse(hit.body) as Record<string, unknown>;
  expect(body).toEqual({
    id: MESSAGE_ID,
    from: 'lead',
    kind: 'message',
    created_at: '2026-11-01T00:00:00.000Z',
    body: 'from lead\n\nhello from the bus scene\n',
    signature: signed.signature,
  });
  // The bus envelope is not in it, the secret is nowhere, and the bridge's own signed-inbox
  // identity fields — a key id, a wire version, a per-record nonce — are absent rather than
  // invented: a TeamCLI message record carries none of the three.
  expect(body.event).toBeUndefined();
  expect(body.v).toBeUndefined();
  expect(body.key_id).toBeUndefined();
  expect(body.wire_version).toBeUndefined();
  expect(body.nonce).toBeUndefined();
  expect(hit.body).not.toContain('synthetic-secret-value');
});

test('the inbox body shape refuses, in plain words, when the record it names is not there', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const root = join(base, 'acme');
  mkdirSync(root, { recursive: true });
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, body: 'inbox' },
    record: arrival('iris', MESSAGE_ID),
    root,
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('refused');
  expect(get.hits.length).toBe(0);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('not posted');
  expect(said.lines[0]).toContain('not in the seat\'s drop folder');
  expect(said.lines[0]).toContain('the drop file stays in place');
  expect(said.lines.join('\n')).not.toContain('synthetic-secret-value');
});

for (const mode of ['header', 'default'] as const) {
  test(`a redirect is never followed, so the secret never reaches the ${mode} mode's second address`, async () => {
    // The routine's address is the only one the row names. A 3xx would hand the secret — the
    // custom header verbatim, or the bearer — to whatever address the answer points at.
    const base = scratch();
    const target = receiver(() => new Response('ok'));
    const hop = receiver(() => new Response(null, { status: 307, headers: { location: target.url } }));
    const hook = files(base, hop.url);
    const said = quiet();
    const webhook = mode === 'header' ? { ...hook, header: 'x-synthetic-auth' } : hook;

    const outcome = await deliverWebhook({
      seat: 'iris',
      webhook,
      record: arrival(),
      policy: { ...FAST, attempts: 1 },
      report: said.report,
    });

    expect(outcome).toBe('failed');
    expect(hop.hits.length).toBe(1);
    expect(target.hits.length).toBe(0);
    expect(said.lines.length).toBe(1);
    expect(said.lines[0]).toContain('not delivered after 1 attempts');
    expect(hop.hits[0]?.body).not.toContain('synthetic-secret-value');
  });
}

test('the inbox shape never reads through a linked seat folder, so another project cannot feed it', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok'));
  writeFileSync(hook.urlFile, get.url + '\n');
  const root = join(base, 'project');
  const outside = join(base, 'other-project');
  signedDrop(base, outside, MESSAGE_ID);
  const parent = join(root, '.agents', 'send-drops', 'acme');
  mkdirSync(parent, { recursive: true });
  symlinkSync(join(outside, '.agents', 'send-drops', 'acme', 'iris'), join(parent, 'iris'));
  const outsideFile = join(outside, '.agents', 'send-drops', 'acme', 'iris', MESSAGE_ID);
  const original = readFileSync(outsideFile, 'utf8');
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: { ...hook, body: 'inbox' },
    record: arrival('iris', MESSAGE_ID),
    root,
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('refused');
  expect(get.hits.length).toBe(0);
  expect(readFileSync(outsideFile, 'utf8')).toBe(original);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('not posted');
  expect(said.lines[0]).toContain('leads outside the project');
});

test('the inbox shape posts only a record addressed to this seat, session and project', async () => {
  // Each variant is a signed record written into this seat's own drop folder, but addressed
  // somewhere else: the seat, the session, or the project folder it names differ from the run's.
  const variants: Partial<RecordPayload>[] = [
    { to: 'lead' },
    { session: 'another-session' },
    { root: '/nonexistent/other-project' },
  ];
  for (const patch of variants) {
    const base = scratch();
    const hook = files(base, '');
    const get = receiver(() => new Response('ok'));
    writeFileSync(hook.urlFile, get.url + '\n');
    const root = join(base, 'acme');
    signedDrop(base, root, MESSAGE_ID, patch);
    const said = quiet();

    const outcome = await deliverWebhook({
      seat: 'iris',
      webhook: { ...hook, body: 'inbox' },
      record: arrival('iris', MESSAGE_ID),
      root,
      policy: FAST,
      report: said.report,
    });

    expect(outcome, JSON.stringify(patch)).toBe('refused');
    expect(get.hits.length).toBe(0);
    expect(said.lines.length).toBe(1);
    expect(said.lines[0]).toContain('not addressed to this seat in this project');
  }
});

test('a non-2xx answer keeps the drop and stops after three attempts, in plain words', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('no', { status: 500 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const drop = dropFile(base);
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: { ...FAST, attempts: 3 },
    report: said.report,
  });

  expect(outcome).toBe('failed');
  expect(get.hits.length).toBe(3);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('iris');
  expect(said.lines[0]).toContain('not delivered after 3 attempts');
  expect(said.lines[0]).toContain('HTTP 500');
  expect(said.lines[0]).toContain('the drop file stays in place');
  expect(readFileSync(drop, 'utf8')).toBe('hello from the bus scene\n');
});

test('a receiver that never answers times out, keeps the drop, and the retries are bounded', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Promise<Response>(() => {}));
  writeFileSync(hook.urlFile, get.url + '\n');
  const drop = dropFile(base);
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: { timeoutMs: 50, attempts: 2, backoffMs: [1] },
    report: said.report,
  });

  expect(outcome).toBe('failed');
  expect(get.hits.length).toBe(2);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('no answer within 50 ms');
  expect(readFileSync(drop, 'utf8')).toBe('hello from the bus scene\n');
});

test('the default wait between attempts runs under the plain runtime', async () => {
  // The installed CLI is the plain runtime, and the production build's types carry no bundler
  // globals: this scene bundles the delivery for node and runs it there with no sleep injected,
  // so a default that only a development runtime provides fails here rather than at the first
  // retry in the field.
  const base = scratch();
  const outdir = join(base, 'bundle');
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'webhook-node-default-retry-run.ts')],
    target: 'node',
    format: 'esm',
    outdir,
  });
  expect(built.success, built.logs.map((log) => log.message).join('\n')).toBe(true);
  const entry = built.outputs.find((output) => output.kind === 'entry-point');
  expect(entry).toBeDefined();
  const proc = Bun.spawn(['node', entry!.path], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const facts = JSON.parse(out) as { runtime: string; attempts: number; outcome: string; elapsedMs: number };
  // Both attempts were made: the wait returned on a runtime that has no bundler sleep.
  expect(facts.attempts).toBe(2);
  expect(facts.outcome).toBe('failed');
  // And it waited the policy's 60 ms backoff rather than spinning past it.
  expect(facts.elapsedMs).toBeGreaterThanOrEqual(50);
});

test('a missing secret file is refused in plain words, with no POST at all', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const secretFile = join(base, 'no-such-secret');
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: { urlFile: hook.urlFile, secretFile },
    record: arrival(),
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('refused');
  expect(get.hits.length).toBe(0);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('not posted');
  expect(said.lines[0]).toContain(secretFile);
  expect(said.lines[0]).toContain('missing or unreadable');
});

test('a secret readable by group or others is refused, naming the mode and never the value', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  chmodSync(hook.secretFile, 0o644);
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('refused');
  expect(get.hits.length).toBe(0);
  expect(said.lines.length).toBe(1);
  expect(said.lines[0]).toContain('readable by group or others');
  expect(said.lines[0]).toContain('0644');
  expect(said.lines[0]).toContain('0600');
  expect(said.lines[0]).not.toContain('synthetic-secret-value');
});

test('an empty secret file is refused too, in the same words', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  writeFileSync(hook.secretFile, '  \n', { mode: 0o600 });
  chmodSync(hook.secretFile, 0o600);
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: FAST,
    report: said.report,
  });

  expect(outcome).toBe('refused');
  expect(get.hits.length).toBe(0);
  expect(said.lines[0]).toContain('empty');
});

test('a seat without a webhook has no route, and the routes carry only the seat that has one', () => {
  const base = scratch();
  const hook = files(base, '');
  const team = teamWith(base, hook);
  const routes = webhookRoutesOf(team);
  expect(routes.has('iris')).toBe(true);
  expect(routes.has('lead')).toBe(false);
  expect(webhookRoutesOf(teamWith(base, null)).size).toBe(0);
});

test('the factory is a no-op for other kinds, other seats and duplicate-free records', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 200 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const team = teamWith(base, hook);
  const lines: string[] = [];
  const deliver = makeWebhookDelivery({ team, stderr: (text) => lines.push(text) });

  deliver(arrival('lead'));
  const otherKind = arrival('iris');
  deliver({ ...otherKind, payload: { ...otherKind.payload, kind: 'message.delivered' } });
  await Bun.sleep(50);
  expect(get.hits.length).toBe(0);

  // And the one record that does match is posted without the caller waiting on it.
  deliver(arrival());
  for (let i = 0; i < 100 && get.hits.length === 0; i += 1) await Bun.sleep(10);
  expect(get.hits.length).toBe(1);
  expect(lines).toEqual([]);
});

test('the factory never throws synchronously, even when its receiver would', async () => {
  const base = scratch();
  // A URL the adapter cannot use: the refusal must be a reported line, not an exception.
  const hook = files(base, 'not a url at all');
  const team = teamWith(base, hook);
  const lines: string[] = [];
  const deliver = makeWebhookDelivery({
    team,
    stderr: (text) => lines.push(text),
    policy: { ...FAST, attempts: 1 },
  });

  expect(() => deliver(arrival())).not.toThrow();
  for (let i = 0; i < 100 && lines.length === 0; i += 1) await Bun.sleep(10);
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('iris');
  expect(lines[0]).toContain('does not hold an http(s) URL');
  expect(lines[0]).not.toContain('synthetic-secret-value');
});

test('nothing the adapter reports contains the secret value', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('no', { status: 503 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const said = quiet();

  await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: { ...FAST, attempts: 1 },
    report: said.report,
  });

  expect(said.lines.join('\n')).not.toContain('synthetic-secret-value');
  expect(readFileSync(hook.secretFile, 'utf8').trim()).toBe('synthetic-secret-value');
});

test('a running bus posts an accepted arrival to the seat\'s webhook adapter', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 204 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  // The seat's drop folder, as the send writes it before the bus's first reconcile pass.
  const root = join(base, 'acme');
  const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
  mkdirSync(dir, { recursive: true });
  const drop = join(dir, 'msg-1');
  writeFileSync(drop, 'from lead\n\nhello from the bus scene\n');
  const lines: string[] = [];

  const started = await startBus({
    root,
    team: teamWith(base, hook),
    home: base,
    stderr: (text) => lines.push(text),
    reconcileIntervalMs: 0,
  });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') return;
  try {
    for (let i = 0; i < 200 && get.hits.length === 0; i += 1) await Bun.sleep(10);
    expect(get.hits.length).toBe(1);
    const hit = get.hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.url).toBe('/routine');
    expect(hit.authorization).toBe('Bearer synthetic-secret-value');
    expect(hit.body).not.toContain('synthetic-secret-value');
    const carrying = JSON.parse(hit.body) as { v: number; event: SignedEventRecord };
    expect(carrying.v).toBe(1);
    expect(carrying.event.payload.kind).toBe('message.arrived');
    expect(carrying.event.payload.to).toBe('iris');
    expect(carrying.event.payload.record_id).toBe('msg-1');
    expect(carrying.event.payload.from).toBe('lead');
    // Delivered or not, the drop file the seat's pull reads stays the backup.
    expect(existsSync(drop)).toBe(true);
    expect(readFileSync(drop, 'utf8')).toBe('from lead\n\nhello from the bus scene\n');
    expect(lines.join('\n')).not.toContain('not delivered');
    // Nothing the bus wrote — no record, log or drop copy — carries the secret. The fixture's
    // own two files are skipped: the secret file is where the secret belongs, and the URL file
    // holds the address, never the secret.
    const carryingSecret: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && path !== hook.urlFile && path !== hook.secretFile) {
          if (readFileSync(path, 'utf8').includes('synthetic-secret-value')) carryingSecret.push(path);
        }
      }
    };
    walk(base);
    expect(carryingSecret).toEqual([]);
  } finally {
    await started.handle.close();
  }
});

test('a running bus posts the inbox shape for a seat whose row names it', async () => {
  const base = scratch();
  const hook = files(base, '');
  const get = receiver(() => new Response('ok', { status: 204 }));
  writeFileSync(hook.urlFile, get.url + '\n');
  const root = join(base, 'acme');
  const signed = signedDrop(base, root, MESSAGE_ID);

  const started = await startBus({
    root,
    team: teamWith(base, { ...hook, body: 'inbox' }),
    home: base,
    stderr: () => {},
    reconcileIntervalMs: 0,
  });
  expect(started.kind).toBe('serving');
  if (started.kind !== 'serving') return;
  try {
    for (let i = 0; i < 200 && get.hits.length === 0; i += 1) await Bun.sleep(10);
    expect(get.hits.length).toBe(1);
    const hit = get.hits[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(body.id).toBe(MESSAGE_ID);
    expect(body.from).toBe('lead');
    expect(body.kind).toBe('message');
    expect(body.created_at).toBe('2026-11-01T00:00:00.000Z');
    expect(body.body).toBe('from lead\n\nhello from the bus scene\n');
    expect(body.signature).toBe(signed.signature);
    expect(body.event).toBeUndefined();
    // The record the seat's pull reads stays exactly where it was.
    expect(existsSync(join(root, '.agents', 'send-drops', 'acme', 'iris', MESSAGE_ID))).toBe(true);
  } finally {
    await started.handle.close();
  }
});

test('a URL that names credentials is refused at read time, and its parts are never echoed', () => {
  const base = scratch();
  const hook = files(
    base,
    'http://SYNTHETIC_USER:SYNTHETIC_URL_PASSWORD@127.0.0.1:1/hook?token=SYNTHETIC_URL_QUERY',
  );

  const route = webhookRouteOf(hook);
  expect(route?.ok).toBe(false);
  const reason = route !== null && !route.ok ? route.reason : '';
  expect(reason).toContain('credentials');
  expect(reason).not.toContain('SYNTHETIC_USER');
  expect(reason).not.toContain('SYNTHETIC_URL_PASSWORD');
  expect(reason).not.toContain('SYNTHETIC_URL_QUERY');
  expect(reason).not.toContain('http://');
});

test('a secret with an internal newline is refused at read time, and never echoed', async () => {
  const base = scratch();
  const hook = files(
    base,
    'http://127.0.0.1:1/routine',
    'SYNTHETIC_SECRET_FIRST\nSYNTHETIC_SECRET_SECOND',
  );

  const route = webhookRouteOf(hook);
  expect(route?.ok).toBe(false);
  const reason = route !== null && !route.ok ? route.reason : '';
  expect(reason).toContain('newline or control character');
  expect(reason).not.toContain('SYNTHETIC_SECRET_FIRST');
  expect(reason).not.toContain('SYNTHETIC_SECRET_SECOND');

  const said = quiet();
  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: FAST,
    report: said.report,
  });
  expect(outcome).toBe('refused');
  expect(said.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
});

test('a runtime error is reported in fixed words, never its own message', async () => {
  const base = scratch();
  const hook = files(base, 'http://127.0.0.1:1/routine');
  const said = quiet();

  const outcome = await deliverWebhook({
    seat: 'iris',
    webhook: hook,
    record: arrival(),
    policy: { ...FAST, attempts: 1 },
    report: said.report,
    fetch: (() => {
      throw new Error(
        'failed url=http://127.0.0.1:1/SYNTHETIC_URL_PATH authorization=Bearer SYNTHETIC_BEARER_SECRET',
      );
    }) as unknown as typeof fetch,
  });

  expect(outcome).toBe('failed');
  const line = said.lines.join('\n');
  expect(line).toContain('could not connect');
  expect(line).not.toContain('SYNTHETIC_URL_PATH');
  expect(line).not.toContain('SYNTHETIC_BEARER_SECRET');
  expect(line).not.toContain('failed url=');
});

test('every failure path keeps the credentials and the secret out of reports and the record', async () => {
  const base = scratch();
  const bearer = 'SYNTHETIC_BEARER_SECRET';
  const credentialUrl =
    'http://SYNTHETIC_USER:SYNTHETIC_URL_PASSWORD@127.0.0.1:1/hook?token=SYNTHETIC_URL_QUERY';
  const credentialHook = files(base, credentialUrl, bearer);
  const newlineHook = files(base, 'http://127.0.0.1:1/routine', 'SYNTHETIC_SECRET_FIRST\nSYNTHETIC_SECRET_SECOND');
  const leakingFetch = (() => {
    throw new Error(`failed url=${credentialUrl} authorization=Bearer ${bearer}`);
  }) as unknown as typeof fetch;
  const said = quiet();

  await deliverWebhook({ seat: 'iris', webhook: credentialHook, record: arrival(), policy: FAST, report: said.report });
  await deliverWebhook({ seat: 'iris', webhook: newlineHook, record: arrival(), policy: FAST, report: said.report });
  await deliverWebhook({
    seat: 'iris',
    webhook: files(base, 'http://127.0.0.1:1/routine'),
    record: arrival(),
    policy: { ...FAST, attempts: 1 },
    report: said.report,
    fetch: leakingFetch,
  });
  const answered = await deliverWebhook({
    seat: 'iris',
    webhook: files(base, 'http://127.0.0.1:1/routine'),
    record: arrival(),
    policy: { ...FAST, attempts: 1 },
    report: said.report,
    fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
  });

  expect(answered).toBe('failed');
  const everything = `${said.lines.join('\n')}\n${JSON.stringify(arrival())}`;
  for (const part of ['SYNTHETIC_USER', 'SYNTHETIC_URL_PASSWORD', 'SYNTHETIC_URL_QUERY', 'SYNTHETIC_BEARER_SECRET', 'SYNTHETIC_SECRET_FIRST', 'SYNTHETIC_SECRET_SECOND']) {
    expect(everything).not.toContain(part);
  }
});

/** What the child run (test/webhook-file-race-run.ts) observed at the swap. */
type RaceFacts = {
  swapped: boolean;
  accepted: boolean;
  valueIsPrivate: boolean;
  valueIsPublic: boolean;
  secondRefused: boolean;
  refusalNamesMode: boolean;
  reasonEchoesValue: boolean;
  parkedKept: boolean;
  modeAtPath: string;
};

test('a secret swapped between the check and the read is never used', async () => {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'webhook-file-race-run.ts')], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exit = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const facts = JSON.parse(out) as RaceFacts;
  // The swap really happened at the read: the path now holds the public 0644 file, and the
  // private file's bytes survived under the parked name.
  expect(facts.swapped).toBe(true);
  expect(facts.modeAtPath).toBe('0644');
  expect(facts.parkedKept).toBe(true);
  // What was accepted is the file whose descriptor passed the checks, never the file now at
  // the path.
  expect(facts.accepted).toBe(true);
  expect(facts.valueIsPrivate).toBe(true);
  expect(facts.valueIsPublic).toBe(false);
  // A later read sees the public 0644 file and refuses it, in words that repeat no value.
  expect(facts.secondRefused).toBe(true);
  expect(facts.refusalNamesMode).toBe(true);
  expect(facts.reasonEchoesValue).toBe(false);
});

/** What the child run (test/webhook-fifo-run.ts) observed with FIFOs at the webhook paths. */
type FifoFacts = {
  mkfifo: boolean;
  teamOk: boolean;
  urlFifoRead: { refused: boolean; reason: string; elapsedMs: number; namesKind: boolean; echoesSecret: boolean };
  secretFifoRead: { refused: boolean; reason: string; elapsedMs: number; namesKind: boolean; echoesSecret: boolean };
  fanOut: { outcome: string; elapsedMs: number; refusedInPlainWords: boolean; echoesSecret: boolean; lines: string[] };
};

test('a FIFO secret or URL is refused at once, and fanOut returns', async () => {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'webhook-fifo-run.ts')], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A FIFO with no writer never answers a blocking open. Before the read became nonblocking,
  // the child was still waiting inside openSync at this bound and was killed here.
  const killer = setTimeout(() => proc.kill('SIGKILL'), 4_000);
  const exit = await proc.exited;
  clearTimeout(killer);
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(exit, err || out).toBe(0);
  const facts = JSON.parse(out) as FifoFacts;
  expect(facts.mkfifo).toBe(true);
  expect(facts.teamOk).toBe(true);
  // Both paths refuse, in plain words that name the kind, within a short bound, and neither
  // repeats the secret file's contents.
  for (const read of [facts.urlFifoRead, facts.secretFifoRead]) {
    expect(read.refused).toBe(true);
    expect(read.reason).toContain('not a regular file');
    expect(read.reason).toContain('FIFO');
    expect(read.echoesSecret).toBe(false);
    expect(read.elapsedMs).toBeLessThan(2000);
  }
  // fanOut calls the delivery callback synchronously, so the bus can only answer the publish
  // once that callback has returned. The arrival is still published; the adapter's refusal
  // keeps the drop in place.
  expect(facts.fanOut.outcome).toBe('published');
  expect(facts.fanOut.elapsedMs).toBeLessThan(2000);
  expect(facts.fanOut.refusedInPlainWords).toBe(true);
  expect(facts.fanOut.echoesSecret).toBe(false);
  expect(facts.fanOut.lines.some((line) => line.includes('not posted'))).toBe(true);
});

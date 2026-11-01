// The bus adapter: every accepted signed arrival for a webhook seat is POSTed to the seat's
// routine. A 2xx is delivered; anything else, a timeout or a network error leaves the drop file
// in place and is retried within a fixed bound. The secret is read from its file at POST time and
// reaches exactly one place: the request's authentication carrier.
//
// Every receiver here is a synthetic listener on a loopback port. No real URL, no real secret, no
// live seat.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignedEventRecord } from '../src/bus/log.ts';
import { WEBHOOK_POLICY, deliverWebhook, makeWebhookDelivery, webhookRoutesOf } from '../src/bus/webhook.ts';
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
type Hit = { url: string; method: string; authorization: string; body: string };
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
function teamWith(base: string, webhook: { urlFile: string; secretFile: string } | null) {
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
${
  webhook === null
    ? ''
    : `    webhook:
      url_file: ${JSON.stringify(webhook.urlFile)}
      secret_file: ${JSON.stringify(webhook.secretFile)}
`
}`;
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(parsed.errors.map((problem) => problem.message).join('; '));
  return parsed.team;
}

let seq = 0;
/** An accepted arrival for iris, shaped like the record the bus writes. */
function arrival(to = 'iris'): SignedEventRecord {
  seq += 1;
  return {
    signature: `sig-${seq}`,
    payload: {
      v: 1,
      seq,
      ts: '2026-11-01T00:00:00.000Z',
      kind: 'message.arrived',
      session: 'acme',
      record_id: `msg-${seq}`,
      from: 'lead',
      to,
      seat: to,
    },
  };
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

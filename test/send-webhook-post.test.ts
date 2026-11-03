// The send posts the receiving seat's webhook adapter itself: right after the record is signed,
// once, with the adapter's own request shape and secret file, and the post holds a claim beside
// the record so the bus adapter and any reconcile pass skip it while it is in flight or once it
// was sent. So one arrival is posted once whether no bus runs, the bus is already serving, the
// bus starts after the send, or a pass runs inside the send's own post. A post that provably did
// not reach the routine releases the claim, so the bus and the seat's pull keep the fallback; one
// whose answer was never read keeps it in `sent`, and nobody posts the record again. The secret
// reaches the request's authentication carrier and nothing else: not the console, not the log,
// not the drop folder.
//
// The team is a synthetic world under a temp folder and every receiver is a loopback listener.
// No live seat, no real routine, no real secret.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySignedEvent, type SignedEventRecord } from '../src/bus/log.ts';
import { startBus, type BusHandle } from '../src/bus/server.ts';
import { makeWebhookDelivery, postArrivalWebhook, deliverWebhook, type WebhookOutcome, type WebhookPolicy } from '../src/bus/webhook.ts';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { signRecord, type RecordPayload, type SignedRecord } from '../src/send/record.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const buses: BusHandle[] = [];
const extras: string[] = [];
let made: World | null = null;
afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
  made?.cleanup();
  made = null;
  for (const dir of extras.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'synthetic-secret-value';

/** What the synthetic receiver saw, in order. */
type Hit = { url: string; method: string; headers: Record<string, string>; authorization: string; body: string };
type Receiver = { url: string; hits: Hit[]; respond: (hit: Hit) => Response | Promise<Response> };

const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

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
  stops.push(() => server.stop(true));
  seen.url = `http://127.0.0.1:${server.port}/routine`;
  seen.hits = hits;
  return seen;
}

/** The two files the seat row names: the routine's URL, and a 0600 secret only the POST carries. */
function hookFiles(url: string): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-post-')));
  extras.push(base);
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

function withHookSeat(webhook: { urlFile: string; secretFile: string }): World {
  made = world(['drop'], [{ name: 'iris', role: 'remote', webhook }]);
  return made;
}

/** The one record name in the seat's folder: the send's own record, never a marker beside it. */
function recordName(dir: string): string {
  const names = readdirSync(dir).filter(
    (name) => !name.startsWith('.') && !name.endsWith('.pending') && !name.endsWith('.fallback.json') && !name.endsWith('.posted') && !name.endsWith('.posting'),
  );
  expect(names.length).toBe(1);
  return names[0]!;
}

/** Every file in a folder, read as text: the secret is proved absent from all of them. */
function folderText(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .map((name) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

function messagePayload(root: string, id: string): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'iris',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-01T00:00:00.000Z',
    body: 'from lead\n\nhello from the send scene\n',
    from: 'lead',
    from_id: null,
    rule: 'a synthetic admission',
    thread: id,
  };
}

describe('the send posts the seat webhook itself', () => {
  test('with no bus, one POST within the second, and the line says it was delivered', async () => {
    const get = receiver(() => new Response('ok', { status: 201 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const started = Date.now();
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    const elapsed = Date.now() - started;
    expect(code, io.err).toBe(0);
    // The owner's scene is a wake that never waits on a bus: the post's own reported leg is the
    // bound that says so. The whole run carries unrelated work (config reads, the record write)
    // and is only held to "did not hang" here, so a loaded machine cannot blur the scene.
    const woke = /delivered \(webhook, (\d+) ms\)/.exec(io.out);
    expect(woke).not.toBeNull();
    expect(Number(woke?.[1] ?? '999999')).toBeLessThan(1000);
    expect(elapsed).toBeLessThan(5000);
    expect(get.hits.length).toBe(1);
    const hit = get.hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(hit.body) as { v: number; event: SignedEventRecord };
    expect(body.v).toBe(1);
    expect(body.event.payload.kind).toBe('message.arrived');
    expect(body.event.payload.to).toBe('iris');
    expect(body.event.payload.session).toBe('acme');
    expect(body.event.payload.from).toBe('owner');
    // The body is the bus's own event record, signed for this checkout: a routine that verifies
    // events accepts what the send posted, exactly as it would accept the bus's.
    expect(verifySignedEvent(body.event, at.home)).toBe(true);
    const dir = dropDir(at.dir, 'iris');
    const id = recordName(dir);
    expect(body.event.payload.record_id).toBe(id);
    // The mark sits beside the record, and the record itself is left for the seat's pull.
    expect(existsSync(join(dir, `${id}.posted`))).toBe(true);
    // The claim the post held ended as the mark; nothing is left in flight.
    expect(existsSync(join(dir, `${id}.posting`))).toBe(false);
    expect(readFileSync(join(dir, id), 'utf8')).toContain('the gate is green');
    // The line claims the delivery only because a 2xx answered, and it no longer calls the
    // arrival queued for a bus that never saw it.
    expect(io.out).toContain('delivered (webhook, ');
    expect(io.out).not.toContain('queued; its webhook fires when the bus takes it');
    // The secret reached the request's authentication carrier and nowhere else.
    expect(io.out).not.toContain(SECRET);
    expect(io.err).not.toContain(SECRET);
    expect(hit.body).not.toContain(SECRET);
    expect(folderText(at.dir)).not.toContain(SECRET);
    expect(folderText(dir)).not.toContain(SECRET);
  });

  test('with a bus already serving, exactly one POST total, and the bus takes the arrival', async () => {
    const get = receiver(() => new Response('ok', { status: 204 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const taken: SignedEventRecord[] = [];
    const deliver = makeWebhookDelivery({ team: loaded.team, root: at.root, stderr: () => {} });
    const started = await startBus({
      root: at.root,
      team: loaded.team,
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
      deliver: (record) => {
        taken.push(record);
        deliver(record);
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(io.out).toContain('delivered (webhook, ');
    expect(get.hits.length).toBe(1);
    // The bus announced the arrival too — and skipped the marked record instead of posting it
    // a second time. Waiting past the adapter's own scheduling is the evidence: a second POST
    // would have landed within milliseconds.
    await Bun.sleep(150);
    expect(get.hits.length).toBe(1);
    expect(taken.some((record) => record.payload.kind === 'message.arrived' && record.payload.to === 'iris')).toBe(true);
  });

  test('a bus that starts after the send raises the record and still posts nothing twice', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const io = owner(at.root);
    expect(await runSend(['iris', 'the gate is green'], io, fake(at)), io.err).toBe(0);
    expect(get.hits.length).toBe(1);
    const dir = dropDir(at.dir, 'iris');
    const id = recordName(dir);
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const taken: SignedEventRecord[] = [];
    const deliver = makeWebhookDelivery({ team: loaded.team, root: at.root, stderr: () => {} });
    const started = await startBus({
      root: at.root,
      team: loaded.team,
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
      deliver: (record) => {
        taken.push(record);
        deliver(record);
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    // The bus's initial pass reads the drop folder: the record is one arrival, and the mark
    // beside it is no record at all.
    expect(taken.filter((record) => record.payload.kind === 'message.arrived').length).toBe(1);
    expect(taken.some((record) => record.payload.record_id === `${id}.posted`)).toBe(false);
    await Bun.sleep(150);
    expect(get.hits.length).toBe(1);
  });

  test('a 500 leaves the send succeeding, one POST, the record in place and no mark', async () => {
    const get = receiver(() => new Response('the routine is down', { status: 500 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(get.hits.length).toBe(1);
    expect(io.out).toContain('webhook not delivered: HTTP 500');
    expect(io.out).not.toContain('delivered (webhook,');
    // No mark: the bus and the seat's pull still carry the arrival, said in the class's words.
    expect(io.out).toContain('queued; its webhook fires when the bus takes it');
    const dir = dropDir(at.dir, 'iris');
    const id = recordName(dir);
    expect(existsSync(join(dir, `${id}.posted`))).toBe(false);
    // The refused claim was given up, so the fallback may post the record.
    expect(existsSync(join(dir, `${id}.posting`))).toBe(false);
    expect(readFileSync(join(dir, id), 'utf8')).toContain('the gate is green');
    expect(io.out).not.toContain(SECRET);
  });

  test('a route that names nothing usable is no post, and the class words stand as before', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat({ urlFile: hook.urlFile, secretFile: join(hook.urlFile, '..', 'no-such-secret') });
    const io = owner(at.root);
    expect(await runSend(['iris', 'the gate is green'], io, fake(at)), io.err).toBe(0);
    expect(get.hits.length).toBe(0);
    expect(io.out).not.toContain('webhook not delivered');
    expect(io.out).not.toContain('delivered (webhook,');
  });
});

describe('the posted mark is what the adapter skips', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  function markedRecord(): SignedEventRecord {
    return {
      signature: 'synthetic',
      payload: {
        v: 1,
        seq: 1,
        ts: '2026-11-01T00:00:00.000Z',
        kind: 'message.arrived',
        session: 'acme',
        record_id: ID,
        from: 'lead',
        to: 'iris',
      },
    };
  }

  function markedWorld(withMark: boolean): { root: string; dir: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-mark-')));
    extras.push(base);
    const root = join(base, 'acme');
    const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ID), '{"synthetic":true}\n');
    if (withMark) writeFileSync(join(dir, `${ID}.posted`), '2026-11-02T00:00:00.000Z\n', { mode: 0o600 });
    return { root, dir };
  }

  test('a marked record is skipped before the route is even read', async () => {
    const { root } = markedWorld(true);
    const said: string[] = [];
    const outcome = await deliverWebhook({
      seat: 'iris',
      // A route that cannot be read would be refused — unless the mark comes first, which it does.
      webhook: { urlFile: join(root, 'no-url'), secretFile: join(root, 'no-secret') },
      record: markedRecord(),
      root,
      policy: { timeoutMs: 1000, attempts: 3, backoffMs: [1, 1] },
      report: (text) => said.push(text),
    });
    expect(outcome).toBe('skipped');
    expect(said).toEqual([]);
  });

  test('the same record without the mark is refused by the same unreadable route', async () => {
    const { root } = markedWorld(false);
    const said: string[] = [];
    const outcome = await deliverWebhook({
      seat: 'iris',
      webhook: { urlFile: join(root, 'no-url'), secretFile: join(root, 'no-secret') },
      record: markedRecord(),
      root,
      policy: { timeoutMs: 1000, attempts: 3, backoffMs: [1, 1] },
      report: (text) => said.push(text),
    });
    expect(outcome).toBe('refused');
    expect(said.length).toBe(1);
  });
});

describe('the inbox body shape needs no event', () => {
  test('a row that names the inbox body posts the signed message record itself', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-inbox-')));
    extras.push(base);
    const root = join(base, 'acme');
    const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const message: SignedRecord = signRecord(messagePayload(root, id), base);
    const outcome = await postArrivalWebhook({
      seat: 'iris',
      webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, body: 'inbox' },
      root,
      session: 'acme',
      id,
      from: 'lead',
      message,
      dropDir: dir,
      home: base,
      now: () => new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(outcome.kind).toBe('posted');
    expect(get.hits.length).toBe(1);
    const body = JSON.parse(get.hits[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({
      id,
      from: 'lead',
      kind: 'message',
      created_at: '2026-11-01T00:00:00.000Z',
      body: 'from lead\n\nhello from the send scene\n',
      signature: message.signature,
    });
    expect(existsSync(join(dir, `${id}.posted`))).toBe(true);
  });
});

describe('the claim decides who posts', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  function arrival(recordId: string = ID): SignedEventRecord {
    return {
      signature: 'synthetic',
      payload: {
        v: 1,
        seq: 1,
        ts: '2026-11-01T00:00:00.000Z',
        kind: 'message.arrived',
        session: 'acme',
        record_id: recordId,
        from: 'lead',
        to: 'iris',
      },
    };
  }

  /** A claim as a poster leaves it: the state it names, written `ageMs` ago, so the stale age is
   *  crossed without waiting for the wall clock. */
  function writeClaim(dir: string, state: 'claimed' | 'sent', ageMs: number): string {
    const path = join(dir, `${ID}.posting`);
    const at = new Date(Date.now() - ageMs);
    writeFileSync(path, `${JSON.stringify({ state, at: at.toISOString() })}\n`, { mode: 0o600 });
    utimesSync(path, at, at);
    return path;
  }

  /** The seat's drop folder with the record in it, as a poster that died mid-flight leaves it. */
  function claimWorld(): { root: string; dir: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-claim-')));
    extras.push(base);
    const root = join(base, 'acme');
    const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ID), '{"synthetic":true}\n');
    return { root, dir };
  }

  /** One delivery against the world's own record, with the route the receiver answers on. */
  function deliverAt(
    root: string,
    hook: { urlFile: string; secretFile: string },
    policy?: Partial<WebhookPolicy>,
    report?: (text: string) => void,
  ): Promise<WebhookOutcome> {
    return deliverWebhook({
      seat: 'iris',
      webhook: hook,
      record: arrival(),
      root,
      ...(policy === undefined ? {} : { policy }),
      ...(report === undefined ? {} : { report }),
    });
  }

  test('a claim a live poster holds makes a pass post nothing, without a word', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = claimWorld();
    writeClaim(at.dir, 'claimed', 0);
    const said: string[] = [];
    expect(await deliverAt(at.root, hook, undefined, (text) => said.push(text))).toBe('skipped');
    expect(get.hits.length).toBe(0);
    expect(said).toEqual([]);
  });

  test('a claim left before the request was sent is taken over once, after the stale age', async () => {
    const get = receiver(() => new Response('ok', { status: 202 }));
    const hook = hookFiles(get.url);
    const at = claimWorld();
    writeClaim(at.dir, 'claimed', 31_000);
    expect(await deliverAt(at.root, hook)).toBe('delivered');
    expect(get.hits.length).toBe(1);
    expect(existsSync(join(at.dir, `${ID}.posted`))).toBe(true);
    expect(existsSync(join(at.dir, `${ID}.posting`))).toBe(false);
    // The same record is never posted again, by this pass or a later one.
    expect(await deliverAt(at.root, hook)).toBe('skipped');
    expect(get.hits.length).toBe(1);
  });

  test('two passes that meet the same stale claim post once between them', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = claimWorld();
    writeClaim(at.dir, 'claimed', 31_000);
    const outcomes = await Promise.all([deliverAt(at.root, hook), deliverAt(at.root, hook)]);
    expect(get.hits.length).toBe(1);
    expect(outcomes.sort()).toEqual(['delivered', 'skipped']);
  });

  test('a claim left in sent is reported and never posted again', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = claimWorld();
    writeClaim(at.dir, 'sent', 31_000);
    const said: string[] = [];
    expect(await deliverAt(at.root, hook, undefined, (text) => said.push(text))).toBe('skipped');
    expect(get.hits.length).toBe(0);
    expect(said.join('\n')).toContain('never read');
    expect(existsSync(join(at.dir, `${ID}.posting`))).toBe(true);
    expect(existsSync(join(at.dir, `${ID}.posted`))).toBe(false);
  });

  test('the stale age is configurable, and a fresh claim is never taken over', async () => {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const fresh = claimWorld();
    writeClaim(fresh.dir, 'claimed', 2_000);
    expect(await deliverAt(fresh.root, hook)).toBe('skipped');
    expect(get.hits.length).toBe(0);
    const short = claimWorld();
    writeClaim(short.dir, 'claimed', 2_000);
    expect(await deliverAt(short.root, hook, { claimStaleMs: 1000 })).toBe('delivered');
    expect(get.hits.length).toBe(1);
  });

  test('a refused connection releases the claim, and the fallback is untouched', async () => {
    const at = withHookSeat(hookFiles('http://127.0.0.1:1/routine'));
    const io = owner(at.root);
    expect(await runSend(['iris', 'the gate is green'], io, fake(at)), io.err).toBe(0);
    // Measured here on 2026-11-02, Bun 1.4.2 refuses a closed loopback port with a TypeError
    // whose code is ConnectionRefused; the post faced a refused connection, so the fallback may
    // still post the record.
    expect(io.out).toContain('webhook not delivered: could not connect (ConnectionRefused)');
    expect(io.out).toContain('queued; its webhook fires when the bus takes it');
    const dir = dropDir(at.dir, 'iris');
    const id = recordName(dir);
    expect(existsSync(join(dir, `${id}.posting`))).toBe(false);
    expect(existsSync(join(dir, `${id}.posted`))).toBe(false);
  });

  test('a send whose answer never comes leaves the claim in sent, and nobody posts again', async () => {
    const hook = hookFiles('http://127.0.0.1:1/routine');
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-unknown-')));
    extras.push(base);
    const root = join(base, 'acme');
    const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    const message: SignedRecord = signRecord(messagePayload(root, ID), base);
    const timedOut = async (): Promise<Response> => {
      const error = new Error('the answer never came');
      error.name = 'TimeoutError';
      throw error;
    };
    const outcome = await postArrivalWebhook({
      seat: 'iris',
      webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, body: 'inbox' },
      root,
      session: 'acme',
      id: ID,
      from: 'lead',
      message,
      dropDir: dir,
      home: base,
      now: () => new Date(),
      fetch: timedOut as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'unknown', reason: 'no answer within 3000 ms' });
    // The claim stays, naming the state that forbids a second post.
    const held = JSON.parse(readFileSync(join(dir, `${ID}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
  });

  test("a routine that never answers is cut off at the sender's own bound, not the routine's five", async () => {
    // The deadline is measured on the wall clock: the request is built with a 3 s abort signal
    // even though the routine's own row allows five, so a person's send never waits out the bus's
    // budget. The fake transport answers only when the signal aborts, the way a real fetch does.
    const hook = hookFiles('http://127.0.0.1:1/routine');
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-webhook-deadline-')));
    extras.push(base);
    const root = join(base, 'acme');
    const dir = join(root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    const message: SignedRecord = signRecord(messagePayload(root, ID), base);
    let aborted = false;
    const hangs = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const stop = (): void => {
          aborted = true;
          const error = new Error('the answer never came');
          error.name = 'TimeoutError';
          reject(error);
        };
        const signal = init?.signal;
        if (signal === null || signal === undefined) return;
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
    }) as unknown as typeof fetch;
    const started = performance.now();
    const outcome = await postArrivalWebhook({
      seat: 'iris',
      webhook: { urlFile: hook.urlFile, secretFile: hook.secretFile, body: 'inbox', timeoutMs: 5000 },
      root,
      session: 'acme',
      id: ID,
      from: 'lead',
      message,
      dropDir: dir,
      home: base,
      now: () => new Date(),
      fetch: hangs,
    });
    const elapsed = performance.now() - started;
    expect(outcome).toEqual({ kind: 'unknown', reason: 'no answer within 3000 ms' });
    expect(aborted).toBe(true);
    // The sender's bound, not the row's five seconds; the upper bound only tolerates a slow timer.
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(5000);
  });

  test('a 2xx whose posted mark cannot be written still blocks a second post', async () => {
    // The routine answers 2xx while the drop folder refuses writes, so neither the claim's
    // rename to `posted` nor the mark beside it can land: the claim stays in `sent`, and that is
    // the state that forbids a second post.
    let dir = '';
    const get = receiver(async () => {
      chmodSync(dir, 0o500);
      return new Response('ok', { status: 200 });
    });
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    dir = dropDir(at.dir, 'iris');
    const io = owner(at.root);
    let code = -1;
    try {
      code = await runSend(['iris', 'the gate is green'], io, fake(at));
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(code, io.err).toBe(0);
    expect(get.hits.length).toBe(1);
    const id = recordName(dir);
    expect(existsSync(join(dir, `${id}.posted`))).toBe(false);
    const held = JSON.parse(readFileSync(join(dir, `${id}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    // Age the claim past the stale bound: the daemon meets it, reports it, and posts nothing.
    const old = new Date(Date.now() - 31_000);
    utimesSync(join(dir, `${id}.posting`), old, old);
    const said: string[] = [];
    expect(await deliverWebhook({ seat: 'iris', webhook: hook, record: arrival(id), root: at.root, report: (text) => said.push(text) })).toBe('skipped');
    expect(get.hits.length).toBe(1);
    expect(said.join('\n')).toContain('never read');
  });
});

describe('the bus asks a slow routine once', () => {
  test('a routine slower than the timeout gets exactly one POST, and the claim keeps it that way', async () => {
    const get = receiver(async () => {
      await Bun.sleep(300);
      return new Response('ok', { status: 200 });
    });
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const id = 'slow-routine-record';
    const dir = dropDir(at.dir, 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id), '{"synthetic":true}\n');
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const said: string[] = [];
    // The bus's own delivery function, as `fanOut` calls it: one arrival, answered too late.
    const deliver = makeWebhookDelivery({
      team: loaded.team,
      root: at.root,
      policy: { timeoutMs: 50, attempts: 3, backoffMs: [1, 1] },
      stderr: (text) => said.push(text),
    });
    const arrival: SignedEventRecord = {
      signature: 'synthetic',
      payload: {
        v: 1,
        seq: 1,
        ts: '2026-11-01T00:00:00.000Z',
        kind: 'message.arrived',
        session: 'acme',
        record_id: id,
        from: 'lead',
        to: 'iris',
      },
    };
    deliver(arrival);
    for (let i = 0; i < 100 && said.length === 0; i += 1) await Bun.sleep(10);
    // The bytes were handed over; the answer never came inside the bound. Reported once, never
    // retried — the owner's rule is that a routine is never asked twice.
    expect(said.join('\n')).toContain('sent, response unknown');
    expect(said.join('\n')).toContain('no answer within 50 ms');
    expect(said.join('\n')).toContain('not retried');
    expect(get.hits.length).toBe(1);
    const held = JSON.parse(readFileSync(join(dir, `${id}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    expect(existsSync(join(dir, `${id}.posted`))).toBe(false);
    // A later pass meets the claim this post left and adds nothing.
    deliver(arrival);
    await Bun.sleep(150);
    expect(get.hits.length).toBe(1);
  });
});

describe('the daemon takes over what a dead send left', () => {
  /** A send whose routine answered once, then its marks rewritten as a poster that died mid-post
   *  leaves them: the genuine record stays, the `posted` mark goes, and the claim names the state
   *  the poster died in. */
  async function crashedSend(state: 'claimed' | 'sent'): Promise<{ at: World; get: Receiver; dir: string; id: string }> {
    const get = receiver(() => new Response('ok', { status: 200 }));
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const io = owner(at.root);
    expect(await runSend(['iris', 'the gate is green'], io, fake(at)), io.err).toBe(0);
    expect(get.hits.length).toBe(1);
    const dir = dropDir(at.dir, 'iris');
    const id = recordName(dir);
    rmSync(join(dir, `${id}.posted`));
    const claim = join(dir, `${id}.posting`);
    const old = new Date(Date.now() - 31_000);
    writeFileSync(claim, `${JSON.stringify({ state, at: old.toISOString() })}\n`, { mode: 0o600 });
    utimesSync(claim, old, old);
    get.hits.length = 0;
    return { at, get, dir, id };
  }

  /** A bus over the world, its initial pass already done. */
  async function busFor(at: World, stderr: (text: string) => void = () => {}): Promise<void> {
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const started = await startBus({
      root: at.root,
      team: loaded.team,
      home: at.home,
      stderr,
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
  }

  test('a pass posts the record a dead send claimed but never sent, exactly once', async () => {
    const { at, get, dir, id } = await crashedSend('claimed');
    await busFor(at);
    for (let i = 0; i < 200 && get.hits.length === 0; i += 1) await Bun.sleep(10);
    expect(get.hits.length).toBe(1);
    // The post's own end lands a moment after the routine's answer.
    for (let i = 0; i < 200 && !existsSync(join(dir, `${id}.posted`)); i += 1) await Bun.sleep(10);
    expect(existsSync(join(dir, `${id}.posted`))).toBe(true);
    expect(existsSync(join(dir, `${id}.posting`))).toBe(false);
    await Bun.sleep(100);
    expect(get.hits.length).toBe(1);
  });

  test('a pass reports the record a dead send left sent, and posts nothing', async () => {
    const { at, get, dir, id } = await crashedSend('sent');
    const said: string[] = [];
    await busFor(at, (text) => said.push(text));
    await Bun.sleep(150);
    expect(get.hits.length).toBe(0);
    expect(said.join('\n')).toContain('never read');
    expect(existsSync(join(dir, `${id}.posting`))).toBe(true);
  });

  test('a reconcile pass that runs inside the send’s own post posts nothing twice', async () => {
    const get = receiver(async () => {
      await Bun.sleep(150);
      return new Response('ok', { status: 200 });
    });
    const hook = hookFiles(get.url);
    const at = withHookSeat(hook);
    const loaded = readTeamConfig(at.root, { home: at.home });
    if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
    const started = await startBus({
      root: at.root,
      team: loaded.team,
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 5,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const io = owner(at.root);
    expect(await runSend(['iris', 'the gate is green'], io, fake(at)), io.err).toBe(0);
    await Bun.sleep(250);
    // The send held the claim for the 150 ms its routine took; every pass inside that window saw
    // it and posted nothing, and the pass after the mark saw the mark.
    expect(get.hits.length).toBe(1);
  });
});

// A send to a seat with an event adapter reaches that adapter within seconds: after the drop is
// written, the send nudges the root's bus, and the bus re-reads and verifies the signed record
// before it fans the arrival out. The interval pass stays the safety net for a bus that was not
// running at send time. A nudge that names a missing or unsigned record delivers nothing.
//
// The team is a synthetic world under a temp folder, the adapter a loopback listener in this
// process, and the bus the real one. No live seat, no real routine.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBus, nudgeBus, type BusHandle } from '../src/bus/server.ts';
import type { SignedEventRecord } from '../src/bus/log.ts';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';

const extras: string[] = [];
const buses: BusHandle[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
let made: World | null = null;
afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.close();
  made?.cleanup();
  made = null;
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of extras.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = 'synthetic-secret-value';

type Hit = { method: string; url: string; authorization: string; body: string };

/** A loopback listener that records each request and answers 204. */
function receiver(): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const seen = { url: '', hits } as { url: string; hits: Hit[] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      hits.push({
        method: request.method,
        url: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
      });
      return new Response('ok', { status: 204 });
    },
  });
  servers.push(server);
  seen.url = `http://127.0.0.1:${server.port}/routine`;
  return seen;
}

/** The two files the seat row names: the listener's URL and a 0600 secret. */
function hookFiles(url: string): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-nudge-')));
  extras.push(base);
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, url + '\n');
  writeFileSync(secretFile, SECRET + '\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

function withHookSeat(webhook: { urlFile: string; secretFile: string }): World {
  made = world(['drop'], [{ name: 'iris', role: 'remote', webhook }]);
  return made;
}

async function loaded(at: World): Promise<Parameters<typeof startBus>[0]['team']> {
  const read = readTeamConfig(at.root, { home: at.home });
  if (!read.ok) throw new Error(read.errors.map((problem) => problem.message).join('; '));
  return read.team;
}

async function until(seen: () => boolean, ms: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (seen()) return true;
    await Bun.sleep(10);
  }
  return seen();
}

describe('a send nudges the bus its seat reads from', () => {
  test('the adapter is posted within five seconds of a send to its seat', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const team = await loaded(at);
    const said: string[] = [];
    const started = await startBus({
      root: at.root,
      team,
      home: at.home,
      stderr: (text) => said.push(text),
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);

    const io = owner(at.root);
    const began = Date.now();
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, `${io.err}\n${said.join('')}`).toBe(0);
    const posted = await until(() => hook.hits.length > 0, 5_000);
    expect(posted, `no POST within five seconds; bus said: ${said.join('')}`).toBe(true);
    expect(Date.now() - began).toBeLessThan(5_000);
    const sent = hook.hits[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.authorization).toBe(`Bearer ${SECRET}`);
    const carrying = JSON.parse(sent?.body ?? '{}') as { v?: number; event?: SignedEventRecord };
    expect(carrying.v).toBe(1);
    expect(carrying.event?.payload.kind).toBe('message.arrived');
    expect(carrying.event?.payload.to).toBe('iris');
  });

  test('a bus started after the send delivers the record on its pass', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const io = owner(at.root);
    const code = await runSend(['iris', 'the gate is green'], io, fake(at));
    expect(code, io.err).toBe(0);
    expect(hook.hits.length).toBe(0);

    const started = await startBus({
      root: at.root,
      team: await loaded(at),
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 0,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const posted = await until(() => hook.hits.length > 0, 5_000);
    expect(posted).toBe(true);
    const sent = hook.hits[0];
    const carrying = JSON.parse(sent?.body ?? '{}') as { event?: SignedEventRecord };
    expect(carrying.event?.payload.record_id).toBeDefined();
    expect(carrying.event?.payload.to).toBe('iris');
  });

  test('a nudge for a missing record delivers nothing', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const started = await startBus({
      root: at.root,
      team: await loaded(at),
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const answer = await nudgeBus(at.root, { session: 'acme', seat: 'iris', record_id: 'msg-absent' });
    expect(answer).toEqual({ kind: 'nudged', event: null, duplicate: false });
    await Bun.sleep(200);
    expect(hook.hits).toEqual([]);
  });

  test('a nudge for an unsigned record delivers nothing', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const started = await startBus({
      root: at.root,
      team: await loaded(at),
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const dir = join(at.root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'msg-forged'), JSON.stringify({
      payload: { kind: 'message', id: 'msg-forged', to: 'iris', root: at.root, session: 'acme', at: new Date().toISOString(), body: 'forged', from: 'lead', from_id: null, rule: 'x', thread: 'msg-forged' },
      signature: 'not-a-signature',
    }));
    const answer = await nudgeBus(at.root, { session: 'acme', seat: 'iris', record_id: 'msg-forged' });
    expect(answer).toEqual({ kind: 'nudged', event: null, duplicate: false });
    await Bun.sleep(200);
    expect(hook.hits).toEqual([]);
  });

  test('a nudge naming a signed record for another seat delivers nothing', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const started = await startBus({
      root: at.root,
      team: await loaded(at),
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const payload: RecordPayload = {
      kind: 'message',
      id: 'msg-elsewhere',
      to: 'helper',
      to_id: null,
      root: at.root,
      session: 'acme',
      at: new Date().toISOString(),
      body: 'not for iris',
      from: 'lead',
      from_id: null,
      rule: 'x',
      thread: 'msg-elsewhere',
    };
    const signed = signRecord(payload, at.home);
    expect(signed.signature).toBeTruthy();
    const dir = join(at.root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'msg-elsewhere'), JSON.stringify(signed, null, 2));
    const answer = await nudgeBus(at.root, { session: 'acme', seat: 'iris', record_id: 'msg-elsewhere' });
    expect(answer).toEqual({ kind: 'nudged', event: null, duplicate: false });
    await Bun.sleep(200);
    expect(hook.hits).toEqual([]);
  });

  test('a nudge on a signed record posts once and a repeat is a duplicate', async () => {
    const hook = receiver();
    const files = hookFiles(hook.url);
    const at = withHookSeat(files);
    const started = await startBus({
      root: at.root,
      team: await loaded(at),
      home: at.home,
      stderr: () => {},
      reconcileIntervalMs: 3_600_000,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    buses.push(started.handle);
    const payload: RecordPayload = {
      kind: 'message',
      id: 'msg-here',
      to: 'iris',
      to_id: null,
      root: at.root,
      session: 'acme',
      at: new Date().toISOString(),
      body: 'for iris',
      from: 'lead',
      from_id: null,
      rule: 'x',
      thread: 'msg-here',
    };
    const dir = join(at.root, '.agents', 'send-drops', 'acme', 'iris');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'msg-here'), JSON.stringify(signRecord(payload, at.home), null, 2));
    const first = await nudgeBus(at.root, { session: 'acme', seat: 'iris', record_id: 'msg-here' });
    expect(first.kind).toBe('nudged');
    if (first.kind !== 'nudged' || first.event === null) throw new Error('the signed record should verify');
    expect(first.event.payload.kind).toBe('message.arrived');
    expect(first.event.payload.to).toBe('iris');
    expect(first.event.payload.from).toBe('lead');
    expect(first.event.payload.record_id).toBe('msg-here');
    expect(first.duplicate).toBe(false);
    const again = await nudgeBus(at.root, { session: 'acme', seat: 'iris', record_id: 'msg-here' });
    expect(again.kind).toBe('nudged');
    if (again.kind === 'nudged') expect(again.duplicate).toBe(true);
    expect(await until(() => hook.hits.length > 0, 2_000)).toBe(true);
    await Bun.sleep(200);
    expect(hook.hits.length).toBe(1);
  });
});

// The channel driven by the event bus: a send announces `message.arrived`, the seat's serving
// inbox is subscribed to the bus as that seat, and the one record the event names is verified
// and pushed at once — no inbox poll in the path. Without a bus the server keeps its short poll.
// Fixtures only: a synthetic checkout and home under /tmp, a bus this test starts and closes,
// two inbox servers on in-memory streams; no live session, pane or CLI is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { busSocket, startBus, subscribeBusOnce, type BusHandle } from '../src/bus/server.ts';
import { announceArrival } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { channelPushPath } from '../src/mcp/channel.ts';
import { listenerPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude ${FLAG}
    leads: true
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude ${FLAG}
`;

type Place = { root: string; home: string };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function place(): Place {
  // A short base: the bus socket's path must fit the platform's socket name limit.
  const base = mkdtempSync(join(realpathSync('/tmp'), 'tcb-'));
  const root = join(base, 'r');
  const home = join(base, 'h');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return { root, home };
}

async function bus(at: Place): Promise<BusHandle> {
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error('the fixture team does not validate');
  const started = await startBus({ root: at.root, team: parsed.team, home: at.home, stderr: () => {}, reconcileIntervalMs: 0 });
  if (started.kind !== 'serving') throw new Error(`the bus did not start: ${started.kind}`);
  let closed = false;
  const handle: BusHandle = {
    close: async () => {
      if (closed) return;
      closed = true;
      await started.handle.close();
    },
    reconcileNow: () => started.handle.reconcileNow(),
  };
  cleanups.push(() => handle.close());
  return handle;
}

type Pushed = { id: string; from: string; content: string; at: number };

/** One seat's inbox server on in-memory streams; every channel notification is timed as written. */
function server(at: Place, seat: string): { pushed: Pushed[]; next(id: string): Promise<Pushed>; ready: Promise<void> } {
  const pushed: Pushed[] = [];
  const waiting = new Map<string, (one: Pushed) => void>();
  let wake: (() => void) | null = null;
  let ended = false;
  const lines = (async function* () {
    while (!ended) await new Promise<void>((resolve) => { wake = resolve; });
  })();
  const running = runMcpServe({ seat, session: SESSION }, testIo(at.root), {
    lines,
    write: (line) => {
      const one = JSON.parse(line) as Record<string, any>;
      if (one.method !== 'notifications/claude/channel') return;
      const entry: Pushed = { id: one.params.meta.id, from: one.params.meta.from, content: one.params.content, at: performance.now() };
      pushed.push(entry);
      waiting.get(entry.id)?.(entry);
    },
  }, { home: at.home });
  cleanups.push(async () => {
    ended = true;
    (wake as (() => void) | null)?.();
    await running;
  });
  const dir = join(at.root, '.agents', 'send-drops', SESSION, seat);
  const ready = (async () => {
    for (let i = 0; i < 400 && !existsSync(listenerPath(dir)); i += 1) await new Promise((r) => setTimeout(r, 5));
    // Let the server's subscription reach the bus before the first send.
    await new Promise((r) => setTimeout(r, 100));
  })();
  return {
    pushed,
    ready,
    next: (id) => new Promise<Pushed>((resolve, reject) => {
      const found = pushed.find((one) => one.id === id);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`no push for ${id} within 3 s`)), 3000);
      waiting.set(id, (one) => { clearTimeout(timer); resolve(one); });
    }),
  };
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `eeeeeeee-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

/** What `team send` does for one message, minus the walk: write the signed record into the
 *  receiver's inbox, then announce it on the bus. `announce: false` is a sender that could not. */
async function deliver(at: Place, from: string, to: string, body: string, extra: Partial<RecordPayload> = {}, announce = true): Promise<{ id: string; t0: number }> {
  const id = extra.id ?? newId();
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: new Date().toISOString(),
    body: `from ${from} — admitted by: the owner\n\n${body}`,
    from,
    from_id: null,
    rule: 'the owner',
    thread: extra.thread ?? id,
    ...extra,
  } as RecordPayload;
  const dir = join(at.root, '.agents', 'send-drops', SESSION, to);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t0 = performance.now();
  writeFileSync(join(dir, id), `${JSON.stringify(signRecord(payload, at.home), null, 2)}\n`, { mode: 0o600 });
  if (announce) await announceArrival(payload, () => new Date());
  return { id, t0 };
}

function p(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

describe('the channel on the event bus', () => {
  test('a send announces message.arrived to the receiving seat, naming the record and no body', async () => {
    const at = place();
    await bus(at);
    const { id } = await deliver(at, 'lead', 'worker', 'secret body');
    const read = await subscribeBusOnce(at.root, { seat: 'worker', cursor: 0 }, { deadlineMs: 1000 });
    expect(read.kind).toBe('events');
    if (read.kind !== 'events') return;
    const arrived = read.events.map((event) => event.payload).filter((payload) => payload.kind === 'message.arrived');
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({ record_id: id, to: 'worker', from: 'lead', session: SESSION });
    expect(JSON.stringify(arrived[0])).not.toContain('secret body');
  });

  test('lead -> worker -> reply -> lead: each leg is pushed from the bus event, p95 under 20 ms, one push per message', async () => {
    const at = place();
    await bus(at);
    const lead = server(at, 'lead');
    const worker = server(at, 'worker');
    await Promise.all([lead.ready, worker.ready]);
    const legs: number[] = [];
    const trips: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const sent = await deliver(at, 'lead', 'worker', `task ${i}`);
      const got = await worker.next(sent.id);
      legs.push(got.at - sent.t0);
      // The worker answers on the same thread as soon as its push lands.
      const reply = await deliver(at, 'worker', 'lead', `done ${i}`, { thread: sent.id, in_reply_to: sent.id } as Partial<RecordPayload>);
      const back = await lead.next(reply.id);
      legs.push(back.at - reply.t0);
      trips.push(back.at - sent.t0);
      expect(back.from).toBe('worker');
      expect(back.content).toContain(`done ${i}`);
    }
    console.log(`channel-bus: leg p50 ${p(legs, 0.5).toFixed(1)} ms, p95 ${p(legs, 0.95).toFixed(1)} ms; round trip p50 ${p(trips, 0.5).toFixed(1)} ms, p95 ${p(trips, 0.95).toFixed(1)} ms`);
    expect(p(legs, 0.95)).toBeLessThan(20);
    expect(p(trips, 0.95)).toBeLessThan(40);
    // One wake per message: no id was pushed twice, on either seat.
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.pushed).toHaveLength(20);
    expect(lead.pushed).toHaveLength(20);
    expect(new Set(worker.pushed.map((one) => one.id)).size).toBe(20);
    expect(new Set(lead.pushed.map((one) => one.id)).size).toBe(20);
  }, 30_000);

  test('without a bus the push still lands, on the poll', async () => {
    const at = place();
    const worker = server(at, 'worker');
    await worker.ready;
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const sent = await deliver(at, 'lead', 'worker', `no bus ${i}`);
      times.push((await worker.next(sent.id)).at - sent.t0);
    }
    expect(worker.pushed).toHaveLength(5);
    expect(Math.max(...times)).toBeLessThan(1000);
  }, 15_000);

  test('a bus that stops mid-run: the server falls back to its poll and loses nothing', async () => {
    const at = place();
    const handle = await bus(at);
    const worker = server(at, 'worker');
    await worker.ready;
    const first = await deliver(at, 'lead', 'worker', 'before');
    await worker.next(first.id);
    await handle.close();
    expect(existsSync(busSocket(at.root))).toBe(false);
    const second = await deliver(at, 'lead', 'worker', 'after');
    const got = await worker.next(second.id);
    expect(got.at - second.t0).toBeLessThan(1000);
    expect(worker.pushed.map((one) => one.id)).toEqual([first.id, second.id]);
  }, 15_000);

  test('a sender that could not reach the bus is still pushed, by the slow safety pass at the latest', async () => {
    const at = place();
    await bus(at);
    const worker = server(at, 'worker');
    await worker.ready;
    const quiet = await deliver(at, 'lead', 'worker', 'unannounced', {}, false);
    const got = await worker.next(quiet.id).catch(() => null);
    // The safety pass runs every five seconds; the wait above is three, so allow one more pass.
    const landed = got ?? (await new Promise<Pushed | null>((resolve) => setTimeout(() => resolve(worker.pushed.find((one) => one.id === quiet.id) ?? null), 3000)));
    expect(landed?.id).toBe(quiet.id);
    expect(worker.pushed).toHaveLength(1);
  }, 15_000);

  test('a held marker the sender left before announcing wins: the bus event pushes nothing', async () => {
    const at = place();
    await bus(at);
    const worker = server(at, 'worker');
    await worker.ready;
    const id = newId();
    const dir = join(at.root, '.agents', 'send-drops', SESSION, 'worker');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(channelPushPath(dir, id), `${JSON.stringify({ v: 1, kind: 'channel-held', id, at: new Date().toISOString(), reason: 'typed' })}\n`, { flag: 'wx', mode: 0o600 });
    await deliver(at, 'lead', 'worker', 'held', { id } as Partial<RecordPayload>);
    await new Promise((r) => setTimeout(r, 400));
    expect(worker.pushed).toHaveLength(0);
  }, 10_000);
});

// rfc-event-comms E6 on the legacy paths: the inbox read (and `team drops --read`, the same
// function) honours the exposure claim on an active root, a leg's own delivery record continues its
// claim, a read writes its one receipt and nothing in the per-seat store (the pending markers an
// earlier build's dual write left are still drained), and a pre-E6 inbox server (a listener
// marker with no level, as 85f8d5351 writes it) blocks activation.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { signRecord, stampedPayload } from '../src/send/record.ts';
import { appendDeliverySync } from '../src/queue/append.ts';
import { activate, floorState, type FloorActor } from '../src/queue/floor.ts';
import { liveFloorActors } from '../src/queue/floor-actors.ts';
import { exposeBody } from '../src/queue/exposure.ts';
import { claimRead, ownerOfClaim } from '../src/send/read-claim.ts';
import { legBody, recordDeliveredBody, settleLegBody } from '../src/send/readable-wake.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { appendRecovered, entryMsgIdAt, verifiedQueuePlaceOf } from '../src/queue/append.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { derivedProgress, drainPendingReceipts, QUEUE_PENDING_DOMAIN, readQueueReceipts } from '../src/queue/receipt-store.ts';
import { currentGenerationName } from '../src/queue/append.ts';
import { messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';
import { LEAD_ACK_PREFIX } from '../src/send/record.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { acquireLockAt } from '../src/launch/seat-lock.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };

function place(): { root: string; home: string; dropDir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e6-legacy-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
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
    model: Grok
    version: "4.7"
    launch: claude
  - role: worker
    name: worker
    cli: codex
    vendor: test
    model: Grok
    version: "4.7"
    launch: codex
`);
  return { root, home, dropDir };
}

function message(at: { root: string; home: string; dropDir: string }, id: string): void {
  // The sender decides the era when it builds the payload (E7b), as `team send` does.
  const record = signRecord(stampedPayload({
    kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION,
    at: '2026-11-18T00:00:00.000Z', body: `body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id,
  }, at.home), at.home);
  appendDeliverySync({ dropDir: at.dropDir, record }, () => {
    writeFileSync(join(at.dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: true };
  }, { home: at.home });
}

/** A signed pending dual write, as a build before the one-receipt read left it beside a queue. */
function plantPending(at: { root: string; home: string; dropDir: string }, msgId: string, nonce = 'aaaaaaaaaaaa'): string {
  const folder = join(at.root, '.agents', 'queues', SESSION, 'lead', 'pending-receipts');
  mkdirSync(folder, { recursive: true });
  const payload = { v: 1, kind: 'queue-pending', root: at.root, session: SESSION, seat: 'lead', msg_id: msgId, receipt: 'read', actor: { kind: 'recipient', name: 'lead' } };
  const signature = signDomain(QUEUE_PENDING_DOMAIN, payload as unknown as Json, messageKeyOf(at.home));
  writeFileSync(join(folder, `0000000000005.${nonce}.${msgId}.read.json`), `${JSON.stringify({ payload, signature })}\n`);
  return folder;
}

function recordOf(at: { dropDir: string }, id: string) {
  return (JSON.parse(readFileSync(join(at.dropDir, id), 'utf8')) as { payload: Parameters<typeof legBody>[0] }).payload;
}

const target = (at: { root: string; dropDir: string }) => ({ dropDir: at.dropDir, root: at.root, seat: 'lead', session: SESSION });

describe('E6 body hand-over on the E5 read claim', () => {
  const M1 = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41';
  const M2 = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42';
  const leg = (at: { root: string; dropDir: string }, id: string) => ({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', msgId: id });
  const on = (at: { root: string; home: string }) => expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');

  test('dark: no claim is taken and the read serves the body exactly as before', () => {
    const at = place();
    message(at, M1);
    expect(exposeBody(leg(at, M1), 'channel', at.home).kind).toBe('legacy');
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
  });

  test('carrier retry: a second hand-over of the same message on the same leg gets a pointer', () => {
    const at = place();
    message(at, M1);
    on(at);
    const first = exposeBody(leg(at, M1), 'socket', at.home);
    expect(first.kind).toBe('expose');
    // The first frame's outcome was inconclusive: the claim stays (exposed-unconfirmed).
    if (first.kind === 'expose') first.settle('unknown', () => true);
    expect(exposeBody(leg(at, M1), 'socket', at.home).kind).toBe('pointer');
    expect(exposeBody(leg(at, M1), 'channel', at.home).kind).toBe('pointer');
  });

  test('carrier versus legacy reader with the receipt delayed: neither the inbox read nor team messages gets the body', () => {
    const at = place();
    message(at, M1);
    on(at);
    const first = exposeBody(leg(at, M1), 'channel', at.home);
    expect(first.kind).toBe('expose');
    const read = readMessage(target(at), M1, at.home);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('already shown');
    // team messages takes the same claim (claimRead): it is refused while the hand-over holds it.
    expect(claimRead(at.dropDir, M1).ok).toBe(false);
  });

  test('a sealed hand-over writes exactly one read, through its own claim, and releases it', () => {
    const at = place();
    message(at, M1);
    on(at);
    const first = exposeBody(leg(at, M1), 'channel', at.home);
    expect(first.kind).toBe('expose');
    if (first.kind === 'expose') first.settle('yes', (owner) => recordDeliveredBody({ dropDir: at.dropDir, id: M1, root: at.root, session: SESSION, seat: 'lead', home: at.home, owner }));
    expect(existsSync(receiptPath(at.dropDir, M1))).toBe(true);
    expect(ownerOfClaim(at.dropDir, M1)).toBe(null);
    expect(readMessage(target(at), M1, at.home).ok).toBe(false);
  });

  test('after a sealed hand-over (or a sealed inbox read), a later carrier gets a pointer, never the body', () => {
    const at = place();
    message(at, M1);
    on(at);
    const first = exposeBody(leg(at, M1), 'channel', at.home);
    if (first.kind === 'expose') first.settle('yes', (owner) => recordDeliveredBody({ dropDir: at.dropDir, id: M1, root: at.root, session: SESSION, seat: 'lead', home: at.home, owner }));
    expect(exposeBody(leg(at, M1), 'socket', at.home).kind).toBe('pointer');
    // E7b: M2 is signed while the root is active, so it is stamped (at-least-once). A read is an
    // unconfirmed copy; a later carrier sends the body again, numbered, never a pointer.
    message(at, M2);
    expect(readMessage(target(at), M2, at.home).ok).toBe(true);
    expect(exposeBody(leg(at, M2), 'native', at.home).kind).toBe('legacy');
  });

  test('a sealed receipt that later cannot be proved keeps every later carrier on a pointer', () => {
    const at = place();
    message(at, M1);
    on(at);
    const first = exposeBody(leg(at, M1), 'channel', at.home);
    if (first.kind === 'expose') first.settle('yes', (owner) => recordDeliveredBody({ dropDir: at.dropDir, id: M1, root: at.root, session: SESSION, seat: 'lead', home: at.home, owner }));
    expect(ownerOfClaim(at.dropDir, M1)).toBe(null);
    // The receipt is damaged (or its key unavailable): it no longer verifies, but the name stands.
    // The carrier does not consult the key at all: any entry at the name keeps the body back.
    writeFileSync(receiptPath(at.dropDir, M1), 'not a receipt');
    expect(exposeBody(leg(at, M1), 'native', at.home).kind).toBe('pointer');
    expect(ownerOfClaim(at.dropDir, M1)).toBe(null);
  });

  test("a lead's valid clearance holds the read name: no carrier sends the body", () => {
    const at = place();
    message(at, M1);
    on(at);
    const out = publishRecordRead({ dropDir: at.dropDir, id: M1, to: 'lead', root: at.root, session: SESSION, home: at.home, key: messageKeyOf(at.home), at: '2026-11-18T00:01:00.000Z', readBy: `${LEAD_ACK_PREFIX}owner`, lead: 'lead' });
    expect(out.kind).toBe('published');
    expect(exposeBody(leg(at, M1), 'channel', at.home).kind).toBe('pointer');
  });

  test('a reader at the pre-fsync boundary (the writer holds the queue lock) proves nothing, then proves once it is released', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const writer = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in writer).toBe(true);
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
    if ('release' in writer) writer.release();
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).not.toBe(null);
  });

  test('a pending dual write an earlier build left while the queue lock was held is drained to exactly one receipt', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in holder).toBe(true);
    const pending = plantPending(at, M1);
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    const binding = { root: at.root, session: SESSION, seat: 'lead', generation };
    // Still held: the drain proves nothing and keeps the marker.
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 0, left: 1, dropped: 0 });
    if ('release' in holder) holder.release();
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 1, left: 0, dropped: 0 });
    expect(readdirSync(pending).length).toBe(0);
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 0, left: 0, dropped: 0 });
    const receipts = readQueueReceipts(binding, at.home, entryAt)!;
    expect(receipts.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
  });

  test('a read writes one receipt: no per-seat store file and no pending marker, even with the queue lock held', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    if ('release' in holder) holder.release();
    expect(existsSync(receiptPath(at.dropDir, M1))).toBe(true);
    expect(existsSync(join(base, 'pending-receipts'))).toBe(false);
    expect(existsSync(join(at.root, '.agents', 'receipts'))).toBe(false);
  });

  test('a forged or modified pending marker signs no receipt and is dropped', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const folder = join(base, 'pending-receipts');
    mkdirSync(folder, { recursive: true });
    const payload = { v: 1, kind: 'queue-pending', root: at.root, session: SESSION, seat: 'lead', msg_id: M1, receipt: 'read', actor: { kind: 'recipient', name: 'lead' } };
    writeFileSync(join(folder, `0000000000001.aaaaaaaaaaaa.${M1}.read.json`), `${JSON.stringify({ payload, signature: 'AAAA' })}\n`);
    writeFileSync(join(folder, `0000000000002.bbbbbbbbbbbb.${M1}.read.json`), `${JSON.stringify({ payload })}\n`);
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 0, left: 0, dropped: 2 });
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    const receipts = readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!;
    expect(receipts).toEqual([]);
    expect(derivedProgress(receipts).prefix).toBe(0);
  });

  test('a non-verifying marker already standing for the same message never suppresses a genuine decision', () => {
    const at = place();
    message(at, M1);
    const folder = plantPending(at, M1);
    writeFileSync(join(folder, `0000000000001.cccccccccccc.${M1}.read.json`), 'damaged\n');
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 1, left: 0, dropped: 1 });
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    expect(readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
    // The damaged marker is kept as evidence in quarantine, out of the drain's way.
    expect(readdirSync(join(folder, 'quarantine'))).toEqual([`0000000000001.cccccccccccc.${M1}.read.json`]);
  });

  test('a malformed marker sorted first (JSON null) never stops the drain: the valid one settles on the same pass', () => {
    const at = place();
    message(at, M1);
    const folder = plantPending(at, M1);
    writeFileSync(join(folder, `0000000000000.dddddddddddd.${M1}.read.json`), 'null\n');
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 1, left: 0, dropped: 1 });
  });

  test('the next holder of the queue lock drains the pending dual writes when it lets go', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    plantPending(at, M1);
    message(at, M2);
    expect(readdirSync(join(base, 'pending-receipts')).length).toBe(0);
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    expect(readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
  });

  test('a pointer enqueue never writes a read receipt (the first claim faulted, the leg carried a pointer)', () => {
    const at = place();
    message(at, M2);
    on(at);
    const holder = exposeBody(leg(at, M2), 'channel', at.home);
    expect(holder.kind).toBe('expose');
    const body = legBody(recordOf(at, M2), at.home, 'native', at.dropDir);
    expect(body.carriesBody).toBe(false);
    settleLegBody(body, 'yes', { dropDir: at.dropDir, id: M2, root: at.root, session: SESSION, seat: 'lead', home: at.home });
    expect(existsSync(receiptPath(at.dropDir, M2))).toBe(false);
  });

  test('a route that did not take the payload gives the message back (no exposure)', () => {
    const at = place();
    message(at, M1);
    on(at);
    const body = legBody(recordOf(at, M1), at.home, 'native', at.dropDir);
    expect(body.carriesBody).toBe(true);
    settleLegBody(body, 'no');
    expect(ownerOfClaim(at.dropDir, M1)).toBe(null);
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
  });

  test('two entry names at one seq prove neither placement', () => {
    const at = place();
    message(at, M1);
    message(at, M2);
    const generation = currentGenerationName(at.dropDir)!;
    // A second name claiming M1's seq for M2 (M2 also holds seq 2): no placement of either is proved.
    writeFileSync(join(at.root, '.agents', 'queues', SESSION, 'lead', generation, 'entries', `000000000001.${M2}`), '');
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
    expect(verifiedQueuePlaceOf(at.dropDir, M2, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
  });
});

describe('E6 activation against a pre-E6 inbox server', () => {
  test('E7b revision 3: a live listener marker with no level (as 85f8d5351 writes it) or at level 2 is no actor; the daemon alone decides', () => {
    for (const fields of [{ version: '0.5.22', build: 'old' }, { level: 2 }]) {
      const at = place();
      writeFileSync(join(at.dropDir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), ...fields })}\n`);
      const actors = liveFloorActors(at.root, at.home)!;
      expect(actors.filter(a => a.kind !== 'daemon')).toEqual([]);
      expect(activate(at.root, { home: at.home, build: 'b', actors: () => [daemon, ...actors.filter(a => a.kind !== 'daemon')] }).kind).toBe('activated');
    }
  });
});

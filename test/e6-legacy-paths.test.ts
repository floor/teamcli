// rfc-event-comms E6 on the legacy paths: the inbox read (and `team drops --read`, the same
// function) honours the exposure claim on an active root, a leg's own delivery record continues its
// claim, the read is dual-written to the per-seat store, and a pre-E6 inbox server (a listener
// marker with no level, as 85f8d5351 writes it) blocks activation.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { signRecord } from '../src/send/record.ts';
import { appendDeliverySync } from '../src/queue/append.ts';
import { activate, floorState, type FloorActor } from '../src/queue/floor.ts';
import { liveFloorActors } from '../src/queue/floor-actors.ts';
import { exposeBody } from '../src/queue/exposure.ts';
import { claimRead, ownerOfClaim } from '../src/send/read-claim.ts';
import { legBody, recordDeliveredBody, settleLegBody } from '../src/send/readable-wake.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { appendRecovered, entryMsgIdAt, verifiedQueuePlaceOf } from '../src/queue/append.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { derivedProgress, drainPendingReceipts, readQueueReceipts } from '../src/queue/receipt-store.ts';
import { currentGenerationName } from '../src/queue/append.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { LEAD_ACK_PREFIX } from '../src/send/record.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { acquireLockAt } from '../src/launch/seat-lock.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 2 };

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
  const record = signRecord({
    kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION,
    at: '2026-11-18T00:00:00.000Z', body: `body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id,
  }, at.home);
  appendDeliverySync({ dropDir: at.dropDir, record }, () => {
    writeFileSync(join(at.dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: true };
  }, { home: at.home });
}

function recordOf(at: { dropDir: string }, id: string) {
  return (JSON.parse(readFileSync(join(at.dropDir, id), 'utf8')) as { payload: Parameters<typeof legBody>[0] }).payload;
}

const target = (at: { root: string; dropDir: string }) => ({ dropDir: at.dropDir, root: at.root, seat: 'lead', session: SESSION });

describe('E6 body hand-over on the E5 read claim', () => {
  const M1 = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41';
  const M2 = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e42';
  const leg = (at: { root: string; dropDir: string }, id: string) => ({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', msgId: id });
  const on = (at: { root: string; home: string }) => expect(activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => [daemon] }).kind).toBe('activated');

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
    message(at, M2);
    expect(readMessage(target(at), M2, at.home).ok).toBe(true);
    expect(exposeBody(leg(at, M2), 'native', at.home).kind).toBe('pointer');
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

  test('a committed line followed by a torn or corrupt journal is not proved', () => {
    for (const tail of ['{"seq":9,"state":"res', 'not json\n']) {
      const at = place();
      message(at, M1);
      const generation = currentGenerationName(at.dropDir)!;
      const journal = join(at.root, '.agents', 'queues', SESSION, 'lead', generation, 'journal.jsonl');
      writeFileSync(journal, readFileSync(journal, 'utf8') + tail);
      expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
    }
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

  test('a malformed interior journal line (the corruption branch) proves nothing', () => {
    const at = place();
    message(at, M1);
    message(at, M2);
    const generation = currentGenerationName(at.dropDir)!;
    const journal = join(at.root, '.agents', 'queues', SESSION, 'lead', generation, 'journal.jsonl');
    const lines = readFileSync(journal, 'utf8').trimEnd().split('\n');
    const afterM1 = lines.findIndex(l => l.includes(M1) && l.includes('"committed"')) + 1;
    writeFileSync(journal, `${[...lines.slice(0, afterM1), 'not json', ...lines.slice(afterM1)].join('\n')}\n`);
    // M1's committed line sits in the valid prefix: only the corruption guard keeps it unproved.
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
  });

  test('a failed commit flush poisons the journal: no proof until a later holder flushes it, and a failing flush keeps it poisoned', () => {
    const at = place();
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const record = signRecord({
      kind: 'message', id: M1, to: 'lead', to_id: null, root: at.root, session: SESSION,
      at: '2026-11-18T00:00:00.000Z', body: 'b', from: 'worker', from_id: null, rule: 'the owner', thread: M1,
    }, at.home);
    let calls = 0;
    // The reserve line flushes; the committed line is written whole and its flush fails.
    const failCommit = () => { calls += 1; if (calls >= 2) throw new Error('EIO'); };
    appendDeliverySync({ dropDir: at.dropDir, record }, () => {
      writeFileSync(join(at.dropDir, M1), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      return { ok: true, value: true };
    }, { home: at.home, syncJournal: failCommit });
    const generation = currentGenerationName(at.dropDir)!;
    const marker = join(base, generation, 'poisoned');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(join(base, generation, 'journal.jsonl'), 'utf8')).toContain('"committed"');
    // The next opener whose flush fails too stays out and leaves the journal poisoned.
    const second = appendRecovered(at.dropDir, { root: at.root, session: SESSION, seat: 'lead' }, M1, { home: at.home, syncJournal: () => { throw new Error('EIO'); } });
    expect(second.kind).toBe('skipped');
    expect(existsSync(marker)).toBe(true);
    // A holder whose flush succeeds establishes durability, removes the marker, then proves.
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).not.toBe(null);
    expect(existsSync(marker)).toBe(false);
  });

  test('a read published while another holder has the queue lock leaves a pending dual write, drained to exactly one receipt', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in holder).toBe(true);
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    expect(existsSync(receiptPath(at.dropDir, M1))).toBe(true);
    const pending = join(base, 'pending-receipts');
    expect(readdirSync(pending).length).toBe(1);
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

  test('a read in the record-to-index window leaves a signed marker, drained to exactly one receipt after the commit', () => {
    const at = place();
    const record = signRecord({
      kind: 'message', id: M1, to: 'lead', to_id: null, root: at.root, session: SESSION,
      at: '2026-11-18T00:00:00.000Z', body: 'b', from: 'worker', from_id: null, rule: 'the owner', thread: M1,
    }, at.home);
    let readInWindow = false;
    appendDeliverySync({ dropDir: at.dropDir, record }, () => {
      writeFileSync(join(at.dropDir, M1), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      // The canonical record is published; its entry and id index are not written yet.
      readInWindow = readMessage(target(at), M1, at.home).ok;
      return { ok: true, value: true };
    }, { home: at.home });
    expect(readInWindow).toBe(true);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    // The writer's release drained the marker once the entry was placed.
    expect(readdirSync(join(base, 'pending-receipts')).length).toBe(0);
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    expect(readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
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
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const folder = join(base, 'pending-receipts');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `0000000000001.cccccccccccc.${M1}.read.json`), 'damaged\n');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    if ('release' in holder) holder.release();
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
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const folder = join(base, 'pending-receipts');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    if ('release' in holder) holder.release();
    writeFileSync(join(folder, `0000000000000.dddddddddddd.${M1}.read.json`), 'null\n');
    expect(drainPendingReceipts(at.dropDir, at.home)).toEqual({ written: 1, left: 0, dropped: 1 });
  });

  test('the next holder of the queue lock drains the pending dual writes when it lets go', () => {
    const at = place();
    message(at, M1);
    const base = join(at.root, '.agents', 'queues', SESSION, 'lead');
    const holder = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    if ('release' in holder) holder.release();
    message(at, M2);
    expect(readdirSync(join(base, 'pending-receipts')).length).toBe(0);
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    expect(readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
  });

  test('a placement whose journal line is only reserved is not proved', () => {
    const at = place();
    message(at, M1);
    const generation = currentGenerationName(at.dropDir)!;
    const journal = join(at.root, '.agents', 'queues', SESSION, 'lead', generation, 'journal.jsonl');
    const lines = readFileSync(journal, 'utf8').trim().split('\n').filter(l => !l.includes('"committed"'));
    writeFileSync(journal, `${lines.join('\n')}\n`);
    expect(verifiedQueuePlaceOf(at.dropDir, M1, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
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

  test('a read is dual-written to the per-seat store only at a proved placement', () => {
    const at = place();
    message(at, M1);
    message(at, M2);
    expect(readMessage(target(at), M1, at.home).ok).toBe(true);
    const generation = currentGenerationName(at.dropDir)!;
    const entryAt = (seq: number) => entryMsgIdAt(at.dropDir, generation, seq, { root: at.root, session: SESSION, seat: 'lead' }, at.home);
    const receipts = readQueueReceipts({ root: at.root, session: SESSION, seat: 'lead', generation }, at.home, entryAt)!;
    expect(receipts.map(r => [r.seq, r.kind])).toEqual([[1, 'read']]);
    expect(derivedProgress(receipts).prefix).toBe(1);
    // A stale id index pointing M2 at seq 1 is not a proved placement: nothing is signed for it.
    writeFileSync(join(at.root, '.agents', 'queues', SESSION, 'lead', generation, 'ids', M2), '1\n');
    expect(verifiedQueuePlaceOf(at.dropDir, M2, { root: at.root, session: SESSION, seat: 'lead' }, at.home)).toBe(null);
  });
});

describe('E6 activation against a pre-E6 inbox server', () => {
  test('a live listener marker with no level (as 85f8d5351 writes it) refuses activation', () => {
    const at = place();
    writeFileSync(join(at.dropDir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), version: '0.5.22', build: 'old' })}\n`);
    const actors = liveFloorActors(at.root, at.home)!;
    expect(actors.find(a => a.kind === 'inbox-server')).toMatchObject({ level: null });
    const out = activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => [daemon, ...actors] });
    expect(out.kind).toBe('refused');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('the same marker at level 2 lets the root activate', () => {
    const at = place();
    writeFileSync(join(at.dropDir, '.inbox-listener'), `${JSON.stringify({ v: 1, seat: 'lead', session: SESSION, root: at.root, cli: 'claude-code', pid: process.pid, ts: new Date().toISOString(), level: 2 })}\n`);
    const actors = liveFloorActors(at.root, at.home)!;
    expect(activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => [daemon, ...actors] }).kind).toBe('activated');
  });
});

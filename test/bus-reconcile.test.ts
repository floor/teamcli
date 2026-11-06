import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents, type EventPayload } from '../src/bus/log.ts';
import { OWNER_MAILBOX, OwnerDelivery } from '../src/bus/owner.ts';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { appendHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending } from '../src/send/pending.ts';
import { signReceiptPayload, signRecord, type RecordPayload } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf, messageKeyPath, RECEIPT_DOMAIN, signDomain } from '../src/store/keys.ts';

const dirs: string[] = [];

const SAMPLE_TEAM_YAML = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-reconcile-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  // The pass reads the team's configuration once to know which seat may write a clearance: a
  // receipt naming any other seat raises nothing.
  writeFileSync(join(root, '.agents', 'team.yaml'), SAMPLE_TEAM_YAML);
  return { root, home };
}

/** One message record as a send writes it into the seat's drop folder. */
function dropRecord(
  at: { root: string; home: string },
  seat: string,
  id: string,
  options: { from?: string; ts?: string; thread?: string } = {},
): void {
  const dir = join(at.root, '.agents', 'send-drops', 'acme', seat);
  mkdirSync(dir, { recursive: true });
  const from = options.from ?? 'clerk';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: at.root,
    session: 'acme',
    at: options.ts ?? '2026-10-18T12:00:00.000Z',
    body: `from ${from} — admitted by: lead\n\nhello ${id}`,
    from,
    from_id: null,
    rule: 'a synthetic admission',
    thread: options.thread ?? id,
  };
  dropMessage(dir, id, `${JSON.stringify(signRecord(payload, at.home), null, 2)}\n`);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bus reconciliation pass (RFC 002 Amendment 01 §4.2)', () => {
  test('reconciles send-drops, held .pending markers, and .delivered/.read/.replied receipts idempotently', () => {
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });

    // 1. Signed drop record written by a tool that crashed before publishing to the bus.
    dropRecord({ root, home }, 'worker-1', 'drop-1', { ts: '2026-10-18T12:00:00.000Z' });
    dropMessage(seatDir, 'drop-1.delivered', '{"ok":true}');
    dropMessage(seatDir, 'drop-1.read', '{"ok":true}');
    dropMessage(seatDir, 'drop-1.replied', '{"ok":true}');

    // 2. Held send with `.pending` marker past held_threshold_seconds (15m old >= 600s).
    dropRecord({ root, home }, 'worker-1', 'drop-2', { from: 'owner', ts: '2026-10-18T11:55:00.000Z' });
    markPending(seatDir, {
      id: 'drop-2',
      from: 'owner',
      to: 'worker-1',
      body: 'from the owner — admitted by: the owner\n\nheld drop 2',
      ts: '2026-10-18T11:55:00.000Z',
    });

    // 3. Fresh held send with `.pending` marker before held_threshold_seconds (2m old < 600s).
    dropRecord({ root, home }, 'worker-1', 'drop-3', { from: 'owner', ts: '2026-10-18T12:08:00.000Z' });
    markPending(seatDir, {
      id: 'drop-3',
      from: 'owner',
      to: 'worker-1',
      body: 'from the owner — admitted by: the owner\n\nfresh held drop 3',
      ts: '2026-10-18T12:08:00.000Z',
    });

    const first = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const kindsAndIds = first.raised.map((r) => `${r.payload.kind}:${r.payload.record_id}`);
    expect(kindsAndIds).toContain('message.arrived:drop-1');
    expect(kindsAndIds).toContain('message.delivered:drop-1:delivered');
    expect(kindsAndIds).toContain('message.read:drop-1:read');
    expect(kindsAndIds).toContain('message.replied:drop-1:replied');
    expect(kindsAndIds).toContain('message.arrived:drop-2');
    expect(kindsAndIds).toContain('message.held:drop-2:held');
    expect(kindsAndIds).toContain('message.arrived:drop-3');
    expect(kindsAndIds).not.toContain('message.held:drop-3:held');

    // Second pass 1 minute later (drop-3 still < 10m old) raises 0 new events (idempotent).
    const second = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:11:00.000Z'),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.raised.length).toBe(0);

    // Third pass once drop-3 crosses held_threshold_seconds raises only message.held:drop-3:held.
    const third = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:20:00.000Z'),
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.raised.map((r) => `${r.payload.kind}:${r.payload.record_id}`)).toEqual(['message.held:drop-3:held']);

    const log = readEvents('acme', root, home);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.events.length).toBe(first.raised.length + third.raised.length);
  });

  test('side files beside a record are never arrivals; only the signed record is raised', () => {
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });
    // The record itself is signed, as a send writes it; only the side files are raw.
    dropRecord({ root, home }, 'worker-1', 'drop-9');
    // The bookkeeping the watch, the channel push and a thread close leave beside the record.
    // Their names match a record's shape, but none of them is a message any seat was sent.
    for (const side of ['drop-9.wake', 'drop-9.reported', 'drop-9.channel-push.json', 'drop-9.closed.json']) {
      dropMessage(seatDir, side, '{"ok":true}');
    }

    const pass = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    const arrived = pass.raised
      .filter((record) => record.payload.kind === 'message.arrived')
      .map((record) => record.payload.record_id);
    expect(arrived).toEqual(['drop-9']);
  });

  test('a lead-ack receipt is raised as cleared by its writer, never as the seat\'s own read', () => {
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });
    dropRecord({ root, home }, 'worker-1', 'drop-9');
    dropRecord({ root, home }, 'worker-1', 'drop-10');
    // The two receipts have the same name shape and signature; only the lead's names who cleared.
    const cleared = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: 'drop-9',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:05:00.000Z',
      read_by: 'lead-ack:clerk',
    }, home);
    writeFileSync(join(seatDir, 'drop-9.read.json'), `${JSON.stringify(cleared, null, 2)}\n`);
    const plain = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: 'drop-10',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:06:00.000Z',
    }, home);
    writeFileSync(join(seatDir, 'drop-10.read.json'), `${JSON.stringify(plain, null, 2)}\n`);

    const pass = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    const reads = pass.raised.filter((record) => record.payload.kind === 'message.read');
    const byId = (id: string) => reads.find((record) => record.payload.record_id === id);
    // The lead's receipt is a clearance, and the step says who wrote it. It is still not the
    // seat's read, so no `delivered (read)` consequence follows from it anywhere.
    expect(byId('drop-9:read')?.payload.outcome).toBe('cleared by clerk');
    expect(byId('drop-9:read')?.payload.reason).toBe('cleared by clerk');
    // A receipt without `read_by` is the ordinary read it always was, with no clearance note.
    expect(byId('drop-10:read')).toBeDefined();
    expect(byId('drop-10:read')?.payload.outcome).toBeUndefined();
    expect(byId('drop-10:read')?.payload.reason).toBeUndefined();
  });

  test('a clearance naming a seat that is not the lead raises no read step at all', () => {
    // The message key is the checkout's, shared by every seat: a signed `read_by` naming any name
    // proves only that a seat wrote it. The pass admits the owner or the team's own lead, so a
    // receipt naming another seat is not a clearance and the reader is never reported as one.
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });
    dropRecord({ root, home }, 'worker-1', 'drop-11');
    const forged = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: 'drop-11',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:05:00.000Z',
      read_by: 'lead-ack:op-1',
    }, home);
    writeFileSync(join(seatDir, 'drop-11.read.json'), `${JSON.stringify(forged, null, 2)}\n`);

    const pass = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    // `op-1` is a listed seat, not the coordinator: nothing settled, so nothing is raised for it.
    const reads = pass.raised.filter((record) => record.payload.kind === 'message.read');
    expect(reads.map((record) => record.payload.record_id)).not.toContain('drop-11:read');
  });

  test('a key-blind pass stores no verdict, so a keyed pass raises the signed read', () => {
    // A pass that cannot read the message key cannot tell a signed receipt from a plant. It must
    // leave the file for the next pass: storing an `unverified` verdict by stamp would keep a
    // receipt this checkout signed unraised for the bus's whole lifetime.
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });
    dropRecord({ root, home }, 'worker-1', 'drop-14');
    const read = signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id: 'drop-14',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:05:00.000Z',
    }, home);
    writeFileSync(join(seatDir, 'drop-14.read.json'), `${JSON.stringify(read, null, 2)}\n`);

    const keyPath = messageKeyPath(home);
    const hidden = `${keyPath}.hidden`;
    const state = createReconcileState();
    renameSync(keyPath, hidden);
    try {
      const blind = reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        state,
        now: new Date('2026-10-18T12:10:00.000Z'),
      });
      expect(blind.ok).toBe(true);
      if (!blind.ok) return;
      expect(blind.raised.filter((record) => record.payload.kind === 'message.read')).toHaveLength(0);
    } finally {
      renameSync(hidden, keyPath);
    }

    const keyed = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      now: new Date('2026-10-18T12:11:00.000Z'),
    });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.raised.filter((record) => record.payload.kind === 'message.read').map((record) => record.payload.record_id))
      .toEqual(['drop-14:read']);

    const again = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      now: new Date('2026-10-18T12:12:00.000Z'),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.raised.filter((record) => record.payload.kind === 'message.read')).toHaveLength(0);
  });

  test('an unsigned receipt raises no read step, least of all a clearance', () => {
    // A `.read.json` beside a drop is a signed envelope in this build. An unsigned plant whose
    // bytes this checkout's key never signed proves nothing by its name: it must leave no
    // clearance some lead wrote, and no read step either, exactly as the settle side reads the
    // same file.
    const { root, home } = makeScratch();
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-1');
    mkdirSync(seatDir, { recursive: true });
    dropRecord({ root, home }, 'worker-1', 'drop-12');
    dropRecord({ root, home }, 'worker-1', 'drop-13');
    const forged = (id: string, readBy: string | undefined): string => JSON.stringify({
      payload: {
        kind: 'receipt',
        status: 'read',
        id,
        to: 'worker-1',
        root,
        session: 'acme',
        at: '2026-10-18T12:05:00.000Z',
        ...(readBy === undefined ? {} : { read_by: readBy }),
      },
    }, null, 2);
    writeFileSync(join(seatDir, 'drop-12.read.json'), `${forged('drop-12', 'lead-ack:clerk')}\n`);
    writeFileSync(join(seatDir, 'drop-13.read.json'), `${forged('drop-13', undefined)}\n`);

    const pass = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(pass.ok).toBe(true);
    if (!pass.ok) return;
    const reads = pass.raised
      .filter((record) => record.payload.kind === 'message.read')
      .map((record) => record.payload.record_id);
    expect(reads).not.toContain('drop-12:read');
    expect(reads).not.toContain('drop-13:read');
  });

  test('a pass verifies the whole log once, then only the events appended since its last read', () => {
    const { root, home } = makeScratch();
    for (const id of ['seed-1', 'seed-2', 'seed-3']) {
      const appended = appendEvent('acme', root, home, {
        ts: '2026-10-18T12:00:00.000Z',
        kind: 'message.arrived',
        session: 'acme',
        record_id: id,
        to: 'worker-1',
      });
      expect(appended.ok).toBe(true);
    }
    dropRecord({ root, home }, 'worker-1', 'drop-1');

    const first = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:10:00.000Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.full).toBe(true);
    expect(first.checked).toBe(3);
    expect(first.raised.map((record) => record.payload.record_id)).toEqual(['drop-1']);

    // The second pass checks only the record the first pass appended.
    const second = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:11:00.000Z'),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.full).toBe(false);
    expect(second.checked).toBe(1);
    expect(second.raised).toHaveLength(0);

    // With nothing appended, a pass checks no signature at all.
    const quiet = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:12:00.000Z'),
    });
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) return;
    expect(quiet.full).toBe(false);
    expect(quiet.checked).toBe(0);
    expect(quiet.raised).toHaveLength(0);

    // A new durable record is raised, and the pass that follows it is the one that checks it.
    dropRecord({ root, home }, 'worker-1', 'drop-2', { ts: '2026-10-18T12:13:00.000Z' });
    const raised = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:13:00.000Z'),
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(raised.checked).toBe(0);
    expect(raised.raised.map((record) => record.payload.record_id)).toEqual(['drop-2']);
    const after = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:14:00.000Z'),
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.checked).toBe(1);
    expect(after.raised).toHaveLength(0);
  });

  test('reconciles signed .agents/messages/<seat> records, .read.json receipts, messages.jsonl history, and seat states', () => {
    const { root, home } = makeScratch();

    // Signed mailbox message + receipt.
    plantMessage(home, root, 'worker-1', 'msg-signed-1', {
      kind: 'message',
      id: 'msg-signed-1',
      from: 'clerk',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:00:00.000Z',
      body: 'signed body',
    });
    const receiptPayload = {
      kind: 'receipt' as const,
      id: 'msg-signed-1',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-10-18T12:01:00.000Z',
    };
    const sig = signDomain(RECEIPT_DOMAIN, receiptPayload, messageKeyOf(home));
    writeFileSync(receiptFile(root, 'worker-1', 'msg-signed-1'), JSON.stringify({ payload: receiptPayload, signature: sig }));

    // History entry in messages.jsonl, backed by the signed drop record it names.
    dropRecord({ root, home }, 'worker-2', 'hist-1', { ts: '2026-10-18T12:02:00.000Z' });
    appendHistory('acme', root, home, {
      ts: '2026-10-18T12:02:00.000Z',
      from: 'clerk',
      to: 'worker-2',
      body: 'history body',
      id: 'hist-1',
      outcome: 'delivered (read)',
      via: 'mcp-inbox',
    });
    // A late webhook answer is a delivery, and it is not a read.
    dropRecord({ root, home }, 'worker-2', 'hist-late', { ts: '2026-10-18T12:02:30.000Z' });
    appendHistory('acme', root, home, {
      ts: '2026-10-18T12:02:30.000Z',
      from: 'clerk',
      to: 'worker-2',
      body: 'late webhook body',
      id: 'hist-late',
      outcome: 'delivered (late)',
      via: 'webhook',
    });

    // Seat state in `.agents/team.state.json`.
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-1'] = {
        stage: 'ready',
        cli: 'claude-code',
        pane: 's1:p2',
        workspace: 'ws1',
        last_active: '2026-10-18T12:03:00.000Z',
      };
    });

    const first = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:05:00.000Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const raisedKeys = first.raised.map((e) => `${e.payload.kind}:${e.payload.record_id}`);
    expect(raisedKeys).toContain('message.arrived:msg-signed-1');
    expect(raisedKeys).toContain('message.read:msg-signed-1:read');
    expect(raisedKeys).toContain('message.arrived:hist-1');
    expect(raisedKeys).toContain('message.delivered:hist-1:delivered');
    expect(raisedKeys).toContain('message.read:hist-1:read');
    expect(raisedKeys).toContain('message.delivered:hist-late:delivered');
    expect(raisedKeys).not.toContain('message.read:hist-late:read');
    expect(raisedKeys).toContain('seat.working:seat:worker-1:ready:2026-10-18T12:03:00.000Z');

    // Re-running with the same state raises nothing.
    const again = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:06:00.000Z'),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.raised.length).toBe(0);
  });

  test('history lines with no verifying drop record raise nothing and are refused once', () => {
    const { root, home } = makeScratch();
    // A key is held, so each refusal below is about the record the line names, not a missing key.
    mkdirSync(home, { recursive: true });
    messageKeyOf(home);
    const seatDir = join(root, '.agents', 'send-drops', 'acme', 'worker-2');
    mkdirSync(seatDir, { recursive: true });
    // A line whose record was never written, and one whose record does not verify.
    const unbacked = appendHistory('acme', root, home, {
      ts: '2026-10-18T12:02:00.000Z',
      from: 'clerk',
      to: 'worker-2',
      body: 'a line with nothing behind it',
      id: 'hist-unbacked',
      outcome: 'delivered (read)',
      via: 'mcp-inbox',
    });
    expect(unbacked.ok).toBe(true);
    writeFileSync(join(seatDir, 'hist-tampered'), '{"payload":{"id":"hist-tampered"},"signature":"bad"}\n');
    const tampered = appendHistory('acme', root, home, {
      ts: '2026-10-18T12:02:00.000Z',
      from: 'clerk',
      to: 'worker-2',
      body: 'a line whose record does not verify',
      id: 'hist-tampered',
      outcome: 'delivered',
      via: 'mcp-inbox',
    });
    expect(tampered.ok).toBe(true);

    const refusals: { where: string; reason: string }[] = [];
    const state = createReconcileState();
    const pass = (now: string) => reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date(now),
      state,
      onRefused: (refusal) => refusals.push(refusal),
    });
    const first = pass('2026-10-18T12:05:00.000Z');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const raisedKeys = first.raised.map((e) => `${e.payload.kind}:${e.payload.record_id}`);
    expect(raisedKeys).not.toContain('message.arrived:hist-unbacked');
    expect(raisedKeys).not.toContain('message.arrived:hist-tampered');
    expect(raisedKeys).not.toContain('message.delivered:hist-unbacked:delivered');
    expect(refusals.filter((only) => only.where === 'worker-2/hist-unbacked (history)')).toHaveLength(1);
    expect(refusals.find((only) => only.where === 'worker-2/hist-unbacked (history)')?.reason)
      .toBe('the history line names no signed drop record this checkout can verify');
    expect(refusals.filter((only) => only.where === 'worker-2/hist-tampered (history)')).toHaveLength(1);

    const again = pass('2026-10-18T12:06:00.000Z');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.raised.length).toBe(0);
    expect(refusals.filter((only) => only.where === 'worker-2/hist-unbacked (history)')).toHaveLength(1);
    expect(refusals.filter((only) => only.where === 'worker-2/hist-tampered (history)')).toHaveLength(1);
  });

  test('a digest record raises no message.arrived, so repeated passes over one owner record write exactly one digest', () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // One signed message in the owner's mailbox, written by another seat.
    plantMessage(home, root, OWNER_MAILBOX, 'msg-owner-1', {
      kind: 'message',
      id: 'msg-owner-1',
      from: 'clerk',
      to: OWNER_MAILBOX,
      root,
      session: 'acme',
      at: '2026-10-18T12:00:00.000Z',
      body: 'one note for the owner',
    });
    const ownerDir = join(root, '.agents', 'messages', OWNER_MAILBOX);
    const digests = () => readdirSync(ownerDir).filter((file) => /^digest-[0-9a-f]{16}\.json$/.test(file));

    // Pass one raises the owner message; delivery batches it into the pass's one digest.
    const first = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:01:00.000Z'),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.raised.map((r) => `${r.payload.kind}:${r.payload.record_id}`)).toEqual([
      'message.arrived:msg-owner-1',
    ]);
    const notes: string[] = [];
    const delivery = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });
    for (const record of first.raised) delivery.onEvent(record.payload);
    expect(delivery.flush()).toEqual({ addressed: true, notified: false, recorded: true });
    expect(notes).toEqual([]);
    expect(digests()).toHaveLength(1);

    // Pass two rescans the mailbox, the digest record included: it raises nothing new, so the
    // owner's pass has nothing to batch and no second digest appears.
    const second = reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      now: new Date('2026-10-18T12:02:00.000Z'),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.raised).toHaveLength(0);
    const replay = new OwnerDelivery({
      root,
      session: 'acme',
      team: parsed.team,
      home,
      notify: (text) => notes.push(text),
    });
    for (const record of second.raised) replay.onEvent(record.payload);
    expect(replay.flush()).toBeUndefined();
    expect(notes).toEqual([]);
    expect(digests()).toHaveLength(1);

    // A log written before this guard still carries the digest's own `message.arrived`: delivery
    // drops it rather than summarizing the summary.
    const stale: EventPayload = {
      v: 1,
      seq: 99,
      ts: '2026-10-18T12:01:00.000Z',
      session: 'acme',
      kind: 'message.arrived',
      record_id: digests()[0]!.replace(/\.json$/, ''),
      to: OWNER_MAILBOX,
      from: 'runtime',
    };
    expect(replay.onEvent(stale)).toEqual({ addressed: true, notified: false, recorded: false });
    expect(replay.flush()).toBeUndefined();
    expect(digests()).toHaveLength(1);
  });
});

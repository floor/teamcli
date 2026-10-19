import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EventPayload } from '../src/bus/log.ts';
import { OWNER_MAILBOX, OwnerDelivery } from '../src/bus/owner.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { appendHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending } from '../src/send/pending.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain } from '../src/store/keys.ts';

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
  return { root, home };
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

    // 1. Plain drop file written by a tool that crashed before publishing to the bus.
    dropMessage(seatDir, 'drop-1', 'from the file\'s seat clerk — admitted by: lead\n\nhello drop 1');
    dropMessage(seatDir, 'drop-1.delivered', '{"ok":true}');
    dropMessage(seatDir, 'drop-1.read', '{"ok":true}');
    dropMessage(seatDir, 'drop-1.replied', '{"ok":true}');

    // 2. Held send with `.pending` marker past held_threshold_seconds (15m old >= 600s).
    dropMessage(seatDir, 'drop-2', 'from the owner — admitted by: the owner\n\nheld drop 2');
    markPending(seatDir, {
      id: 'drop-2',
      from: 'owner',
      to: 'worker-1',
      body: 'from the owner — admitted by: the owner\n\nheld drop 2',
      ts: '2026-10-18T11:55:00.000Z',
    });

    // 3. Fresh held send with `.pending` marker before held_threshold_seconds (2m old < 600s).
    dropMessage(seatDir, 'drop-3', 'from the owner — admitted by: the owner\n\nfresh held drop 3');
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

    // History entry in messages.jsonl.
    appendHistory('acme', root, home, {
      ts: '2026-10-18T12:02:00.000Z',
      from: 'clerk',
      to: 'worker-2',
      body: 'history body',
      id: 'hist-1',
      outcome: 'delivered (read)',
      via: 'mcp-inbox',
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

// rfc-event-comms E7: the entry gates (pending reuse durability, unknown drain listings, the
// activation publication window, the managed launch boundary, the bounded journal flush) and the
// reader switch itself (queue order behind a signed per-root flag, rollback mid-traffic,
// mixed-version refusal, completeness, and its fault grid).
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inQueueOrder, listUnread } from '../src/mcp/inbox.ts';
import { unreadOf } from '../src/commands/queues.ts';
import { LEAD_ACK_PREFIX } from '../src/send/record.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { spawnSync } from 'node:child_process';
import { signRecord } from '../src/send/record.ts';
import { appendDeliverySync, lockedQueueOrder, queueBaseOf } from '../src/queue/append.ts';
import { activate, admitManagedLaunch, fencesEnforced, floorState, launchReservations, mayCreateFence, queuesFolder, seatDropFoldersStrict, type FloorActor } from '../src/queue/floor.ts';
import { drainPendingReceipts, pendingMarkers, shadowQueueReceipt } from '../src/queue/receipt-store.ts';
import { readerOrder, readerSwitch, seatQueueCheck, setReaderSwitch } from '../src/queue/reader.ts';
import { acquireLockAt } from '../src/launch/seat-lock.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import type { DurableStep } from '../src/queue/durable.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const e6Server: FloorActor = { kind: 'inbox-server', name: 'acme/lead', pid: 2, build: 'e6', level: 2 };

type At = { root: string; home: string; dropDir: string };

function place(): At {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7-reader-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  return { root, home, dropDir };
}

function record(at: At, id: string, when: string) {
  return signRecord({
    kind: 'message', id, to: 'lead', to_id: null, root: at.root, session: SESSION,
    at: when, body: `body of ${id}`, from: 'worker', from_id: null, rule: 'the owner', thread: id,
  }, at.home);
}

/** A delivery through the one append (queued). */
function message(at: At, id: string, when: string): void {
  const signed = record(at, id, when);
  appendDeliverySync({ dropDir: at.dropDir, record: signed }, () => {
    writeFileSync(join(at.dropDir, id), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, value: true };
  }, { home: at.home });
}

/** A record written with no queue entry (an orphan: a raw or pre-E4 writer). */
function orphan(at: At, id: string, when: string): void {
  writeFileSync(join(at.dropDir, id), `${JSON.stringify(record(at, id, when), null, 2)}\n`, { mode: 0o600 });
}

const context = (at: At) => ({ to: 'lead', root: at.root, session: SESSION });
const binding = (at: At) => ({ root: at.root, session: SESSION, seat: 'lead' });
const listed = (at: At) => inQueueOrder(listUnread(at.dropDir, context(at), at.home)).map(m => [m.id, m.seq ?? null]);
const raw = (at: At) => listUnread(at.dropDir, context(at), at.home).map(m => [m.id, m.seq ?? null]);
const on = (at: At, actors: FloorActor[] = [daemon]) => setReaderSwitch(at.root, true, {
  home: at.home, actors: () => actors,
  unreadOf: (dropDir) => ({ binding: binding(at), ids: listUnread(dropDir, context(at), at.home).map(m => m.id) }),
});
const off = (at: At) => setReaderSwitch(at.root, false, { home: at.home, actors: () => [daemon], unreadOf: () => null });
const activateRoot = (at: At, actors: FloorActor[] = [daemon]) => activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => actors });

const M1 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e01';
const M2 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e02';
const M3 = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e03';
// M1 is queued first but signed later: queue order and the legacy (signed time) order differ.
const LATER = '2026-11-18T00:00:02.000Z';
const EARLIER = '2026-11-18T00:00:01.000Z';

describe('E7 entry gates', () => {
  test('gate 1: a reused pending marker counts only after its folder flush succeeds', () => {
    const at = place();
    message(at, M1, EARLIER);
    orphan(at, M2, EARLIER); // published, not indexed: the receipt's placement cannot be proved
    const input = { dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', msgId: M2, kind: 'read' as const, actor: { kind: 'recipient' as const, name: 'lead' }, home: at.home };
    expect(shadowQueueReceipt(input)).toBe('pending');
    // A second caller finds the same signed decision: success only once the folder flush holds.
    expect(shadowQueueReceipt({ ...input, faults: { reuseFlush: () => { throw new Error('fsync failed'); } } })).toBe('failed');
    expect(shadowQueueReceipt(input)).toBe('pending');
    const pending = join(queueBaseOf(at.dropDir) as string, 'pending-receipts');
    expect(readdirSync(pending).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });

  test('gate 4: a pending folder that cannot be listed is unknown, never zero, and blocks completeness', () => {
    const at = place();
    message(at, M1, EARLIER);
    const base = queueBaseOf(at.dropDir) as string;
    writeFileSync(join(base, 'pending-receipts'), 'not a folder');
    expect(drainPendingReceipts(at.dropDir, at.home)).toMatchObject({ unknown: true, left: 0 });
    expect(seatQueueCheck(at.dropDir, binding(at), [M1], at.home)).toMatchObject({ kind: 'incomplete' });
  });

  test('gate 2: a record whose publication was cut off is unknown (fences honoured, none created) until A0 republishes', () => {
    const at = place();
    expect(() => activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => [daemon], after: (step) => { if (step === 'record') throw new Error('crash'); } })).toThrow('crash');
    expect(existsSync(join(queuesFolder(at.root), 'ACTIVATION'))).toBe(true);
    expect(existsSync(join(queuesFolder(at.root), 'PUBLISHED'))).toBe(false);
    expect(floorState(at.root, at.home).kind).toBe('unknown');
    expect(fencesEnforced(at.root, at.home)).toBe(true);
    expect(mayCreateFence(at.root, at.home, 'exposure')).toBe(false);
    expect(readerOrder(at.dropDir, binding(at), [], at.home)).toMatchObject({ kind: 'legacy' });
    expect(activateRoot(at).kind).toBe('already');
    expect(floorState(at.root, at.home).kind).toBe('active');
  });

  test('gate 3: the managed launch boundary admits this build, refuses one below the floor, and refuses when the lock is held', () => {
    const at = place();
    expect(admitManagedLaunch(at.root, at.home)).toBeNull(); // dark
    expect(activateRoot(at).kind).toBe('activated');
    expect(admitManagedLaunch(at.root, at.home)).toBeNull();
    expect(admitManagedLaunch(at.root, at.home, 2)).toContain('below the root');
    const folder = queuesFolder(at.root);
    const held = acquireLockAt(join(folder, 'activation.lock'), folder, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in held).toBe(true);
    try {
      expect(admitManagedLaunch(at.root, at.home)).toContain('activation lock is held');
    } finally {
      if ('release' in held) held.release();
    }
  });
});

describe('E7 reader switch', () => {
  test('off by default: the legacy listing (signed-time order), no seq', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(readerSwitch(at.root, at.home).kind).toBe('off');
    expect(listed(at)).toEqual([[M2, null], [M1, null]]);
  });

  test('on: queue order with seq; off mid-traffic: legacy order at once, the same set', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(on(at).kind).toBe('on');
    expect(listed(at)).toEqual([[M1, 1], [M2, 2]]);
    message(at, M3, EARLIER); // traffic while on
    expect(listed(at)).toEqual([[M1, 1], [M2, 2], [M3, 3]]);
    expect(off(at).kind).toBe('off');
    expect(listed(at).map(([id]) => id).sort()).toEqual([M1, M2, M3].sort());
    expect(listed(at).every(([, seq]) => seq === null)).toBe(true);
  });

  test('mixed versions: an E6 actor (level 2) keeps the root dark, and the switch cannot go on', () => {
    const at = place();
    message(at, M1, LATER);
    expect(activateRoot(at, [daemon, e6Server]).kind).toBe('refused');
    expect(on(at).kind).toBe('refused');
    expect(listed(at)).toEqual([[M1, null]]);
  });

  test('a fenced root (a legacy actor appeared after activation) falls back to the legacy listing', async () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(on(at).kind).toBe('on');
    const { checkActors } = await import('../src/queue/floor.ts');
    expect(checkActors(at.root, at.home, [daemon, e6Server]).kind).toBe('fenced');
    expect(listed(at)).toEqual([[M2, null], [M1, null]]);
  });

  test('completeness: an unread record with no queue entry refuses the switch, and while on, makes that listing legacy without hiding it', () => {
    const at = place();
    message(at, M1, LATER);
    orphan(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    const refused = on(at);
    expect(refused.kind).toBe('refused');
    // The orphan gets its entry (the reconcile pass's orphan source), then the switch goes on.
    const { appendRecovered } = require('../src/queue/append.ts') as typeof import('../src/queue/append.ts');
    expect(appendRecovered(at.dropDir, { root: at.root, session: SESSION, seat: 'lead' }, M2, { home: at.home }).kind).toBe('committed');
    expect(on(at).kind).toBe('on');
    expect(listed(at)).toEqual([[M1, 1], [M2, 2]]);
    // A new orphan while on: the listing still holds it (legacy order), nothing is hidden.
    orphan(at, M3, EARLIER);
    expect(listed(at).map(([id]) => id).sort()).toEqual([M1, M2, M3].sort());
    expect(listed(at).every(([, seq]) => seq === null)).toBe(true);
  });

  test('a seat queue whose lock is held is unknown now: the listing stays legacy, the set unchanged', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(on(at).kind).toBe('on');
    const base = queueBaseOf(at.dropDir) as string;
    const held = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in held).toBe(true);
    try {
      expect(listed(at)).toEqual([[M2, null], [M1, null]]);
    } finally {
      if ('release' in held) held.release();
    }
    expect(listed(at)).toEqual([[M1, 1], [M2, 2]]);
  });

  test('a forged or foreign reader switch is unknown: legacy listing', () => {
    const at = place();
    message(at, M1, LATER);
    expect(activateRoot(at).kind).toBe('activated');
    writeFileSync(join(queuesFolder(at.root), 'READER'), JSON.stringify({ payload: { v: 1, kind: 'queue-reader', root: at.root, level: 3, at: 'x' }, signature: 'forged' }));
    expect(readerSwitch(at.root, at.home).kind).toBe('unknown');
    expect(listed(at)).toEqual([[M1, null]]);
  });

  test('fault grid: a fault at any durable step of the switch never hides a message, and a clean pass settles it', () => {
    const STEPS: DurableStep[] = ['temp', 'temp-fsync', 'link', 'unlink-temp', 'folder-fsync'];
    for (const step of STEPS) {
      const at = place();
      message(at, M1, LATER);
      message(at, M2, EARLIER);
      expect(activateRoot(at).kind).toBe('activated');
      const out = setReaderSwitch(at.root, true, {
        home: at.home, actors: () => [daemon],
        unreadOf: () => ({ binding: binding(at), ids: [M1, M2] }),
        faults: { before: (point, path) => { if (point === step && path.endsWith('READER')) throw new Error('fault'); } },
      });
      expect(out.kind).toBe('failed');
      const linked = step === 'unlink-temp' || step === 'folder-fsync';
      expect(readerSwitch(at.root, at.home).kind).toBe(linked ? 'on' : 'off');
      // Either order holds the same set: the switch changes order, never membership.
      expect(listed(at).map(([id]) => id).sort()).toEqual([M1, M2].sort());
      expect(on(at).kind).toBe('on');
      expect(listed(at)).toEqual([[M1, 1], [M2, 2]]);
    }
  });
});

describe('E7 round 2', () => {
  test('P1 recovery: a record cut off before publication is never published without today\'s proof', () => {
    for (const actors of [[daemon, e6Server], [] as FloorActor[]]) {
      const at = place();
      expect(() => activate(at.root, { home: at.home, build: 'b', launchBoundary: true, actors: () => [daemon], after: (step) => { if (step === 'record') throw new Error('crash'); } })).toThrow('crash');
      // A level-2 actor appeared, or the daemon is gone: the recovery run refuses and publishes nothing.
      expect(activateRoot(at, actors).kind).toBe('refused');
      expect(existsSync(join(queuesFolder(at.root), 'PUBLISHED'))).toBe(false);
      expect(floorState(at.root, at.home).kind).toBe('unknown');
      expect(mayCreateFence(at.root, at.home, 'exposure')).toBe(false);
      // Today's proof holds: A4 publishes the cut-off record.
      expect(activateRoot(at).kind).toBe('already');
      expect(floorState(at.root, at.home).kind).toBe('active');
    }
  });

  test('P1 admission: an admitted launch is represented before the lock is let go; a lower-level launch in flight refuses activation', () => {
    const at = place();
    // Dark root: a level-2 launch is admitted and reserved under the lock (the launcher is this
    // live test process); its own actor record does not exist yet.
    expect(admitManagedLaunch(at.root, at.home, 2, process.pid, 'restart worker')).toBeNull();
    expect(launchReservations(at.root)).toMatchObject([{ level: 2, pid: process.pid }]);
    // Activation running while that launch is in flight counts it, and refuses.
    expect(activateRoot(at).kind).toBe('refused');
    expect(floorState(at.root, at.home).kind).toBe('dark');
  });

  test('P1 admission: a reservation whose launcher is gone is cleared, and a same-level one is counted at its level', () => {
    const at = place();
    const gone = spawnSync('true').pid as number;
    expect(admitManagedLaunch(at.root, at.home, 2, gone, 'old')).toBeNull();
    expect(launchReservations(at.root)).toEqual([]); // a dead launcher is not an actor
    expect(admitManagedLaunch(at.root, at.home, 3, process.pid, 'mcp serve')).toBeNull();
    expect(activateRoot(at).kind).toBe('activated');
    expect(readdirSync(join(queuesFolder(at.root), 'launching')).some(name => name.startsWith(`${String(gone)}.`))).toBe(false);
  });

  test('P2 completeness: an unlistable session or inbox is never certified; the bound view honours a lead clearance', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    // A lead's valid clearance settles M2 in the bound view the inbox uses.
    expect(publishRecordRead({ dropDir: at.dropDir, id: M2, to: 'lead', root: at.root, session: SESSION, home: at.home, key: messageKeyOf(at.home), at: '2026-11-18T00:01:00.000Z', readBy: `${LEAD_ACK_PREFIX}owner`, lead: 'lead' })).toBeTruthy();
    expect(unreadOf(at.root, at.home, 'lead', at.dropDir)?.ids).toEqual([M1]);
    // An inbox that cannot be listed is null, never an empty set.
    const blind = join(at.root, '.agents', 'send-drops', SESSION, 'ghost');
    writeFileSync(blind, 'not a folder');
    expect(unreadOf(at.root, at.home, 'lead', blind)).toBeNull();
    const refused = setReaderSwitch(at.root, true, { home: at.home, actors: () => [daemon], unreadOf: (dropDir) => unreadOf(at.root, at.home, 'lead', dropDir) });
    expect(refused.kind).toBe('refused');
    // A session folder that cannot be listed makes the whole inventory unknown.
    writeFileSync(join(at.root, '.agents', 'send-drops', 'broken'), 'x');
    expect(seatDropFoldersStrict(at.root)).toBeNull();
  });

  test('P2 consumers: every consumer keeps signed-time order; only the model-facing listing is offered by seq', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(on(at).kind).toBe('on');
    expect(raw(at)).toEqual([[M2, 2], [M1, 1]]); // time order kept, seq attached (drops batch, wake ages, wake picker)
    expect(listed(at)).toEqual([[M1, 1], [M2, 2]]); // inbox_check order
  });

  test('P2 generation: the order is proved on the generation current under the lock; a rotation leaves the listing legacy', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    expect(activateRoot(at).kind).toBe('activated');
    expect(on(at).kind).toBe('on');
    const base = queueBaseOf(at.dropDir) as string;
    // Rotate: a new empty generation becomes current (as a replacement does).
    mkdirSync(join(base, 'g00000000000000ff', 'entries'), { recursive: true });
    writeFileSync(join(base, 'current'), 'g00000000000000ff\n');
    expect(listed(at)).toEqual([[M2, null], [M1, null]]);
  });

  test('P2 generation: a rotation after the lock is taken is the generation proved (the pointer is read under the lock)', () => {
    const at = place();
    message(at, M1, LATER);
    message(at, M2, EARLIER);
    const base = queueBaseOf(at.dropDir) as string;
    const out = lockedQueueOrder(at.dropDir, binding(at), [M1, M2], at.home, { afterLock: () => {
      mkdirSync(join(base, 'g00000000000000fe', 'entries'), { recursive: true });
      writeFileSync(join(base, 'current'), 'g00000000000000fe\n');
    } });
    expect(out).toMatchObject({ why: expect.stringContaining('no committed queue entry') });
  });

  test('P2 status is read-only: pending, quarantine and receipts are left exactly as they were', () => {
    const at = place();
    message(at, M1, EARLIER);
    const base = queueBaseOf(at.dropDir) as string;
    // A read decided while another holder has the queue lock: a pending marker a drain could settle.
    const held = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
    expect('release' in held).toBe(true);
    try {
      expect(shadowQueueReceipt({ dropDir: at.dropDir, root: at.root, session: SESSION, seat: 'lead', msgId: M1, kind: 'read', actor: { kind: 'recipient', name: 'lead' }, home: at.home })).toBe('pending');
    } finally {
      if ('release' in held) held.release();
    }
    const snapshot = () => JSON.stringify([readdirSync(join(base, 'pending-receipts')).sort(), existsSync(join(at.root, '.agents', 'receipts')) ? readdirSync(join(at.root, '.agents', 'receipts'), { recursive: true }).sort() : []]);
    const before = snapshot();
    expect(seatQueueCheck(at.dropDir, binding(at), [M1], at.home)).toMatchObject({ kind: 'incomplete' });
    expect(pendingMarkers(at.dropDir)).toBe(1);
    expect(snapshot()).toBe(before);
    // The authorized path drains it: the receipt is written and the marker goes.
    expect(seatQueueCheck(at.dropDir, binding(at), [M1], at.home, { drain: true }).kind).toBe('complete');
    expect(snapshot()).not.toBe(before);
  });
});

// rfc-event-comms E6: the activation floor, exposure claims, the per-seat receipt store and the
// wake-attempt states, each with its fault grid (crash after a step, a failing fsync, a failing
// link or unlink at every durable step).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageKeyOf, signDomain, type Json } from '../src/store/keys.ts';
import { activate, checkActors, fencesEnforced, floorState, mayCreateFence, queuesFolder, type FloorActor } from '../src/queue/floor.ts';
import { derivedProgress, readQueueReceipts, writeQueueReceipt, receiptFolder, QUEUE_RECEIPT_DOMAIN } from '../src/queue/receipt-store.ts';
import { attemptGate, attemptsOf, prepareAttempt, tokenText } from '../src/queue/wake-attempt.ts';
import { createExclusive, type DurableStep } from '../src/queue/durable.ts';
import { deliverLeadTypedWake, deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readFileSync } from 'node:fs';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');

function scene(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'e6-'));
  const root = join(base, 'root');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);
  return { root, home };
}

const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 2 };
const server = (level: number | null): FloorActor => ({ kind: 'inbox-server', name: 's/seat', pid: 2, build: 'b', level });

function active(): { root: string; home: string } {
  const s = scene();
  expect(activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon, server(2)] }).kind).toBe('activated');
  return s;
}

const STEPS: DurableStep[] = ['temp', 'temp-fsync', 'link', 'unlink-temp', 'folder-fsync'];

describe('activation floor', () => {
  test('an actor below the floor, or with no level, refuses activation and writes nothing', () => {
    for (const below of [server(null), server(1)]) {
      const s = scene();
      const out = activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon, below] });
      expect(out.kind).toBe('refused');
      expect(floorState(s.root, s.home).kind).toBe('dark');
      expect(existsSync(join(queuesFolder(s.root), 'PROTOCOL'))).toBe(false);
    }
  });

  test('no live daemon means no activation', () => {
    const s = scene();
    expect(activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [server(2)] }).kind).toBe('refused');
    expect(floorState(s.root, s.home).kind).toBe('dark');
  });

  test('every actor at the floor activates; marker then record', () => {
    const s = active();
    expect(floorState(s.root, s.home)).toMatchObject({ kind: 'active', level: 2 });
    expect(mayCreateFence(s.root, s.home, 'exposure')).toBe(true);
  });

  test('a crash after the marker leaves the root dark, and the next pass removes the marker and activates', () => {
    const s = scene();
    expect(() => activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon], after: (step) => { if (step === 'marker') throw new Error('crash'); } })).toThrow('crash');
    expect(existsSync(join(queuesFolder(s.root), 'PROTOCOL'))).toBe(true);
    expect(floorState(s.root, s.home).kind).toBe('dark');
    expect(mayCreateFence(s.root, s.home, 'exposure')).toBe(false);
    expect(activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon] }).kind).toBe('activated');
    expect(floorState(s.root, s.home).kind).toBe('active');
  });

  test('fault grid: a fault at any durable step of the marker or the record never leaves the root active', () => {
    for (const file of ['PROTOCOL', 'ACTIVATION']) {
      for (const step of STEPS) {
        const s = scene();
        const out = activate(s.root, {
          home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon],
          faults: { before: (at, path) => { if (at === step && path.endsWith(file)) throw new Error('fault'); } },
        });
        expect(out.kind).toBe('failed');
        const after = floorState(s.root, s.home).kind;
        // Before the record's link the root is dark; once the record is visible it is never taken
        // back (a reader may have acted on it): it stays enforcing.
        if (file === 'ACTIVATION' && (step === 'unlink-temp' || step === 'folder-fsync')) expect(after).toBe('active');
        else expect(after).toBe('dark');
        // A clean pass afterwards reaches one consistent state: active.
        expect(['activated', 'already']).toContain(activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon] }).kind);
        expect(floorState(s.root, s.home).kind).toBe('active');
      }
    }
  });

  test('a legacy actor after activation fences the root: no new fences, existing ones honoured; a clean proof lifts it', () => {
    const s = active();
    expect(checkActors(s.root, s.home, [daemon, server(null)]).kind).toBe('fenced');
    expect(mayCreateFence(s.root, s.home, 'exposure')).toBe(false);
    expect(fencesEnforced(s.root, s.home)).toBe(true);
    expect(activate(s.root, { home: s.home, build: 'b', launchBoundary: true, actors: () => [daemon, server(2)] }).kind).toBe('activated');
    expect(floorState(s.root, s.home).kind).toBe('active');
  });

  test('E6 ships dark: without the managed launch boundary nothing activates', () => {
    const s = scene();
    expect(activate(s.root, { home: s.home, build: 'b', actors: () => [daemon] }).kind).toBe('refused');
    expect(floorState(s.root, s.home).kind).toBe('dark');
  });

  test('an unreadable actor probe on an active root fences it (no new fences)', () => {
    const s = active();
    expect(checkActors(s.root, s.home, null).kind).toBe('fenced');
    expect(mayCreateFence(s.root, s.home, 'wake-attempt')).toBe(false);
  });

  test('an activation record that does not verify, or stands without its marker, is unknown (fail closed)', () => {
    const s = active();
    writeFileSync(join(queuesFolder(s.root), 'ACTIVATION'), JSON.stringify({ payload: { v: 1, kind: 'activation', root: s.root, level: 2 }, signature: 'x' }));
    expect(floorState(s.root, s.home).kind).toBe('unknown');
    expect(mayCreateFence(s.root, s.home, 'exposure')).toBe(false);
    expect(fencesEnforced(s.root, s.home)).toBe(true);
  });
});

describe('per-seat receipt store', () => {
  const binding = (root: string, seq: number) => ({ root, session: 'floor', seat: 'tester', generation: 'g0123456789abcdef', seq, msg_id: `m${String(seq)}` });

  test('a receipt whose msg_id is not the committed entry at its seq is never counted', () => {
    const s = scene();
    writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home);
    expect(readQueueReceipts(binding(s.root, 1), s.home, () => 'another-message')).toEqual([]);
    expect(readQueueReceipts(binding(s.root, 1), s.home, () => null)).toEqual([]);
  });

  test('the actor matrix refuses a writer the kind does not admit', () => {
    const s = scene();
    expect(writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'adapter', name: 'x' }, s.home)).toBe('refused');
    expect(writeQueueReceipt(binding(s.root, 1), 'cleared', { kind: 'recipient', name: 'x' }, s.home)).toBe('refused');
    expect(writeQueueReceipt(binding(s.root, 1), 'offered', { kind: 'adapter', name: 'x' }, s.home)).toBe('written');
  });

  test('progress is derived: a contiguous prefix of terminal receipts; cleared settles, offered does not', () => {
    const s = scene();
    writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home);
    writeQueueReceipt(binding(s.root, 2), 'cleared', { kind: 'lead', name: 'l' }, s.home);
    writeQueueReceipt(binding(s.root, 3), 'offered', { kind: 'adapter', name: 'a' }, s.home);
    writeQueueReceipt(binding(s.root, 4), 'answered.op1', { kind: 'reply-op', name: 'r' }, s.home);
    const read = readQueueReceipts(binding(s.root, 1), s.home, (seq) => `m${String(seq)}`)!;
    expect(derivedProgress(read)).toEqual({ prefix: 2, sparse: [4] });
  });

  test('one file per receipt, never replaced; a concurrent second writer sees it exists', () => {
    const s = scene();
    expect(writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home)).toBe('written');
    expect(writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'relay', name: 'r' }, s.home)).toBe('exists');
  });

  test('a receipt replayed into another seat or generation, or hand-edited, is ignored', () => {
    const s = scene();
    writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home);
    const from = join(receiptFolder(binding(s.root, 1)), '000000000001.read');
    const text = require('node:fs').readFileSync(from, 'utf8') as string;
    const other = { ...binding(s.root, 1), seat: 'other' };
    mkdirSync(receiptFolder(other), { recursive: true });
    writeFileSync(join(receiptFolder(other), '000000000001.read'), text);
    expect(readQueueReceipts(other, s.home, (seq) => `m${String(seq)}`)).toEqual([]);
    writeFileSync(from, text.replace('"recipient"', '"owner"'));
    expect(readQueueReceipts(binding(s.root, 1), s.home, (seq) => `m${String(seq)}`)).toEqual([]);
  });

  test('a signed receipt whose actor the matrix refuses for its kind is ignored at read', () => {
    const s = scene();
    const b = binding(s.root, 1);
    const payload = { v: 1, kind: 'queue-receipt', ...b, receipt: 'read', actor: { kind: 'adapter', name: 'x' }, at: 'now' };
    mkdirSync(receiptFolder(b), { recursive: true });
    writeFileSync(join(receiptFolder(b), '000000000001.read'), JSON.stringify({ payload, signature: signDomain(QUEUE_RECEIPT_DOMAIN, payload as unknown as Json, messageKeyOf(s.home)) }));
    expect(readQueueReceipts(b, s.home, (seq) => `m${String(seq)}`)).toEqual([]);
  });

  test('fault grid: a receipt not made durable is reported failed, and a retry settles it once', () => {
    for (const step of STEPS) {
      const s = scene();
      const out = writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home, { faults: { before: (at) => { if (at === step) throw new Error('fault'); } } });
      expect(out).toBe('failed');
      const retry = writeQueueReceipt(binding(s.root, 1), 'read', { kind: 'recipient', name: 't' }, s.home);
      expect(['written', 'exists']).toContain(retry);
      expect(derivedProgress(readQueueReceipts(binding(s.root, 1), s.home, (seq) => `m${String(seq)}`)!).prefix).toBe(1);
    }
  });
});

describe('wake-attempt states', () => {
  const scope = (root: string, incarnation = 'i0000000000000001') => ({ root, session: 'floor', seat: 'tester', incarnation });
  const target = { msg_id: 'm1', seq: 1 };
  const none = { settled: () => false, scrollback: () => null };

  test('dark: the gate is open and enforces nothing', () => {
    const s = scene();
    expect(attemptGate(scope(s.root), target, s.home, none)).toEqual({ kind: 'open', enforced: false, create: 'shadow' });
  });

  test('prepared only (no key sent) allows a retry; emitted unconfirmed blocks a retype', () => {
    const s = active();
    const first = prepareAttempt(scope(s.root), target, s.home, true)!;
    first.settle({ delivered: false, typed: false });
    expect(attemptGate(scope(s.root), target, s.home, none).kind).toBe('open');
    const second = prepareAttempt(scope(s.root), target, s.home, true)!;
    expect(second.emit()).toBe(true);
    second.settle({ delivered: false, typed: true });
    expect(attemptGate(scope(s.root), target, s.home, none)).toMatchObject({ kind: 'blocked' });
    // One wake per seat: an earlier message is covered by the unresolved wake for a later one; a
    // later message may get its own wake (§5: "an attempt for an equal or higher seq").
    expect(attemptGate(scope(s.root), { msg_id: 'm0', seq: 0.5 }, s.home, none).kind).toBe('blocked');
    expect(attemptGate(scope(s.root), { msg_id: 'm2', seq: 2 }, s.home, none).kind).toBe('open');
  });

  test('evidence resolves it: a read, the token in the scrollback, or a new incarnation', () => {
    const s = active();
    const a = prepareAttempt(scope(s.root), target, s.home, true)!;
    a.emit();
    a.settle({ delivered: false, typed: true });
    expect(attemptGate(scope(s.root), target, s.home, { settled: () => false, scrollback: () => `x ${tokenText(a.attempt.token)} y` }).kind).toBe('open');
    expect(attemptsOf(scope(s.root), s.home)!.find(x => x.n === a.attempt.n)!.state).toBe('confirmed');
    const b = prepareAttempt(scope(s.root), target, s.home, true)!;
    b.emit();
    b.settle({ delivered: false, typed: true });
    expect(attemptGate(scope(s.root), target, s.home, { settled: (id) => id === 'm1', scrollback: () => null }).kind).toBe('open');
    const c = prepareAttempt(scope(s.root), target, s.home, true)!;
    c.emit();
    expect(attemptGate(scope(s.root), target, s.home, none).kind).toBe('blocked');
    expect(attemptGate(scope(s.root, 'i0000000000000002'), target, s.home, none).kind).toBe('open');
  });

  test('a fenced root honours an unresolved attempt and creates no new attempt state', () => {
    const s = active();
    const a = prepareAttempt(scope(s.root), target, s.home, true)!;
    a.emit();
    a.settle({ delivered: false, typed: true });
    checkActors(s.root, s.home, [daemon, server(null)]);
    expect(attemptGate(scope(s.root), target, s.home, none).kind).toBe('blocked');
    const open = attemptGate(scope(s.root, 'i0000000000000003'), target, s.home, none);
    expect(open).toMatchObject({ kind: 'open', create: 'none' });
  });

  test('an unknown incarnation, or unreadable attempts, block on an enforcing root', () => {
    const s = active();
    expect(attemptGate(scope(s.root, 'unknown'), target, s.home, none).kind).toBe('blocked');
    const a = prepareAttempt(scope(s.root), target, s.home, true)!;
    writeFileSync(join(s.root, '.agents', 'wakes', 'floor', 'tester', 'i0000000000000001', `${String(a.attempt.n)}.emitted`), 'garbage');
    expect(attemptGate(scope(s.root), target, s.home, none).kind).toBe('blocked');
  });

  test('fault grid: an emitted state not made durable sends no key at all', async () => {
    for (const step of STEPS) {
      const s = active();
      const a = prepareAttempt(scope(s.root), target, s.home, true)!;
      let calls = 0;
      const faulty = prepareAttempt(scope(s.root), { msg_id: 'm9', seq: 9 }, s.home, true, { before: (at, path) => { if (at === step && path.endsWith('.emitted')) { calls += 1; throw new Error('fault'); } } })!;
      const typed: string[] = [];
      // A real idle Muse screen: without the gate this walk types the line (the control below).
      const host: TypedWakeHost = {
        read: () => IDLE,
        type: (_p, text) => { typed.push(text); return true; },
        enter: () => { typed.push('\r'); return true; },
        wait: async () => {},
      };
      const result = await deliverTypedWake(host, 'w1:p1', 'hello', 'muse', { beforeFirstKey: faulty.emit, settleMs: 1, enterSettleMs: 1, pollMs: 1, ackSettleMs: 1, verifyMs: 1, rereadMs: 0 });
      expect(typed).toEqual([]);
      expect(result.delivered).toBe(false);
      void a;
      expect(calls <= 1).toBe(true);
    }
  });

  test('control: the same idle screen with an open gate is typed into', async () => {
    const typed: string[] = [];
    const host: TypedWakeHost = { read: () => IDLE, type: (_p, text) => { typed.push(text); return true; }, enter: () => { typed.push('\r'); return true; }, wait: async () => {} };
    await deliverTypedWake(host, 'w1:p1', 'hello', 'muse', { beforeFirstKey: () => true, settleMs: 1, enterSettleMs: 1, pollMs: 1, ackSettleMs: 1, verifyMs: 1, rereadMs: 0 });
    expect(typed.length).toBeGreaterThan(0);
  });

  test("the lead's legacy fallback: a refused gate sends zero keys, the draft-clearing keys included", async () => {
    const UNSENT = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'unsent-synthetic.txt'), 'utf8');
    const CLAUDE_DRAFT = readFileSync(join(import.meta.dir, 'fixtures/claude-code/2.1.289/unsent-paste-ansi.txt'), 'utf8');
    for (const [screen, cli] of [[IDLE, 'muse'], [UNSENT, 'muse'], [CLAUDE_DRAFT, 'claude-code']] as const) {
      const typed: string[] = [];
      const host: TypedWakeHost = {
        read: () => screen,
        type: (_p, text) => { typed.push(text); return true; },
        enter: () => { typed.push('\r'); return true; },
        key: (_p, key) => { typed.push(key); return true; },
        wait: async () => {},
      };
      await deliverLeadTypedWake(host, 'w1:p1', 'hello', cli, { beforeFirstKey: () => false, settleMs: 1, enterSettleMs: 1, pollMs: 1, ackSettleMs: 1, verifyMs: 1, rereadMs: 0 });
      expect(typed).toEqual([]);
    }
  });

  test('a gate that refuses blocks every key path, including the scroll-back key', async () => {
    const typed: string[] = [];
    const host: TypedWakeHost = {
      read: () => null,
      type: (_p, text) => { typed.push(text); return true; },
      enter: () => { typed.push('\r'); return true; },
      key: (_p, key) => { typed.push(key); return true; },
      wait: async () => {},
    };
    await deliverTypedWake(host, 'w1:p1', 'hello', 'claude-code', { beforeFirstKey: () => false, rereadMs: 0 });
    expect(typed).toEqual([]);
  });
});

describe('durable create', () => {
  test('a retry after a failed parent fsync flushes that standing level again', () => {
    const s = scene();
    const folder = join(s.root, '.agents', 'x', 'y');
    expect(createExclusive(join(folder, 'f'), 'a', { before: (at) => { if (at === 'parent-fsync') throw new Error('fault'); } })).toBe('failed');
    const steps: string[] = [];
    expect(createExclusive(join(folder, 'f'), 'a', { before: (at, path) => { steps.push(`${at}:${path.slice(s.root.length)}`); } })).toBe('created');
    expect(steps.filter(x => x.startsWith('parent-fsync'))).toEqual(expect.arrayContaining(['parent-fsync:/.agents/x/y', 'parent-fsync:/.agents/x']));
  });

  test('first-write trace: every new folder level is made durable in its parent before the file', () => {
    const s = scene();
    const steps: string[] = [];
    expect(createExclusive(join(s.root, 'n1', 'n2', 'f'), 'x', { before: (at, path) => { steps.push(`${at}:${path.slice(s.root.length)}`); } })).toBe('created');
    expect(steps.slice(0, 4)).toEqual(['mkdir:/n1', 'parent-fsync:/n1', 'mkdir:/n1/n2', 'parent-fsync:/n1/n2']);
    expect(steps.slice(4)).toEqual(['temp:/n1/n2/f', 'temp-fsync:/n1/n2/f', 'link:/n1/n2/f', 'unlink-temp:/n1/n2/f', 'folder-fsync:/n1/n2/f']);
  });

  test('a fault making a new folder level never reports created, and a retry makes the whole chain', () => {
    for (const step of ['mkdir', 'parent-fsync'] as const) {
      const s = scene();
      const path = join(s.root, 'a', 'b', 'c', 'f');
      expect(createExclusive(path, 'x', { before: (at) => { if (at === step) throw new Error('fault'); } })).toBe('failed');
      expect(createExclusive(path, 'x')).toBe('created');
    }
  });

  test('exists when the name stands; nothing replaces it', () => {
    const s = scene();
    const path = join(s.root, 'x', 'f');
    expect(createExclusive(path, 'a')).toBe('created');
    expect(createExclusive(path, 'b')).toBe('exists');
    expect(require('node:fs').readFileSync(path, 'utf8')).toBe('a');
    expect(readdirSync(join(s.root, 'x')).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
});

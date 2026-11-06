// The reconcile pass yields to the event loop, remembers what it already read and verified, and
// still raises a receipt that arrives after its record was taken. The daemon's
// heartbeat starts before any endpoint and every root is recorded while it is still starting;
// a send endpoint that stops answering is closed and started again in this process, and a start
// that keeps failing stops the daemon once. These are the regression probes for the five
// findings against the stopped archive procedure: a late read is still exposed once, a family
// half moved is not lost, a rewritten record is not served from a stale entry, a read event is
// never dropped, and a reply receipt still names the sender.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendEvent, eventLogPath, EVENT_DOMAIN, readEvents, type SignedEventRecord } from '../src/bus/log.ts';
import { createReconcileState, reconcilePass, reconcilePassAsync, type ReconcileResult } from '../src/bus/reconcile.ts';
import { nudgeBus, startBus } from '../src/bus/server.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { daemonDifferences, daemonNotes } from '../src/daemon/health_display.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { signReceiptPayload, signRecord, type RecordPayload } from '../src/send/record.ts';
import type { SendDaemonHandle } from '../src/send/daemon.ts';
import { emptySession, LOCK_FILE, updateState } from '../src/state.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain, type Json } from '../src/store/keys.ts';

const TEAM = `format: 1
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

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  // A short base keeps the bus and send socket paths under the platform's limit; the OS temp
  // folder itself can be long on a desktop.
  const short = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  const base = realpathSync(mkdtempSync(join(short, 'team-offloop-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function dropsDir(root: string): string {
  return join(root, '.agents', 'send-drops', 'acme', 'worker-1');
}

/** One message record as a send writes it into worker-1's drop folder. */
function signedDrop(
  root: string,
  home: string,
  id: string,
  options: { from?: string; at?: string; thread?: string } = {},
): void {
  const dir = dropsDir(root);
  mkdirSync(dir, { recursive: true });
  const from = options.from ?? 'clerk';
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: 'worker-1',
    to_id: null,
    root,
    session: 'acme',
    at: options.at ?? BULK_TS,
    body: `${from} says hello to ${id}`,
    from,
    from_id: null,
    rule: 'a synthetic admission',
    thread: options.thread ?? id,
  };
  writeFileSync(join(dir, id), `${JSON.stringify(signRecord(payload, home), null, 2)}\n`);
}

/** One receipt as a read or a reply leaves it beside its record: a signed `.json` envelope. */
function signedReceipt(root: string, home: string, id: string, status: 'read' | 'replied'): void {
  const receipt = signReceiptPayload({
    kind: 'receipt',
    status,
    id,
    to: 'worker-1',
    root,
    session: 'acme',
    at: '2026-11-01T00:02:00.000Z',
  }, home);
  writeFileSync(join(dropsDir(root), `${id}.${status}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

function raisedKeys(pass: ReconcileResult): string[] {
  if (!pass.ok) throw new Error(pass.reason);
  return pass.raised.map((record) => `${record.payload.kind}:${record.payload.record_id}`);
}

function readStateOk(home: string) {
  const read = readDaemonState(home);
  if (read.kind !== 'ok') throw new Error(`daemon state is ${read.kind}`);
  return read.state;
}

async function waitForValue<T>(check: () => T | null, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Holds the event log's lock for this process, so a pass's append is deferred and retried. */
function holdEventLock(root: string, home: string): string {
  const dir = join(dirname(eventLogPath('acme', root, home)), 'locks', 'events');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  writeFileSync(path, `${String(process.pid)}\n`);
  return path;
}

const BULK_FILES = 10_000;
const BULK_TS = '2026-11-01T00:00:00.000Z';

/**
 * A store of 10,000 drop files whose events are already in the log. Every file is still listed,
 * stamped and examined — these fixtures are unsigned, so the verified read refuses each one,
 * which is the read this scene measures — and no raise appends anything: the scene measures the
 * scan and its yields, not 10,000 event appends.
 */
function seedBulkStore(root: string, home: string): void {
  const dir = dropsDir(root);
  mkdirSync(dir, { recursive: true });
  const key = messageKeyOf(home);
  const firstId = 'bulk-000000';
  const first = appendEvent('acme', root, home, {
    ts: BULK_TS,
    kind: 'message.arrived',
    session: 'acme',
    record_id: firstId,
    to: 'worker-1',
  });
  if (!first.ok) throw new Error(first.reason);
  const lines: string[] = [];
  for (let index = 0; index < BULK_FILES; index += 1) {
    const id = `bulk-${String(index).padStart(6, '0')}`;
    writeFileSync(join(dir, id), `from clerk — admitted by: lead\n\nbody ${String(index)}`);
    if (index === 0) continue;
    const payload = {
      v: 1,
      seq: index + 1,
      ts: BULK_TS,
      kind: 'message.arrived',
      session: 'acme',
      record_id: id,
      to: 'worker-1',
    };
    const signature = signDomain(EVENT_DOMAIN, payload as unknown as Json, key);
    lines.push(JSON.stringify({ payload, signature }));
  }
  appendFileSync(first.path, `${lines.join('\n')}\n`);
}

describe('reconcile steps yield off the event loop', () => {
  test('a 10,000-file store keeps a timer ticking while every record is examined', async () => {
    const { root, home } = scratch();
    seedBulkStore(root, home);
    const state = createReconcileState();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    let pass;
    try {
      pass = await reconcilePassAsync({
        project: 'acme',
        root,
        session: 'acme',
        home,
        state,
        sliceMs: 0,
      });
    } finally {
      clearInterval(timer);
    }
    expect(pass.ok).toBe(true);
    expect(state.stats.filesRead).toBe(BULK_FILES);
    expect(state.stats.yields).toBeGreaterThanOrEqual(BULK_FILES);
    expect(ticks).toBeGreaterThan(0);
  }, 120_000);

  test('the sync driver drains the same steps and raises the same events', () => {
    const { root, home } = scratch();
    signedDrop(root, home, 'rec-sync');
    const sync = reconcilePass({ project: 'acme', root, session: 'acme', home });
    expect(raisedKeys(sync)).toContain('message.arrived:rec-sync');
  });
});

describe('a pass remembers what it read and verified', () => {
  test('the second pass reads no record file again and reuses every entry', () => {
    const { root, home } = scratch();
    for (let index = 0; index < 100; index += 1) {
      signedDrop(root, home, `rec-${String(index).padStart(3, '0')}`);
    }
    const state = createReconcileState();
    const first = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(first.ok).toBe(true);
    expect(state.stats.filesRead).toBe(100);
    const second = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(second.ok).toBe(true);
    expect(state.stats.passes).toBe(2);
    expect(state.stats.filesRead).toBe(0);
    expect(state.stats.filesReused).toBeGreaterThanOrEqual(100);
  });

  test('a signed record is verified once and its cached verdict is reused', () => {
    const { root, home } = scratch();
    plantMessage(home, root, 'worker-1', 'msg-signed-1', {
      kind: 'message',
      id: 'msg-signed-1',
      from: 'clerk',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-11-01T00:00:00.000Z',
      body: 'signed body',
    });
    const receiptPayload = {
      kind: 'receipt' as const,
      id: 'msg-signed-1',
      to: 'worker-1',
      root,
      session: 'acme',
      at: '2026-11-01T00:01:00.000Z',
    };
    const signature = signDomain(RECEIPT_DOMAIN, receiptPayload, messageKeyOf(home));
    writeFileSync(
      receiptFile(root, 'worker-1', 'msg-signed-1'),
      JSON.stringify({ payload: receiptPayload, signature }),
    );
    const state = createReconcileState();
    const first = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(first.ok).toBe(true);
    expect(state.stats.verifies).toBe(2);
    const second = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(second.ok).toBe(true);
    expect(state.stats.verifies).toBe(0);
    expect(state.stats.verifiesReused).toBeGreaterThanOrEqual(2);
  });
});

describe('the archive findings are regression probes', () => {
  test('a read and a reply that arrive after the record was taken still raise, once, with the sender', () => {
    const { root, home } = scratch();
    const dir = dropsDir(root);
    signedDrop(root, home, 'rec-late');
    const state = createReconcileState();
    const first = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(raisedKeys(first)).toContain('message.arrived:rec-late');
    // The record leaves the live tree the way a move does; the receipts are written afterwards.
    unlinkSync(join(dir, 'rec-late'));
    signedReceipt(root, home, 'rec-late', 'read');
    signedReceipt(root, home, 'rec-late', 'replied');
    const second = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    if (!second.ok) throw new Error(second.reason);
    expect(raisedKeys(second)).toContain('message.read:rec-late:read');
    expect(raisedKeys(second)).toContain('message.replied:rec-late:replied');
    for (const record of second.raised) {
      if (record.payload.record_id?.startsWith('rec-late:')) expect(record.payload.from).toBe('clerk');
    }
    const third = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    expect(raisedKeys(third)).toEqual([]);
  });

  test('a receipt whose record already left still raises without inventing a sender', () => {
    const { root, home } = scratch();
    const dir = dropsDir(root);
    mkdirSync(dir, { recursive: true });
    signedReceipt(root, home, 'rec-lone', 'read');
    const pass = reconcilePass({ project: 'acme', root, session: 'acme', home });
    if (!pass.ok) throw new Error(pass.reason);
    expect(raisedKeys(pass)).toContain('message.read:rec-lone:read');
    const read = pass.raised.find((record) => record.payload.record_id === 'rec-lone:read');
    expect(read?.payload.from).toBeUndefined();
  });

  test('a receipt after an intervening quiet pass still names the sender', () => {
    const { root, home } = scratch();
    const dir = dropsDir(root);
    signedDrop(root, home, 'rec-gap');
    const state = createReconcileState();
    expect(raisedKeys(reconcilePass({ project: 'acme', root, session: 'acme', home, state })))
      .toContain('message.arrived:rec-gap');
    // The record is taken and one pass sees the folder without it; only then does the receipt
    // arrive. The pass's own map has forgotten the sender by now; the log has not.
    unlinkSync(join(dir, 'rec-gap'));
    expect(raisedKeys(reconcilePass({ project: 'acme', root, session: 'acme', home, state }))).toEqual([]);
    signedReceipt(root, home, 'rec-gap', 'replied');
    const last = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    if (!last.ok) throw new Error(last.reason);
    expect(raisedKeys(last)).toContain('message.replied:rec-gap:replied');
    expect(last.raised.find((record) => record.payload.record_id === 'rec-gap:replied')?.payload.from)
      .toBe('clerk');
    // A fresh state has no map at all, only the log: the same answer, an event and a restart later.
    signedReceipt(root, home, 'rec-gap', 'read');
    const fresh = reconcilePass({ project: 'acme', root, session: 'acme', home });
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(raisedKeys(fresh)).toContain('message.read:rec-gap:read');
    expect(fresh.raised.find((record) => record.payload.record_id === 'rec-gap:read')?.payload.from)
      .toBe('clerk');
  });

  test('a record rewritten in place is read again, and a later receipt carries the new sender', () => {
    const { root, home } = scratch();
    const dir = dropsDir(root);
    signedDrop(root, home, 'rec-rewrite');
    const state = createReconcileState();
    expect(raisedKeys(reconcilePass({ project: 'acme', root, session: 'acme', home, state })))
      .toContain('message.arrived:rec-rewrite');
    // A different sender and thread carry a different signed payload, so the record's own stamp
    // moved: the pass reads it again rather than serving the verdict it cached for the old bytes.
    signedDrop(root, home, 'rec-rewrite', { from: 'alice', thread: 'rewritten-thread' });
    signedReceipt(root, home, 'rec-rewrite', 'read');
    const second = reconcilePass({ project: 'acme', root, session: 'acme', home, state });
    if (!second.ok) throw new Error(second.reason);
    expect(state.stats.filesRead).toBe(1);
    expect(raisedKeys(second)).toContain('message.read:rec-rewrite:read');
    const read = second.raised.find((record) => record.payload.record_id === 'rec-rewrite:read');
    expect(read?.payload.from).toBe('alice');
  });
});

describe('a held event lock neither loses the event nor freezes the loop', () => {
  function seatReady(root: string, ts: string): void {
    updateState(join(root, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).seats['worker-1'] = { stage: 'ready', last_active: ts };
    });
  }

  test('a refused seat event is raised by the next pass', async () => {
    const { root, home } = scratch();
    const input = { project: 'acme', root, session: 'acme', home };
    const seed = appendEvent('acme', root, home, {
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed',
      ts: BULK_TS,
      to: 'worker-1',
    });
    if (!seed.ok) throw new Error(seed.reason);
    const state = createReconcileState();
    reconcilePass({ ...input, state });
    seatReady(root, '2026-11-01T01:00:00.000Z');
    const lock = holdEventLock(root, home);
    let refused: ReconcileResult | null = null;
    try {
      // A short retry budget keeps the scene quick; the lock stays held until the pass returns.
      refused = await reconcilePassAsync({ ...input, state, sliceMs: 0, appendRetryMs: 120 });
    } finally {
      unlinkSync(lock);
    }
    if (refused === null) throw new Error('the pass did not return');
    expect(raisedKeys(refused)).toEqual([]);
    // The refused append must not move the seat's watermark: the next pass still raises it.
    const retry = reconcilePass({ ...input, state });
    expect(raisedKeys(retry)).toContain('seat.working:seat:worker-1:ready:2026-11-01T01:00:00.000Z');
  }, 15_000);

  test('the async driver waits for a held lock without freezing the loop', async () => {
    const { root, home } = scratch();
    const input = { project: 'acme', root, session: 'acme', home };
    const seed = appendEvent('acme', root, home, {
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed',
      ts: BULK_TS,
      to: 'worker-1',
    });
    if (!seed.ok) throw new Error(seed.reason);
    const state = createReconcileState();
    reconcilePass({ ...input, state });
    seatReady(root, '2026-11-01T02:00:00.000Z');
    const lock = holdEventLock(root, home);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    // The timer releases the lock while the pass is waiting: only a live event loop lets it run.
    const release = setTimeout(() => {
      try {
        unlinkSync(lock);
      } catch {}
    }, 200);
    const began = performance.now();
    let pass: ReconcileResult | null = null;
    try {
      pass = await reconcilePassAsync({ ...input, state, sliceMs: 0 });
    } finally {
      clearInterval(timer);
      clearTimeout(release);
      try {
        unlinkSync(lock);
      } catch {}
    }
    const elapsed = performance.now() - began;
    if (pass === null) throw new Error('the pass did not return');
    expect(ticks).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(3_000);
    expect(raisedKeys(pass)).toContain('seat.working:seat:worker-1:ready:2026-11-01T02:00:00.000Z');
  }, 15_000);

  test('a deferred backlog yields the loop between appends, and every record lands', async () => {
    const { root, home } = scratch();
    const input = { project: 'acme', root, session: 'acme', home };
    const state = createReconcileState();
    const count = 200;
    for (let n = 0; n < count; n += 1) {
      signedDrop(root, home, `defer-${String(n).padStart(4, '0')}`);
    }
    const seed = appendEvent('acme', root, home, {
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed',
      ts: BULK_TS,
      to: 'worker-1',
    });
    if (!seed.ok) throw new Error(seed.reason);
    const lock = holdEventLock(root, home);
    let ticks = 0;
    let released = false;
    let firstTicks = 0;
    let lastTicks = 0;
    let firstRecord = true;
    const timer = setInterval(() => {
      ticks += 1;
      // The lock stays held until every append is queued, so what the tick count measures is
      // the drain itself, not the scan that queued it.
      if (!released && state.deferred.length >= count) {
        released = true;
        try {
          unlinkSync(lock);
        } catch {}
      }
    }, 1);
    let pass: ReconcileResult | null = null;
    try {
      pass = await reconcilePassAsync({
        ...input,
        state,
        sliceMs: 0,
        onEvent: () => {
          if (firstRecord) {
            firstRecord = false;
            firstTicks = ticks;
          }
          lastTicks = ticks;
        },
      });
    } finally {
      clearInterval(timer);
      try {
        unlinkSync(lock);
      } catch {}
    }
    if (pass === null) throw new Error('the pass did not return');
    expect(released).toBe(true);
    expect(raisedKeys(pass)).toHaveLength(count);
    // The timer keeps firing between appends: the drain is sliced like the scan, not one
    // synchronous run.
    expect(lastTicks - firstTicks).toBeGreaterThan(0);
  }, 15_000);

  test('an abort raised during the deferred fan-out stops the remaining appends', async () => {
    const { root, home } = scratch();
    const input = { project: 'acme', root, session: 'acme', home };
    const state = createReconcileState();
    const count = 3;
    const stop = new AbortController();
    for (let n = 0; n < count; n += 1) {
      signedDrop(root, home, `defer-${String(n).padStart(4, '0')}`);
    }
    const seed = appendEvent('acme', root, home, {
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed',
      ts: BULK_TS,
      to: 'worker-1',
    });
    if (!seed.ok) throw new Error(seed.reason);
    const lock = holdEventLock(root, home);
    let released = false;
    const timer = setInterval(() => {
      if (!released && state.deferred.length >= count) {
        released = true;
        try {
          unlinkSync(lock);
        } catch {}
      }
    }, 1);
    let pass: ReconcileResult | null = null;
    let fanOuts = 0;
    try {
      pass = await reconcilePassAsync({
        ...input,
        state,
        signal: stop.signal,
        sliceMs: 0,
        // The first persisted record aborts the pass from its own fan-out callback.
        onEvent: () => {
          fanOuts += 1;
          stop.abort();
        },
      });
    } finally {
      clearInterval(timer);
      try {
        unlinkSync(lock);
      } catch {}
    }
    if (pass === null) throw new Error('the pass did not return');
    expect(released).toBe(true);
    expect(stop.signal.aborted).toBe(true);
    // The first record is written and fanned out; the abort in its callback stops the rest.
    expect(fanOuts).toBe(1);
    expect(raisedKeys(pass)).toHaveLength(1);
    // What the abort left is not lost: the next pass finds it in the store, and the record that
    // already landed is deduplicated rather than fanned out again. The store's listing order is
    // not lexical, so the scene names the set, not which record went first.
    const retry = await reconcilePassAsync({ ...input, state: createReconcileState(), sliceMs: 0 });
    const landed = raisedKeys(pass);
    expect(landed).toHaveLength(1);
    const recovered = raisedKeys(retry).sort();
    expect(recovered).toHaveLength(2);
    expect(recovered).not.toContain(landed[0]);
    expect([...landed, ...recovered].sort()).toEqual([
      'message.arrived:defer-0000',
      'message.arrived:defer-0001',
      'message.arrived:defer-0002',
    ]);
  }, 15_000);

  test('an abort scheduled from a fan-out lands during the yield and stops the next append', async () => {
    const { root, home } = scratch();
    const input = { project: 'acme', root, session: 'acme', home };
    const state = createReconcileState();
    const count = 3;
    const stop = new AbortController();
    for (let n = 0; n < count; n += 1) {
      signedDrop(root, home, `defer-${String(n).padStart(4, '0')}`);
    }
    const seed = appendEvent('acme', root, home, {
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed',
      ts: BULK_TS,
      to: 'worker-1',
    });
    if (!seed.ok) throw new Error(seed.reason);
    const lock = holdEventLock(root, home);
    let released = false;
    const timer = setInterval(() => {
      if (!released && state.deferred.length >= count) {
        released = true;
        try {
          unlinkSync(lock);
        } catch {}
      }
    }, 1);
    let pass: ReconcileResult | null = null;
    try {
      pass = await reconcilePassAsync({
        ...input,
        state,
        signal: stop.signal,
        sliceMs: 0,
        // The abort is scheduled, not raised in the callback: it runs on the drain's own yield,
        // between the first record's append and the second's — a boundary a check at the loop's
        // top, before the yield, cannot see.
        onEvent: () => setImmediate(() => stop.abort()),
      });
    } finally {
      clearInterval(timer);
      try {
        unlinkSync(lock);
      } catch {}
    }
    if (pass === null) throw new Error('the pass did not return');
    expect(released).toBe(true);
    expect(stop.signal.aborted).toBe(true);
    // The first record is written and fanned out; the abort the yield delivered stops the rest.
    expect(raisedKeys(pass)).toHaveLength(1);
  }, 15_000);
});

describe('closing the bus cancels the pass it started', () => {
  test('close resolves after the pass stopped, and nothing is appended after it', async () => {
    const { root, home } = scratch();
    const parsed = validateTeamFile(TEAM);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const started = await startBus({ root, team: parsed.team, home, stderr: () => {}, reconcileIntervalMs: 0 });
    if (started.kind !== 'serving') throw new Error(started.kind);
    for (let n = 0; n < 200; n += 1) {
      signedDrop(root, home, `close-${String(n).padStart(4, '0')}`);
    }
    function appended(): number {
      const read = readEvents('acme', root, home);
      if (!read.ok) throw new Error(read.reason);
      return read.events.length;
    }
    // Start the pass and close in the same turn: the pass is in flight, suspended at a slice
    // boundary, when close runs.
    const run = started.handle.reconcileNow();
    let atClose = -1;
    let raised: number = -1;
    try {
      await started.handle.close();
      atClose = appended();
      raised = (await run).length;
    } finally {
      await run;
    }
    // Close means the bus is done writing: the pass it cancelled appended nothing after close
    // resolved. The records it did not reach were not lost — no cursor advanced past them — but
    // nothing in this process writes them once the endpoint is released.
    expect(atClose).toBeGreaterThanOrEqual(0);
    expect(appended()).toBe(atClose);
    expect(raised).toBeLessThanOrEqual(atClose);
  }, 15_000);
});

describe('a bus can host its first pass in the background', () => {
  test('the start resolves before the pass raises; reconcileNow joins it; close drains a pass in flight', async () => {
    const { root, home } = scratch();
    const parsed = validateTeamFile(TEAM);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    signedDrop(root, home, 'background-0001');
    // The held event lock keeps the first pass's append deferred, so the pass is provably still
    // running — and its record provably not raised — when the background start resolves.
    const lock = holdEventLock(root, home);
    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      initialReconcile: 'background',
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    const handle = started.handle;
    function appended(): number {
      const read = readEvents('acme', root, home);
      if (!read.ok) throw new Error(read.reason);
      return read.events.length;
    }
    try {
      // Bound and answering, with the first pass still scanning: the start did not wait for it.
      // The resolved start need not have reached the pass's first slice yet, so give the
      // background walk a turn to scan before reading the live counters. The held event lock
      // keeps it from settling however many turns that takes.
      let running = handle.firstPass();
      for (let turn = 0; turn < 100 && running.scanned === 0; turn += 1) {
        await sleep(1);
        running = handle.firstPass();
      }
      expect(running.running).toBe(true);
      if (running.running) expect(running.scanned).toBeGreaterThanOrEqual(1);
      expect(appended()).toBe(0);
      // The same pass, joined rather than a second scan: releasing the lock lets its deferred
      // append land, and the handle reports the pass settled with its total and instant.
      unlinkSync(lock);
      const raised = await handle.reconcileNow();
      expect(raised.map((record) => `${record.payload.kind}:${record.payload.record_id}`))
        .toContain('message.arrived:background-0001');
      expect(appended()).toBe(1);
      const done = handle.firstPass();
      expect(done.running).toBe(false);
      if (!done.running) {
        expect(done.doneAt).not.toBeNull();
        expect(done.scanned).toBeGreaterThanOrEqual(1);
        // The walk finished, so it is not said to have stopped on a failure.
        expect(done.errors).toBe(false);
      }
      // A pass in flight when close lands is drained, and nothing is appended after close.
      for (let n = 0; n < 200; n += 1) signedDrop(root, home, `closing-${String(n).padStart(4, '0')}`);
      const run = handle.reconcileNow();
      await handle.close();
      const atClose = appended();
      await run;
      expect(appended()).toBe(atClose);
      // A later scan never rewrites the first pass's own record.
      expect(handle.firstPass().running).toBe(false);
    } finally {
      try {
        unlinkSync(lock);
      } catch {}
      await handle.close();
    }
  }, 30_000);

  test('over a 10,050-file store, the bus serves while the first pass runs, delivers a send mid-pass, and close mid-pass leaves no dangling pass', async () => {
    const { root, home } = scratch();
    const parsed = validateTeamFile(TEAM);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    seedBulkStore(root, home);
    const dir = dropsDir(root);
    for (let extra = 0; extra < 50; extra += 1) {
      writeFileSync(join(dir, `bulk-extra-${String(extra).padStart(4, '0')}`), `from clerk — admitted by: lead\n\nextra ${String(extra)}`);
    }
    // Hold the event lock only for the last signed drop so the 10k+ scan stays in flight until we
    // test mid-pass send and mid-pass close.
    signedDrop(root, home, 'zz-tail-0001');
    const delivered: SignedEventRecord[] = [];
    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      initialReconcile: 'background',
      deliver: (record) => delivered.push(record),
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    const handle = started.handle;
    try {
      // Immediately after startBus resolves, the 10,050-file scan is still running.
      const midPass = handle.firstPass();
      expect(midPass.running).toBe(true);
      expect(midPass.doneAt).toBeNull();
      expect(midPass.scanned).toBeLessThan(10_051);

      // A send landing during the 10k+ pass is nudged and delivered over the serving bus socket
      // while the first pass is still running.
      signedDrop(root, home, 'aa-mid-pass-send');
      const nudged = await nudgeBus(root, { session: 'acme', seat: 'worker-1', record_id: 'aa-mid-pass-send' });
      expect(nudged.kind).toBe('nudged');
      if (nudged.kind === 'nudged') {
        expect(nudged.duplicate).toBe(false);
        expect(nudged.event?.payload.record_id).toBe('aa-mid-pass-send');
      }
      expect(delivered.some((record) => record.payload.record_id === 'aa-mid-pass-send')).toBe(true);
      expect(handle.firstPass().running).toBe(true);

      // Closing mid-first-pass aborts and drains the in-flight 10k+ pass; nothing continues
      // scanning or appending after close() resolves.
      await handle.close();
      const scannedAtClose = handle.firstPass().scanned;
      const eventsAtClose = readEvents('acme', root, home);
      if (!eventsAtClose.ok) throw new Error(eventsAtClose.reason);
      const countAtClose = eventsAtClose.events.length;
      await sleep(40);
      expect(handle.firstPass().scanned).toBe(scannedAtClose);
      const eventsAfterWait = readEvents('acme', root, home);
      if (!eventsAfterWait.ok) throw new Error(eventsAfterWait.reason);
      expect(eventsAfterWait.events.length).toBe(countAtClose);
    } finally {
      await handle.close();
    }
  }, 60_000);

  test('the default startBus mode (await) finishes the first pass before resolving', async () => {
    const { root, home } = scratch();
    const parsed = validateTeamFile(TEAM);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    signedDrop(root, home, 'default-await-0001');
    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    try {
      const pass = started.handle.firstPass();
      expect(pass.running).toBe(false);
      if (!pass.running) {
        expect(typeof pass.doneAt).toBe('string');
        expect(pass.scanned).toBe(1);
      }
      const events = readEvents('acme', root, home);
      if (!events.ok) throw new Error(events.reason);
      expect(events.events.map((e) => e.payload.record_id)).toContain('default-await-0001');
    } finally {
      await started.handle.close();
    }
  }, 15_000);

  test('a first pass a closing bus aborts is never reported as done', async () => {
    const { root, home } = scratch();
    const parsed = validateTeamFile(TEAM);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    signedDrop(root, home, 'aborted-0001');
    // The held event lock keeps the first pass's append deferred, so the pass is provably still
    // in flight when close lands.
    const lock = holdEventLock(root, home);
    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      initialReconcile: 'background',
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    const handle = started.handle;
    try {
      expect(handle.firstPass().running).toBe(true);
      // close aborts the walk; the pass answers cancelled rather than failed, and nothing stamps
      // it settled. A reader must never see this pass as a clean finish it never reached.
      await handle.close();
      const after = handle.firstPass();
      expect(after.running).toBe(true);
      if (after.running) expect(after.doneAt).toBeNull();
    } finally {
      try {
        unlinkSync(lock);
      } catch {}
      await handle.close();
    }
  }, 15_000);
});

describe('the daemon heartbeat and endpoint supervision', () => {
  test('a pending endpoint start leaves the daemon heartbeating and its root recorded as starting', async () => {
    const { root, home } = scratch();
    let resolveSend!: (value: { kind: 'locked'; holderPid: number | null }) => void;
    const gate = new Promise<{ kind: 'locked'; holderPid: number | null }>((resolve) => {
      resolveSend = resolve;
    });
    const started = startMachineDaemon({
      home,
      roots: [root],
      version: 'test',
      heartbeatMs: 5,
      sendStart: () => gate,
    });
    try {
      const first = await waitForValue(() => {
        const read = readDaemonState(home);
        if (read.kind !== 'ok') return null;
        const entry = read.state.roots[0];
        return entry?.send === 'starting' && entry.bus === 'starting'
          ? { heartbeatAt: read.state.heartbeatAt, root: entry.root }
          : null;
      }, 5_000);
      expect(first.root).toBe(root);
      await sleep(30);
      const later = readStateOk(home);
      expect(later.heartbeatAt).not.toBe(first.heartbeatAt);
      expect(later.roots[0]?.send).toBe('starting');
    } finally {
      resolveSend({ kind: 'locked', holderPid: 1 });
    }
    const result = await started;
    expect(result.kind).toBe('serving');
    if (result.kind === 'serving') await result.daemon.close();
  }, 30_000);

  test('a 10,000-file first pass runs behind a serving bus and never stops the heartbeat', async () => {
    const { root, home } = scratch();
    seedBulkStore(root, home);
    const started = startMachineDaemon({
      home,
      roots: [root],
      version: 'test',
      heartbeatMs: 5,
      sendStart: async () => ({ kind: 'already-running', socketPath: join(home, 'absent-send.sock'), pid: null }),
    });
    // The bus serves once its listener is bound; the first pass scans behind it and the row says
    // how far it has got, so serving is not read as caught up while the heartbeat keeps beating.
    const first = await waitForValue(() => {
      const read = readDaemonState(home);
      if (read.kind !== 'ok') return null;
      const entry = read.state.roots[0];
      return entry?.bus === 'serving' && entry.firstPass?.running === true
        ? { heartbeatAt: read.state.heartbeatAt, scanned: entry.firstPass.scanned }
        : null;
    }, 5_000);
    await sleep(40);
    const later = readStateOk(home);
    expect(later.heartbeatAt).not.toBe(first.heartbeatAt);
    expect(later.roots[0]?.bus).toBe('serving');
    expect(later.roots[0]?.firstPass?.running).toBe(true);
    // The start returned while the pass still ran; close aborts and drains it.
    const result = await started;
    expect(result.kind).toBe('serving');
    if (result.kind === 'serving') await result.daemon.close();
  }, 120_000);

  test('a dead send endpoint is closed and started again; a start that keeps failing stops the daemon once', async () => {
    const { root, home } = scratch();
    let starts = 0;
    const fatal: string[] = [];
    const handle = (name: string): SendDaemonHandle => ({
      socketPath: join(home, `${name}.sock`),
      lockPath: join(home, `${name}.lock`),
      close: async () => {},
      deliver: async () => {
        throw new Error('the scene never delivers');
      },
    });
    const started = await startMachineDaemon({
      home,
      roots: [root],
      version: 'test',
      heartbeatMs: 5,
      sendStart: async () => {
        starts += 1;
        if (starts === 1) return { kind: 'serving' as const, handle: handle('dead-send') };
        return { kind: 'locked' as const, holderPid: 1 };
      },
      sendRestart: { giveUp: 2, backoffMs: () => 0 },
      onFatal: (why) => fatal.push(why),
    });
    if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
    try {
      await waitForValue(() => (fatal.length > 0 ? fatal[0]! : null), 10_000);
      expect(starts).toBeGreaterThanOrEqual(3);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toContain('failed 2 restarts in a row');
      // The refresh writes the record after it reports the stop, so the scene waits for that row.
      const written = await waitForValue(() => {
        const read = readDaemonState(home);
        if (read.kind !== 'ok') return null;
        return read.state.roots[0]?.send === 'failed' ? read.state : null;
      }, 5_000);
      expect(written.roots[0]?.send).toBe('failed');
      expect(written.roots[0]?.sendWhy).toContain('another send server holds the project socket');
      expect(typeof written.roots[0]?.sendFailedAt).toBe('string');
    } finally {
      await started.daemon.close();
    }
  }, 30_000);
});

describe('a failed endpoint is a difference a reader can act on', () => {
  function healthWithFailedSend(): DaemonHealth {
    return {
      daemon: 'teamcli',
      socket: '/synthetic/daemon.sock',
      state: 'running',
      running: true,
      pid: 42,
      uid: 501,
      since: '2026-11-01T00:00:00.000Z',
      startedBy: 'service-manager',
      version: 'test',
      gitHead: null,
      heartbeatAt: '2026-11-01T00:00:12.000Z',
      heartbeatSeconds: null,
      features: { broker: 'absent' },
      stuck: [],
      roots: [
        {
          root: '/synthetic/repo',
          team: 'acme',
          send: 'failed',
          bus: 'serving',
          why: 'the hosted send endpoint stopped answering',
          sendFailedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      probe: { state: 'answered', at: '2026-11-01T00:00:12.000Z' },
      why: null,
    };
  }

  test('the status line names the failed endpoint, its reason and its age', () => {
    const [line] = daemonNotes(healthWithFailedSend());
    expect(line).toContain('send for /synthetic/repo: the hosted send endpoint stopped answering, failing for 12s');
    expect(line).toContain('1 endpoint did not start here');
  });

  test('status and check carry it as a difference with the owner repair', () => {
    const rows = daemonDifferences(healthWithFailedSend(), new Date('2026-11-01T00:00:12.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.what).toContain('machine daemon send endpoint for /synthetic/repo');
    expect(rows[0]?.what).toContain('failing for 12s');
    expect(rows[0]?.repair).toBe('team daemon install');
    expect(rows[0]?.owner).toBe(true);
  });

  test('a record written before the failure instant is kept still names the failure', () => {
    const health = healthWithFailedSend();
    const roots = health.roots as Array<Record<string, unknown>>;
    const first = roots[0];
    if (first === undefined) throw new Error('the fixture has one root');
    delete first.sendFailedAt;
    const [line] = daemonNotes(health);
    // The age is optional; the failure is not. Losing the row with the stamp would let an old
    // record report full health while its endpoint is still down.
    expect(line).toContain('send for /synthetic/repo: the hosted send endpoint stopped answering');
    expect(line).toContain('1 endpoint did not start here');
    expect(line).not.toContain('failing for');
    const rows = daemonDifferences(health, new Date('2026-11-01T00:00:12.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.what).toContain('machine daemon send endpoint for /synthetic/repo');
    expect(rows[0]?.what).not.toContain('failing for');
  });
});

// A health snapshot that is not running has no endpoint difference: absence is already said by
// status and is ordinary for check.
describe('a daemon that is not running is not an endpoint difference', () => {
  test('no rows', () => {
    const health = { ...({} as DaemonHealth), state: 'not-running' } as DaemonHealth;
    expect(daemonDifferences(health, new Date('2026-11-01T00:00:12.000Z'))).toEqual([]);
  });
});

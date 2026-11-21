// rfc-event-comms §1, step E4: the receiver's queue, written in shadow by every ingress. The
// index is one entry NAME per seq (`entries/<seq>.<msg_id>`). The gates: a writer killed at each
// step boundary (record, entry) leaves a state the orphan source settles from the record; an
// earlier build's journal is folded into entry names; concurrent writers never share a seq; the
// orphan scan appends a record no writer indexed; a legacy read in the gap sees the record once and
// the queue exposes nothing; a queue that cannot be used never changes the write.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { acquireLockAt } from '../src/launch/seat-lock.ts';
import { messageKeyPath } from '../src/store/keys.ts';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDeliverySync, appendRecovered, currentGenerationName, entriesOf, queueBaseOf, queuedHint, queuePlaceOf, recoverSessionQueues, verifiedQueuePlaceOf } from '../src/queue/append.ts';
import { listDrops } from '../src/commands/drops.ts';
import { signRecord, writeRecord, type SignedRecord } from '../src/send/record.ts';

const SESSION = 'demo';
const SEAT = 'worker';
const CHILD = join(import.meta.dir, 'helpers', 'queue-crash-child.ts');

let base = '';
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function scene(): { root: string; home: string; dropDir: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'queue-e4-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const dropDir = join(root, '.agents', 'send-drops', SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home, dropDir };
}

function id(n: number): string {
  return `a4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function recordOf(root: string, home: string, msgId: string): SignedRecord {
  return signRecord({
    kind: 'message', id: msgId, to: SEAT, to_id: null, root, session: SESSION, at: '2026-11-17T22:00:00.000Z',
    body: `body of ${msgId}`, from: 'tester', from_id: null, rule: 'test', thread: msgId,
  }, home);
}

function append(s: { root: string; home: string; dropDir: string }, msgId: string) {
  const record = recordOf(s.root, s.home, msgId);
  return appendDeliverySync({ dropDir: s.dropDir, record }, () => {
    const result = writeRecord(s.dropDir, record);
    return { ok: result.ok, value: result };
  }, { home: s.home });
}

function crashAt(s: { root: string; home: string; dropDir: string }, msgId: string, step: string): number {
  // The key exists before the child signs with it.
  recordOf(s.root, s.home, id(999));
  const ran = spawnSync(process.execPath, [CHILD, s.dropDir, s.home, s.root, SESSION, SEAT, msgId, step], { encoding: 'utf8' });
  return ran.status ?? -1;
}

const TARGET = (s: { root: string }) => ({ root: s.root, session: SESSION, seat: SEAT });

function recovered(s: { root: string; home: string; dropDir: string }, msgId: string) {
  return appendRecovered(s.dropDir, TARGET(s), msgId, { home: s.home });
}

describe('appendDelivery: the commit', () => {
  test('two deliveries commit seq 1 and 2 in order; the same id again is the existing seq', () => {
    const s = scene();
    expect(append(s, id(1)).queue).toMatchObject({ kind: 'committed', seq: 1 });
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
    // A second write of a committed id: the record write refuses as before, the queue answers the seq.
    const again = append(s, id(1));
    expect(again.value.ok).toBe(false);
    expect(again.queue).toMatchObject({ kind: 'existing', seq: 1 });
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
  });

  test('a write that fails takes no seq', () => {
    const s = scene();
    const record = recordOf(s.root, s.home, id(1));
    const failed = appendDeliverySync({ dropDir: s.dropDir, record }, () => ({ ok: false, value: 'refused' }), { home: s.home });
    expect(failed.value).toBe('refused');
    expect(failed.queue).toMatchObject({ kind: 'void' });
    expect(entriesOf(s.dropDir)).toEqual([]);
    expect(append(s, id(1)).queue).toMatchObject({ kind: 'committed', seq: 1 });
  });

  test('one append writes one entry name and nothing else in the queue', () => {
    const s = scene();
    append(s, id(1));
    const generation = join(queueBaseOf(s.dropDir)!, currentGenerationName(s.dropDir)!);
    expect(readdirSync(generation)).toEqual(['entries']);
    expect(readdirSync(join(generation, 'entries'))).toEqual([`000000000001.${id(1)}`]);
    expect(readFileSync(join(generation, 'entries', `000000000001.${id(1)}`), 'utf8')).toBe('');
  });
});

describe('appendDelivery: a writer killed at each step boundary', () => {
  test('killed after the record (no entry): the next append takes the next seq, the orphan source appends the record after it', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    expect(existsSync(join(s.dropDir, id(1)))).toBe(true);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 1 });
    expect(queuedHint(s.dropDir, id(1))).toBe(false);
    expect(recovered(s, id(1))).toMatchObject({ kind: 'committed', seq: 2, recovered: true });
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
  });

  test('killed after the entry (lock never released): the dead holder\'s lock is taken over', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'entry')).toBe(9);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
    expect(queuedHint(s.dropDir, id(1))).toBe(true);
  });

  test('a record at its name that does not verify is never placed', () => {
    const s = scene();
    append(s, id(2));
    writeFileSync(join(s.dropDir, id(1)), '{"payload":{},"signature":"00"}\n');
    expect(recovered(s, id(1))).toMatchObject({ kind: 'skipped', reason: 'the record does not verify for this seat' });
    expect(queuedHint(s.dropDir, id(1))).toBe(false);
  });
});

describe('read old, write new: an earlier build\'s journal', () => {
  function legacy(s: { root: string; home: string; dropDir: string }, lines: object[]): string {
    const queue = queueBaseOf(s.dropDir)!;
    const folder = join(queue, 'g00000000000000aa');
    mkdirSync(join(folder, 'entries'), { recursive: true });
    mkdirSync(join(folder, 'ids'), { recursive: true });
    writeFileSync(join(queue, 'current'), 'g00000000000000aa\n');
    writeFileSync(join(folder, 'journal.jsonl'), lines.map((line) => `${JSON.stringify({ v: 1, op_key: 'k', at: 'x', ...line })}\n`).join(''));
    writeFileSync(join(folder, 'entries', '000000000001'), '{}\n');
    return folder;
  }

  test('the first lock holder folds committed lines into entry names; a reserved one is left to its record; nothing is numbered twice', () => {
    const s = scene();
    for (const n of [1, 2, 3]) writeRecord(s.dropDir, recordOf(s.root, s.home, id(n)));
    const folder = legacy(s, [
      { seq: 1, msg_id: id(1), state: 'reserved' }, { seq: 1, msg_id: id(1), state: 'committed' },
      { seq: 2, msg_id: id(2), state: 'reserved' },
      { seq: 3, msg_id: id(3), state: 'committed' },
    ]);
    expect(recoverSessionQueues(s.root, SESSION, { home: s.home })).toEqual([]);
    expect(existsSync(join(folder, 'journal.jsonl'))).toBe(false);
    expect(entriesOf(s.dropDir)).toEqual([1, 3]);
    expect(verifiedQueuePlaceOf(s.dropDir, id(1), TARGET(s), s.home)).toEqual({ generation: 'g00000000000000aa', seq: 1 });
    expect(queuedHint(s.dropDir, id(2))).toBe(false);
    expect(append(s, id(4)).queue).toMatchObject({ kind: 'committed', seq: 4 });
    expect(recovered(s, id(2))).toMatchObject({ kind: 'committed', seq: 5 });
    // An older build that wrote its journal again over the folded generation: a seq or an id
    // already named is never named twice; the record is the orphan source's.
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(6)));
    writeFileSync(join(folder, 'journal.jsonl'), `${JSON.stringify({ v: 1, seq: 1, msg_id: id(6), op_key: 'k', state: 'committed', at: 'x' })}\n${JSON.stringify({ v: 1, seq: 9, msg_id: id(1), op_key: 'k', state: 'committed', at: 'x' })}\nnot json\n`);
    expect(append(s, id(7)).queue).toMatchObject({ kind: 'committed', seq: 6 });
    expect(queuePlaceOf(s.dropDir, id(6))).toBe(null);
    expect(queuePlaceOf(s.dropDir, id(1))?.seq).toBe(1);
    expect(existsSync(join(folder, 'journal.jsonl'))).toBe(false);
  });
});

describe('concurrent writers', () => {
  test('eight processes appending at once share no seq and lose no id', async () => {
    const s = scene();
    recordOf(s.root, s.home, id(999));
    const runs = Array.from({ length: 8 }, (_, n) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [CHILD, s.dropDir, s.home, s.root, SESSION, SEAT, id(n + 1), 'none']);
      child.on('exit', (code) => resolve(code ?? -1));
    }));
    expect(await Promise.all(runs)).toEqual(Array(8).fill(0));
    expect(entriesOf(s.dropDir)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(Array.from({ length: 8 }, (_, n) => queuePlaceOf(s.dropDir, id(n + 1))?.seq)).size).toBe(8);
  });

  test('two writers after a crash share no seq; the crashed record is appended once after them', async () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    const runs = [2, 3].map((n) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [CHILD, s.dropDir, s.home, s.root, SESSION, SEAT, id(n), 'none']);
      child.on('exit', (code) => resolve(code ?? -1));
    }));
    expect(await Promise.all(runs)).toEqual([0, 0]);
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
    expect(recovered(s, id(1))).toMatchObject({ kind: 'committed', seq: 3 });
    expect(recovered(s, id(1))).toMatchObject({ kind: 'existing', seq: 3 });
  });
});

describe('the orphan source', () => {
  test('a record written without the queue is appended once, flagged recovered', () => {
    const s = scene();
    append(s, id(1));
    const orphan = recordOf(s.root, s.home, id(2));
    expect(writeRecord(s.dropDir, orphan).ok).toBe(true);
    const target = { root: s.root, session: SESSION, seat: SEAT };
    expect(appendRecovered(s.dropDir, target, id(2), { home: s.home })).toMatchObject({ kind: 'committed', seq: 2, recovered: true });
    expect(appendRecovered(s.dropDir, target, id(2), { home: s.home })).toMatchObject({ kind: 'existing', seq: 2 });
    expect(appendRecovered(s.dropDir, target, id(3), { home: s.home }).kind).toBe('skipped');
  });
});

describe('shadow: the queue never changes the write', () => {
  test('a queue folder that cannot be made: the record is written exactly as before', () => {
    const s = scene();
    const queues = join(s.root, '.agents', 'queues');
    writeFileSync(queues, 'not a folder');
    const lines: string[] = [];
    const record = recordOf(s.root, s.home, id(1));
    const out = appendDeliverySync({ dropDir: s.dropDir, record }, () => {
      const result = writeRecord(s.dropDir, record);
      return { ok: result.ok, value: result };
    }, { home: s.home, log: (line) => lines.push(line) });
    expect(out.value.ok).toBe(true);
    expect(out.queue.kind).toBe('skipped');
    expect(existsSync(join(s.dropDir, id(1)))).toBe(true);
    expect(lines.join('\n')).toContain('queue skipped');
  });

  test('a folder that is not a seat drop folder is written without a queue', () => {
    const s = scene();
    const other = join(base, 'inbox');
    mkdirSync(other);
    const record = recordOf(s.root, s.home, id(1));
    const out = appendDeliverySync({ dropDir: other, record }, () => {
      writeFileSync(join(other, id(1)), 'x');
      return { ok: true, value: null };
    }, { home: s.home });
    expect(out.queue).toEqual({ kind: 'skipped', reason: 'the folder is not a seat drop folder' });
    expect(existsSync(join(s.root, '.agents', 'queues'))).toBe(false);
  });

  test('a legacy read in the gap (record written, entry not yet) sees the record once; the queue adds nothing it reads', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    const rows = (dir: string) => { const listed = listDrops(dir); return listed.kind === 'ok' ? listed.rows.map((row) => row.id) : []; };
    const listed = rows(s.dropDir);
    expect(listed.filter((one) => one === id(1))).toHaveLength(1);
    append(s, id(2));
    const after = rows(s.dropDir);
    expect(after.filter((one) => one === id(1))).toHaveLength(1);
    // Nothing the queue writes lands in the drop folder a reader lists.
    expect(readdirSync(s.dropDir).every((name) => !name.includes('queue'))).toBe(true);
  });
});

// Review round 1 (Hermes, Hestia): the gates the first diff missed.

function genFolder(dropDir: string): string {
  return join(queueBaseOf(dropDir)!, currentGenerationName(dropDir)!);
}

describe('round 1: a proof reads the record even when the entry was written', () => {
  for (const [label, damage] of [
    ['removed', (s: { dropDir: string }) => unlinkSync(join(s.dropDir, id(1)))],
    ['corrupt', (s: { dropDir: string }) => writeFileSync(join(s.dropDir, id(1)), 'not json\n')],
    // A record replaced by another body this checkout signed for the same id and seat IS the
    // record now (`writeRecordOver`): the name proves the place, the record proves the body.
  ] as const) {
    test(`killed after the entry, record then ${label}: no proved placement`, () => {
      const s = scene();
      expect(crashAt(s, id(1), 'entry')).toBe(9);
      damage(s);
      append(s, id(2));
      expect(verifiedQueuePlaceOf(s.dropDir, id(1), TARGET(s), s.home)).toBe(null);
    });
  }
});

describe('round 1: an unreadable or linked index is never treated as empty', () => {
  test('entries replaced by a link: the queue is skipped, the record is written once, the link target is untouched', () => {
    const s = scene();
    append(s, id(1));
    const folder = genFolder(s.dropDir);
    const outside = join(base, 'outside');
    renameSync(join(folder, 'entries'), outside);
    symlinkSync(outside, join(folder, 'entries'));
    const before = readdirSync(outside);
    let writes = 0;
    const record = recordOf(s.root, s.home, id(2));
    const out = appendDeliverySync({ dropDir: s.dropDir, record }, () => {
      writes += 1;
      const result = writeRecord(s.dropDir, record);
      return { ok: result.ok, value: result };
    }, { home: s.home });
    expect(writes).toBe(1);
    expect(out.value.ok).toBe(true);
    expect(out.queue).toEqual({ kind: 'skipped', reason: 'the queue entries cannot be listed' });
    expect(readdirSync(outside)).toEqual(before);
  });
});

describe('round 1: the record is durable before the entry names it', () => {
  test('the order is record flush, record folder flush, entry, committed line', () => {
    const s = scene();
    const points: string[] = [];
    const record = recordOf(s.root, s.home, id(1));
    appendDeliverySync({ dropDir: s.dropDir, record }, () => {
      const result = writeRecord(s.dropDir, record);
      return { ok: result.ok, value: result };
    }, { home: s.home, trace: (point) => points.push(point) });
    expect(points).toEqual(['record-fsync', 'record-folder-fsync', 'entry']);
  });

  test('a record flush that fails names no entry and leaves the write as it was; the orphan source appends it', () => {
    const s = scene();
    const record = recordOf(s.root, s.home, id(1));
    const out = appendDeliverySync({ dropDir: s.dropDir, record }, () => {
      const result = writeRecord(s.dropDir, record);
      return { ok: result.ok, value: result };
    }, { home: s.home, syncRecord: () => { throw new Error('EIO'); } });
    expect(out.value.ok).toBe(true);
    expect(out.queue.kind).toBe('skipped');
    expect(entriesOf(s.dropDir)).toEqual([]);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 1 });
    expect(recovered(s, id(1))).toMatchObject({ kind: 'committed', seq: 2 });
  });
});

describe('round 1: the orphan source through the bus\'s own reconcile pass', () => {
  const pass = (s: { root: string; home: string }, state = createReconcileState()) =>
    reconcilePass({ project: SESSION, root: s.root, session: SESSION, home: s.home, state });

  test('an existing queue and a new raw record: the pass indexes it; a removed entry name is placed again', () => {
    const s = scene();
    append(s, id(1));
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(2)));
    pass(s);
    expect(queuePlaceOf(s.dropDir, id(2))?.seq).toBe(2);
    unlinkSync(join(genFolder(s.dropDir), 'entries', `000000000001.${id(1)}`));
    pass(s);
    expect(queuePlaceOf(s.dropDir, id(1))?.seq).toBe(3);
  });

  test('the cache is bound to the generation: after a replacement both records are indexed once in the new one', () => {
    const s = scene();
    const state = createReconcileState();
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(1)));
    pass(s, state);
    const first = currentGenerationName(s.dropDir)!;
    writeFileSync(join(queueBaseOf(s.dropDir)!, 'current'), 'names no generation\n');
    append(s, id(2));
    const second = currentGenerationName(s.dropDir)!;
    expect(second).not.toBe(first);
    pass(s, state);
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
    expect([queuedHint(s.dropDir, id(1)), queuedHint(s.dropDir, id(2))]).toEqual([true, true]);
  });

  test('a held queue lock: the pass does not wait, and indexes the record on a later pass', () => {
    const s = scene();
    append(s, id(1));
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(2)));
    const queue = queueBaseOf(s.dropDir)!;
    const lock = acquireLockAt(join(queue, 'lock'), queue);
    if (!('release' in lock)) throw new Error('the test could not hold the lock');
    const state = createReconcileState();
    const started = performance.now();
    pass(s, state);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(queuedHint(s.dropDir, id(2))).toBe(false);
    lock.release();
    pass(s, state);
    expect(queuedHint(s.dropDir, id(2))).toBe(true);
  });

  test('a queue write that fails is contained: the pass goes on, and the record is indexed once the queue is repaired', () => {
    const s = scene();
    append(s, id(1));
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(2)));
    writeRecord(s.dropDir, recordOf(s.root, s.home, id(3)));
    const entries = join(genFolder(s.dropDir), 'entries');
    const aside = join(base, 'entries-aside');
    renameSync(entries, aside);
    writeFileSync(entries, 'not a folder');
    const state = createReconcileState();
    const raised: string[] = [];
    reconcilePass({ project: SESSION, root: s.root, session: SESSION, home: s.home, state, onEvent: (event) => raised.push(event.payload.record_id) });
    expect(raised).toContain(id(3));
    unlinkSync(entries);
    renameSync(aside, entries);
    pass(s, state);
    expect(queuedHint(s.dropDir, id(2))).toBe(true);
    expect(queuedHint(s.dropDir, id(3))).toBe(true);
  });
});

describe('round 2: uncertainty places nothing, then the record is appended', () => {
  test('a stat failure that is not ENOENT places nothing; after repair it is appended at seq 1', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    const aside = join(base, 'drops-aside');
    renameSync(s.dropDir, aside);
    writeFileSync(s.dropDir, 'a file where the folder was');
    expect(recovered(s, id(1)).kind).toBe('skipped');
    unlinkSync(s.dropDir);
    renameSync(aside, s.dropDir);
    expect(recovered(s, id(1))).toMatchObject({ kind: 'committed', seq: 1 });
  });

  test('no verification key: nothing is placed and no key is made; with the key back it is appended at seq 1', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    const keyPath = messageKeyPath(s.home);
    expect(existsSync(keyPath)).toBe(true);
    const aside = join(base, 'key-aside.json');
    renameSync(keyPath, aside);
    expect(recovered(s, id(1)).kind).toBe('skipped');
    expect(existsSync(keyPath)).toBe(false);
    renameSync(aside, keyPath);
    expect(recovered(s, id(1))).toMatchObject({ kind: 'committed', seq: 1 });
  });
});

describe('round 3: a metadata fault on the queue\'s own files is never read as missing', () => {
  const eio = (target: string) => (path: string) => {
    if (path === target) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return lstatSync(path);
  };

  test('pointer: a stat EIO skips the queue and never starts a new generation', () => {
    const s = scene();
    append(s, id(1));
    const before = currentGenerationName(s.dropDir);
    const pointer = join(queueBaseOf(s.dropDir)!, 'current');
    const record = recordOf(s.root, s.home, id(2));
    const out = appendDeliverySync({ dropDir: s.dropDir, record }, () => {
      const result = writeRecord(s.dropDir, record);
      return { ok: result.ok, value: result };
    }, { home: s.home, stat: eio(pointer) });
    expect(out.queue.kind).toBe('skipped');
    expect(currentGenerationName(s.dropDir)).toBe(before);
  });
});

// rfc-event-comms §1, step E4: the receiver's queue, written in shadow by every ingress.
// The gates: a writer killed at each step boundary (reserve, record, entry, mark) leaves a state the
// next lock holder settles from the record; a torn journal tail is cut back; concurrent writers and
// repairers never share a seq; the orphan scan appends a record no writer indexed; a legacy read in
// the gap sees the record once and the queue exposes nothing; a queue that cannot be used never
// changes the write.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDeliverySync, appendRecovered, entriesOf, journalOf, queueBaseOf, queuedHint, recoverSessionQueues } from '../src/queue/append.ts';
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

function lastStates(dropDir: string): Map<number, string> {
  const states = new Map<number, string>();
  for (const line of journalOf(dropDir).lines) states.set(line.seq, line.state);
  return states;
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

  test('a write that fails voids its reserved seq; the seq is never reused', () => {
    const s = scene();
    const record = recordOf(s.root, s.home, id(1));
    const failed = appendDeliverySync({ dropDir: s.dropDir, record }, () => ({ ok: false, value: 'refused' }), { home: s.home });
    expect(failed.value).toBe('refused');
    expect(failed.queue).toMatchObject({ kind: 'void', seq: 1 });
    expect(append(s, id(1)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(lastStates(s.dropDir)).toEqual(new Map([[1, 'void'], [2, 'committed']]));
  });
});

describe('appendDelivery: a writer killed at each step boundary', () => {
  test('killed after the reserve (no record): the next holder voids the seq', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'reserve')).toBe(9);
    expect(existsSync(join(s.dropDir, id(1)))).toBe(false);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(lastStates(s.dropDir).get(1)).toBe('void');
  });

  test('killed after the record (no entry): the next holder commits it at its reserved seq', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    expect(existsSync(join(s.dropDir, id(1)))).toBe(true);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(lastStates(s.dropDir)).toEqual(new Map([[1, 'committed'], [2, 'committed']]));
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
    expect(queuedHint(s.dropDir, id(1))).toBe(true);
  });

  test('killed after the entry (not marked): the next holder marks it committed', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'entry')).toBe(9);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(lastStates(s.dropDir).get(1)).toBe('committed');
    expect(entriesOf(s.dropDir)).toEqual([1, 2]);
  });

  test('killed after the mark (lock never released): the dead holder\'s lock is taken over', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'mark')).toBe(9);
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    expect(lastStates(s.dropDir)).toEqual(new Map([[1, 'committed'], [2, 'committed']]));
  });

  test('a record at a reserved name that does not verify voids the seq as corrupt', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'reserve')).toBe(9);
    writeFileSync(join(s.dropDir, id(1)), '{"payload":{},"signature":"00"}\n');
    append(s, id(2));
    const line = journalOf(s.dropDir).lines.find((one) => one.seq === 1 && one.state === 'void');
    expect(line?.reason).toContain('does not verify');
  });
});

describe('recovery on daemon start', () => {
  test('the bus\'s first pass settles a hole a dead writer left, with no new append', () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    expect(lastStates(s.dropDir).get(1)).toBe('reserved');
    expect(recoverSessionQueues(s.root, SESSION, { home: s.home })).toEqual([]);
    expect(lastStates(s.dropDir).get(1)).toBe('committed');
    expect(entriesOf(s.dropDir)).toEqual([1]);
  });
});

describe('the journal', () => {
  test('a torn tail is cut back to the last whole line, and appends continue', () => {
    const s = scene();
    append(s, id(1));
    const { generation } = journalOf(s.dropDir);
    const path = join(queueBaseOf(s.dropDir)!, generation!, 'journal.jsonl');
    appendFileSync(path, '{"v":1,"seq":2,"msg_id":"half');
    expect(append(s, id(2)).queue).toMatchObject({ kind: 'committed', seq: 2 });
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('half');
  });

  test('a corrupt line before the tail starts a new generation; the old one is left as it was', () => {
    const s = scene();
    append(s, id(1));
    const before = journalOf(s.dropDir).generation!;
    const path = join(queueBaseOf(s.dropDir)!, before, 'journal.jsonl');
    writeFileSync(path, `not json\n${readFileSync(path, 'utf8')}`);
    const after = append(s, id(2)).queue;
    expect(after.kind).toBe('committed');
    const now = journalOf(s.dropDir).generation!;
    expect(now).not.toBe(before);
    expect(existsSync(path)).toBe(true);
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
    const lines = journalOf(s.dropDir).lines.filter((line) => line.state === 'committed');
    const seqs = lines.map((line) => line.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(lines.map((line) => line.msg_id)).size).toBe(8);
  });

  test('two repairers after a crash settle the hole once', async () => {
    const s = scene();
    expect(crashAt(s, id(1), 'record')).toBe(9);
    const runs = [2, 3].map((n) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [CHILD, s.dropDir, s.home, s.root, SESSION, SEAT, id(n), 'none']);
      child.on('exit', (code) => resolve(code ?? -1));
    }));
    expect(await Promise.all(runs)).toEqual([0, 0]);
    const committed = journalOf(s.dropDir).lines.filter((line) => line.state === 'committed');
    expect(committed.filter((line) => line.seq === 1)).toHaveLength(1);
    expect(entriesOf(s.dropDir)).toEqual([1, 2, 3]);
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

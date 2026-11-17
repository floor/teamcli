// The receiving seat's delivery queue: a sequence index over the signed message records
// (rfc-event-comms §1, step E4). The record stays the one immutable copy of every message; the
// queue only numbers records per receiving seat. E4 writes it in shadow: no reader uses it yet,
// and nothing a send or a reader does depends on it.
//
// Layout, one folder per receiving seat beside the drop folders:
//   .agents/queues/<session>/<seat>/current            the current generation's name
//   .agents/queues/<session>/<seat>/lock               the receiver's queue lock (the seat lock's rule)
//   .agents/queues/<session>/<seat>/<gen>/journal.jsonl one line per intent change, fsynced
//   .agents/queues/<session>/<seat>/<gen>/entries/<seq> one signed entry per committed seq
//   .agents/queues/<session>/<seat>/<gen>/ids/<msg_id> the seq a committed msg_id holds
//
// The commit (§1), under the receiver's queue lock:
//   1. reserve: journal line {seq, msg_id, op_key, state: reserved}, fsynced;
//   2. record: the caller's own record write, exactly as before E4;
//   3. entry: the signed entry, then the id file, then journal {state: committed}, each fsynced;
//   4. release.
// Recovery runs under the same lock before every append: a reserved intent below the lock was
// left by a writer that died (the writer holds the lock for its whole commit), so its record
// decides it — present and verifying commits it at its reserved seq, absent voids it, present and
// not verifying voids it as corrupt. A torn journal tail is cut back to its last whole line.
//
// Shadow rule (E4): the queue never changes what the caller's write does. A queue that cannot be
// locked, read or written is logged and the record is written exactly as before; the bus's
// reconcile pass finds a record with no committed entry and appends it as `recovered`
// (`appendRecovered`), so the index converges without the writer.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, readdirSync } from 'node:fs';
import { ftruncateSync, mkdirSync, openSync, renameSync, writeSync } from '../host/guarded-fs.ts';
import { basename, dirname, join } from 'node:path';
import { acquireLockAt, type LockSteps } from '../launch/seat-lock.ts';
import { messageKeyOf, messageKeyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { readNoFollow } from '../send/history.ts';
import { recordFile, sameFolder, signedRecordOf, verifyRecord, type SignedRecord } from '../send/record.ts';

/** The domain a queue entry is signed over. */
export const QUEUE_DOMAIN = 'team-queue-v1\n';

/** The steps a crash can stop between (the fault gates name them). */
export type AppendStep = 'reserve' | 'record' | 'entry' | 'mark';

export type JournalState = 'reserved' | 'committed' | 'void';

export type JournalLine = {
  v: 1;
  seq: number;
  msg_id: string;
  op_key: string;
  state: JournalState;
  at: string;
  recovered?: true;
  reason?: string;
};

export type QueueEntryPayload = {
  v: 1;
  kind: 'queue-entry';
  root: string;
  session: string;
  seat: string;
  generation: string;
  seq: number;
  msg_id: string;
  record_digest: string;
  recovered?: true;
};

export type QueueEntry = { payload: QueueEntryPayload; signature: string };

/** What the queue did for one append. Never a reason to change the write's own outcome. */
export type QueueOutcome =
  | { kind: 'committed'; generation: string; seq: number; recovered?: true }
  | { kind: 'existing'; generation: string; seq: number }
  | { kind: 'void'; generation: string; seq: number; reason: string }
  | { kind: 'skipped'; reason: string };

export type QueueOptions = {
  home: string;
  /** Test seam: called after each step; a crash test exits the process here. */
  after?: (step: AppendStep) => void;
  lock?: Partial<LockSteps>;
  /** How long an append waits for the receiver's lock. */
  lockWaitMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
};

const LOCK_WAIT_MS = 5_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATION = /^g[0-9a-f]{16}$/;

/** The receiver's queue folder for a seat's drop folder `<root>/.agents/send-drops/<session>/<seat>`,
 *  or null when the folder is not one (a client inbox, a mailbox, a test's own folder). */
export function queueBaseOf(dropDir: string): string | null {
  const seat = basename(dropDir);
  const sessionDir = dirname(dropDir);
  const session = basename(sessionDir);
  const drops = dirname(sessionDir);
  if (basename(drops) !== 'send-drops' || !NAME.test(seat) || !NAME.test(session)) return null;
  return join(dirname(drops), 'queues', session, seat);
}

function seqName(seq: number): string {
  return String(seq).padStart(12, '0');
}

/** Writes `text` whole: a private temp file in the same folder, fsynced, renamed, folder fsynced. */
function writeDurable(path: string, text: string): void {
  const folder = dirname(path);
  const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncFolder(folder);
}

function fsyncFolder(folder: string): void {
  const fd = openSync(folder, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendLine(path: string, line: JournalLine): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function plainFolder(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureFolder(path: string): void {
  if (plainFolder(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!plainFolder(path)) throw new Error(`${path} is not a folder of its own`);
}

type Journal = { lines: JournalLine[]; tornAt: number | null; corrupt: boolean };

function isLine(value: unknown): value is JournalLine {
  if (value === null || typeof value !== 'object') return false;
  const line = value as Partial<JournalLine>;
  return line.v === 1 && Number.isSafeInteger(line.seq) && (line.seq as number) > 0
    && typeof line.msg_id === 'string' && NAME.test(line.msg_id)
    && typeof line.op_key === 'string'
    && (line.state === 'reserved' || line.state === 'committed' || line.state === 'void');
}

/** The journal's whole lines. A last line with no newline, or one that does not parse, is a torn
 *  tail (`tornAt` is the byte where it starts); a bad line before the tail is corruption. */
function readJournal(path: string): Journal {
  const text = readNoFollow(path);
  if (text === null) return { lines: [], tornAt: null, corrupt: false };
  const lines: JournalLine[] = [];
  let offset = 0;
  const parts = text.split('\n');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const last = index === parts.length - 1;
    if (last) {
      // Text after the last newline was never finished.
      return { lines, tornAt: part === '' ? null : offset, corrupt: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(part);
    } catch {
      parsed = null;
    }
    if (!isLine(parsed)) {
      // A bad line that is the last whole line is a tail torn mid-write; anything before is not.
      const rest = parts.slice(index + 1).join('');
      if (rest === '') return { lines, tornAt: offset, corrupt: false };
      return { lines, tornAt: null, corrupt: true };
    }
    lines.push(parsed);
    offset += Buffer.byteLength(part) + 1;
  }
  return { lines, tornAt: null, corrupt: false };
}

type Folded = { head: number; last: Map<number, JournalLine>; committedIds: Map<string, number> };

function fold(lines: readonly JournalLine[]): Folded {
  const last = new Map<number, JournalLine>();
  let head = 0;
  for (const line of lines) {
    last.set(line.seq, line);
    if (line.seq > head) head = line.seq;
  }
  const committedIds = new Map<string, number>();
  for (const [seq, line] of last) if (line.state === 'committed') committedIds.set(line.msg_id, seq);
  return { head, last, committedIds };
}

type Generation = { name: string; folder: string };

/** The current generation, created on first use. A `current` that does not name a generation
 *  this build reads starts a new one: state bound to the old one never applies to it. */
function currentGeneration(base: string, log: (line: string) => void): Generation {
  ensureFolder(base);
  const pointer = join(base, 'current');
  const named = readNoFollow(pointer)?.trim() ?? null;
  if (named !== null && GENERATION.test(named) && plainFolder(join(base, named))) {
    return { name: named, folder: join(base, named) };
  }
  const name = `g${randomBytes(8).toString('hex')}`;
  const folder = join(base, name);
  ensureFolder(join(folder, 'entries'));
  ensureFolder(join(folder, 'ids'));
  writeDurable(pointer, `${name}\n`);
  if (named !== null) log(`queue ${base}: generation ${named} unreadable; started ${name}`);
  return { name, folder };
}

function replaceGeneration(base: string, old: Generation, log: (line: string) => void): Generation {
  const name = `g${randomBytes(8).toString('hex')}`;
  const folder = join(base, name);
  ensureFolder(join(folder, 'entries'));
  ensureFolder(join(folder, 'ids'));
  writeDurable(join(base, 'current'), `${name}\n`);
  log(`queue ${base}: generation ${old.name} has a corrupt journal; started ${name}`);
  return { name, folder };
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type Target = { dropDir: string; root: string; session: string; seat: string };

/** The record at the id's name, read without following a link, and whether it verifies for this
 *  receiver: this checkout's key signed it, and it names this seat, session and checkout. */
function recordOnDisk(target: Target, msgId: string, home: string): { state: 'absent' } | { state: 'bad' } | { state: 'ok'; digest: string } {
  const path = recordFile(target.dropDir, msgId);
  const text = readNoFollow(path);
  if (text === null) {
    try {
      lstatSync(path);
      return { state: 'bad' };
    } catch {
      return { state: 'absent' };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'bad' };
  }
  const record = signedRecordOf(parsed);
  const key = messageKeyState(home);
  if (record === null || key.kind !== 'key' || !verifyRecord(record, key.key)) return { state: 'bad' };
  const payload = record.payload;
  if (payload.id !== msgId || payload.to !== target.seat || payload.session !== target.session || !sameFolder(payload.root, target.root)) {
    return { state: 'bad' };
  }
  return { state: 'ok', digest: digestOf(text) };
}

function signEntry(payload: QueueEntryPayload, home: string): QueueEntry {
  return { payload, signature: signDomain(QUEUE_DOMAIN, payload as unknown as Json, messageKeyOf(home)) };
}

/** A committed entry as stored, verified with this checkout's key and bound to its place. */
export function readEntry(folder: string, seq: number, expected: Omit<QueueEntryPayload, 'v' | 'kind' | 'seq' | 'msg_id' | 'record_digest' | 'recovered'>, home: string): QueueEntry | null {
  const text = readNoFollow(join(folder, 'entries', seqName(seq)));
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = parsed as QueueEntry;
  const key = messageKeyState(home);
  if (key.kind !== 'key' || entry === null || typeof entry !== 'object' || typeof entry.signature !== 'string') return null;
  const payload = entry.payload;
  if (payload?.v !== 1 || payload.kind !== 'queue-entry' || payload.seq !== seq) return null;
  if (payload.session !== expected.session || payload.seat !== expected.seat || payload.generation !== expected.generation
    || !sameFolder(payload.root, expected.root)) return null;
  if (!verifyDomain(QUEUE_DOMAIN, payload as unknown as Json, entry.signature, key.key)) return null;
  return entry;
}

type Locked = {
  base: string;
  target: Target;
  generation: Generation;
  journalPath: string;
  folded: Folded;
  options: QueueOptions;
  log: (line: string) => void;
  now: () => Date;
};

function line(locked: Locked, seq: number, msgId: string, opKey: string, state: JournalState, extra: Partial<JournalLine> = {}): JournalLine {
  return { v: 1, seq, msg_id: msgId, op_key: opKey, state, at: locked.now().toISOString(), ...extra };
}

function writeJournal(locked: Locked, next: JournalLine): void {
  appendLine(locked.journalPath, next);
  locked.folded.last.set(next.seq, next);
  if (next.seq > locked.folded.head) locked.folded.head = next.seq;
  if (next.state === 'committed') locked.folded.committedIds.set(next.msg_id, next.seq);
}

/** Steps 3: the signed entry, the id file, the committed line. */
function commit(locked: Locked, seq: number, msgId: string, opKey: string, digest: string, recovered: boolean): void {
  const { target, generation } = locked;
  const payload: QueueEntryPayload = {
    v: 1, kind: 'queue-entry', root: target.root, session: target.session, seat: target.seat,
    generation: generation.name, seq, msg_id: msgId, record_digest: digest,
    ...(recovered ? { recovered: true as const } : {}),
  };
  writeDurable(join(generation.folder, 'entries', seqName(seq)), `${JSON.stringify(signEntry(payload, locked.options.home))}\n`);
  locked.options.after?.('entry');
  writeDurable(join(generation.folder, 'ids', msgId), `${String(seq)}\n`);
  writeJournal(locked, line(locked, seq, msgId, opKey, 'committed', recovered ? { recovered: true } : {}));
  locked.options.after?.('mark');
}

/** Recovery under the lock: cut a torn tail, settle every reserved intent, rebuild missing id files. */
function recover(locked: Locked): void {
  const { generation, target, options } = locked;
  const expected = { root: target.root, session: target.session, seat: target.seat, generation: generation.name };
  for (const [seq, last] of [...locked.folded.last].sort((a, b) => a[0] - b[0])) {
    if (last.state === 'reserved') {
      const entry = readEntry(generation.folder, seq, expected, options.home);
      if (entry !== null && entry.payload.msg_id === last.msg_id) {
        writeDurable(join(generation.folder, 'ids', last.msg_id), `${String(seq)}\n`);
        writeJournal(locked, line(locked, seq, last.msg_id, last.op_key, 'committed', last.recovered ? { recovered: true } : {}));
        locked.log(`queue ${target.session}/${target.seat}: recovered seq ${String(seq)} (entry written, not marked)`);
        continue;
      }
      const onDisk = recordOnDisk(target, last.msg_id, options.home);
      if (onDisk.state === 'ok' && !locked.folded.committedIds.has(last.msg_id)) {
        commit(locked, seq, last.msg_id, last.op_key, onDisk.digest, last.recovered === true);
        locked.log(`queue ${target.session}/${target.seat}: recovered seq ${String(seq)} (record written, not indexed)`);
      } else {
        const reason = onDisk.state === 'absent' ? 'the record was never written'
          : onDisk.state === 'bad' ? 'the record at its name does not verify for this seat'
            : 'the id is already committed at another seq';
        writeJournal(locked, line(locked, seq, last.msg_id, last.op_key, 'void', { reason }));
        locked.log(`queue ${target.session}/${target.seat}: seq ${String(seq)} void: ${reason}`);
      }
    } else if (last.state === 'committed' && readNoFollow(join(generation.folder, 'ids', last.msg_id)) === null) {
      writeDurable(join(generation.folder, 'ids', last.msg_id), `${String(seq)}\n`);
    }
  }
}

/** The receiver's queue lock, waited for. The seat lock's taker answers at once when another
 *  taker wins the takeover of a dead holder's lock; the queue tries again until its budget ends,
 *  so two writers that both find a dead holder both append. */
function takeQueueLock(base: string, options: QueueOptions): ReturnType<typeof acquireLockAt> {
  const waitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const lock = acquireLockAt(join(base, 'lock'), base, options.lock, { waitMs: remaining, pollMs: 10 });
    if ('release' in lock || Date.now() >= deadline) return lock;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

/** Takes the receiver's lock and opens its current generation, recovered. Null when the queue
 *  cannot be used: the reason is logged, and the caller writes as before. */
function open(dropDir: string, target: Omit<Target, 'dropDir'>, options: QueueOptions): { locked: Locked; release: () => void } | { skipped: string } {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const base = queueBaseOf(dropDir);
  if (base === null) return { skipped: 'the folder is not a seat drop folder' };
  if (!NAME.test(target.seat) || !NAME.test(target.session)) return { skipped: 'the seat or session cannot name a queue' };
  ensureFolder(base);
  const lock = takeQueueLock(base, options);
  if (!('release' in lock)) return { skipped: `the queue lock is held (pid ${String(lock.held)})` };
  try {
    let generation = currentGeneration(base, log);
    let journalPath = join(generation.folder, 'journal.jsonl');
    let journal = readJournal(journalPath);
    if (journal.corrupt) {
      generation = replaceGeneration(base, generation, log);
      journalPath = join(generation.folder, 'journal.jsonl');
      journal = { lines: [], tornAt: null, corrupt: false };
    }
    if (journal.tornAt !== null) {
      const fd = openSync(journalPath, 'r+');
      try {
        ftruncateSync(fd, journal.tornAt);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      log(`queue ${target.session}/${target.seat}: cut a torn journal tail at byte ${String(journal.tornAt)}`);
    }
    const locked: Locked = {
      base, target: { dropDir, ...target }, generation, journalPath, folded: fold(journal.lines), options, log, now,
    };
    recover(locked);
    return { locked, release: () => lock.release() };
  } catch (error) {
    lock.release();
    throw error;
  }
}

export type AppendInput = {
  dropDir: string;
  /** The record the write puts at its id's name. */
  record: SignedRecord;
  /** The operation's stable key; a plain delivery's is its message id. */
  opKey?: string;
};

type WriteOutcome<T> = { ok: boolean; value: T };

function targetOf(record: SignedRecord): Omit<Target, 'dropDir'> {
  return { root: record.payload.root, session: record.payload.session, seat: record.payload.to };
}

/** Reserves the next seq, or answers that the id is committed already. */
function reserve(locked: Locked, msgId: string, opKey: string): { seq: number } | { existing: number } {
  const existing = locked.folded.committedIds.get(msgId);
  if (existing !== undefined) return { existing };
  const seq = locked.folded.head + 1;
  writeJournal(locked, line(locked, seq, msgId, opKey, 'reserved'));
  locked.options.after?.('reserve');
  return { seq };
}

function afterWrite(locked: Locked, seq: number, msgId: string, opKey: string, ok: boolean): QueueOutcome {
  if (!ok) {
    writeJournal(locked, line(locked, seq, msgId, opKey, 'void', { reason: 'the write did not complete' }));
    return { kind: 'void', generation: locked.generation.name, seq, reason: 'the write did not complete' };
  }
  const onDisk = recordOnDisk(locked.target, msgId, locked.options.home);
  if (onDisk.state !== 'ok') {
    const reason = onDisk.state === 'absent' ? 'the record is not at its name' : 'the record at its name does not verify for this seat';
    writeJournal(locked, line(locked, seq, msgId, opKey, 'void', { reason }));
    return { kind: 'void', generation: locked.generation.name, seq, reason };
  }
  commit(locked, seq, msgId, opKey, onDisk.digest, false);
  return { kind: 'committed', generation: locked.generation.name, seq };
}

/**
 * The one append every ingress uses (§1): the send host and its in-process fallback (the staged
 * record), `team reply`, launch briefs, runtime notices and the native and client writers. `write`
 * is the caller's record write, unchanged; it runs inside the receiver's queue lock, between the
 * reserve and the commit. Its outcome is returned exactly as it was.
 */
export async function appendDelivery<T>(input: AppendInput, write: () => Promise<WriteOutcome<T>>, options: QueueOptions): Promise<{ value: T; queue: QueueOutcome }> {
  const log = options.log ?? (() => {});
  let opened: ReturnType<typeof open>;
  try {
    opened = open(input.dropDir, targetOf(input.record), options);
  } catch (error) {
    opened = { skipped: `the queue could not be opened (${(error as Error).message})` };
  }
  if ('skipped' in opened) {
    log(`queue skipped for ${input.record.payload.id}: ${opened.skipped}`);
    const written = await write();
    return { value: written.value, queue: { kind: 'skipped', reason: opened.skipped } };
  }
  const { locked, release } = opened;
  const msgId = input.record.payload.id;
  const opKey = input.opKey ?? msgId;
  try {
    let reserved: ReturnType<typeof reserve>;
    try {
      reserved = reserve(locked, msgId, opKey);
    } catch (error) {
      const reason = `the reserve could not be written (${(error as Error).message})`;
      log(`queue skipped for ${msgId}: ${reason}`);
      const written = await write();
      return { value: written.value, queue: { kind: 'skipped', reason } };
    }
    const written = await write();
    options.after?.('record');
    if ('existing' in reserved) return { value: written.value, queue: { kind: 'existing', generation: locked.generation.name, seq: reserved.existing } };
    try {
      return { value: written.value, queue: afterWrite(locked, reserved.seq, msgId, opKey, written.ok) };
    } catch (error) {
      // The intent stays reserved: the next holder of the lock settles it from the record.
      const reason = `the commit could not be written (${(error as Error).message})`;
      log(`queue ${msgId}: ${reason}`);
      return { value: written.value, queue: { kind: 'skipped', reason } };
    }
  } finally {
    release();
  }
}

/** `appendDelivery` for a write that does not wait. */
export function appendDeliverySync<T>(input: AppendInput, write: () => WriteOutcome<T>, options: QueueOptions): { value: T; queue: QueueOutcome } {
  const log = options.log ?? (() => {});
  let opened: ReturnType<typeof open>;
  try {
    opened = open(input.dropDir, targetOf(input.record), options);
  } catch (error) {
    opened = { skipped: `the queue could not be opened (${(error as Error).message})` };
  }
  if ('skipped' in opened) {
    log(`queue skipped for ${input.record.payload.id}: ${opened.skipped}`);
    return { value: write().value, queue: { kind: 'skipped', reason: opened.skipped } };
  }
  const { locked, release } = opened;
  const msgId = input.record.payload.id;
  const opKey = input.opKey ?? msgId;
  try {
    let reserved: ReturnType<typeof reserve>;
    try {
      reserved = reserve(locked, msgId, opKey);
    } catch (error) {
      const reason = `the reserve could not be written (${(error as Error).message})`;
      log(`queue skipped for ${msgId}: ${reason}`);
      return { value: write().value, queue: { kind: 'skipped', reason } };
    }
    const written = write();
    options.after?.('record');
    if ('existing' in reserved) return { value: written.value, queue: { kind: 'existing', generation: locked.generation.name, seq: reserved.existing } };
    try {
      return { value: written.value, queue: afterWrite(locked, reserved.seq, msgId, opKey, written.ok) };
    } catch (error) {
      const reason = `the commit could not be written (${(error as Error).message})`;
      log(`queue ${msgId}: ${reason}`);
      return { value: written.value, queue: { kind: 'skipped', reason } };
    }
  } finally {
    release();
  }
}

/**
 * The orphan source (§1 recovery): a verified record in a seat's drop folder with no committed
 * entry — a writer that ran before E4, one whose queue was busy or unwritable, or a raw writer —
 * appended at the next seq, flagged `recovered`. Its order is recovery order.
 */
export function appendRecovered(dropDir: string, target: Omit<Target, 'dropDir'>, msgId: string, options: QueueOptions): QueueOutcome {
  if (!NAME.test(msgId)) return { kind: 'skipped', reason: 'the id cannot name a queue entry' };
  let opened: ReturnType<typeof open>;
  try {
    opened = open(dropDir, target, options);
  } catch (error) {
    return { kind: 'skipped', reason: `the queue could not be opened (${(error as Error).message})` };
  }
  if ('skipped' in opened) return { kind: 'skipped', reason: opened.skipped };
  const { locked, release } = opened;
  try {
    const existing = locked.folded.committedIds.get(msgId);
    if (existing !== undefined) return { kind: 'existing', generation: locked.generation.name, seq: existing };
    const onDisk = recordOnDisk(locked.target, msgId, options.home);
    if (onDisk.state !== 'ok') return { kind: 'skipped', reason: 'the record does not verify for this seat' };
    const seq = locked.folded.head + 1;
    writeJournal(locked, line(locked, seq, msgId, msgId, 'reserved', { recovered: true }));
    options.after?.('reserve');
    commit(locked, seq, msgId, msgId, onDisk.digest, true);
    return { kind: 'committed', generation: locked.generation.name, seq, recovered: true };
  } finally {
    release();
  }
}

/**
 * Recovery on daemon start (§1): every seat queue of a session is opened once under its lock, which
 * cuts a torn tail and settles every reserved intent a dead writer left. The bus runs it on its
 * first reconcile pass. Returns the seats it could not open, with why.
 */
export function recoverSessionQueues(root: string, session: string, options: QueueOptions): { seat: string; reason: string }[] {
  const folder = join(root, '.agents', 'queues', session);
  let seats: string[];
  try {
    seats = readdirSync(folder).filter((name) => NAME.test(name) && plainFolder(join(folder, name)));
  } catch {
    return [];
  }
  const failed: { seat: string; reason: string }[] = [];
  for (const seat of seats) {
    const dropDir = join(root, '.agents', 'send-drops', session, seat);
    try {
      const opened = open(dropDir, { root, session, seat }, options);
      if ('skipped' in opened) failed.push({ seat, reason: opened.skipped });
      else opened.release();
    } catch (error) {
      failed.push({ seat, reason: (error as Error).message });
    }
  }
  return failed;
}

/** Whether `msgId` holds a committed seq in the seat's current generation: one read, no lock. A
 *  reader's hint only; the journal under the lock is the authority. */
export function queuedHint(dropDir: string, msgId: string): boolean {
  const base = queueBaseOf(dropDir);
  if (base === null || !NAME.test(msgId)) return false;
  const named = readNoFollow(join(base, 'current'))?.trim();
  if (named === undefined || !GENERATION.test(named)) return false;
  return readNoFollow(join(base, named, 'ids', msgId)) !== null;
}

/** The journal's lines, for tests and `team status` (not authority). */
export function journalOf(dropDir: string): { generation: string | null; lines: JournalLine[] } {
  const base = queueBaseOf(dropDir);
  if (base === null) return { generation: null, lines: [] };
  const named = readNoFollow(join(base, 'current'))?.trim() ?? null;
  if (named === null || !GENERATION.test(named)) return { generation: null, lines: [] };
  return { generation: named, lines: readJournal(join(base, named, 'journal.jsonl')).lines };
}

/** The committed entries of the current generation, by seq (tests and diagnostics). */
export function entriesOf(dropDir: string): number[] {
  const base = queueBaseOf(dropDir);
  if (base === null) return [];
  const named = readNoFollow(join(base, 'current'))?.trim() ?? null;
  if (named === null || !GENERATION.test(named)) return [];
  try {
    return readdirSync(join(base, named, 'entries')).filter((name) => /^\d{12}$/.test(name)).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

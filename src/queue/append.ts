// The receiving seat's delivery queue: a sequence index over the signed message records
// (rfc-event-comms §1, step E4). The record stays the one immutable copy of every message; the
// queue only numbers records per receiving seat, and the number lives in a file NAME.
//
// Layout, one folder per receiving seat beside the drop folders:
//   .agents/queues/<session>/<seat>/current                         the current generation's name
//   .agents/queues/<session>/<seat>/lock                            the receiver's queue lock
//   .agents/queues/<session>/<seat>/<gen>/entries/<seq>.<msg_id>    one empty file per committed seq
//
// The commit (§1), under the receiver's queue lock:
//   1. record: the caller's own record write, then the record and its folder flushed;
//   2. entry: `<seq>.<msg_id>` created exclusively at the next seq, its folder flushed;
//   3. release.
// An entry stands only for a record already durable, so the entry's name is the whole index: the
// seq, the id, and (by the record it names, which is signed and verified at every proof) the body.
// A writer that dies before its entry leaves a record with none: the bus's reconcile pass appends
// it as `recovered` at the next seq (`appendRecovered`). No seq is ever reserved, so none is void.
//
// Read old, write new: a generation an earlier build wrote (`journal.jsonl`, `entries/<seq>`,
// `ids/<msg_id>`) is folded into entry names by the first holder of its lock (`foldLegacy`): every
// committed line whose seq and id are free gets its entry name, and the journal is removed. A
// reserved line is left to its record (the orphan source), so nothing is lost or numbered twice.
//
// Shadow rule (E4): the queue never changes what the caller's write does. A queue that cannot be
// locked, read or written is logged and the record is written exactly as before.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { mkdirSync, openSync, renameSync, writeSync } from '../host/guarded-fs.ts';
import { basename, dirname, join } from 'node:path';
import { acquireLockAt, type LockSteps } from '../launch/seat-lock.ts';
import { messageKeyState } from '../store/keys.ts';
import { readNoFollow } from '../send/history.ts';
import { fsyncFolder, removeDurable } from './durable.ts';
import { drainPendingReceipts } from './receipt-store.ts';
import { recordFile, sameFolder, signedRecordOf, verifyRecord, type SignedRecord } from '../send/record.ts';
import { mailDirOf, seatDropDir } from './mail-tree.ts';

/** The steps a crash can stop between (the fault gates name them). */
export type AppendStep = 'record' | 'entry';

/** What the queue did for one append. Never a reason to change the write's own outcome. */
export type QueueOutcome =
  | { kind: 'committed'; generation: string; seq: number; recovered?: true }
  | { kind: 'existing'; generation: string; seq: number }
  | { kind: 'void'; reason: string }
  | { kind: 'skipped'; reason: string };

export type QueueOptions = {
  home: string;
  /** Test seam: called after each step; a crash test exits the process here. */
  after?: (step: AppendStep) => void;
  /** Test seam: each durability point, in the order it happens. */
  trace?: (point: 'record-fsync' | 'record-folder-fsync' | 'entry') => void;
  /** Test seam: a failing record flush. */
  syncRecord?: (path: string) => void;
  /** Test seam: the metadata read of the generation pointer. */
  stat?: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  lock?: Partial<LockSteps>;
  /** How long an append waits for the receiver's lock. */
  lockWaitMs?: number;
  log?: (line: string) => void;
};

const LOCK_WAIT_MS = 5_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GENERATION = /^g[0-9a-f]{16}$/;
const ENTRY = /^(\d{12})\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
type Binding = { root: string; session: string; seat: string };

/** The receiver's queue folder for a seat's drop folder `<root>/.agents/send-drops/<session>/<seat>`,
 *  or null when the folder is not one (a client inbox, a mailbox, a test's own folder). */
export function queueBaseOf(dropDir: string): string | null {
  // Either of the seat's two folders (src/queue/mail-tree.ts) names the seat's one queue.
  const at = mailDirOf(dropDir);
  if (at === null || !NAME.test(at.seat) || !NAME.test(at.session)) return null;
  return join(at.agents, 'queues', at.session, at.seat);
}

function seqName(seq: number): string {
  return String(seq).padStart(12, '0');
}
/** Reads a file of its own: '' only when lstat proves it absent (ENOENT); null for any other
 *  metadata or read fault, a link or a non-file. Unknown is never read as missing. */
export function readOwn(path: string, stat: (path: string) => { isFile(): boolean; isSymbolicLink(): boolean } = lstatSync): string | null {
  try {
    const held = stat(path);
    if (held.isSymbolicLink() || !held.isFile()) return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
  }
  // The file itself, opened without following a link: any fault from here on is unknown, never ''.
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(8192);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Writes every byte: a short write is continued, never taken for the whole text. */
export function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/** Writes `text` whole: a private temp file in the same folder, fsynced, renamed, folder fsynced. */
function writeDurable(path: string, text: string): void {
  const folder = dirname(path);
  const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeAll(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncFolder(folder);
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

/** A generation's entries, from their names alone. `seqs` holds null for a seq two names claim,
 *  `ids` holds -1 for an id at two seqs: neither proves a placement (fail closed). */
type Index = { head: number; ids: Map<string, number>; seqs: Map<number, string | null> };

/** The generation's index; null when its entries cannot be listed (unknown, never empty). */
function readIndex(folder: string): Index | null {
  const entries = join(folder, 'entries');
  let names: string[] = [];
  try {
    const held = lstatSync(entries);
    // A link at the name lends another folder's listing: never read through it.
    if (held.isSymbolicLink() || !held.isDirectory()) return null;
    names = readdirSync(entries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  const index: Index = { head: 0, ids: new Map(), seqs: new Map() };
  for (const name of names) {
    const match = ENTRY.exec(name);
    if (match !== null) note(index, Number(match[1]), match[2]!);
  }
  return index;
}

function note(index: Index, seq: number, id: string): void {
  if (seq < 1) return;
  if (seq > index.head) index.head = seq;
  index.seqs.set(seq, index.seqs.has(seq) ? null : id);
  index.ids.set(id, index.ids.has(id) ? -1 : seq);
}

function placed(index: Index, id: string): number | null {
  const seq = index.ids.get(id);
  return seq !== undefined && seq > 0 && index.seqs.get(seq) === id ? seq : null;
}

function createEntry(folder: string, seq: number, id: string): void {
  closeSync(openSync(join(folder, 'entries', `${seqName(seq)}.${id}`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600));
}

/** Read old, write new: an earlier build's journal folded into entry names, under the lock. A
 *  committed line whose seq and id are both free gets its name; everything else is left to its
 *  record (the orphan source). False when the journal cannot be read (the queue is not used). */
function foldLegacy(folder: string, index: Index, log: (line: string) => void): boolean {
  const journal = join(folder, 'journal.jsonl');
  const text = readOwn(journal);
  if (text === '') return true;
  if (text === null) return false;
  const last = new Map<number, string | null>();
  for (const part of text.split('\n')) {
    let line: { seq?: unknown; msg_id?: unknown; state?: unknown } | null;
    try {
      line = JSON.parse(part) as typeof line;
    } catch {
      continue;
    }
    if (line === null || typeof line !== 'object' || !Number.isSafeInteger(line.seq) || (line.seq as number) < 1) continue;
    const id = typeof line.msg_id === 'string' && NAME.test(line.msg_id) ? line.msg_id : null;
    last.set(line.seq as number, line.state === 'committed' ? id : null);
  }
  let folded = 0;
  for (const [seq, id] of [...last].sort((a, b) => a[0] - b[0])) {
    if (id === null || index.seqs.has(seq) || index.ids.has(id)) continue;
    createEntry(folder, seq, id);
    note(index, seq, id);
    folded += 1;
  }
  fsyncFolder(join(folder, 'entries'));
  if (removeDurable(journal) !== 'removed') log(`queue ${folder}: the legacy journal could not be removed; the next holder folds it again`);
  log(`queue ${folder}: folded ${String(folded)} committed seq(s) of the legacy journal into entry names`);
  return true;
}

/** The current generation, created on first use. A `current` that does not name a generation
 *  this build reads starts a new one: state bound to the old one never applies to it. */
function currentGeneration(base: string, log: (line: string) => void, stat?: QueueOptions['stat']): string {
  ensureFolder(base);
  const pointer = join(base, 'current');
  const text = readOwn(pointer, stat);
  // A pointer that cannot be read is not a missing one: the queue is not used this time.
  if (text === null) throw new Error('the generation pointer cannot be read');
  const named = text.trim();
  if (GENERATION.test(named) && plainFolder(join(base, named))) {
    // A generation made without its entries folder gets one; whatever already holds the name is
    // judged by the listing (`readIndex`), never replaced.
    try {
      mkdirSync(join(base, named, 'entries'), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return join(base, named);
  }
  const name = `g${randomBytes(8).toString('hex')}`;
  ensureFolder(join(base, name, 'entries'));
  writeDurable(pointer, `${name}\n`);
  if (named !== '') log(`queue ${base}: generation pointer names no generation; started ${name}`);
  return join(base, name);
}

type Target = Binding & { dropDir: string };

/** The record at the id's name, read without following a link, and whether it verifies for this
 *  receiver: this checkout's key signed it, and it names this seat, session and checkout. */
type OnDisk = { state: 'absent' } | { state: 'bad' } | { state: 'unreadable' } | { state: 'ok'; path: string };

function recordOnDisk(target: Target, msgId: string, home: string): OnDisk {
  const path = recordFile(target.dropDir, msgId);
  // Only ENOENT proves absence: any other stat failure is uncertainty, settled later.
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable' };
  }
  // A link, a folder or a FIFO at the name is not a record.
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'bad' };
  // No key to verify with is not a failed verification: it is never created here to settle it.
  const key = messageKeyState(home);
  if (key.kind !== 'key') return { state: 'unreadable' };
  const text = readNoFollow(path);
  if (text === null) return { state: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'bad' };
  }
  const record = signedRecordOf(parsed);
  if (record === null || !verifyRecord(record, key.key)) return { state: 'bad' };
  const payload = record.payload;
  if (payload.id !== msgId || payload.to !== target.seat || payload.session !== target.session || !sameFolder(payload.root, target.root)) {
    return { state: 'bad' };
  }
  return { state: 'ok', path };
}

/** The canonical record and its folder entry made durable before any entry names it (§1 order). */
function flushRecord(path: string, options: QueueOptions): void {
  if (options.syncRecord !== undefined) options.syncRecord(path);
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  options.trace?.('record-fsync');
  fsyncFolder(dirname(path));
  options.trace?.('record-folder-fsync');
}

type Locked = { target: Target; generation: string; index: Index; options: QueueOptions };

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

/** Takes the receiver's lock and opens its current generation (an earlier build's journal folded
 *  in). `skipped` when the queue cannot be used: the caller writes as before. */
function open(dropDir: string, target: Binding, options: QueueOptions): { locked: Locked; release: () => void } | { skipped: string } {
  const log = options.log ?? (() => {});
  const base = queueBaseOf(dropDir);
  if (base === null) return { skipped: 'the folder is not a seat drop folder' };
  if (!NAME.test(target.seat) || !NAME.test(target.session)) return { skipped: 'the seat or session cannot name a queue' };
  ensureFolder(base);
  // The queue folder is its own, under this checkout's real `.agents`: no link above it lends
  // another place.
  const agents = dirname(dirname(dirname(base)));
  try {
    if (realpathSync(base) !== join(realpathSync(agents), 'queues', target.session, target.seat)) return { skipped: 'the queue folder is not this checkout\'s' };
  } catch {
    return { skipped: 'the queue folder cannot be resolved' };
  }
  const lock = takeQueueLock(base, options);
  if (!('release' in lock)) return { skipped: `the queue lock is held (pid ${String(lock.held)})` };
  try {
    const generation = currentGeneration(base, log, options.stat);
    const index = readIndex(generation);
    const why = index === null ? 'the queue entries cannot be listed' : foldLegacy(generation, index, log) ? null : 'the legacy journal cannot be read';
    if (why !== null) {
      lock.release();
      return { skipped: why };
    }
    // The next holder of the lock drains the seat's pending dual writes once it lets the lock go
    // (a drain proves each placement under the lock again, so it never runs while this one holds).
    return { locked: { target: { dropDir, ...target }, generation, index: index!, options }, release: () => { lock.release(); drainAfterRelease(dropDir, options); } };
  } catch (error) {
    lock.release();
    throw error;
  }
}

function safeOpen(dropDir: string, target: Binding, options: QueueOptions): ReturnType<typeof open> {
  try {
    return open(dropDir, target, options);
  } catch (error) {
    return { skipped: `the queue could not be opened (${(error as Error).message})` };
  }
}

/** The commit's steps 1–2 for a record already written: the record proved and flushed, then the
 *  next seq's entry name created and its folder flushed. */
function place(locked: Locked, msgId: string, recovered: boolean): QueueOutcome {
  const { options, index } = locked;
  const onDisk = recordOnDisk(locked.target, msgId, options.home);
  // Not proven either way: the record stays for the reconcile pass's orphan source.
  if (onDisk.state === 'unreadable') return { kind: 'skipped', reason: 'the record cannot be read now' };
  if (onDisk.state !== 'ok') return { kind: 'void', reason: onDisk.state === 'absent' ? 'the record is not at its name' : 'the record at its name does not verify for this seat' };
  flushRecord(onDisk.path, options);
  const seq = index.head + 1;
  createEntry(locked.generation, seq, msgId);
  fsyncFolder(join(locked.generation, 'entries'));
  note(index, seq, msgId);
  options.trace?.('entry');
  options.after?.('entry');
  return { kind: 'committed', generation: basename(locked.generation), seq, ...(recovered ? { recovered: true as const } : {}) };
}

function settle(locked: Locked, msgId: string, ok: boolean): QueueOutcome {
  locked.options.after?.('record');
  const existing = placed(locked.index, msgId);
  if (existing !== null) return { kind: 'existing', generation: basename(locked.generation), seq: existing };
  if (!ok) return { kind: 'void', reason: 'the write did not complete' };
  try {
    return place(locked, msgId, false);
  } catch (error) {
    // No entry: the reconcile pass appends the record later.
    const reason = `the commit could not be written (${(error as Error).message})`;
    locked.options.log?.(`queue ${msgId}: ${reason}`);
    return { kind: 'skipped', reason };
  }
}

export type AppendInput = {
  dropDir: string;
  /** The record the write puts at its id's name. */
  record: SignedRecord;
};

type WriteOutcome<T> = { ok: boolean; value: T };

function targetOf(record: SignedRecord): Binding {
  return { root: record.payload.root, session: record.payload.session, seat: record.payload.to };
}

function skippedFor(input: AppendInput, opened: { skipped: string }, options: QueueOptions): QueueOutcome {
  options.log?.(`queue skipped for ${input.record.payload.id}: ${opened.skipped}`);
  return { kind: 'skipped', reason: opened.skipped };
}

/**
 * The one append every ingress uses (§1): the send host and its in-process fallback (the staged
 * record), `team reply`, launch briefs, runtime notices and the native and client writers. `write`
 * is the caller's record write, unchanged; it runs inside the receiver's queue lock, before the
 * entry. Its outcome is returned exactly as it was.
 */
export async function appendDelivery<T>(input: AppendInput, write: () => Promise<WriteOutcome<T>>, options: QueueOptions): Promise<{ value: T; queue: QueueOutcome }> {
  const opened = safeOpen(input.dropDir, targetOf(input.record), options);
  if ('skipped' in opened) return { queue: skippedFor(input, opened, options), value: (await write()).value };
  try {
    const written = await write();
    return { value: written.value, queue: settle(opened.locked, input.record.payload.id, written.ok) };
  } finally {
    opened.release();
  }
}

/** `appendDelivery` for a write that does not wait. */
export function appendDeliverySync<T>(input: AppendInput, write: () => WriteOutcome<T>, options: QueueOptions): { value: T; queue: QueueOutcome } {
  const opened = safeOpen(input.dropDir, targetOf(input.record), options);
  if ('skipped' in opened) return { queue: skippedFor(input, opened, options), value: write().value };
  try {
    const written = write();
    return { value: written.value, queue: settle(opened.locked, input.record.payload.id, written.ok) };
  } finally {
    opened.release();
  }
}

function drainAfterRelease(dropDir: string, options: QueueOptions): void {
  try {
    drainPendingReceipts(dropDir, options.home, options.log);
  } catch (error) {
    options.log?.(`queue: the pending receipts could not be drained (${(error as Error).message})`);
  }
}

/**
 * The orphan source (§1 recovery): a verified record in a seat's drop folder with no entry — a
 * writer that died before its entry, one whose queue was busy or unwritable, or a raw writer —
 * appended at the next seq, flagged `recovered`. Its order is recovery order.
 */
export function appendRecovered(dropDir: string, target: Binding, msgId: string, options: QueueOptions): QueueOutcome {
  if (!NAME.test(msgId)) return { kind: 'skipped', reason: 'the id cannot name a queue entry' };
  const opened = safeOpen(dropDir, target, options);
  if ('skipped' in opened) return { kind: 'skipped', reason: opened.skipped };
  try {
    const existing = placed(opened.locked.index, msgId);
    if (existing !== null) return { kind: 'existing', generation: basename(opened.locked.generation), seq: existing };
    const out = place(opened.locked, msgId, true);
    return out.kind === 'void' ? { kind: 'skipped', reason: 'the record does not verify for this seat' } : out;
  } catch (error) {
    // A queue write that fails here never escapes into the caller's pass: a retryable skip.
    return { kind: 'skipped', reason: `the orphan append could not be written (${(error as Error).message})` };
  } finally {
    opened.release();
  }
}

/**
 * The queues' open on daemon start (§1): every seat queue of a session is opened once under its
 * lock, which folds an earlier build's journal into entry names. The bus runs it on its first
 * reconcile pass. Returns the seats it could not open, with why.
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
    const dropDir = seatDropDir(root, session, seat);
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

/** The seat's current generation's name, read without the lock; null when there is none. A
 *  reader's cache key: an answer bound to one generation is asked again when it changes. */
export function currentGenerationName(dropDir: string): string | null {
  const base = queueBaseOf(dropDir);
  if (base === null) return null;
  const named = readNoFollow(join(base, 'current'))?.trim() ?? '';
  return GENERATION.test(named) ? named : null;
}

function currentIndex(dropDir: string): { generation: string; index: Index } | null {
  const base = queueBaseOf(dropDir);
  const named = currentGenerationName(dropDir);
  if (base === null || named === null) return null;
  const index = readIndex(join(base, named));
  return index === null ? null : { generation: named, index };
}

/** Whether `msgId` holds a committed seq in the seat's current generation: one listing, no lock.
 *  A reader's hint only. */
export function queuedHint(dropDir: string, msgId: string): boolean {
  return queuePlaceOf(dropDir, msgId) !== null;
}

/** Where `msgId` sits in the seat's current generation: its generation and seq, or null when it
 *  holds none. A lookup, never authority: every use re-verifies against the receipts it writes. */
export function queuePlaceOf(dropDir: string, msgId: string): { generation: string; seq: number } | null {
  if (!NAME.test(msgId)) return null;
  const at = currentIndex(dropDir);
  const seq = at === null ? null : placed(at.index, msgId);
  return at === null || seq === null ? null : { generation: at.generation, seq };
}

/** `fn` under the writer's queue lock, tried once and never waited for: an entry the writer has
 *  created but not yet flushed is never seen (the commit boundary is the writer's folder fsync,
 *  which ends before it lets the lock go). A lock not taken answers `held` (fail closed). */
function underLock<T>(dropDir: string, fn: () => T, held: T): T {
  const base = queueBaseOf(dropDir);
  if (base === null) return held;
  let lock: ReturnType<typeof acquireLockAt>;
  try {
    lock = acquireLockAt(join(base, 'lock'), base, undefined, { waitMs: 0, pollMs: 10 });
  } catch {
    return held;
  }
  if (!('release' in lock)) return held;
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/**
 * Where `msgId` sits, PROVED under the lock: its entry name is the one placement of the id in the
 * current generation, and the record it names verifies for this root, session and seat. The only
 * placement a receipt may be signed at (E6).
 */
export function verifiedQueuePlaceOf(dropDir: string, msgId: string, binding: Binding, home: string): { generation: string; seq: number } | null {
  return underLock(dropDir, () => {
    const at = queuePlaceOf(dropDir, msgId);
    return at !== null && recordOnDisk({ dropDir, ...binding }, msgId, home).state === 'ok' ? at : null;
  }, null);
}

/** The msg_id a proved entry holds at `seq` of `generation`; null otherwise. */
export function entryMsgIdAt(dropDir: string, generation: string, seq: number, binding: Binding, home: string): string | null {
  const base = queueBaseOf(dropDir);
  if (base === null || !GENERATION.test(generation)) return null;
  return underLock(dropDir, () => {
    const index = readIndex(join(base, generation));
    const id = index?.seqs.get(seq) ?? null;
    return id !== null && placed(index!, id) === seq && recordOnDisk({ dropDir, ...binding }, id, home).state === 'ok' ? id : null;
  }, null);
}

/** The committed seqs of the current generation (tests and diagnostics). */
export function entriesOf(dropDir: string): number[] {
  const at = currentIndex(dropDir);
  return at === null ? [] : [...at.index.seqs.keys()].sort((a, b) => a - b);
}

type Order = { generation: string; seq: Map<string, number> } | { why: string };

function orderOf(dropDir: string, binding: Binding, ids: readonly string[], home: string): Order {
  if (queueBaseOf(dropDir) === null) return { why: 'the folder has no queue' };
  if (currentGenerationName(dropDir) === null) return { why: 'the queue has no current generation' };
  const at = currentIndex(dropDir);
  if (at === null) return { why: 'the queue entries cannot be listed' };
  const seq = new Map<string, number>();
  for (const id of ids) {
    const held = placed(at.index, id);
    if (held === null) return { why: `message ${id} has no committed queue entry` };
    if (recordOnDisk({ dropDir, ...binding }, id, home).state !== 'ok') return { why: `message ${id}'s queue entry does not verify` };
    seq.set(id, held);
  }
  return { generation: at.generation, seq };
}

/**
 * The queue order of `ids` (a listing's set), proved in ONE locked snapshot (E7): under the
 * writer's queue lock (tried once, never waited for) the current generation pointer is read and
 * every id's one entry name and the record it names are verified, all before the lock is let go.
 * A generation rotated before the lock is therefore never read as current. Null with the reason
 * when anything is unknown, missing or held.
 */
export function lockedQueueOrder(dropDir: string, binding: Binding, ids: readonly string[], home: string, faults: { afterLock?: () => void } = {}): Order {
  if (queueBaseOf(dropDir) === null) return { why: 'the folder has no queue' };
  return underLock(dropDir, () => {
    faults.afterLock?.();
    return orderOf(dropDir, binding, ids, home);
  }, { why: 'the queue lock is held' });
}

/**
 * The same order proof, OBSERVED (`team queues status`): no lock is taken and nothing is written,
 * so a public read changes no byte. An observation is not authority: only the locked proof
 * (`lockedQueueOrder`) orders a listing.
 */
export function observedQueueOrder(dropDir: string, binding: Binding, ids: readonly string[], home: string): Order {
  return orderOf(dropDir, binding, ids, home);
}

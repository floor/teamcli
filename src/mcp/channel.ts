// The channel leg: a message the seat's own inbox server pushes to its CLI. A transport marker
// records the reservation; only a separate signed consumer receipt proves a read.
//
// The channel is a development mode of the seat's launch, not a second transport an operator
// turns on separately: the seat's launch line carries the development-channels flag and names
// this team server, and the server then declares `experimental["claude/channel"]` and pushes one
// `notifications/claude/channel` per message that arrives after it starts. The body and the
// meta travel together; the signed record stays in the inbox for `inbox_read` and for every later
// reader, untouched. The server leaves a `<id>.channel-push.json` reservation beside the record,
// which the sender reads to end its walk as `sent (channel)`. Stdio handoff is not a read: the
// signed receipt waits for explicit client acknowledgement, inbox read or reply.
//
// A pushed message with no signed `read` receipt after the confirmation window is the one case
// the watch redelivers. It redelivers exactly once (`redelivered: channel unconfirmed`), and only
// for an id with no receipt: an acknowledged message is never touched again.
import { hostedCommit } from '../host/request-scope.ts';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, fstatSync, fsyncSync, readFileSync, statSync } from 'node:fs';
import { linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from '../host/guarded-fs.ts';
import { basename, join } from 'node:path';
import { cliWordListOf, provenScriptWord, shellScriptWordOf } from '../launch/cli-scope.ts';
import { flockBound, flockExclusive } from '../lock/flock.ts';
import { shellWords } from '../launch/shell-words.ts';
import { seatFolderOf } from '../send/drop-folder.ts';

/** The launch flag that loads a development channel, and the value that names this server. */
export const CHANNEL_FLAG = '--dangerously-load-development-channels';
export const CHANNEL_SERVER = 'team-inbox';

/** The capability a channel server declares, and the notification method the client renders. */
export const CHANNEL_CAPABILITY = 'claude/channel';
export const CHANNEL_METHOD = 'notifications/claude/channel';

/** The server's reservation beside a pushed record. It is not a read receipt: only a signed
 *  consumer receipt proves a read. */
export const CHANNEL_PUSH_RECEIPT = 'channel-push';
export const CHANNEL_PUSH_STATUS = 'sent (channel)';

/** The marker a sender leaves at the push marker's name when its own walk already wakes the seat
 *  through another leg. Any marker-aware serving server treats a marker for the id as a push and
 *  skips it — including a long-lived server running an install this sender has already replaced,
 *  whose own push after the fallback would be a second wake; a build older than this rule cannot
 *  honor it. It is not a push, and the sender's own wait never reads it as one. */
export const CHANNEL_HELD_RECEIPT = 'channel-held';

/** How long a send waits for the server's push marker. The server pushes when the drop folder
 *  changes, so this still covers a watch event that was missed, and the sender's own steps stay
 *  on `CHANNEL_TICK_MS`. */
export const CHANNEL_PUSH_GRACE_MS = 2_000;

/** How often a sender looks for the push marker it is waiting on. The serving inbox does not
 *  poll on this interval: a folder watch delivers a new record, and `CHANNEL_IDLE_MS` is the
 *  slow pass when that watch is quiet or down. */
export const CHANNEL_TICK_MS = 250;

/** How often a serving inbox with no bus still reads its folder whole. A few seconds, so an
 *  idle server does not scan the inbox several times a second. A new record is pushed from the
 *  folder watch or from a bus event, not from this pass. */
export const CHANNEL_IDLE_MS = 2_000;
/** How often the channel server looks for stamped records due another copy (E7b). */
export const CHANNEL_REDELIVER_MS = 30_000;

/** How often a serving inbox with a live bus subscription still reads its inbox whole: the bus
 *  carries each arrival at once, and this slow pass catches a sender that could not reach it. */
export const CHANNEL_SAFETY_MS = 5_000;

/** How long a pushed message waits for its signed read receipt before the watch redelivers it
 *  through the next leg. Three minutes is long enough for a handling turn, short enough that a
 *  lost push is not lost for the ten-minute inbox fallback. */
export const CHANNEL_CONFIRM_MS = 3 * 60_000;

/** The reason a push was redelivered, as the marker's own `redelivered` value: the channel had
 *  no signed receipt when its confirmation window ended. */
export const CHANNEL_UNCONFIRMED = 'channel unconfirmed';

/** The note a redelivery records, on the marker and on the history line. */
export const CHANNEL_UNCONFIRMED_REASON = `redelivered: ${CHANNEL_UNCONFIRMED}`;

/** The read receipt's `read_by` for an acknowledgement made through the channel tool. */
export const CHANNEL_READ_BY = 'channel';

/** The one sentence the server gives its client when the channel is on. The model acknowledges
 *  the id from the notification's meta in the same turn, before it reads or acts on anything. */
export const CHANNEL_INSTRUCTIONS =
  'When a channel notification arrives, call the ack tool with the id from its meta in the same handling turn, before you read the message or act on it.';

type ChannelSpan = { start: number; end: number };

/** Remove this team's channel option by its shell-word spans. Every byte outside the
 *  option stays as written, including quoted rules, newlines and unrelated spacing. */
export function withoutChannel(launch: string, server: string = CHANNEL_SERVER): string {
  // The same scope proof as option placement: prompt text, shell syntax and unproved scripts
  // cannot lend a substring the meaning of a CLI option.
  if (cliWordListOf('claude', launch) === null) return launch;
  return eraseChannelSpans(launch, channelSpans(launch, `server:${server}`));
}

function channelSpans(command: string, chosen: string): ChannelSpan[] {
  const script = shellScriptWordOf(command);
  if (script !== null) {
    const proof = provenScriptWord(command, script.word);
    if (proof === null) return [];
    const spans = literalWordSpans(command.slice(script.word.start, script.word.end));
    if (spans === null || spans.length !== proof.body.length) return [];
    // Project deletions through the original quoted word, including quote splices. Re-encoding
    // the whole script would change unrelated source bytes; erasing its emitted characters
    // leaves those bytes and all surrounding quote delimiters in place.
    return channelSpans(proof.body, chosen).flatMap((span) => spans.slice(span.start, span.end).map((source) => ({
      start: script.word.start + source.start, end: script.word.start + source.end,
    })));
  }
  const words = shellWords(command);
  if (words === null) return [];
  const removals: ChannelSpan[] = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word.text === '--') break;
    // These options carry prompt text, even when that text is exactly a flag-shaped word.
    if (word.text === '--append-system-prompt' || word.text === '--system-prompt') {
      at += 1;
      continue;
    }
    if (word.expands) continue;
    const attached = word.text.startsWith(`${CHANNEL_FLAG}=`);
    if (word.text !== CHANNEL_FLAG && !attached) continue;
    const value = attached ? word : words[at + 1];
    if (value === undefined || value.expands) continue;
    const names = (attached ? word.text.slice(CHANNEL_FLAG.length + 1) : value.text).split(',');
    if (!names.includes(chosen)) continue;
    if (names.every((name) => name === chosen || name === '')) {
      removals.push({ start: word.start, end: value.end });
    } else {
      const raw = command.slice(value.start, value.end);
      const spans = channelNameSpans(raw, names, chosen, attached);
      const wanted = (attached ? `${CHANNEL_FLAG}=` : '') + names.filter((name) => name !== chosen && name !== '').join(',');
      const read = shellWords(eraseChannelSpans(raw, spans));
      if (read?.length !== 1 || read[0]!.expands || read[0]!.text !== wanted) continue;
      removals.push(...spans.map((span) => ({ start: value.start + span.start, end: value.start + span.end })));
    }
    if (!attached) at += 1;
  }
  return removals;
}

/** Preserve every other identifier's spelling and quoting; discard only this server and
 *  adjacent commas, retaining one existing comma between each pair of remaining names. */
function channelNameSpans(raw: string, names: readonly string[], chosen: string, attached: boolean): ChannelSpan[] {
  const keep: boolean[] = Array(attached ? CHANNEL_FLAG.length + 1 : 0).fill(true);
  let kept = false;
  for (const [index, name] of names.entries()) {
    const retain = name !== chosen && name !== '';
    if (index > 0) keep.push(retain && kept);
    keep.push(...Array(name.length).fill(retain));
    if (retain) kept = true;
  }
  const spans = literalWordSpans(raw);
  return spans === null || spans.length !== keep.length ? [] : spans.filter((_span, index) => !keep[index]);
}

/** Source spans of a proved literal word's decoded characters. Quotes emit no character;
 *  escapes emit their literal character, and line continuations emit nothing. The caller
 *  checks this projection against the shared shell-word reader before accepting an edit. */
function literalWordSpans(raw: string): ChannelSpan[] | null {
  const spans: ChannelSpan[] = [];
  let quote: "'" | '"' | null = null;
  for (let at = 0; at < raw.length;) {
    const char = raw[at]!;
    if (quote === null && char === '$' && raw[at + 1] === "'") {
      quote = "'";
      at += 2;
    } else if (char === quote) {
      quote = null;
      at += 1;
    } else if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      at += 1;
    } else if (char === '\\' && quote !== "'") {
      const next = raw[at + 1];
      if (next === undefined) return null;
      if (next === '\n') at += 2;
      else if (quote === null || '$`"\\'.includes(next)) {
        spans.push({ start: at, end: at + 2 });
        at += 2;
      } else {
        spans.push({ start: at, end: at + 1 });
        at += 1;
      }
    } else {
      spans.push({ start: at, end: at + 1 });
      at += 1;
    }
  }
  return spans;
}

function eraseChannelSpans(command: string, spans: readonly ChannelSpan[]): string {
  let result = command;
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result;
}

/**
 * Whether a launch line starts its CLI with the development channel naming this team server.
 * The flag is the one measured on the client; its value is `server:<name>`, one or more of them,
 * comma-separated. Any other spelling, or a line without the flag, is no channel at all.
 */
export function channelLaunchEnabled(launch: string | undefined | null, server: string = CHANNEL_SERVER): boolean {
  if (typeof launch !== 'string' || launch.trim() === '') return false;
  const words = launch.trim().split(/\s+/);
  const chosen = `server:${server}`;
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word === CHANNEL_FLAG) {
      const value = words[at + 1];
      if (value !== undefined && value.split(',').includes(chosen)) return true;
      continue;
    }
    if (word.startsWith(`${CHANNEL_FLAG}=`)) {
      if (word.slice(CHANNEL_FLAG.length + 1).split(',').includes(chosen)) return true;
    }
  }
  return false;
}

/** The push marker's path: the record's own name, then the marker's suffix. */
export function channelPushPath(dropDir: string, id: string): string {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  return join(dropDir, `${id}.${CHANNEL_PUSH_RECEIPT}.json`);
}

/** Whether a marker for exactly this id is present and readable. The marker is either the
 *  server's push or the sender's held marker; both say this id is not to be pushed. A file that
 *  does not parse, or that names another id, is no marker. */
export function channelPushHeld(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

/** Whether the server itself wrote the push marker for this id. The sender's held marker sits at
 *  the same name but is not a push: the channel leg has not delivered anything when only that one
 *  is there, and its walk goes on. */
export function channelPushed(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown; kind?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id && parsed.kind !== CHANNEL_HELD_RECEIPT;
  } catch {
    return false;
  }
}


/** Whether the server recorded a completed notification write for this id. A reservation, a held
 *  marker, or a marker left behind when the seat lost liveness is not a delivery. */
export function channelNotified(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown; kind?: unknown; notified?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id && parsed.kind !== CHANNEL_HELD_RECEIPT && parsed.notified === true;
  } catch {
    return false;
  }
}

/** Records that the notification line was written. Never creates the marker and never turns a
 *  held marker into a delivery: only the server's own reservation can become a completed write. */
export function markChannelNotified(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  const path = channelPushPath(dropDir, id);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown; kind?: unknown };
    if (parsed === null || typeof parsed !== 'object' || parsed.id !== id || parsed.kind === CHANNEL_HELD_RECEIPT) return false;
    const next = { ...parsed, notified: true };
    // A reader must see the previous marker or the completed one, never a truncated rewrite.
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // The marker at `path` was not replaced.
    }
    return false;
  }
}

/** Written inside the commit lock before the notification line. It means the line was about to
 *  leave or did leave, including when the completion flag could not be published. It is not
 *  itself a successful delivery, and it is not permission for another leg. */
export function channelEmittedPath(dropDir: string, id: string): string {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  return join(dropDir, `${id}.channel-emitted`);
}

export function channelEmitted(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const parsed = JSON.parse(readFileSync(channelEmittedPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

export function recordChannelEmitted(dropDir: string, id: string, at: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  hostedCommit('recordChannelEmitted');
  try {
    writeFileSync(channelEmittedPath(dropDir, id), `${JSON.stringify({ v: 1, id, at })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The sender's abort beside a reservation: an in-flight server must not write the notification
 *  after the sender has taken another leg. It is not a push and not a delivery. */
export function channelAbortPath(dropDir: string, id: string): string {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  return join(dropDir, `${id}.channel-abort`);
}

export function channelAborted(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const parsed = JSON.parse(readFileSync(channelAbortPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

export function recordChannelAbort(dropDir: string, id: string, at: string, reason: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  hostedCommit('recordChannelAbort');
  try {
    writeFileSync(channelAbortPath(dropDir, id), `${JSON.stringify({ v: 1, id, at, reason })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The sender's marker: its walk takes the message on another leg, so no serving channel may
 *  push it. `reason` says which walk left it; `at` is the sender's clock, not a push time. */
export type ChannelHeldReceipt = {
  v: 1;
  kind: 'channel-held';
  id: string;
  at: string;
  reason: string;
};

/**
 * Writes the sender's held marker whole, mode 0600. `wx` is the reservation: a marker already at
 * the name is the server's push of the same id, and a push that already happened is never
 * replaced. False when the marker could not be written or one was already there — the send goes
 * on either way; the marker only ever prevents a later push.
 */
export function recordChannelHeld(dropDir: string, receipt: ChannelHeldReceipt): boolean {
  dropDir = seatFolderOf(dropDir, receipt.id); // E7b revision 3: the record's own tree.
  hostedCommit('recordChannelHeld');
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}


/** The lock the server holds across its abort check, notification write, and completion flag,
 *  and the sender holds across the same check before it takes another leg. A check and a write
 *  on either side with the lock released between them is a live duplicate, not only a crash.
 *  The lock name is published only after the owner record is durable. An empty or malformed
 *  name is not reclaimed: unknown ownership stays blocked. A time grace is not ownership. */
export function channelCommitLockPath(dropDir: string, id: string): string {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  return join(dropDir, `${id}.channel-commit.lock`);
}

/** Test seams. Production calls pass none. */
export type ChannelCommitHooks = {
  /** After the private owner record is durable, before the lock name is published. */
  beforePublish?: () => void;
  /** After this holder has recorded its inode, before the lock name is removed. */
  beforeRelease?: () => void;
  /** The owner-record write fails after the private file is created. */
  failOwnerWrite?: boolean;
  /** While this holder owns the reclaim. A rival here stays out. When flock is bound, the lock is
   *  still the dead record. When it is not, the lock already names this holder. */
  beforeLockRename?: () => void;
  /** Pid of the external hold used when flock cannot be bound. */
  helperPid?: (pid: number) => void;
  /** How long to wait for the external hold to publish. Production waits two seconds. */
  helperWaitMs?: number;
  /** Force the plain-filesystem recovery used when flock cannot be bound. */
  skipFlock?: boolean;
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The private file is already gone.
  }
}

/** Closes `fd` and removes `path` when that name still refers to the inode `fd` held. A name
 *  someone else has replaced is left alone. A throw while releasing still closes the descriptor
 *  and still removes the name we held. */
function dropOwned(fd: number, path: string): void {
  let held: { dev: number; ino: number } | null = null;
  try {
    const info = fstatSync(fd);
    held = { dev: info.dev, ino: info.ino };
  } catch {
    held = null;
  }
  try {
    closeSync(fd);
  } catch {
    // The descriptor is already closed.
  }
  if (held === null) return;
  try {
    const now = statSync(path);
    if (now.dev === held.dev && now.ino === held.ino) unlinkSync(path);
  } catch {
    // The inode we held is already gone. A replacement at this path belongs to its creator.
  }
}

/** Publishes the lock name only after the owner pid is durable in a private file. A contender
 *  never sees an empty lock name. `failOwnerWrite` closes the private descriptor and leaves no
 *  lock name. */
function takeChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number | null = null;
  let published = false;
  try {
    fd = openSync(prep, 'wx');
    if (hooks?.failOwnerWrite === true) throw new Error('owner write failed');
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    hooks?.beforePublish?.();
    linkSync(prep, lock);
    published = true;
    const mine = fstatSync(fd);
    const named = statSync(lock);
    if (mine.dev !== named.dev || mine.ino !== named.ino) throw new Error('lock inode changed');
    const owned = fd;
    fd = null;
    discard(prep);
    return owned;
  } catch {
    return 'busy';
  } finally {
    // A return that does not hand back the descriptor removes the name this attempt published.
    if (fd !== null) {
      if (published) dropOwned(fd, lock);
      else {
        try {
          closeSync(fd);
        } catch {
          // The descriptor is already closed.
        }
      }
      discard(prep);
    }
  }
}

// Exclusive non-blocking flock (src/lock/flock.ts). A live holder's claim stays at its public
// name, so recovery never renames it aside and never has a name to restore over a successor.

/** Claims this process already holds. A second attempt in the same process cannot wait on its
 *  own flock, so the set keeps that attempt from publishing another claim or renaming the lock. */
const heldClaims = new Set<string>();

function claimPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.channel-commit.reclaim`);
}

/** Creates a claim, locks it, and only then publishes the name. The lock is already held when
 *  any other opener can see the file. */
function createHeldClaim(dropDir: string, id: string): number | 'busy' {
  const claim = claimPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(prep, 'wx');
  } catch {
    return 'busy';
  }
  let linked = false;
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if (!flockExclusive(fd)) throw new Error('claim lock unavailable');
    linkSync(prep, claim);
    linked = true;
    const mine = fstatSync(fd);
    const published = statSync(claim);
    if (mine.dev !== published.dev || mine.ino !== published.ino) throw new Error('claim inode changed');
  } catch {
    closeSync(fd);
    discard(prep);
    if (linked) discard(claim);
    return 'busy';
  }
  discard(prep);
  heldClaims.add(claim);
  return fd;
}

/** Adopts a claim left by a dead pid, including a hard link of that dead lock. A live pid is
 *  left untouched: its name is not renamed and not replaced. */
function adoptHeldClaim(dropDir: string, id: string): number | 'busy' {
  const claim = claimPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  let fd: number;
  try {
    fd = openSync(claim, 'r');
  } catch {
    return 'busy';
  }
  if (!flockExclusive(fd)) {
    closeSync(fd);
    return 'busy';
  }
  let holder = NaN;
  let mineDev = 0;
  let mineIno = 0;
  try {
    const info = fstatSync(fd);
    mineDev = info.dev;
    mineIno = info.ino;
    holder = Number(readFileSync(fd, 'utf8').trim());
    const now = statSync(claim);
    if (now.dev !== mineDev || now.ino !== mineIno) throw new Error('claim was replaced');
  } catch {
    closeSync(fd);
    return 'busy';
  }
  if (!Number.isInteger(holder) || holder <= 0 || pidAlive(holder)) {
    closeSync(fd);
    return 'busy';
  }
  heldClaims.add(claim);
  return fd;
}

function flockWorks(hooks?: ChannelCommitHooks): boolean {
  if (hooks?.skipFlock === true) return false;
  return flockBound();
}

const FLOCK_HELPER = `import errno, fcntl, os, select, sys
claim, lock, pid, status, go, prep = sys.argv[1:]
parent = int(pid)

def write_status(text):
    out = os.open(status, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(out, text.encode())
    os.close(out)

def alive(n):
    try:
        os.kill(n, 0)
    except OSError as err:
        return err.errno == errno.EPERM
    return True

def dead_lock():
    try:
        raw = open(lock, 'rb').read().decode().strip()
    except OSError:
        return False
    if not raw.isdigit():
        return False
    holder = int(raw)
    return holder > 0 and not alive(holder)

fd = os.open(claim, os.O_RDONLY)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    write_status('busy')
    raise SystemExit
write_status('held')
while not os.path.exists(go):
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if not ready:
        continue
    if sys.stdin.buffer.read(1) == b'':
        raise SystemExit
if not dead_lock():
    write_status('aborted')
    raise SystemExit
stall = claim + '.stall'
while os.path.exists(stall):
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if ready and sys.stdin.buffer.read(1) == b'':
        raise SystemExit
pfd = os.open(prep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(pfd, (str(parent) + chr(10)).encode())
os.fsync(pfd)
os.close(pfd)
try:
    os.rename(prep, lock)
except OSError:
    try:
        os.unlink(prep)
    except OSError:
        pass
    write_status('aborted')
    raise SystemExit
write_status('published')
sys.stdin.buffer.read()
`;

function readHelperStatus(path: string, accept: readonly string[], waitMs = 2_000): string | null {
  const started = Date.now();
  // The helper runs in its own process and publishes the status beside the lock. This returns
  // as soon as that status is one of `accept`, and at the deadline otherwise. It does not park
  // the main thread on a wait whose timeout can fail to fire.
  for (;;) {
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (accept.includes(text)) return text;
    } catch {
      // The helper has not written the status yet.
    }
    if (Date.now() - started >= waitMs) return null;
  }
}

function stopHelper(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    // The pipe is already closed.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The helper has already exited.
  }
}

function holdClaim(dropDir: string, id: string): number | 'busy' {
  const created = createHeldClaim(dropDir, id);
  if (created !== 'busy') return created;
  return adoptHeldClaim(dropDir, id);
}

function releaseHeldClaim(claim: string, fd: number): void {
  heldClaims.delete(claim);
  try {
    const mine = fstatSync(fd);
    const now = statSync(claim);
    if (mine.dev === now.dev && mine.ino === now.ino) unlinkSync(claim);
  } catch {
    // The name is already gone, or it no longer refers to the inode we held.
  }
  closeSync(fd);
}

/** Reclaims a dead lock when this process cannot bind flock. The helper holds the claim and is
 *  the only one that renames the lock. If the helper dies, this process does not rename. */
function reclaimHeldByHelper(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const claim = claimPath(dropDir, id);
  const lock = channelCommitLockPath(dropDir, id);
  if (heldClaims.has(claim)) return 'busy';
  let created = false;
  try {
    readFileSync(claim);
  } catch {
    const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
    let prepFd: number;
    try {
      prepFd = openSync(prep, 'wx');
    } catch {
      return 'busy';
    }
    let linked = false;
    try {
      writeFileSync(prepFd, `${process.pid}\n`);
      fsyncSync(prepFd);
      linkSync(prep, claim);
      linked = true;
    } catch {
      closeSync(prepFd);
      discard(prep);
      if (linked) discard(claim);
      return 'busy';
    }
    closeSync(prepFd);
    discard(prep);
    created = true;
  }
  const status = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  const go = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  hostedCommit('node:child_process.spawn');
  const helper = spawn('/usr/bin/python3', ['-c', FLOCK_HELPER, claim, lock, String(process.pid), status, go, prep], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  helper.on('error', () => {
    // A missing helper fails closed through the status wait.
  });
  let accepted = false;
  let marked: { dev: number; ino: number } | null = null;
  try {
    const answer = readHelperStatus(status, ['held', 'busy']);
    if (answer !== 'held') {
      if (created) discard(claim);
      return 'busy';
    }
    heldClaims.add(claim);
    let holder = NaN;
    try {
      marked = statSync(claim);
      holder = Number(readFileSync(claim, 'utf8').trim());
    } catch {
      if (created) discard(claim);
      return 'busy';
    }
    const ours = created && holder === process.pid;
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder) && !ours) return 'busy';
    // The published lock name's pid is the holder. The claim can still carry a dead pid, and
    // the claim flock is free once the helper that published the lock has exited. Neither of
    // those makes a live lock pid stealable. Only a dead lock pid may be replaced.
    let publishedHolder = NaN;
    try {
      publishedHolder = Number(readFileSync(lock, 'utf8').trim());
    } catch {
      if (created) discard(claim);
      return 'busy';
    }
    if (Number.isInteger(publishedHolder) && publishedHolder > 0 && pidAlive(publishedHolder)) {
      if (created) discard(claim);
      return 'busy';
    }
    accepted = true;
    if (!lockIsDead(lock)) return 'busy';
    writeFileSync(go, '1\n');
    const published = readHelperStatus(status, ['published', 'aborted'], hooks?.helperWaitMs);
    if (published !== 'published') stopHelper(helper);
    let fd: number | null = null;
    try {
      fd = openSync(lock, 'r');
      const now = Number(readFileSync(fd, 'utf8').trim());
      if (now !== process.pid) {
        closeSync(fd);
        fd = null;
        return 'busy';
      }
      const mine = fstatSync(fd);
      const at = statSync(lock);
      if (mine.dev !== at.dev || mine.ino !== at.ino) {
        closeSync(fd);
        fd = null;
        return 'busy';
      }
    } catch {
      if (fd !== null) dropOwned(fd, lock);
      return 'busy';
    }
    if (fd === null) return 'busy';
    if (typeof helper.pid === 'number') hooks?.helperPid?.(helper.pid);
    // The descriptor is held, but the caller has not recorded it yet. Record it before the
    // hook so a nested attempt sees a live holder and does not remove the published name.
    heldCommits.add(lock);
    try {
      hooks?.beforeLockRename?.();
    } catch (error) {
      heldCommits.delete(lock);
      dropOwned(fd, lock);
      throw error;
    }
    return fd;
  } finally {
    heldClaims.delete(claim);
    stopHelper(helper);
    discard(status);
    discard(go);
    discard(prep);
    if (accepted && marked !== null) {
      try {
        const now = statSync(claim);
        if (now.dev === marked.dev && now.ino === marked.ino) unlinkSync(claim);
      } catch {
        // The claim name is already gone, or it no longer refers to the inode we held.
      }
    }
  }
}

/** Replaces the dead lock in one rename, so the lock name is never absent. */
function replaceDeadLock(dropDir: string, id: string): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  const prep = join(dropDir, `${id}.channel-commit.prep-${process.pid}-${randomBytes(4).toString('hex')}`);
  let fd: number | null = null;
  let published = false;
  try {
    fd = openSync(prep, 'wx');
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    renameSync(prep, lock);
    published = true;
    const mine = fstatSync(fd);
    const named = statSync(lock);
    if (mine.dev !== named.dev || mine.ino !== named.ino) throw new Error('lock inode changed');
    const owned = fd;
    fd = null;
    return owned;
  } catch {
    return 'busy';
  } finally {
    if (fd !== null) {
      if (published) dropOwned(fd, lock);
      else {
        try {
          closeSync(fd);
        } catch {
          // The descriptor is already closed.
        }
        discard(prep);
      }
    }
  }
}

function lockIsDead(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, 'r');
  } catch {
    return false;
  }
  try {
    const holder = Number(readFileSync(fd, 'utf8').trim());
    return Number.isInteger(holder) && holder > 0 && !pidAlive(holder);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** A dead positive pid can be reclaimed. An empty, partial, or live record cannot. The reclaim
 *  claim stays at its public name for the whole replacement. A live claim is not moved. The dead
 *  lock is replaced by one rename, so a third taker never sees the name absent. */
function reclaimChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const lock = channelCommitLockPath(dropDir, id);
  if (!lockIsDead(lock)) return 'busy';
  if (!flockWorks(hooks)) return reclaimHeldByHelper(dropDir, id, hooks);
  const claimFd = holdClaim(dropDir, id);
  if (claimFd === 'busy') return 'busy';
  const claim = claimPath(dropDir, id);
  try {
    if (!lockIsDead(lock)) return 'busy';
    hooks?.beforeLockRename?.();
    if (!lockIsDead(lock)) return 'busy';
    return replaceDeadLock(dropDir, id);
  } finally {
    releaseHeldClaim(claim, claimFd);
  }
}

function tryChannelCommit(dropDir: string, id: string, hooks?: ChannelCommitHooks): number | 'busy' {
  const created = takeChannelCommit(dropDir, id, hooks);
  if (created !== 'busy') return created;
  return reclaimChannelCommit(dropDir, id, hooks);
}

function releaseChannelCommit(fd: number, path: string, hooks?: ChannelCommitHooks): void {
  let held: { dev: number; ino: number } | null = null;
  try {
    const info = fstatSync(fd);
    held = { dev: info.dev, ino: info.ino };
  } catch {
    held = null;
  }
  try {
    hooks?.beforeRelease?.();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is already closed.
    }
    if (held !== null) {
      try {
        const now = statSync(path);
        if (now.dev === held.dev && now.ino === held.ino) unlinkSync(path);
      } catch {
        // The inode we held is already gone. A replacement at this path belongs to its creator.
      }
    }
  }
}

function lockHolder(dropDir: string, id: string): number | null {
  try {
    const holder = Number(readFileSync(channelCommitLockPath(dropDir, id), 'utf8').trim());
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/** True when the lock name exists and is not a dead positive pid. An empty or malformed record
 *  stays blocked. A missing name is not busy. */
export function channelCommitActive(dropDir: string, id: string): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  try {
    const holder = Number(readFileSync(channelCommitLockPath(dropDir, id), 'utf8').trim());
    if (!Number.isInteger(holder) || holder <= 0) return true;
    return pidAlive(holder);
  } catch {
    return false;
  }
}

/** Lock paths this process currently holds a descriptor for. A name that carries our pid and is
 *  not in this set is a leftover: no one is waiting on it, and the next attempt removes it. */
const heldCommits = new Set<string>();

/** Runs `work` while this process holds the commit lock. `busy` means another live holder has
 *  the name, or this process already holds it. A name that carries this process's pid while
 *  this process does not hold the descriptor is stale: it is removed and the take is repeated.
 *  This never waits. A caller that wants another try schedules it. The lock name is removed on
 *  every return, including a throw from `work` or from the release hook. Nothing is spawned
 *  while the descriptor is held. */
export function withChannelCommit<T>(dropDir: string, id: string, work: () => T, hooks?: ChannelCommitHooks): T | 'busy' {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  const path = channelCommitLockPath(dropDir, id);
  let fd: number | 'busy' = 'busy';
  for (let at = 0; at < 3; at += 1) {
    fd = tryChannelCommit(dropDir, id, at === 0 ? hooks : undefined);
    if (fd !== 'busy') break;
    const holder = lockHolder(dropDir, id);
    // A live pid on the published lock is the holder, including this process while its
    // descriptor is recorded. A stale claim or a free flock does not make that pid stealable.
    // Only a dead lock pid is removed and tried again. This process's own pid is removed only
    // when no descriptor is held for the name.
    if (holder !== null && pidAlive(holder) && (holder !== process.pid || heldCommits.has(path))) return 'busy';
    if (holder === process.pid && !heldCommits.has(path)) {
      discard(path);
      continue;
    }
    return 'busy';
  }
  if (fd === 'busy') return 'busy';
  heldCommits.add(path);
  try {
    return work();
  } finally {
    heldCommits.delete(path);
    releaseChannelCommit(fd, path, hooks);
  }
}

/**
 * Before another leg: a completed notification stays the delivery. The decision and the guard
 * writes share the commit lock with the server's write. A reserved name is not success. When
 * neither guard can be written, the result is `unguarded` and the caller must not start another
 * leg: reporting a hold that was not written would let both sides deliver.
 */
export function reserveChannelFallback(dropDir: string, receipt: ChannelHeldReceipt): 'notified' | 'held' | 'unguarded' | 'uncertain' {
  dropDir = seatFolderOf(dropDir, receipt.id); // E7b revision 3: the record's own tree.
  const claim = withChannelCommit(dropDir, receipt.id, () => {
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    const aborted = recordChannelAbort(dropDir, receipt.id, receipt.at, receipt.reason);
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    const held = recordChannelHeld(dropDir, receipt);
    if (channelNotified(dropDir, receipt.id)) return 'notified' as const;
    if (channelEmitted(dropDir, receipt.id)) return 'uncertain' as const;
    if (aborted || held || channelAborted(dropDir, receipt.id) || channelPushHeld(dropDir, receipt.id)) return 'held' as const;
    return 'unguarded' as const;
  });
  return claim === 'busy' ? 'unguarded' : claim;
}

/** The marker the server reserves before one channel notification. The meta joins the
 *  reservation to its intended message; the marker alone proves neither handoff nor read. */
export type ChannelPushReceipt = {
  v: 1;
  kind: 'channel-push';
  id: string;
  seat: string;
  session: string;
  root: string;
  at: string;
  meta: { id: string; from: string; seat: string; team: string };
  content_sha256: string;
  status: typeof CHANNEL_PUSH_STATUS;
  /** Present only after the notification line was written. A marker without it is a reservation. */
  notified?: true;
};

/**
 * Writes the push marker whole, mode 0600. `wx` is the reservation: a marker already at the name
 * belongs to an earlier reservation of the same id, and the second write is refused rather than
 * replacing it. False when the marker could not be written or was already there: the caller
 * must not write a notification without winning this reservation.
 */
export function recordChannelPush(dropDir: string, receipt: ChannelPushReceipt): boolean {
  dropDir = seatFolderOf(dropDir, receipt.id); // E7b revision 3: the record's own tree.
  hostedCommit('recordChannelPush');
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * rfc-event-comms E7b: retires one channel attempt of a stamped record, so the next copy can be
 * pushed (R2.4 per-attempt markers). Under the record's channel commit lock, the push marker, the
 * emitted marker and the abort beside them are moved, never deleted, into the record's delivery
 * history (`.exposures/<id>/c<time>.<name>`), where they stay as evidence of the earlier copy.
 * True once none stands at its live name; false on any fault (the next pass tries again).
 */
export function retireChannelAttempt(dropDir: string, id: string, nowMs: number = Date.now()): boolean {
  dropDir = seatFolderOf(dropDir, id); // E7b revision 3: the record's own tree.
  const done = withChannelCommit(dropDir, id, () => {
    const history = join(dropDir, '.exposures', id);
    try {
      mkdirSync(history, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    for (const path of [channelPushPath(dropDir, id), channelEmittedPath(dropDir, id), channelAbortPath(dropDir, id)]) {
      try {
        renameSync(path, join(history, `c${String(nowMs)}.${basename(path)}`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return true;
  });
  return done === true;
}

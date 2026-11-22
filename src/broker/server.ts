// The broker's serving half: bind the clone's one socket, check every request against the
// recorded state, dispatch the read, apply the policy, answer one line. The start protocol has
// three answers, pinned by the recon's probe under bun and node: a connect that succeeds means a
// broker already answers (refuse, the caller's exit is nonzero); ECONNREFUSED means a socket
// file left by an unclean death (unlink it — only when it is still the very entry the probe saw,
// and only once that entry has answered stale twice with a turn between — then bind); ENOENT
// means no file (bind). One lstat stands before all three: a path that is
// not a socket is refused up front — never probed, never unlinked (the ubuntu CI read that made
// this a pinned fork: run 37778336251). A clean
// close removes the file — the runtime owns that, pinned under bun 1.4.2 and node v26.8.1
// (afterBind true, afterClose false) — and a path that cannot bind is a refusal with a code,
// never a crash (a regular file at the path fails under both runtimes: EADDRINUSE under bun,
// EINVAL under node; an over-long path fails under node only — bun binds 207 bytes). The check is the S2 caller
// functions reused verbatim, against the claimed (seat, pane) and the recorded state: integrity
// against a mistaken agent, not authenticity against a hostile one (RFC 008 §5's same-principal
// limit; the page says so).
//
// The whole start section — the lstat gate, the probe, the clear, the bind, the listen — runs
// under one lock beside the socket (`.agents/broker.sock.lock`, never at the socket path
// itself), so two starts in two processes serialize instead of racing a path one of them is
// still on its way to binding (the pin: a real owner held pre-listen, a second real start
// spawned mid-hold — the owner serves, the second waits and reads it live). The serialization
// is between starts that leave the paths alone — a same-principal process that removes the
// lock or the socket path can still split two starts, which the page states. The lock file
// holds its holder's pid and carries `withLock`'s discipline from `src/state.ts` — an
// exclusive create that publishes the entry whole (a private temp naming its writer, linked
// into the shared name, so no reader ever sees the name without its pid), a lock whose holder
// is dead taken over, one start at a time through a claim beside the lock — written as an
// await loop because this section spans awaits, where `withLock`
// busy-waits; `withLock` itself is untouched. A start whose wait
// outlasts the deadline answers `locked`: refused, nothing cleared, nothing bound. The lock is
// released when the listen lands and on every other way out of the section.
import { closeSync, fstatSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from '../host/guarded-fs.ts';
import { createServer, connect, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { anotherPaneRefusal, callerVerdict, noPaneRefusal, standingOf, type Caller } from '../caller.ts';
import type { TeamFile } from '../file/types.ts';
import type { TaskRead, TaskRecord, TaskRefusal } from '../tasks/adapter.ts';
import { applyPolicy, bareRefusalId, type TaskPolicy } from './policy.ts';
import { MAX_ANSWER_BYTES, MAX_REQUEST_BYTES, brokerSocket, encodeLine, parseRequest, type BrokerAnswer, type BrokerRequest } from './protocol.ts';
import { hostedCommit } from '../host/request-scope.ts';

/** What one dispatch of the read produced: the adapter's read (with its notice, when the read
 *  was not the whole tracker), or a failure the broker keeps to its own terminal. */
export type BrokerReadResult = { kind: 'read'; read: TaskRead; notice?: string } | { kind: 'failed'; message: string };

export type BrokerReader = () => Promise<BrokerReadResult>;

export type StartBrokerInput = {
  root: string;
  /** The approved team file: the declared seats and the session every request is judged in. */
  team: TeamFile;
  read: BrokerReader;
  policy?: TaskPolicy;
  /** The broker's own one-line failures — a failed read, a broken connection. The owner reads
   *  them where the broker runs; a seat never sees more than the generic refusal. */
  stderr: (text: string) => void;
};

export type BrokerHandle = { close(): Promise<void> };

export type StartBrokerResult =
  | { kind: 'serving'; cleared: boolean; handle: BrokerHandle }
  | { kind: 'busy' }
  | { kind: 'bind-failed'; code?: string }
  | { kind: 'locked' };

/** A connection that opens and never sends a line is dropped after this. */
const REQUEST_IDLE_MS = 5000;

/** The one sentence a malformed or over-long request hears — the client never sends one. */
const UNKNOWN_REQUEST = 'the request is not one this broker knows';

/** What the seat hears when a read failed; the detail stays on the broker's terminal. */
const FAILED_READ = 'the broker failed this read';

/** A start that keeps losing the clear race re-walks the three answers this many times; the
 *  bound ends on the pinned bare bind sentence instead of looping. */
const START_WALKS = 8;

/** A stale answer is confirmed only when the same entry answers stale again after this turn:
 *  a fresh sibling socket answers ECONNREFUSED for a moment before its owner's listen takes
 *  effect (CI's ubuntu runner, run 37787613018: two concurrent starts both served — the second
 *  probed the first's fresh socket "stale" where macOS already read it live). */
const STALE_CONFIRM_MS = 50;

/** How long a start waits on the start lock's live holder before it refuses. It must outlast a
 *  sibling start's whole section (the pin holds one for 1500ms and the waiter still wins the
 *  lock), and it fails closed: past this, the pinned `locked` answer, nothing touched. */
const LOCK_WAIT_MS = 2000;

/** The wait's poll cadence, and the pause before re-reading a lock too young to hold its pid —
 *  `withLock`'s own 50 and 20. */
const LOCK_POLL_MS = 50;
const LOCK_YOUNG_MS = 1000;

/** `withLock`'s read of "the holder is still running" (it is not exported; the discipline is
 *  mirrored here, not imported): a pid that answers signal 0, with EPERM — another user's live
 *  process — counting alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock read that may land in a writer's create→write gap, or on junk: the pid only when the
 *  bytes are a positive integer, NaN otherwise — never 0, which is what an empty file parses
 *  to and which must stay unknown here (it names no holder; the loop below reads a positive
 *  integer as the only thing that can). */
function readPid(path: string): number {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : NaN;
  } catch {
    return NaN;
  }
}

/** Whether a file is young enough that its writer could still be coming. One that is not there
 *  any more is not. */
function young(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < LOCK_YOUNG_MS;
  } catch {
    return false;
  }
}

/** Whether a path still holds the very entry a judgement read: the same dev+ino, and the pid
 *  bytes still naming what they named then — `NaN` when the judgement read absence or junk.
 *  A replacement is a different inode; one that reuses the freed inode names its own writer.
 *  The unlinks in `takeOver` are gated on this: an unlink acts only on the entry its actor
 *  read. */
function stillJudged(path: string, dev: number, ino: number, seen: number): boolean {
  const now = lstatSync(path, { throwIfNoEntry: false });
  if (now === undefined || now.dev !== dev || now.ino !== ino) return false;
  const pid = readPid(path);
  return Number.isNaN(seen) ? Number.isNaN(pid) : pid === seen;
}

/** The temps a killed create leaves: `<path>.<pid>.new`, beside the lock and beside its claim.
 *  Each names its writer, so the next start clears the dead ones and never touches a live
 *  pid's — a live pid's temp is a create in flight. The released protocol never reads any of
 *  them: the sweep is hygiene, not recovery. A start whose temp was wrongly swept would fail
 *  its link with the same EEXIST a rival's win answers, so the race direction is safe. */
function sweepTemps(lockPath: string): void {
  let names: string[];
  try {
    names = readdirSync(dirname(lockPath));
  } catch {
    return;
  }
  const prefix = `${basename(lockPath)}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.new')) continue;
    const pid = Number(name.slice(prefix.length, -'.new'.length).split('.').pop());
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try {
      unlinkSync(join(dirname(lockPath), name));
    } catch {}
  }
}

/** The one exclusive create the lock and its takeover claim both run — the entry's name and
 *  its content published in one step, never one before the other. The write goes to a private
 *  temp that names its writer (`<path>.<pid>.new`), then `link` gives the shared name: it can
 *  appear only already carrying this process's pid, and only one create can win it — every
 *  other answers EEXIST exactly as a plain exclusive create did, so both callers' waiter
 *  branches are unchanged. A plain `openSync(path,'wx')` cannot close its own gap — the name
 *  is visible from the create's return, the pid a beat behind — and that gap was the finding:
 *  a live writer paused in it was aged out as if dead, its entry evicted while the writer was
 *  still to resume, its pid then published into an unlinked file. There is no such gap here to
 *  stand in. Measured under bun 1.4.2 before it was written into the source: after link the
 *  shared name carries the temp's bytes (`content-after-link "4242\n"`), the temp fd's
 *  dev+ino equal the name's (`identity-match= true`), and a second link answers EEXIST. The
 *  temp is removed by this call's own finally; one left by a kill is swept by the next start
 *  (`sweepTemps`), and a temp under this process's own pid — which only this live process can
 *  have named — is cleared before the create. */
function createOwned(path: string): { dev: number; ino: number } {
  const tmp = `${path}.${process.pid}.new`;
  try {
    unlinkSync(tmp); // this process's own stale temp, if any: no other writer names it
  } catch {}
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, `${process.pid}\n`);
    const held = fstatSync(fd);
    linkSync(tmp, path); // EEXIST = a rival holds the name: the plain create's own answer
    return { dev: held.dev, ino: held.ino };
  } finally {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** The dead lock's removal, one start at a time: every takeover runs through a claim file
 *  beside the lock (`<lock>.takeover`), so exactly one start is removing the dead entry while
 *  the others wait — and the removal is the whole of the takeover. The lock path is never
 *  moved aside to be judged: that dance freed the path for a rival's exclusive create while
 *  the judgement ran, and against a burst of starts a rival's freshly written lock could be
 *  the very entry such a judgement landed on — the free window carried a second walker, and
 *  neither the restore-by-name nor a put-back that lost the name race closed it (measured on
 *  my own export of the head that introduced the discipline: six starts on a dead pid's lock
 *  breached 10/30 rounds, corpse + dead pid 13/60, and an aside-judging variant of this fix
 *  48/300 — every breach a `bind-failed` start that never waited). Here the claim's holder
 *  re-reads the entry and removes it only when it still names no live holder and is not still
 *  young — this build's own creates publish whole, so an entry still in that gap is a foreign
 *  or older writer's, and the window stays its charge — then drops the claim, and
 *  every start re-races the exclusive create, which arbitrates cleanly: one wins the create
 *  and holds, every other reads the winner live and takes the wait. A crashed claim-holder is
 *  recovered the way its locks are: a claim naming a dead pid, or an empty one aged out, is
 *  cleared by the next start — the eviction is idempotent, its follow-up the same create race
 *  — and the claim names its holder's pid, so an evicted-and-replaced claim is never mistaken
 *  for the one this start just wrote.
 *
 *  The round's invariant, on every unlink under this discipline: an unlink acts only on the
 *  entry its actor has established — existence taken first (an absent path is nothing to
 *  clear), identity checked (dev+ino, and the bytes still naming the pid that was read: a
 *  replacement is a different inode, and one that reuses the freed inode names its own
 *  writer) — and judging implies holding (the lock is removed only by a start whose claim is
 *  still its own at the moment of removal; a claim is released only against its create's own
 *  entry and pid). Refused by it: a stale eviction removing a rival's fresh claim, and a
 *  straddling judge removing the fresh lock a rival's removal-and-create landed — the two
 *  judges a stolen claim allows. The residual is one syscall pair wide — a compare→unlink gap
 *  sized for a rival's eviction and full create to fit inside — which name-based `unlink`
 *  cannot close; every wider straddle is refused, not raced. */
async function takeOver(path: string): Promise<void> {
  const claim = `${path}.takeover`;
  for (let tries = 0; tries < 8; tries++) {
    let claimed: { dev: number; ino: number };
    try {
      // The claim rides the same atomic create as the lock: a live taker paused in its own
      // create never becomes an aged-out empty claim for a rival to evict.
      claimed = createOwned(claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The eviction reads existence first and unlinks only the entry it read: a NaN read of
      // an already-gone path is no dead taker to clear — the name is simply free, and the
      // create race below arbitrates it.
      const judged = lstatSync(claim, { throwIfNoEntry: false });
      if (judged !== undefined) {
        const taker = readPid(claim);
        if (!Number.isNaN(taker) && alive(taker)) {
          await new Promise((tick) => setTimeout(tick, 20)); // a live claim-holder is mid-section
          return;
        }
        if (Number.isNaN(taker) && young(claim)) {
          await new Promise((tick) => setTimeout(tick, 20)); // its pid is still landing
          return;
        }
        // A dead taker, or an empty claim aged out — and only while the name still holds the
        // entry judged above: an eviction race can free the name and a rival's fresh claim
        // land before this unlink, and a stale evictor must not remove a live claimant.
        if (stillJudged(claim, judged.dev, judged.ino, taker)) {
          try {
            unlinkSync(claim);
          } catch {}
        }
      }
      continue;
    }
    // The claim is this start's — checked, never assumed: an eviction race can put a rival's
    // fresh claim on the name between the create and here, and a start whose claim is gone
    // must not touch the lock on its say-so.
    if (readPid(claim) !== process.pid) {
      await new Promise((tick) => setTimeout(tick, 20));
      return;
    }
    // The judgement is anchored on the entry's existence, taken before the content is read:
    // while this claim is held, a present entry can be neither removed — the other takers are
    // claim-serialized and a release unlinks only its own identity- and pid-bound entry — nor
    // replaced, a rival's create answering EEXIST against it, so an entry present here is
    // exactly the one read and judged below. Taken after the read it would leave a sliver:
    // `young` is false for a path already gone, so a NaN read of absence fell into the unlink,
    // and a rival's create could land the freed name between that read and the unlink — the
    // victim was the rival's fresh live lock, and two starts walked. A live holder is never
    // removed (the check below), a writer whose pid is still on its way keeps its entry, and
    // an absent path is nothing to clear: the claim drops and the create race arbitrates.
    const judged = lstatSync(path, { throwIfNoEntry: false });
    if (judged !== undefined) {
      const holder = readPid(path);
      const live = !Number.isNaN(holder) && alive(holder);
      const landing = Number.isNaN(holder) && young(path);
      if (!live && !landing) {
        // Judging implies holding, and the entry judged is the entry removed or none: the
        // claim is re-read as this start's own at the decision point — a claim since evicted
        // and replaced authorizes nothing — and the lock name must still hold the entry read
        // above, so a judge whose read went stale across a rival's removal-and-fresh-create
        // refuses rather than removing the fresh live lock.
        if (readPid(claim) === process.pid && stillJudged(path, judged.dev, judged.ino, holder)) {
          try {
            unlinkSync(path);
          } catch {}
        }
      }
    }
    // The claim is released the way the lock is released: only the entry this start's own
    // create made — the fd's identity, and the bytes still naming this process — a successor's
    // claim a release race may find on the name is never the releaser's.
    const held = lstatSync(claim, { throwIfNoEntry: false });
    if (held !== undefined && held.dev === claimed.dev && held.ino === claimed.ino && readPid(claim) === process.pid) {
      try {
        unlinkSync(claim);
      } catch {}
    }
    return;
  }
}

/** The start section's lock, `withLock`'s discipline awaited instead of busy-waited: an
 *  exclusive create whose entry appears already holding its pid (`createOwned`), a live holder
 *  waited for until the deadline (answered `timeout`, which the caller refuses), a dead
 *  holder's lock taken over at once — one start at a time, through the claim above — and a
 *  lock that names nothing — a foreign or older writer's empty file, junk — waited on while it
 *  is young, then taken over once it has aged past `LOCK_YOUNG_MS`; this build's own creates
 *  cannot leave such an entry, so the sweep below clears the temps a killed create did leave.
 *  The file's directory is made the way `withLock` makes its own. */
async function acquireStartLock(path: string): Promise<{ kind: 'held'; release: () => void } | { kind: 'timeout' }> {
  mkdirSync(dirname(path), { recursive: true });
  sweepTemps(path);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    // The deadline governs the whole wait, every branch of it: past it the answer is the
    // pinned `locked`, nothing cleared, nothing bound.
    if (Date.now() > deadline) return { kind: 'timeout' };
    try {
      // The entry this create made, named by the fd itself at its creation (`createOwned`,
      // whose fstat is of the fd — the entry itself): the release below unlinks the file at
      // the path only while the path still holds this very entry. The shape that forces it:
      // the entry removed and a second start's lock created in the free name while this holder
      // is still mid-section — an unconditional unlink at release would kill the replacement,
      // alive and still starting. A replacement is a different inode and is skipped: a lock
      // this hold did not create is not this hold's to remove.
      const held = createOwned(path);
      return {
        kind: 'held',
        // `withLock`'s own release, identity-bound: the file this hold created, gone. A dead
        // holder never reaches here — its lock is taken over by the next start — and a live
        // hold is never taken over, so in ordinary operation the entry at the path is this one.
        release: () => {
          try {
            const current = lstatSync(path, { throwIfNoEntry: false });
            if (!current || current.dev !== held.dev || current.ino !== held.ino) return;
            // The entry's pid too: a filesystem can hand a freed inode straight back to the
            // next create at the same name, and then dev+ino alone match a replacement — the
            // ubuntu runner did exactly that (the regression pin's bytes there), while macOS
            // did not. The bytes the entry names are this process's only for this hold's own
            // entry; a replacement names its writer.
            if (readPid(path) !== process.pid) return;
            unlinkSync(path);
          } catch {}
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readPid(path);
      if (!Number.isNaN(holder) && alive(holder)) {
        await new Promise((tick) => setTimeout(tick, LOCK_POLL_MS));
        continue;
      }
      // No live holder: a dead pid, a file too young to name its writer yet, or one already
      // released. Only the first two are worth taking over — a gone file just gets the create
      // retried.
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between the create and the read
      }
      if (Number.isNaN(holder) && age < LOCK_YOUNG_MS) {
        await new Promise((tick) => setTimeout(tick, 20));
        continue;
      }
      await takeOver(path);
    }
  }
}

export async function startBroker(input: StartBrokerInput): Promise<StartBrokerResult> {
  const path = brokerSocket(input.root);
  const lock = await acquireStartLock(`${path}.lock`);
  if (lock.kind === 'timeout') return { kind: 'locked' };
  try {
    // The lock is held through the whole walk, and released — here, on every return and on a
    // throw — the moment the section is over: for a serve, as the listen lands.
    return await startWalk(input, path);
  } finally {
    lock.release();
  }
}

async function startWalk(input: StartBrokerInput, path: string): Promise<StartBrokerResult> {
  // The entry the previous walk saw a stale answer on, awaiting a second sighting.
  let confirmed: { dev: number; ino: number } | undefined;
  for (let walk = 0; walk < START_WALKS; walk++) {
    // The entry, judged by lstat and not by an errno: only a socket belongs to the walk below,
    // and a path holding anything else is refused here, with the pinned bind sentence, untouched
    // — never probed, never unlinked, never bound over. CI's ubuntu runner is why this gate is
    // first (run 37778336251: a regular file answered ECONNREFUSED — Linux's answer where macOS
    // reads ENOTSOCK, myself: bun 1.4.2 + node v26.8.1 — the stale branch then cleared the file
    // and bound, the broker served, and both pinning tests timed out on a refusal that never
    // came). A symlink is "anything else" too: nothing here follows a path someone else planted.
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isSocket()) return { kind: 'bind-failed' };
    const probe = await probeSocket(path);
    if (probe === 'live') return { kind: 'busy' };
    let cleared = false;
    if (probe === 'stale') {
      // The path named a socket nothing listens on. Only that very entry may be cleared: the
      // identity captured at the gate above (dev+ino, lstat and never stat — nothing here
      // follows a path someone else could have planted) must still be the entry here, and it
      // must have answered stale on the previous walk too, with a loop turn in between. An
      // unclean death leaves the file (SIGKILL leaves it, a clean close does not — both
      // pinned) and keeps answering stale; a sibling start's fresh socket answers stale only
      // until its listen lands, so it is never cleared on one sighting. A changed entry is
      // never unlinked — the walk reads it instead, and its own three answers decide.
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (!entry || !current || current.dev !== entry.dev || current.ino !== entry.ino) {
        confirmed = undefined;
        continue;
      }
      if (!confirmed || confirmed.dev !== entry.dev || confirmed.ino !== entry.ino) {
        confirmed = { dev: entry.dev, ino: entry.ino };
        await new Promise<void>((done) => setTimeout(done, STALE_CONFIRM_MS));
        continue;
      }
      confirmed = undefined;
      try {
        unlinkSync(path);
        cleared = true;
      } catch {
        // Gone under us between the identity check and the unlink: walk again rather than bind
        // over an entry that is not the one the probe saw.
        continue;
      }
    } else {
      confirmed = undefined;
    }
    const sockets = new Set<Socket>();
    hostedCommit('node:net.createServer');
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      serve(socket, input);
    });
    const failure = await new Promise<{ code?: string } | null>((done) => {
      server.once('error', (error) => done({ code: (error as NodeJS.ErrnoException).code }));
      server.listen(path, () => done(null));
    });
    if (failure) return { kind: 'bind-failed', code: failure.code };
    // A later server-level error must not take the broker down silently.
    server.on('error', (error) => input.stderr(`team broker: ${error.message}\n`));
    const handle: BrokerHandle = {
      close: () =>
        new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
    };
    return { kind: 'serving', cleared, handle };
  }
  return { kind: 'bind-failed' };
}

type Probe = 'live' | 'stale' | 'none';

/** The three-answer start protocol's read: connect to the path and see which of the three the
 *  answer is. Any error that is not ECONNREFUSED reads as no file; the bind that follows is
 *  what turns that into a concrete answer. */
function probeSocket(path: string): Promise<Probe> {
  return new Promise((done) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      done('live');
    });
    socket.once('error', (error) => {
      socket.destroy();
      done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'none');
    });
  });
}

function serve(socket: Socket, input: StartBrokerInput): void {
  socket.on('error', () => socket.destroy());
  socket.setTimeout(REQUEST_IDLE_MS, () => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const at = buffer.indexOf('\n');
    if (at < 0) {
      if (buffer.length > MAX_REQUEST_BYTES) answer(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
      return;
    }
    const line = buffer.slice(0, at);
    buffer = '';
    socket.pause();
    void dispatch(socket, line, input);
  });
}

async function dispatch(socket: Socket, line: string, input: StartBrokerInput): Promise<void> {
  const request = parseRequest(line);
  if (!request) {
    answer(socket, { ok: false, at: 'caller', message: UNKNOWN_REQUEST });
    return;
  }
  const refusal = authorize(request, input.team, input.root);
  if (refusal) {
    answer(socket, { ok: false, at: 'caller', message: refusal });
    return;
  }
  let result: BrokerReadResult;
  try {
    result = await input.read();
  } catch (error) {
    input.stderr(`team broker: the read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    answer(socket, { ok: false, at: 'read', message: FAILED_READ });
    return;
  }
  if (result.kind === 'failed') {
    input.stderr(`team broker: the read failed: ${result.message}\n`);
    answer(socket, { ok: false, at: 'read', message: FAILED_READ });
    return;
  }
  const value: BrokerAnswer = { ok: true, read: filtered(result.read, input.policy) };
  if (result.notice !== undefined) value.notice = result.notice;
  answer(socket, value);
}

/** The S2 request check: the claimed name must be a declared seat, and the claimed pane the
 *  pane the state records for it in the team's session — the same functions `team next` uses,
 *  asked about the request. */
function authorize(request: BrokerRequest, team: TeamFile, root: string): string | undefined {
  if (!team.seats.some((seat) => seat.name === request.seat)) return notASeat(request.seat);
  const caller: Caller = { kind: 'seat', name: request.seat, pane: request.pane, session: team.session };
  const verdict = callerVerdict(caller, request.seat, standingOf(join(root, '.agents'), team.session, caller));
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  if (verdict.kind !== 'ok') return notASeat(request.seat);
  return undefined;
}

function notASeat(seat: string): string {
  return `only a seat of this team pulls a task; this request names ${seat}`;
}

/** The message id rule (`src/commands/messages.ts`), the same token a task id is. The adapter
 *  judges the source's identifier by presence; the id that crosses — after the transform — must
 *  be a task id, so it is judged here, before a record is accepted or a lease is written. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The policy, applied on this side of the boundary, before the answer is serialized. A record
 *  whose final id is not a task id is refused in the adapter's own shape — the same sentence,
 *  the same keys, the same key order — at the source position of the record it came from, and so
 *  is one whose final id repeats an already-accepted final id: the transform can merge two
 *  distinct source ids into one, and the seat's take must not meet two records under one id
 *  (both adapters enforce this rule on raw ids already). The transform governs a refusal's id
 *  too, by the same rule (the id is the source's own reference). With nothing converted and no
 *  refusal's id transformed, the adapter's refusal list passes through untouched, so a
 *  no-transform run answers byte for byte what it answered before (fix2 P2). */
function filtered(read: TaskRead, policy?: TaskPolicy): TaskRead {
  if (read.kind !== 'records') return read;
  const taken = new Set(read.refusals.map((refusal) => refusal.index));
  const records: TaskRecord[] = [];
  const converted: TaskRefusal[] = [];
  // Only an accepted final id is remembered, the adapter's own rule: a record refused for its
  // own fault reserves nothing.
  const accepted = new Set<string>();
  read.records.forEach((record, position) => {
    const crossed = applyPolicy(record, policy);
    if (!TASK_ID.test(crossed.id)) {
      converted.push({ index: sourceIndex(position + 1, taken), reason: 'its id is not a task id' });
      return;
    }
    if (accepted.has(crossed.id)) {
      converted.push({ index: sourceIndex(position + 1, taken), id: crossed.id, reason: 'its id repeats an earlier record' });
      return;
    }
    accepted.add(crossed.id);
    records.push(crossed);
  });
  const refusals = policy?.transform?.id === 'bare' ? read.refusals.map((refusal) => crossedRefusal(refusal)) : read.refusals;
  if (converted.length === 0 && refusals === read.refusals) return { kind: 'records', records, refusals: read.refusals };
  return { kind: 'records', records, refusals: [...refusals, ...converted].sort((a, b) => a.index - b.index) };
}

/** A refusal's id under the same policy: crossed by the transform, or omitted when the raw id
 *  has no segment to cross — the raw one never rides in a refusal. A refusal with no id is
 *  unchanged. */
function crossedRefusal(refusal: TaskRefusal): TaskRefusal {
  if (refusal.id === undefined) return refusal;
  const id = bareRefusalId(refusal.id);
  if (id === undefined) return { index: refusal.index, reason: refusal.reason };
  return { index: refusal.index, id, reason: refusal.reason };
}

/** The source's 1-based position of its position-th accepted record: the accepted records and
 *  the adapter's refused indexes are two halves of one partition of the source's positions. */
function sourceIndex(position: number, taken: Set<number>): number {
  let index = 0;
  let left = position;
  while (left > 0) {
    index += 1;
    if (!taken.has(index)) left -= 1;
  }
  return index;
}

function answer(socket: Socket, value: BrokerAnswer): void {
  const line = encodeLine(value);
  if (line.length > MAX_ANSWER_BYTES) {
    socket.end(encodeLine({ ok: false, at: 'read', message: FAILED_READ }));
    return;
  }
  socket.end(line);
}

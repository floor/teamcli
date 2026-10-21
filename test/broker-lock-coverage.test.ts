// The broker start lock's empty-entry window, over an independently authored world: one scratch
// clone, one minimal team of my own, one real unix socket per scene. The window is the create's
// empty file — a foreign or older writer's entry, or one a writer killed before it wrote its pid
// left behind — which must be waited on while it is too young to judge and taken over once it has
// aged past the window.
//
// The young wait is proved on a controlled clock, not by sampling a race. The lock is written
// empty, its real mtime is read, and this process's clock is frozen so the entry's age is 999 ms —
// positive, just inside the window. While it is frozen the start must still be pending and the
// entry must still be the very entry that was written — the same dev and inode, the same empty
// bytes — checked over six of the product's poll turns, each seeing the same 999 ms. The clock
// then steps to 1001 ms and the start must recover the entry and serve. The product's own 2000 ms
// whole-wait deadline is measured on this same clock, so freezing it leaves the deadline 1998 ms
// away: the boundary is the only thing that moves, and no host stall can stand in for it. A
// product that took over below 999 ms would change the entry or settle during the hold, so the
// positive pre-boundary age rejects a lowered threshold; the stepped 1001 ms rejects one raised
// past the boundary. The clock is restored in each scene's finally, and the live deadline
// controls below run on the real clock. Each test file is its own process under the runner, so
// the mock never reaches another file.
//
// The actual-main b071 hosted run failed this area. A separate stall harness, kept with its own
// raw output and outside this file, reproduces the failure's shape by stopping the event loop
// across the deadline. The saved hosted log records the failure, not its cause: the reading that a
// load stall carried a poll past the deadline is an inference, not an established history.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { brokerSocket, encodeLine, parseAnswer, type BrokerAnswer, type BrokerRequest } from '../src/broker/protocol.ts';
import { startBroker } from '../src/broker/server.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';

/** The empty-entry window the start protocol documents (`LOCK_YOUNG_MS` in the server). */
const YOUNG_MS = 1000;

/** The whole-wait deadline the start protocol documents (`LOCK_WAIT_MS` in the server). */
const WAIT_MS = 2000;

/** Out of every platform's pid space, so signal 0 answers ESRCH: a holder that cannot be alive. */
const DEAD_PID = 2_147_483_647;

/** My own fixture: one declared seat, recorded on the pane its requests claim. The task source is
 *  a file the broker never reads here — the read is injected — and the session is the project's
 *  own name, which is where `record` below writes the seat's standing. */
const TEAM = `format: 1
project: lockcheck
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
`;

const leadRequest: BrokerRequest = { op: 'read', seat: 'lead', pane: 'p1:1' };

type Identity = { dev: number; ino: number };
type Started = Awaited<ReturnType<typeof startBroker>>;
const openHandles: { close(): Promise<void> }[] = [];
let base: string | undefined;
let root: string;
let team: TeamFile;
let failures: string[];

/** One fresh clone per scene: the fixture team, `.agents` state with the seat on its pane, and
 *  the socket path. The root is a real directory under the runner's temp space; no network, no
 *  credential and no seat's home is read. */
function world(): string {
  base = mkdtempSync(join(tmpdir(), 'team-broker-lock-'));
  root = join(base, 'clone');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'team.yaml'), TEAM);
  const checked = validateTeamFile(TEAM);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  team = checked.team;
  mkdirSync(join(root, '.git'), { recursive: true });
  updateState(agents, (state) => {
    const session = (state.sessions.lockcheck ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'p1:1' };
  });
  failures = [];
  return brokerSocket(root);
}

function starting(path: string): Promise<Started> {
  return startBroker({
    root,
    team,
    read: () => Promise.resolve({ kind: 'read' as const, read: { kind: 'records' as const, records: [{ id: 'x1', title: 't' }], refusals: [] } }),
    stderr: (line) => failures.push(line),
  });
}

function identityOf(path: string): Identity {
  const entry = lstatSync(path);
  return { dev: entry.dev, ino: entry.ino };
}

/** An empty lock and the real mtime its age is measured from; the caller freezes the clock. */
function emptyEntry(lockPath: string): number {
  writeFileSync(lockPath, '');
  return statSync(lockPath).mtimeMs;
}

/** Freeze this process's clock at a chosen age past the entry's real mtime. The product and this
 *  test read the same frozen `Date.now`; the entry's mtime is the real one the filesystem wrote. */
function freezeAtAge(mtime: number, ageMs: number): void {
  setSystemTime(new Date(Math.floor(mtime) + ageMs));
}

/** Bound an await on the real timer, which the frozen clock does not touch: a start that does not
 *  recover inside the budget is a failed scene with its own message, never a hung file. */
function within<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(message)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

/** Hold the frozen 999 ms state and prove it: over six of the product's 20 ms poll turns the entry
 *  must still be the same dev and inode carrying the same empty bytes, the logical age must still
 *  be positive and inside the window, and the start must still be pending. `extra` pins a dead
 *  taker's claim the same way while the lock is held. */
async function holdsYoung(
  lockPath: string,
  entry: Identity,
  mtime: number,
  pending: Promise<Started>,
  extra?: { path: string; entry: Identity; bytes: string },
): Promise<void> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 6; turn++) {
    await new Promise((tick) => setTimeout(tick, 20));
    const age = Date.now() - mtime;
    expect(age).toBeGreaterThan(0);
    expect(age).toBeLessThan(YOUNG_MS);
    const now = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!now) throw new Error('the young empty entry changed before the boundary');
    expect({ dev: now.dev, ino: now.ino }).toEqual(entry);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    if (extra) {
      const held = lstatSync(extra.path, { throwIfNoEntry: false });
      if (!held) throw new Error('the dead taker\'s claim disappeared before the boundary');
      expect({ dev: held.dev, ino: held.ino }).toEqual(extra.entry);
      expect(readFileSync(extra.path, 'utf8')).toBe(extra.bytes);
    }
    if (settled) throw new Error('the start settled inside the young window');
  }
  expect(settled).toBe(false);
}

/** One read over the served socket, bounded by the scene's budget rather than left to hang. */
function ask(path: string, request: BrokerRequest): Promise<BrokerAnswer> {
  return new Promise((done, fail) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error('the served broker did not answer'));
    }, 5000);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(encodeLine(request)));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      clearTimeout(timer);
      const answer = parseAnswer(buffer.slice(0, at));
      socket.destroy();
      if (!answer) fail(new Error(`the answer is not one this build wrote: ${buffer.slice(0, at)}`));
      else done(answer);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/** The private temps the atomic create and the takeover claim write beside the lock. None may
 *  remain at rest: each create removes its own, and a killed one is swept by the next start. */
function temps(path: string): string[] {
  const prefix = `${basename(path)}.`;
  return readdirSync(dirname(path)).filter((name) => name.startsWith(prefix) && name.endsWith('.new'));
}

afterEach(async () => {
  setSystemTime();
  for (const handle of openHandles.splice(0)) await handle.close();
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 30_000);

const scene = (name: string, fn: () => Promise<void>): void => {
  test(name, fn, 60_000);
};

describe('the start lock over an independent world', () => {
  scene('a young empty lock is held at 999 ms, then recovered at 1001 ms and served', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const mtime = emptyEntry(lockPath);
    const entry = identityOf(lockPath);
    try {
      freezeAtAge(mtime, YOUNG_MS - 1);
      const started = starting(path);
      await holdsYoung(lockPath, entry, mtime, started);
      freezeAtAge(mtime, YOUNG_MS + 1);
      const result = await within(started, 5000, 'the start did not recover past the young boundary');
      expect(result.kind).toBe('serving');
      expect(await ask(path, leadRequest)).toMatchObject({ ok: true, read: { kind: 'records' } });
      if (result.kind === 'serving') openHandles.push(result.handle);
      expect(failures).toEqual([]);
      // The start served on its own lock, released when the listen landed; the takeover left no
      // claim and no private temp behind.
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.takeover`)).toBe(false);
      expect(temps(lockPath)).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  scene('a dead holder\'s lock is taken over and serves', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, `${DEAD_PID}\n`);
    const result = await starting(path);
    expect(result.kind).toBe('serving');
    expect(await ask(path, leadRequest)).toMatchObject({ ok: true, read: { kind: 'records' } });
    if (result.kind === 'serving') openHandles.push(result.handle);
    expect(failures).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.takeover`)).toBe(false);
    expect(temps(lockPath)).toEqual([]);
  });

  scene('a dead taker\'s claim is held at 999 ms, then evicted at 1001 ms and its lock recovered', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const claimPath = `${lockPath}.takeover`;
    const mtime = emptyEntry(lockPath);
    const entry = identityOf(lockPath);
    const claimBytes = `${DEAD_PID}\n`;
    writeFileSync(claimPath, claimBytes);
    // The dead taker's claim is already past its own window: on the frozen clock an entry made
    // this instant would stay young forever and the eviction would never be due.
    const longAgo = new Date(Date.now() - 3000);
    utimesSync(claimPath, longAgo, longAgo);
    const claimEntry = identityOf(claimPath);
    try {
      freezeAtAge(mtime, YOUNG_MS - 1);
      const started = starting(path);
      await holdsYoung(lockPath, entry, mtime, started, { path: claimPath, entry: claimEntry, bytes: claimBytes });
      freezeAtAge(mtime, YOUNG_MS + 1);
      const result = await within(started, 5000, 'the dead claim was not evicted past the young boundary');
      expect(result.kind).toBe('serving');
      expect(await ask(path, leadRequest)).toMatchObject({ ok: true, read: { kind: 'records' } });
      if (result.kind === 'serving') openHandles.push(result.handle);
      expect(failures).toEqual([]);
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(claimPath)).toBe(false);
      expect(temps(lockPath)).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  scene('a live holder is never evicted: the deadline refuses and touches nothing', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const bytes = `${process.pid}\n`;
    writeFileSync(lockPath, bytes);
    const before = identityOf(lockPath);
    const began = Date.now();
    const result = await starting(path);
    const waited = Date.now() - began;
    // The product deadline is the assertion, and only its floor: a live holder may never be
    // evicted, so the start must wait the whole deadline out and then fail closed. The ceiling
    // is not asserted — scheduling can only make a loaded machine later, never earlier.
    expect(result).toEqual({ kind: 'locked' });
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 100);
    // The holder's entry is the very entry it was: same dev and inode, same bytes.
    expect(identityOf(lockPath)).toEqual(before);
    expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
    expect(existsSync(`${lockPath}.takeover`)).toBe(false);
    expect(temps(lockPath)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(failures).toEqual([]);
  });

  scene('a live taker\'s claim is never evicted: the empty lock is waited on and refused', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const claimPath = `${lockPath}.takeover`;
    writeFileSync(lockPath, '');
    const bytes = `${process.pid}\n`;
    writeFileSync(claimPath, bytes);
    const lockBefore = identityOf(lockPath);
    const claimBefore = identityOf(claimPath);
    const began = Date.now();
    const result = await starting(path);
    const waited = Date.now() - began;
    expect(result).toEqual({ kind: 'locked' });
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 100);
    // Neither the claim nor the lock it guards moved: the empty entry is not recoverable while a
    // live taker holds the claim, and the deadline is the only way out.
    expect(identityOf(claimPath)).toEqual(claimBefore);
    expect(readFileSync(claimPath, 'utf8')).toBe(bytes);
    expect(identityOf(lockPath)).toEqual(lockBefore);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    expect(temps(lockPath)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(failures).toEqual([]);
  });
});

// The clock-controlled young-boundary scenes, run as their own process by
// `broker-lock-coverage.test.ts` and never collected by the runner: the name matches none of its
// test patterns, and `bun test` in script mode is not how it is started. It is started with the
// runtime's own binary and this path, so the `Date.now` mock it installs lives and dies in this
// process and the runner's clock is never touched. Plain assertions: a failure throws, the
// process exits nonzero with the message, and the parent test reports the captured output.
//
// The boundary: an empty lock's real mtime is pinned to a whole second, then this process's clock
// is frozen at exactly 999 ms past it. Over six 20 ms turns the start must stay pending while the
// entry keeps the same dev, inode and empty bytes and every turn reads exactly 999 ms. The clock
// then steps to exactly 1001 ms and the start must take the entry over, serve and answer a read.
// The product's own 2000 ms deadline is read from this same clock, so at the crossing it is still
// 1998 ms away; only the boundary moves. The second scene pins a dead taker's claim the same way
// and requires its eviction at the crossing.
//
// Each scene prints one CLOCK line per proven state; the parent test asserts those exact lines and
// that this process is not the parent's.
import { setSystemTime } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { brokerSocket, encodeLine, parseAnswer, type BrokerAnswer, type BrokerRequest } from '../../src/broker/protocol.ts';
import { startBroker } from '../../src/broker/server.ts';
import type { TeamFile } from '../../src/file/types.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { emptySession, updateState } from '../../src/state.ts';

/** The empty-entry window the start protocol documents (`LOCK_YOUNG_MS` in the server). */
const YOUNG_MS = 1000;

/** Out of every platform's pid space, so signal 0 answers ESRCH: a holder that cannot be alive. */
const DEAD_PID = 2_147_483_647;

/** My own fixture: one declared seat, recorded on the pane its requests claim. */
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
type World = { base: string; root: string; team: TeamFile; failures: string[]; socketPath: string };

/** One fresh clone: the fixture team, `.agents` state with the seat on its pane, and the socket. */
function makeWorld(): World {
  const base = mkdtempSync(join(tmpdir(), 'team-broker-clock-'));
  const root = join(base, 'clone');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'team.yaml'), TEAM);
  const checked = validateTeamFile(TEAM);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  mkdirSync(join(root, '.git'), { recursive: true });
  updateState(agents, (state) => {
    const session = (state.sessions.lockcheck ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'p1:1' };
  });
  return { base, root, team: checked.team, failures: [], socketPath: brokerSocket(root) };
}

function starting(world: World): Promise<Started> {
  return startBroker({
    root: world.root,
    team: world.team,
    read: () => Promise.resolve({ kind: 'read' as const, read: { kind: 'records' as const, records: [{ id: 'x1', title: 't' }], refusals: [] } }),
    stderr: (line) => world.failures.push(line),
  });
}

function identityOf(path: string): Identity {
  const entry = lstatSync(path);
  return { dev: entry.dev, ino: entry.ino };
}

/** An empty lock with its mtime pinned to a whole second, so the frozen ages are exact. */
function emptyEntry(lockPath: string): number {
  writeFileSync(lockPath, '');
  const exact = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  utimesSync(lockPath, exact, exact);
  return statSync(lockPath).mtimeMs;
}

/** Freeze this process's clock at an exact age past the entry's whole-second mtime. */
function freezeAtAge(mtime: number, ageMs: number): void {
  setSystemTime(new Date(mtime + ageMs));
}

/** Bound an await on the real timer, which the frozen clock does not touch. */
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

/** One read over the served socket, bounded so a scene fails rather than hangs. */
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

/** The private temps the atomic create writes beside the lock; none may remain at rest. */
function temps(path: string): string[] {
  const prefix = `${basename(path)}.`;
  return readdirSync(dirname(path)).filter((name) => name.startsWith(prefix) && name.endsWith('.new'));
}

/** Hold the frozen 999 ms state and prove it over six of the product's 20 ms poll turns: the
 *  entry keeps its dev and inode and its empty bytes, each turn reads exactly 999 ms, and the
 *  start is still pending. `extra` pins a dead taker's claim alongside the lock. */
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
    assert.equal(Date.now() - mtime, YOUNG_MS - 1, 'the frozen age is exactly 999 ms');
    const now = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!now) throw new Error('the young empty entry changed before the boundary');
    assert.deepEqual({ dev: now.dev, ino: now.ino }, entry, 'the entry keeps its dev and inode');
    assert.equal(readFileSync(lockPath, 'utf8'), '', 'the entry keeps its empty bytes');
    if (extra) {
      const held = lstatSync(extra.path, { throwIfNoEntry: false });
      if (!held) throw new Error('the dead taker\'s claim disappeared before the boundary');
      assert.deepEqual({ dev: held.dev, ino: held.ino }, extra.entry, 'the claim keeps its dev and inode');
      assert.equal(readFileSync(extra.path, 'utf8'), extra.bytes, 'the claim keeps its bytes');
    }
    if (settled) throw new Error('the start settled inside the young window');
  }
  assert.equal(settled, false, 'the start is still pending after the held turns');
}

async function youngScene(): Promise<void> {
  const world = makeWorld();
  const lockPath = `${world.socketPath}.lock`;
  const mtime = emptyEntry(lockPath);
  const entry = identityOf(lockPath);
  try {
    freezeAtAge(mtime, YOUNG_MS - 1);
    const started = starting(world);
    await holdsYoung(lockPath, entry, mtime, started);
    console.log(`CLOCK scene=young pid=${process.pid} held age=999 turns=6 pending=1 same-entry=1`);
    freezeAtAge(mtime, YOUNG_MS + 1);
    const result = await within(started, 5000, 'the start did not recover past the young boundary');
    if (result.kind !== 'serving') throw new Error('the start did not serve after the crossing');
    const answer = await ask(world.socketPath, leadRequest);
    if (!answer.ok) throw new Error('the served broker refused the read');
    assert.equal(answer.read.kind, 'records');
    assert.deepEqual(world.failures, []);
    assert.equal(existsSync(lockPath), false, 'the start released its own lock');
    assert.equal(existsSync(`${lockPath}.takeover`), false, 'no claim remains');
    assert.deepEqual(temps(lockPath), []);
    console.log(`CLOCK scene=young crossed age=1001 serving=1 read=1 lock-released=1 claim-absent=1 temps=0`);
    await result.handle.close();
  } finally {
    setSystemTime();
    rmSync(world.base, { recursive: true, force: true });
  }
}

async function claimScene(): Promise<void> {
  const world = makeWorld();
  const lockPath = `${world.socketPath}.lock`;
  const claimPath = `${lockPath}.takeover`;
  const mtime = emptyEntry(lockPath);
  const entry = identityOf(lockPath);
  const claimBytes = `${DEAD_PID}\n`;
  writeFileSync(claimPath, claimBytes);
  const claimEntry = identityOf(claimPath);
  try {
    freezeAtAge(mtime, YOUNG_MS - 1);
    const started = starting(world);
    await holdsYoung(lockPath, entry, mtime, started, { path: claimPath, entry: claimEntry, bytes: claimBytes });
    console.log(`CLOCK scene=claim pid=${process.pid} held age=999 turns=6 pending=1 same-lock=1 same-claim=1`);
    freezeAtAge(mtime, YOUNG_MS + 1);
    const result = await within(started, 5000, 'the dead claim was not evicted past the young boundary');
    if (result.kind !== 'serving') throw new Error('the start did not serve after the claim eviction');
    const answer = await ask(world.socketPath, leadRequest);
    if (!answer.ok) throw new Error('the served broker refused the read');
    assert.equal(answer.read.kind, 'records');
    assert.deepEqual(world.failures, []);
    assert.equal(existsSync(lockPath), false, 'the start released its own lock');
    assert.equal(existsSync(claimPath), false, 'the dead claim is gone');
    assert.deepEqual(temps(lockPath), []);
    console.log(`CLOCK scene=claim crossed age=1001 serving=1 read=1 lock-released=1 claim-released=1 temps=0`);
    await result.handle.close();
  } finally {
    setSystemTime();
    rmSync(world.base, { recursive: true, force: true });
  }
}

try {
  await youngScene();
  await claimScene();
  console.log(`CLOCK done pid=${process.pid} scenes=2`);
} finally {
  setSystemTime();
}

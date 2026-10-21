// The broker start lock's empty-entry window, over an independently authored world: one scratch
// clone, one minimal team of my own, one real unix socket per scene. The window is the create's
// empty file — a foreign or older writer's entry, or one a writer killed before it wrote its pid
// left behind — which must be waited on while it is too young to judge and taken over once it has
// aged past the window. The schedule below is narrowed on purpose: the empty entry's age is set
// 900 ms into the documented 1000 ms window, so only ~100 ms of the young wait remains. That keeps
// the age assertion exact (the entry may not change before its age reaches 1000 ms) while leaving
// the whole-wait deadline nearly two seconds of margin, where a loaded machine's stall cannot
// stand in for the behavior under test. The actual-main b071 macOS read is that hazard's own
// record: a start starved across the deadline answered `locked` before the takeover its wait was
// for, and the scene's wall-clock assertion could not tell that from the product it meant to pin.
// Nothing here asserts an upper bound on real elapsed time; the only deadline asserted is the
// product's own, fail-closed one, and it is asserted as a lower bound (a start cannot answer
// `locked` on a live holder sooner than that deadline) plus the state the refusal must leave.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

/** Watch an empty entry until it first changes (the takeover republishes the name with a pid, or
 *  the unlink and the next create land between reads). Returns the moment the change was seen. */
async function firstChange(path: string, until: number): Promise<number | undefined> {
  while (Date.now() < until) {
    let bytes: string | undefined;
    try {
      bytes = readFileSync(path, 'utf8');
    } catch {
      return Date.now();
    }
    if (bytes !== '') return Date.now();
    await new Promise((tick) => setTimeout(tick, 2));
  }
  return undefined;
}

/** The narrowed schedule: the entry is already 900 ms old, so the young wait that remains is
 *  ~100 ms and the product's whole-wait deadline still has ~1900 ms of margin. */
function agedEmpty(lockPath: string): number {
  const mtime = Date.now() - (YOUNG_MS - 100);
  writeFileSync(lockPath, '');
  utimesSync(lockPath, new Date(mtime), new Date(mtime));
  return mtime;
}

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 30_000);

const scene = (name: string, fn: () => Promise<void>): void => {
  test(name, fn, 60_000);
};

describe('the start lock over an independent world', () => {
  scene('a young empty lock is not taken over before its age window, then serves', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const mtime = agedEmpty(lockPath);
    const started = starting(path);
    const changedAt = await firstChange(lockPath, mtime + WAIT_MS + 3000);
    const result = await started;
    if (changedAt === undefined) throw new Error('the empty lock was never taken over');
    // The behavioral pin: whatever the schedule does, the entry the start judged stayed the empty
    // entry it was until its age passed the documented window. A product that takes over inside
    // the window changes the name at ~899 ms and fails here.
    expect(changedAt - mtime).toBeGreaterThanOrEqual(YOUNG_MS);
    expect(result.kind).toBe('serving');
    expect(await ask(path, leadRequest)).toMatchObject({ ok: true, read: { kind: 'records' } });
    if (result.kind === 'serving') openHandles.push(result.handle);
    expect(failures).toEqual([]);
    // The start served on its own lock, released when the listen landed; the takeover left no
    // claim and no private temp behind.
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.takeover`)).toBe(false);
    expect(temps(lockPath)).toEqual([]);
  });

  scene('a dead holder\'s lock is taken over without a young wait', async () => {
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

  scene('a dead taker\'s claim is evicted and its empty lock recovered after the window', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const claimPath = `${lockPath}.takeover`;
    const mtime = agedEmpty(lockPath);
    writeFileSync(claimPath, `${DEAD_PID}\n`);
    const started = starting(path);
    const changedAt = await firstChange(lockPath, mtime + WAIT_MS + 3000);
    const result = await started;
    if (changedAt === undefined) throw new Error('the empty lock was never taken over');
    expect(changedAt - mtime).toBeGreaterThanOrEqual(YOUNG_MS);
    expect(result.kind).toBe('serving');
    expect(await ask(path, leadRequest)).toMatchObject({ ok: true, read: { kind: 'records' } });
    if (result.kind === 'serving') openHandles.push(result.handle);
    expect(failures).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect(temps(lockPath)).toEqual([]);
  });

  scene('a live holder is never evicted: the deadline refuses and touches nothing', async () => {
    const path = world();
    const lockPath = `${path}.lock`;
    const bytes = `${process.pid}\n`;
    writeFileSync(lockPath, bytes);
    const began = Date.now();
    const result = await starting(path);
    const waited = Date.now() - began;
    // The product deadline is the assertion, and only its floor: a live holder may never be
    // evicted, so the start must wait the whole deadline out and then fail closed. The ceiling
    // is not asserted — scheduling can only make a loaded machine later, never earlier.
    expect(result).toEqual({ kind: 'locked' });
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 100);
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
    agedEmpty(lockPath);
    const bytes = `${process.pid}\n`;
    writeFileSync(claimPath, bytes);
    const began = Date.now();
    const result = await starting(path);
    const waited = Date.now() - began;
    expect(result).toEqual({ kind: 'locked' });
    expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 100);
    // Neither the claim nor the lock it guards moved: the empty entry is not recoverable while a
    // live taker holds the claim, and the deadline is the only way out.
    expect(readFileSync(claimPath, 'utf8')).toBe(bytes);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    expect(temps(lockPath)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(failures).toEqual([]);
  });
});

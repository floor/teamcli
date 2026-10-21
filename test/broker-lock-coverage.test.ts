// The broker start lock's empty-entry window, over an independently authored world: one scratch
// clone, one minimal team of my own, one real unix socket per scene. The window is the create's
// empty file — a foreign or older writer's entry, or one a writer killed before it wrote its pid
// left behind — which must be waited on while it is too young to judge and taken over once it has
// aged past the window.
//
// The clock-controlled boundary scenes run in a child process of their own
// (`fixtures/broker-lock-clock-child.ts`), started below with this runtime's own binary and that
// path. The runner does not give each test file a process of its own — files share one process
// and its globals — so a clock mock installed here would change `Date.now` for everything else in
// the run. The child installs the mock itself: the empty entry's mtime is pinned to a whole
// second, the clock is frozen at exactly 999 ms past it, six of the product's 20 ms poll turns
// must find the start pending and the entry the same dev, inode and empty bytes at exactly
// 999 ms, then the clock steps to exactly 1001 ms and the start must take the entry over, serve
// and answer a read. The product's own 2000 ms whole-wait deadline is read from that same clock,
// so at the crossing it is still 1998 ms away: the boundary is the only thing that moves, and no
// host stall can stand in for it. The child restores the clock and exits. This file asserts its
// exact CLOCK lines, that its pid is not this process's, and that this process's clock still
// advanced with real time across the spawn, so the mock stayed in the child.
//
// The scenes that follow run in this process on the real clock: a dead holder's lock is recovered,
// and a live holder and a live taker claim each drive the product's own 2000 ms deadline to its
// fail-closed `locked` while their entries keep the same dev, inode and bytes.
//
// The actual-main b071 hosted run failed this area. A separate stall harness, kept with its own
// raw output and outside this file, reproduces the failure's shape by stopping the event loop
// across the deadline. The saved hosted log records the failure, not its cause: the reading that a
// load stall carried a poll past the deadline is an inference, not an established history.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerSocket, encodeLine, parseAnswer, type BrokerAnswer, type BrokerRequest } from '../src/broker/protocol.ts';
import { startBroker } from '../src/broker/server.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';

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
  for (const handle of openHandles.splice(0)) await handle.close();
  if (base) rmSync(base, { recursive: true, force: true });
  base = undefined;
}, 30_000);

const scene = (name: string, fn: () => Promise<void>): void => {
  test(name, fn, 60_000);
};

describe('the start lock over an independent world', () => {
  scene('the controlled young boundary runs in its own process', async () => {
    const childPath = fileURLToPath(new URL('./fixtures/broker-lock-clock-child.ts', import.meta.url));
    const child = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000 });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    if (child.status !== 0) throw new Error(`the clock child failed (status ${child.status}): ${output}`);
    const pid = /CLOCK scene=young pid=(\d+)/.exec(output)?.[1];
    if (pid === undefined) throw new Error(`the clock child printed no pid line: ${output}`);
    expect(Number(pid)).not.toBe(process.pid);
    expect(output).toContain(`CLOCK scene=young pid=${pid} held age=999 turns=6 pending=1 same-entry=1`);
    expect(output).toContain('CLOCK scene=young crossed age=1001 serving=1 read=1 lock-released=1 claim-absent=1 temps=0');
    expect(output).toContain(`CLOCK scene=claim pid=${pid} held age=999 turns=6 pending=1 same-lock=1 same-claim=1`);
    expect(output).toContain('CLOCK scene=claim crossed age=1001 serving=1 read=1 lock-released=1 claim-released=1 temps=0');
    expect(output).toContain(`CLOCK done pid=${pid} scenes=2`);
    // The mock stayed in the child: this process's clock still advances with real time.
    const began = Date.now();
    await new Promise((tick) => setTimeout(tick, 60));
    const advanced = Date.now() - began;
    expect(advanced).toBeGreaterThanOrEqual(40);
    expect(advanced).toBeLessThan(10_000);
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

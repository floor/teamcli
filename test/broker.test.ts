// The broker boundary over a real unix socket in a scratch directory: the protocol's strict
// parsers, the three-answer start protocol, the S2 request check, the per-field policy, and the
// seat's client outcomes. The credential is a deliberate non-real string and the tracker is an
// answer map, the release world's shape — no test here reads the Keychain or opens a network
// connection. The child that leaves a stale socket is killed with SIGKILL, the probe's own pin:
// a clean close removes the file, a kill leaves it (probe run under bun 1.4.2 and node v26.8.1:
// afterBind true, afterClose false on both).
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { runBroker, type BrokerSources } from '../src/commands/broker.ts';
import { askBroker, BROKER_DEADLINE_MS, DEADLINE, NOT_RUNNING, WRONG_ANSWER, type BrokerOutcome } from '../src/broker/client.ts';
import { applyPolicy, type TaskPolicy } from '../src/broker/policy.ts';
import { brokerSocket, encodeLine, MAX_REQUEST_BYTES, parseAnswer, parseRequest, type BrokerAnswer, type BrokerRequest } from '../src/broker/protocol.ts';
import { startBroker, type BrokerReadResult, type BrokerReader } from '../src/broker/server.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Attempt, Fetch, RequestOptions } from '../src/release/http.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { TaskRecord, TaskRefusal } from '../src/tasks/adapter.ts';
import { testIo } from './helpers.ts';

const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const KEY = 'test-key-not-real';

const LINEAR = `format: 1
project: acme
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
  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "1"
    launch: codex
tasks:
  source: linear
  linear:
    project: ${PROJECT}
    keychainService: team.linear.acme
`;

const FILE_SOURCE = LINEAR.replace('  source: linear', '  source: file').replace(/  linear:\n    project: .*\n    keychainService: .*\n/, '  path: .agents/tasks.yaml\n');

const leadSeat: BrokerRequest = { op: 'read', seat: 'lead', pane: 'w1:p1' };
const workerSeat: BrokerRequest = { op: 'read', seat: 'worker', pane: 'w2:p1' };

let base: string;
let root: string;
let home: string;

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

const openHandles: { close(): Promise<void> }[] = [];

/** A clone with the linear fixture: git-initialized, the team file in `.agents`, its own home. */
function project(text = LINEAR): void {
  if (base) rmSync(base, { recursive: true, force: true });
  base = mkdtempSync(join(tmpdir(), 'team-broker-'));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

/** The state the S2 check reads: both seats recorded, on their panes. */
function record(): void {
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
}

function teamOf(text = LINEAR): TeamFile {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the fixture does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

function records(list: TaskRecord[], refusals: TaskRefusal[] = []): BrokerReadResult {
  return { kind: 'read', read: { kind: 'records', records: list, refusals } };
}

async function serving(read: BrokerReader, policy?: TaskPolicy): Promise<{ handle: { close(): Promise<void> }; stderr: string[] }> {
  const lines: string[] = [];
  const started = await startBroker({
    root,
    team: teamOf(),
    read,
    ...(policy ? { policy } : {}),
    stderr: (text) => lines.push(text),
  });
  if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
  openHandles.push(started.handle);
  return { handle: started.handle, stderr: lines };
}

function ask(request: BrokerRequest, deadlineMs?: number): Promise<BrokerOutcome> {
  return askBroker(root, request, deadlineMs === undefined ? {} : { deadlineMs });
}

/** One raw request line over the socket, with the answer line back — the probe reads the wire
 *  the way a foreign caller would, without the client's parsers. */
function send(line: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(brokerSocket(root));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => {
      socket.destroy();
      fail(new Error('the broker did not answer'));
    });
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      socket.destroy();
      done(buffer.slice(0, at));
    });
    socket.once('error', fail);
  });
}

/** A plain listener on the clone's socket path, for the answers the client must fail safe on.
 *  It is closed with its connections: bun's node:net server has no `closeAllConnections`. */
async function rawServer(handler: (socket: Socket) => void): Promise<() => Promise<void>> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    handler(socket);
  });
  await new Promise<void>((done) => server.listen(brokerSocket(root), () => done()));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) return;
    await new Promise((tick) => setTimeout(tick, 10));
  }
  throw new Error('the condition never held');
}

/** A socket file with no listener behind it, left the way an unclean death leaves one: a child
 *  binds it and SIGKILLs itself. The recon pinned this under bun and node: the file stays, and a
 *  connect to it answers ECONNREFUSED. */
function leaveStaleSocket(at: string = brokerSocket(root)): void {
  const script = join(base, 'stale.mjs');
  writeFileSync(script, "import net from 'node:net';\nconst server = net.createServer();\nserver.listen(process.argv[2], () => process.kill(process.pid, 'SIGKILL'));\n");
  try {
    execFileSync(process.execPath, [script, at], { stdio: 'ignore' });
  } catch (error) {
    if ((error as { signal?: string }).signal !== 'SIGKILL') throw error;
  }
}

/** The fixture child the start-serialization pin runs: the real start path in a real process,
 *  with its listen call deliberately held back a fixed number of milliseconds. The hold sits
 *  inside a patched `net.Server.prototype.listen`, a busy-wait before the real call — measured
 *  before it was written into a pin (mine: node v26.8.1 and bun 1.4.2, one observer process
 *  polling the path every 100ms while the holder ran an 800ms hold: "0ms patched listen
 *  entered, exists=false / 800ms the delay is over, exists=false / 801ms the listen call
 *  returned, exists=true" — identical timelines, the path clean for the whole hold, so a
 *  second start arriving in the window reads no entry and binds first). The hold is before the
 *  listen call on purpose: there is no JS-holdable window after it — the syscall lands with
 *  the file created and the callback within the same beat even with the loop blocked (the same
 *  probe), and a genuinely bound-not-listening socket answers ECONNREFUSED on macOS exactly as
 *  on Linux (mine: a python bind, 3s before listen, connects refused throughout). What a
 *  serialized start must prevent is a second start taking a path this one is still on its way
 *  to; a second start arriving after the file exists reads a live socket and is refused busy
 *  either way.
 *  It prints `ready` with a raw write — out before the hold can block the loop — then one JSON
 *  line with the outcome. A serving child stays alive; anything else runs out of work and
 *  exits on its own. */
const FIXTURE = `import { lstatSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const [root, delay, repo] = process.argv.slice(2);
const real = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const end = Date.now() + Number(delay);
  while (Date.now() < end) {}
  return real.apply(this, args);
};
const at = (p) => pathToFileURL(join(repo, p)).href;
const { validateTeamFile } = await import(at('src/file/validate.ts'));
const { startBroker } = await import(at('src/broker/server.ts'));
const { brokerSocket } = await import(at('src/broker/protocol.ts'));
const checked = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
if (!checked.ok) {
  writeSync(2, 'the fixture team file does not validate\\n');
  process.exit(2);
}
writeSync(1, 'ready\\n');
const result = await startBroker({
  root,
  team: checked.team,
  read: async () => ({ kind: 'read', read: { kind: 'records', records: [{ id: 'm1', title: 't' }], refusals: [] } }),
  stderr: (text) => writeSync(2, text),
});
let entry;
try { entry = lstatSync(brokerSocket(root)); } catch {}
writeSync(1, JSON.stringify({
  kind: result.kind,
  cleared: result.kind === 'serving' ? result.cleared : false,
  dev: entry?.dev,
  ino: entry?.ino,
}) + '\\n');
`;

type FixtureOutcome = { kind: 'serving' | 'busy' | 'bind-failed' | 'locked'; cleared: boolean; dev: number | undefined; ino: number | undefined; ms?: number };

/** The burst fixture: the same real start path in a real process, but released together with
 *  its siblings — it says `ready`, then waits for the go file, so the test can hold every
 *  starter in the wait and write the go file only once all of them are about to start. One
 *  JSON line with the outcome and the elapsed is the whole answer. Used for the rounds where
 *  a crash left a dead start's lock (and a corpse socket) behind and several starts arrive at
 *  once. */
const BURST_FIXTURE = `import { existsSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, go, repo] = process.argv.slice(2);
const at = (p) => pathToFileURL(join(repo, p)).href;
const { validateTeamFile } = await import(at('src/file/validate.ts'));
const { startBroker } = await import(at('src/broker/server.ts'));
const checked = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
if (!checked.ok) {
  writeSync(2, 'the fixture team file does not validate\\n');
  process.exit(2);
}
writeSync(1, 'ready\\n');
while (!existsSync(go)) await new Promise((tick) => setTimeout(tick, 1));
const started = Date.now();
const result = await startBroker({
  root,
  team: checked.team,
  read: async () => ({ kind: 'read', read: { kind: 'records', records: [{ id: 'm1', title: 't' }], refusals: [] } }),
  stderr: (text) => writeSync(2, text),
});
writeSync(1, JSON.stringify({ kind: result.kind, cleared: result.kind === 'serving' ? result.cleared : false, ms: Date.now() - started }) + '\\n');
`;

/** The gap fixture: the real start path in a real process, with the writer itself held inside
 *  its own create. The hold rides a redefined `process.pid` getter, installed after the imports
 *  and before `ready`: in `server.ts` the first read of `process.pid` after arming is the pid
 *  written into the lock or the claim, so the getter's busy-wait lands exactly in the
 *  create→write gap — the interval the finding is about. The seam is measured, never assumed:
 *  patching a named `node:fs` import from the child could not work (bun 1.4.2 binds named
 *  imports to the function itself; a probe router process recorded `openHits= 0 writeHits= 0`
 *  through a patched default import), while the getter fires on the first read and every later
 *  read answers the real pid (probe: `getter-installed ok`, `paused`, `read-again=true`). The
 *  hold is 1500ms: past `LOCK_YOUNG_MS` (1000), so an aged empty entry can be taken over while
 *  the writer is still alive — the finding's exact shape — and under `LOCK_WAIT_MS` (2000), so
 *  the writer resumes into its own section and answers, rather than timing out on its own
 *  artificial hold. It says `ready`, then `paused` with a raw write — out before the busy-wait
 *  can block the loop — then one JSON line with the outcome. */
const GAP_FIXTURE = `import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, gap, repo] = process.argv.slice(2);
const at = (p) => pathToFileURL(join(repo, p)).href;
const { validateTeamFile } = await import(at('src/file/validate.ts'));
const { startBroker } = await import(at('src/broker/server.ts'));
const checked = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
if (!checked.ok) {
  writeSync(2, 'the fixture team file does not validate\\n');
  process.exit(2);
}
const real = process.pid;
let armed = true;
Object.defineProperty(process, 'pid', {
  get() {
    if (armed) {
      armed = false;
      writeSync(1, 'paused\\n');
      const end = Date.now() + Number(gap);
      while (Date.now() < end) {}
    }
    return real;
  },
});
writeSync(1, 'ready\\n');
const result = await startBroker({
  root,
  team: checked.team,
  read: async () => ({ kind: 'read', read: { kind: 'records', records: [{ id: 'm1', title: 't' }], refusals: [] } }),
  stderr: (text) => writeSync(2, text),
});
writeSync(1, JSON.stringify({ kind: result.kind, cleared: result.kind === 'serving' ? result.cleared : false }) + '\\n');
`;

type FixtureChild = {
  pid: number | undefined;
  said: string[];
  outcome: FixtureOutcome | undefined;
  failure: string | undefined;
  /** Resolves on the child's `exit` — after it is reaped, its pid is gone. */
  exited: Promise<void>;
  kill: () => void;
};

/** One fixture child, spawned with its hold; its stdout is read line by line, its stderr kept
 *  for the failure message. `kill` leaves the corpse exactly as any SIGKILL does. */
function spawnFixture(script: string, args: string[]): FixtureChild {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exitedDone: () => void = () => {};
  const exited = new Promise<void>((done) => (exitedDone = done));
  child.once('exit', () => exitedDone());
  const fixture: FixtureChild = { pid: child.pid, said: [], outcome: undefined, failure: undefined, exited, kill: () => child.kill('SIGKILL') };
  let buffer = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      fixture.said.push(line);
      if (line.startsWith('{')) fixture.outcome = JSON.parse(line) as FixtureOutcome;
      else if (line !== 'ready' && line !== 'paused') fixture.failure = `the fixture said: ${line}`;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (err += chunk));
  child.once('close', (code, signal) => {
    fixture.failure ??= `the fixture exited before an outcome (${code ?? signal})${err ? `: ${err.trim()}` : ''}`;
  });
  return fixture;
}

function startFixture(delayMs: number): FixtureChild {
  const script = join(base, `start-${delayMs}.mjs`);
  writeFileSync(script, FIXTURE);
  return spawnFixture(script, [root, String(delayMs), join(import.meta.dir, '..')]);
}

/** One burst child for a per-round root: it waits for that round's go file. */
function burstFixture(roundRoot: string, go: string): FixtureChild {
  const script = join(base, 'burst.mjs');
  writeFileSync(script, BURST_FIXTURE);
  return spawnFixture(script, [roundRoot, go, join(import.meta.dir, '..')]);
}

/** One gap child: a real start whose writer holds inside its own create for `gapMs`. */
function gapFixture(gapMs: number): FixtureChild {
  const script = join(base, `gap-${gapMs}.mjs`);
  writeFileSync(script, GAP_FIXTURE);
  return spawnFixture(script, [root, String(gapMs), join(import.meta.dir, '..')]);
}

/** The claim-burst fixture: the burst fixture plus the instrumented claim lane — `unlinkSync`
 *  wrapped so every unlink of a `*.lock` / `*.lock.takeover` path whose bytes named a live pid
 *  other than the unlinker is logged, one buffered `EVENTS` line at the outcome, never a write
 *  mid-race (the delta-2 lab's `UNLINK_LIVE` form, the finding's own instrument). The wrap
 *  rides the first route that proves itself (`A1`/`A2`: a `bun:test`
 *  `mock.module('node:fs', …)` registered before the server import, as a copy or a prototype;
 *  `M`: the namespace object; `R`: the require object): a route is taken only after a canary
 *  import's own call fires the wrap — bun 1.4.2 binds a named import to the function itself,
 *  so a patch that never fires must never be believed. The `touched` counter is the wire's
 *  positive control: the winning start's takeover unlinks the dead lock every round, so
 *  `touched ≥ rounds` proves the wrap sits in the server's call path and an events=0 is a
 *  measured zero, not a dead wire. */
const CLAIM_BURST_FIXTURE = `import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, root, go, repo] = process.argv.slice(2);
const DETECT = mode === 'selftest' || process.env.DS_DETECT === '1';
const ROUTE = process.env.DS_ROUTE || 'A1';
const PARENT = Number(process.env.DS_PARENT || '0');
const events = [];
let touched = 0;
let wireErr = null;

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } }
function wrap(orig) {
  return function (p) {
    try {
      const s = String(p);
      if (/\\.lock$|\\.lock\\.takeover$/.test(s)) {
        touched += 1;
        let data = null;
        try { data = readFileSync(s, 'utf8'); } catch {}
        const pid = data === null ? NaN : Number.parseInt(data.trim(), 10);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
          events.push({ path: s, pid, me: process.pid, bytes: data });
        }
      }
    } catch {}
    return orig.apply(this, arguments);
  };
}
const canarySrc = "import { unlinkSync } from 'node:fs';\\nexport function go(p) { unlinkSync(p); }\\n";
async function install() {
  const det = mkdtempSync(join(tmpdir(), 'team-claim-det-'));
  const canary = join(det, 'canary-' + ROUTE + '.mjs');
  writeFileSync(canary, canarySrc);
  if (ROUTE === 'A1' || ROUTE === 'A2') {
    const { mock } = await import('bun:test');
    const fs = await import('node:fs');
    const m = ROUTE === 'A1' ? Object.assign({}, fs) : Object.create(fs);
    m.unlinkSync = wrap(fs.unlinkSync);
    mock.module('node:fs', () => m);
  } else if (ROUTE === 'M') {
    const fs = await import('node:fs');
    fs.unlinkSync = wrap(fs.unlinkSync);
  } else if (ROUTE === 'R') {
    const req = createRequire(import.meta.url);
    const rfs = req('node:fs');
    rfs.unlinkSync = wrap(rfs.unlinkSync);
  } else {
    throw new Error('unknown route ' + ROUTE);
  }
  return canary;
}
if (DETECT) {
  try {
    const canary = await install();
    const m = await import(pathToFileURL(canary).href);
    const dummy = join(dirname(canary), 'selftest.lock');
    writeFileSync(dummy, String(PARENT));
    const before = events.length;
    m.go(dummy);
    const fires = events.length - before;
    if (mode === 'selftest') {
      writeSync(1, JSON.stringify({ selftest: fires > 0 ? 'ok' : 'fail', route: ROUTE, fires, touched }) + '\\n');
      process.exit(fires > 0 ? 0 : 4);
    }
    writeSync(1, JSON.stringify({ event: 'DET', route: ROUTE, fires, errs: wireErr }) + '\\n');
    if (fires === 0) { writeSync(1, JSON.stringify({ event: 'DET-BROKEN', route: ROUTE }) + '\\n'); }
  } catch (e) {
    wireErr = String((e && e.message) || e);
    if (mode === 'selftest') {
      writeSync(1, JSON.stringify({ selftest: 'fail', route: ROUTE, fires: 0, errs: wireErr }) + '\\n');
      process.exit(4);
    }
    writeSync(1, JSON.stringify({ event: 'DET-BROKEN', route: ROUTE, errs: wireErr }) + '\\n');
  }
}
if (mode === 'selftest') {
  writeSync(1, JSON.stringify({ selftest: 'fail', route: ROUTE, fires: 0, errs: 'no wrap fired' }) + '\\n');
  process.exit(4);
}
events.length = 0; // the canary's own unlink is the wire's test, not a round event
touched = 0;
const at = (p) => pathToFileURL(join(repo, p)).href;
const { validateTeamFile } = await import(at('src/file/validate.ts'));
const srv = await import(at('src/broker/server.ts'));
const checked = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
if (!checked.ok) { writeSync(2, 'the fixture team file does not validate\\n'); process.exit(2); }
writeSync(1, 'ready\\n');
while (!existsSync(go)) await new Promise((tick) => setTimeout(tick, 1));
// The stalled-broker stub: a start path that sits this long before it answers, standing in for
// a broker that regressed. Only the scene proving a stalled release fails sets it; a round
// never counts it as broker work, it is the broker's work made slow.
const stallMs = Number(process.env.DS_SLOW_STALL_MS || '0');
if (stallMs > 0) await new Promise((tick) => setTimeout(tick, stallMs));
const t0 = Date.now();
const result = await srv.startBroker({
  root,
  team: checked.team,
  read: async () => ({ kind: 'read', read: { kind: 'records', records: [{ id: 'm1', title: 't' }], refusals: [] } }),
  stderr: (text) => writeSync(2, text),
});
const ms = Date.now() - t0;
if (events.length > 0 || touched > 0) {
  writeSync(1, JSON.stringify({ event: 'EVENTS', list: events, touched }) + '\\n');
}
writeSync(1, JSON.stringify({ kind: result.kind, cleared: result.kind === 'serving' ? result.cleared : false, ms, pid: process.pid }) + '\\n');
`;

type ClaimEvent = { path: string; pid: number; me: number; bytes: string };
type ClaimChild = FixtureChild & {
  claim: () => { list: ClaimEvent[]; touched: number };
  detBroken: () => boolean;
  selftest: () => string | undefined;
};

/** One claim-burst child; `extraEnv` carries the detector route and the parent pid the
 *  selftest's planted lock names as its live writer. The detector's own lines are not the
 *  fixture's answers: only a line that is neither `ready` nor JSON fails it, and only a line
 *  with a `kind` is its outcome. */
function spawnClaimKid(args: string[], extraEnv: Record<string, string>): ClaimChild {
  const script = join(base, 'claim-burst.mjs');
  writeFileSync(script, CLAIM_BURST_FIXTURE);
  const proc = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  let list: ClaimEvent[] = [];
  let touched = 0;
  let broken = false;
  let selftestLine: string | undefined;
  const fixture: ClaimChild = {
    pid: proc.pid,
    said: [],
    outcome: undefined,
    failure: undefined,
    exited: new Promise<void>((done) => proc.once('exit', () => done())),
    kill: () => proc.kill('SIGKILL'),
    claim: () => ({ list, touched }),
    detBroken: () => broken,
    selftest: () => selftestLine,
  };
  let buffer = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      fixture.said.push(line);
      if (!line.startsWith('{')) {
        if (line !== 'ready') fixture.failure = `the fixture said: ${line}`;
        continue;
      }
      const parsed = JSON.parse(line) as { event?: string; selftest?: string; list?: ClaimEvent[]; touched?: number; kind?: string; cleared?: boolean };
      if (parsed.event === 'EVENTS') { list = parsed.list ?? []; touched = parsed.touched ?? 0; }
      else if (parsed.event === 'DET-BROKEN') broken = true;
      else if (parsed.selftest !== undefined) selftestLine = line;
      else if (parsed.kind !== undefined) fixture.outcome = parsed as FixtureOutcome;
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => (err += chunk));
  proc.once('close', (code, signal) => {
    fixture.failure ??= `the fixture exited before an outcome (${code ?? signal})${err ? `: ${err.trim()}` : ''}`;
  });
  return fixture;
}

/** The detector's selftest for one route: a child that installs the wrap, fires it through a
 *  canary import's own call, and answers `ok` only when the event was logged. */
async function claimSelftest(candidate: string): Promise<{ ok: boolean; line: string }> {
  const kid = spawnClaimKid(['selftest', 'x', 'x', join(import.meta.dir, '..')], { DS_ROUTE: candidate, DS_PARENT: String(process.pid) });
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const verdict = kid.selftest();
    if (verdict !== undefined) { kid.kill(); await kid.exited; return { ok: verdict.includes('"ok"'), line: verdict }; }
    await new Promise((tick) => setTimeout(tick, 20));
  }
  kid.kill();
  await kid.exited;
  return { ok: false, line: 'no selftest line' };
}

/** The claim pin's rounds: the pre-registered 413 (ceil(ln 0.01 / ln(1 − p̂)) on the pooled
 *  1.111%/round) — never resized after seeing a result. */
const CLAIM_ROUNDS = 413;
/** The pin's own budget floor, from CI's ≈0.23 s/round pace. */
const CLAIM_STEP_FLOOR_MS = 10_000;
const CLAIM_RUN_FLOOR_MS = 300_000;
const CLAIM_RUN_CAP_MS = 2_400_000;
/** The outcomes step is fixed, never scaled: released together on a dead start's lock, the six
 *  starts' whole release path measured 130–260 ms at load 9–14, so ten seconds is two orders of
 *  magnitude of headroom — and a broker that regressed must fail it, not inherit a budget its
 *  own slowdown inflated. */
const CLAIM_OUTCOMES_STEP_MS = 10_000;
/** The cumulative outcomes wall the run may spend: 413 rounds × 2 s. The measured per-round
 *  window is 130–260 ms even at load 9–14, so this catches a broker that stays just under the
 *  per-round step round after round, without failing a merely loaded machine. */
const CLAIM_OUTCOMES_TOTAL_MS = CLAIM_ROUNDS * 2_000;

/** The budgets, computed from the BOOT pace alone — round start → every start's `ready`, plus
 *  its reap — never from the release window where `startBroker` runs: a broker that slowed
 *  would inflate a pace that included it and scale the very budget meant to catch it. The step
 *  deadline is twice the boot pace (never under the pin's original ten seconds); the run budget
 *  is twice the extrapolated 413-round total, floored at the pin's original five minutes and
 *  capped at forty. */
function claimBudgets(bootPaceMs: number): { stepMs: number; runBudgetMs: number } {
  return {
    stepMs: Math.max(CLAIM_STEP_FLOOR_MS, Math.ceil(bootPaceMs * 2)),
    runBudgetMs: Math.min(CLAIM_RUN_CAP_MS, Math.max(CLAIM_RUN_FLOOR_MS, Math.ceil(bootPaceMs * CLAIM_ROUNDS * 2))),
  };
}

/** The two burst scenes' budgets, from the same BOOT pace the claim lane uses — round start →
 *  every start's `ready`, plus its reap — never from the release window, so a regressed broker
 *  cannot inflate the budget meant to catch it. The ready step is twice the pace, never under
 *  the pin's ten seconds and never past its two-minute cap; the release step stays fixed at
 *  ten seconds; the run budget is twice the extrapolated total, floored and capped. The cap's
 *  margin is not decoration: bun 1.4.2 does not cancel a timed-out test body, so a body that
 *  outlived its test runs on against the fixture world the after-each has already removed, and
 *  its later rejection surfaces as an unhandled error between tests (probe on bun 1.4.2: a
 *  100 ms test whose body awaits a waiter that throws at 650 ms, with a later test holding the
 *  runner open, prints "# Unhandled error between tests"; an internal catch on the awaited
 *  waiter changes nothing — the rejection reported is the body's own). Four starts: fifteen
 *  minutes of run inside a thirty-minute test; six: forty inside fifty, the claim lane's own
 *  margins. Each body therefore ends inside its timeout by construction, and a machine that
 *  cannot finish stops first, naming its round and step — never at the timeout with no name. */
const BURST_STEP_FLOOR_MS = 10_000;
const BURST_STEP_CAP_MS = 120_000;
const BURST_OUTCOMES_STEP_MS = 10_000;
const BURST4_RUN_FLOOR_MS = 120_000;
const BURST4_RUN_CAP_MS = 900_000;
const BURST6_RUN_FLOOR_MS = 300_000;
const BURST6_RUN_CAP_MS = 2_400_000;

function burstBudgets(rounds: number, bootPaceMs: number, runFloorMs: number, runCapMs: number): { stepMs: number; runBudgetMs: number } {
  return {
    stepMs: Math.min(BURST_STEP_CAP_MS, Math.max(BURST_STEP_FLOOR_MS, Math.ceil(bootPaceMs * 2))),
    runBudgetMs: Math.min(runCapMs, Math.max(runFloorMs, Math.ceil(bootPaceMs * rounds * 2))),
  };
}

/** One step of a round, bounded by its own budget: a step that runs out kills and reaps its
 *  round's starts at once and fails naming the step and the budget it overran, never the child
 *  it waited on. The label carries the scene's own name, so a failure names where it happened. */
async function withinStep<T>(label: string, roundKids: FixtureChild[], budgetMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`step "${label}" outlived its ${budgetMs} ms budget; its starts were killed and reaped`)),
      budgetMs,
    );
  });
  try {
    return await Promise.race([fn(), late]);
  } catch (error) {
    for (const kid of roundKids) kid.kill();
    await Promise.all(roundKids.map((kid) => kid.exited));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** While a writer holds inside its create, watch one path: every sighting of the file present
 *  with no positive pid in it is counted, first and last with the elapsed since the watch began.
 *  A path that is absent is not a sighting — absence is the one state both protocols agree on,
 *  the pre-create and the post-release state. The counters are the pin's byte: a create that
 *  publishes ownership atomically never shows the shared name without its writer, while the
 *  base head's `openSync(path,'wx')`-then-write state exists — empty — for the whole hold. */
function watchNoPid(path: string): { stop: () => Promise<void>; empty: { count: number; firstMs: number; lastMs: number } } {
  const empty = { count: 0, firstMs: 0, lastMs: 0 };
  const t0 = Date.now();
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        const value = Number(readFileSync(path, 'utf8').trim());
        if (!(Number.isInteger(value) && value > 0)) {
          const at = Date.now() - t0;
          if (empty.count === 0) empty.firstMs = at;
          empty.lastMs = at;
          empty.count += 1;
        }
      } catch {}
      await new Promise((tick) => setTimeout(tick, 5));
    }
  })();
  return { stop: async () => { stopped = true; await done; }, empty };
}

/** The private temps an atomic create keeps only while it runs: any `.new` name under the
 *  clone's `.agents` at rest is residue the released protocol must not leave — the one a
 *  killed create left behind is swept by the next start. */
function newResidue(): string[] {
  return readdirSync(join(root, '.agents')).filter((name) => name.endsWith('.new')).sort();
}

/** A fixture's `ready`, with the deadline failing the pin on what the child has said so far
 *  instead of hanging the suite. */
async function readyOf(fixture: FixtureChild, deadlineMs = 8000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fixture.said.includes('ready')) return;
    if (fixture.failure) throw new Error(fixture.failure);
    await new Promise((tick) => setTimeout(tick, 25));
  }
  throw new Error(`the fixture never said ready: ${fixture.said.join(' | ')}`);
}

/** A fixture's outcome line, with the same deadline and the same failure message. */
async function outcomeOf(fixture: FixtureChild, deadlineMs = 8000): Promise<FixtureOutcome> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (fixture.outcome) return fixture.outcome;
    if (fixture.failure) throw new Error(fixture.failure);
    await new Promise((tick) => setTimeout(tick, 25));
  }
  throw new Error(`the fixture never answered: ${fixture.said.join(' | ')}`);
}

/** Wait until the start lock names the fixture's own process — its start section has begun and
 *  the lock is observably its own. */
async function lockedBy(fixture: FixtureChild): Promise<void> {
  const lockPath = `${brokerSocket(root)}.lock`;
  await waitFor(() => {
    try {
      return Number(readFileSync(lockPath, 'utf8').trim()) === fixture.pid;
    } catch {
      return false;
    }
  });
}

/** The pid is gone, not merely signalled: a reaped process answers no signal at all. */
async function gone(pid: number): Promise<void> {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

/** The answer map, the release world's shape: one recorded attempt, every request kept. */
function tracker(value: unknown): { fetch: Fetch; requests: { url: string; request?: RequestOptions }[] } {
  const requests: { url: string; request?: RequestOptions }[] = [];
  const fetch: Fetch = (url, request) => {
    requests.push(request === undefined ? { url } : { url, request });
    const attempt: Attempt = { kind: 'http', status: 200, body: JSON.stringify(value) };
    return Promise.resolve(attempt);
  };
  return { fetch, requests };
}

function issuesAnswer(nodes: unknown[], hasNextPage: unknown = false): Record<string, unknown> {
  return { data: { project: { id: PROJECT, issues: { nodes, pageInfo: { hasNextPage } } } } };
}

function node(change: Record<string, unknown> = {}): Record<string, unknown> {
  return { identifier: 'ACME-1', title: 'a task', description: 'the body', ...change };
}

/** The command's seams without the terminal: a literal key, the answer map, and a stop the test
 *  holds. Production's own wiring is never exercised here. The caller is handed in: without one
 *  the walk would place this very test run — a seat under herdr on a dev machine, an owner-no-tty
 *  on CI — and the start is the owner's. */
async function startCommand(seams: BrokerSources = {}): Promise<{ running: Promise<number>; io: ReturnType<typeof testIo>; finish: () => void }> {
  const io = testIo(root, { kind: 'owner' });
  let finish!: () => void;
  const running = runBroker([], io, {
    home,
    keyReader: async () => ({ ok: true, key: KEY }),
    stop: (end) => {
      finish = end;
      return () => {};
    },
    ...seams,
  });
  await waitFor(() => io.err.includes('answering on') || io.err.includes('team broker: '));
  return { running, io, finish };
}

describe('the broker wire protocol', () => {
  test('a request is exactly the three keys this build writes', () => {
    expect(parseRequest(JSON.stringify({ op: 'read', seat: 'lead', pane: 'w1:p1' }))).toEqual(leadSeat);
    for (const line of [
      'not json',
      JSON.stringify({ op: 'read', seat: 'lead', pane: 'w1:p1', token: 'x' }),
      JSON.stringify({ op: 'read', seat: 'lead' }),
      JSON.stringify({ op: 'write', seat: 'lead', pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: '', pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: 'a'.repeat(201), pane: 'w1:p1' }),
      JSON.stringify({ op: 'read', seat: 'lead\nworker', pane: 'w1:p1' }),
      JSON.stringify([{ op: 'read', seat: 'lead', pane: 'w1:p1' }]),
    ]) {
      expect(parseRequest(line)).toBeNull();
    }
  });

  test('an answer this build did not write is refused, never half-read', () => {
    const read: BrokerAnswer = { ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', priority: 1 }], refusals: [{ index: 2, id: 'm2', reason: 'title is required' }] } };
    expect(parseAnswer(encodeLine(read).trimEnd())).toEqual(read);
    const withNotice: BrokerAnswer = { ...read, notice: 'more' };
    expect(parseAnswer(encodeLine(withNotice).trimEnd())).toEqual(withNotice);
    const refused: BrokerAnswer = { ok: false, at: 'caller', message: 'no' };
    expect(parseAnswer(encodeLine(refused).trimEnd())).toEqual(refused);
    expect(parseAnswer(encodeLine({ ok: true, read: { kind: 'missing' } } as BrokerAnswer).trimEnd())).toEqual({ ok: true, read: { kind: 'missing' } });
    for (const line of [
      'not json',
      JSON.stringify({ ok: true, read: { kind: 'missing', junk: 1 } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [], junk: 1 } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1' }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', extra: 1 }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [{ id: 'm1', title: 't', priority: true }], refusals: [] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [{ index: 0, reason: 'x' }] } }),
      JSON.stringify({ ok: true, read: { kind: 'records', records: [], refusals: [], notice: '' } }),
      JSON.stringify({ ok: false, at: 'somewhere', message: 'no' }),
      JSON.stringify({ ok: 'yes', read: { kind: 'missing' } }),
      JSON.stringify({ ok: true }),
    ]) {
      expect(parseAnswer(line)).toBeNull();
    }
  });

  test('a line over the cap without its newline is refused, not buffered forever', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 't' }]));
    const line = `{"op":"read","seat":"lead","pane":"${'x'.repeat(MAX_REQUEST_BYTES)}"}`;
    const answer = await send(line);
    expect(JSON.parse(answer)).toEqual({ ok: false, at: 'caller', message: 'the request is not one this broker knows' });
  });
});

describe('the seat\'s client outcomes', () => {
  test('the sentences are bytes, and the deadline is the release check\'s', () => {
    expect(NOT_RUNNING).toBe('the broker is not running; the owner starts it with `team broker`');
    expect(WRONG_ANSWER).toBe("the broker's answer is not one this build knows; the owner restarts it");
    expect(DEADLINE).toBe('the broker accepted the request and did not answer; nothing is claimed');
    expect(BROKER_DEADLINE_MS).toBe(5000);
  });

  test('no broker, no socket file: unavailable', async () => {
    project();
    record();
    expect(await ask(leadSeat)).toEqual({ kind: 'unavailable' });
  });

  test('an answer line this build does not know is wrong, never half-read', async () => {
    project();
    record();
    const lines = ['not json\n', '{"ok":true,"read":{"kind":"records","records":[{"id":"m1"}],"refusals":[]}}\n'];
    for (const line of lines) {
      const close = await rawServer((socket) => socket.end(line));
      try {
        expect(await ask(leadSeat)).toEqual({ kind: 'wrong' });
      } finally {
        await close();
      }
    }
  });

  test('a broker that accepts and never answers is a deadline, and nothing is claimed', async () => {
    project();
    record();
    const close = await rawServer(() => {});
    try {
      expect(await ask(leadSeat, 200)).toEqual({ kind: 'deadline' });
    } finally {
      await close();
    }
  });
});

describe('the start protocol', () => {
  test('a call that is not the owner is refused before the keychain and before any bind', async () => {
    // The gate is the first thing after the invocation: no team file, no Keychain — the key
    // reader below must never be called — and no socket file. A pane run counts too: an agent
    // creates panes, so a pane is never the owner's terminal, TTY or not.
    project();
    const path = brokerSocket(root);
    const callers: [Caller, string][] = [
      [{ kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' }, 'worker'],
      [{ kind: 'pane', pane: 'w1:p1' }, 'it runs in pane w1:p1'],
      [{ kind: 'unplaced', reason: 'AGENT_UNATTENDED is set' }, 'unplaced (AGENT_UNATTENDED is set)'],
    ];
    for (const [caller, describe] of callers) {
      let keyReads = 0;
      const io = testIo(root, caller);
      const code = await runBroker([], io, {
        home,
        keyReader: async () => {
          keyReads += 1;
          return { ok: true, key: KEY };
        },
      });
      expect(code).toBe(1);
      expect(io.err).toBe(`team broker: only the owner runs \`broker\`, from a terminal outside herdr; this call is ${describe}\n`);
      expect(io.out).toBe('');
      expect(keyReads).toBe(0);
      expect(existsSync(path)).toBe(false);
    }
  });

  test('a second broker refuses as busy, through the module and through the command', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 't' }]));
    expect(await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([])), stderr: () => {} })).toEqual({ kind: 'busy' });
    const { running, io } = await startCommand();
    expect(await running).toBe(1);
    expect(io.err).toContain('team broker: a broker is already answering on .agents/broker.sock\n');
  });

  test('a socket file left by a SIGKILL is cleared and bound', async () => {
    project();
    record();
    leaveStaleSocket();
    const path = brokerSocket(root);
    expect(existsSync(path)).toBe(true);
    const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    expect(started.cleared).toBe(true);
    const outcome = await ask(leadSeat);
    expect(outcome).toMatchObject({ kind: 'read' });
    await started.handle.close();
    expect(existsSync(path)).toBe(false);
  });

  test('two concurrent starts against one stale socket leave one serving and one busy', async () => {
    // Base: both starts probed the same stale file and both cleared and bound — two live handles
    // on one path (rehearsed 20/20 rounds). The clear then followed the identity of the entry
    // the probe saw (dev+ino from the gate's lstat), which held on macOS but not on CI's ubuntu
    // runner (run 37787613018: both served — one start's walk read the other's fresh socket as
    // stale, a connect refused for a beat before its listen took effect). A stale answer is now
    // confirmed only when the same entry answers stale again after a turn, so a fresh sibling
    // socket is never cleared: the first to resume clears and binds, the other reads it live.
    // Which call resumes first is the runtime's to say; the pin is the pair — exactly one
    // serving, the loser busy — so it reads the same whether or not the order ever flips.
    project();
    record();
    leaveStaleSocket();
    const path = brokerSocket(root);
    const start = () =>
      startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    const outcomes = await Promise.all([start(), start()]);
    expect([...outcomes.map((outcome) => outcome.kind)].sort()).toEqual(['busy', 'serving']);
    const started = outcomes.find((outcome) => outcome.kind === 'serving');
    if (started?.kind !== 'serving') throw new Error('neither start served');
    expect(started.cleared).toBe(true);
    expect(await ask(leadSeat)).toMatchObject({ kind: 'read' });
    await started.handle.close();
    expect(existsSync(path)).toBe(false);
  });

  test('a second start cannot take the path from a start that is still starting', async () => {
    // The window the walk alone cannot close: a start is not instantaneous, and this owner —
    // the real start path in a real process — has its listen call deliberately held back a
    // fixed 1500ms by the fixture. The second start is a real start too, spawned the moment
    // the owner says ready, while the owner is still on its way to binding. At the base head
    // the path is clean through the whole hold: the racer's walk reads no entry, binds first,
    // and the owner's listen fails EADDRINUSE — the start that began first is the one refused
    // (rehearsed at the base head, macOS: 3/3 rounds; the push of this pin alone was the red
    // on CI — ubuntu run 37798070215 at head 982c4b0, `Expected: "serving"` / `Received:
    // "bind-failed"`, 1548.59ms — the proof the fix flips). The fix this pin holds: the
    // owner takes the start lock before its walk, the racer waits on that lock and then reads
    // the owner's socket live — busy — and the path carries the owner's very entry (dev+ino)
    // through everything the racer did.
    project();
    record();
    const path = brokerSocket(root);
    const owner = startFixture(1500);
    try {
      await readyOf(owner);
      const racer = startFixture(0);
      try {
        const ownerOutcome = await outcomeOf(owner);
        const racerOutcome = await outcomeOf(racer);
        expect(ownerOutcome.kind).toBe('serving');
        expect(racerOutcome.kind).toBe('busy');
        expect(ownerOutcome.cleared).toBe(false);
        expect(racerOutcome.cleared).toBe(false);
        const entry = lstatSync(path);
        expect(entry.isSocket()).toBe(true);
        const seen: Pick<FixtureOutcome, 'dev' | 'ino'> = { dev: entry.dev, ino: entry.ino };
        expect(seen).toEqual({ dev: ownerOutcome.dev, ino: ownerOutcome.ino });
        expect(seen).toEqual({ dev: racerOutcome.dev, ino: racerOutcome.ino });
        expect(await ask(leadSeat)).toMatchObject({ kind: 'read' });
        // The lock covers the start section, not the serve: the owner released it as its
        // listen landed, and the racer released the very hold it waited for — none is left.
        expect(existsSync(`${path}.lock`)).toBe(false);
      } finally {
        racer.kill();
      }
    } finally {
      owner.kill();
    }
  });

  test('a start\'s release leaves a lock a second start holds', async () => {
    // The release-identity shape, deterministic: A is a real start held pre-listen by the
    // fixture's listen hold (1500ms). Once A holds the lock, the same-principal removal the
    // finding's own step uses drops that entry, and B — a real start, held the same way —
    // creates its own lock in the free name. A's walk then lands and A's release runs while B
    // is alive and still mid-section: the release must unlink only the entry A created, so B's
    // lock survives A's exit — bytes and inode both. A release that unlinks the path
    // unconditionally removes a live replacement's lock; this pin is red until the release is
    // identity-bound. B's own walk, arriving after A bound, answers the pinned bind sentence;
    // B's release then removes its own lock.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const a = startFixture(1500);
    try {
      await readyOf(a);
      if (a.pid === undefined) throw new Error('the fixture has no pid');
      // The lock naming A itself, not mere existence: the file exists a beat before its pid
      // lands, and this pin needs A's section begun — the lock observably A's own.
      await lockedBy(a);
      expect(Number(readFileSync(lockPath, 'utf8').trim())).toBe(a.pid);
      unlinkSync(lockPath);
      const b = startFixture(1500);
      try {
        await readyOf(b);
        if (b.pid === undefined) throw new Error('the fixture has no pid');
        await lockedBy(b);
        expect(Number(readFileSync(lockPath, 'utf8').trim())).toBe(b.pid);
        const bEntry = lstatSync(lockPath);
        expect((await outcomeOf(a)).kind).toBe('serving');
        // A has left its section: B is alive, mid-section, and the lock at the path is still
        // B's entry.
        expect(existsSync(lockPath)).toBe(true);
        if (existsSync(lockPath)) {
          expect(Number(readFileSync(lockPath, 'utf8').trim())).toBe(b.pid);
          expect(lstatSync(lockPath).ino).toBe(bEntry.ino);
          expect(lstatSync(lockPath).dev).toBe(bEntry.dev);
        }
        expect((await outcomeOf(b)).kind).toBe('bind-failed');
      } finally {
        b.kill();
      }
    } finally {
      a.kill();
    }
    expect(existsSync(lockPath)).toBe(false); // B's own release removed its own entry
  }, 15000);

  test('a start lock a killed start left behind is taken over', async () => {
    // A start killed mid-section — the fixture SIGKILLed while it holds the lock and is still
    // on its way to binding — leaves the lock file with its dead pid. The next start must not
    // wedge on it: `withLock`'s discipline, the dead file taken over under a takeover claim,
    // serves it. Nothing was there to clear (the killed section never bound), and the lock the
    // next start took is released with it.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const killed = startFixture(60000);
    try {
      await readyOf(killed);
      if (killed.pid === undefined) throw new Error('the fixture has no pid');
      await lockedBy(killed);
      killed.kill();
      await killed.exited;
      await gone(killed.pid);
      expect(existsSync(lockPath)).toBe(true);
      expect(Number(readFileSync(lockPath, 'utf8').trim())).toBe(killed.pid);
      const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
      if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
      expect(started.cleared).toBe(false);
      expect(await ask(leadSeat)).toMatchObject({ kind: 'read' });
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(`${lockPath}.${process.pid}.stale`)).toBe(false);
      expect(existsSync(`${lockPath}.takeover`)).toBe(false);
      await started.handle.close();
      expect(existsSync(path)).toBe(false);
    } finally {
      killed.kill();
      await killed.exited;
    }
  });

  test('an empty lock file is waited on, not taken over', async () => {
    // The create→write gap, made observable: the lock exists the instant `openSync(path,'wx')`
    // returns, its pid one beat later — an empty read is what a sibling lands on in that gap,
    // and what a writer killed exactly there leaves behind. The too-young guard was written for
    // garbage reads only: an empty read parses to `0`, `Number.isInteger(0)` is true, so the
    // guard was skipped, `0 > 0` kept it out of the live-holder branch, and the lock was taken
    // over in the same instant it appeared (rehearsed at the frozen head on my own export:
    // `broker young EMPTY "": outcome=serving in 0ms`). The pin: the start must serve only
    // after the lock's age passed the young window — the empty file waited on like any lock
    // too young to hold its pid, then taken over where no writer is coming (nothing here ever
    // writes a pid into it; LOCK_YOUNG_MS is 1000). At the frozen head the serve lands within
    // a few ms of the create, so the elapsed is the observable: a wait that never happened
    // cannot be faked by a slow machine, only by the bug.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const t0 = Date.now();
    writeFileSync(lockPath, '');
    const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    const waited = Date.now() - t0;
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(await ask(leadSeat)).toMatchObject({ kind: 'read' });
    await started.handle.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('an interrupted writer\'s empty lock is waited on, then taken over', async () => {
    // The create→write gap with a real writer killed inside it (the review's C2 shape): a
    // child exclusive-creates the lock and SIGKILLs itself before writing its pid. The empty
    // file is now a dead writer's, and the second start is a real start: it must not take the
    // file over inside the young window — nothing has had a chance to write, and the oldest a
    // fresh entry can be is microseconds — and with no writer coming, the empty file is taken
    // over once it has aged past LOCK_YOUNG_MS (1000) and serves.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const writer = join(base, 'interrupted.mjs');
    writeFileSync(writer, "import { openSync } from 'node:fs';\nopenSync(process.argv[2], 'wx');\nprocess.kill(process.pid, 'SIGKILL');\n");
    try {
      execFileSync(process.execPath, [writer, lockPath], { stdio: 'ignore' });
    } catch (error) {
      if ((error as { signal?: string }).signal !== 'SIGKILL') throw error;
    }
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    const t0 = Date.now();
    const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    const waited = Date.now() - t0;
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    expect(waited).toBeGreaterThanOrEqual(950);
    expect(await ask(leadSeat)).toMatchObject({ kind: 'read' });
    await started.handle.close();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a live writer paused in the lock\'s create is never evicted', async () => {
    // The finding, against real processes: a writer alive and inside its own create — the
    // fixture's pid getter holds the real start path for 1500ms, a watched window an order of
    // magnitude past LOCK_YOUNG_MS — is not dead, and a second real start arriving mid-hold
    // must not serve through it. At the base head the lock's name exists at the create's
    // `openSync(path,'wx')` return and stays empty for the whole hold; the second start waits
    // out the young window, `takeOver` ages the entry out and unlinks it while the writer is
    // still to resume — the writer then publishes its pid into an unlinked file (the review's
    // own bytes: `writer:["opened"]`, `starter:["ready","prelisten","out:serving"]`,
    // `writerAlive:true`, `lock:false`). The pin judges the protocol's state, not the
    // schedule: whatever anyone answers, the shared name must never exist without a pid in it
    // — an entry is published whole — and at rest no start serves through the other: the
    // second serves, the writer resumes into its own section and answers busy, and no lock, no
    // claim, no private temp is left. The outcome pair is the same on both heads; the empty
    // sighting is the discriminator.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const writer = gapFixture(1500);
    const watcher = watchNoPid(lockPath);
    try {
      await readyOf(writer);
      await waitFor(() => writer.said.includes('paused')); // the writer is in its create's gap
      const second = startFixture(0);
      try {
        const secondOutcome = await outcomeOf(second, 15000);
        const writerOutcome = await outcomeOf(writer, 15000);
        await watcher.stop();
        expect(watcher.empty).toEqual({ count: 0, firstMs: 0, lastMs: 0 });
        expect(secondOutcome.kind).toBe('serving');
        expect(secondOutcome.cleared).toBe(false);
        expect(writerOutcome.kind).toBe('busy');
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(`${lockPath}.takeover`)).toBe(false);
        expect(newResidue()).toEqual([]);
      } finally {
        second.kill();
      }
    } finally {
      writer.kill();
      await watcher.stop();
    }
  }, 15000);

  test('a live writer paused in the takeover claim\'s create is never evicted', async () => {
    // The claim's own create→write gap, the same finding one file over: a start arriving at a
    // dead pid's lock enters `takeOver`, and its claim — `.agents/broker.sock.lock.takeover` —
    // is created empty, its pid one beat behind; the fixture holds exactly there for 1500ms.
    // A second real start on the same dead lock reads the claim empty and young, waits, then —
    // at the base head — ages it out and unlinks it while its writer is alive, takes the lock
    // over and serves; the writer resumes, finds its claim gone, and backs off on the pid check
    // (`readPid(claim) !== process.pid`): a live claim-holder evicted mid-create is the same
    // defect the lock's own gap was. The same watch applies — the claim must never exist
    // without its pid — and the same resting shape: the second serves (nothing to clear; the
    // dead start left no socket), the writer answers busy, and lock, claim and temps all end
    // absent.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const claimPath = `${lockPath}.takeover`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
    writeFileSync(lockPath, `${dead.pid}\n`); // a dead start's lock: the takeover path at once
    const writer = gapFixture(1500);
    const watcher = watchNoPid(claimPath);
    try {
      await readyOf(writer);
      await waitFor(() => writer.said.includes('paused')); // inside the claim's create
      const second = startFixture(0);
      try {
        const secondOutcome = await outcomeOf(second, 15000);
        const writerOutcome = await outcomeOf(writer, 15000);
        await watcher.stop();
        expect(watcher.empty).toEqual({ count: 0, firstMs: 0, lastMs: 0 });
        expect(secondOutcome.kind).toBe('serving');
        expect(secondOutcome.cleared).toBe(false);
        expect(writerOutcome.kind).toBe('busy');
        expect(existsSync(lockPath)).toBe(false);
        expect(existsSync(claimPath)).toBe(false);
        expect(newResidue()).toEqual([]);
      } finally {
        second.kill();
      }
    } finally {
      writer.kill();
      await watcher.stop();
    }
  }, 15000);

  test('a killed create\'s private temp is cleared by the next start, a live one kept', async () => {
    // The one residue an atomic create can leave: a start killed between its private temp's
    // create and its removal leaves `<lock>.<pid>.new` — and, for the claim, the same pattern
    // one segment further. The temp names its writer, so the next start clears the dead ones
    // and never touches a live pid's: a live pid's temp is a create in flight. Neither is ever
    // read by the protocol — the sweep is hygiene — and a start whose temp was wrongly swept
    // would fail its link with the same EEXIST a rival's win answers, so the race direction is
    // safe.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const dead = spawnSync(process.execPath, ['-e', '']);
    if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
    const deadTemp = `${lockPath}.${dead.pid}.new`;
    const liveTemp = `${lockPath}.takeover.${process.pid}.new`;
    writeFileSync(deadTemp, 'x\n');
    writeFileSync(liveTemp, 'x\n');
    const started = await startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([{ id: 'm1', title: 't' }])), stderr: () => {} });
    if (started.kind !== 'serving') throw new Error(`the broker did not start: ${started.kind}`);
    expect(existsSync(deadTemp)).toBe(false);
    expect(existsSync(liveTemp)).toBe(true);
    unlinkSync(liveTemp);
    await started.handle.close();
  });

  test('starts released together onto a dead start\'s lock serialize: one serves, every other busy', async () => {
    // The crash-recovery burst, four starts to a round: a start SIGKILLed mid-section leaves
    // the lock naming its dead pid, and a broker SIGKILLed leaves its socket file (the h9
    // shape); four real starts are spawned, held at a go file, and released together. The advertised
    // property — "a lock a killed start left behind is taken over, not waited on" — and the
    // three-answer discipline the page states: the winner clears the corpse and serves, "a
    // second start waits on that lock and then asks the path as any start does: it finds a
    // broker answering and stops with the refusal below, having cleared and bound nothing". At
    // the frozen head the burst breaches: my own export of it, 13/60 rounds of this shape, and
    // 10/30 of the six-way dead-pid shape with `bind-failed` losers finishing in 4ms — they
    // never waited (the review lab measured the same, 47/120 and 6/25). Every round's tuple
    // must be exactly one serving with the corpse cleared plus three busy that cleared
    // nothing; any other tuple — a `bind-failed`, a second serving, a cleared loser — is the
    // breach this pin names.
    //
    // The body is bounded the way the claim lane's below is: each round is two steps with
    // their own budgets (the ready step scaled from the measured boot pace, the release step
    // fixed at ten seconds), its starts are killed and reaped before the next round begins,
    // the live set never passes the four a round holds, and the run's own budget stops a
    // machine that cannot finish with the round and step named. The test timeout's margin
    // over the run cap is the other half of that bound: a body bun abandons at the timeout
    // runs on against the teardown's removed fixtures, and its later rejection is reported as
    // an unhandled error between tests. A run that cannot finish inside its budget stops
    // itself first, with every start reaped and the leftover count asserted on that path.
    project();
    record();
    const ROUNDS = 30;
    const ROUND_SIZE = 4;
    const WARMUP_ROUNDS = 5;
    const breaches: string[] = [];
    const live = new Set<FixtureChild>();
    /** A start joins the live set on spawn and leaves it when it is reaped. */
    const track = (kid: FixtureChild): FixtureChild => {
      live.add(kid);
      void kid.exited.then(() => live.delete(kid));
      return kid;
    };
    /** The round's own end: every start it made is killed and reaped before the next begins. */
    const reap = async (roundKids: FixtureChild[]): Promise<void> => {
      for (const kid of roundKids) kid.kill();
      await Promise.all(roundKids.map((kid) => kid.exited));
    };
    let stepMs = BURST_STEP_FLOOR_MS;
    let runBudgetMs = BURST4_RUN_FLOOR_MS;
    let warmupBootMs = 0;
    let failure: unknown;
    const runStart = Date.now();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        if (Date.now() - runStart > runBudgetMs) {
          throw new Error(`the four-start burst: the run outlived its ${runBudgetMs / 1000} s budget before round ${round} (step: start); its starts were killed and reaped`);
        }
        const bootStart = Date.now();
        const roundRoot = join(base, `burst-${round}`);
        mkdirSync(join(roundRoot, '.agents'), { recursive: true });
        writeFileSync(join(roundRoot, '.agents', 'team.yaml'), LINEAR);
        const at = brokerSocket(roundRoot);
        leaveStaleSocket(at);
        const dead = spawnSync(process.execPath, ['-e', '']);
        if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
        writeFileSync(`${at}.lock`, `${dead.pid}\n`);
        const go = join(base, `go-${round}`);
        const roundKids = Array.from({ length: ROUND_SIZE }, () => track(burstFixture(roundRoot, go)));
        if (live.size > ROUND_SIZE) {
          throw new Error(`the four-start burst: round ${round} held ${live.size} live starts, past the ${ROUND_SIZE}-start cap: an earlier round was not reaped`);
        }
        await withinStep(`the four-start burst: round ${round}: ready`, roundKids, stepMs, () => Promise.all(roundKids.map((kid) => readyOf(kid, stepMs + 10_000))));
        const bootMs = Date.now() - bootStart;
        writeFileSync(go, 'go\n');
        const outcomes = await withinStep(`the four-start burst: round ${round}: outcomes`, roundKids, BURST_OUTCOMES_STEP_MS, () =>
          Promise.all(roundKids.map((kid) => outcomeOf(kid, BURST_OUTCOMES_STEP_MS + 5_000))),
        );
        const serving = outcomes.filter((outcome) => outcome.kind === 'serving' && outcome.cleared);
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy' && !outcome.cleared);
        if (serving.length !== 1 || busy.length !== 3) {
          breaches.push(`round ${round}: [${outcomes.map((outcome) => `${outcome.kind}${outcome.cleared ? '+cleared' : ''}`).join(' ')}]`);
        }
        const reapStart = Date.now();
        await reap(roundKids);
        if (round < WARMUP_ROUNDS) warmupBootMs += bootMs + (Date.now() - reapStart);
        if (round === WARMUP_ROUNDS - 1) ({ stepMs, runBudgetMs } = burstBudgets(ROUNDS, warmupBootMs / WARMUP_ROUNDS, BURST4_RUN_FLOOR_MS, BURST4_RUN_CAP_MS));
      }
    } catch (error) {
      failure = error;
    }
    // The teardown is the pin's own, whichever way the body ended — a pass, a failure, or a
    // step's timeout: every start still alive is killed and reaped, and the leftover count is
    // asserted, so no run can leave a process behind.
    for (const kid of live) kid.kill();
    await Promise.all([...live].map((kid) => kid.exited));
    const leftBehind = live.size;
    if (leftBehind !== 0) {
      throw new Error(`the four-start burst: ${leftBehind} start${leftBehind === 1 ? '' : 's'} still alive after teardown${failure === undefined ? '' : ` (the run had already failed: ${String(failure)})`}`);
    }
    if (failure !== undefined) throw failure;
    expect(breaches).toEqual([]);
  }, 1_800_000);

  test('the dead-lock burst, sized: six starts released together onto a dead start\'s lock, one serves and every other busy', async () => {
    // The sized twin of the corpse burst above, on the dead-lock shape alone — sized from a
    // measurement, not picked: the race it guards is the takeover reading an already-gone lock
    // path (a NaN read, ENOENT), judging it like aged junk, and unlinking a rival's fresh
    // atomic lock that landed the freed name between the read and the unlink — two starts
    // walk, and the loser's bind fails. The window is microseconds inside one function, so no
    // deterministic pin exists and no shipped seam is worth its review surface; the durable
    // artifact is this repetition. Measured on the frozen bytes (`src/broker/server.ts`
    // `46bbb778…`), 300 rounds a shape: six starts 5/300 (p̂ 1.667%), nine 1/300 (0.333%),
    // twelve 5/300 (1.667%) → the pre-registered pick is cheapest cost = ceil(ln 0.01 /
    // ln(1 − p̂)) × measured per-round wall: six starts at 275 rounds, where a nine-start pin
    // would need 1380 rounds and twelve starts the same 275 at twice the per-round wall.
    // (59/60)^275 ≈ 0.98% miss — ≈99% to catch the race on the old bytes. Never resize this
    // pin after seeing a result: a pin-only head whose CI misses is re-run, both runs quoted.
    // Every round's tuple must be exactly one serving that cleared nothing plus five busy
    // that cleared nothing — a `bind-failed` at any seat, a second serving, a cleared loser,
    // is the breach this pin names.
    //
    // The body is bounded like the four-start scene's above: each round's ready step is scaled
    // from the measured boot pace (the release step fixed at ten seconds), its starts are
    // killed and reaped before the next round begins — never 275 rounds of survivors — and the
    // run's own budget stops a machine that cannot finish with the round and step named, inside
    // a test timeout whose margin over the cap is what keeps bun from ever abandoning the body.
    project();
    record();
    const ROUNDS = 275;
    const ROUND_SIZE = 6;
    const WARMUP_ROUNDS = 10;
    const breaches: string[] = [];
    const live = new Set<FixtureChild>();
    /** A start joins the live set on spawn and leaves it when it is reaped. */
    const track = (kid: FixtureChild): FixtureChild => {
      live.add(kid);
      void kid.exited.then(() => live.delete(kid));
      return kid;
    };
    /** The round's own end: every start it made is killed and reaped before the next begins. */
    const reap = async (roundKids: FixtureChild[]): Promise<void> => {
      for (const kid of roundKids) kid.kill();
      await Promise.all(roundKids.map((kid) => kid.exited));
    };
    let stepMs = BURST_STEP_FLOOR_MS;
    let runBudgetMs = BURST6_RUN_FLOOR_MS;
    let warmupBootMs = 0;
    let failure: unknown;
    const runStart = Date.now();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        if (Date.now() - runStart > runBudgetMs) {
          throw new Error(`the dead-lock burst: the run outlived its ${runBudgetMs / 1000} s budget before round ${round} (step: start); its starts were killed and reaped`);
        }
        const bootStart = Date.now();
        const roundRoot = join(base, `lockburst-${round}`);
        mkdirSync(join(roundRoot, '.agents'), { recursive: true });
        writeFileSync(join(roundRoot, '.agents', 'team.yaml'), LINEAR);
        const at = brokerSocket(roundRoot);
        const dead = spawnSync(process.execPath, ['-e', '']);
        if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
        writeFileSync(`${at}.lock`, `${dead.pid}\n`);
        const go = join(base, `lockgo-${round}`);
        const roundKids = Array.from({ length: ROUND_SIZE }, () => track(burstFixture(roundRoot, go)));
        if (live.size > ROUND_SIZE) {
          throw new Error(`the dead-lock burst: round ${round} held ${live.size} live starts, past the ${ROUND_SIZE}-start cap: an earlier round was not reaped`);
        }
        await withinStep(`the dead-lock burst: round ${round}: ready`, roundKids, stepMs, () => Promise.all(roundKids.map((kid) => readyOf(kid, stepMs + 10_000))));
        const bootMs = Date.now() - bootStart;
        writeFileSync(go, 'go\n');
        const outcomes = await withinStep(`the dead-lock burst: round ${round}: outcomes`, roundKids, BURST_OUTCOMES_STEP_MS, () =>
          Promise.all(roundKids.map((kid) => outcomeOf(kid, BURST_OUTCOMES_STEP_MS + 5_000))),
        );
        const serving = outcomes.filter((outcome) => outcome.kind === 'serving' && !outcome.cleared);
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy' && !outcome.cleared);
        if (serving.length !== 1 || busy.length !== 5) {
          breaches.push(`round ${round}: [${outcomes.map((outcome) => `${outcome.kind}${outcome.cleared ? '+cleared' : ''}`).join(' ')}]`);
        }
        const reapStart = Date.now();
        await reap(roundKids);
        if (round < WARMUP_ROUNDS) warmupBootMs += bootMs + (Date.now() - reapStart);
        if (round === WARMUP_ROUNDS - 1) ({ stepMs, runBudgetMs } = burstBudgets(ROUNDS, warmupBootMs / WARMUP_ROUNDS, BURST6_RUN_FLOOR_MS, BURST6_RUN_CAP_MS));
      }
    } catch (error) {
      failure = error;
    }
    // The teardown is the pin's own, whichever way the body ended — a pass, a failure, or a
    // step's timeout: every start still alive is killed and reaped, and the leftover count is
    // asserted, so no run can leave a process behind.
    for (const kid of live) kid.kill();
    await Promise.all([...live].map((kid) => kid.exited));
    const leftBehind = live.size;
    if (leftBehind !== 0) {
      throw new Error(`the dead-lock burst: ${leftBehind} start${leftBehind === 1 ? '' : 's'} still alive after teardown${failure === undefined ? '' : ` (the run had already failed: ${String(failure)})`}`);
    }
    if (failure !== undefined) throw failure;
    expect(breaches).toEqual([]);
  }, 3_000_000);

  test('the claim lane, sized and instrumented: six starts released together onto a dead start\'s lock never unlink a live lock or claim', async () => {
    // The pin for the claim path's own residual, carrying the delta-2 lab's finding instrument:
    // a wrap of `node:fs`'s `unlinkSync` that logs, one buffered line at the child's outcome,
    // every unlink of a `*.lock` / `*.lock.takeover` path whose bytes named a live pid other
    // than the unlinker (the lab's `UNLINK_LIVE` form: `…broker.sock.lock.takeover pid=16164
    // me=16167 bytes="16164"`, 2/150 six-way rounds on the frozen bytes). The seam: the
    // takeover's claim eviction read the claim, judged it dead, and unlinked it unanchored — a
    // rival's fresh claim landing in the read→unlink gap loses its claim, the stolen claimant
    // judges the lock without holding it, and two straddling judges can rebuild the
    // two-holders walk the dead-lock burst above pins down. Sizing, measured before this pin
    // was written — the same six-start dead-lock round with the wrap installed, on an export of
    // the unfixed `src/broker/server.ts` `6e0b54e0…`: 300 rounds → 3 events (1.00%/round;
    // rounds 156, 163, 206, every one a `.takeover` lane; ≈0.23 s/round). Pooled with the
    // lab's 2/150 on the same shape, p̂ = 5/450 = 1.111% → the pre-registered pick
    // ceil(ln 0.01 / ln(1 − p̂)) = 413 rounds ((89/90)^413 ≈ 0.99% miss at p̂; at the pooled
    // one-sided 90% exact-binomial (Clopper–Pearson) lower bound, 0.5415%, (1 − p_L)^413 ≈
    // 10.6% miss — the conservative tail; 1.768%, the figure this comment first named, is a
    // one-sided normal upper bound). Never
    // resize this pin after seeing a result: a pin-only head whose CI misses is re-run, both
    // runs quoted. Every round must still be exactly one serving that cleared nothing plus
    // five busy that cleared nothing — and the wire must have seen zero unlinks of a live lock
    // or claim, with its control: the winner's takeover unlinks the dead lock every round, so
    // `touched ≥ rounds` carries the zero. The detector rides the first route that proves
    // itself on this runner (a canary import's own call must fire the wrap before any round is
    // scored); where no route arms, the tuples are pinned and the unlink event is unasserted,
    // loudly. The timeout is the pin's own: 413 rounds of six real processes, with the step
    // and run budgets scaled from a warm-up's measured BOOT pace (on a loaded laptop the six
    // child boots, not the broker, set that pace; the release window is excluded so a
    // regressed broker cannot inflate the budget meant to catch it) and the outcomes step
    // fixed at ten seconds. Each round is a bounded step: its six starts are
    // killed and reaped before the next round begins, the live set may never pass the six a
    // round holds, and a step that outlives its budget tears its own round down at once and
    // fails naming the step. A run that cannot finish inside its budget stops with the round
    // and step named — never at the test timeout with no name — and every start is reaped and
    // the leftover count asserted on each of those paths.
    project();
    record();
    const routes = ['A1', 'A2', 'M', 'R'];
    let route: string | undefined;
    const selftestLog: string[] = [];
    for (const candidate of routes) {
      const verdict = await claimSelftest(candidate);
      selftestLog.push(`${candidate}: ${verdict.line}`);
      if (verdict.ok) { route = candidate; break; }
    }
    const ROUND_SIZE = 6;
    // The pin's own measured wall is ≈0.23 s a round on CI (≈95 s all told). A loaded laptop
    // boots the six child starts far slower (measured here: ≈2.5–3.6 s a round at load ≈8–9),
    // so the budgets come from the pace the run actually finds — the BOOT pace alone, round
    // start to every start's `ready` plus its reap, never the release window where
    // `startBroker` runs: a broker that regressed must not inflate the budget meant to catch
    // it. The first ten rounds are a warm-up; after them the step deadline is twice the boot
    // pace (never under the pin's original ten seconds), the run budget is twice the
    // extrapolated total from that same pace (between the pin's original five minutes and a
    // forty-minute cap), and the outcomes step stays a fixed ten seconds. A machine that
    // cannot finish 413 rounds inside the cap still stops with the round and step named and
    // every start reaped; what the budgets never do is let a slow machine pass as a broken
    // broker.
    const WARMUP_ROUNDS = 10;
    let stepMs = CLAIM_STEP_FLOOR_MS;
    let runBudgetMs = CLAIM_RUN_FLOOR_MS;
    const breaches: string[] = [];
    const live = new Set<ClaimChild>();
    /** A start joins the live set on spawn and leaves it when it is reaped. */
    const track = (kid: ClaimChild): ClaimChild => {
      live.add(kid);
      void kid.exited.then(() => live.delete(kid));
      return kid;
    };
    /** The round's own end: every start it made is killed and reaped before the next begins. */
    const reap = async (roundKids: ClaimChild[]): Promise<void> => {
      for (const kid of roundKids) kid.kill();
      await Promise.all(roundKids.map((kid) => kid.exited));
    };
    let events = 0;
    let touched = 0;
    let broken = 0;
    let failure: unknown;
    let warmupBootMs = 0;
    let outcomesTotalMs = 0;
    const runStart = Date.now();
    try {
      for (let round = 0; round < CLAIM_ROUNDS; round++) {
        if (Date.now() - runStart > runBudgetMs) {
          throw new Error(`the claim lane: the run outlived its ${runBudgetMs / 1000} s budget before round ${round} (step: start); its starts were killed and reaped`);
        }
        const bootStart = Date.now();
        const roundRoot = join(base, `claimburst-${round}`);
        mkdirSync(join(roundRoot, '.agents'), { recursive: true });
        writeFileSync(join(roundRoot, '.agents', 'team.yaml'), LINEAR);
        const at = brokerSocket(roundRoot);
        const dead = spawnSync(process.execPath, ['-e', '']);
        if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
        writeFileSync(`${at}.lock`, `${dead.pid}\n`);
        const go = join(base, `claimgo-${round}`);
        const roundKids = Array.from({ length: ROUND_SIZE }, () =>
          track(spawnClaimKid(['run', roundRoot, go, join(import.meta.dir, '..')], route ? { DS_DETECT: '1', DS_ROUTE: route, DS_PARENT: String(process.pid) } : {})),
        );
        if (live.size > ROUND_SIZE) {
          throw new Error(`the claim lane: round ${round} held ${live.size} live starts, past the ${ROUND_SIZE}-start cap: an earlier round was not reaped`);
        }
        await withinStep(`the claim lane: round ${round}: ready`, roundKids, stepMs, () => Promise.all(roundKids.map((kid) => readyOf(kid, stepMs + 10_000))));
        const bootMs = Date.now() - bootStart;
        writeFileSync(go, 'go\n');
        const outcomesStart = Date.now();
        const outcomes = await withinStep(`the claim lane: round ${round}: outcomes`, roundKids, CLAIM_OUTCOMES_STEP_MS, () => Promise.all(roundKids.map((kid) => outcomeOf(kid, CLAIM_OUTCOMES_STEP_MS + 5_000))));
        outcomesTotalMs += Date.now() - outcomesStart;
        const serving = outcomes.filter((outcome) => outcome.kind === 'serving' && !outcome.cleared);
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy' && !outcome.cleared);
        if (serving.length !== 1 || busy.length !== 5) {
          breaches.push(`round ${round}: [${outcomes.map((outcome) => `${outcome.kind}${outcome.cleared ? '+cleared' : ''}`).join(' ')}]`);
        }
        for (const kid of roundKids) {
          const seen = kid.claim();
          events += seen.list.length;
          touched += seen.touched;
          if (kid.detBroken()) broken += 1;
          for (const item of seen.list) {
            breaches.push(`round ${round}: UNLINK_LIVE ${item.path.replace(base, '…')} pid=${item.pid} me=${item.me} bytes="${String(item.bytes).trim()}"`);
          }
        }
        const reapStart = Date.now();
        await reap(roundKids);
        if (round < WARMUP_ROUNDS) warmupBootMs += bootMs + (Date.now() - reapStart);
        if (round === WARMUP_ROUNDS - 1) ({ stepMs, runBudgetMs } = claimBudgets(warmupBootMs / WARMUP_ROUNDS));
      }
    } catch (error) {
      failure = error;
    }
    // The teardown is the pin's own, whichever way the body ended — a pass, a failure, or a
    // step's timeout: every start still alive is killed and reaped, and the leftover count is
    // asserted, so no run can leave a process behind.
    for (const kid of live) kid.kill();
    await Promise.all([...live].map((kid) => kid.exited));
    const leftBehind = live.size;
    if (leftBehind !== 0) {
      throw new Error(`the claim lane: ${leftBehind} start${leftBehind === 1 ? '' : 's'} still alive after teardown${failure === undefined ? '' : ` (the run had already failed: ${String(failure)})`}`);
    }
    if (failure !== undefined) throw failure;
    // The release path's cumulative wall: a broker that stayed under the per-round step but far
    // over its measured window would pass every round and fail here.
    expect(outcomesTotalMs).toBeLessThanOrEqual(CLAIM_OUTCOMES_TOTAL_MS);
    if (route === undefined) {
      console.log(`the claim-lane pin: no detector route fired here (${selftestLog.join(' | ')}) — the tuples are pinned, the unlink event is unasserted on this runner`);
      expect(breaches).toEqual([]);
      return;
    }
    expect(broken).toBe(0);
    expect(touched).toBeGreaterThanOrEqual(CLAIM_ROUNDS);
    expect(breaches).toEqual([]);
    expect(events).toBe(0);
  }, 3_000_000);

  test('the claim lane, a stalled broker: a release stalled past the fixed outcomes step fails, and the boot pace never scales that step', async () => {
    // The regression the budgets must not hide: a broker whose start path slows down. The pin
    // measures its budgets from the BOOT pace (round start → every start's `ready`, plus reap)
    // and holds the outcomes step fixed at ten seconds — the release path measured 130–260 ms
    // at load 9–14 — so a stalled release fails the step instead of inflating a budget scaled
    // from it. This scene stubs exactly that: six real starts on the dead-lock shape, released
    // together, each sitting STALL_MS before it answers. The step must fail at ten seconds
    // naming itself, and the budgets from this round's boot pace must stay far under the
    // stall — proof the slower release never entered them.
    project();
    record();
    const STALL_MS = 12_000;
    const roundRoot = join(base, 'claimstall-0');
    mkdirSync(join(roundRoot, '.agents'), { recursive: true });
    writeFileSync(join(roundRoot, '.agents', 'team.yaml'), LINEAR);
    const at = brokerSocket(roundRoot);
    const dead = spawnSync(process.execPath, ['-e', '']);
    if (dead.pid === undefined) throw new Error('the dead-pid fixture has no pid');
    writeFileSync(`${at}.lock`, `${dead.pid}\n`);
    const go = join(base, 'claimstall-go');
    const kids = Array.from({ length: 6 }, () =>
      spawnClaimKid(['run', roundRoot, go, join(import.meta.dir, '..')], { DS_SLOW_STALL_MS: String(STALL_MS) }),
    );
    try {
      const bootStart = Date.now();
      await Promise.all(kids.map((kid) => readyOf(kid, 60_000)));
      const bootPaceMs = Date.now() - bootStart;
      const budgets = claimBudgets(bootPaceMs);
      // The pace the budgets are taken from is the boot alone, and it sits under the stall; the
      // old whole-round pace included the release by construction, so it would have measured at
      // least the stall and doubled it into the step — the regression scaling its own budget.
      expect(bootPaceMs).toBeLessThan(STALL_MS);
      expect(budgets.stepMs).toBeLessThan(STALL_MS);
      writeFileSync(go, 'go\n');
      const releaseStart = Date.now();
      const failure = await withinStep('the claim lane: round stall: outcomes', kids, CLAIM_OUTCOMES_STEP_MS, () =>
        Promise.all(kids.map((kid) => outcomeOf(kid, CLAIM_OUTCOMES_STEP_MS + 5_000))),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsed = Date.now() - releaseStart;
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toContain(`step "the claim lane: round stall: outcomes" outlived its ${CLAIM_OUTCOMES_STEP_MS} ms budget`);
      expect(elapsed).toBeGreaterThanOrEqual(CLAIM_OUTCOMES_STEP_MS);
      expect(elapsed).toBeLessThan(CLAIM_OUTCOMES_STEP_MS + 5_000);
    } finally {
      for (const kid of kids) kid.kill();
      await Promise.all(kids.map((kid) => kid.exited));
    }
  }, 120_000);

  test('a start that waits out the lock deadline refuses with the one line and touches nothing', async () => {
    // A live holder — a real start, held pre-listen for a minute — keeps the lock past every
    // waiter's deadline. The module and the command both wait it out and then fail closed: the
    // pinned line, exit 1, the socket path exactly as the holder left it (nothing yet: the
    // holder is still on its way to binding), and the lock file still the holder's own bytes.
    // Neither waiter clears, binds, or writes the lock.
    project();
    record();
    const path = brokerSocket(root);
    const lockPath = `${path}.lock`;
    const holder = startFixture(60000);
    try {
      await readyOf(holder);
      if (holder.pid === undefined) throw new Error('the fixture has no pid');
      await lockedBy(holder);
      const viaModule = startBroker({ root, team: teamOf(), read: () => Promise.resolve(records([])), stderr: () => {} });
      const io = testIo(root, { kind: 'owner' });
      const viaCommand = runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) });
      const [moduleResult, commandCode] = await Promise.all([viaModule, viaCommand]);
      expect(moduleResult).toEqual({ kind: 'locked' });
      expect(commandCode).toBe(1);
      expect(io.err).toContain('team broker: another start is binding .agents/broker.sock; try again\n');
      expect(existsSync(path)).toBe(false);
      expect(Number(readFileSync(lockPath, 'utf8').trim())).toBe(holder.pid);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  test('a path that cannot bind is a line and exit 1, not a crash, and the file stays', async () => {
    // A regular file where the socket belongs: the lstat gate refuses the entry before any
    // probe, with the pinned bare sentence and the file untouched. The errno story is why the
    // gate has no errno: macOS reads the file ENOTSOCK (myself: bun 1.4.2 + node v26.8.1),
    // where CI's ubuntu runner answered ECONNREFUSED — the walk's "stale" answer, which cleared
    // the file and bound; this test and the scene timed out there (run 37778336251). Either
    // read refuses the same way now. (The probe also showed an over-long path fails under node
    // only — bun binds it, 207 bytes — so no path length or error code is pinned here; the
    // failing file is the pin.)
    project();
    const path = brokerSocket(root);
    writeFileSync(path, 'not a socket');
    const io = testIo(root, { kind: 'owner' });
    const code = await runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) });
    expect(code).toBe(1);
    expect(io.err).toBe('team broker: the socket could not be bound\n');
    expect(io.err).not.toContain('at Object');
    expect(io.out).toBe('');
    // Fail closed: the walk refused the entry, and never unlinked the file.
    expect(readFileSync(path, 'utf8')).toBe('not a socket');
    // The refusal was made under the start lock, and the lock left with it.
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test('the walk clears only a socket: a symlink to a dead broker is left where it is', async () => {
    // The non-socket fork proved without an errno: connect would answer ECONNREFUSED (the link
    // resolves to a dead socket — a SIGKILLed child left it) and pre-gate the walk cleared the
    // link and served (probed: pre-fix head 8f9ddb2, outcome serving, cleared true, the path a
    // socket). The lstat gate refuses first: exit 1, the bare sentence, link and target both
    // where they were.
    project();
    const path = brokerSocket(root);
    const target = join(root, '.agents', 'dead.sock');
    leaveStaleSocket(target);
    symlinkSync(target, path);
    const io = testIo(root, { kind: 'owner' });
    const code = await runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) });
    expect(code).toBe(1);
    expect(io.err).toBe('team broker: the socket could not be bound\n');
    expect(io.out).toBe('');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isSocket()).toBe(true);
    // The refusal was made under the start lock, and the lock left with it.
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe('the per-request check', () => {
  test('every request is held to the recorded state, with the S2 sentences', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 'the task title' }]));
    expect(await ask({ op: 'read', seat: 'stranger', pane: 'w9:p1' })).toEqual({
      kind: 'refused',
      at: 'caller',
      message: 'only a seat of this team pulls a task; this request names stranger',
    });
    expect(await ask({ op: 'read', seat: 'lead', pane: 'w2:p1' })).toEqual({
      kind: 'refused',
      at: 'caller',
      message: anotherPaneRefusal('lead', 'w1:p1'),
    });
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready' };
    });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'caller', message: noPaneRefusal('lead') });
    expect(await ask(workerSeat)).toMatchObject({ kind: 'read' });
  });

  test('a request line that is not one this build wrote is a refusal, never a crash', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'm1', title: 'the task title' }]));
    for (const line of ['hello\n', '{"op":"read","seat":"lead","pane":"w1:p1","token":"x"}\n', '{"op":"read"}\n', '\n']) {
      const answer = JSON.parse(await send(line)) as BrokerAnswer;
      expect(answer).toEqual({ ok: false, at: 'caller', message: 'the request is not one this broker knows' });
    }
  });
});

describe('the per-field policy', () => {
  const full: TaskRecord = {
    id: 'ACME-1',
    title: 'a task',
    priority: 1,
    assignee: 'worker',
    milestone: 'M1',
    deadline: '2026-10-31',
    blockedBy: ['ACME-0'],
    repos: ['acme'],
    needs: ['review'],
    description: 'the body',
  };

  test('with no policy the nine typed fields cross and the description does not', () => {
    const out = applyPolicy(full);
    expect(out).toEqual({
      id: 'ACME-1',
      title: 'a task',
      priority: 1,
      assignee: 'worker',
      milestone: 'M1',
      deadline: '2026-10-31',
      blockedBy: ['ACME-0'],
      repos: ['acme'],
      needs: ['review'],
    });
    expect('description' in out).toBe(false);
  });

  test('an omitted field is absent from the record, never blank', () => {
    const out = applyPolicy(full, { omit: ['assignee', 'description'] });
    expect('assignee' in out).toBe(false);
    expect('description' in out).toBe(false);
    expect(out.deadline).toBe('2026-10-31');
  });

  test('allow names the set, and id and title stay the record itself', () => {
    expect(applyPolicy(full, { allow: ['id', 'title'] })).toEqual({ id: 'ACME-1', title: 'a task' });
    expect(applyPolicy(full, { allow: ['id', 'title', 'description'] })).toEqual({ id: 'ACME-1', title: 'a task', description: 'the body' });
    // The invariant holds whichever way the policy is called, even bypassing the validator.
    expect(applyPolicy(full, { allow: [] })).toEqual({ id: 'ACME-1', title: 'a task' });
    // Naming them in `omit` changes nothing: the two cross regardless.
    const omitted = applyPolicy(full, { omit: ['id', 'title'] });
    expect(omitted.id).toBe('ACME-1');
    expect(omitted.title).toBe('a task');
    expect('description' in omitted).toBe(false);
  });

  test('id: bare keeps the last URL segment', () => {
    const url = { ...full, id: 'https://linear.app/acme/issue/ACME-1/a-title' };
    expect(applyPolicy(url, { transform: { id: 'bare' } }).id).toBe('a-title');
    expect(applyPolicy({ ...full, id: 'ACME-1' }, { transform: { id: 'bare' } }).id).toBe('ACME-1');
  });

  test('the policy is applied before the answer is serialized, not by the seat', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'ACME-1', title: 'a task', description: 'the body', priority: 1 }]), { allow: ['id', 'title'] });
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(line).not.toContain('the body');
    expect(line).not.toContain('description');
    const answer = parseAnswer(line);
    expect(answer).toEqual({ ok: true, read: { kind: 'records', records: [{ id: 'ACME-1', title: 'a task' }], refusals: [] } });
  });

  test('a record whose final id is not a task id is refused on the broker\'s side, at today\'s exact bytes', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'https://linear.app/acme/issue/ACME-1', title: 'a task' }]));
    // The adapter carries the URL identifier; with no transform the broker refuses it — the same
    // sentence, keys and key order the adapter's own refusal always had (fix2 P2 byte discipline).
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(line).toBe('{"ok":true,"read":{"kind":"records","records":[],"refusals":[{"index":1,"reason":"its id is not a task id"}]}}');
  });

  test('a converted refusal takes the source position of its record, the list staying in order', async () => {
    project();
    record();
    await serving(async () =>
      records(
        [
          { id: 'ACME-1', title: 'one' },
          { id: 'https://linear.app/acme/issue/ACME-2', title: 'two' },
          { id: 'ACME-3', title: 'three' },
        ],
        [{ index: 4, id: 'ACME-4', reason: 'title is required' }],
      ),
    );
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(JSON.parse(line)).toEqual({
      ok: true,
      read: {
        kind: 'records',
        records: [
          { id: 'ACME-1', title: 'one' },
          { id: 'ACME-3', title: 'three' },
        ],
        refusals: [
          { index: 2, reason: 'its id is not a task id' },
          { index: 4, id: 'ACME-4', reason: 'title is required' },
        ],
      },
    });
  });

  test('a record whose final id repeats an earlier one is refused, at the adapter\'s sentence and keys', async () => {
    project();
    record();
    await serving(
      async () =>
        records([
          { id: 'https://linear.app/acme/issue/ACME-1', title: 'first version' },
          { id: 'ACME-1', title: 'second version' },
        ]),
      { transform: { id: 'bare' } },
    );
    // The transform made the two source ids one final id. The second is refused the way the
    // adapter refuses a raw repeat — its sentence, its keys, its key order — and only the first
    // crosses, so a take and a renewal meet one record under one id.
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(line).toBe(
      '{"ok":true,"read":{"kind":"records","records":[{"id":"ACME-1","title":"first version"}],"refusals":[{"index":2,"id":"ACME-1","reason":"its id repeats an earlier record"}]}}',
    );
  });

  test('a repeated final id takes the source position of its record, the list staying in order', async () => {
    project();
    record();
    await serving(
      async () =>
        records(
          [
            { id: 'ACME-1', title: 'one' },
            { id: 'https://linear.app/acme/issue/ACME-2', title: 'two' },
            { id: 'ACME-1', title: 'one again' },
          ],
          [{ index: 2, id: 'ACME-9', reason: 'title is required' }],
        ),
      { transform: { id: 'bare' } },
    );
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(JSON.parse(line)).toEqual({
      ok: true,
      read: {
        kind: 'records',
        records: [
          { id: 'ACME-1', title: 'one' },
          { id: 'ACME-2', title: 'two' },
        ],
        refusals: [
          { index: 2, id: 'ACME-9', reason: 'title is required' },
          { index: 4, id: 'ACME-1', reason: 'its id repeats an earlier record' },
        ],
      },
    });
  });

  test('id: bare governs a refusal\'s id too, and an id with no segment is omitted', async () => {
    project();
    record();
    await serving(
      async () =>
        records(
          [{ id: 'ACME-9', title: 'the task title' }],
          [
            { index: 2, id: 'https://linear.app/acme/issue/ACME-1', reason: 'title is required' },
            { index: 3, id: 'ACME-2', reason: 'title is required' },
            { index: 4, id: '///', reason: 'title is required' },
          ],
        ),
      { transform: { id: 'bare' } },
    );
    // The id is the source's own reference, not a credential: the transform governs it on a
    // refusal too. An already-bare id keeps its bytes; an id with no segment to cross is
    // omitted, so the raw one never rides in a refusal.
    const line = await send(`${encodeLine(leadSeat)}`);
    expect(line).toBe(
      '{"ok":true,"read":{"kind":"records","records":[{"id":"ACME-9","title":"the task title"}],"refusals":[{"index":2,"id":"ACME-1","reason":"title is required"},{"index":3,"id":"ACME-2","reason":"title is required"},{"index":4,"reason":"title is required"}]}}',
    );
  });

  test('id: bare lets a source URL cross as its last segment', async () => {
    project();
    record();
    await serving(async () => records([{ id: 'https://linear.app/acme/issue/ACME-1', title: 'a task' }]), { transform: { id: 'bare' } });
    const answer = parseAnswer(await send(`${encodeLine(leadSeat)}`));
    expect(answer).toEqual({ ok: true, read: { kind: 'records', records: [{ id: 'ACME-1', title: 'a task' }], refusals: [] } });
  });

  test('a failed read keeps its detail on the broker\'s terminal and tells the seat the one line', async () => {
    project();
    record();
    let call = 0;
    const { stderr } = await serving(async () => {
      call += 1;
      if (call === 1) return { kind: 'failed', message: 'the tracker could not be read' };
      throw new Error('boom');
    });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'read', message: 'the broker failed this read' });
    expect(await ask(leadSeat)).toEqual({ kind: 'refused', at: 'read', message: 'the broker failed this read' });
    expect(stderr).toEqual(['team broker: the read failed: the tracker could not be read\n', 'team broker: the read failed: boom\n']);
  });
});

describe('the tasks section under the broker source', () => {
  const of = (extra: string): string => `${LINEAR}${extra}`;

  test('source: linear validates with its block, and omitted keys stay absent', () => {
    const plain = validateTeamFile(LINEAR);
    if (!plain.ok) throw new Error('the fixture does not validate');
    expect(plain.team.tasks).toEqual({ source: 'linear', linear: { project: PROJECT, keychainService: 'team.linear.acme' } });
    const withPolicy = validateTeamFile(of('  policy:\n    omit: [description]\n    transform:\n      id: bare\n'));
    if (!withPolicy.ok) throw new Error('the policy fixture does not validate');
    expect(withPolicy.team.tasks).toEqual({
      source: 'linear',
      linear: { project: PROJECT, keychainService: 'team.linear.acme' },
      policy: { omit: ['description'], transform: { id: 'bare' } },
    });
  });

  test('every refusal sentence of the table is a byte', () => {
    const fileWithPolicy = `${FILE_SOURCE}  policy:\n    omit: [description]\n`;
    expect(refusals(fileWithPolicy)).toContain('tasks.policy is for a broker source; source: file has no broker');
    const fileWithLinear = `${FILE_SOURCE}  linear:\n    project: x\n    keychainService: y\n`;
    expect(refusals(fileWithLinear)).toContain('tasks.linear is for source: linear');
    expect(refusals(of('  policy:\n    allow: [id, title]\n    omit: [description]\n'))).toContain('tasks.policy: allow and omit are not used together');
    expect(refusals(of('  policy:\n    allow: [id, title, foo]\n'))).toContain('tasks.policy.allow lists "foo", not a task field');
    expect(refusals(of('  policy:\n    omit: [foo]\n'))).toContain('tasks.policy.omit lists "foo", not a task field');
    expect(refusals(of('  policy:\n    allow: id\n'))).toContain('tasks.policy.allow must be a list of task fields');
    expect(refusals(of('  policy:\n    allow: [id, title, 3]\n'))).toContain('tasks.policy.allow must be a list of task fields');
    expect(refusals(of('  policy:\n    transform:\n      title: lowercase\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    expect(refusals(of('  policy:\n    transform:\n      id: shout\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    expect(refusals(of('  policy:\n    transform: {}\n'))).toContain('tasks.policy.transform: only id: bare is defined in this build');
    // The record itself: allow must name id and title, omit must name neither.
    expect(refusals(of('  policy:\n    allow: [id]\n'))).toContain('tasks.policy.allow must name id and title, the record itself');
    expect(refusals(of('  policy:\n    allow: [title]\n'))).toContain('tasks.policy.allow must name id and title, the record itself');
    expect(refusals(of('  policy:\n    omit: [id]\n'))).toContain('tasks.policy.omit must not name id or title, the record itself');
    expect(refusals(of('  policy:\n    omit: [title, description]\n'))).toContain('tasks.policy.omit must not name id or title, the record itself');
    // The linear block's own sentences.
    expect(refusals(LINEAR.replace(`    project: ${PROJECT}\n`, ''))).toContain('tasks.linear.project is required');
    expect(refusals(LINEAR.replace('    keychainService: team.linear.acme\n', ''))).toContain('tasks.linear.keychainService is required');
    // The source fence itself.
    expect(refusals(of('  path: .agents/tasks.yaml\n'))).toContain('tasks.path is for source: file');
    expect(refusals(LINEAR.replace('source: linear', 'source: tracker'))).toContain('tasks.source must be file or linear');
  });

  function refusals(text: string): string {
    const checked = validateTeamFile(text);
    if (checked.ok) return '';
    return checked.errors.map((error) => error.message).join('\n');
  }
});

describe('the credential never crosses to the seat', () => {
  test('a full take over the socket: one keychain read, one request, one header, the policy applied', async () => {
    project();
    record();
    let keyReads = 0;
    const world = tracker(issuesAnswer([node({ priority: 1 })]));
    const { running, io, finish } = await startCommand({
      keyReader: async () => {
        keyReads += 1;
        return { ok: true, key: KEY };
      },
      fetch: world.fetch,
    });
    const outcome = await ask(leadSeat, 3000);
    finish();
    expect(await running).toBe(0);
    if (outcome.kind !== 'read' || outcome.read.kind !== 'records') throw new Error(`the read did not arrive: ${JSON.stringify(outcome)}`);
    expect(outcome.read.records).toEqual([{ id: 'ACME-1', title: 'a task', priority: 1 }]);
    expect(keyReads).toBe(1);
    expect(world.requests.length).toBe(1);
    expect(world.requests[0]?.request?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: KEY });
    expect(io.err).toContain('team broker: answering on .agents/broker.sock\n');
    expect(io.err).toContain('team broker: stopped\n');
    expect(existsSync(brokerSocket(root))).toBe(false);
    // The key is in the broker's header and nowhere else this run can see: not the answer, not
    // the terminal, not any file under the clone.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(`${io.out}${io.err}`).not.toContain(KEY);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).not.toContain(KEY);
  });

  test('without the facility the broker refuses to start, forms no request, and binds nothing', async () => {
    project();
    record();
    let fetched = false;
    const world = tracker(issuesAnswer([]));
    const io = testIo(root, { kind: 'owner-no-tty' });
    let read = false;
    const code = await runBroker([], io, {
      home,
      keyReader: async () => {
        read = true;
        return { ok: false, reason: 'the run is not interactive' };
      },
      fetch: (url, request) => {
        fetched = true;
        return world.fetch(url, request);
      },
    });
    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(io.err).toBe('team broker: only the owner runs this, from a terminal outside herdr\n');
    expect(fetched).toBe(false);
    expect(existsSync(brokerSocket(root))).toBe(false);
  });

  test('the command refuses a file source, a missing source, and a bad invocation', async () => {
    project(FILE_SOURCE);
    record();
    const io = testIo(root, { kind: 'owner' });
    expect(await runBroker([], io, { home, keyReader: async () => ({ ok: true, key: KEY }) })).toBe(1);
    expect(io.err).toBe('team broker: tasks.source must be linear; the broker serves a tracker source\n');
    project(LINEAR.replace(/tasks:\n  source: linear\n  linear:\n    project: .*\n    keychainService: .*\n/, ''));
    record();
    const bare = testIo(root, { kind: 'owner' });
    expect(await runBroker([], bare, { home, keyReader: async () => ({ ok: true, key: KEY }) })).toBe(1);
    expect(bare.err).toBe('team broker: the team file declares no task source\n');
    const stray = testIo(base, { kind: 'owner' });
    expect(await runBroker([], stray, { home })).toBe(2);
    expect(stray.err).toBe('team broker: not inside a git repository: run team from a project\n');
    const extra = testIo(root, { kind: 'owner' });
    expect(await runBroker(['extra'], extra, { home })).toBe(2);
    expect(extra.err.startsWith('team broker: unexpected "extra"\nUsage: team broker\n')).toBe(true);
  });

  test('the seat\'s own modules reach no keychain, no network wiring, no child process', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');
    const client = read('src/broker/client.ts');
    const command = read('src/commands/next.ts');
    const server = read('src/broker/server.ts');
    const reaches = [
      "'node:child_process'",
      "'../release/keychain.ts'",
      "'../release/http.ts'",
      "'../release/checks.ts'",
      "'../tasks/linear.ts'",
    ];
    for (const text of [client, command, server]) {
      for (const specifier of reaches) expect(text).not.toContain(specifier);
    }
    // Only the seat's own two files are held to the no-filesystem rule; the serving half owns
    // the socket file's unlink and reads nothing else.
    for (const text of [client, command]) expect(text).not.toContain("'node:fs'");
    // The serving half checks no credential either: the key lives in the command's own closure.
    expect(server).not.toContain('keychain');
    expect(server).not.toContain('credential');
  });
});

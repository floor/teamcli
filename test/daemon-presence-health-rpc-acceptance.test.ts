// Independent acceptance for the daemon's existing health request, its fresh per-route presence
// answer and `daemonHealth`'s merge of that answer. The real machine daemon is started in a
// synthetic world with the real presence ingester and activity step; the wire is the actual
// machine socket and the actual `probeDaemonHealth` / `daemonHealth` calls. The last scene drives
// a controlled socket to prove the client's refusal edges (epoch, malformed, contradictory,
// absent roots), because no live daemon can be made to answer dishonestly.
//
// Pinned here: fresh in-memory roots on the canonical root and loaded session; serving+healthy
// only after the real producer's caught-up step; the producer's own fault and backlog answer
// pending+false with their reason; the fixed grace ages a quiet channel to pending and the next
// pass renews it; a closing daemon never claims health; presence hosting off omits the record;
// the request instant (not a native-event age) is carried as checkedAt; a probe writes nothing;
// and the client merges only same-epoch, well-formed, non-contradictory records for roots the
// state record already carries. No pane, owner home, credential file or live seat is involved.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonHealth, probeDaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { daemonSocketPath, daemonStatePath } from '../src/daemon/paths.ts';
import { PRESENCE_HEALTH_GRACE_MS } from '../src/daemon/presence/health.ts';
import { mintPresenceBinding } from '../src/daemon/presence/contract.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';
import {
  answerDaemonRequest, DAEMON_PROTOCOL_VERSION, formatDaemonResponse, parseDaemonRequest,
  type DaemonHealthSnapshot,
} from '../src/daemon/protocol.ts';
import { writeDaemonState, type DaemonRootState, type DaemonState } from '../src/daemon/state.ts';

const SESSION = 'crew';
const SEAT = 'writer';
const SEAT_ID = 'seat_0123456789ab';

const TEAM_TEXT = `format: 1
project: acme
entity: acme
session: crew
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
    launch: claude
    leads: true
  - role: worker
    name: writer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type World = { base: string; home: string; root: string; dir: string; binding: string };
type Running = { daemon: MachineDaemon; closed: boolean };

let worlds: World[] = [];
let daemons: Running[] = [];
let servers: Server[] = [];

/**
 * One synthetic checkout, home and seat record under the platform temporary directory.
 */
function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'presence-rpc-acceptance-')));
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), TEAM_TEXT);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const binding = mintPresenceBinding();
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: {
      crew: {
        seats: { writer: { stage: 'ready', id: SEAT_ID, presence_binding: binding } },
        worktrees: {},
      },
    },
  })}\n`);
  const world: World = { base, home, root, dir, binding };
  worlds.push(world);
  return world;
}

async function start(world: World, overrides: Partial<Parameters<typeof startMachineDaemon>[0]> = {}): Promise<Running> {
  const started = await startMachineDaemon({
    home: world.home,
    roots: [world.root],
    version: '0.0.0-presence-rpc-acceptance',
    // Long enough that no heartbeat state write lands inside a scene: a probe's read-only claim
    // is then checked against a file nothing in the daemon is rewriting.
    heartbeatMs: 60_000,
    presenceHosting: true,
    presenceEveryMs: 500,
    ...overrides,
  });
  if (started.kind !== 'serving') throw new Error(`the daemon did not start: ${started.kind}`);
  const running: Running = { daemon: started.daemon, closed: false };
  daemons.push(running);
  return running;
}

async function stop(running: Running): Promise<void> {
  if (running.closed) return;
  running.closed = true;
  await running.daemon.close();
}

afterEach(async () => {
  for (const running of daemons.splice(0)) {
    try { await stop(running); } catch { /* the scene already closed it */ }
  }
  for (const server of servers.splice(0)) server.close();
  for (const world of worlds.splice(0)) rmSync(world.base, { recursive: true, force: true });
});

beforeEach(() => {
  // Each scene owns its world; this hook exists so a leaked server from an earlier scene cannot
  // answer a later one. The reset is also what keeps `afterEach`'s cleanup ordering plain.
  daemons = [];
  servers = [];
  worlds = [];
});

type Answer = DaemonHealthSnapshot;

async function probe(socketPath: string): Promise<Answer> {
  const answer = await probeDaemonHealth(socketPath, { timeoutMs: 2_000 });
  if (answer.kind !== 'answered') throw new Error(`the health probe did not answer: ${JSON.stringify(answer)}`);
  return answer.health;
}

/** The single route's fresh record, asserted present with the shape the daemon promises. */
function onlyPresence(answer: Answer) {
  expect(Array.isArray(answer.roots)).toBe(true);
  const roots = answer.roots!;
  expect(roots).toHaveLength(1);
  return roots[0]!;
}

async function waitFor<T>(check: () => Promise<T | null>, deadlineMs: number, label: string): Promise<T> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let staged = 0;

/** One spool record in the producer's own contract, written where the ingester lists it. A
 *  record this build cannot read would be rejected, not ingested, and the scenes below assert
 *  the projection to prove the producer itself accepted it. */
function stage(world: World, event: 'turn-start' | 'turn-end', ts: string): string {
  const paths = presencePaths(world.dir, SESSION, SEAT);
  if (paths === null) throw new Error('the seat has no presence paths');
  mkdirSync(paths.spool, { recursive: true });
  staged += 1;
  const suffix = (0x10000000 + staged).toString(16).padStart(8, '0');
  const id = `${ts}-${suffix}`;
  writeFileSync(join(paths.spool, `${id}.json`), `${JSON.stringify({
    v: 1, id, ts, session: SESSION, seat: SEAT, binding: world.binding,
    source: 'runtime-hook', event,
  })}\n`);
  return id;
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe('the existing health answer carries fresh per-route presence', () => {
  test('pending before a pass, serving after the real producer catches up; checkedAt is the request instant', async () => {
    const world = makeWorld();
    const running = await start(world, { presenceEveryMs: 500 });

    // Before any record exists the producer's own verdict is false, so the route must not claim
    // health merely because the daemon is up.
    const early = await probe(running.daemon.socketPath);
    const earlyRoot = onlyPresence(early);
    expect(earlyRoot.root).toBe(world.root);
    expect(earlyRoot.presence).toBeDefined();
    expect(earlyRoot.presence!.session).toBe(SESSION);
    expect(earlyRoot.presence!.state).toBe('pending');
    expect(earlyRoot.presence!.healthy).toBe(false);
    expect(typeof earlyRoot.presence!.why).toBe('string');
    expect(earlyRoot.presence!.why!.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(earlyRoot.presence!.checkedAt))).toBe(true);

    // Bounded: the answer adds a root name and one fixed-shape record, plus one entry per
    // declared seat — never a spool or log payload, and no second call to obtain it.
    expect(Object.keys(earlyRoot).sort()).toEqual(['presence', 'root']);
    expect(Object.keys(earlyRoot.presence!).sort()).toEqual(['checkedAt', 'healthy', 'seats', 'session', 'state', 'why']);
    expect(earlyRoot.presence!.seats!.map((seat) => seat.seat).sort()).toEqual(['lead', 'writer']);

    // A probe is a read: with the heartbeat far away, the state record is byte-identical after
    // two probes. Nothing about this answer is persisted.
    const before = readFileSync(daemonStatePath(world.home), 'utf8');
    await probe(running.daemon.socketPath);
    await probe(running.daemon.socketPath);
    expect(readFileSync(daemonStatePath(world.home), 'utf8')).toBe(before);

    // One caught-up pass later the channel serves. The native event is two days old: the answer
    // must carry the request instant, not the age of the event behind the projection.
    const oldTs = iso(Date.now() - 2 * 24 * 60 * 60 * 1000);
    stage(world, 'turn-end', oldTs);
    const serving = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'serving' ? root : null;
    }, 5_000, 'the caught-up serving answer');

    const at = Date.parse(serving.presence!.checkedAt);
    expect(serving.presence).toMatchObject({ session: SESSION, state: 'serving', healthy: true, why: null });
    // The request instant, within one probe's own local round trip — not the event's age.
    expect(Math.abs(Date.now() - at)).toBeLessThan(2_000);
    // The projection stands on the old native event while the channel answer is current.
    const current = await readPresenceCurrent(world.dir, SESSION, SEAT);
    if (current.kind !== 'ok') throw new Error(`the projection did not land: ${JSON.stringify(current)}`);
    expect(current.value).toMatchObject({ state: 'idle', source: 'runtime-hook', binding: world.binding, since: oldTs });
    expect(Math.abs(Date.parse(serving.presence!.checkedAt) - Date.parse(oldTs))).toBeGreaterThan(24 * 60 * 60 * 1000);
  }, 20_000);

  test("a pre-existing fatal log line turns the first pass pending with the producer's own reason", async () => {
    const world = makeWorld();
    stage(world, 'turn-end', iso(Date.now() - 60_000));
    const first = await start(world, { presenceEveryMs: 250 });
    await waitFor(async () => {
      const root = onlyPresence(await probe(first.daemon.socketPath));
      return root.presence?.state === 'serving' ? true : null;
    }, 5_000, 'the healthy first daemon');
    await stop(first);

    // The log is read whole on a fresh ingester's first step: a corrupt trailing line is a
    // structured fault there, reported once with the line's own reason. (A running index never
    // re-reads the log, so this fault is only reachable across a restart.)
    const paths = presencePaths(world.dir, SESSION, SEAT);
    if (paths === null) throw new Error('the seat has no presence paths');
    appendFileSync(paths.log, 'not a presence line\n');

    const second = await start(world, { presenceEveryMs: 500 });
    // The channel starts pending before any pass; the answer this scene pins is the one the
    // faulted step itself produced, still carrying the producer's own reason.
    const faulted = await waitFor(async () => {
      const root = onlyPresence(await probe(second.daemon.socketPath));
      return root.presence?.why?.includes('not a presence line') ? root : null;
    }, 4_000, 'the faulted pending answer');
    expect(faulted.presence!.healthy).toBe(false);
    expect(faulted.presence!.why).toContain('not a presence line');
    // The same fatal answer is what the process itself reports, not a stored word: the state
    // record carries no fresh presence and nothing from this answer is written to it.
    const reading = await daemonHealth(world.home, { timeoutMs: 1_000 });
    expect(reading.roots[0]!.presence).toMatchObject({
      session: SESSION, state: 'pending', healthy: false,
    });
    expect(typeof (reading.roots[0]!.presence as { why?: unknown }).why).toBe('string');
    const persisted = readFileSync(daemonStatePath(world.home), 'utf8');
    expect(JSON.parse(persisted).roots[0].presence).toBeUndefined();
  }, 20_000);

  test('a real known backlog answers pending with its reason, then serving once caught up', async () => {
    const world = makeWorld();
    // More records than one step's batch, staged before the daemon's first pass so the first
    // batch is known to be full rather than racing a half-written folder.
    const base = Date.now() - 120_000;
    for (let index = 0; index < 70; index += 1) stage(world, 'turn-end', iso(base + index * 1_000));
    const running = await start(world, { presenceEveryMs: 500 });

    const backlogged = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.why === 'the presence channel still has a backlog' ? root : null;
    }, 5_000, 'the backlog answer');
    expect(backlogged.presence).toMatchObject({ state: 'pending', healthy: false });

    const serving = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'serving' ? root : null;
    }, 5_000, 'the caught-up answer');
    expect(serving.presence).toMatchObject({ session: SESSION, state: 'serving', healthy: true, why: null });
    const current = await readPresenceCurrent(world.dir, SESSION, SEAT);
    if (current.kind !== 'ok') throw new Error(`the projection did not land: ${JSON.stringify(current)}`);
    expect(current.value.seq).toBe(70);
  }, 20_000);

  test('a quiet channel ages out of the fixed grace and the next pass renews it', async () => {
    const world = makeWorld();
    const recordTs = iso(Date.now() - 60_000);
    stage(world, 'turn-end', recordTs);
    // Two passes five seconds apart with a two-second grace: the serving window closes between
    // them, so the aging is the daemon's fixed liveness, not a producer fault.
    const running = await start(world, { presenceEveryMs: 5_000 });
    const firstServing = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'serving' ? root : null;
    }, 8_000, 'the first serving answer');
    const servedAt = Date.now();
    expect(firstServing.presence!.healthy).toBe(true);

    const aged = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'pending' ? root : null;
    }, 4_500, 'the aged-out pending answer');
    const ageElapsed = Date.now() - servedAt;
    expect(aged.presence!.healthy).toBe(false);
    expect(aged.presence!.why).toBe('no presence step finished inside the liveness window');
    // It ages after the fixed grace, not before, and before the next five-second pass.
    expect(ageElapsed).toBeGreaterThanOrEqual(PRESENCE_HEALTH_GRACE_MS - 300);
    expect(ageElapsed).toBeLessThan(4_500);

    const renewed = await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'serving' ? root : null;
    }, 6_000, 'the renewed serving answer');
    expect(renewed.presence!.healthy).toBe(true);
  }, 30_000);

  test('presence hosting off omits the record, and a foreign op keeps its refusal', async () => {
    const world = makeWorld();
    const running = await start(world, { presenceHosting: false });
    const answer = await probe(running.daemon.socketPath);
    const root = onlyPresence(answer);
    expect(root.root).toBe(world.root);
    expect('presence' in root).toBe(false);

    // The client reading must not invent health from a route with no presence record.
    const reading = await daemonHealth(world.home, { timeoutMs: 2_000 });
    expect(reading.probe.state).toBe('answered');
    expect(reading.roots).toHaveLength(1);
    expect(reading.roots[0]!.root).toBe(world.root);
    expect(reading.roots[0]!.presence).toBeUndefined();

    // The extension adds no op and no privilege: the only other daemon op is still refused on
    // the same socket, before any principal is proven.
    const refused = await rawRequest(running.daemon.socketPath, JSON.stringify({
      v: DAEMON_PROTOCOL_VERSION, id: 'rpc-acceptance-send', op: 'send',
      scope: { root: world.root, team: 'acme', seat: SEAT, session: SESSION, agent: 'agt_0123456789ab' },
    }));
    expect(refused).toMatchObject({ ok: false, error: { code: 'daemon.auth-unsupported' } });
  }, 15_000);

  test('a closing daemon answers pending and a closed one never serves again', async () => {
    const world = makeWorld();
    stage(world, 'turn-end', iso(Date.now() - 60_000));
    const running = await start(world, { presenceEveryMs: 250 });
    await waitFor(async () => {
      const root = onlyPresence(await probe(running.daemon.socketPath));
      return root.presence?.state === 'serving' ? true : null;
    }, 5_000, 'the serving answer before close');

    // Start the close without awaiting: the daemon marks itself closing synchronously, before
    // its first await, so its own snapshot answers pending with that reason.
    const closing = running.daemon.close();
    running.closed = true;
    const during = running.daemon.health();
    const duringRoot = during.roots?.find((entry) => entry.root === world.root);
    expect(duringRoot?.presence).toMatchObject({
      state: 'pending', healthy: false, why: 'the daemon is closing',
    });

    // The endpoint either refuses admission or stops answering; either way no health is claimed.
    const probeDuring = await probeDaemonHealth(running.daemon.socketPath, { timeoutMs: 500 });
    if (probeDuring.kind === 'answered') throw new Error('a closing daemon answered health');
    await closing;

    // After a truthful drain the record and socket are gone: the reading is not-running and
    // cannot paste the last in-memory answer onto anything.
    const after = await daemonHealth(world.home, { timeoutMs: 500 });
    expect(after.state).toBe('not-running');
    expect(after.roots).toEqual([]);
  }, 15_000);
});

describe('the client merges only what the answering epoch proves', () => {
  const ROOT = '/private/tmp/presence-rpc-world';

  function stateOf(home: string, overrides: Partial<DaemonState> = {}): DaemonState {
    return {
      format: 1,
      pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      since: '2026-10-20T10:00:00.000Z',
      startedBy: 'service-manager',
      version: '0.0.0-presence-rpc-acceptance',
      heartbeatAt: '2026-10-20T11:59:30.000Z',
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [{
        root: ROOT, team: 'acme', send: 'serving', bus: 'serving', why: null,
        presence: { state: 'pending', why: 'the last drain was not truthful' },
      }],
      ...overrides,
    };
  }

  function snapshotOf(state: DaemonState): DaemonHealthSnapshot {
    return {
      pid: state.pid, uid: state.uid, since: state.since, startedBy: state.startedBy,
      version: state.version, heartbeatAt: state.heartbeatAt, stuck: state.stuck,
      features: state.features,
    };
  }

  async function serve(home: string, initial: DaemonHealthSnapshot): Promise<{ set: (next: DaemonHealthSnapshot) => void }> {
    const socketPath = daemonSocketPath(home);
    mkdirSync(join(home, '.team'), { recursive: true, mode: 0o700 });
    let current = initial;
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const parsed = parseDaemonRequest(buffer.slice(0, nl));
        const response = parsed.ok
          ? answerDaemonRequest(parsed.request, current)
          : { v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false as const, error: parsed.error };
        socket.end(formatDaemonResponse(response));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    return { set: (next) => { current = next; } };
  }

  test('epoch mismatch, absent or malformed roots, and contradictions leave the recorded root alone', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'presence-rpc-client-')));
    worlds.push({ base: home, home, root: home, dir: home, binding: '' });
    const state = stateOf(home);
    writeDaemonState(home, state);
    const served = await serve(home, snapshotOf(state));
    const persisted = state.roots[0]!.presence;

    // Another epoch's fresh serving answer is not pasted onto this record.
    served.set({
      ...snapshotOf(state), since: '2026-10-20T10:00:01.000Z',
      roots: [{ root: ROOT, presence: {
        session: SESSION, state: 'serving', healthy: true, checkedAt: iso(Date.now()), why: null,
      } }],
    });
    let reading = await daemonHealth(home, { timeoutMs: 1_000 });
    expect(reading.roots[0]!.presence).toEqual(persisted);

    // Same epoch, but no roots / a non-array roots answer: nothing is merged.
    served.set(snapshotOf(state));
    reading = await daemonHealth(home, { timeoutMs: 1_000 });
    expect(reading.roots[0]!.presence).toEqual(persisted);
    served.set({ ...snapshotOf(state), roots: 'not-an-array' as unknown as DaemonHealthSnapshot['roots'] });
    reading = await daemonHealth(home, { timeoutMs: 1_000 });
    expect(reading.roots[0]!.presence).toEqual(persisted);

    // Contradictory records (serving without healthy, pending with healthy, empty why) are
    // dropped whole, never repaired into a claim.
    for (const presence of [
      { session: SESSION, state: 'serving', healthy: false, checkedAt: iso(Date.now()), why: null },
      { session: SESSION, state: 'pending', healthy: true, checkedAt: iso(Date.now()), why: null },
      { session: SESSION, state: 'pending', healthy: false, checkedAt: iso(Date.now()), why: '' },
      { session: SESSION, state: 'serving', healthy: true, checkedAt: '', why: null },
      { session: '', state: 'serving', healthy: true, checkedAt: iso(Date.now()), why: null },
      null,
    ]) {
      // A hostile wire record: the cast is the point, since the daemon's real answer never
      // produces these shapes and the client must refuse them all the same.
      served.set({ ...snapshotOf(state), roots: [{ root: ROOT, presence }] as unknown as DaemonHealthSnapshot['roots'] });
      reading = await daemonHealth(home, { timeoutMs: 1_000 });
      expect(reading.roots[0]!.presence).toEqual(persisted);
    }

    // A well-formed answer for a root this record does not carry is never invented into it.
    served.set({
      ...snapshotOf(state),
      roots: [{ root: '/private/tmp/another-route', presence: {
        session: SESSION, state: 'serving', healthy: true, checkedAt: iso(Date.now()), why: null,
      } }],
    });
    reading = await daemonHealth(home, { timeoutMs: 1_000 });
    expect(reading.roots.map((root) => root.root)).toEqual([ROOT]);
    expect(reading.roots[0]!.presence).toEqual(persisted);

    // The valid same-epoch record is merged exactly, checkedAt included.
    const checkedAt = iso(Date.now());
    const fresh = { session: SESSION, state: 'serving' as const, healthy: true, checkedAt, why: null };
    served.set({ ...snapshotOf(state), roots: [{ root: ROOT, presence: fresh }] });
    reading = await daemonHealth(home, { timeoutMs: 1_000 });
    expect(reading.roots[0]!.presence).toEqual(fresh);
  }, 15_000);

  test('a persisted record can never carry healthy, and an unanswered probe pastes nothing', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'presence-rpc-client-')));
    worlds.push({ base: home, home, root: home, dir: home, binding: '' });
    const state = stateOf(home);
    // A hand-edited file, the way a stale writer or a person could leave one: the record says
    // pending but also carries a healthy word. The state read door must drop the extra word;
    // the pending record is display detail, never proof.
    mkdirSync(dirname(daemonStatePath(home)), { recursive: true, mode: 0o700 });
    writeFileSync(daemonStatePath(home), `${JSON.stringify({
      ...state,
      roots: [{ ...state.roots[0]!, presence: { state: 'pending', why: 'stale word', healthy: true } }],
    })}\n`);
    // No socket at all: the probe cannot answer, so nothing fresh may be pasted in.
    const reading = await daemonHealth(home, { timeoutMs: 100 });
    expect(reading.probe.state).toBe('unanswered');
    expect(reading.roots[0]!.presence).toEqual({ state: 'pending', why: 'stale word' });
    expect((reading.roots[0]!.presence as Record<string, unknown>).healthy).toBeUndefined();
  }, 10_000);
});

/** One request line on the daemon's socket, for the op-refusal proof. */
function rawRequest(socketPath: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the raw request timed out')); }, 2_000);
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

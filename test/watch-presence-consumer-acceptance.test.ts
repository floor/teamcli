// Independent acceptance for the presence consumer at its actual entry points: the asynchronous
// prefetch, the synchronous idle snapshot the watch and the commands share, and the dispatcher's
// use of both. Every world is synthetic: a temporary team root and state folder, a hand-built
// team file, and presence projections the daemon's own ingester wrote or a malformed file placed
// by hand. No pane, screen, socket, CLI home or live team file is touched.
//
// A red assertion here is the measured behaviour of this source, not a weakened expectation:
// each scene names one contract property and asserts it whole.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PresenceReading } from '../src/daemon/presence/contract.ts';
import { presenceId } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester } from '../src/daemon/presence/ingest.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { captureIdleClaim, idleClaimOf } from '../src/watch/claim.ts';
import { dispatchIdleWork, forgetIdleEpisodes, type IdleDispatchInput, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import { prefetchPresence, type PresenceRead } from '../src/watch/presence.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const SESSION = 'crew';
const SEAT = 'writer';
const BINDING = 'prs_0123456789ab';
const SUCCESSOR = 'prs_fedcba987654';
const SEAT_ID = 'seat_0123456789ab';

function at(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

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

const loaded = validateTeamFile(TEAM_TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const team: TeamFile = loaded.team;

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE_SCREEN = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const BUSY_SCREEN = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;

function liveWith(status: 'idle' | 'done' | 'working', screen: string): Live {
  return {
    running: true,
    agents: [{ name: SEAT, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null }],
    workspaces: [{ id: 'w1', label: SEAT }],
    screens: { 'w1:p1': screen },
  };
}

type World = { base: string; root: string; dir: string };

let bases: string[] = [];
afterEach(() => {
  forgetIdleEpisodes();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-consumer-acceptance-')));
  bases.push(base);
  const root = join(base, 'crew');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  return { base, root, dir };
}

function queue(world: World, ids: readonly string[] = ['t1']): void {
  writeFileSync(join(world.dir, 'queue.yaml'), ids.map((id) => `- id: ${id}\n  title: "${id}"\n`).join(''));
}

function writeState(world: World, session: SessionState): void {
  writeFileSync(
    join(world.dir, 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: session } })}\n`,
  );
}

function worldState(world: World): SessionState {
  return readState(world.dir).sessions[SESSION] ?? emptySession();
}

function statePath(world: World): string {
  return join(world.dir, 'team.state.json');
}

/** Every file any announcement could have written under the state folder's mailbox tree. */
function mailboxFiles(world: World): string[] {
  const root = join(world.dir, 'messages');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(root);
  return found;
}

function fence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: at(540), ...over };
}

type SessionOptions = {
  lastActive?: string;
  noStamp?: boolean;
  seatId?: string | null;
  binding?: string | null;
  gate?: 'default' | 'none' | Record<string, unknown>;
};

function sessionWith(options: SessionOptions = {}): SessionState {
  const state = emptySession();
  const record: Record<string, unknown> = { stage: 'ready' };
  if (options.noStamp !== true) record.last_active = options.lastActive ?? at(360);
  if (options.seatId !== null) record.id = options.seatId ?? SEAT_ID;
  if (options.binding !== null) record.presence_binding = options.binding ?? BINDING;
  const gate = options.gate ?? 'default';
  if (gate !== 'none') record.presence_applied = gate === 'default' ? fence() : gate;
  state.seats[SEAT] = record as unknown as SessionState['seats'][string];
  return state;
}

/** A native projection on the current incarnation, coherent with its own id and ingest instant. */
function reading(over: Partial<PresenceReading> = {}): PresenceReading {
  const since = over.since ?? at(600);
  const value: PresenceReading = {
    v: 1,
    seq: 7,
    id: `${since}-a1b2c3d4`,
    state: 'idle',
    source: 'runtime-hook',
    event: 'turn-end',
    binding: BINDING,
    since,
    observedAt: at(540),
    ...over,
  };
  if (over.id === undefined) value.id = `${value.since}-a1b2c3d4`;
  if (over.observedAt === undefined) {
    value.observedAt = new Date(Math.min(NOW, Date.parse(value.since) + MIN)).toISOString();
  }
  return value;
}

function reportWith(
  read: PresenceRead,
  options: {
    state?: SessionState;
    live?: Live | null;
    healthy?: boolean;
  } = {},
) {
  return idleWorkReport({
    root: '/nonexistent-consumer-root',
    team,
    state: options.state ?? sessionWith(),
    live: options.live === undefined ? null : options.live,
    now: new Date(NOW),
    presence: new Map([[SEAT, read]]),
    presenceChannelHealthy: options.healthy === undefined ? true : options.healthy,
  });
}

function dispatchInput(world: World, extra: Partial<IdleDispatchInput> = {}): IdleDispatchInput {
  return {
    root: world.root,
    dir: world.dir,
    team,
    state: worldState(world),
    live: null,
    now: new Date(NOW),
    body: (seat) => `body for ${seat}`,
    ...extra,
  };
}

let nonceCounter = 0;

/** Stages one turn-end and runs one real ingester step, returning the projection it wrote. */
async function ingestOne(world: World, ts = at(600)): Promise<PresenceReading> {
  writeState(world, sessionWith({ noStamp: true, gate: 'none' }));
  nonceCounter += 1;
  const id = presenceId(ts, nonceCounter.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the scene instant is not a presence instant');
  const staged = stagePresenceRecord(world.dir, {
    session: SESSION,
    seat: SEAT,
    binding: BINDING,
    source: 'runtime-hook',
    event: 'turn-end',
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  const ingester = createPresenceIngester({ stateDir: world.dir, session: SESSION, now: () => new Date(NOW) });
  const step = await ingester.step();
  if (step.errors.length > 0) throw new Error(`the ingester refused its own projection: ${JSON.stringify(step.errors)}`);
  expect(step.ingested).toHaveLength(1);
  await ingester.close();
  const current = await readPresenceCurrent(world.dir, SESSION, SEAT);
  if (current.kind !== 'ok') throw new Error(`the projection is ${current.kind}`);
  return current.value;
}

function pathsOf(world: World) {
  const paths = presencePaths(world.dir, SESSION, SEAT);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return paths;
}

describe('both clocks and the persisted stamp', () => {
  test('a native idle past both clocks is counted with the persisted stamp as its clock', () => {
    const report = reportWith(
      { kind: 'native', reading: reading({ since: at(600) }) },
      { state: sessionWith({ lastActive: at(360) }) },
    );
    expect(report.presence_unknown).toBeUndefined();
    expect(report.idle).toEqual([{
      seat: SEAT,
      since: at(360),
      native_since: at(600),
      presence_source: 'runtime-hook',
    }]);
  });

  test('a fresh persisted stamp or a fresh native transition is too recent, never unknown', () => {
    const freshPersisted = reportWith(
      { kind: 'native', reading: reading({ since: at(600) }) },
      { state: sessionWith({ lastActive: at(120) }) },
    );
    expect(freshPersisted.idle).toEqual([]);
    expect(freshPersisted.presence_unknown).toBeUndefined();

    const freshNative = reportWith(
      { kind: 'native', reading: reading({ since: at(120) }) },
      { state: sessionWith({ lastActive: at(180) }) },
    );
    expect(freshNative.idle).toEqual([]);
    expect(freshNative.presence_unknown).toBeUndefined();
  });

  test('a persisted stamp older than the transition is an unknown hold, never a wake', () => {
    const report = reportWith(
      { kind: 'native', reading: reading({ since: at(60) }) },
      { state: sessionWith({ lastActive: at(600) }) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('predates the transition');
  });

  test('an idle projection with no persisted stamp is unknown, never a wake', () => {
    const report = reportWith(
      { kind: 'native', reading: reading() },
      { state: sessionWith({ noStamp: true }) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('no parseable persisted activity stamp');
  });
});

describe('known states and the exact fence', () => {
  test('working, waiting-for-a-person and gone are known non-idle and never hold the pass', () => {
    const states = [
      ['working', 'turn-start'],
      ['waiting-for-a-person', 'human-wait'],
      ['gone', 'session-end'],
    ] as const;
    for (const [state, event] of states) {
      const report = reportWith(
        { kind: 'native', reading: reading({ state, event, since: at(60) }) },
        // Waiting and gone advance the fence but need no newer persisted clock; the idle screen
        // is present and must not be able to change a known state.
        { state: sessionWith({ noStamp: true }), live: liveWith('idle', IDLE_SCREEN) },
      );
      expect(report.idle).toEqual([]);
      expect(report.presence_unknown).toBeUndefined();
    }
  });

  test('a fence one sequence ahead of the projection holds the pass', () => {
    const report = reportWith(
      { kind: 'native', reading: reading({ seq: 7 }) },
      { state: sessionWith({ gate: fence({ seq: 8 }) }) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('fence is at seq 8 while the projection carries seq 7');
  });

  test('a fence one sequence behind the projection holds the pass', () => {
    const report = reportWith(
      { kind: 'native', reading: reading({ seq: 7 }) },
      { state: sessionWith({ gate: fence({ seq: 6 }) }) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('fence is at seq 6 while the projection carries seq 7');
  });

  test('a fence applied on another incarnation or naming another managed seat is invalid', () => {
    const otherIncarnation = reportWith(
      { kind: 'native', reading: reading() },
      { state: sessionWith({ gate: fence({ binding: SUCCESSOR }) }) },
    );
    expect(otherIncarnation.idle).toEqual([]);
    expect(otherIncarnation.presence_unknown).toContain('another incarnation');

    const otherSeat = reportWith(
      { kind: 'native', reading: reading() },
      { state: sessionWith({ gate: fence({ seat_id: 'seat_ffffffffffff' }) }) },
    );
    expect(otherSeat.idle).toEqual([]);
    expect(otherSeat.presence_unknown).toContain('another managed seat');
  });

  test('a future fence instant is invalid', () => {
    const report = reportWith(
      { kind: 'native', reading: reading() },
      { state: sessionWith({ gate: fence({ applied_at: new Date(NOW + 2 * MIN).toISOString() }) }) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('applied_at is in the future');
  });

  test('a present projection on a channel not known healthy is unknown, never a fallback', () => {
    const report = reportWith(
      { kind: 'native', reading: reading() },
      { state: sessionWith(), healthy: false, live: liveWith('idle', IDLE_SCREEN) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('channel is not known healthy');
  });
});

describe('fallback licensing', () => {
  test('absence licenses the labelled terminal-host reading only with a live terminal', () => {
    const withLive = reportWith(
      { kind: 'absent', why: 'no projection' },
      { state: sessionWith({ lastActive: at(600) }), live: liveWith('idle', IDLE_SCREEN) },
    );
    expect(withLive.presence_unknown).toBeUndefined();
    expect(withLive.idle).toEqual([{ seat: SEAT, since: at(600), presence_source: 'terminal-host' }]);

    const withoutLive = reportWith(
      { kind: 'absent', why: 'no projection' },
      { state: sessionWith({ lastActive: at(600) }), live: null },
    );
    expect(withoutLive.idle).toEqual([]);
    expect(withoutLive.presence_unknown).toBeUndefined();
  });

  test('a malformed record never falls back to an idle screen', () => {
    const report = reportWith(
      { kind: 'invalid', why: 'the projection is not JSON' },
      { state: sessionWith({ lastActive: at(600) }), live: liveWith('idle', IDLE_SCREEN) },
    );
    expect(report.idle).toEqual([]);
    expect(report.presence_unknown).toContain('the projection is not JSON');
  });
});

describe('the daemon projection at the consumer', () => {
  test('a projection the ingester wrote is prefetched and counted by the synchronous report with no terminal', async () => {
    const world = makeWorld();
    const projection = await ingestOne(world);
    writeState(world, sessionWith({
      lastActive: at(360),
      gate: fence({ seq: projection.seq, applied_at: projection.observedAt }),
    }));
    const reads = await prefetchPresence({ stateDir: world.dir, session: SESSION, seatNames: [SEAT] });
    expect(reads.get(SEAT)).toMatchObject({ kind: 'native' });
    const report = idleWorkReport({
      root: world.root,
      team,
      state: worldState(world),
      live: null,
      now: new Date(NOW),
      presence: reads,
      presenceChannelHealthy: true,
    });
    expect(report.presence_unknown).toBeUndefined();
    expect(report.idle).toEqual([{
      seat: SEAT,
      since: at(360),
      native_since: projection.since,
      presence_source: 'runtime-hook',
    }]);
  });

  test('prefetch and the report write nothing', async () => {
    const world = makeWorld();
    const projection = await ingestOne(world);
    writeState(world, sessionWith({
      lastActive: at(360),
      gate: fence({ seq: projection.seq, applied_at: projection.observedAt }),
    }));
    const paths = pathsOf(world);
    const before = {
      state: readFileSync(statePath(world), 'utf8'),
      log: readFileSync(paths.log, 'utf8'),
      current: readFileSync(paths.current, 'utf8'),
    };
    const reads = await prefetchPresence({ stateDir: world.dir, session: SESSION, seatNames: [SEAT] });
    const report = idleWorkReport({
      root: world.root,
      team,
      state: worldState(world),
      live: null,
      now: new Date(NOW),
      presence: reads,
      presenceChannelHealthy: true,
    });
    expect(report.idle).toHaveLength(1);
    expect(readFileSync(statePath(world), 'utf8')).toBe(before.state);
    expect(readFileSync(paths.log, 'utf8')).toBe(before.log);
    expect(readFileSync(paths.current, 'utf8')).toBe(before.current);
  });
});

describe('the dispatcher holds what it cannot prove', () => {
  test('a native idle seat is woken with a terminal that reports busy, and the claim keeps the persisted stamp', async () => {
    const world = makeWorld();
    queue(world);
    writeState(world, sessionWith({ lastActive: at(360) }));
    const pushes: WorkPushRequest[] = [];
    const push = async (request: WorkPushRequest) => {
      pushes.push(request);
      return { ok: true as const, outcome: 'typed (unconfirmed)' };
    };
    const result = await dispatchIdleWork(dispatchInput(world, {
      live: liveWith('working', BUSY_SCREEN),
      presence: new Map([[SEAT, { kind: 'native', reading: reading() }]]),
      presenceChannelHealthy: true,
      push,
    }));
    expect(result.suppressed).toEqual([SEAT]);
    expect(result.pushed).toEqual([{ seat: SEAT, ok: true, outcome: 'typed (unconfirmed)' }]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ seat: SEAT, pane: 'w1:p1' });
    expect(result.fallback).toBeUndefined();
    const claim = idleClaimOf(worldState(world), SEAT);
    expect(claim).toMatchObject({ idle_since: at(360) });
    expect(JSON.stringify(claim)).not.toContain(at(600));
  });

  test('an invalid reading holds the claim byte-for-byte and writes no notice', async () => {
    const world = makeWorld();
    queue(world);
    writeState(world, sessionWith({ lastActive: at(360) }));
    expect(captureIdleClaim(world.dir, {
      session: SESSION, seat: SEAT, idle_since: at(360), at: new Date(NOW - 5 * MIN),
    }).kind).toBe('captured');
    const before = readFileSync(statePath(world), 'utf8');
    const result = await dispatchIdleWork(dispatchInput(world, {
      live: liveWith('idle', IDLE_SCREEN),
      presence: new Map([[SEAT, { kind: 'invalid', why: 'the projection is unreadable' }]]),
      presenceChannelHealthy: true,
    }));
    expect(result.pushed).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(readFileSync(statePath(world), 'utf8')).toBe(before);
    expect(mailboxFiles(world)).toEqual([]);
  });

  test('an unknown reading with nothing takeable neither ends the claim nor announces the empty stretch', async () => {
    const world = makeWorld();
    writeState(world, sessionWith({ lastActive: at(360) }));
    expect(captureIdleClaim(world.dir, {
      session: SESSION, seat: SEAT, idle_since: at(360), at: new Date(NOW - 5 * MIN),
    }).kind).toBe('captured');
    const before = readFileSync(statePath(world), 'utf8');
    const result = await dispatchIdleWork(dispatchInput(world, {
      presence: new Map([[SEAT, { kind: 'invalid', why: 'the projection is unreadable' }]]),
      presenceChannelHealthy: true,
    }));
    expect(result.pushed).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(readFileSync(statePath(world), 'utf8')).toBe(before);
    expect(mailboxFiles(world)).toEqual([]);
  });

  test('a projection on disk with no health answer is default-closed and holds the claim', async () => {
    const world = makeWorld();
    queue(world);
    const projection = await ingestOne(world);
    writeState(world, sessionWith({
      lastActive: at(360),
      gate: fence({ seq: projection.seq, applied_at: projection.observedAt }),
    }));
    expect(captureIdleClaim(world.dir, {
      session: SESSION, seat: SEAT, idle_since: at(360), at: new Date(NOW - 5 * MIN),
    }).kind).toBe('captured');
    const before = readFileSync(statePath(world), 'utf8');
    const result = await dispatchIdleWork(dispatchInput(world));
    expect(result.pushed).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(readFileSync(statePath(world), 'utf8')).toBe(before);
    expect(mailboxFiles(world)).toEqual([]);
  });

  test('an unreadable projection on disk holds even when the screen reads idle', async () => {
    const world = makeWorld();
    queue(world);
    writeState(world, sessionWith({ lastActive: at(360) }));
    expect(captureIdleClaim(world.dir, {
      session: SESSION, seat: SEAT, idle_since: at(360), at: new Date(NOW - 5 * MIN),
    }).kind).toBe('captured');
    const paths = pathsOf(world);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.current, '{not json');
    const before = readFileSync(statePath(world), 'utf8');
    const result = await dispatchIdleWork(dispatchInput(world, {
      live: liveWith('idle', IDLE_SCREEN),
      presenceChannelHealthy: true,
    }));
    expect(result.pushed).toEqual([]);
    expect(result.fallback).toBeUndefined();
    expect(readFileSync(statePath(world), 'utf8')).toBe(before);
    expect(mailboxFiles(world)).toEqual([]);
  });

  test('the dispatcher prefetches the real projection before its synchronous report', async () => {
    const world = makeWorld();
    queue(world);
    const projection = await ingestOne(world);
    writeState(world, sessionWith({
      lastActive: at(360),
      gate: fence({ seq: projection.seq, applied_at: projection.observedAt }),
    }));
    const result = await dispatchIdleWork(dispatchInput(world, { presenceChannelHealthy: true }));
    expect(result.suppressed).toEqual([SEAT]);
    // No route is wired in this pass: the attempt is still recorded, which proves the reading
    // reached the dispatcher through the prefetch and not through a screen.
    expect(result.pushed).toEqual([{ seat: SEAT, ok: false, refused: 'no direct work route is wired' }]);
    const claim = idleClaimOf(worldState(world), SEAT);
    expect(claim).toMatchObject({ idle_since: at(360) });
  });
});

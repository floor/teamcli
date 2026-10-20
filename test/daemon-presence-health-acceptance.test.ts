// Independent acceptance for the presence channel's typed verdict and the recovery it must
// carry. The scenes run the real ingester over a synthetic `.agents` folder that first produced a
// valid old idle projection and its canonical fence, then make the log fatal or unreadable or
// leave known backlog, and finally restore a valid source. The daemon's guard
// (`presenceStepHealth`) decides the channel answer, and the consumer's own snapshot decides
// whether the old idle is authorized.
//
// No scene substitutes a hand-built `healthy: true` for the producer's answer: every health
// value asserted here is the one the real ingester returned on that step.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presenceId } from '../src/daemon/presence/contract.ts';
import { createPresenceActivity } from '../src/daemon/presence/activity.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { presenceStepHealth } from '../src/daemon/presence/health.ts';
import { readPresenceCurrent } from '../src/daemon/presence/read.ts';
import { presencePaths, stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import { idleWorkReport } from '../src/watch/idle-work.ts';
import { prefetchPresence } from '../src/watch/presence.ts';

const NOW = Date.parse('2026-10-20T03:00:00Z');
const SESSION = 'crew';
const SEAT = 'writer';
const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';

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

type World = { base: string; root: string; dir: string };

let bases: string[] = [];
let ingesters: PresenceIngester[] = [];
afterEach(async () => {
  for (const ingester of ingesters.splice(0)) {
    try { if (!ingester.isClosed()) await ingester.close(); } catch { /* the scene closed it */ }
  }
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'presence-health-acceptance-')));
  bases.push(base);
  const root = join(base, 'crew');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  return { base, root, dir };
}

function writeState(world: World, state: SessionState): void {
  writeFileSync(
    join(world.dir, 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: state } })}\n`,
  );
}

function worldState(world: World): SessionState {
  return readState(world.dir).sessions[SESSION] ?? emptySession();
}

function seatRecord(world: World): SessionState['seats'][string] | undefined {
  return worldState(world).seats?.[SEAT];
}

function queue(world: World, ids: readonly string[] = ['t1']): void {
  writeFileSync(join(world.dir, 'queue.yaml'), ids.map((id) => `- id: ${id}\n  title: "${id}"\n`).join(''));
}

let nonceCounter = 0;
function stage(world: World, event: 'turn-start' | 'turn-end', ts: string): string {
  nonceCounter += 1;
  const id = presenceId(ts, nonceCounter.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the scene instant is not a presence instant');
  const staged = stagePresenceRecord(world.dir, {
    session: SESSION,
    seat: SEAT,
    binding: BINDING,
    source: 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return id;
}

function ingester(world: World, options: { maxRecords?: number } = {}): PresenceIngester {
  const made = createPresenceIngester({
    stateDir: world.dir,
    session: SESSION,
    now: () => new Date(NOW),
    ...options,
  });
  ingesters.push(made);
  return made;
}

function logPath(world: World): string {
  const paths = presencePaths(world.dir, SESSION, SEAT);
  if (paths === null) throw new Error('the scene seat cannot name a presence folder');
  return paths.log;
}

function spoolIds(world: World): string[] {
  const paths = presencePaths(world.dir, SESSION, SEAT);
  if (paths === null || !existsSync(paths.spool)) return [];
  return readdirSync(paths.spool).filter((name) => name.endsWith('.json')).sort();
}

/**
 * The valid old idle every scene starts from: state with the managed seat and its binding, a real
 * turn-end ingested into the log, then the canonical activity beat that stamps `last_active` and
 * the matching fence. Only the producer and the reconciler write these values.
 */
async function seedOldIdle(world: World): Promise<void> {
  const state = emptySession();
  state.seats[SEAT] = {
    stage: 'ready',
    id: SEAT_ID,
    presence_binding: BINDING,
  } as unknown as SessionState['seats'][string];
  writeState(world, state);
  queue(world);
  stage(world, 'turn-end', at(3600));
  const first = ingester(world);
  const step = await first.step();
  expect(step.healthy).toBe(true);
  expect(step.ingested).toHaveLength(1);
  await first.close();
  const applied = await createPresenceActivity({ stateDir: world.dir, session: SESSION })(new Date(NOW));
  expect(applied.failed).toBeNull();
  const seat = seatRecord(world)!;
  expect(seat.last_active).toBe(at(3600));
  expect(seat.presence_applied).toMatchObject({ seat_id: SEAT_ID, binding: BINDING, seq: 1 });
}

function report(world: World, healthy: boolean) {
  return idleWorkReport({
    root: world.root,
    team,
    state: worldState(world),
    live: null,
    now: new Date(NOW),
    presence: prefetched,
    presenceChannelHealthy: healthy,
  });
}

let prefetched: Awaited<ReturnType<typeof prefetchPresence>> = new Map();

async function prefetch(world: World): Promise<void> {
  prefetched = await prefetchPresence({ stateDir: world.dir, session: SESSION, seatNames: [SEAT] });
}

/** The real projection and fence are coherent here, so only the channel answer can hold them. */
async function expectCoherentOldIdle(world: World): Promise<void> {
  const current = await readPresenceCurrent(world.dir, SESSION, SEAT);
  expect(current.kind).toBe('ok');
  if (current.kind === 'ok') {
    expect(current.value.state).toBe('idle');
    expect(current.value.seq).toBe(1);
  }
  expect(seatRecord(world)!.presence_applied).toMatchObject({ binding: BINDING, seq: 1 });
}

describe('a fatal log holds the old idle across quiet steps', () => {
  test('the fault is reported once, later steps are quiet, and the verdict never turns healthy', async () => {
    const world = makeWorld();
    await seedOldIdle(world);
    writeFileSync(logPath(world), `${readFileSync(logPath(world), 'utf8')}not a presence line\n`);
    const pendingRecord = stage(world, 'turn-start', at(600));

    const fresh = ingester(world);
    const found = await fresh.step();
    expect(found.healthy).toBe(false);
    expect(found.errors.some((entry) => entry.why.includes('not a presence line'))).toBe(true);

    const quiet = await fresh.step();
    expect(quiet.errors).toEqual([]);
    expect(quiet.healthy).toBe(false);
    const quieter = await fresh.step();
    expect(quieter.errors).toEqual([]);
    expect(quieter.healthy).toBe(false);
    expect(presenceStepHealth(quieter)).toBe(false);

    // The spool record cannot be consumed and the projection cannot advance: the old idle is
    // still on disk and its fence still matches it.
    expect(spoolIds(world)).toContain(`${pendingRecord}.json`);
    await expectCoherentOldIdle(world);

    await prefetch(world);
    const held = report(world, presenceStepHealth(quieter));
    expect(held.idle).toEqual([]);
    expect(held.takeable).toBe(0);
    expect(held.presence_unknown).toContain('not known healthy');
  }, 15_000);
});

describe('an unreadable log holds until the source answers again', () => {
  test('quiet steps stay unhealthy, and a fresh pass over the restored log is healthy', async () => {
    const world = makeWorld();
    await seedOldIdle(world);
    const log = logPath(world);
    const aside = `${log}.aside`;
    renameSync(log, aside);
    mkdirSync(log);

    const broken = ingester(world);
    const failed = await broken.step();
    expect(failed.healthy).toBe(false);
    expect(failed.errors.length).toBeGreaterThan(0);
    const quiet = await broken.step();
    expect(quiet.healthy).toBe(false);
    expect(presenceStepHealth(quiet)).toBe(false);

    await prefetch(world);
    expect(report(world, presenceStepHealth(quiet)).idle).toEqual([]);
    await expectCoherentOldIdle(world);

    rmdirSync(log);
    renameSync(aside, log);
    const restored = ingester(world);
    const recovered = await restored.step();
    expect(recovered.healthy).toBe(true);
    expect(recovered.pending).toBe(false);
    expect(presenceStepHealth(recovered)).toBe(true);

    await prefetch(world);
    const authorized = report(world, presenceStepHealth(recovered));
    expect(authorized.presence_unknown).toBeUndefined();
    expect(authorized.idle).toEqual([{ seat: SEAT, since: at(3600), native_since: at(3600), presence_source: 'runtime-hook' }]);
    expect(authorized.takeable).toBe(1);
  }, 15_000);
});

describe('known backlog holds the old idle until the step is caught up', () => {
  test('a pending step is not healthy even with a coherent projection, and the caught-up step is', async () => {
    const world = makeWorld();
    const state = emptySession();
    state.seats[SEAT] = {
      stage: 'ready',
      id: SEAT_ID,
      presence_binding: BINDING,
    } as unknown as SessionState['seats'][string];
    writeState(world, state);
    queue(world);
    stage(world, 'turn-end', at(3600));
    stage(world, 'turn-end', at(1800));

    const one = ingester(world, { maxRecords: 1 });
    const first = await one.step();
    expect(first.ingested).toHaveLength(1);
    expect(first.pending).toBe(true);
    expect(first.healthy).toBe(false);
    expect(presenceStepHealth(first)).toBe(false);
    await createPresenceActivity({ stateDir: world.dir, session: SESSION })(new Date(NOW));
    await prefetch(world);
    // The first projection is a coherent old idle; only the known backlog holds it.
    await expectCoherentOldIdle(world);
    expect(report(world, presenceStepHealth(first)).idle).toEqual([]);

    const second = await one.step();
    expect(second.ingested).toHaveLength(1);
    // A batch that spent its budget has not yet proven there is nothing left.
    expect(second.pending).toBe(true);
    expect(second.healthy).toBe(false);
    await createPresenceActivity({ stateDir: world.dir, session: SESSION })(new Date(NOW));
    await prefetch(world);
    expect(seatRecord(world)!.last_active).toBe(at(1800));
    expect(seatRecord(world)!.presence_applied).toMatchObject({ seq: 2 });
    expect(report(world, presenceStepHealth(second)).idle).toEqual([]);

    const third = await one.step();
    expect(third.ingested).toEqual([]);
    expect(third.pending).toBe(false);
    expect(third.healthy).toBe(true);
    expect(presenceStepHealth(third)).toBe(true);
    await prefetch(world);
    const authorized = report(world, presenceStepHealth(third));
    expect(authorized.presence_unknown).toBeUndefined();
    expect(authorized.idle).toEqual([{ seat: SEAT, since: at(1800), native_since: at(1800), presence_source: 'runtime-hook' }]);
    expect(authorized.takeable).toBe(1);
  }, 15_000);
});

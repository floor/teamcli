// The idle-work dispatcher: one shared snapshot, one attempt per seat per idle episode (a
// refusal spends it), and no legacy typed nudge for an episode the dispatcher owns. A route that
// is missing or refuses leaves one signed runtime record per distinct target (the team lead and
// the main orchestrator) per episode, with the transport's own words kept. Two production
// readings leave nothing to deliver and are announced once each through the same records: an
// empty source with idle seats, and a seat still idle a minute after an accepted wake with no
// read-only evidence of a claim. The last case proves the watch seam itself: the direct route is
// called and nothing is typed into the seat.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plantRecord } from '../src/commands/messages.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { captureIdleClaim, settleIdleClaim } from '../src/watch/claim.ts';
import {
  dispatchIdleWork, forgetIdleEpisodes,
  type IdleDispatchInput, type WorkPush, type WorkPushRequest,
} from '../src/watch/dispatch.ts';
import { testIo } from './helpers.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const WIN = '5.5';

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

// A crew whose entity is named, so the main orchestrator can be mapped from a registry. No
// `tasks:` block: the local queue is the source, as it is for a team that declares none.
const CREW = `format: 1
project: acme-web
entity: acme
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-2
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
`;

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function live(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace] of [['worker-1', 'w1'], ['worker-2', 'w2']] as const) {
    const change = over[name] ?? {};
    agents.push({ name, agent: 'claude', pane: `${workspace}:p1`, workspace, status: change.status ?? 'idle', cwd: null });
    screens[`${workspace}:p1`] = change.screen ?? idle;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

function stateAt(stamp: string, seats: readonly string[] = ['worker-1', 'worker-2']): SessionState {
  const state = emptySession();
  for (const seat of seats) state.seats[seat] = { stage: 'ready', last_active: stamp };
  return state;
}

let base: string;
let root: string;
let entityRoot: string;
let home: string;
let defaultState: SessionState;
// The snapshot most recently written to the state file. The dispatcher reads the session fresh
// from the file every pass, as the watch does; a test that hands `input()` a different snapshot
// object reseeds it, and a pass that only moves the clock leaves the file (claims included) as
// the previous pass wrote it.
let seeded: SessionState | undefined;
// Set by `handWritten`: the state file is the test's own, and `input()` must not reseed it.
let frozen = false;

// The crew's root, the entity's own root and a home with the registry that names both. With
// `withMain` false the registry names only the crew, so the main orchestrator cannot be mapped.
function scratch(withMain = true): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-dispatch-')));
  root = join(base, 'crew');
  entityRoot = join(base, 'entity');
  home = join(base, 'home');
  seeded = undefined;
  frozen = false;
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  upsertTeam(home, teamIdOf(root), {
    project: 'acme-web',
    entity: 'acme',
    session: 'crew',
    root,
    roster: [{ agent: 'agt_crew000000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  if (withMain) {
    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'acme',
      entity: 'acme',
      session: 'acme',
      root: entityRoot,
      roster: [{ agent: 'agt_head000000', seat: 'head-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
  }
}

function queue(records: { id: string; title: string }[]): void {
  writeFileSync(join(root, '.agents', 'queue.yaml'), records.map((record) => `- id: ${record.id}\n  title: "${record.title}"\n`).join(''));
}

function input(extra: Partial<IdleDispatchInput> = {}): IdleDispatchInput {
  const team = extra.team ?? teamOf(CREW);
  const wanted = extra.state ?? defaultState;
  if (!frozen && wanted !== seeded) {
    writeFileSync(
      join(root, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: { [team.session]: wanted } }, null, 2)}\n`,
    );
    seeded = wanted;
  }
  // The pass snapshot is the file's session, as the watch reads it fresh each pass, so a claim
  // an earlier pass wrote is in it.
  const state = readState(join(root, '.agents')).sessions[team.session] ?? emptySession();
  const built: IdleDispatchInput = {
    root,
    dir: join(root, '.agents'),
    team,
    state,
    live: live(),
    now: new Date(NOW),
    home,
    body: (seat) => `body for ${seat}`,
    ...extra,
  };
  // The snapshot and the state directory are the harness's, never a test's: `extra.state` names
  // the record to seed, not a stale snapshot to dispatch over.
  built.state = state;
  built.dir = join(root, '.agents');
  return built;
}

function recordsIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

/** Writes one session record to the state file by hand, as another writer or an older build
 *  could have left it, and keeps `input()` from reseeding over it. */
function handWritten(session: unknown): void {
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { crew: session } }, null, 2)}\n`,
  );
  seeded = undefined;
  frozen = true;
}

beforeEach(() => {
  forgetIdleEpisodes();
  scratch(true);
  defaultState = stateAt(new Date(NOW - 10 * MIN).toISOString());
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

describe('one attempt per eligible idle episode', () => {
  test('each idle seat is pushed once with its pane, cli and rendered body, and the outcome is kept verbatim', async () => {
    queue([{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }]);
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const first = await dispatchIdleWork(input({ push }));
    expect(calls.map((one) => one.seat).sort()).toEqual(['worker-1', 'worker-2']);
    expect(calls.every((one) => one.body === `body for ${one.seat}`)).toBe(true);
    expect(calls.find((one) => one.seat === 'worker-1')).toEqual({
      seat: 'worker-1', pane: 'w1:p1', cli: 'claude-code', body: 'body for worker-1',
    });
    expect(first.pushed).toEqual([
      { seat: 'worker-1', ok: true, outcome: 'typed (unconfirmed)' },
      { seat: 'worker-2', ok: true, outcome: 'typed (unconfirmed)' },
    ]);
    expect(first.suppressed?.sort()).toEqual(['worker-1', 'worker-2']);
    expect(first.fallback).toBeUndefined();

    const second = await dispatchIdleWork(input({ push, now: new Date(NOW + MIN) }));
    expect(second.pushed).toEqual([]);
    expect(second.suppressed?.sort()).toEqual(['worker-1', 'worker-2']);
    expect(calls).toHaveLength(2);
  });

  test('a durable copy is not flattened into a wake: the route names its own outcome', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const push: WorkPush = async () => ({ ok: true, outcome: 'durable copy only (not read)' });
    const result = await dispatchIdleWork(input({ push, state: stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']) }));
    expect(result.pushed).toEqual([{ seat: 'worker-1', ok: true, outcome: 'durable copy only (not read)' }]);
  });

  test('a refusal spends the episode and leaves one signed record for the lead and one for the main', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: false, refused: 'the pane holds a dialog' };
    };
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const first = await dispatchIdleWork(input({ push, state: one }));
    expect(first.pushed).toEqual([{ seat: 'worker-1', ok: false, refused: 'the pane holds a dialog' }]);
    expect(first.fallback?.failed).toEqual([]);
    expect(first.fallback?.missing).toEqual([]);

    const lead = recordsIn(join(root, '.agents', 'messages', 'crew-lead'));
    const main = recordsIn(join(entityRoot, '.agents', 'messages', 'head-lead'));
    expect(lead).toHaveLength(1);
    expect(main).toHaveLength(1);
    const leadPath = join(root, '.agents', 'messages', 'crew-lead', lead[0]!);
    const leadRecord = JSON.parse(readFileSync(leadPath, 'utf8')) as {
      payload: { to: string; session: string; from: string; body: string };
    };
    expect(leadRecord.payload.to).toBe('crew-lead');
    expect(leadRecord.payload.session).toBe('crew');
    expect(leadRecord.payload.from).toBe('runtime');
    expect(leadRecord.payload.body).toContain('worker-1 is idle with takeable work but was not told directly');
    expect(leadRecord.payload.body).toContain('the pane holds a dialog');
    expect(statSync(leadPath).mode & 0o777).toBe(0o600);
    const mainRecord = JSON.parse(
      readFileSync(join(entityRoot, '.agents', 'messages', 'head-lead', main[0]!), 'utf8'),
    ) as { payload: { to: string; session: string; body: string } };
    expect(mainRecord.payload.to).toBe('head-lead');
    expect(mainRecord.payload.session).toBe('acme');
    expect(mainRecord.payload.body).toContain('worker-1');

    const second = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + MIN) }));
    expect(second.pushed).toEqual([]);
    expect(second.fallback).toBeUndefined();
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);

    // The seat works: the episode ends. Idle again: a new attempt, and the stable id keeps the
    // first fallback record from being written a second time.
    await dispatchIdleWork(input({ push, state: one, live: live({ 'worker-1': { status: 'working', screen: busy } }) }));
    const again = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 2 * MIN) }));
    expect(again.pushed).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });

  test('a throwing route is a refusal, not a crash, and still spends the episode', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      throw new Error('herdr hung up');
    };
    const first = await dispatchIdleWork(input({ push, state: one }));
    expect(first.pushed).toEqual([{ seat: 'worker-1', ok: false, refused: 'herdr hung up' }]);
    await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + MIN) }));
    expect(calls).toBe(1);
  });
});

describe('a route that is absent or unmappable', () => {
  test('push absent dispatches nothing, types nothing, spends the episode and says the route is not wired', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const first = await dispatchIdleWork(input({ state: one }));
    expect(first.pushed).toEqual([{ seat: 'worker-1', ok: false, refused: 'no direct work route is wired' }]);
    expect(first.suppressed).toEqual(['worker-1']);
    expect(first.fallback?.written).toHaveLength(2);
    const second = await dispatchIdleWork(input({ state: one, now: new Date(NOW + MIN) }));
    expect(second.pushed).toEqual([]);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });

  test('the main orchestrator the registry cannot map is reported missing, never replaced', async () => {
    scratch(false);
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const result = await dispatchIdleWork(input({
      state: one,
      push: async () => ({ ok: false, refused: 'no route' }),
    }));
    expect(result.fallback?.written).toHaveLength(1);
    expect(result.fallback?.written[0]).toContain(join(root, '.agents', 'messages', 'crew-lead'));
    expect(result.fallback?.missing).toEqual([
      'the main orchestrator was not told: the registry maps no entity lead for this team',
    ]);
    expect(recordsIn(join(entityRoot, '.agents', 'messages', 'head-lead'))).toHaveLength(0);
  });

  test('a lead that is also the main orchestrator is one canonical target and gets one record', async () => {
    // The crew is registered as the entity's own team (its project is the entity), so the
    // registry maps the entity lead to the crew lead in the same root and session. The second
    // root stops being the entity's own team, so exactly one target is left to map.
    upsertTeam(home, teamIdOf(entityRoot), {
      project: 'headquarters',
      entity: 'acme',
      session: 'acme',
      root: entityRoot,
      roster: [{ agent: 'agt_head000000', seat: 'head-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      entity: 'acme',
      session: 'crew',
      root,
      roster: [{ agent: 'agt_crew000000', seat: 'crew-lead', role: 'coordinator', leads: true }],
      lifecycle: 'running',
    });
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const result = await dispatchIdleWork(input({
      state: one,
      push: async () => ({ ok: false, refused: 'no route' }),
    }));
    expect(result.fallback?.written).toHaveLength(1);
    expect(result.fallback?.missing).toEqual([]);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });
});

describe('readings no dispatcher may act on', () => {
  test('an unknown idle threshold dispatches nothing and resets no episode', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    // A hand-written policy entry has no signature: the window in force is unknown.
    const broken = teamOf(`${CREW}\npolicies:\n  idle-threshold: 90s\n`);
    const result = await dispatchIdleWork(input({ push, team: broken }));
    expect(result.pushed).toEqual([]);
    expect(result.suppressed).toBeUndefined();
    expect(calls).toEqual([]);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(0);
  });

  test('a named source that cannot be read dispatches nothing', async () => {
    const missing = teamOf(`${CREW}\ntasks:\n  source: file\n  path: .agents/tasks.yaml\n`);
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const result = await dispatchIdleWork(input({ push, team: missing }));
    expect(result.pushed).toEqual([]);
    expect(result.suppressed).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('zero takeable work dispatches nothing and ends the episode, so later work is attempted', async () => {
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const empty = await dispatchIdleWork(input({ push }));
    expect(empty.pushed).toEqual([]);
    expect(empty.fallback?.written).toHaveLength(2); // the empty-source notice, not a push
    queue([{ id: 't1', title: 'First' }]);
    const later = await dispatchIdleWork(input({ push, now: new Date(NOW + MIN) }));
    expect(later.pushed.map((one) => one.seat).sort()).toEqual(['worker-1', 'worker-2']);
  });

  test('a paused team and a seat holding a queued swap are not pushed', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const paused: IdleDispatchInput['pause'] = {
      by: 'owner', at: new Date(NOW - MIN).toISOString(), stops: [],
    };
    expect((await dispatchIdleWork(input({ push, pause: paused }))).pushed).toEqual([]);
    forgetIdleEpisodes();
    const swapped = await dispatchIdleWork(input({ push, swaps: ['worker-1', 'worker-2'] }));
    expect(swapped.pushed).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('an empty source', () => {
  test('idle seats with nothing queued give one aggregate notice per continuous empty stretch', async () => {
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const first = await dispatchIdleWork(input({ push }));
    expect(first.pushed).toEqual([]);
    expect(first.fallback?.failed).toEqual([]);
    expect(first.fallback?.missing).toEqual([]);
    expect(first.fallback?.written).toHaveLength(2);
    const lead = recordsIn(join(root, '.agents', 'messages', 'crew-lead'));
    expect(lead).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(root, '.agents', 'messages', 'crew-lead', lead[0]!), 'utf8')) as {
      payload: { from: string; to: string; body: string };
    };
    expect(record.payload.from).toBe('runtime');
    expect(record.payload.to).toBe('crew-lead');
    expect(record.payload.body).toBe('acme-web: 2 idle, nothing queued (worker-1, worker-2)');

    // The same stretch, a later pass: no second notice.
    const second = await dispatchIdleWork(input({ push, now: new Date(NOW + MIN) }));
    expect(second.fallback).toBeUndefined();
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);

    // Work arrives and is taken: the stretch ends.
    queue([{ id: 't1', title: 'First' }]);
    const worked = await dispatchIdleWork(input({ push, now: new Date(NOW + 2 * MIN) }));
    expect(worked.pushed).toHaveLength(2);
    expect(worked.fallback).toBeUndefined();

    // Empty again, same seats: a new stretch is a new notice, written under a new id.
    rmSync(join(root, '.agents', 'queue.yaml'));
    const third = await dispatchIdleWork(input({ push, now: new Date(NOW + 3 * MIN) }));
    expect(third.fallback?.written).toHaveLength(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(2);
  });

  test('no idle seat, an unknown window or an unreadable source announces nothing', async () => {
    // Everyone is working: an empty source is not news.
    const working = live({ 'worker-1': { status: 'working', screen: busy }, 'worker-2': { status: 'working', screen: busy } });
    expect((await dispatchIdleWork(input({ live: working }))).fallback).toBeUndefined();
    // Readings no dispatcher may act on: an unknown window and a source it cannot read.
    const broken = teamOf(`${CREW}\npolicies:\n  idle-threshold: 90s\n`);
    expect((await dispatchIdleWork(input({ team: broken }))).fallback).toBeUndefined();
    const missing = teamOf(`${CREW}\ntasks:\n  source: file\n  path: .agents/tasks.yaml\n`);
    expect((await dispatchIdleWork(input({ team: missing }))).fallback).toBeUndefined();
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(0);
  });
});

describe('a failed pickup', () => {
  test('an accepted wake still idle a minute later is announced once and never woken again', async () => {
    queue([{ id: 't1', title: 'First' }]);
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const first = await dispatchIdleWork(input({ push, state: one }));
    expect(first.pushed).toHaveLength(1);

    // Half a minute in, the grace has not elapsed: nothing is said.
    const early = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 30_000) }));
    expect(early.pushed).toEqual([]);
    expect(early.fallback).toBeUndefined();

    // A minute in, still idle with no lease and no activity: one announcement, once.
    const late = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 61_000) }));
    expect(late.pushed).toEqual([]);
    expect(late.fallback?.failed).toEqual([]);
    expect(late.fallback?.missing).toEqual([]);
    expect(late.fallback?.written).toHaveLength(2);
    const lead = recordsIn(join(root, '.agents', 'messages', 'crew-lead'));
    expect(lead).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(root, '.agents', 'messages', 'crew-lead', lead[0]!), 'utf8')) as {
      payload: { from: string; to: string; body: string };
    };
    expect(record.payload.from).toBe('runtime');
    expect(record.payload.to).toBe('crew-lead');
    expect(record.payload.body).toContain('worker-1');
    expect(record.payload.body).toContain('still idle with no observed claim');

    // No retry and no second notice for the same idle episode.
    const later = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 10 * MIN) }));
    expect(later.pushed).toEqual([]);
    expect(later.fallback).toBeUndefined();
    expect(calls).toBe(1);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });

  test('a live lease held by the woken seat is a claim, so the pickup is not reported', async () => {
    queue([{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }]);
    const push: WorkPush = async () => ({ ok: true, outcome: 'typed (unconfirmed)' });
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    await dispatchIdleWork(input({ push, state: one }));
    // The seat claimed t2 the way `team next` does: a live lease in this clone. t1 stays takeable.
    mkdirSync(join(root, '.agents', 'leases'), { recursive: true });
    writeFileSync(join(root, '.agents', 'leases', 't2.json'), `${JSON.stringify({
      format: 1, id: 't2', seat: 'worker-1', pane: 'w1:p1',
      acquiredAt: new Date(NOW).toISOString(), renewedAt: new Date(NOW).toISOString(),
      until: new Date(NOW + 10 * MIN).toISOString(),
    }, null, 2)}\n`);
    const late = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 61_000) }));
    expect(late.pushed).toEqual([]);
    expect(late.fallback).toBeUndefined();
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(0);
  });

  test('leaving eligibility cancels the pending pickup, and the seat is woken again when idle', async () => {
    queue([{ id: 't1', title: 'First' }]);
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    await dispatchIdleWork(input({ push, state: one }));
    // The seat starts a turn: it leaves its idle episode, which cancels the pending check.
    await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 30_000), live: live({ 'worker-1': { status: 'working', screen: busy } }) }));
    // Idle again past the old grace: a new episode, a new attempt, and no failed-pickup notice.
    const again = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 61_000) }));
    expect(again.pushed).toHaveLength(1);
    expect(again.fallback).toBeUndefined();
    expect(calls).toBe(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(0);
  });

  test('a refused route never counts as a wake that failed pickup', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const push: WorkPush = async () => ({ ok: false, refused: 'the pane holds a dialog' });
    await dispatchIdleWork(input({ push, state: one }));
    const late = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 10 * MIN) }));
    expect(late.fallback).toBeUndefined();
    // Only the refusal's own record is there.
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });
});

describe('a durable episode claim', () => {
  test('a watch restart never pushes the same episode twice', async () => {
    queue([{ id: 't1', title: 'First' }]);
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const first = await dispatchIdleWork(input({ push, state: one }));
    expect(first.pushed).toHaveLength(1);
    // The seam a watch restart passes through: every in-process memory is gone, the state file
    // is not, and the persisted last_active names the same episode.
    forgetIdleEpisodes();
    const second = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 10_000) }));
    expect(second.pushed).toEqual([]);
    expect(calls).toBe(1);
    // Past the pickup grace the episode is followed, never re-attempted.
    const late = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 61_000) }));
    expect(late.pushed).toEqual([]);
    expect(calls).toBe(1);
    expect(late.fallback?.written).toHaveLength(2); // the failed-pickup notice, once
  });

  test('a refusal survives a restart: the episode stays spent and its notice is replayed, not lost', async () => {
    queue([{ id: 't1', title: 'First' }]);
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: false, refused: 'the pane holds a dialog' };
    };
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    await dispatchIdleWork(input({ push, state: one }));
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);

    forgetIdleEpisodes();
    const second = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + MIN) }));
    expect(second.pushed).toEqual([]);
    expect(calls).toBe(1);
    // The claim still owes the notice: the replay names the same `once: true` record.
    expect(second.fallback?.written).toHaveLength(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });

  test('a capture with no recorded outcome is held, never retried, and says so once after the grace', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const since = one.seats['worker-1']?.last_active ?? '';
    const first = input({ state: one }); // seeds the state file the claim is written to
    const captured = captureIdleClaim(first.dir, {
      session: 'crew', seat: 'worker-1', idle_since: since, at: new Date(NOW - 2 * MIN),
    });
    expect(captured.kind).toBe('captured');
    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };

    const held = await dispatchIdleWork(input({ push, state: one }));
    expect(held.pushed).toEqual([]);
    expect(calls).toBe(0);
    expect(held.fallback?.written).toHaveLength(2);
    const lead = recordsIn(join(root, '.agents', 'messages', 'crew-lead'));
    expect(lead).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(root, '.agents', 'messages', 'crew-lead', lead[0]!), 'utf8')) as {
      payload: { body: string };
    };
    expect(record.payload.body).toContain('no recorded outcome');
    expect(record.payload.body).not.toContain('accepted');

    // A later pass in this process does not repeat it; a restart replays the same record.
    expect((await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + MIN) }))).fallback).toBeUndefined();
    forgetIdleEpisodes();
    const restarted = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 2 * MIN) }));
    expect(restarted.pushed).toEqual([]);
    expect(restarted.fallback?.written).toHaveLength(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
    expect(calls).toBe(0);
    // Still pending, with its one notice: held, never retried.
    expect(readState(first.dir).sessions.crew?.idle_claims?.['worker-1']).toMatchObject({
      state: 'pending', notice: 'unknown',
    });
  });

  test('a refusal settled before its publication is published by the next pass, once', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const one = stateAt(new Date(NOW - 10 * MIN).toISOString(), ['worker-1']);
    const since = one.seats['worker-1']?.last_active ?? '';
    const first = input({ state: one }); // seeds the state file the claim is written to
    const captured = captureIdleClaim(first.dir, { session: 'crew', seat: 'worker-1', idle_since: since, at: new Date(NOW) });
    if (captured.kind !== 'captured') throw new Error(`expected a capture, got ${captured.kind}`);
    // A stop between the settle and the announcement: the claim holds the intent, and no record
    // was left yet.
    settleIdleClaim(first.dir, {
      session: 'crew', seat: 'worker-1', idle_since: since, claim_id: captured.claim.claim_id,
      at: new Date(NOW), outcome: 'refused',
    });
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(0);

    let calls = 0;
    const push: WorkPush = async () => {
      calls += 1;
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const published = await dispatchIdleWork(input({ push, state: one, now: new Date(NOW + 1_000) }));
    expect(published.pushed).toEqual([]);
    expect(calls).toBe(0);
    expect(published.fallback?.written).toHaveLength(2);
    expect(recordsIn(join(root, '.agents', 'messages', 'crew-lead'))).toHaveLength(1);
  });

  test('a malformed claim is a hold, not an absence, until the episode ends', async () => {
    queue([{ id: 't1', title: 'First' }]);
    const stamp = new Date(NOW - 10 * MIN).toISOString();
    handWritten({
      seats: {
        'worker-1': { stage: 'ready', last_active: stamp },
        'worker-2': { stage: 'ready', last_active: stamp },
      },
      worktrees: {},
      idle_claims: { 'worker-1': { state: 'pending' } },
    });
    const calls: string[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request.seat);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const first = await dispatchIdleWork(input({ push }));
    expect(calls).toEqual(['worker-2']);
    expect(first.pushed.map((one) => one.seat)).toEqual(['worker-2']);

    // The seat starts a turn: the episode ends and releases the malformed presence. Idle again
    // is a new episode, and it is attempted.
    await dispatchIdleWork(input({ push, now: new Date(NOW + 30_000), live: live({ 'worker-1': { status: 'working', screen: busy } }) }));
    const again = await dispatchIdleWork(input({ push, now: new Date(NOW + MIN) }));
    expect(again.pushed.map((one) => one.seat)).toEqual(['worker-1']);
    expect(calls.sort()).toEqual(['worker-1', 'worker-2']);
    expect(readState(join(root, '.agents')).sessions.crew?.idle_claims?.['worker-1']).toBeDefined();
  });
});

// The seam: a full watch pass over the example team, with the local queue holding work and both
// workers recorded idle past the window. The dispatcher's route is called and the legacy typed
// work nudge never reaches the pane; with no route wired nothing is typed either.
describe('the watch seam', () => {
  const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
  let dir: string;
  let file: string;
  let typed: string[];
  let screenNow: string;
  let clock: number;
  let pushed: WorkPushRequest[];

  function sources(over: Partial<WatchSources> = {}): WatchSources {
    let left = 2;
    const scene: Live = {
      running: true,
      agents: [
        { name: 'deepseek-acme', agent: 'claude', pane: 'first:pane', workspace: 'first', status: 'idle', cwd: null },
        { name: 'deepseek-acme-2', agent: 'claude', pane: 'second:pane', workspace: 'second', status: 'idle', cwd: null },
      ],
      workspaces: [{ id: 'first', label: 'first' }, { id: 'second', label: 'second' }],
      screens: { 'first:pane': idle, 'second:pane': idle },
    };
    return {
      live: () => scene,
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => screenNow,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = text.includes('Read ') ? idle : text; return true; },
      pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
      sleep: async (ms) => { clock += ms; },
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => { clock += 10 * MIN; return --left > 0; },
      alive: () => false,
      pid: 4242,
      home: dir,
      ...over,
    };
  }

  beforeEach(() => {
    forgetIdleEpisodes();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-dispatch-')));
    execSync('git init -q', { cwd: dir });
    mkdirSync(join(dir, '.agents'));
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, raw.replace('watch:\n', 'watch:\n  nudge: Take the next unfinished item in your queue and start it.\n'));
    writeFileSync(join(dir, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
    const old = new Date(Date.parse('2026-10-03T13:00:00Z')).toISOString();
    writeFileSync(join(dir, '.agents', 'team.state.json'), `${JSON.stringify({
      format: 1,
      sessions: {
        'acme-web': {
          seats: {
            'deepseek-acme': { stage: 'ready', last_active: old },
            'deepseek-acme-2': { stage: 'ready', last_active: old },
          },
          worktrees: {},
        },
      },
    })}\n`);
    typed = [];
    pushed = [];
    screenNow = idle;
    clock = Date.parse('2026-10-03T14:00:00Z');
  });

  afterEach(() => {
    forgetIdleEpisodes();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A signed owner message left unread in one seat's drop folder, as a send would leave it. */
  function waitingMail(id: string, to: string): void {
    plantRecord(dir, dir, 'acme-web', to, id, 'from the owner — admitted by: the owner\n\nread this and report', {
      from: 'owner', rule: 'the owner writes to any seat', at: new Date(clock).toISOString(),
    });
  }

  test('the direct route is called for each idle episode and no work drop is typed', async () => {
    const pushWork: WorkPush = async (request) => {
      pushed.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources({ pushWork }));
    expect(code).toBe(0);
    expect(pushed.map((one) => one.seat).sort()).toEqual(['deepseek-acme', 'deepseek-acme-2']);
    expect(pushed.every((one) => one.body.includes('Take the next unfinished item'))).toBe(true);
    expect(typed.filter((line) => line.includes('and do that.'))).toEqual([]);
    expect(existsSync(join(dir, '.agents', 'send-drops', 'acme-web', 'deepseek-acme'))).toBe(false);
  });

  test('with no route wired nothing is typed for the episode and the fallback record is left', async () => {
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources());
    expect(code).toBe(0);
    expect(typed.filter((line) => line.includes('and do that.'))).toEqual([]);
    expect(existsSync(join(dir, '.agents', 'send-drops', 'acme-web', 'deepseek-acme'))).toBe(false);
    expect(recordsIn(join(dir, '.agents', 'messages', 'claude-coordinator-acme'))).toHaveLength(2);
  });

  test('an unread record does not ring a seat whose work episode the dispatcher owns', async () => {
    waitingMail('ring-1', 'deepseek-acme');
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources());
    expect(code).toBe(0);
    // The queue holds t1 and no route is wired: the seat's episode is the dispatcher's, and its
    // undelivered outcome is announced there. The unread record waits for its seat; it never
    // becomes a second typed path into the same episode.
    expect(typed.filter((line) => line.includes('Team: run team drops --read'))).toEqual([]);
    expect(recordsIn(join(dir, '.agents', 'messages', 'claude-coordinator-acme'))).toHaveLength(2);
  });

  test('a stamped idle seat outside any work episode is still rung', async () => {
    rmSync(join(dir, '.agents', 'queue.yaml'));
    waitingMail('ring-3', 'deepseek-acme-2');
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources());
    expect(code).toBe(0);
    // The guard is narrow: with nothing to dispatch and a truthful clock, the mail ring is the
    // one typed path left, and it types.
    expect(typed.some((line) => line.includes('Team: run team drops --read --seat deepseek-acme-2'))).toBe(true);
  });
});

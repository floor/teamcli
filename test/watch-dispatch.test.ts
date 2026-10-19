// The idle-work dispatcher: one shared snapshot, one attempt per seat per idle episode (a
// refusal spends it), and no legacy typed nudge for an episode the dispatcher owns. A route that
// is missing or refuses leaves one signed runtime record per distinct target (the team lead and
// the main orchestrator) per episode, with the transport's own words kept. The last case proves
// the watch seam itself: the direct route is called and nothing is typed into the seat.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
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

// The crew's root, the entity's own root and a home with the registry that names both. With
// `withMain` false the registry names only the crew, so the main orchestrator cannot be mapped.
function scratch(withMain = true): void {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-dispatch-')));
  root = join(base, 'crew');
  entityRoot = join(base, 'entity');
  home = join(base, 'home');
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
  return {
    root,
    team,
    state: stateAt(new Date(NOW - 10 * MIN).toISOString()),
    live: live(),
    now: new Date(NOW),
    home,
    body: (seat) => `body for ${seat}`,
    ...extra,
  };
}

function recordsIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

beforeEach(() => {
  forgetIdleEpisodes();
  scratch(true);
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
    expect(empty.fallback).toBeUndefined();
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
});

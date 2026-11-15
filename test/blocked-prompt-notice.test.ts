// A seat stopped at a dialog reaches its lead in the mailbox the lead's turn reads. A hosted
// watch sends the daemon's own notice for a prompt and for a screen nobody recognises, each under
// its own id, so a seat whose cause changes is told again; the climb after the escalation window
// and one reminder after a long stretch go the same way when the entity's lead is the team's own
// lead. Nothing here answers a dialog: every line is a report. Screens, homes and panes are
// synthetic.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { holdClimb, HELD_CLIMB_STALE_MS, hostedClimbTakes, loadHeldClimbs, releaseHeldClimb, runWatch, screenExcerpt, supersededClimbs } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import { unreadMachine } from '../src/watch/machine.ts';
import {
  createSeatStatusEngine,
  PROMPT_REMINDER_MS,
  type StatusClimb,
  type StatusSource,
} from '../src/watch/status-events.ts';
import { withHostedLoop } from './helpers/hosted-watch.ts';
import { owner, world } from './send-native-fixtures.ts';

const GROK_PERMISSION = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.77', 'permission.txt'), 'utf8');
const MIN = 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function team(): TeamFile {
  const parsed = validateTeamFile(`format: 1
project: crew
coordinator: lead
operator: lead
session: crew
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: worker
    name: worker-1
    cli: grok
    vendor: test
    model: Test
    version: "1"
    launch: grok
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

const blockedSource = (): StatusSource => ({
  waitStatus: async () => ({ outcome: 'timeout', at: 0 }),
  promptReading: () => ({ kind: 'unknown', text: null }),
});

test('the excerpt is the last rows the pane shows, without the frame marks, and null with no screen', () => {
  const live: Live = {
    running: true,
    agents: [{ name: 'worker-1', agent: 'grok', pane: 'p1', workspace: 'w', status: 'blocked', cwd: '/x' }],
    workspaces: [],
    screens: { p1: GROK_PERMISSION },
  };
  const shown = screenExcerpt(live, 'worker-1');
  expect(shown).not.toBeNull();
  const rows = (shown as string).split('\n');
  expect(rows.length).toBeLessThanOrEqual(8);
  expect(shown).toContain('2 (●) Yes, proceed');
  expect(shown).toContain('1/3:select');
  expect(shown).not.toContain('┃');
  expect(screenExcerpt(live, 'nobody')).toBeNull();
  expect(screenExcerpt(null, 'worker-1')).toBeNull();
  expect(screenExcerpt({ ...live, screens: {} }, 'worker-1')).toBeNull();
});

test('a hosted climb is taken to this team\'s own lead, or across teams to the entity\'s orchestrator', () => {
  const crew = team();
  const climb = (seat: string, root: string, session: string): StatusClimb => ({
    seat: 'worker-1', id: 'evt-prompt-climb-x', text: 'crew: x', target: { seat, root, session },
  });
  expect(hostedClimbTakes(climb('lead', '/r/crew', 'crew'), '/r/crew', 'crew', crew)).toBe(true);
  // 2026-11-15: a climb to the entity's orchestrator in another checkout went to a runtime record
  // nobody reads. It now goes out as the daemon's notice to that seat's real inbox.
  expect(hostedClimbTakes(climb('orchestrator', '/r/other', 'other'), '/r/crew', 'crew', crew)).toBe(true);
  expect(hostedClimbTakes(climb('', '/r/other', 'other'), '/r/crew', 'crew', crew)).toBe(false);
  expect(hostedClimbTakes(climb('lead', '/r/crew', 'other'), '/r/crew', 'crew', crew)).toBe(false);
  expect(hostedClimbTakes(climb('worker-1', '/r/crew', 'crew'), '/r/crew', 'crew', crew)).toBe(false);
});

test('an unrecognised prompt escalates, then reminds once after the long window, and a taken climb writes no runtime record', async () => {
  const climbs: StatusClimb[] = [];
  const crew = team();
  // The team is its own entity: its lead is the entity's lead, as a main team's is.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'blocked-prompt-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'crew');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  upsertTeam(home, teamIdOf(root), {
    project: 'crew',
    entity: 'crew',
    session: 'crew',
    root,
    roster: [{ agent: 'agt_lead00000000', seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  let clock = Date.parse('2026-11-14T18:18:00.000Z');
  const engine = createSeatStatusEngine({
    team: crew,
    root,
    home,
    source: blockedSource(),
    now: () => clock,
    promptEscalationSeconds: 300,
    promptReminderMs: 60 * MIN,
    deliverClimb: (climb) => {
      climbs.push(climb);
      return true;
    },
  });
  await engine.observe('worker-1', 'blocked', clock, 'p1', GROK_PERMISSION.replace(/1\/3:select/, 'xx'));
  clock += 5 * MIN;
  const escalated = await engine.tick(clock);
  expect(escalated.map((event) => event.input.record_id).filter((id) => id.startsWith('status:prompt-escalated:'))).toHaveLength(1);
  expect(climbs).toHaveLength(1);
  expect(climbs[0]?.target.seat).toBe('lead');
  expect(climbs[0]?.text).toContain('worker-1 is still at a blocked prompt after 5 minutes');
  expect(escalated.flatMap((event) => event.escalatedMailboxPaths)).toHaveLength(0);
  expect(existsSync(join(root, '.agents', 'messages', 'lead'))).toBe(false);
  clock += 30 * MIN;
  expect((await engine.tick(clock)).filter((event) => event.input.record_id.startsWith('status:prompt-reminder:'))).toHaveLength(0);
  clock += 30 * MIN;
  const reminded = (await engine.tick(clock)).filter((event) => event.input.record_id.startsWith('status:prompt-reminder:'));
  expect(reminded).toHaveLength(1);
  expect(reminded[0]?.input.reason).toContain('worker-1 is still at a blocked prompt after 65 minutes');
  expect(reminded[0]?.escalatedMailboxPaths).toHaveLength(0);
  expect(climbs).toHaveLength(2);
  expect(climbs[1]?.text).toContain('a reminder, the only one for this prompt');
  clock += 120 * MIN;
  expect((await engine.tick(clock)).filter((event) => event.input.record_id.startsWith('status:prompt-reminder:'))).toHaveLength(0);
  expect(climbs).toHaveLength(2);
  expect(PROMPT_REMINDER_MS).toBe(60 * MIN);
});

function entityWorld(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'blocked-prompt-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'crew');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  upsertTeam(home, teamIdOf(root), {
    project: 'crew',
    entity: 'crew',
    session: 'crew',
    root,
    roster: [{ agent: 'agt_lead00000000', seat: 'lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  return { root, home };
}

test('an overdue tick raises the escalation and the reminder under two mailbox identities', async () => {
  const climbs: StatusClimb[] = [];
  const { root, home } = entityWorld();
  let clock = Date.parse('2026-11-14T18:18:00.000Z');
  const engine = createSeatStatusEngine({
    team: team(),
    root,
    home,
    source: blockedSource(),
    now: () => clock,
    promptEscalationSeconds: 300,
    promptReminderMs: 60 * MIN,
    deliverClimb: (climb) => {
      climbs.push(climb);
      return true;
    },
  });
  await engine.observe('worker-1', 'blocked', clock, 'p1', '');
  clock += 90 * MIN;
  const emitted = await engine.tick(clock);
  expect(emitted.filter((event) => event.input.kind === 'seat.prompt-escalated')).toHaveLength(2);
  expect(climbs).toHaveLength(2);
  expect(new Set(climbs.map((climb) => climb.id)).size).toBe(2);
  expect(climbs.some((climb) => climb.id.startsWith('evt-prompt-remind-worker-1-'))).toBe(true);
});

test('the lead\'s own prompt climbs at once and is never reminded', async () => {
  const climbs: StatusClimb[] = [];
  const { root, home } = entityWorld();
  let clock = Date.parse('2026-11-14T18:18:00.000Z');
  const engine = createSeatStatusEngine({
    team: team(),
    root,
    home,
    source: blockedSource(),
    now: () => clock,
    promptEscalationSeconds: 300,
    promptReminderMs: 60 * MIN,
    deliverClimb: (climb) => {
      climbs.push(climb);
      return true;
    },
  });
  await engine.observe('lead', 'blocked', clock, 'p0', '');
  clock += 3 * 60 * MIN;
  const emitted = await engine.tick(clock);
  expect(emitted.filter((event) => event.input.record_id.startsWith('status:prompt-reminder:'))).toHaveLength(0);
  expect(climbs.filter((climb) => climb.id.startsWith('evt-prompt-remind-'))).toHaveLength(0);
});

test('a hosted watch tells the lead a grok seat waits at its command approval, with the screen, once', async () => {
  const when = new Date('2026-11-14T18:18:00.000Z');
  const made = world(null, [{ name: 'gravel', role: 'implementer', cli: 'grok', launch: 'grok' }]);
  cleanups.push(made.cleanup);
  updateState(made.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.gravel = {
      stage: 'ready',
      cli: 'grok',
      pane: 'pane-gravel',
      last_active: when.toISOString(),
      launched: { shell: 31, cli: [32] },
    };
  });
  const live: Live = {
    running: true,
    agents: [{ name: 'gravel', agent: 'grok', pane: 'pane-gravel', workspace: 'gravel', status: 'blocked', cwd: made.root }],
    workspaces: [],
    screens: { 'pane-gravel': GROK_PERMISSION },
    processes: { 'pane-gravel': { shell: 31, foreground: [32] } },
    foreground: { 'pane-gravel': ['grok'] },
  };
  forgetIdleEpisodes();
  writeDaemonState(made.home, {
    format: 1,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: when.toISOString(),
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: when.toISOString(),
    socket: join(made.home, 'daemon.sock'),
    features: { broker: 'absent' },
    stuck: [],
    roots: [{ root: made.root, team: 'acme', send: 'serving', bus: 'serving', why: null }],
  });
  mkdirSync(dirname(daemonLockPath(made.home)), { recursive: true });
  writeFileSync(daemonLockPath(made.home), `${String(process.pid)}\n`);
  const run = async (): Promise<number> => {
    const io = owner(made.root);
    return runWatch([], io, withHostedLoop({
      live: () => live,
      machine: () => unreadMachine(),
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => null,
      status: () => null,
      foreground: () => null,
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      notify: () => {},
      now: () => when,
      wait: async () => false,
      alive: () => false,
      pid: 1,
      home: made.home,
      pushWork: async () => ({ ok: false, refused: 'the route refused' }),
      busPublish: async () => ({ kind: 'unavailable' }),
    }));
  };
  expect(await run()).toBe(0);
  forgetIdleEpisodes();
  const leadDrops = join(made.dir, 'send-drops', 'acme', 'lead');
  const notices = existsSync(leadDrops)
    ? readdirSync(leadDrops).filter((name) => name.startsWith('blocked-episode-gravel-') && !name.includes('.'))
    : [];
  expect(notices).toHaveLength(1);
  const body = readFileSync(join(leadDrops, notices[0] as string), 'utf8');
  expect(body).toContain('gravel waits at a permission prompt');
  expect(body).toContain('On its screen:');
  expect(body).toContain('Yes, proceed');
});

test('a taken climb is held on disk until it is sent, so a restarted daemon still sends it', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'climbs-held-')));
  try {
    const climb: StatusClimb = { seat: 'worker-1', id: 'evt-prompt-lead-worker-1-abc', text: 'crew: x', target: { seat: 'orchestrator', root: '/r/main', session: 'main' } };
    const first: { climb: StatusClimb; tries: number }[] = [];
    holdClimb(dir, first, climb);
    holdClimb(dir, first, climb);
    expect(first).toHaveLength(1);
    // A new process: its queue starts empty and reads the held climb back, once.
    const after: { climb: StatusClimb; tries: number }[] = [];
    loadHeldClimbs(dir, after);
    loadHeldClimbs(dir, after);
    expect(after.map((held) => held.climb)).toEqual([climb]);
    releaseHeldClimb(dir, climb.id);
    const released: { climb: StatusClimb; tries: number }[] = [];
    loadHeldClimbs(dir, released);
    expect(released).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest climb per seat and prompt is sent, and none a run held more than 30 minutes ago', () => {
  // 2026-11-15: a climb held by the run before a restart went out beside the new run's climb for
  // the same prompt, and the lead got the escalation twice.
  const now = new Date('2026-11-15T11:40:00.000Z');
  const target = { seat: 'orchestrator', root: '/r/main', session: 'main' };
  const climb = (id: string, at: string): { climb: StatusClimb; tries: number } => ({ climb: { seat: 'worker-1', id, text: 'x', at, target }, tries: 0 });
  const dropped: string[] = [];
  const kept = supersededClimbs([
    climb('evt-prompt-climb-worker-1-a', '2026-11-15T11:20:00.000Z'),
    climb('evt-prompt-climb-worker-1-b', '2026-11-15T11:38:00.000Z'),
    climb('evt-prompt-remind-worker-1-c', '2026-11-15T11:39:00.000Z'),
    climb('evt-prompt-climb-worker-2-d', new Date(now.getTime() - HELD_CLIMB_STALE_MS - 1).toISOString()),
  ], now, (one) => dropped.push(one.id));
  expect(kept.map((one) => one.climb.id)).toEqual(['evt-prompt-climb-worker-1-b', 'evt-prompt-remind-worker-1-c']);
  expect(dropped).toEqual(['evt-prompt-climb-worker-1-a', 'evt-prompt-climb-worker-2-d']);
});

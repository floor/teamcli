// Independent verification of the stuck-episode report and of the unread report's two audiences.
// Every non-human, non-stopped seat whose oldest unread message is past twice its window is named
// once per episode, unless a proven working presence younger than watch.stuck_after says a turn
// is running. While that episode is open the sender still receives its unread record, and the
// lead's folder stays at the stuck notice. A young proven turn tells the sender and leaves the
// lead's folder unwritten. The pane, its screen, and the clock are synthetic. No live host, CLI,
// or process signal is invoked.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending, pendingDropPath } from '../src/send/pending.ts';
import { signReceiptPayload, signRecord, writeReceipt } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { readScreen } from '../src/watch/screen.ts';
import { reportStuckSeats, reportUnreadDrops, type StuckStalePresence } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T14:00:00.000Z');
const MIN = 60_000;
const WINDOW = 600;
const STUCK_AFTER = 900;
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const REASON = 'link-down';
const OLD = [
  '019a0000-bbbb-7ccc-8ddd-000000000001',
  '019a0000-bbbb-7ccc-8ddd-000000000002',
  '019a0000-bbbb-7ccc-8ddd-000000000003',
] as const;
const FRESH = '019a0000-bbbb-7ccc-8ddd-000000000004';
const PAST = '019a0000-cccc-7ddd-8eee-000000000021';
const AGES = [120 * MIN, 100 * MIN, 80 * MIN];
const SURVEY = [
  '● Done.',
  '',
  "How's the CLI experience so far? [1] Good [2] Fine [3] Bad [0] Skip",
].join('\n');
const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2', 'idle.txt'), 'utf8');

let bases: string[] = [];
let scratch = '';

afterEach(() => {
  if (bases.length > 0) discardFixtures(bases, { roots: scratch === '' ? [] : [scratch] });
  bases = [];
});

type World = { root: string; dir: string; home: string; text: string };

function seatBlock(name: string, role: string, extra: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${name === 'lead' ? 'claude-code' : 'antigravity'}
    vendor: test
    model: Fixture
    version: "1"
    launch: ${name === 'lead' ? 'claude' : 'agy'}
${extra}`;
}

function world(extra = ''): World {
  const base = fixtureBase('c78d-');
  bases.push(base);
  scratch = dirname(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seatBlock('lead', 'coordinator', '')}${seatBlock(SEAT, 'implementer', '')}${extra}`;
  writeFileSync(join(dir, 'team.yaml'), text);
  return { root, dir, home, text };
}

function teamOf(text: string) {
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function seed(
  made: World,
  seat: string,
  id: string,
  ageMs: number,
  from = 'owner',
  pending = false,
): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', seat);
  const at = new Date(NOW.getTime() - ageMs).toISOString();
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at,
    body: `fixture message ${id}`,
    from,
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, made.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  if (pending) {
    markPending(dropDir, { id, from, to: seat, body: `fixture message ${id}`, ts: at, leg: 'drop' });
  }
  return dropDir;
}

/** Three old drops and one new: the oldest is two hours, past twice a 10-minute window. */
function fourHeld(made: World, pending = false, from = 'owner'): string {
  let dropDir = '';
  for (const [index, id] of OLD.entries()) {
    dropDir = seed(made, SEAT, id, AGES[index] ?? 120 * MIN, from, pending);
  }
  return seed(made, SEAT, FRESH, MIN, from, pending);
}

type Pane = { screen: string | null; status: string; typed: string[]; enters: number };

function pane(screen: string | null, status = 'done'): Pane {
  return { screen, status, typed: [], enters: 0 };
}

function sourcesOf(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(status: string, present: boolean): Live {
  const agents: HerdrAgent[] = present
    ? [{ name: SEAT, agent: 'agy', pane: PANE, workspace: 'first', status, cwd: null }]
    : [];
  return { running: true, agents, workspaces: [], screens: {} };
}

type Reading = {
  now?: Date;
  workingSince?: string;
  stale?: StuckStalePresence;
  present?: boolean;
};

function report(made: World, one: Pane, said: string[], reading: Reading = {}): void {
  const team = teamOf(made.text);
  const workingSince = reading.workingSince === undefined
    ? new Map<string, string>()
    : new Map([[SEAT, reading.workingSince]]);
  const stalePresence = reading.stale === undefined
    ? new Map<string, StuckStalePresence>()
    : new Map<string, StuckStalePresence>([[SEAT, reading.stale]]);
  const scene: RetryScene = {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team,
    live: liveWith(one.status, reading.present !== false),
    ownPane: null,
    sources: sourcesOf(one),
    now: reading.now ?? NOW,
    say: (text: string) => said.push(text),
  };
  reportStuckSeats(scene, { unreadAfter: WINDOW }, {
    workingSince,
    stuckAfterSeconds: STUCK_AFTER,
    stalePresence,
  });
}

/** The unread report, handed the same reading the stuck report just used. */
function due(made: World, one: Pane, said: string[], reading: Reading = {}): void {
  const team = teamOf(made.text);
  const workingSince = reading.workingSince === undefined
    ? new Map<string, string>()
    : new Map([[SEAT, reading.workingSince]]);
  const stalePresence = reading.stale === undefined
    ? new Map<string, StuckStalePresence>()
    : new Map<string, StuckStalePresence>([[SEAT, reading.stale]]);
  const scene: RetryScene = {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team,
    live: liveWith(one.status, reading.present !== false),
    ownPane: null,
    sources: sourcesOf(one),
    now: reading.now ?? NOW,
    say: (text: string) => said.push(text),
  };
  reportUnreadDrops(scene, { unreadAfter: WINDOW }, {
    workingSince,
    stuckAfterSeconds: STUCK_AFTER,
    stalePresence,
  });
}

function leadDropIds(made: World): string[] {
  const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
  if (!existsSync(dropDir)) return [];
  return readdirSync(dropDir).filter((name) => MESSAGE_ID.test(name)).sort();
}

function ownerBody(made: World, id: string): string {
  const path = join(made.root, '.agents', 'messages', 'owner', `unread-${id}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { payload?: { body?: unknown; to?: unknown } };
  if (parsed.payload?.to !== 'owner' || typeof parsed.payload.body !== 'string') {
    throw new Error('the sender unread record was not written');
  }
  return parsed.payload.body;
}

function leadNotices(made: World): string[] {
  const dropDir = join(made.dir, 'send-drops', 'acme', 'lead');
  if (!existsSync(dropDir)) return [];
  const found: { at: string; body: string }[] = [];
  for (const name of readdirSync(dropDir)) {
    let parsed: { payload?: { at?: unknown; from?: unknown; to?: unknown; body?: unknown } };
    try {
      parsed = JSON.parse(readFileSync(join(dropDir, name), 'utf8')) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.payload?.from !== 'runtime' || parsed.payload.to !== 'lead') continue;
    if (typeof parsed.payload.body !== 'string' || typeof parsed.payload.at !== 'string') continue;
    found.push({ at: parsed.payload.at, body: parsed.payload.body });
  }
  found.sort((one, other) => Date.parse(one.at) - Date.parse(other.at));
  return found.map((one) => one.body);
}

test('an unhealthy channel, a stale working projection, and a recognised done screen are named once', () => {
  const made = world();
  expect(readScreen('antigravity', IDLE).kind).toBe('idle');
  const dropDir = fourHeld(made, true);
  const ids = [...OLD, FRESH];
  const before = new Map(ids.map((id) => [id, readFileSync(pendingDropPath(dropDir, id), 'utf8')]));
  const since = new Date(NOW.getTime() - 30 * MIN).toISOString();
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said, {
    stale: { word: `presence channel unhealthy (${REASON})`, state: 'working', since },
  });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  const body = first[0];
  if (body === undefined) throw new Error('the lead notice was not written');
  expect(body).toContain(SEAT);
  expect(body).toContain(`presence channel unhealthy (${REASON})`);
  expect(body).toContain(`last seen working since ${since}`);
  expect(body).toContain('4 messages wait');
  expect(body).toContain('oldest 120 min');
  expect(body).not.toContain('screen not recognised');
  expect(body).not.toContain('screen idle');
  expect(said).toHaveLength(1);
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(existsSync(seatLockPath(made.dir, 'acme', SEAT))).toBe(false);
  for (const id of ids) {
    const stored = before.get(id);
    if (stored === undefined) throw new Error('a pending marker was not read');
    expect(readFileSync(pendingDropPath(dropDir, id), 'utf8')).toBe(stored);
  }

  report(made, one, said, {
    stale: { word: `presence channel unhealthy (${REASON})`, state: 'working', since },
    now: new Date(NOW.getTime() + MIN),
  });
  expect(leadNotices(made)).toHaveLength(1);
  expect(said).toHaveLength(1);
});

test('a proven working presence younger than 900 s raises no notice, even on that same shape', () => {
  const made = world();
  fourHeld(made, true);
  const since = new Date(NOW.getTime() - (STUCK_AFTER * 1000 - MIN)).toISOString();
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said, {
    workingSince: since,
    stale: {
      word: `presence channel unhealthy (${REASON})`,
      state: 'working',
      since: new Date(NOW.getTime() - 30 * MIN).toISOString(),
    },
  });

  expect(leadNotices(made)).toEqual([]);
  expect(said).toEqual([]);
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
});

test('a proven working presence older than 900 s is named with the time it began', () => {
  const made = world();
  fourHeld(made);
  const since = new Date(NOW.getTime() - (STUCK_AFTER * 1000 + MIN)).toISOString();
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said, { workingSince: since });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  const body = first[0];
  if (body === undefined) throw new Error('the lead notice was not written');
  expect(body).toContain(`presence says working since ${since}`);
  expect(body).toContain('4 messages wait');
  expect(body).toContain('oldest 120 min');
  expect(body).toContain('the word has stood for 16 min');
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);

  report(made, one, said, { workingSince: since, now: new Date(NOW.getTime() + MIN) });
  expect(leadNotices(made)).toHaveLength(1);
});

test('a pull-only seat with old runtime mail is named once, not once per message', () => {
  const made = world();
  const ages = [90 * MIN, 70 * MIN, 50 * MIN];
  for (const [index, id] of OLD.entries()) {
    seed(made, SEAT, id, ages[index] ?? 90 * MIN, 'runtime');
  }
  const one = pane(null, 'done');
  const said: string[] = [];

  report(made, one, said, { present: false });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  const body = first[0];
  if (body === undefined) throw new Error('the lead notice was not written');
  expect(body.startsWith(`${SEAT}:`)).toBe(true);
  expect(body).toContain('no live pane was read, no wake reached it');
  expect(body).toContain('3 messages wait');
  expect(body).toContain('oldest 90 min');
  expect(said).toHaveLength(1);
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);

  report(made, one, said, { present: false, now: new Date(NOW.getTime() + MIN) });
  expect(leadNotices(made)).toHaveLength(1);
  expect(said).toHaveLength(1);
});

test('mail younger than twice the window is not named on a recognised screen', () => {
  const made = world();
  seed(made, SEAT, FRESH, 19 * MIN);
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said);

  expect(leadNotices(made)).toEqual([]);
  expect(said).toEqual([]);
  expect(one.typed).toEqual([]);
});

test('a screen change leaves the episode open, and only a read starts another', () => {
  const made = world();
  const dropDir = fourHeld(made);
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said);

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  const body = first[0];
  if (body === undefined) throw new Error('the lead notice was not written');
  expect(body).toContain('screen idle, no wake reached it');
  expect(body).toContain('4 messages wait');
  expect(body).toContain('oldest 120 min');
  expect(one.typed).toEqual([]);

  one.screen = SURVEY;
  expect(readScreen('antigravity', SURVEY).kind).toBe('unknown');
  report(made, one, said, { now: new Date(NOW.getTime() + MIN) });
  expect(leadNotices(made)).toHaveLength(1);
  expect(said).toHaveLength(1);

  writeReceipt(dropDir, signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id: OLD[0],
    to: SEAT,
    root: realpathSync(made.root),
    session: 'acme',
    at: new Date(NOW.getTime() + MIN).toISOString(),
  }, made.home), made.home);

  report(made, one, said, { now: new Date(NOW.getTime() + 2 * MIN) });
  const notices = leadNotices(made);
  expect(notices).toHaveLength(2);
  const again = notices[1];
  if (again === undefined) throw new Error('the second lead notice was not written');
  expect(again).toContain('3 messages wait');
  expect(again).toContain('oldest 102 min');
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(existsSync(seatLockPath(made.dir, 'acme', SEAT))).toBe(false);
});

test('the lead, a person, and a stopped seat are not named', () => {
  const made = world(`${seatBlock('person', 'implementer', '    human: true\n')}${seatBlock('halted', 'implementer', '    stopped: true\n')}`);
  const quiet = ['lead', 'person', 'halted'] as const;
  for (const [index, seat] of quiet.entries()) {
    seed(made, seat, `019a0000-bbbb-7ccc-8ddd-00000000001${String(index)}`, 120 * MIN);
  }
  seed(made, SEAT, OLD[0], 120 * MIN, 'runtime');
  const one = pane(null, 'done');
  const said: string[] = [];

  report(made, one, said, { present: false });

  const notices = leadNotices(made);
  expect(notices).toHaveLength(1);
  const body = notices[0];
  if (body === undefined) throw new Error('the lead notice was not written');
  expect(body.startsWith(`${SEAT}:`)).toBe(true);
  expect(body).toContain('1 message wait');
  for (const seat of quiet) expect(body.startsWith(`${seat}:`)).toBe(false);
  expect(said).toHaveLength(1);
  expect(one.typed).toEqual([]);
});

test('an open episode still writes the sender unread record and leaves the lead at the stuck notice', () => {
  const made = world();
  seed(made, SEAT, PAST, 21 * MIN);
  const one = pane(IDLE, 'done');
  const said: string[] = [];

  report(made, one, said);
  const standing = leadDropIds(made);
  expect(standing).toHaveLength(1);
  const stuck = leadNotices(made);
  expect(stuck).toHaveLength(1);
  const notice = stuck[0];
  if (notice === undefined) throw new Error('the stuck notice was not written');
  expect(notice).toContain('screen idle, no wake reached it');
  expect(notice).toContain('1 message wait');
  expect(notice).toContain('oldest 21 min');

  due(made, one, said);

  const record = ownerBody(made, PAST);
  expect(record).toContain(`${SEAT}: a message from owner is queued, not woken - unread for 21 min`);
  expect(record).toContain('no wake line was typed');
  expect(leadDropIds(made)).toEqual(standing);
  expect(leadNotices(made)).toEqual(stuck);
  const told = said[said.length - 1];
  if (told === undefined) throw new Error('the sender was not told');
  expect(told).toContain('reported to owner');
  expect(told).not.toContain('and lead');
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(existsSync(seatLockPath(made.dir, 'acme', SEAT))).toBe(false);
});

test('a young proven turn tells the sender and writes nothing for the lead', () => {
  const made = world();
  seed(made, SEAT, PAST, 21 * MIN);
  const since = new Date(NOW.getTime() - 5 * MIN).toISOString();
  const one = pane(IDLE, 'done');
  const said: string[] = [];
  const reading = { workingSince: since };

  report(made, one, said, reading);
  due(made, one, said, reading);

  const record = ownerBody(made, PAST);
  expect(record).toContain(`${SEAT}: a message from owner is queued, not woken - unread for 21 min`);
  expect(leadDropIds(made)).toEqual([]);
  expect(leadNotices(made)).toEqual([]);
  expect(said).toEqual([`${SEAT}: a message from owner was still unread after 21 min; reported to owner`]);
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
});

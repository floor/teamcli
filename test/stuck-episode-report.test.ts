// The stuck-episode report: a seat whose oldest unread message has waited past twice its window
// is named to the lead once per episode, unless a proven working presence younger than
// watch.stuck_after says a turn is running. The notice names what the watch sees — an unknown
// screen, a proven working word past the bound, an unhealthy presence channel with the state it
// last showed, or a recognised screen no wake reached — with the count and the oldest age. It is
// a report only: it types nothing, takes no seat lock, and changes no pending marker.
//
// Red first: the recognised-screen and unproven-presence scenes below fail on the 0.5.12 report;
// the pane is a scripted screen and no live session is touched.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending, pendingDropPath } from '../src/send/pending.ts';
import { signReceiptPayload, signRecord, writeReceipt } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { readScreen } from '../src/watch/screen.ts';
import { reportStuckSeats } from '../src/watch/unread.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const N = 600;
const MIN = 60_000;
/** The shipped `watch.stuck_after` default, in seconds: 15 minutes. */
const T = 900;

const ANTIGRAVITY_IDLE = readFileSync(
  new URL('./fixtures/antigravity/1.4.2/idle.txt', import.meta.url),
  'utf8',
);
const ANTIGRAVITY_SURVEY = [
  '● Done.',
  '',
  "How's the CLI experience so far? [1] Good [2] Fine [3] Bad [0] Skip",
].join('\n');

const OLD_1 = 'dddddddd-0000-4000-8000-000000000201';
const OLD_2 = 'dddddddd-0000-4000-8000-000000000202';
const OLD_3 = 'dddddddd-0000-4000-8000-000000000203';
const FRESH = 'dddddddd-0000-4000-8000-000000000204';

let base = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-stuck-report-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = { root: string; dir: string; home: string };

function teamText(world: World): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(world.home)}
  - ${world.root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: worker
    cli: antigravity
    vendor: google
    model: Gemini 4 Argon
    version: "1"
    launch: agy
`;
}

function world(): World {
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const made = { root, dir: join(root, '.agents'), home };
  writeFileSync(join(made.dir, 'team.yaml'), teamText(made));
  return made;
}

function teamOf(made: World) {
  const result = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** A signed message in the seat's drop folder, dated by its own signed instant. */
function seed(made: World, seat: string, id: string, ageMs: number, from = 'owner'): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', seat);
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at: new Date(NOW.getTime() - ageMs).toISOString(),
    body: `message ${id}`,
    from,
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, made.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  return dropDir;
}

/** The marker a sender's held drop leg leaves: the record is stored, no seat was woken. */
function leavePending(dropDir: string, id: string, ageMs: number, from = 'owner'): void {
  markPending(dropDir, {
    id,
    from,
    to: 'worker',
    body: `message ${id}`,
    ts: new Date(NOW.getTime() - ageMs).toISOString(),
    leg: 'drop',
  });
}

/** Every three of the old messages plus the fresh one: the four held behind the screen. */
function fourHeld(made: World, pending = false): string {
  const ages = [120 * MIN, 100 * MIN, 80 * MIN];
  const ids = [OLD_1, OLD_2, OLD_3];
  let dropDir = '';
  for (const [index, id] of ids.entries()) {
    dropDir = seed(made, 'worker', id, ages[index]!);
    if (pending) leavePending(dropDir, id, ages[index]!);
  }
  dropDir = seed(made, 'worker', FRESH, MIN);
  if (pending) leavePending(dropDir, FRESH, MIN);
  return dropDir;
}

type Pane = { screen: string | null; status: string; typed: string[]; enters: number };

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
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

function liveWith(status = 'idle', agents = true): Live {
  const list: HerdrAgent[] = agents
    ? [{ name: 'worker', agent: 'agy', pane: 'pane-worker', workspace: 'first', status, cwd: null }]
    : [];
  return { running: true, agents: list, workspaces: [], screens: {} };
}

/** What the watch measured about a native presence it could not prove: the channel's own reason
 *  and the projection it last showed. */
type StalePresence = { word: string; state: string; since: string };

type Reading = {
  now?: Date;
  workingSince?: string;
  status?: string;
  stale?: StalePresence;
  noAgents?: boolean;
};

function sceneOf(
  made: World,
  team: ReturnType<typeof teamOf>,
  one: Pane,
  said: string[],
  reading: Reading = {},
): RetryScene {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team,
    live: liveWith(reading.status, reading.noAgents !== true),
    ownPane: null,
    sources: scripts(one),
    now: reading.now ?? NOW,
    say: (text: string) => said.push(text),
  };
}

function report(
  made: World,
  team: ReturnType<typeof teamOf>,
  one: Pane,
  said: string[],
  reading: Reading = {},
): void {
  const workingSince = reading.workingSince === undefined
    ? new Map<string, string>()
    : new Map([['worker', reading.workingSince]]);
  const stalePresence = reading.stale === undefined
    ? new Map<string, StalePresence>()
    : new Map<string, StalePresence>([['worker', reading.stale]]);
  reportStuckSeats(
    sceneOf(made, team, one, said, reading),
    { unreadAfter: N },
    { workingSince, stuckAfterSeconds: T, stalePresence },
  );
}

/** The notices the lead's own folder holds, oldest first: every signed runtime report, as its
 *  body. `readdirSync` order is the file system's, not the clock's, so the listing is sorted by
 *  each record's own signed instant. */
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
    if (typeof parsed.payload.body !== 'string') continue;
    found.push({
      at: typeof parsed.payload.at === 'string' ? parsed.payload.at : '',
      body: parsed.payload.body,
    });
  }
  found.sort((one, other) => Date.parse(one.at) - Date.parse(other.at));
  return found.map((one) => one.body);
}

test('an unrecognised screen is named once, with every held message and the oldest age', () => {
  const made = world();
  const team = teamOf(made);
  expect(readScreen('antigravity', ANTIGRAVITY_SURVEY).kind).toBe('unknown');
  const dropDir = fourHeld(made);
  const one = pane(ANTIGRAVITY_SURVEY);
  const said: string[] = [];

  // Within 2N of the watch first seeing the screen: every message counts, the hour-old ones too.
  report(made, team, one, said);

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('worker');
  expect(first[0]).toContain('screen not recognised');
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  expect(said).toHaveLength(1);
  expect(said[0]).toContain('worker');
  // Report only: no keystroke, and no seat lock taken for one.
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
  expect(existsSync(seatLockPath(made.dir, 'acme', 'worker'))).toBe(false);

  // Further passes in the same episode raise no second notice.
  report(made, team, one, said, { now: new Date(NOW.getTime() + MIN) });
  report(made, team, one, said, { now: new Date(NOW.getTime() + 30 * MIN) });
  expect(leadNotices(made)).toHaveLength(1);
  expect(said).toHaveLength(1);
  expect(existsSync(dropDir)).toBe(true);
});

test('the same notice counts drops a sender left pending, and leaves the markers untouched', () => {
  const made = world();
  const team = teamOf(made);
  const dropDir = fourHeld(made, true);
  const ids = [OLD_1, OLD_2, OLD_3, FRESH];
  const before = new Map(
    ids.map((id) => [id, readFileSync(pendingDropPath(dropDir, id), 'utf8')]),
  );

  const one = pane(ANTIGRAVITY_SURVEY);
  const said: string[] = [];
  report(made, team, one, said);

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  for (const id of ids) {
    expect(existsSync(pendingDropPath(dropDir, id))).toBe(true);
    expect(readFileSync(pendingDropPath(dropDir, id), 'utf8')).toBe(before.get(id)!);
  }
  expect(one.typed).toEqual([]);

  report(made, team, one, said, { now: new Date(NOW.getTime() + 2 * MIN) });
  expect(leadNotices(made)).toHaveLength(1);
});

test('a presence that has said working since before T is named with the time it began', () => {
  const made = world();
  const team = teamOf(made);
  const dropDir = fourHeld(made, true);
  const since = new Date(NOW.getTime() - (T * 1000 + MIN)).toISOString();
  const one = pane(ANTIGRAVITY_IDLE);
  const said: string[] = [];

  report(made, team, one, said, { workingSince: since });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('worker');
  expect(first[0]).toContain(`presence says working since ${since}`);
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  expect(first[0]).not.toContain('screen not recognised');
  expect(one.typed).toEqual([]);
  expect(existsSync(pendingDropPath(dropDir, OLD_1))).toBe(true);

  report(made, team, one, said, { workingSince: since, now: new Date(NOW.getTime() + 5 * MIN) });
  expect(leadNotices(made)).toHaveLength(1);
});

test('a presence that has said working for less than T is not named, and is named past T', () => {
  const made = world();
  const team = teamOf(made);
  fourHeld(made, true);
  const one = pane(ANTIGRAVITY_SURVEY);
  const said: string[] = [];
  const since = new Date(NOW.getTime() - (T * 1000 - MIN)).toISOString();

  // T - 1: a real turn is not a stuck seat, not even behind a screen the watch cannot read.
  report(made, team, one, said, { workingSince: since });
  expect(leadNotices(made)).toHaveLength(0);
  expect(said).toHaveLength(0);

  // T + 1: the same word, now too old to be a live turn.
  report(made, team, one, said, {
    workingSince: since,
    now: new Date(NOW.getTime() + 2 * MIN),
  });
  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain(`presence says working since ${since}`);
  expect(first[0]).toContain('4 messages wait');
});

test('an open episode stands while its messages are unread, whatever the screen now says', () => {
  const made = world();
  const team = teamOf(made);
  fourHeld(made);
  const one = pane(ANTIGRAVITY_SURVEY);
  const said: string[] = [];

  report(made, team, one, said);
  expect(leadNotices(made)).toHaveLength(1);

  // The screen is recognised now: the named messages still stand, so the episode is not over.
  one.screen = ANTIGRAVITY_IDLE;
  report(made, team, one, said, { now: new Date(NOW.getTime() + MIN) });
  expect(leadNotices(made)).toHaveLength(1);
});

test('a recognised idle screen with mail past 2N is named, not excused', () => {
  const made = world();
  const team = teamOf(made);
  fourHeld(made);
  const one = pane(ANTIGRAVITY_IDLE);
  const said: string[] = [];

  expect(readScreen('antigravity', ANTIGRAVITY_IDLE).kind).toBe('idle');
  report(made, team, one, said);

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('worker');
  expect(first[0]).toContain('screen idle, no wake reached it');
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  expect(said).toHaveLength(1);
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
});

test('an unhealthy presence channel is named with its reason and the state it last showed', () => {
  const made = world();
  const team = teamOf(made);
  fourHeld(made);
  // A recognised screen does not excuse an unproven presence: this is operator-3's shape.
  const one = pane(ANTIGRAVITY_IDLE);
  const said: string[] = [];
  const since = new Date(NOW.getTime() - 20 * 60 * MIN).toISOString();

  report(made, team, one, said, {
    stale: { word: 'presence channel unhealthy (transport-error)', state: 'working', since },
  });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('worker');
  expect(first[0]).toContain('presence channel unhealthy (transport-error)');
  expect(first[0]).toContain(`last seen working since ${since}`);
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  expect(first[0]).not.toContain('screen not recognised');
  expect(one.typed).toEqual([]);
  expect(one.enters).toBe(0);
});

test('a pull-only seat with old runtime notices is named once, not once per message', () => {
  const made = world();
  const team = teamOf(made);
  for (const id of [OLD_1, OLD_2, OLD_3]) seed(made, 'worker', id, 90 * MIN, 'runtime');
  const one = pane(null);
  const said: string[] = [];

  // No live pane: the wake path has no screen to reach, and the notice says what was read.
  report(made, team, one, said, { noAgents: true, status: 'done' });

  const first = leadNotices(made);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('worker');
  expect(first[0]).toContain('no live pane');
  expect(first[0]).toContain('3 messages wait');
  expect(first[0]).toContain('oldest 90 min');
  expect(said).toHaveLength(1);

  // A second pass inside the episode adds no word per message.
  report(made, team, one, said, {
    noAgents: true,
    status: 'done',
    now: new Date(NOW.getTime() + MIN),
  });
  expect(leadNotices(made)).toHaveLength(1);
});

test('a read receipt closes the episode; the messages still waiting are named again', () => {
  const made = world();
  const team = teamOf(made);
  const dropDir = fourHeld(made);
  const one = pane(ANTIGRAVITY_SURVEY);
  const said: string[] = [];

  report(made, team, one, said);
  expect(leadNotices(made)).toHaveLength(1);

  // The seat reads one of the four: that read ends the episode.
  writeReceipt(dropDir, signReceiptPayload({
    kind: 'receipt',
    status: 'read',
    id: OLD_1,
    to: 'worker',
    root: realpathSync(made.root),
    session: 'acme',
    at: new Date(NOW.getTime() + MIN).toISOString(),
  }, made.home), made.home);

  report(made, team, one, said, { now: new Date(NOW.getTime() + 2 * MIN) });
  const notices = leadNotices(made);
  expect(notices).toHaveLength(2);
  expect(notices[1]).toContain('3 messages wait');
  // The age is the message's own, read at this pass: 100 minutes when it landed, 102 by now.
  expect(notices[1]).toContain('oldest 102 min');
});

// The stuck-episode marker belongs to the pass, not to each report: its presence comes from the
// drop-folder listing the pass already takes, a marker the listing shows is read at most once for
// the whole pass, and the sites that reserve or give it back update that same reading. The 2N
// report therefore sees the episode the stuck report read, opened, or closed — without reading
// the folder a second time, and without reading anything at all when no marker was ever listed.
//
// The scenes make the pass reading observable without counting opens: the file is changed or
// removed between the two reports of one shared `MailPass`, and only a report that re-reads the
// folder can notice. The pane, its screen, and the clock are synthetic; no live host is touched.
//
// Red first: the first two scenes fail on e972bb19b, where each report reads the marker for
// itself, so the second report sees the file as the test left it rather than as the pass read it.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MailPass } from '../src/watch/mail-pass.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { readScreen } from '../src/watch/screen.ts';
import { reportStuckSeats, reportUnreadDrops, type StuckReading } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const MIN = 60_000;
const WINDOW = 600;
const STUCK_AFTER = 900;
const SEAT = 'worker';
const PANE = 'fixture-pane-a';
const OLD = '019a0000-dddd-7eee-8fff-000000000001';
const YOUNG = '019a0000-dddd-7eee-8fff-000000000002';
/** An id no drop folder holds: a marker naming it covers nothing. */
const ABSENT = '019a0000-dddd-7eee-8fff-000000000003';
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

function seatBlock(name: string, role: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${name === 'lead' ? 'claude-code' : 'antigravity'}
    vendor: test
    model: Fixture
    version: "1"
    launch: ${name === 'lead' ? 'claude' : 'agy'}`;
}

function world(): World {
  const base = fixtureBase('c78e-');
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
${seatBlock('lead', 'coordinator')}
${seatBlock(SEAT, 'implementer')}
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  return { root, dir, home, text };
}

function teamOf(text: string) {
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

/** A signed message in the seat's drop folder, dated by its own signed instant. */
function seed(made: World, id: string, ageMs: number): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', SEAT);
  const at = new Date(NOW.getTime() - ageMs).toISOString();
  const record = signRecord({
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at,
    body: `fixture message ${id}`,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, made.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  return dropDir;
}

/** An open episode marker naming `ids`, as the stuck report writes it. */
function leaveEpisode(dropDir: string, ids: readonly string[]): string {
  const path = join(dropDir, '.stuck');
  writeFileSync(path, `${JSON.stringify({
    v: 1,
    at: NOW.toISOString(),
    class: 'screen',
    kind: 'unknown',
    ids: [...ids],
    notice: `fixture-notice-${ids.join('-')}`,
  })}\n`);
  return path;
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

function liveWith(status: string): Live {
  const agents: HerdrAgent[] = [{ name: SEAT, agent: 'agy', pane: PANE, workspace: 'first', status, cwd: null }];
  return { running: true, agents, workspaces: [], screens: {} };
}

/** The pass: one clock, one pane, one shared mail reading for every report it runs. */
function sceneOf(made: World, one: Pane, said: string[], mail: MailPass): RetryScene {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made.text),
    live: liveWith(one.status),
    ownPane: null,
    sources: sourcesOf(one),
    now: NOW,
    say: (text: string) => said.push(text),
    mail,
  };
}

function reading(): StuckReading {
  return { workingSince: new Map(), stuckAfterSeconds: STUCK_AFTER };
}

function mailOf(made: World): MailPass {
  return new MailPass({ dir: made.dir, root: made.root, session: 'acme', home: made.home });
}

/** The signed runtime notices in the lead's own folder, oldest first. */
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

test('a marker the stuck report read serves the 2N report without a second read', () => {
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const marker = leaveEpisode(dropDir, [OLD]);
  const one = pane(IDLE);
  const said: string[] = [];
  const mail = mailOf(made);

  // The marker covers the seat's only message: the episode already speaks, so the stuck report
  // says nothing new and leaves the marker standing.
  reportStuckSeats(sceneOf(made, one, said, mail), { unreadAfter: WINDOW }, reading());
  expect(existsSync(marker)).toBe(true);
  expect(leadNotices(made)).toHaveLength(0);

  // The pass has taken the marker's reading; the file is gone before the 2N report runs.
  rmSync(marker);
  reportUnreadDrops(sceneOf(made, one, said, mail), { unreadAfter: WINDOW }, reading());

  // The 2N report keeps the lead silent: the episode the pass read still speaks for the seat,
  // and the folder is not read again to look for a marker the pass already knows.
  expect(leadNotices(made)).toHaveLength(0);
});

test('a marker this pass reserved serves the 2N report without a read', () => {
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const one = pane(SURVEY);
  const said: string[] = [];
  const mail = mailOf(made);

  // No marker was listed: nothing is read, and the stuck report reserves the claim itself.
  reportStuckSeats(sceneOf(made, one, said, mail), { unreadAfter: WINDOW }, reading());
  const notices = leadNotices(made);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('screen not recognised');

  // The claim is the pass's own reading: removing the file afterwards cannot make the episode
  // it opened stop speaking for the 2N report.
  rmSync(join(dropDir, '.stuck'));
  reportUnreadDrops(sceneOf(made, one, said, mail), { unreadAfter: WINDOW }, reading());
  expect(leadNotices(made)).toHaveLength(1);
});

test('a marker this pass gave back is not an episode for the 2N report', () => {
  const made = world();
  const dropDir = seed(made, YOUNG, MIN);
  const marker = leaveEpisode(dropDir, [ABSENT]);
  const one = pane(IDLE);
  const said: string[] = [];
  const mail = mailOf(made);

  // The marker names a message that is no longer unread: the stuck report gives it back, and
  // the seat's one unread message is too young for a fresh notice at this window.
  reportStuckSeats(sceneOf(made, one, said, mail), { unreadAfter: WINDOW }, reading());
  expect(existsSync(marker)).toBe(false);
  expect(leadNotices(made)).toHaveLength(0);

  // A later reader of the same pass sees the episode as closed — a cache that kept it would
  // leave the lead silent for a marker this pass already gave back.
  reportUnreadDrops(sceneOf(made, one, said, mail), { unreadAfter: 30 }, reading());
  expect(leadNotices(made)).toHaveLength(1);
});

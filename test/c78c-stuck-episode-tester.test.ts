// Independent verification of the stuck-episode lead notice (src/watch/unread.ts) and of a
// watch approval written before stuck_after (src/approve/approval.ts). The pane, its screen
// and the clock are synthetic. No live host, CLI, or process signal is invoked.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { approvedFingerprints } from '../src/approve/approval.ts';
import { compare, fingerprints, legacyWatchDigests } from '../src/approve/fingerprint.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending, pendingDropPath } from '../src/send/pending.ts';
import { signRecord } from '../src/send/record.ts';
import type { ApprovalRecord } from '../src/store/store.ts';
import { readScreen } from '../src/watch/screen.ts';
import { reportStuckSeats } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const NOW = new Date('2026-11-05T13:00:00.000Z');
const MIN = 60_000;
const WINDOW = 600;
const STUCK_AFTER = 900;
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const OLD = [
  '019a0000-aaaa-7bbb-8ccc-000000000001',
  '019a0000-aaaa-7bbb-8ccc-000000000002',
  '019a0000-aaaa-7bbb-8ccc-000000000003',
] as const;
const FRESH = '019a0000-aaaa-7bbb-8ccc-000000000004';
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

function world(): { root: string; dir: string; home: string; text: string } {
  const base = fixtureBase('c78c-');
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
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: antigravity
    vendor: test
    model: Fixture
    version: "1"
    launch: agy
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  return { root, dir, home, text };
}

function teamOf(text: string) {
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function seed(made: { root: string; dir: string; home: string }, id: string, ageMs: number, pending: boolean): string {
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
  if (pending) {
    markPending(dropDir, { id, from: 'owner', to: SEAT, body: `fixture message ${id}`, ts: at, leg: 'drop' });
  }
  return dropDir;
}

function fourHeld(made: { root: string; dir: string; home: string }, pending: boolean): string {
  let dropDir = '';
  for (const [index, id] of OLD.entries()) dropDir = seed(made, id, AGES[index]!, pending);
  return seed(made, FRESH, MIN, pending);
}

type Pane = { screen: string; typed: string[]; enters: number };

function report(
  made: { root: string; dir: string; home: string; text: string },
  pane: Pane,
  said: string[],
  when: Date,
  workingSince?: string,
): void {
  const since = workingSince === undefined ? new Map<string, string>() : new Map([[SEAT, workingSince]]);
  reportStuckSeats(
    {
      dir: made.dir,
      session: 'acme',
      root: made.root,
      home: made.home,
      team: teamOf(made.text),
      live: {
        running: true,
        agents: [{ name: SEAT, agent: 'agy', pane: PANE, workspace: 'fixture-space', status: 'idle', cwd: null }],
        workspaces: [],
        screens: {},
      },
      ownPane: null,
      sources: {
        screen: () => pane.screen,
        status: () => 'idle',
        typeText: (_pane, text) => {
          pane.typed.push(text);
          return true;
        },
        pressEnter: () => {
          pane.enters += 1;
          return true;
        },
        sleep: async () => {},
      },
      now: when,
      say: (text) => {
        said.push(text);
      },
    },
    { unreadAfter: WINDOW },
    { workingSince: since, stuckAfterSeconds: STUCK_AFTER },
  );
}

function notices(dir: string): string[] {
  const dropDir = join(dir, 'send-drops', 'acme', 'lead');
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
    found.push({ at: typeof parsed.payload.at === 'string' ? parsed.payload.at : '', body: parsed.payload.body });
  }
  found.sort((one, other) => Date.parse(one.at) - Date.parse(other.at));
  return found.map((one) => one.body);
}

test('an unknown screen with three old drops and one new names the lead once, with count 4', () => {
  expect(readScreen('antigravity', SURVEY).kind).toBe('unknown');
  const made = world();
  fourHeld(made, false);
  const pane: Pane = { screen: SURVEY, typed: [], enters: 0 };
  const said: string[] = [];
  report(made, pane, said, NOW);
  const first = notices(made.dir);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain(SEAT);
  expect(first[0]).toContain('screen not recognised');
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).toContain('oldest 120 min');
  expect(said).toHaveLength(1);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  expect(existsSync(seatLockPath(made.dir, 'acme', SEAT))).toBe(false);
  report(made, pane, said, new Date(NOW.getTime() + MIN));
  expect(notices(made.dir)).toHaveLength(1);
  expect(said).toHaveLength(1);
});

test('pending markers are counted and left byte for byte, and nothing is typed', () => {
  const made = world();
  const dropDir = fourHeld(made, true);
  const ids = [...OLD, FRESH];
  const before = new Map(ids.map((id) => [id, readFileSync(pendingDropPath(dropDir, id), 'utf8')]));
  const pane: Pane = { screen: SURVEY, typed: [], enters: 0 };
  const said: string[] = [];
  report(made, pane, said, NOW);
  const first = notices(made.dir);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('4 messages wait');
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(0);
  for (const id of ids) {
    const stored = before.get(id);
    if (stored === undefined) throw new Error('a pending marker was not read');
    expect(readFileSync(pendingDropPath(dropDir, id), 'utf8')).toBe(stored);
  }
  report(made, pane, said, new Date(NOW.getTime() + 2 * MIN));
  expect(notices(made.dir)).toHaveLength(1);
});

test('a working presence older than 900 s is named once, and one just under that bound is not', () => {
  const made = world();
  const dropDir = fourHeld(made, true);
  const before = readFileSync(pendingDropPath(dropDir, OLD[0]!), 'utf8');
  const young = new Date(NOW.getTime() - (STUCK_AFTER * 1000 - MIN)).toISOString();
  const pane: Pane = { screen: SURVEY, typed: [], enters: 0 };
  const said: string[] = [];
  report(made, pane, said, NOW, young);
  expect(notices(made.dir)).toEqual([]);
  expect(said).toEqual([]);
  expect(pane.typed).toEqual([]);

  const old = new Date(NOW.getTime() - (STUCK_AFTER * 1000 + MIN)).toISOString();
  const recognised: Pane = { screen: IDLE, typed: [], enters: 0 };
  report(made, recognised, said, NOW, old);
  const first = notices(made.dir);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain(`presence says working since ${old}`);
  expect(first[0]).toContain('4 messages wait');
  expect(first[0]).not.toContain('screen not recognised');
  expect(recognised.typed).toEqual([]);
  expect(readFileSync(pendingDropPath(dropDir, OLD[0]!), 'utf8')).toBe(before);
  report(made, recognised, said, new Date(NOW.getTime() + 5 * MIN), old);
  expect(notices(made.dir)).toHaveLength(1);
});

test('an approval written before stuck_after still matches the same file', () => {
  const made = world();
  const team = teamOf(made.text);
  const current = fingerprints(team);
  const legacy = legacyWatchDigests(team, true).find((digest) => digest !== current.sections.watch);
  if (legacy === undefined) throw new Error('no earlier watch digest differs from the current one');
  expect(legacy).not.toBe(current.sections.watch);
  const record: ApprovalRecord = {
    file: made.text,
    approval: {
      format: 1,
      approvedAt: NOW.toISOString(),
      root: made.root,
      ceilings: { seats: 8, temporary: 0, vendors: {} },
      fingerprints: {
        sections: { ...current.sections, watch: legacy },
        seats: current.seats,
      },
    },
  };
  const adopted = approvedFingerprints(record);
  expect(adopted.sections.watch).toBe(current.sections.watch);
  expect(compare(adopted, current, team)).toEqual([]);
});

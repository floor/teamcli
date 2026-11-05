// Independent check of two contracts on the combined head.
// The Codex hint row under an empty composer reads idle, and the scroll-back wake sends one
// return key (src/watch/screen.ts, src/send/typed-wake.ts).
// The stuck marker's presence comes from the pass's folder listing: a pass with none does not
// read the file, and a pass whose listing shows one reads it once across the blocked-screen
// site, the stuck report and the 2N report (src/watch/unread.ts, src/watch/mail-pass.ts).
// Screens, keys and the clock are synthetic. No live host, CLI, or process signal is invoked.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readScreen, screenData } from '../src/watch/screen.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const realFs = await import('node:fs');
const stuckReads: string[] = [];
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  const real = realFs.readFileSync;
  Object.assign(wrapped, {
    readFileSync: (...args: unknown[]) => {
      const target = String(args[0]);
      if (target.endsWith('/.stuck')) stuckReads.push(target);
      return real.apply(realFs, args as Parameters<typeof real>);
    },
  });
  return wrapped as typeof realFs;
});
afterAll(() => {
  mock.module('node:fs', () => realFs);
});

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const SCROLL = readFileSync(join(FIXTURES, 'scroll-back.txt'), 'utf8');
const MARKER = readFileSync(join(FIXTURES, 'scroll-back-marker.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const HINT = readFileSync(join(FIXTURES, 'esc-hint.txt'), 'utf8');
const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2', 'idle.txt'), 'utf8');

const HINT_ROW = 'esc again to edit previous message';
const PROMPT = '› Ask Codex to do anything';
const LINE = 'fixture wake line';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const declared = screenData('codex')?.scrollBack?.returnKey;
if (declared === undefined) throw new Error('codex declares no scroll-back return key');
const RETURN: string = declared;

const NOW = new Date('2026-11-05T15:00:00.000Z');
const MIN = 60_000;
const WINDOW = 600;
const STUCK_AFTER = 900;
const SEAT = 'worker';
const OLD = '019a0000-eeee-7fff-8000-0000000000e1';
const YOUNG = '019a0000-eeee-7fff-8000-0000000000e2';
const ABSENT = '019a0000-eeee-7fff-8000-0000000000e3';
const SURVEY = [
  'Done.',
  '',
  'How is the session so far? [1] Good [2] Fine [3] Bad [0] Skip',
].join('\n');

const holding = (text: string): string => IDLE.replace(/› .*/, `› ${text}`);
const hintHolding = (text: string): string => HINT.replace(PROMPT, `› ${text}`);

type Wake = { host: TypedWakeHost; typed: string[]; keys: string[]; enters: () => number };

function wakeOf(screen: (read: number) => string | null): Wake {
  let reads = 0;
  let enters = 0;
  const typed: string[] = [];
  const keys: string[] = [];
  const host: TypedWakeHost = {
    read: () => screen(reads++),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
    key: (_pane, key) => {
      keys.push(key);
      return true;
    },
  };
  return { host, typed, keys, enters: () => enters };
}

function script(screens: readonly string[]): (read: number) => string {
  return (read) => screens[Math.min(read, screens.length - 1)] ?? '';
}

type World = { root: string; dir: string; home: string; text: string };
let bases: string[] = [];
let scratch = '';

afterEach(() => {
  if (bases.length > 0) discardFixtures(bases, { roots: scratch === '' ? [] : [scratch] });
  bases = [];
  stuckReads.length = 0;
});

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
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: test
    model: Fixture
    version: "1"
    launch: claude
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: antigravity
    vendor: test
    model: Fixture
    version: "1"
    launch: agy
`;
  writeFileSync(join(dir, 'team.yaml'), text, { mode: 0o600 });
  return { root, dir, home, text };
}

function teamOf(text: string) {
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return validated.team;
}

function seed(made: World, id: string, ageMs: number): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', SEAT);
  const record = signRecord({
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at: new Date(NOW.getTime() - ageMs).toISOString(),
    body: `fixture message ${id}`,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, made.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  return dropDir;
}

function leaveMarker(dropDir: string, ids: readonly string[]): string {
  const path = join(dropDir, '.stuck');
  writeFileSync(path, `${JSON.stringify({
    v: 1,
    at: NOW.toISOString(),
    class: 'screen',
    kind: 'unknown',
    ids: [...ids],
    notice: `fixture-notice-${ids.join('-')}`,
  })}\n`, { mode: 0o600 });
  return path;
}

function sourcesOf(screen: string): RetrySources {
  return {
    screen: () => screen,
    status: () => 'done',
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
  };
}

function liveWith(): Live {
  const agents: HerdrAgent[] = [
    { name: SEAT, agent: 'agy', pane: PANE, workspace: 'fixture-space', status: 'done', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function sceneOf(made: World, screen: string, mail?: RetryScene['mail']): RetryScene {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made.text),
    live: liveWith(),
    ownPane: null,
    sources: sourcesOf(screen),
    now: NOW,
    say: () => {},
    ...(mail === undefined ? {} : { mail }),
  };
}

function reading() {
  return { workingSince: new Map<string, string>(), stuckAfterSeconds: STUCK_AFTER };
}

async function api() {
  const unread = await import('../src/watch/unread.ts');
  const mail = await import('../src/watch/mail-pass.ts');
  return { unread, MailPass: mail.MailPass };
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

test('the hint under an empty composer, as the last non-blank row, reads idle', () => {
  const rows = HINT.split('\n').filter((line) => line.trim() !== '');
  expect(rows.at(-1)?.trim()).toBe(HINT_ROW);
  expect(rows.at(-2)).toContain('GPT-6.1-Sol high · Context 74% left · weekly 94% left');
  expect(rows.at(-3)).toBe(PROMPT);
  expect(readScreen('codex', HINT).kind).toBe('idle');
  expect(classifyComposer('codex', HINT.split('\n')).kind).toBe('idle');
  expect(readScreen('codex', `${HINT}\n\n\n`).kind).toBe('idle');
});

test('a near miss, a later row, or the hint with no composer does not read idle', () => {
  expect(readScreen('codex', HINT.replace(HINT_ROW, 'esc again to edit the previous message')).kind).toBe('unknown');
  expect(readScreen('codex', HINT.replace(HINT_ROW, `${HINT_ROW} now`)).kind).toBe('unknown');
  expect(readScreen('codex', `${HINT}\n• a later row\n`).kind).toBe('unknown');
  expect(readScreen('codex', `• a transcript row\n  ${HINT_ROW}\n`).kind).toBe('unknown');
});

test('a composer holding text reads unsent, hint row or none', () => {
  const draft = hintHolding('a draft left unsent');
  expect(readScreen('codex', draft).kind).toBe('unsent');
});

test('a transcript line quoting the hint is not the hint row', () => {
  const quoted = MARKER.replace(
    '• Merged into the release branch.',
    `• the pane printed ${HINT_ROW}`,
  );
  expect(quoted).not.toBe(MARKER);
  expect(readScreen('codex', quoted).kind).toBe('scroll back');
  const idleWithQuote = IDLE.replace(PROMPT, `• the pane printed ${HINT_ROW}\n\n${PROMPT}`);
  expect(readScreen('codex', idleWithQuote).kind).toBe('idle');
});

test('scroll back, one return, then the hint on both idle reads, types the line and delivers', async () => {
  const drawn = [holding(LINE), holding(LINE), WORKING];
  for (const layout of [MARKER, SCROLL]) {
    const wake = wakeOf(script([layout, HINT, HINT, ...drawn]));
    const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1 });
    expect(out.reason).toContain('working screen showed after 1 Enter');
    expect(wake.keys).toEqual([RETURN]);
    expect(wake.typed).toEqual([LINE]);
    expect(wake.enters()).toBe(1);
  }
});

test('a pane that stays scrolled back after the return gets one key and no second', async () => {
  const wake = wakeOf(() => MARKER);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out).toMatchObject({ delivered: false, typed: true, tries: 0 });
  expect(out.reason).toContain('scroll back');
  expect(out.reason).toContain('no wake line was typed');
  expect(wake.keys).toEqual([RETURN]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a near-miss hint and an unsent box after the return each get one key and no line', async () => {
  const near = HINT.replace(HINT_ROW, `${HINT_ROW} now`);
  const draft = hintHolding('a draft left unsent');
  for (const after of [near, draft]) {
    const wake = wakeOf((read) => (read === 0 ? SCROLL : after));
    const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
    expect(out.delivered).toBe(false);
    expect(out.tries).toBe(0);
    expect(out.reason).toContain('no wake line was typed');
    expect(wake.keys).toEqual([RETURN]);
    expect(wake.typed).toEqual([]);
    expect(wake.enters()).toBe(0);
  }
});

test('a pass with no stuck marker never reads one', async () => {
  expect(readScreen('antigravity', SURVEY).kind).toBe('unknown');
  const { unread, MailPass } = await api();
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const mail = new MailPass({ dir: made.dir, root: made.root, session: 'acme', home: made.home });
  const scene = sceneOf(made, AGY_IDLE, mail);

  unread.reportStuckSeats(scene, { unreadAfter: WINDOW }, reading());
  rmSync(join(dropDir, '.stuck'));
  unread.reportUnreadDrops(scene, { unreadAfter: WINDOW }, reading());

  expect(stuckReads).toEqual([]);
  const notices = leadNotices(made);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('screen idle');
  expect(existsSync(join(dropDir, '.stuck'))).toBe(false);
});

test('the blocked screen, the stuck report and the 2N report share one read of a listed marker', async () => {
  const { unread, MailPass } = await api();
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const marker = leaveMarker(dropDir, [OLD]);
  const mail = new MailPass({ dir: made.dir, root: made.root, session: 'acme', home: made.home });
  const scene = sceneOf(made, SURVEY, mail);

  await unread.wakeUnreadDrops(scene, { unreadAfter: WINDOW });
  rmSync(marker);
  unread.reportStuckSeats(scene, { unreadAfter: WINDOW }, reading());
  unread.reportUnreadDrops(scene, { unreadAfter: WINDOW }, reading());

  expect(stuckReads).toEqual([marker]);
  expect(leadNotices(made)).toEqual([]);
});

test('a marker this pass gave back lets the 2N report speak', async () => {
  const { unread, MailPass } = await api();
  const made = world();
  const dropDir = seed(made, YOUNG, MIN);
  const marker = leaveMarker(dropDir, [ABSENT]);
  const mail = new MailPass({ dir: made.dir, root: made.root, session: 'acme', home: made.home });
  const scene = sceneOf(made, AGY_IDLE, mail);

  unread.reportStuckSeats(scene, { unreadAfter: WINDOW }, reading());
  expect(existsSync(marker)).toBe(false);
  expect(leadNotices(made)).toEqual([]);
  expect(stuckReads).toEqual([marker]);

  unread.reportUnreadDrops(scene, { unreadAfter: 30 }, reading());
  expect(stuckReads).toEqual([marker]);
  const notices = leadNotices(made);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(SEAT);
});

test('a listed marker that cannot be read is opened once and is not an episode', async () => {
  const { unread, MailPass } = await api();
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const marker = join(dropDir, '.stuck');
  writeFileSync(marker, 'not a marker\n', { mode: 0o600 });
  const mail = new MailPass({ dir: made.dir, root: made.root, session: 'acme', home: made.home });
  const scene = sceneOf(made, AGY_IDLE, mail);

  unread.reportStuckSeats(scene, { unreadAfter: WINDOW }, reading());
  unread.reportUnreadDrops(scene, { unreadAfter: WINDOW }, reading());

  expect(stuckReads).toEqual([marker]);
  expect(readFileSync(marker, 'utf8')).toBe('not a marker\n');
  const notices = leadNotices(made);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('queued, not woken');
});

test('separate passes each read a marker the folder still lists', async () => {
  const { unread } = await api();
  const made = world();
  const dropDir = seed(made, OLD, 120 * MIN);
  const marker = leaveMarker(dropDir, [OLD]);
  const scene = sceneOf(made, AGY_IDLE);

  unread.reportStuckSeats(scene, { unreadAfter: WINDOW }, reading());
  unread.reportUnreadDrops(scene, { unreadAfter: WINDOW }, reading());

  expect(stuckReads).toEqual([marker, marker]);
  expect(leadNotices(made)).toEqual([]);
});

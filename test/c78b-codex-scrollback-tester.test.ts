// Independent verification of the second Codex scroll-back layout
// (src/watch/screen.ts, src/send/typed-wake.ts, src/watch/unread.ts). The marker sits on the
// nearest row above the drawn composer and the status footer is the pane's last non-blank row.
// Screens, keys and the clock are synthetic. No live host, CLI, or process signal is invoked.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { dropMessage } from '../src/send/native.ts';
import { readRecord, signRecord } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { classifyComposer, readScreen, screenData } from '../src/watch/screen.ts';
import { wakeUnreadDrops } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const MARKER_FRAME = readFileSync(join(FIXTURES, 'scroll-back-marker.txt'), 'utf8');
const FIRST_LAYOUT = readFileSync(join(FIXTURES, 'scroll-back.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const MARKER = '↓ Back to bottom · esc';
const WORKING_ROW = WORKING.split('\n').find((line) => line.includes('esc to interrupt')) ?? '';

const markerRows = MARKER_FRAME.split('\n');
const markerAt = markerRows.findIndex((line) => line.trim() === MARKER);
let statusAt = markerRows.length - 1;
while (statusAt >= 0 && (markerRows[statusAt] ?? '').trim() === '') statusAt -= 1;
const STATUS = markerRows[statusAt] ?? '';

const NOW = new Date('2026-11-05T12:30:00.000Z');
const MIN = 60_000;
const UNREAD = '019a0000-bbbb-7ccc-8ddd-eeeeffff0000';
const LINE = 'fixture wake line';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const declared = screenData('codex')?.scrollBack?.returnKey;
if (declared === undefined) throw new Error('codex declares no scroll-back return key');
const RETURN: string = declared;

const holding = (text: string): string => IDLE.replace(/› .*/, `› ${text}`);
const replaceMarker = (row: string): string =>
  markerRows.map((line) => (line.trim() === MARKER ? row : line)).join('\n');

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
    key: (_pane, key) => {
      keys.push(key);
      return true;
    },
    wait: async () => {},
  };
  return { host, typed, keys, enters: () => enters };
}

function script(screens: readonly string[]): (read: number) => string {
  return (read) => screens[Math.min(read, screens.length - 1)] ?? '';
}

let bases: string[] = [];
let scratch = '';

afterEach(() => {
  if (bases.length > 0) discardFixtures(bases, { roots: scratch === '' ? [] : [scratch] });
  bases = [];
});

function world(): { root: string; dir: string; home: string; team: TeamFile } {
  const base = fixtureBase('c78b-');
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
    cli: codex
    vendor: test
    model: Fixture
    version: "1"
    launch: codex
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return { root, dir, home, team: validated.team };
}

function seed(made: { root: string; dir: string; home: string }): void {
  const dropDir = join(made.dir, 'send-drops', 'acme', SEAT);
  const at = new Date(NOW.getTime() - 11 * MIN);
  const record = signRecord({
    kind: 'message',
    id: UNREAD,
    to: SEAT,
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at: at.toISOString(),
    body: 'from the owner\n\nfixture wake me',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: UNREAD,
  }, made.home);
  dropMessage(dropDir, UNREAD, `${JSON.stringify(record, null, 2)}\n`);
}

function sources(status: string | null, calls: { pane: string; line: string }[]): RetrySources {
  return {
    screen: () => MARKER_FRAME,
    status: () => status,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    typedWake: async (pane, line) => {
      calls.push({ pane, line });
      return { delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' };
    },
  };
}

function sceneOf(made: { root: string; dir: string; home: string; team: TeamFile }, said: string[], status: string | null, calls: { pane: string; line: string }[]) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: made.team,
    live: {
      running: true,
      agents: [
        { name: SEAT, agent: 'codex', pane: PANE, workspace: 'fixture-space', status: status ?? 'unknown', cwd: null },
        { name: 'lead', agent: 'claude', pane: 'fixture-pane-lead', workspace: 'fixture-lead', status: 'working', cwd: null },
      ],
      workspaces: [],
      screens: {},
    } satisfies Live,
    ownPane: null,
    sources: sources(status, calls),
    now: NOW,
    say: (text: string) => {
      said.push(text);
    },
  };
}

function leadDrops(dir: string): string[] {
  const dropDir = join(dir, 'send-drops', 'acme', 'lead');
  if (!existsSync(dropDir)) return [];
  return readdirSync(dropDir).filter((name) => MESSAGE_ID.test(name));
}

async function woken(status: string | null): Promise<{ calls: { pane: string }[]; said: string[]; drops: string[] }> {
  const made = world();
  seed(made);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  await wakeUnreadDrops(sceneOf(made, said, status, calls), { unreadAfter: 60 });
  const read = leadDrops(made.dir);
  if (read.length === 1) {
    const id = read[0];
    if (id !== undefined) {
      const body = readRecord(join(made.dir, 'send-drops', 'acme', 'lead', id), id);
      if (body.ok && body.record !== null) said.push(body.record.payload.body);
    }
  }
  return { calls, said, drops: read };
}

test('the marker above the composer, with the status footer last, gets one return key, then the line, then Enter', async () => {
  expect(markerAt).toBeGreaterThan(0);
  expect(STATUS).toContain('Earlier messages available.');
  expect(readScreen('codex', MARKER_FRAME).kind).toBe('scroll back');
  expect(readScreen('codex', FIRST_LAYOUT).kind).toBe('scroll back');
  expect(classifyComposer('codex', markerRows).kind).toBe('unknown');
  const wake = wakeOf(script([MARKER_FRAME, IDLE, IDLE, holding(LINE), holding(LINE), WORKING]));
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.delivered).toBe(true);
  expect(out.tries).toBe(1);
  expect(wake.keys).toEqual([RETURN]);
  expect(wake.typed).toEqual([LINE]);
  expect(wake.enters()).toBe(1);
});

test('a transcript row that only contains the marker words gets no key', async () => {
  const spoken = replaceMarker(`fixture log printed ${MARKER} before the merge`);
  expect(readScreen('codex', spoken).kind).toBe('unknown');
  const wake = wakeOf(() => spoken);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.typed).toBe(false);
  expect(wake.keys).toEqual([]);
  expect(wake.typed).toEqual([]);
});

test('an exact marker with a printed row between it and the composer gets no key', async () => {
  const displaced = [
    ...markerRows.slice(0, markerAt + 1),
    'fixture row the seat printed',
    ...markerRows.slice(markerAt + 1),
  ].join('\n');
  expect(readScreen('codex', displaced).kind).toBe('unknown');
  const wake = wakeOf(() => displaced);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.typed).toBe(false);
  expect(wake.keys).toEqual([]);
});

test('a near-miss status footer gets no key', async () => {
  const near = MARKER_FRAME.replace('Earlier messages available.', 'Earlier messages are available.');
  expect(near).not.toBe(MARKER_FRAME);
  expect(readScreen('codex', near).kind).toBe('unknown');
  const wake = wakeOf(() => near);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.typed).toBe(false);
  expect(wake.keys).toEqual([]);
});

test('a working row in the bottom region sends no key', async () => {
  expect(WORKING_ROW).not.toBe('');
  const frame = replaceMarker(`${WORKING_ROW}\n\n${MARKER}`);
  expect(readScreen('codex', frame).kind).toBe('working');
  const wake = wakeOf(() => frame);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.typed).toBe(false);
  expect(out.reason).toContain('working');
  expect(wake.keys).toEqual([]);
});

test('a due message on the marker layout is woken for an idle, unknown, or null host word', async () => {
  for (const status of ['idle', 'unknown', null] as const) {
    const seen = await woken(status);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]?.pane).toBe(PANE);
    expect(seen.said.join('\n')).toContain('typed wake');
    expect(seen.drops).toEqual([]);
  }
});

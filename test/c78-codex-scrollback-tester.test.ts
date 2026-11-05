// Independent verification of the Codex scroll-back wake and the late blocked-screen notice
// (src/send/typed-wake.ts, src/watch/screen.ts, src/watch/unread.ts). Screens, keys and the
// clock are synthetic. No live host, CLI, or process signal is invoked.
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
import { reportUnreadDrops, wakeUnreadDrops } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const SCROLL = readFileSync(join(FIXTURES, 'scroll-back.txt'), 'utf8');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

const rows = SCROLL.split('\n');
let footerAt = rows.length - 1;
while (footerAt >= 0 && (rows[footerAt] ?? '').trim() === '') footerAt -= 1;
const FOOTER = rows[footerAt] ?? '';
const WITHOUT_FOOTER = rows.filter((_row, index) => index !== footerAt).join('\n');
const TRANSCRIPT = [FOOTER, ...rows.filter((_row, index) => index !== footerAt)].join('\n');
const WORKING_UNDER_FOOTER = `${WORKING}\n${FOOTER}\n`;

const NOW = new Date('2026-11-05T11:40:00.000Z');
const MIN = 60_000;
const UNREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const LINE = 'fixture wake line';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const declared = screenData('codex')?.scrollBack?.returnKey;
if (declared === undefined) throw new Error('codex declares no scroll-back return key');
const RETURN: string = declared;

const holding = (text: string): string => IDLE.replace(/› .*/, `› ${text}`);

type Wake = { host: TypedWakeHost; typed: string[]; keys: string[]; enters: () => number };

function wakeOf(screen: (read: number) => string | null, bound = true): Wake {
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
    ...(bound ? { key: (_pane: string, key: string) => { keys.push(key); return true; } } : {}),
  };
  return { host, typed, keys, enters: () => enters };
}

function script(screens: readonly string[]): (read: number) => string {
  return (read) => screens[Math.min(read, screens.length - 1)] ?? '';
}

let base = '';
let scratch = '';

afterEach(() => {
  if (base !== '') discardFixtures([base], { roots: [scratch] });
  base = '';
});

function world(): { root: string; dir: string; home: string; team: TeamFile } {
  base = fixtureBase('c78sb-');
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

function seed(made: { root: string; dir: string; home: string }, ageMin: number): void {
  const dropDir = join(made.dir, 'send-drops', 'acme', SEAT);
  const at = new Date(NOW.getTime() - ageMin * MIN);
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

function live(status: string): Live {
  return {
    running: true,
    agents: [
      { name: SEAT, agent: 'codex', pane: PANE, workspace: 'fixture-space', status, cwd: null },
      { name: 'lead', agent: 'claude', pane: 'fixture-pane-lead', workspace: 'fixture-lead', status: 'working', cwd: null },
    ],
    workspaces: [],
    screens: {},
  };
}

function sources(screen: string, status: string | null, calls: { pane: string; line: string }[]): RetrySources {
  return {
    screen: () => screen,
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

function sceneOf(
  made: { root: string; dir: string; home: string; team: TeamFile },
  said: string[],
  screen: string,
  status: string | null,
  calls: { pane: string; line: string }[],
) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: made.team,
    live: live(status ?? 'unknown'),
    ownPane: null,
    sources: sources(screen, status, calls),
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

function leadBody(dir: string): string {
  const ids = leadDrops(dir);
  expect(ids).toHaveLength(1);
  const id = ids[0];
  if (id === undefined) throw new Error('the lead report is missing');
  const read = readRecord(join(dir, 'send-drops', 'acme', 'lead', id), id);
  if (!read.ok || read.record === null) throw new Error('the lead report did not verify');
  return read.record.payload.body;
}

test('a scroll-back footer with the composer hidden gets one return key, then the line, then Enter', async () => {
  expect(RETURN).toBeString();
  expect(readScreen('codex', SCROLL).kind).toBe('scroll back');
  expect(classifyComposer('codex', SCROLL.split('\n')).kind).toBe('unknown');
  const wake = wakeOf(script([SCROLL, IDLE, IDLE, holding(LINE), holding(LINE), WORKING]));
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.delivered).toBe(true);
  expect(out.tries).toBe(1);
  expect(wake.keys).toEqual([RETURN]);
  expect(wake.typed).toEqual([LINE]);
  expect(wake.enters()).toBe(1);
});

test('a footer-shaped transcript row is not scroll back and gets no key', async () => {
  expect(readScreen('codex', TRANSCRIPT).kind).toBe('unknown');
  const wake = wakeOf(() => TRANSCRIPT);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.delivered).toBe(false);
  expect(out.typed).toBe(false);
  expect(out.reason).toContain('unknown');
  expect(wake.keys).toEqual([]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a draft revealed after the return refuses, with no wake line', async () => {
  const draft = holding('fixture draft left unsent');
  expect(readScreen('codex', draft).kind).toBe('unsent');
  const wake = wakeOf((read) => (read === 0 ? SCROLL : draft));
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out).toMatchObject({ delivered: false, typed: true, tries: 0 });
  expect(out.reason).toContain('unsent');
  expect(out.reason).toContain('no wake line was typed');
  expect(wake.keys).toEqual([RETURN]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a working screen sends no key', async () => {
  expect(readScreen('codex', WORKING_UNDER_FOOTER).kind).toBe('working');
  const wake = wakeOf(() => WORKING_UNDER_FOOTER);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out.delivered).toBe(false);
  expect(out.typed).toBe(false);
  expect(out.reason).toContain('working');
  expect(out.reason).toContain('nothing was typed');
  expect(wake.keys).toEqual([]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a host with no return key refuses without a key', async () => {
  const wake = wakeOf(() => SCROLL, false);
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out).toMatchObject({ delivered: false, typed: false, tries: 0 });
  expect(out.reason).toContain('no return key is bound');
  expect(wake.keys).toEqual([]);
  expect(wake.typed).toEqual([]);
  expect(wake.enters()).toBe(0);
});

test('a due message behind an unreadable screen notifies the lead once, even past 2N', async () => {
  expect(readScreen('codex', WITHOUT_FOOTER).kind).toBe('unknown');
  const made = world();
  seed(made, 11);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  const scene = sceneOf(made, said, WITHOUT_FOOTER, 'unknown', calls);
  await wakeUnreadDrops(scene, { unreadAfter: 60 });
  expect(calls).toEqual([]);
  expect(said).toHaveLength(1);
  expect(said[0]).toContain('delivered-but-blocked');
  expect(leadBody(made.dir)).toContain('unknown');

  await wakeUnreadDrops(scene, { unreadAfter: 60 });
  reportUnreadDrops(scene, { unreadAfter: 60 });
  expect(said).toHaveLength(1);
  expect(leadDrops(made.dir)).toHaveLength(1);
});

test('a scroll-back pane whose host status is unknown is woken, and the lead is not told', async () => {
  expect(readScreen('codex', SCROLL).kind).toBe('scroll back');
  const made = world();
  seed(made, 11);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  await wakeUnreadDrops(sceneOf(made, said, SCROLL, 'unknown', calls), { unreadAfter: 60 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.pane).toBe(PANE);
  expect(said.join('\n')).toContain('typed wake');
  expect(said.join('\n')).not.toContain('delivered-but-blocked');
  expect(leadDrops(made.dir)).toEqual([]);
});

test('a scroll-back pane whose host status is null is woken, and the lead is not told', async () => {
  const made = world();
  seed(made, 11);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  await wakeUnreadDrops(sceneOf(made, said, SCROLL, null, calls), { unreadAfter: 60 });
  expect(calls).toHaveLength(1);
  expect(said.join('\n')).toContain('typed wake');
  expect(leadDrops(made.dir)).toEqual([]);
});

test('a scroll-back pane whose host status is working is left, with no notice', async () => {
  const made = world();
  seed(made, 11);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  await wakeUnreadDrops(sceneOf(made, said, SCROLL, 'working', calls), { unreadAfter: 60 });
  expect(calls).toEqual([]);
  expect(said).toEqual([]);
  expect(leadDrops(made.dir)).toEqual([]);
});

test('a recognised idle seat gets no blocked-screen notice', async () => {
  expect(readScreen('codex', IDLE).kind).toBe('idle');
  const made = world();
  seed(made, 11);
  const calls: { pane: string; line: string }[] = [];
  const said: string[] = [];
  await wakeUnreadDrops(sceneOf(made, said, IDLE, 'idle', calls), { unreadAfter: 60 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.pane).toBe(PANE);
  expect(said.join('\n')).not.toContain('delivered-but-blocked');
  expect(leadDrops(made.dir)).toEqual([]);
});

// The nightly result `team check` reads: a class over its send-to-read target, a lost message,
// or a result older than a day, each naming the run's date. A missing file and a class inside
// its target draw nothing. The check scene plants the file the harness would have written.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { documentOf, findingsOf, NIGHTLY_FRESH_MS, PINGPONG_LEGS_FILE, pingpongLegDifferences, type PingpongLegsDocument } from '../src/check/pingpong-legs.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const RAN = '2026-11-03T02:00:00.000Z';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function legs(over: Partial<Record<'channel' | 'webhook' | 'typed' | 'mailbox', { n: number; p50: number | null; p95: number | null }>>, lost = 0, ranAt = RAN): PingpongLegsDocument {
  const classes = ['channel', 'webhook', 'typed', 'mailbox'] as const;
  return {
    schema: 'team.pingpong-legs',
    version: 1,
    ranAt,
    lost,
    legs: classes.map((name) => ({ class: name, n: 0, p50: null, p95: null, ...over[name] })),
  };
}

function whats(doc: PingpongLegsDocument, now = NOW): string[] {
  return findingsOf(doc, now).map((finding) => finding.what);
}

test('a class over its target is named with the run date, and the target itself is not', () => {
  expect(whats(legs({ channel: { n: 4, p50: 4_000, p95: 7_000 } }))).toEqual([
    'nightly run 2026-11-03: channel p50 4s is over 3s and p95 7s is over 6s',
  ]);
  expect(whats(legs({ webhook: { n: 2, p50: 1_500, p95: 5_100 } }))).toEqual([
    'nightly run 2026-11-03: webhook p95 5.1s is over 5s',
  ]);
  expect(whats(legs({ typed: { n: 1, p50: 12_000, p95: 20_000 } }))).toEqual([]);
  expect(whats(legs({ mailbox: { n: 3, p50: 60_000, p95: 90_000 } }))).toEqual([]);
  expect(whats(legs({ channel: { n: 0, p50: 9_000, p95: 9_000 } }))).toEqual([]);
});

test('a lost message is its own finding, and a result older than 36 hours is stale', () => {
  expect(whats(legs({}, 1))).toEqual(['nightly run 2026-11-03: 1 message was lost']);
  expect(whats(legs({ typed: { n: 1, p50: 13_000, p95: 19_000 } }, 2))).toEqual([
    'nightly run 2026-11-03: typed p50 13s is over 12s',
    'nightly run 2026-11-03: 2 messages were lost',
  ]);
  const fresh = new Date(NOW.getTime() - NIGHTLY_FRESH_MS).toISOString();
  expect(whats(legs({}, 0, fresh))).toEqual([]);
  const stale = new Date(NOW.getTime() - NIGHTLY_FRESH_MS - 1).toISOString();
  expect(whats(legs({ channel: { n: 1, p50: 3_100, p95: 4_000 } }, 0, stale))).toEqual([
    `nightly run ${stale.slice(0, 10)} is older than a day`,
    `nightly run ${stale.slice(0, 10)}: channel p50 3.1s is over 3s`,
  ]);
});

test('a document that is not the result cannot be read, and a missing file draws nothing', () => {
  expect(documentOf({ schema: 'team.pingpong-legs', version: 2, ranAt: RAN, lost: 0, legs: [] })).toBeNull();
  expect(documentOf({ schema: 'other', version: 1, ranAt: RAN, lost: 0, legs: [] })).toBeNull();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-legs-')));
  made.push(base);
  expect(pingpongLegDifferences(base, NOW)).toEqual([]);
  writeFileSync(join(base, PINGPONG_LEGS_FILE), '{', 'utf8');
  expect(pingpongLegDifferences(base, NOW).map((finding) => finding.what)).toEqual([
    'the nightly run result cannot be read',
  ]);
});

test('a lost count that is not a whole number draws the unreadable finding, in the check\'s own words', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-legs-')));
  made.push(base);
  writeFileSync(join(base, PINGPONG_LEGS_FILE), `${JSON.stringify(legs({}, 1.5))}\n`, 'utf8');
  expect(pingpongLegDifferences(base, NOW)).toEqual([
    {
      what: 'the nightly run result cannot be read',
      repair: 'the next nightly rewrites the result',
      who: "the team's lead",
    },
  ]);
});

function world(): { root: string; text: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-legs-check-')));
  made.push(base);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: remote
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      const workspace = `w${String(index + 1)}`;
      session.seats[seat.name] = { stage: 'ready', pane: `${workspace}-pane`, workspace, cli: seat.cli };
    });
  });
  return { root, text };
}

function live(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => {
      const workspace = `w${String(index + 1)}`;
      return {
        name: seat.name,
        agent: 'claude',
        pane: `${workspace}-pane`,
        workspace,
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(seat),
      };
    }),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `w${String(index + 1)}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`w${String(index + 1)}-pane`, CLAUDE_IDLE])),
  };
}

function check(root: string, text: string): { code: number; out: string } {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(text),
    branch: () => 'main',
    standing: () => verifiedOf(parsed.team, text, root, NOW),
    now: () => NOW,
    home: root,
    alive: () => true,
  });
  return { code, out: `${io.out}${io.err}` };
}

function differenceCount(out: string): number {
  return out.split('difference: ').length - 1;
}

test('team check names the planted nightly result and stays quiet when the file is absent', () => {
  const w = world();
  const before = check(w.root, w.text);
  expect(before.out).not.toContain('nightly run');

  writeFileSync(join(w.root, '.agents', PINGPONG_LEGS_FILE), `${JSON.stringify(legs({ channel: { n: 4, p50: 4_000, p95: 7_000 } }, 1))}\n`, 'utf8');
  const after = check(w.root, w.text);
  expect(after.out).toContain('difference: nightly run 2026-11-03: channel p50 4s is over 3s and p95 7s is over 6s');
  expect(after.out).toContain('difference: nightly run 2026-11-03: 1 message was lost');
  expect(differenceCount(after.out)).toBe(differenceCount(before.out) + 2);
  expect(after.code).toBe(1);
});

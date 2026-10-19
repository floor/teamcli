// `team check` names unread work: every seat carrying a message with no signed read receipt
// past `watch.unread_after` gets one difference, read through the same `listUnread` the watch's
// unread wake uses. A read receipt clears it, a message inside the window is not named, the
// general seat brief keeps its own read difference, and a person's drop is never asked for a
// receipt. The pane here is a scripted screen; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T03:50:00.000Z');
const MIN = 60_000;
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000301';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000302';

const TEXT = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
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
  - role: implementer
    name: person
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    human: true
`;

type World = { base: string; root: string; home: string; dir: string; session: string; labels: Record<string, string> };

let made: World | undefined;

afterEach(() => {
  if (made) rmSync(made.base, { recursive: true, force: true });
  made = undefined;
});

/** One checkout: the file's two seats recorded ready, and the launch's briefs delivered. The
 *  briefs may be left unread, for the scene that pins the brief's own difference. */
function place(briefRead = true, briefAt = NOW): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-unread-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  const parsed = validateTeamFile(TEXT);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const session = parsed.team.session;
  const dir = join(root, '.agents');
  updateState(dir, (state) => {
    const one = (state.sessions[session] ??= emptySession());
    one.watch = { pid: 1, heartbeat: NOW.toISOString() };
    one.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1', watcher: 'hook' };
    one.seats.person = { stage: 'ready', pane: 'w2:p1', workspace: 'w2', watcher: 'hook' };
  });
  deliverBriefs({
    dir,
    root,
    session,
    seats: ['lead', 'person'],
    home,
    at: briefAt.toISOString(),
    ...(briefRead ? {} : { read: false as const }),
  });
  const labels: Record<string, string> = {};
  for (const seat of parsed.team.seats) labels[seat.name] = workspaceLabel(seat);
  made = { base, root, home, dir, session, labels };
  return made;
}

/** Both seats idle, on screens the profile reads as idle, each in its own workspace. */
function live(labels: Record<string, string>): Live {
  return {
    running: true,
    agents: [
      { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
      { name: 'person', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
    ],
    workspaces: [
      { id: 'w1', label: labels.lead ?? '' },
      { id: 'w2', label: labels.person ?? '' },
    ],
    screens: { 'w1:p1': CLAUDE_IDLE, 'w2:p1': CLAUDE_IDLE },
  };
}

function check(at: World): { code: number; out: string } {
  const io = testIo(at.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(at.labels),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
  });
  return { code, out: `${io.out}${io.err}` };
}

/** A delivered message, signed by this checkout's message key, aged by its mtime. No marker is
 *  written: the record's own `from` is what the check must name. */
function seed(at: World, seat: string, id: string, minutesOld: number, from = 'owner'): void {
  const ts = new Date(NOW.getTime() - minutesOld * MIN);
  const dropDir = join(at.dir, 'send-drops', at.session, seat);
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(at.root),
    session: at.session,
    at: ts.toISOString(),
    body: `work ${id}`,
    from,
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, id), new Date(), ts);
}

/** The receipt the seat's own `team drops --read` writes, through the same reader the CLI uses. */
function read(at: World, seat: string, id: string): void {
  const dropDir = join(at.dir, 'send-drops', at.session, seat);
  const receipt = readMessage({ dropDir, root: realpathSync(at.root), seat, session: at.session }, id, at.home);
  if (!receipt.ok) throw new Error(receipt.reason);
}

describe('unread work in team check', () => {
  test('a quiet team names no unread work', () => {
    const at = place();
    const { code, out } = check(at);
    expect(out).not.toContain('has been unread');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a message past the window names the seat, the sender and the age', () => {
    const at = place();
    seed(at, 'lead', ID_A, 11);
    const { code, out } = check(at);
    expect(out).toContain(`difference: lead: a message from owner has been unread for 11 min (id ${ID_A})`);
    expect(out).toContain('  repair: the seat\'s next turn reads it (team drops --read --seat lead)');
    expect(code).toBe(1);
  });

  test('a message inside the window is not named', () => {
    const at = place();
    seed(at, 'lead', ID_A, 5);
    const { code, out } = check(at);
    expect(out).not.toContain('has been unread');
    expect(code).toBe(0);
  });

  test('a signed read receipt clears it', () => {
    const at = place();
    seed(at, 'lead', ID_A, 11);
    read(at, 'lead', ID_A);
    const { code, out } = check(at);
    expect(out).not.toContain('has been unread');
    expect(code).toBe(0);
  });

  test('the oldest is named and the rest are counted', () => {
    const at = place();
    seed(at, 'lead', ID_A, 11);
    seed(at, 'lead', ID_B, 25, 'helper-2');
    const { code, out } = check(at);
    expect(out).toContain(`difference: lead: a message from helper-2 has been unread for 25 min; 1 more unread (id ${ID_B})`);
    expect(code).toBe(1);
  });

  test("a verified record's sender wins over the marker's unsigned word", () => {
    const at = place();
    seed(at, 'lead', ID_A, 11);
    const ts = new Date(NOW.getTime() - 11 * MIN);
    writeFileSync(
      join(at.dir, 'send-drops', at.session, 'lead', `${ID_A}.pending`),
      JSON.stringify({ id: ID_A, from: 'helper-2', ts: ts.toISOString() }),
    );

    const { code, out } = check(at);

    expect(out).toContain(`difference: lead: a message from owner has been unread for 11 min (id ${ID_A})`);
    expect(out).not.toContain('from helper-2');
    expect(code).toBe(1);
  });

  test('an unverified record never lends its marker word a sender', () => {
    const at = place();
    const ts = new Date(NOW.getTime() - 11 * MIN);
    const dropDir = join(at.dir, 'send-drops', at.session, 'lead');
    const record = signRecord({
      kind: 'message',
      id: ID_A,
      to: 'lead',
      to_id: null,
      root: realpathSync(at.root),
      session: at.session,
      at: ts.toISOString(),
      body: `work ${ID_A}`,
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      thread: ID_A,
    }, at.home);
    record.signature = `${record.signature.slice(0, -4)}AAAA`;
    dropMessage(dropDir, ID_A, `${JSON.stringify(record, null, 2)}\n`);
    utimesSync(join(dropDir, ID_A), new Date(), ts);
    writeFileSync(
      join(dropDir, `${ID_A}.pending`),
      JSON.stringify({ id: ID_A, from: 'owner', ts: ts.toISOString() }),
    );

    const { code, out } = check(at);

    expect(out).toContain(`difference: lead: an unverified message has been unread for 11 min (id ${ID_A})`);
    expect(out).not.toContain('a message from owner');
    expect(code).toBe(1);
  });

  test('the general seat brief keeps its own read difference and is not unread work', () => {
    const at = place(false, new Date(NOW.getTime() - 20 * MIN));
    const { code, out } = check(at);
    expect(out).toContain('the general seat brief has been delivered and not read');
    expect(out).not.toContain('has been unread');
    expect(code).toBe(1);
  });

  test('a person\'s drop is never asked for a receipt', () => {
    const at = place();
    seed(at, 'person', ID_A, 30);
    const { code, out } = check(at);
    expect(out).not.toContain('has been unread');
    expect(code).toBe(0);
  });
});

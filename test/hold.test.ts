// `team hold` at its edges: one record in the state, the session walk's caller rule, `--until`'s
// two shapes, and the expiry that needs no writer. The status note and the doctor line are their
// readers: the note lives in status.test.ts beside the reading it joins, and the doctor line is
// pinned here against a plain run, as `doctor-machine.test.ts` pins its finding.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { type Caller } from '../src/caller.ts';

const HOLD_ROUTE = 'only the owner, the orchestrator or the operator runs this, from a terminal outside herdr or its own seat';
import { runDoctor, holdFindings, type DoctorSources } from '../src/commands/doctor.ts';
import { runHold, type HoldSources } from '../src/commands/hold.ts';
import { HOLD_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { emptySession, holdText, liveHold, readState, updateState, type HoldRecord } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
session: acme
operator: lead
workspace:
  mode: shared
watch:
  idle_first: 10m
  idle_repeat: 20m
  team_idle: 10m
  nudge_wait: 10m
  unsent_after: 1m
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const NOW = new Date('2026-10-04T09:00:00Z');
const OWNER: Caller = { kind: 'owner' };

// The one seat the fixture declares, placed where the state records it: the caller the caller
// rule admits beside the owner.
const ORCHESTRATOR: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };

function place(): { root: string; home: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hold-')));
  files.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  return { root, home, file };
}

const files: string[] = [];

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function hold(
  argv: string[],
  where: { root: string; home: string },
  caller: Caller = OWNER,
  now: Date = NOW,
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const code = await runHold(argv, io, { home: where.home, now: () => now } satisfies HoldSources);
  return { code, out: io.out, err: io.err };
}

/** The state file as written, so a refused call can be pinned byte for byte against the one
 *  before it. */
function stateText(where: { root: string }): string {
  return readFileSync(join(where.root, '.agents', 'team.state.json'), 'utf8');
}

/** Record a pane for the orchestrator's seat, the way a launch would: the caller rule admits a
 *  seat only on the pane the state holds for it. */
function recordPane(where: { root: string }, name: string, pane: string): void {
  updateState(join(where.root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}

const stored = (where: { root: string }): HoldRecord | undefined => readState(join(where.root, '.agents')).hold;

/** An instant's local clock, the `<HH:MM>` `--until` reads. */
function clockOf(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

describe('the hold reading', () => {
  test('a record past its until reads as no hold, and the record itself is left where it is', () => {
    const state = { format: 1 as const, sessions: {} };
    expect(liveHold(state, NOW)).toBeNull();
    const record: HoldRecord = { reason: 'freeze', by: 'owner', at: '2026-10-04T08:00:00.000Z' };
    expect(liveHold({ ...state, hold: record }, NOW)).toEqual(record);
    expect(liveHold({ ...state, hold: { ...record, until: '2026-10-04T09:00:01.000Z' } }, NOW)).toEqual({
      ...record,
      until: '2026-10-04T09:00:01.000Z',
    });
    // The boundary is the instant itself: at `until` the hold has lapsed.
    const withLapsed = { ...state, hold: { ...record, until: NOW.toISOString() } };
    const snapshot = JSON.stringify(withLapsed);
    expect(liveHold(withLapsed, NOW)).toBeNull();
    // The record is the state's: the reading answers, and edits and deletes nothing.
    expect(JSON.stringify(withLapsed)).toBe(snapshot);
  });

  test('the line reads with and without an end, in one shape for every reader', () => {
    expect(holdText({ reason: 'deploys', by: 'owner', at: NOW.toISOString() })).toBe('hold: deploys');
    expect(holdText({ reason: 'deploys', by: 'owner', at: NOW.toISOString(), until: '2026-10-05T00:00:00.000Z' })).toBe(
      'hold until 2026-10-05T00:00:00.000Z: deploys',
    );
  });

  test('a hand-edited record is dropped at the read door, and a well-formed one is kept', () => {
    const where = place();
    const at = join(where.root, '.agents', 'team.state.json');
    const write = (value: unknown) => writeFileSync(at, `${JSON.stringify({ format: 1, sessions: {}, hold: value }, null, 2)}\n`);
    write({ reason: '', by: 'owner', at: NOW.toISOString() });
    expect(readState(join(where.root, '.agents')).hold).toBeUndefined();
    write({ reason: 'x', by: 'owner', at: 'not a date' });
    expect(readState(join(where.root, '.agents')).hold).toBeUndefined();
    write({ reason: 'x', by: 'owner', at: NOW.toISOString(), until: 'whenever' });
    expect(readState(join(where.root, '.agents')).hold).toBeUndefined();
    write({ reason: 'x', by: 42, at: NOW.toISOString() });
    expect(readState(join(where.root, '.agents')).hold).toBeUndefined();
    write({ reason: 'kept', by: 'owner', at: NOW.toISOString() });
    expect(readState(join(where.root, '.agents')).hold?.reason).toBe('kept');
  });
});

describe('team hold', () => {
  test('the owner places one, and the line names the reason with the caller and instant stored', async () => {
    const where = place();
    const { code, out, err } = await hold(['freeze deploys'], where);
    expect(code).toBe(0);
    expect(out).toBe('hold: freeze deploys\n');
    expect(err).toBe('');
    expect(stored(where)).toEqual({ reason: 'freeze deploys', by: 'owner', at: NOW.toISOString() });
  });

  test('a second hold under a live one is refused, naming the first, and the first is untouched', async () => {
    const where = place();
    expect((await hold(['freeze deploys'], where)).code).toBe(0);
    const before = stored(where);
    const { code, err } = await hold(['something else'], where);
    expect(code).toBe(1);
    expect(err).toBe('team hold: already held: freeze deploys\n');
    expect(stored(where)).toEqual(before);
    // One that ends is named the way the reader prints it, end and all.
    expect((await hold(['--release'], where)).code).toBe(0);
    const until = '2026-10-04T12:00:00.000Z';
    expect((await hold(['freeze deploys', '--until', until], where)).code).toBe(0);
    const timed = await hold(['again'], where);
    expect(timed.code).toBe(1);
    expect(timed.err).toBe(`team hold: already held until ${until}: freeze deploys\n`);
    expect(stored(where)?.reason).toBe('freeze deploys');
  });

  test('--until takes a local clock, stored as the next time it comes', async () => {
    const where = place();
    // The clock one hour from now: derived from an instant, so the local reading is the test's
    // own whatever timezone it runs in, and the instant it names is exactly that one.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const { code, out } = await hold(['lunch', '--until', clockOf(later)], where);
    expect(code).toBe(0);
    expect(out).toBe(`hold until ${later.toISOString()}: lunch\n`);
    expect(stored(where)?.until).toBe(later.toISOString());
  });

  test('a clock that has passed today is tomorrow, and the clock now is tomorrow too', async () => {
    const where = place();
    // The clock an hour ago: today's occurrence is behind `now`, so the one meant is tomorrow's.
    const earlier = new Date(NOW.getTime() - 60 * 60 * 1000);
    const tomorrow = new Date(earlier);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect((await hold(['a', '--until', clockOf(earlier)], where)).code).toBe(0);
    expect(stored(where)?.until).toBe(tomorrow.toISOString());
    expect(new Date(stored(where)?.until ?? 0).getTime()).toBeGreaterThan(NOW.getTime());
    // The clock `now` reads is not ahead of `now` either: it comes tomorrow, at that clock.
    expect((await hold(['--release'], where)).code).toBe(0);
    const here = new Date(NOW);
    here.setDate(here.getDate() + 1);
    expect((await hold(['b', '--until', clockOf(NOW)], where)).code).toBe(0);
    expect(stored(where)?.until).toBe(here.toISOString());
    expect(here.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('--until takes an ISO instant with Z or an offset, and stores the instant', async () => {
    const where = place();
    expect((await hold(['a', '--until', '2026-10-05T12:00:00Z'], where)).code).toBe(0);
    expect(stored(where)?.until).toBe('2026-10-05T12:00:00.000Z');
    expect((await hold(['--release'], where)).code).toBe(0);
    // The same instant written with an offset is the same instant, stored as one.
    expect((await hold(['b', '--until', '2026-10-05T14:00:00+02:00'], where)).code).toBe(0);
    expect(stored(where)?.until).toBe('2026-10-05T12:00:00.000Z');
    expect((await hold(['--release'], where)).code).toBe(0);
    expect((await hold(['c', '--until', '2026-10-05T09:30:00.500Z'], where)).code).toBe(0);
    expect(stored(where)?.until).toBe('2026-10-05T09:30:00.500Z');
  });

  test('--until is those two shapes and nothing else, and nothing is written when it is neither', async () => {
    const where = place();
    for (const bad of ['tomorrow', '2026-10-05', '25:00', '12:5', 'noon', '2026-10-05T12:00']) {
      const { code, err } = await hold(['freeze', '--until', bad], where);
      expect(code).toBe(1);
      expect(err).toBe('team hold: --until is a local <HH:MM>, or an ISO 8601 instant with Z or an offset, and nothing else\n');
      expect(stored(where)).toBeUndefined();
    }
  });

  test('a hold past its until is no hold, so a new one replaces it without a release', async () => {
    const where = place();
    const soon = new Date(NOW.getTime() + 5 * 60 * 1000);
    expect((await hold(['first', '--until', soon.toISOString()], where)).code).toBe(0);
    // Inside the window the record stands.
    const inside = new Date(NOW.getTime() + 60 * 1000);
    expect((await hold(['second'], where, OWNER, inside)).code).toBe(1);
    // Past it, the same call places the new one: the lapsed record is replaced, not refused.
    const after = new Date(NOW.getTime() + 6 * 60 * 1000);
    const { code, out } = await hold(['second'], where, OWNER, after);
    expect(code).toBe(0);
    expect(out).toBe('hold: second\n');
    expect(stored(where)).toEqual({ reason: 'second', by: 'owner', at: after.toISOString() });
  });

  test('--release clears it, and a release with no hold is refused', async () => {
    const where = place();
    expect((await hold(['freeze deploys'], where)).code).toBe(0);
    const { code, out, err } = await hold(['--release'], where);
    expect(code).toBe(0);
    expect(out).toBe('hold: released\n');
    expect(err).toBe('');
    expect(stored(where)).toBeUndefined();
    const again = await hold(['--release'], where);
    expect(again.code).toBe(1);
    expect(again.err).toBe('team hold: not held\n');
  });

  test('a refused call leaves the state file byte for byte as it was', async () => {
    const where = place();
    expect((await hold(['freeze deploys'], where)).code).toBe(0);
    const before = stateText(where);
    expect((await hold(['other'], where)).code).toBe(1);
    expect((await hold(['other'], where, ORCHESTRATOR)).code).toBe(1);
    expect((await hold(['--release'], where, ORCHESTRATOR)).code).toBe(1);
    expect(stateText(where)).toBe(before);
  });

  test('a hand-edited hold is dropped through the command too: the file it rewrites carries none', async () => {
    const where = place();
    writeFileSync(
      join(where.root, '.agents', 'team.state.json'),
      `${JSON.stringify({ format: 1, sessions: {}, hold: { reason: 42 } }, null, 2)}\n`,
    );
    const { code, err } = await hold(['--release'], where);
    expect(code).toBe(1);
    expect(err).toBe('team hold: not held\n');
    expect(readFileSync(join(where.root, '.agents', 'team.state.json'), 'utf8')).not.toContain('"hold"');
  });

  test('no reason, a second reason or a stray flag is an invocation: exit 2 with the usage', async () => {
    const where = place();
    for (const argv of [[], ['--until', '10:00'], ['a', 'b'], ['--release', 'a'], ['--release', '--until', '10:00']]) {
      const { code, err } = await hold(argv, where);
      expect(code).toBe(2);
      expect(err).toContain('Usage: team hold <reason> [--until <time>]');
      expect(stored(where)).toBeUndefined();
    }
    const blank = await hold(['   '], where);
    expect(blank.code).toBe(2);
    expect(blank.err).toContain('team hold: a <reason> is required\n');
  });

  test('a seat outside the file\'s two leads is refused, by the caller it is', async () => {
    const where = place();
    const bystander: Caller = { kind: 'seat', name: 'builder', pane: 'w2:p1', session: 'acme' };
    const { code, err } = await hold(['freeze deploys'], where, bystander);
    expect(code).toBe(1);
    expect(err).toBe('team hold: only the owner, the orchestrator or the operator holds the team; this call is builder\n');
    expect(stored(where)).toBeUndefined();
  });

  test('the orchestrator\'s seat holds and releases when the state records its pane', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const placed = await hold(['freeze deploys'], where, ORCHESTRATOR);
    expect(placed.code).toBe(0);
    expect(placed.out).toBe('hold: freeze deploys\n');
    expect(stored(where)).toEqual({ reason: 'freeze deploys', by: 'lead', at: NOW.toISOString() });
    expect((await hold(['--release'], where, ORCHESTRATOR)).code).toBe(0);
    expect(stored(where)).toBeUndefined();
  });

  test('a seat with no recorded pane is refused by the repair that records one', async () => {
    const where = place();
    const { code, err } = await hold(['freeze deploys'], where, ORCHESTRATOR);
    expect(code).toBe(1);
    expect(err).toBe(
      'team hold: no pane is recorded for seat lead in this session: a lead stops that seat and runs `team up`\n',
    );
  });

  test('a seat on another pane is refused by the pane the state holds for it', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const moved: Caller = { kind: 'seat', name: 'lead', pane: 'w2:p2', session: 'acme' };
    const { code, err } = await hold(['freeze deploys'], where, moved);
    expect(code).toBe(1);
    expect(err).toBe(
      'team hold: the state records pane w1:p1 for seat lead in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`)\n',
    );
  });

  test('a call with no terminal is refused before any file is read', async () => {
    const where = place();
    const { code, err } = await hold(['freeze deploys'], where, { kind: 'owner-no-tty' });
    expect(code).toBe(1);
    expect(err).toBe(`team hold: ${HOLD_ROUTE}\n`);
    expect(stored(where)).toBeUndefined();
  });

  test('outside any project the refusal names only the project: hold takes no --file', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-hold-outside-')));
    files.push(base);
    const home = join(base, 'home');
    mkdirSync(home);
    const now = () => NOW;
    const io = testIo(base, OWNER);
    expect(await runHold(['freeze deploys'], io, { home, now })).toBe(2);
    expect(io.err).toBe('team hold: not inside a git repository: run team from a project\n');
    const json = testIo(base, OWNER);
    expect(await runHold(['freeze deploys', '--json'], json, { home, now })).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, { id: 'hold.file', messageContains: 'not inside a git repository: run team from a project' });
    expect(json.out).not.toContain('--file');
  });

  test('--json emits team.hold on placed and released and team.error on refusals', async () => {
    const where = place();
    const placed = await hold(['freeze deploys', '--until', '2026-10-04T12:00:00Z', '--json'], where);
    expect(placed.code).toBe(0);
    expect(placed.err).toBe('');
    const placedDoc = assertMatchesOutputSchema(placed.out, HOLD_OUTPUT_SCHEMA);
    expect(placedDoc).toEqual({
      schema: { name: 'team.hold', version: 1 },
      format: 1,
      dry_run: false,
      status: 'placed',
      action_summary: 'hold until 2026-10-04T12:00:00.000Z: freeze deploys',
      project: 'acme',
      session: 'acme',
      target: 'hold',
      value: 'freeze deploys',
      hold: {
        reason: 'freeze deploys',
        by: 'owner',
        at: NOW.toISOString(),
        until: '2026-10-04T12:00:00.000Z',
      },
    });

    const dup = await hold(['other', '--json'], where);
    expect(dup.code).toBe(1);
    expect(dup.err).toBe('');
    assertJsonErrorShape(dup.out, {
      id: 'hold.held',
      messageContains: 'already held until 2026-10-04T12:00:00.000Z: freeze deploys',
      repair: 'team hold --release',
    });

    const released = await hold(['--release', '--json'], where);
    expect(released.code).toBe(0);
    expect(released.err).toBe('');
    const releasedDoc = assertMatchesOutputSchema(released.out, HOLD_OUTPUT_SCHEMA);
    expect(releasedDoc).toEqual({
      schema: { name: 'team.hold', version: 1 },
      format: 1,
      dry_run: false,
      status: 'released',
      action_summary: 'hold: released',
      project: 'acme',
      session: 'acme',
      target: 'hold',
      value: null,
    });

    const notHeld = await hold(['--release', '--json'], where);
    expect(notHeld.code).toBe(1);
    expect(notHeld.err).toBe('');
    assertJsonErrorShape(notHeld.out, {
      id: 'hold.not-held',
      messageContains: 'not held',
      repair: null,
    });

    const badArg = await hold(['--nope', '--json'], where);
    expect(badArg.code).toBe(2);
    expect(badArg.err).toBe('');
    assertJsonErrorShape(badArg.out, {
      id: 'hold.invocation',
      messageContains: 'unknown option --nope',
      repair: null,
    });
  });

  test('--json caller refusal branches: non-lead seat (owner-or-leads), unplaced pane (unplaced), and detached (unplaced)', async () => {
    const where = place();
    const bystander: Caller = { kind: 'seat', name: 'builder', pane: 'w2:p1', session: 'acme' };
    const wrongCaller = await hold(['freeze deploys', '--json'], where, bystander);
    expect(wrongCaller.code).toBe(1);
    expect(wrongCaller.err).toBe('');
    const wrongCallerDoc = assertJsonErrorShape(wrongCaller.out, {
      id: 'hold.caller',
      messageContains: 'only the owner, the orchestrator or the operator holds the team; this call is builder',
      repair: null,
    });
    expect(wrongCallerDoc.error).toMatchObject({ rule: 'owner-or-leads' });

    const noPane = await hold(['freeze deploys', '--json'], where, ORCHESTRATOR);
    expect(noPane.code).toBe(1);
    expect(noPane.err).toBe('');
    const noPaneDoc = assertJsonErrorShape(noPane.out, {
      id: 'hold.caller',
      messageContains: 'no pane is recorded for seat lead in this session',
      repair: 'team up',
    });
    expect(noPaneDoc.error).toMatchObject({ rule: 'unplaced' });

    recordPane(where, 'lead', 'w1:p1');
    const moved: Caller = { kind: 'seat', name: 'lead', pane: 'w2:p2', session: 'acme' };
    const anotherPane = await hold(['freeze deploys', '--json'], where, moved);
    expect(anotherPane.code).toBe(1);
    expect(anotherPane.err).toBe('');
    const anotherPaneDoc = assertJsonErrorShape(anotherPane.out, {
      id: 'hold.caller',
      messageContains: 'the state records pane w1:p1 for seat lead in this session',
      repair: 'team down && team up',
    });
    expect(anotherPaneDoc.error).toMatchObject({ rule: 'unplaced' });

    const detached = await hold(['freeze deploys', '--json'], where, { kind: 'owner-no-tty' });
    expect(detached.code).toBe(1);
    expect(detached.err).toBe('');
    const detachedDoc = assertJsonErrorShape(detached.out, {
      id: 'hold.detached',
      messageContains: HOLD_ROUTE,
      repair: null,
    });
    expect(detachedDoc.error).toMatchObject({ rule: 'unplaced' });
  });

  test('--json carries notice on both team.hold and team.error when team config is invalid and falls back to the stored copy', async () => {
    const where = place();
    expect((await hold(['freeze deploys'], where)).code).toBe(0);
    writeFileSync(where.file, 'format: 2\n');

    const released = await hold(['--release', '--json'], where);
    expect(released.code).toBe(0);
    expect(released.err).toBe('');
    const releasedDoc = assertMatchesOutputSchema(released.out, HOLD_OUTPUT_SCHEMA);
    expect(typeof releasedDoc.notice).toBe('string');
    expect(String(releasedDoc.notice)).toContain('team config is invalid');
    expect(String(releasedDoc.notice)).toContain('using the copy of');

    const notHeld = await hold(['--release', '--json'], where);
    expect(notHeld.code).toBe(1);
    expect(notHeld.err).toBe('');
    const notHeldDoc = assertJsonErrorShape(notHeld.out, {
      id: 'hold.not-held',
      messageContains: 'not held',
      repair: null,
    });
    expect(typeof notHeldDoc.notice).toBe('string');
    expect(String(notHeldDoc.notice)).toContain('team config is invalid');
    expect(String(notHeldDoc.notice)).toContain('using the copy of');

    const placed = await hold(['freeze deploys', '--json'], where);
    expect(placed.code).toBe(0);
    expect(placed.err).toBe('');
    const placedDoc = assertMatchesOutputSchema(placed.out, HOLD_OUTPUT_SCHEMA);
    expect(typeof placedDoc.notice).toBe('string');
    expect(String(placedDoc.notice)).toContain('team config is invalid');
    expect(String(placedDoc.notice)).toContain('using the copy of');

    const alreadyHeld = await hold(['second', '--json'], where);
    expect(alreadyHeld.code).toBe(1);
    expect(alreadyHeld.err).toBe('');
    const alreadyHeldDoc = assertJsonErrorShape(alreadyHeld.out, {
      id: 'hold.held',
      messageContains: 'already held: freeze deploys',
      repair: 'team hold --release',
    });
    expect(typeof alreadyHeldDoc.notice).toBe('string');
    expect(String(alreadyHeldDoc.notice)).toContain('team config is invalid');
    expect(String(alreadyHeldDoc.notice)).toContain('using the copy of');

    const bystander: Caller = { kind: 'seat', name: 'builder', pane: 'w2:p1', session: 'acme' };
    const refusedCaller = await hold(['--release', '--json'], where, bystander);
    expect(refusedCaller.code).toBe(1);
    expect(refusedCaller.err).toBe('');
    const refusedCallerDoc = assertJsonErrorShape(refusedCaller.out, {
      id: 'hold.caller',
      messageContains: 'only the owner, the orchestrator or the operator holds the team; this call is builder',
      repair: null,
    });
    expect(typeof refusedCallerDoc.notice).toBe('string');
    expect(String(refusedCallerDoc.notice)).toContain('team config is invalid');
  });
});

describe('the doctor line', () => {
  function sources(where: { home: string }): DoctorSources {
    return {
      version: () => '2.1.288 (Claude Code)',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => NOW,
      home: where.home,
    };
  }

  test('one -- line before the summary, and nothing else moves', async () => {
    const where = place();
    const io = testIo(where.root, OWNER);
    const before = await (async () => {
      const code = await runDoctor(['--file', '.agents/team.yaml'], io, sources(where));
      return { code, out: io.out };
    })();
    expect((await hold(['freeze deploys'], where)).code).toBe(0);
    const held = testIo(where.root, OWNER);
    const code = await runDoctor(['--file', '.agents/team.yaml'], held, sources(where));
    expect(code).toBe(before.code);
    expect(held.out).toBe(
      before.out.replace(
        'team doctor: ',
        'note  hold: freeze deploys (`team hold --release` clears it)\nteam doctor: ',
      ),
    );
  });

  test('a lapsed hold says nothing, and neither does a state that holds none', async () => {
    const where = place();
    updateState(join(where.root, '.agents'), (state) => {
      state.hold = { reason: 'freeze deploys', by: 'owner', at: '2026-10-04T08:00:00.000Z', until: '2026-10-04T08:30:00.000Z' };
    });
    expect(holdFindings(join(where.root, '.agents'), sources(where))).toEqual([]);
    const io = testIo(where.root, OWNER);
    await runDoctor(['--file', '.agents/team.yaml'], io, sources(where));
    expect(io.out).not.toContain('freeze deploys');
  });
});

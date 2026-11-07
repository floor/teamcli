// The bus log near its retained-size cap: `team check` notes it once, in plain words, when the
// bytes the retained set holds reach four fifths of the cap — before a drop has to happen, so the
// team's lead sees the cap coming. A note, never a difference: the exit stays 0, and dropping
// still starts only when the retained bytes would exceed the cap itself. The size is a stat of
// the files `readEvents` walks, the live segment and the sealed slots inside the reader's bound,
// so a near-cap note never reads a segment's bytes.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EVENT_LOG_TOTAL_BYTES, eventLogPath, retainedLogBytes } from '../src/bus/log.ts';
import { eventLogSettingsFor } from '../src/bus/log-settings.ts';
import { busLogSizeNotes } from '../src/bus/notes.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, notesOtherThanSocket, testIo } from './helpers.ts';

const NOW = new Date('2026-11-04T09:00:00Z');

const TEAM = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: steward
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

const NEAR_CAP =
  "bus: the bus log holds 80 MB of its 100 MB retained-size cap; the team's lead: shorten bus.retain_days, or accept the oldest sealed segments dropping (each drop is declared in the log)";

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

type World = { root: string; home: string };

/** One clean world: the file in a git checkout, the seat recorded ready on its pane, a watch
 *  pass recent enough that the run itself is no difference. */
function place(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-bus-log-cap-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEAM);
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats['steward'] = { stage: 'ready', pane: 'pane1', workspace: 'space1' };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return { root, home };
}

function live(): Live {
  const parsed = validateTeamFile(TEAM);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat) => ({
      name: seat.name,
      agent: 'claude',
      pane: 'pane1',
      workspace: 'space1',
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map(() => ({ id: 'space1', label: workspaceLabel(parsed.team.seats[0]!) })),
    screens: { pane1: CLAUDE_IDLE },
  };
}

function check(world: World, json = false): { code: number; out: string; stdout: string } {
  const io = testIo(world.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', ...(json ? { json: true } : {}) }, io, {
    home: world.home,
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(world.root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}`, stdout: io.out };
}

/** One retained set file of `bytes`, held sparse: the size is real, the bytes are not written. */
function held(world: World, slot: number, bytes: number): string {
  const path = slot === 0 ? eventLogPath('acme', world.root, world.home) : `${eventLogPath('acme', world.root, world.home)}.${String(slot)}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, bytes);
  return path;
}

describe('the near-cap words', () => {
  test('at four fifths of the cap: what it holds, the repair, and whose repair it is', () => {
    expect(busLogSizeNotes({ bytes: 80_000_000, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([NEAR_CAP]);
  });

  test('one byte below the share says nothing', () => {
    expect(busLogSizeNotes({ bytes: 79_999_999, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([]);
  });

  test('the megabytes are whole, floored, and read from the cap given', () => {
    expect(busLogSizeNotes({ bytes: 81_999_999, cap: EVENT_LOG_TOTAL_BYTES })[0]).toContain('holds 81 MB of its 100 MB');
    expect(busLogSizeNotes({ bytes: 80_000_001, cap: EVENT_LOG_TOTAL_BYTES })[0]).toContain('holds 80 MB');
    expect(busLogSizeNotes({ bytes: 40_000_000, cap: 50_000_000 })[0]).toContain('holds 40 MB of its 50 MB');
    expect(busLogSizeNotes({ bytes: 39_999_999, cap: 50_000_000 })).toEqual([]);
  });

  test('nothing retained says nothing', () => {
    expect(busLogSizeNotes({ bytes: 0, cap: EVENT_LOG_TOTAL_BYTES })).toEqual([]);
  });
});

describe('the bytes a retained set holds', () => {
  test('the live segment and the sealed slots inside the bound, a stat each', () => {
    const world = place();
    held(world, 0, 10_000_000);
    held(world, 1, 5_000_000);
    held(world, 2, 7_000_000);
    // A configured team's default bound: the live segment and the twelve sealed slots a 100 MB
    // cap holds at the 8 MB default segment size.
    expect(retainedLogBytes('acme', world.root, world.home)).toBe(22_000_000);
    expect(retainedLogBytes('acme', world.root, world.home, { kept: 2 })).toBe(15_000_000);
  });
});

describe('team check near the cap', () => {
  test('a clean world below the share draws no cap note and no difference', () => {
    const world = place();
    const clean = check(world);
    expect(clean.out).not.toContain('retained-size cap');
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('no differences');
  });

  test('the live segment alone at four fifths draws one note, and the exit stays 0', () => {
    const world = place();
    const before = check(world);
    held(world, 0, 80_000_000);
    const after = check(world);
    expect(after.out).toContain(`note: ${NEAR_CAP}`);
    // Exactly one more note than the same world draws without the size.
    expect(notesOtherThanSocket(after.out).length).toBe(notesOtherThanSocket(before.out).length + 1);
    // A note is not a difference: the file works as it stands, and the exit stays 0.
    expect(after.out).not.toContain('difference:');
    expect(after.out).toContain('no differences');
    expect(after.code).toBe(0);
  });

  test('the sealed slots count with the live segment toward the share', () => {
    const world = place();
    held(world, 0, 40_000_000);
    held(world, 1, 40_000_000);
    const ran = check(world);
    expect(ran.out).toContain(`note: ${NEAR_CAP}`);
    expect(ran.code).toBe(0);
  });

  test("a slot outside the reader's bound is neither read nor counted", () => {
    const world = place();
    // The bound is the slot count the team's segment size allows. The next index is the first
    // one the reader does not look at.
    const outside = eventLogSettingsFor(world.root, world.home).kept;
    held(world, 0, 40_000_000);
    held(world, outside, 40_000_000);
    expect(retainedLogBytes('acme', world.root, world.home)).toBe(40_000_000);
    const ran = check(world);
    expect(ran.out).not.toContain('retained-size cap');
    expect(ran.code).toBe(0);
  });

  test('the note carries in the --json report and adds no difference', () => {
    const world = place();
    held(world, 0, 80_000_000);
    const { code, stdout } = check(world, true);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(NEAR_CAP);
    expect(doc.differences).toEqual([]);
  });
});

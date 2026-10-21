// The state's records and the team file's seats drift apart: a seat the file no longer declares
// keeps its record — and the pane that record names — until something drops it. The file is the
// truth. `team register` records the seat that stands on a pane a departed record still claims;
// `team check` names the departed records and the sessions with no seat of the team in them, and
// the owner's `--repair` drops them in one logged write. Fake herdr, a temporary home and a pinned
// caller: no live session is read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { currentBriefClaim } from '../src/launch/general-brief.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T10:00:00Z');
const OWNER = { kind: 'owner' as const };
const LEAD = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
const PANE = 'w1:p1';

const made: string[] = [];
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; dir: string };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'state-departed-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
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
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  return { base, home, root, dir: join(root, '.agents') };
}

/**
 * The state the reported team kept: two records for seats the file no longer declares — one on
 * the lead's own pane, one on a pane of its own — beside two session records with no seat of the
 * team in them. Nothing here is a temporary seat: the file never lists one, and its record is its
 * own.
 */
function seed(w: World): void {
  updateState(w.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.helper = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
    session.seats.runner = { stage: 'ready', pane: 'w2:p1', workspace: 'w2' };
    state.sessions['gone-one'] = { seats: {}, worktrees: {} };
    state.sessions['gone-two'] = { seats: {}, worktrees: {} };
  });
  // The launch delivered the general brief before it typed: the file's lead seat's record and entry.
  deliverBriefs({ dir: w.dir, root: w.root, session: 'acme', seats: ['lead'], home: w.home, at: NOW.toISOString() });
}

/** The agent herdr reports for the lead: its own pane, running a program in front of its shell. */
function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null, session: 'claude-session-1' };
}

function registerSources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    renameAgent: () => true,
    now: () => NOW,
    ...over,
  };
}

async function register(w: World, argv: string[], over: Partial<RegisterSources> = {}): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, OWNER);
  const code = await runRegister(argv, io, registerSources(w, over));
  // A registration attributes the seat, so it delivers the brief under a fresh claim lifetime —
  // the launch's earlier claim and its receipt are superseded. The seat's next turn reads what
  // the registration wrote, the way the run's own claim-bound reader does.
  if (code === 0) readBrief(w);
  return { code, out: io.out, err: io.err };
}

/**
 * The seat's first turn after its registration reads the brief. The receipt is the run's signed,
 * claim-bound one: the current claim is resolved again before the write, so the receipt answers
 * for the id the check will read and never for a superseded launch claim.
 */
function readBrief(w: World, seat = 'lead'): void {
  const claimOf = () => currentBriefClaim(readState(w.dir).sessions.acme?.briefs?.[seat]);
  const claim = claimOf();
  if (claim === null) throw new Error(`the fixture has no current brief claim for ${seat}`);
  const read = readMessage(
    {
      dropDir: join(w.root, '.agents', 'send-drops', 'acme', seat),
      root: w.root,
      seat,
      session: 'acme',
    },
    claim.id,
    w.home,
    { claim: claimOf },
  );
  if (!read.ok) throw new Error(`the fixture's brief was not read: ${read.reason}`);
}

/** The live session the check reads: the lead on its recorded pane, quiet at its prompt. */
function live(): Live {
  return {
    running: true,
    agents: [agent('lead')],
    workspaces: [{ id: 'w1', label: 'lead' }],
    screens: { [PANE]: CLAUDE_IDLE },
  };
}

/** The check's own reads: herdr's one live session, and nothing else. */
function checkSources(w: World, over: Partial<CheckSources> = {}): CheckSources {
  return {
    live: () => live(),
    branch: () => 'main',
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home: w.home,
    ...over,
  };
}

function check(
  w: World,
  args: { repair?: boolean; file?: boolean; session?: string } = {},
  caller: typeof OWNER | typeof LEAD = OWNER,
  over: Partial<CheckSources> = {},
): { code: number; out: string; err: string } {
  const io = testIo(w.root, caller);
  const code = runTeamCheck(
    {
      // A seat aims no flags: its check finds the team file from where it stands.
      ...(args.file === false ? {} : { file: '.agents/team.yaml' }),
      ...(args.repair ? { repair: true } : {}),
      ...(args.session !== undefined ? { session: args.session } : {}),
    },
    io,
    checkSources(w, over),
  );
  return { code, out: io.out, err: io.err };
}

/** The state's seat records for the addressed session, by name. */
function seats(w: World): string[] {
  return Object.keys(readState(w.dir).sessions.acme?.seats ?? {}).sort();
}

describe('a state seat the file no longer declares', () => {
  test('register records the seat standing on the pane its record still claims', async () => {
    const w = world();
    seed(w);

    const r = await register(w, ['lead', '--pane', PANE]);

    // Before the file was the truth here, the departed record refused this run: the pane was
    // "helper's", though the file declares no such seat and herdr names the lead on it.
    expect(r.code).toBe(0);
    expect(r.out).toContain('lead: registered — pane w1:p1');
    expect(readState(w.dir).sessions.acme?.seats.lead?.pane).toBe(PANE);
    // The departed records are not this command's to drop: only the check's repair drops one.
    expect(seats(w)).toEqual(['helper', 'lead', 'runner']);
    expect(findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' })?.reach.pane).toBe(PANE);
  });

  test('check names both departed seats and both stale sessions, and changes nothing', async () => {
    const w = world();
    seed(w);
    await register(w, ['lead', '--pane', PANE]);

    const r = check(w);

    expect(r.code).toBe(1);
    expect(r.out).toContain('difference: helper: left the team file but its record still claims pane w1:p1');
    expect(r.out).toContain('difference: runner: left the team file but its record still claims pane w2:p1');
    expect(r.out).toContain('difference: the state records the session "gone-one", and no seat of the team is in it');
    expect(r.out).toContain('difference: the state records the session "gone-two", and no seat of the team is in it');
    expect(r.out).toContain('repair: drop its record from the state (team check --repair)');
    expect(r.out).toContain('4 differences, 4 for the owner');
    // A plain check is a read: every record stands where it was.
    expect(seats(w)).toEqual(['helper', 'lead', 'runner']);
    expect(Object.keys(readState(w.dir).sessions).sort()).toEqual(['acme', 'gone-one', 'gone-two']);
  });

  test('the repair is the owner\'s: a seat\'s --repair is refused and drops nothing', async () => {
    const w = world();
    seed(w);
    await register(w, ['lead', '--pane', PANE]);

    const r = check(w, { repair: true, file: false }, LEAD);

    expect(r.code).toBe(1);
    expect(r.err).toBe("team check: --repair is the owner's\n");
    expect(r.out).toBe('');
    expect(seats(w)).toEqual(['helper', 'lead', 'runner']);
    expect(Object.keys(readState(w.dir).sessions).sort()).toEqual(['acme', 'gone-one', 'gone-two']);
    // Nothing was dropped, so nothing was logged as dropped — the register's own line is all
    // the log holds.
    expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).not.toContain('repaired:');
  });

  test('the owner\'s --repair drops them in one logged write, and the check after it is clean', async () => {
    const w = world();
    seed(w);
    await register(w, ['lead', '--pane', PANE]);

    const fixed = check(w, { repair: true });

    expect(fixed.code).toBe(0);
    expect(fixed.out).toContain('repaired: helper: left the team file and its record claimed pane w1:p1; its record is dropped');
    expect(fixed.out).toContain('repaired: runner: left the team file and its record claimed pane w2:p1; its record is dropped');
    expect(fixed.out).toContain('repaired: the state\'s session "gone-one" holds no seat of the team; its record is dropped');
    expect(fixed.out).toContain('repaired: the state\'s session "gone-two" holds no seat of the team; its record is dropped');
    expect(fixed.out).toContain('no differences');
    // The file's own seat is untouched, and the leftovers are gone from the state.
    expect(seats(w)).toEqual(['lead']);
    expect(Object.keys(readState(w.dir).sessions)).toEqual(['acme']);
    // The drop is accountable: every line it printed is in the project's log under the check.
    const log = readFileSync(join(w.dir, LOG_FILE), 'utf8');
    expect(log).toContain('check [owner] repaired: helper: left the team file and its record claimed pane w1:p1; its record is dropped');
    expect(log).toContain('check [owner] repaired: the state\'s session "gone-two" holds no seat of the team; its record is dropped');

    // The next plain check reads the state the file would have written.
    const after = check(w);
    expect(after.code).toBe(0);
    expect(after.out).toContain('no differences');
  });

  test('--repair keeps a session a seat of the team lives in, and drops one with none', async () => {
    const w = world();
    seed(w);
    await register(w, ['lead', '--pane', PANE]);

    // The state holds a second session the file does not name, with the file's own seat in it —
    // a launch that took `--session` — and one holding only a seat the file does not declare.
    updateState(w.dir, (state) => {
      state.sessions.moved = { seats: { lead: { stage: 'ready', pane: 'w3:p1', workspace: 'w3' } }, worktrees: {} };
      state.sessions.held = { seats: { helper: { stage: 'ready', pane: 'w4:p1', workspace: 'w4' } }, worktrees: {} };
    });

    const r = check(w, { repair: true });

    // The file decides: a session with a seat it still declares is the team's, and is left where
    // it is; a session with no such seat is a leftover. Herdr is not consulted either way.
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('session "moved"');
    expect(r.out).toContain('repaired: the state\'s session "held" holds no seat of the team; its record is dropped');
    expect(Object.keys(readState(w.dir).sessions).sort()).toEqual(['acme', 'moved']);
  });
});

describe('the session the run addresses', () => {
  test('--session aims the check at it, and --repair never calls it a leftover nor drops it', async () => {
    const w = world();
    seed(w);
    await register(w, ['lead', '--pane', PANE]);
    // The addressed session holds only a record the file no longer declares. Without the skip,
    // the sessions pass calls the session itself a leftover, and the repair drops the very record
    // the check is reading.
    updateState(w.dir, (state) => {
      state.sessions.alt = { seats: { helper: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' } }, worktrees: {} };
    });

    const r = check(w, { repair: true, session: 'alt' });

    expect(r.out).not.toContain('the state\'s session "alt"');
    expect(r.out).not.toContain('the state records the session "alt"');
    // The records inside the addressed session are still compared with the file: the departed
    // seat is dropped from it, and the session itself stands.
    expect(r.out).toContain('repaired: helper: left the team file and its record claimed pane w2:p1; its record is dropped');
    expect(readState(w.dir).sessions.alt).toEqual({ seats: {}, worktrees: {} });
  });
});

describe('herdr silent', () => {
  test('--repair waits for the live read: a check that refuses has dropped nothing', () => {
    const w = world();
    seed(w);

    const r = check(w, { repair: true }, OWNER, { live: () => null });

    expect(r.code).toBe(2);
    expect(r.err).toBe("team check: herdr doesn't answer; is it installed and running?\n");
    expect(r.out).toBe('');
    // The leftovers are still there, and nothing was logged as dropped.
    expect(seats(w)).toEqual(['helper', 'runner']);
    expect(Object.keys(readState(w.dir).sessions).sort()).toEqual(['acme', 'gone-one', 'gone-two']);
    expect(existsSync(join(w.dir, LOG_FILE))).toBe(false);
  });
});

// The stale-session guard on `team check`: the check names the state's leftover session records,
// and the owner's `--repair` drops them — but never the session the check itself is reading. That
// session is the file's own, or the one `--session` names; whichever it is, its record stands.
// A check that could not read herdr repairs nothing either: `--repair` writes only after the live
// read has answered, and the run says why it could not check.
//
// Every scene is a temporary home and root with herdr's read injected and the caller pinned. The
// names are synthetic and the panes neutral; nothing here reads a real session or home.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { loadConfig } from '../src/check/load.ts';
import type { CheckSources } from '../src/check/team.ts';
import { check } from '../src/commands/check.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { emptySession, readState, STATE_FILE, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T15:00:00Z');
const OWNER: Caller = { kind: 'owner' };
/** The file's own session. */
const SESSION = 'alpha';
/** The session `--session` names. */
const ALT = 'alt';
/** A session with no seat of the team in it, and neither of the two above. */
const STALE = 'third';
const PANE = 'w1:p1';

const made: string[] = [];
beforeEach(() => {
  // Herdr is never reached: every scene injects the live read it wants, and an unreadable one is
  // the `null` the check's own source answers when herdr cannot be read.
});
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string };

/** One machine: a checkout with its file and a temporary home carrying the machine lobby. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stale-guard-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'team.yaml'), teamText(home, root));
  return { base, root, home, dir };
}

/** The file: one declared lead seat, in the one session it names. */
function teamText(home: string, root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function fileOf(w: World): TeamFile {
  const loaded = validateTeamFile(readFileSync(join(w.dir, 'team.yaml'), 'utf8'));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

/**
 * Session records in the state: `lead` records the file's declared seat on its pane, as a launch
 * leaves it, with a watch line so the plain reading is quiet; `empty` records a session and no seat
 * at all — the shape a launch that never placed a seat leaves behind.
 */
function seed(w: World, sessions: Record<string, 'lead' | 'empty'>): void {
  updateState(w.dir, (state) => {
    for (const [name, kind] of Object.entries(sessions)) {
      const held = (state.sessions[name] ??= emptySession());
      if (kind === 'lead') {
        held.watch = { pid: 1, heartbeat: NOW.toISOString() };
        held.seats.lead = { stage: 'ready', pane: PANE, workspace: 'w1' };
      }
    }
  });
}

/** The live read of the file's own session: the declared lead, idle on its pane. */
function liveLead(w: World): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: workspaceLabel(fileOf(w).seats[0]!) }],
    screens: { [PANE]: CLAUDE_IDLE },
  };
}

/** The live read of a session holding no seat: herdr answers, and lists nothing. */
function liveNoSeats(): Live {
  return { running: true, agents: [], workspaces: [], screens: {} };
}

function checkSources(w: World, live: CheckSources['live']): CheckSources {
  return {
    live,
    branch: () => 'main',
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home: w.home,
  };
}

async function runCheck(
  w: World,
  argv: string[],
  live: CheckSources['live'],
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, OWNER);
  const code = await check(argv, io, loadConfig, checkSources(w, live));
  return { code, out: io.out, err: io.err };
}

/** The state file's bytes, which a run that writes nothing must leave exactly as they were. */
function stateBytes(w: World): string {
  return readFileSync(join(w.dir, STATE_FILE), 'utf8');
}

describe('the session the check is reading is never a leftover', () => {
  test('with --session alt, alt is neither named nor dropped, and a stale third session is', async () => {
    const w = world();
    seed(w, { [SESSION]: 'lead', [ALT]: 'empty', [STALE]: 'empty' });
    const altBefore = readState(w.dir).sessions[ALT];
    expect(altBefore).toBeDefined();

    const r = await runCheck(w, ['--session', ALT, '--repair'], liveNoSeats);

    // Neither a difference nor a repair line names the addressed session as a leftover.
    expect(r.out).not.toContain(`the state's session "${ALT}"`);
    expect(r.out).not.toContain(`the state records the session "${ALT}"`);
    expect(r.err).not.toContain(`session "${ALT}"`);
    // The truly stale one is named and dropped.
    expect(r.out).toContain(`repaired: the state's session "${STALE}" holds no seat of the team; its record is dropped`);
    const state = readState(w.dir);
    expect(Object.hasOwn(state.sessions, ALT)).toBe(true);
    expect(state.sessions[ALT]).toEqual(altBefore);
    expect(Object.hasOwn(state.sessions, STALE)).toBe(false);
    // The file's own session and its seat record are untouched.
    expect(Object.hasOwn(state.sessions, SESSION)).toBe(true);
    expect(state.sessions[SESSION]?.seats.lead).toEqual({ stage: 'ready', pane: PANE, workspace: 'w1' });
  });

  test('control: without --session, the file\'s own session stays and stale others are dropped', async () => {
    const w = world();
    seed(w, { [SESSION]: 'lead', [STALE]: 'empty' });

    const r = await runCheck(w, ['--repair'], () => liveLead(w));

    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain(`repaired: the state's session "${STALE}" holds no seat of the team; its record is dropped`);
    expect(r.out).not.toContain(`the state's session "${SESSION}"`);
    expect(r.out).toContain('0 difference(s)');
    const state = readState(w.dir);
    expect(Object.keys(state.sessions)).toEqual([SESSION]);
    expect(state.sessions[SESSION]?.seats.lead).toEqual({ stage: 'ready', pane: PANE, workspace: 'w1' });
  });
});

describe('a check that could not read herdr repairs nothing', () => {
  test('--repair leaves the state byte-identical and the run says why it could not check', async () => {
    const w = world();
    seed(w, { [SESSION]: 'lead', [STALE]: 'empty' });
    // A leftover seat beside the leftover session, so the repair has both kinds to leave alone.
    updateState(w.dir, (state) => {
      state.sessions[SESSION]!.seats.clerk = { stage: 'ready', pane: 'w2:p1', workspace: 'w2' };
    });
    const before = stateBytes(w);

    const r = await runCheck(w, ['--repair'], () => null);

    expect(r.code).toBe(2);
    expect(r.err).toContain("team check: herdr doesn't answer; is it installed and running?");
    expect(r.out).not.toContain('repaired:');
    expect(stateBytes(w)).toBe(before);
  });
});

// The roster line a live seat needs. Where the registry holds a record of a team, its roster is
// the record of who the team's seats are for the permission bridge (`src/permissions/who.ts`): a
// seat the roster does not list has no record there, whatever the approved file declares, and
// every gate wired to the bridge refuses it what the file says it holds. `team check` names the
// gap for a seat the state holds ready and herdr runs, and the repair it names, `team register
// <seat>`, writes the line a launch would have written. A team the registry holds no record of is
// not this gap — the bridge reads the file's own declaration then — and a seat still launching is
// not one either: the line is written when the seat reaches ready.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents } from '../src/registry/agents.ts';
import { getTeam, setRoster, teamIdOf, teamsFile, upsertTeam, type RosterEntry } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const PANE = 'w1:p1';
const OWNER = { kind: 'owner' as const };

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
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const TITLE = workspaceLabel(loaded.team.seats[0]!);

const made: string[] = [];
beforeEach(() => {
  // No pane of this machine's is behind the register half's real reads; an unreadable herdr is
  // the reading that leaves them alone.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; home: string; dir: string };

/** One machine: the team's checkout with its file, a home with the lobby, nothing registered yet. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-roster-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  return { base, root, home, dir: join(root, '.agents') };
}

/** The state the launch leaves: the watch recorded and the seat ready on the pane it was given. */
function ready(w: World, stage: 'launched' | 'named' | 'ready' = 'ready', pane = PANE): void {
  updateState(w.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage, pane, workspace: 'w1' };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: w.dir, root: w.root, session: 'acme', seats: ['lead'], home: w.home, at: NOW.toISOString() });
}

/** The registry's record of this team, with the roster the argument names (none: empty). */
function record(w: World, roster?: RosterEntry[]): void {
  const id = teamIdOf(w.root);
  upsertTeam(w.home, id, { project: 'acme', session: 'acme', root: w.root, at: NOW.toISOString() });
  if (roster !== undefined) setRoster(w.home, id, roster);
}

/** Herdr's reading of the session: the seat running on its recorded pane, its lines the file's. */
function liveOn(pane = PANE): Live {
  return {
    running: true,
    agents: [{ name: 'lead', agent: 'claude', pane, workspace: 'w1', status: 'idle', cwd: null }],
    workspaces: [{ id: 'w1', label: TITLE }],
    screens: { [pane]: CLAUDE_IDLE },
  };
}

/** The scene's check. `home` null stands in for a check with no home at all, exactly as
 *  `test/check-two-projects.test.ts` reads it. */
function check(w: World, live: Live = liveOn(), home: string | null = w.home): { code: number; out: string } {
  const io = testIo(w.root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home ?? w.root),
    now: () => NOW,
    home: home ?? undefined,
  });
  return { code, out: `${io.out}${io.err}` };
}

/** The gap's own line, verbatim: what a scene expects to find, or to not find. */
const THE_GAP = "difference: lead: ready and running, and the team registry's roster does not list it";

describe('team check names a ready seat the roster does not list', () => {
  test('a roster that lists the seat is not a difference', () => {
    const w = world();
    ready(w);
    record(w, [{ agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true }]);
    const { code, out } = check(w);
    expect(out).not.toContain('roster does not list');
    expect(code).toBe(0);
  });

  test('an empty roster is the gap, with the repair that writes the line', () => {
    const w = world();
    ready(w);
    record(w);
    const { code, out } = check(w);
    expect(out).toContain(THE_GAP);
    expect(out).toContain('  repair: team register lead');
    expect(code).toBe(1);
  });

  test('a roster holding a line for another seat is the same gap', () => {
    const w = world();
    ready(w);
    record(w, [{ agent: 'agt_111111111111', seat: 'claude-desk', role: 'builder' }]);
    const { code, out } = check(w);
    expect(out).toContain(THE_GAP);
    expect(out).toContain('  repair: team register lead');
    expect(code).toBe(1);
  });

  test('a team the registry holds no record of is not the gap', () => {
    const w = world();
    ready(w);
    // The bridge reads the file's own declaration then, and the seat is served: nothing is owed.
    const { code, out } = check(w);
    expect(out).not.toContain('roster does not list');
    expect(code).toBe(0);
  });

  test('a seat still launching has no line yet, and is not the gap', () => {
    const w = world();
    ready(w, 'launched');
    record(w);
    const { out } = check(w);
    expect(out).not.toContain('roster does not list');
  });

  test('a seat that is not running is not the gap', () => {
    const w = world();
    ready(w);
    record(w);
    const { out } = check(w, { running: false, agents: [], workspaces: [], screens: {} });
    expect(out).not.toContain('roster does not list');
  });

  test('a pane the state does not record for the seat is not read', () => {
    const w = world();
    ready(w);
    record(w);
    // Herdr lists the name on another pane: a stale record, and `team register` would refuse it,
    // so it is not repaired from here.
    const { out } = check(w, liveOn('w9:p1'));
    expect(out).not.toContain('roster does not list');
  });

  test('a check with no home answers for no registry', () => {
    const w = world();
    ready(w);
    record(w);
    const { out } = check(w, liveOn(), null);
    expect(out).not.toContain('roster does not list');
  });
});

/** The register reads a test replaces, as `test/register.test.ts` injects them. */
function sources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent()],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    now: () => NOW,
    ...over,
  };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function agent(): HerdrAgent {
  return { name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: null, session: 'claude-session-1' };
}

async function register(w: World, argv: string[], over: Partial<RegisterSources> = {}) {
  const io = testIo(w.root, OWNER);
  const code = await runRegister(argv, io, sources(w, over));
  return { code, out: io.out, err: io.err };
}

describe('the repair the check names writes the roster line', () => {
  test('a ready seat the roster omits: the line is written, the pane is not entered', async () => {
    const w = world();
    ready(w);
    record(w);
    const ran = await register(w, ['lead']);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toContain("lead: already registered — pane w1:p1; the team registry's roster did not list it, and was written");
    // The line a launch would have written: the agent's id, the file's role, and the `leads`
    // mark re-resolved from the file.
    const id = teamIdOf(w.root);
    const found = findAgent(w.home, { team: id, seat: 'lead' });
    expect(found).not.toBeNull();
    expect(getTeam(w.home, id)?.roster).toEqual([
      { agent: found!.id, seat: 'lead', role: 'coordinator', leads: true },
    ]);
    expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain('lead: roster line written — pane w1:p1');
  });

  test('the line once written, a second run re-records the same content, the stamp the only move', async () => {
    const w = world();
    ready(w);
    record(w);
    await register(w, ['lead']);
    const id = teamIdOf(w.root);
    const sansStamp = (): Record<string, unknown> => {
      const { provenance: _stamp, ...rest } = getTeam(w.home, id)!;
      return rest;
    };
    const before = sansStamp();
    const second = await register(w, ['lead']);
    expect(second.code).toBe(0);
    // The merged path re-records from the file on every run: the second run says so, and what
    // stands is what stood — the roster line among it — with only the write's own provenance
    // stamp moving, as every launch's write moves it.
    expect(second.out).toContain('lead: already registered — pane w1:p1; the record was refreshed from the file, nothing relaunched');
    expect(sansStamp()).toEqual(before);
  });

  test('--dry-run says what would be written and writes no registry at all', async () => {
    const w = world();
    ready(w);
    record(w);
    const before = readFileSync(teamsFile(w.home), 'utf8');
    const ran = await register(w, ['lead', '--dry-run']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("lead: already registered — pane w1:p1; the team registry's roster would be written");
    expect(readAgents(w.home)).toEqual([]);
    expect(readFileSync(teamsFile(w.home), 'utf8')).toBe(before);
  });

  test('a team the registry holds no record of: the team and the agent record are written', async () => {
    const w = world();
    ready(w);
    const ran = await register(w, ['lead']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("lead: already registered — pane w1:p1; the team registry's roster did not list it, and was written");
    // A team started before the registry kept a record is repaired to the shape a launch
    // writes: the team, the seat's agent record and its roster line — so the bridge and
    // `team check` read the same team here as for any other.
    const id = teamIdOf(w.root);
    const found = findAgent(w.home, { team: id, seat: 'lead' });
    expect(found).not.toBeNull();
    expect(getTeam(w.home, id)?.roster).toEqual([
      { agent: found!.id, seat: 'lead', role: 'coordinator', leads: true },
    ]);
    expect(existsSync(teamsFile(w.home))).toBe(true);
  });
});

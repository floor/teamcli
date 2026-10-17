// The RC1 cut's release smoke failed on a phrase a granted up used to print, and no longer does:
// since 0.5.0 the permission map's own row admits the orchestrator's `up` (the owner, or a seat
// its team's record marks `leads`), so a lead seat's dry run needs no `grant:` in the file and no
// granted skip line. What the smoke stands on now is the product's own shape: the admitted dry
// run exits 0, prints a plan ending in "dry run: nothing was run", names no refusal, and makes
// nothing. This scene pins that shape from the lead seat's own pane, with no `grant:` section
// anywhere in the file, so a return to grant-gated admission shows up here as a refusal.
//
// The second scene is the other half of that check: a refused dry run prints the same tail line,
// so the release smoke cannot read the tail as the admission proof — it must also find no
// refusal, exactly as the fixed step does.
//
// The caller is pinned to the seat the state places on its pane: that placement is what the map
// proves, and nothing here walks a real process. Every read the run makes is injected or a
// temporary home's.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T05:20:00Z');
const PANE = 'lead-pane';
const SESSION = 'alpha';

let made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; lobby: string };

/** A checkout with a first commit, the team file, and a home with the machine lobby: the state
 *  records the lead seat ready on its pane, as the launch that started it leaves it. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rc1-smoke-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const lobby = lobbyDir(home);
  mkdirSync(dir, { recursive: true });
  // The lobby is the machine's own folder: only its owner reads it (0700, as the gate requires).
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'team.yaml'), teamText(home, root));
  updateState(dir, (state) => {
    state.sessions[SESSION] = emptySession();
    state.sessions[SESSION]!.seats.lead = { stage: 'ready', pane: PANE, workspace: 'w1' };
  });
  return { base, root, dir, home, lobby };
}

/** The smallest file whose lead is admitted by the map: a declared lead seat, an absolute trust
 *  list, and no `grant:` section. The coordinator is also the operator, as a team of one lead. */
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
    leads: true
`;
}

function fileOf(text: string): TeamFile {
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return loaded.team;
}

function doctor(w: World): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: w.home,
  };
}

type Trace = { workspaces: number; closed: number; starts: number; typed: number; renamed: number };

/** A launch that records every effect, so a dry run that reached herdr would show it. None of it
 *  may be called: a dry run reads the machine and prints a plan. */
function sources(w: World, team: TeamFile): { sources: UpSources; trace: Trace } {
  const trace: Trace = { workspaces: 0, closed: 0, starts: 0, typed: 0, renamed: 0 };
  const agents: HerdrAgent[] = [
    { name: 'lead', agent: 'claude', pane: PANE, workspace: 'w1', status: 'idle', cwd: w.root },
  ];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer() {
      trace.starts += 1;
      return true;
    },
    sessionUp: () => true,
    createWorkspace() {
      trace.workspaces += 1;
      return null;
    },
    paneRun() {
      trace.starts += 1;
      return true;
    },
    renameAgent() {
      trace.renamed += 1;
      return true;
    },
    closeWorkspace() {
      trace.closed += 1;
      return true;
    },
    agentPanes: () => [PANE],
    agents: () => agents,
    paneText: () => CLAUDE_IDLE,
    foreground: () => ['claude'],
    typeText() {
      trace.typed += 1;
      return true;
    },
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    trace,
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents,
      workspaces: () => [{ id: 'w1', label: workspaceLabel(team.seats[0]!) }],
      home: w.home,
      doctor: doctor(w),
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
  };
}

describe("a lead seat's up dry run is admitted by the map, with no grant in the file", () => {
  test('it exits 0 with the plan and its tail, names no refusal, and makes nothing', async () => {
    const w = world();
    const team = fileOf(readFileSync(join(w.dir, 'team.yaml'), 'utf8'));
    // The file this scene runs on holds no `grant:` and no `delegates:`: the admission below is
    // the map's own row for a lead of its own team, not an agreement's.
    expect(team.grant).toBeNull();
    const { sources: reads, trace } = sources(w, team);
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: PANE, session: SESSION });

    const code = await runUp(['--dry-run'], io, reads);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    // The plan, and the tail line the release smoke stands on.
    expect(io.out).toContain('dry run: nothing was run');
    expect(io.out).toContain('lead');
    // No refusal of any shape: the dry run's own marked line, the real run's bare deny, or a
    // refusal word in the plan's text.
    expect(io.out).not.toContain('! up would refuse:');
    expect(io.out).not.toContain('! to unblock:');
    expect(io.out).not.toMatch(/^deny$/m);
    expect(io.out).not.toContain('refused');
    // The phrase the old smoke keyed on is a granted seat's skip line, and this run has no
    // granted seat: the phrase is not part of the admitted shape.
    expect(io.out).not.toContain('a granted up');
    // Nothing was made, started, closed or typed into.
    expect(trace).toEqual({ workspaces: 0, closed: 0, starts: 0, typed: 0, renamed: 0 });
    expect(readState(w.dir).sessions[SESSION]?.seats.lead?.pane).toBe(PANE);
  });

  test('a refused dry run prints the same tail, so the tail line alone is not the admission check', async () => {
    const w = world();
    const team = fileOf(readFileSync(join(w.dir, 'team.yaml'), 'utf8'));
    const { sources: reads } = sources(w, team);
    // A seat the file does not declare, so the map records no lead for it: the run is refused.
    const io = testIo(w.root, { kind: 'seat', name: 'helper', pane: 'helper-pane', session: SESSION });

    const code = await runUp(['--dry-run'], io, reads);

    // The plan and its tail are printed for a refused run too — the release smoke cannot read
    // the tail line as the admission proof; it must also find no refusal.
    expect(code).toBe(1);
    expect(io.out).toContain('! up would refuse:');
    expect(io.out).toContain('dry run: nothing was run');
  });
});

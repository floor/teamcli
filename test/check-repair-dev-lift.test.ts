// The owner's dev-mode admission across teams: the main orchestrator, placed in the main team's
// session on the pane that team's state records, runs a project team's `check --repair` under
// dev mode. The target file does not name it, so the proof is its own team: the registry holds
// the main team above the target, the main team's approved file names the same entity and makes
// the caller its orchestrator, and its state records the pane the caller stands on. Every other
// foreign lead — a sibling team's — is refused, as is the right name on the wrong pane, a caller
// no session places, and dev mode off. The scene is synthetic throughout: a main folder that
// holds a project checkout, a registry under a temporary home, and fake herdr sources.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources, Process } from '../src/caller.ts';
import { runTeamCheck, type CheckSources } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Standing } from '../src/store/store.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const MAIN_SESSION = 'main';
const TARGET_SESSION = 'material';
const OTHER_SESSION = 'other';

const MAIN_TEXT = `format: 1
project: floor
entity: floor
session: main
coordinator: atlas
operator: atlas
trust:
  - ~/.config/team/lobbies/floor
  - __ROOT__
workspace:
  mode: shared
seats:
  - role: coordinator
    name: atlas
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

const TARGET_TEXT = `format: 1
project: material
entity: floor
session: material
coordinator: mill
operator: mill
trust:
  - ~/.config/team/lobbies/floor
  - __ROOT__
workspace:
  mode: shared
seats:
  - role: coordinator
    name: mill
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
delegates:
  - pane: main/w1:p1
    commands: [up]
`;

const OTHER_TEXT = `format: 1
project: other
entity: floor
session: other
coordinator: other-lead
operator: other-lead
trust:
  - ~/.config/team/lobbies/floor
  - __ROOT__
workspace:
  mode: shared
seats:
  - role: coordinator
    name: other-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

const target = validateTeamFile(TARGET_TEXT.replace('__ROOT__', '/synthetic/material'));
if (!target.ok) throw new Error(JSON.stringify(target.errors));
const TARGET_TEAM = target.team;
const TARGET_SEATS = TARGET_TEAM.seats;
const TITLES = Object.fromEntries(TARGET_SEATS.map((seat) => [seat.name, workspaceLabel(seat)])) as Record<string, string>;
const DISPLAYS = Object.fromEntries(TARGET_SEATS.map((seat) => [seat.name, displayAgent(seat)])) as Record<string, string>;

let made: string[] = [];
afterEach(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
  made = [];
});

type Place = { floorRoot: string; targetRoot: string; otherRoot: string; home: string };

/** A main folder holding a project checkout, a sibling team outside it, and a home. Each team
 *  file is the one its own folder holds; the target and sibling are git checkouts, the main
 *  folder is the plain folder above them, as the main team file describes itself. */
function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-lift-')));
  made.push(base);
  const floorRoot = join(base, 'floor');
  const targetRoot = join(floorRoot, 'material');
  const otherRoot = join(base, 'other');
  const home = join(base, 'home');
  for (const root of [floorRoot, targetRoot, otherRoot]) mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(floorRoot, '.agents', 'team.yaml'), MAIN_TEXT.replace('__ROOT__', floorRoot));
  writeFileSync(join(targetRoot, '.agents', 'team.yaml'), TARGET_TEXT.replace('__ROOT__', targetRoot));
  writeFileSync(join(otherRoot, '.agents', 'team.yaml'), OTHER_TEXT.replace('__ROOT__', otherRoot));
  for (const root of [targetRoot, otherRoot]) execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  // The main orchestrator, placed where the main team's own launch recorded it.
  writeState(join(floorRoot, '.agents'), { [MAIN_SESSION]: { seats: { atlas: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } }, worktrees: {} } });
  // The target's seats, a watch recent enough to be no difference, and one seat the file no
  // longer declares — the leftover the repair is asked to drop.
  writeState(join(targetRoot, '.agents'), {
    [TARGET_SESSION]: {
      seats: {
        mill: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' },
        helper: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
        gone: { stage: 'ready', pane: 'w9:p1', workspace: 'w9' },
      },
      worktrees: {},
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    },
  });
  writeState(join(otherRoot, '.agents'), {
    [OTHER_SESSION]: { seats: { 'other-lead': { stage: 'ready', pane: 'w3:p1', workspace: 'w3' } }, worktrees: {} },
  });
  // The registry: three teams, each with the session its own file names.
  upsertTeam(home, teamIdOf(floorRoot), { project: 'floor', entity: 'floor', session: MAIN_SESSION, root: floorRoot, roster: [], by: 'test' });
  upsertTeam(home, teamIdOf(targetRoot), { project: 'material', entity: 'floor', session: TARGET_SESSION, root: targetRoot, roster: [], by: 'test' });
  upsertTeam(home, teamIdOf(otherRoot), { project: 'other', entity: 'floor', session: OTHER_SESSION, root: otherRoot, roster: [], by: 'test' });
  return { floorRoot, targetRoot, otherRoot, home };
}

function writeState(dir: string, sessions: Record<string, unknown>): void {
  writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({ format: 1, sessions }, null, 2)}\n`);
}

const UNDER_HERDR: Process[] = [
  { pid: 501, name: 'zsh' },
  { pid: 500, name: 'herdr' },
];

/** One agent per pane the scene places in a session, and the pane roots a herdr would answer:
 *  the caller's pane root is an ancestor, every other pane belongs to another process. */
function herdr(sessions: Record<string, { name: string; pane: string }[]>): (asked?: string) => CallerSources {
  return (asked) => {
    const agents = asked === undefined ? [] : (sessions[asked] ?? []);
    return {
      ancestors: () => UNDER_HERDR,
      agents: () => agents.map((agent) => ({ name: agent.name, agent: 'claude', pane: agent.pane, workspace: agent.pane.split(':')[0] ?? '', status: 'idle', cwd: null })),
      paneRootPid: (pane) => (agents.some((agent) => agent.pane === pane) ? 501 : null),
      env: {},
      stdinIsTTY: false,
    };
  };
}

/** The target session as herdr answers it: both seats live, their sidebar lines the file's own. */
function live(): Live {
  return {
    running: true,
    agents: [
      { name: 'mill', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null, displayAgent: DISPLAYS.mill as string },
      { name: 'helper', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null, displayAgent: DISPLAYS.helper as string },
    ],
    workspaces: [
      { id: 'w1', label: TITLES.mill as string },
      { id: 'w2', label: TITLES.helper as string },
    ],
    screens: { 'w1:p1': CLAUDE_IDLE, 'w2:p1': CLAUDE_IDLE },
  };
}

/** The verified approval the read gate asks for; this scene is about the write gate's caller. */
function verified(): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: NOW.toISOString(),
    record: {
      approval: { format: 2, approvedAt: NOW.toISOString(), root: '/synthetic/material', fingerprints: fingerprints(TARGET_TEAM), ceilings: { seats: 0, temporary: 0, vendors: {} } },
      file: TARGET_TEXT,
      generation: 1,
      signature: 'test',
    },
  };
}

type Run = { code: number; out: string; err: string };

/** One `check --repair` as the caller the sources place. The sidebar writes are injected as
 *  accepted and recorded nowhere: the scene reads only the gate and the state's leftover. */
function repair(at: Place, io: ReturnType<typeof testIo>, json = false): Run {
  const sources: CheckSources = {
    live: () => live(),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, at.home),
    now: () => NOW,
    home: at.home,
    gate: {
      standing: () => verified(),
      state: () => readState(join(at.targetRoot, '.agents')),
      agents: () => [],
      sessionRunning: () => true,
    },
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
  };
  const code = runTeamCheck({ repair: true, ...(json ? { json: true } : {}) }, io, sources);
  return { code, out: io.out, err: io.err };
}

function dropped(at: Place): boolean {
  return readState(join(at.targetRoot, '.agents')).sessions[TARGET_SESSION]?.seats.gone === undefined;
}

function logOf(at: Place): string {
  const path = join(at.targetRoot, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('the main orchestrator across teams', () => {
  test('a placed main orchestrator continues past --repair, with the warning and its audit', () => {
    const at = place();
    const io = testIo(at.targetRoot);
    io.callerSources = herdr({ [MAIN_SESSION]: [{ name: 'atlas', pane: 'w1:p1' }] });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const run = repair(at, io);
    expect(run.err).not.toContain("team check: --repair is the owner's");
    expect(run.err).toContain("warning: --repair is the owner's; dev mode continues");
    expect(dropped(at)).toBe(true);
    expect(logOf(at)).toContain("check [atlas] warning: --repair is the owner's; dev mode continues; admitted as orchestrator");
  });

  test('the JSON form continues too, and writes no check.repair-owner error', () => {
    const at = place();
    const io = testIo(at.targetRoot);
    io.callerSources = herdr({ [MAIN_SESSION]: [{ name: 'atlas', pane: 'w1:p1' }] });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const run = repair(at, io, true);
    expect(run.err).toContain("warning: --repair is the owner's; dev mode continues");
    expect(run.out).not.toContain('check.repair-owner');
    expect(run.out).toContain('"name": "team.check"');
    expect(dropped(at)).toBe(true);
  });

  test('a lead outside the main team is refused: the entity alone is no admission', () => {
    const at = place();
    const io = testIo(at.targetRoot);
    // It reads the team through the same approved delegate pane the main orchestrator uses, so
    // the refusal below is the owner gate's, not the read gate's: the guest's own team is not
    // the one above the target, and a shared entity does not make it so.
    io.callerSources = herdr({ [MAIN_SESSION]: [{ name: 'other-lead', pane: 'w1:p1' }] });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const run = repair(at, io);
    expect(run.err).toContain("team check: --repair is the owner's\n");
    expect(dropped(at)).toBe(false);
    expect(logOf(at)).toBe('');
  });

  test('the right name on another pane is refused, and dev mode off refuses the placed lead', () => {
    const at = place();
    // The main team's own state records its orchestrator on another pane than the one this call
    // stands on: the name is the orchestrator's, the placement is not.
    writeState(join(at.floorRoot, '.agents'), {
      [MAIN_SESSION]: { seats: { atlas: { stage: 'ready', pane: 'w9:p9', workspace: 'w9' } }, worktrees: {} },
    });
    const wrongPane = testIo(at.targetRoot);
    wrongPane.callerSources = herdr({ [MAIN_SESSION]: [{ name: 'atlas', pane: 'w1:p1' }] });
    wrongPane.env = { TEAMCLI_DEV_MODE: '1' };
    expect(repair(at, wrongPane).err).toContain("team check: --repair is the owner's\n");
    expect(dropped(at)).toBe(false);

    const off = testIo(at.targetRoot);
    off.callerSources = herdr({ [MAIN_SESSION]: [{ name: 'atlas', pane: 'w1:p1' }] });
    const run = repair(at, off);
    expect(run.err).toContain("team check: --repair is the owner's\n");
    expect(dropped(at)).toBe(false);
    expect(logOf(at)).toBe('');
  });
});

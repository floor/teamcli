// Independent coverage for the C7.5 follow-up in `team check`: a workspace is named only when
// no team record holds it and every pane in it is a bare shell; held workspaces are never named,
// and no unrecorded workspace is closed, even under `--repair`. Every reading is a synthetic
// terminal host: no real workspace is listed, inspected or closed.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realCheckSources, runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  DEFAULT_SIDEBAR_ROWS,
  hostConfigPath,
  renderSidebarTomlBlock,
  setCaptureExec,
  setHerdrRun,
  setPaneExec,
} from '../src/herdr.ts';
import { sidebarRowsWord } from '../src/policy/index.ts';
import { recordSidebarReloads } from '../src/registry/sidebar-reloads.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const SESSION = 'acme-app';
/** Delegates name panes outside their team's own session, so own-delegate coverage checks this one. */
const OTHER = 'acme-alt';

const TEAM_YAML = `format: 1
project: acme
session: ${SESSION}
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: parked
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
delegates:
  - pane: ${OTHER}/ws-own-deleg:p1
    commands:
      - up
`;

const SIBLING_YAML = `format: 1
project: sibling
session: ${OTHER}
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
delegates:
  - pane: ${SESSION}/ws-sib-deleg:p1
    commands:
      - up
`;

const parsed = validateTeamFile(TEAM_YAML);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
const LEAD_SEAT = parsed.team.seats[0]!;
const LEAD_TITLE = workspaceLabel(LEAD_SEAT);
const LEAD_DISPLAY = displayAgent(LEAD_SEAT);
const DEFAULT_TOML_BLOCK = renderSidebarTomlBlock(DEFAULT_SIDEBAR_ROWS, 'symbols');
const DEFAULT_ROWS_WORD = sidebarRowsWord(DEFAULT_SIDEBAR_ROWS);

type PaneSpec = {
  pane: string;
  workspace: string;
  shell: number;
  foreground: number[];
  screen?: string;
  displayAgent?: string;
};

type AgentSpec = {
  name: string | null;
  agent: string | null;
  pane: string;
  workspace: string;
  status: string;
  cwd: string | null;
  displayAgent?: string;
};

type SessionSpec = {
  running: boolean;
  workspaces: { id: string; label: string }[];
  panes: PaneSpec[];
  agents: AgentSpec[];
};

type HostTrace = {
  calls: { session?: string; args: string[] }[];
  closed: { session?: string; workspace: string }[];
};

const tempDirs: string[] = [];

beforeEach(() => {
  setCaptureExec(null);
  setHerdrRun(null);
  setPaneExec(null);
});

afterEach(() => {
  setCaptureExec(null);
  setHerdrRun(null);
  setPaneExec(null);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Own team with a live seat, a stopped seat, watch, bus, watchdog and one own delegate. */
function makeWorld(): { base: string; root: string; dir: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-unrecorded-independent-')));
  tempDirs.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEAM_YAML);

  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = {
      stage: 'ready',
      pane: 'ws-lead:p1',
      workspace: 'ws-lead',
      launched: { shell: 100, cli: [200] },
    };
    session.seats.parked = {
      stage: 'ready',
      pane: 'ws-parked:p1',
      workspace: 'ws-parked',
    };
    session.watch = { pid: 42, heartbeat: NOW.toISOString(), pane: 'ws-watch:p1', workspace: 'ws-watch' };
    session.bus = { pane: 'ws-bus:p1', workspace: 'ws-bus', started: NOW.toISOString() };
    session.watchdog = { file: 'watchdog.log', pane: 'ws-dog:p1' };
    // The other session this team's delegate names; checked below so its own delegate is in play.
    const other = (state.sessions[OTHER] ??= emptySession());
    other.seats.lead = {
      stage: 'ready',
      pane: 'alt-lead:p1',
      workspace: 'alt-lead',
      launched: { shell: 300, cli: [400] },
    };
  });

  deliverBriefs({
    dir,
    root,
    session: SESSION,
    seats: ['lead', 'parked'],
    home,
    at: NOW.toISOString(),
  });

  const cfgPath = hostConfigPath(home);
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  writeFileSync(cfgPath, `${DEFAULT_TOML_BLOCK}\n`, { mode: 0o600 });
  recordSidebarReloads(home, [
    { session: SESSION, record: { rows: DEFAULT_ROWS_WORD, indicators: 'symbols', at: NOW.toISOString() } },
  ]);

  return { base, root, dir, home };
}

/** A second registered team in the same session, with a seat and a delegate in that session. */
function makeSibling(world: { base: string; home: string }): { root: string; dir: string } {
  const root = join(world.base, 'sibling');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), SIBLING_YAML);
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.helper = {
      stage: 'ready',
      pane: 'ws-sib-seat:p1',
      workspace: 'ws-sib-seat',
    };
  });
  upsertTeam(world.home, teamIdOf(root), {
    project: 'sibling',
    session: OTHER,
    root,
    at: NOW.toISOString(),
  });
  return { root, dir };
}

function installSyntheticHost(sessions: Record<string, SessionSpec>): HostTrace {
  const trace: HostTrace = { calls: [], closed: [] };

  const sessionListJson = () =>
    JSON.stringify({
      sessions: Object.entries(sessions).map(([name, spec]) => ({
        name,
        running: spec.running,
        session_dir: null,
        socket_path: null,
      })),
    });

  const recordClose = (session: string | undefined, workspace: string) => {
    trace.closed.push({ ...(session === undefined ? {} : { session }), workspace });
  };

  // The adapter paths that do not go through the herdr run hook still read the synthetic host.
  setCaptureExec((args) => {
    trace.calls.push({ args });
    if (args[0] === 'session' && args[1] === 'list') return sessionListJson();
    if (args.includes('close') && args.includes('workspace')) {
      const at = args.indexOf('close');
      recordClose(undefined, args[at + 1] ?? '');
      return JSON.stringify({ result: { closed: true } });
    }
    return JSON.stringify({ result: {} });
  });

  setPaneExec((args) => {
    const at = args.indexOf('--session');
    const session = at >= 0 ? args[at + 1] : SESSION;
    const read = args.indexOf('read');
    const paneId = read >= 0 ? args[read + 1] : '';
    return sessions[session ?? SESSION]?.panes.find((p) => p.pane === paneId)?.screen ?? '';
  });

  setHerdrRun((args, session) => {
    trace.calls.push({ ...(session === undefined ? {} : { session }), args });
    if (args[0] === 'session' && args[1] === 'list') return sessionListJson();
    const current = sessions[session ?? SESSION];
    if (!current) return null;

    if (args[0] === 'workspace' && args[1] === 'list') {
      return { workspaces: current.workspaces.map((w) => ({ workspace_id: w.id, label: w.label })) };
    }
    if (args[0] === 'agent' && args[1] === 'list') {
      return {
        agents: current.agents.map((a) => ({
          name: a.name,
          agent: a.agent,
          pane_id: a.pane,
          workspace_id: a.workspace,
          agent_status: a.status,
          cwd: a.cwd,
          ...(a.displayAgent === undefined ? {} : { display_agent: a.displayAgent }),
        })),
      };
    }
    if (args[0] === 'pane' && args[1] === 'list' && args[2] === '--workspace') {
      const id = args[3] ?? '';
      return {
        panes: current.panes
          .filter((p) => p.workspace === id)
          .map((p) => ({
            pane_id: p.pane,
            workspace_id: p.workspace,
            ...(p.displayAgent === undefined ? {} : { display_agent: p.displayAgent }),
          })),
      };
    }
    if (args[0] === 'pane' && args[1] === 'process-info' && args[2] === '--pane') {
      const id = args[3] ?? '';
      const pane = current.panes.find((p) => p.pane === id);
      if (!pane) return null;
      return {
        process_info: {
          shell_pid: pane.shell,
          foreground_processes: pane.foreground.map((pid) => ({
            pid,
            argv0: pid === pane.shell ? 'zsh' : 'claude',
          })),
        },
      };
    }
    if (args[0] === 'workspace' && args[1] === 'close') {
      recordClose(session, args[2] ?? '');
      return { closed: true };
    }
    return null;
  });

  return trace;
}

/** The shared scene: one reportable stray, every other workspace held by a team record. */
function fixtureSessions(root: string): Record<string, SessionSpec> {
  return {
    [SESSION]: {
      running: true,
      workspaces: [
        { id: 'ws-lead', label: LEAD_TITLE },
        { id: 'ws-parked', label: 'parked' },
        { id: 'ws-watch', label: 'watch' },
        { id: 'ws-bus', label: 'bus' },
        { id: 'ws-dog', label: 'watchdog' },
        { id: 'ws-own-deleg', label: 'own-delegate' },
        { id: 'ws-sib-deleg', label: 'sibling-delegate' },
        { id: 'ws-sib-seat', label: 'sibling-seat' },
        { id: 'ws-stray', label: 'leftover' },
      ],
      panes: [
        {
          pane: 'ws-lead:p1',
          workspace: 'ws-lead',
          shell: 100,
          foreground: [200],
          screen: CLAUDE_IDLE,
          displayAgent: LEAD_DISPLAY,
        },
        { pane: 'ws-parked:p1', workspace: 'ws-parked', shell: 110, foreground: [110] },
        { pane: 'ws-watch:p1', workspace: 'ws-watch', shell: 120, foreground: [120] },
        { pane: 'ws-bus:p1', workspace: 'ws-bus', shell: 130, foreground: [130] },
        { pane: 'ws-dog:p1', workspace: 'ws-dog', shell: 140, foreground: [140] },
        { pane: 'ws-own-deleg:p1', workspace: 'ws-own-deleg', shell: 150, foreground: [150] },
        { pane: 'ws-sib-deleg:p1', workspace: 'ws-sib-deleg', shell: 160, foreground: [160] },
        { pane: 'ws-sib-seat:p1', workspace: 'ws-sib-seat', shell: 170, foreground: [170] },
        { pane: 'ws-stray:p1', workspace: 'ws-stray', shell: 500, foreground: [500] },
      ],
      agents: [
        {
          name: 'lead',
          agent: 'claude',
          pane: 'ws-lead:p1',
          workspace: 'ws-lead',
          status: 'idle',
          cwd: root,
          displayAgent: LEAD_DISPLAY,
        },
      ],
    },
    [OTHER]: {
      running: true,
      workspaces: [
        { id: 'alt-lead', label: LEAD_TITLE },
        { id: 'ws-own-deleg', label: 'own-delegate' },
        { id: 'ws-alt-stray', label: 'alt-leftover' },
      ],
      panes: [
        {
          pane: 'alt-lead:p1',
          workspace: 'alt-lead',
          shell: 300,
          foreground: [400],
          screen: CLAUDE_IDLE,
          displayAgent: LEAD_DISPLAY,
        },
        // The pane this team's own delegate entry names, in a session outside the team's own.
        { pane: 'ws-own-deleg:p1', workspace: 'ws-own-deleg', shell: 150, foreground: [150] },
        { pane: 'ws-alt-stray:p1', workspace: 'ws-alt-stray', shell: 600, foreground: [600] },
      ],
      agents: [
        {
          name: 'lead',
          agent: 'claude',
          pane: 'alt-lead:p1',
          workspace: 'alt-lead',
          status: 'idle',
          cwd: root,
          displayAgent: LEAD_DISPLAY,
        },
      ],
    },
  };
}

function check(
  world: { root: string; home: string },
  options: { repair?: boolean; session?: string } = {},
): { code: number; out: string; err: string } {
  const io = testIo(world.root, { kind: 'owner' });
  const code = runTeamCheck(
    {
      file: '.agents/team.yaml',
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.repair === true ? { repair: true } : {}),
    },
    io,
    {
      ...realCheckSources,
      branch: () => 'main',
      standing: (at) => approvalStanding(at, world.home),
      now: () => NOW,
      home: world.home,
      alive: () => true,
      pendingGreen: () => [],
      orphans: undefined,
      closeOrphans: undefined,
    },
  );
  return { code, out: io.out, err: io.err };
}

describe('independent: unrecorded workspaces in team check', () => {
  test('names only the bare-shell workspace no record holds, and closes nothing under --repair', () => {
    const world = makeWorld();
    makeSibling(world);
    const trace = installSyntheticHost(fixtureSessions(world.root));

    const plain = check(world);
    expect(plain.code).toBe(1);
    expect(plain.out).toContain('difference: unrecorded workspace ws-stray (leftover) holds only shells');
    expect(plain.out).toContain('  repair: look at the workspace; close it if it is yours');

    // Every workspace a record holds is left out here: live and stopped seats, watch, bus,
    // watchdog, and the sibling team's seat and delegate.
    for (const held of ['ws-lead', 'ws-parked', 'ws-watch', 'ws-bus', 'ws-dog', 'ws-sib-deleg', 'ws-sib-seat']) {
      expect(plain.out).not.toContain(`unrecorded workspace ${held}`);
    }

    // The report came from fresh readings through the synthetic host.
    expect(
      trace.calls.some(
        (c) => c.session === SESSION && c.args.join(' ') === 'pane list --workspace ws-stray',
      ),
    ).toBe(true);
    expect(
      trace.calls.some(
        (c) => c.session === SESSION && c.args.join(' ') === 'pane process-info --pane ws-stray:p1',
      ),
    ).toBe(true);
    expect(trace.closed).toEqual([]);

    const repaired = check(world, { repair: true });
    expect(repaired.code).toBe(1);
    expect(repaired.out).toContain('difference: unrecorded workspace ws-stray (leftover) holds only shells');
    expect(trace.closed).toEqual([]);

    // In the session this team's own delegate entry names, that delegate's bare-shell pane is
    // held and never named, while a true stray in the same session is still reported.
    const other = check(world, { session: OTHER });
    expect(other.code).toBe(1);
    expect(other.out).toContain('difference: unrecorded workspace ws-alt-stray (alt-leftover) holds only shells');
    expect(other.out).not.toContain('unrecorded workspace ws-own-deleg');
    expect(other.out).not.toContain('unrecorded workspace alt-lead');
    expect(trace.closed).toEqual([]);
  });

  test('leaves out a workspace with any non-shell process, even beside a bare shell pane', () => {
    const world = makeWorld();
    const trace = installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-busy', label: 'busy' },
          { id: 'ws-mixed', label: 'mixed' },
          { id: 'ws-stray', label: 'leftover' },
        ],
        panes: [
          {
            pane: 'ws-lead:p1',
            workspace: 'ws-lead',
            shell: 100,
            foreground: [200],
            screen: CLAUDE_IDLE,
            displayAgent: LEAD_DISPLAY,
          },
          // One pane runs a program in front of a non-shell process.
          { pane: 'ws-busy:p1', workspace: 'ws-busy', shell: 510, foreground: [910] },
          // Two panes: one bare shell, one that runs a program; the workspace is not all shells.
          { pane: 'ws-mixed:p1', workspace: 'ws-mixed', shell: 520, foreground: [520] },
          { pane: 'ws-mixed:p2', workspace: 'ws-mixed', shell: 521, foreground: [921] },
          { pane: 'ws-stray:p1', workspace: 'ws-stray', shell: 500, foreground: [500] },
        ],
        agents: [
          {
            name: 'lead',
            agent: 'claude',
            pane: 'ws-lead:p1',
            workspace: 'ws-lead',
            status: 'idle',
            cwd: world.root,
            displayAgent: LEAD_DISPLAY,
          },
        ],
      },
    });

    const res = check(world);
    expect(res.code).toBe(1);
    expect(res.out).toContain('difference: unrecorded workspace ws-stray (leftover) holds only shells');
    expect(res.out).not.toContain('unrecorded workspace ws-busy');
    expect(res.out).not.toContain('unrecorded workspace ws-mixed');
    expect(trace.closed).toEqual([]);
  });
});

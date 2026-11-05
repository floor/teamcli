// C7.5 follow-up: `team check` reports, per session, the workspaces whose panes are all bare
// shells and which no team record names, as:
//   difference: unrecorded workspace <id> (<label>) holds only shells
//     repair: look at the workspace; close it if it is yours
// Read-only, from fresh readings through the terminal host role, and never closed even under
// `team check --repair`.
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

const NOW = new Date('2026-11-05T10:00:00Z');
const SESSION = 'acme-app';
const ALT_SESSION = 'acme-alt';

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
    name: halted
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const parsed = validateTeamFile(TEAM_YAML);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
const LEAD_SEAT = parsed.team.seats[0]!;
const LEAD_TITLE = workspaceLabel(LEAD_SEAT);
const LEAD_DISPLAY = displayAgent(LEAD_SEAT);
const DEFAULT_ROWS_WORD = sidebarRowsWord(DEFAULT_SIDEBAR_ROWS);
const DEFAULT_TOML_BLOCK = renderSidebarTomlBlock(DEFAULT_SIDEBAR_ROWS, 'symbols');

type SyntheticPane = {
  pane: string;
  workspace: string;
  shell: number;
  foreground: number[];
  screen?: string;
  displayAgent?: string;
  unreadableProcess?: boolean;
};

type SyntheticSession = {
  running: boolean;
  workspaces: { id: string; label: string; unreadablePanes?: boolean; emptyPanes?: boolean }[];
  panes: SyntheticPane[];
  agents: {
    name: string | null;
    agent: string | null;
    pane: string;
    workspace: string;
    status: string;
    cwd: string | null;
    displayAgent?: string;
  }[];
};

type HostTrace = {
  calls: { session?: string; args: string[] }[];
  closedWorkspaces: { session?: string; workspace: string }[];
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

function installSyntheticHost(sessions: Record<string, SyntheticSession>): HostTrace {
  const trace: HostTrace = { calls: [], closedWorkspaces: [] };

  const sessionListJson = () =>
    JSON.stringify({
      sessions: Object.entries(sessions).map(([name, s]) => ({
        name,
        running: s.running,
        session_dir: null,
        socket_path: null,
      })),
    });

  setCaptureExec((args) => {
    trace.calls.push({ args });
    if (args[0] === 'session' && args[1] === 'list') {
      return sessionListJson();
    }
    if (args.includes('close') && args.includes('workspace')) {
      const idx = args.indexOf('close');
      trace.closedWorkspaces.push({ workspace: args[idx + 1] ?? '' });
      return JSON.stringify({ result: { closed: true } });
    }
    return JSON.stringify({ result: {} });
  });

  setPaneExec((args) => {
    const sessIdx = args.indexOf('--session');
    const session = sessIdx >= 0 ? args[sessIdx + 1] : SESSION;
    const readIdx = args.indexOf('read');
    const paneId = readIdx >= 0 ? args[readIdx + 1] : '';
    const found = sessions[session ?? SESSION]?.panes.find((p) => p.pane === paneId);
    return found?.screen ?? '';
  });

  setHerdrRun((args, session) => {
    trace.calls.push({ ...(session === undefined ? {} : { session }), args });
    if (args[0] === 'session' && args[1] === 'list') {
      return sessionListJson();
    }
    const current = sessions[session ?? SESSION];
    if (!current) return null;

    if (args[0] === 'workspace' && args[1] === 'list') {
      return {
        workspaces: current.workspaces.map((w) => ({
          workspace_id: w.id,
          label: w.label,
        })),
      };
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
      const wsId = args[3] ?? '';
      const ws = current.workspaces.find((w) => w.id === wsId);
      if (!ws || ws.unreadablePanes) return null;
      if (ws.emptyPanes) return { panes: [] };
      const panes = current.panes
        .filter((p) => p.workspace === wsId)
        .map((p) => ({
          pane_id: p.pane,
          workspace_id: p.workspace,
          ...(p.displayAgent === undefined ? {} : { display_agent: p.displayAgent }),
        }));
      return { panes };
    }
    if (args[0] === 'pane' && args[1] === 'process-info' && args[2] === '--pane') {
      const paneId = args[3] ?? '';
      const pane = current.panes.find((p) => p.pane === paneId);
      if (!pane || pane.unreadableProcess) return null;
      return {
        process_info: {
          shell_pid: pane.shell,
          foreground_processes: pane.foreground.map((pid) => ({ pid, argv0: pid === pane.shell ? 'zsh' : 'claude' })),
        },
      };
    }
    if (args[0] === 'workspace' && args[1] === 'close') {
      trace.closedWorkspaces.push({ ...(session === undefined ? {} : { session }), workspace: args[2] ?? '' });
      return { closed: true };
    }
    return null;
  });

  return trace;
}

function makeWorld(): { base: string; root: string; dir: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-unrecorded-ws-')));
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
    session.seats.halted = {
      stage: 'ready',
      pane: 'ws-halted:p1',
      workspace: 'ws-halted',
      launched: { shell: 110, cli: [210] },
    };
    session.watch = { pid: 42, heartbeat: NOW.toISOString(), pane: 'ws-watch:p1', workspace: 'ws-watch' };
    session.bus = { pane: 'ws-bus:p1', workspace: 'ws-bus', started: NOW.toISOString() };
  });

  deliverBriefs({
    dir,
    root,
    session: SESSION,
    seats: ['lead', 'halted'],
    home,
    at: NOW.toISOString(),
  });

  const cfgPath = hostConfigPath(home);
  mkdirSync(join(cfgPath, '..'), { recursive: true });
  writeFileSync(cfgPath, `${DEFAULT_TOML_BLOCK}\n`, { mode: 0o600 });
  recordSidebarReloads(home, [
    {
      session: SESSION,
      record: { rows: DEFAULT_ROWS_WORD, indicators: 'symbols', at: NOW.toISOString() },
    },
    {
      session: ALT_SESSION,
      record: { rows: DEFAULT_ROWS_WORD, indicators: 'symbols', at: NOW.toISOString() },
    },
  ]);

  return { base, root, dir, home };
}

function runCheckWithHost(
  world: { root: string; home: string },
  options: { session?: string; repair?: boolean; json?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const io = testIo(world.root, { kind: 'owner' });
  const code = runTeamCheck(
    {
      file: '.agents/team.yaml',
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.repair === true ? { repair: true } : {}),
      ...(options.json === true ? { json: true } : {}),
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
  return { code, stdout: io.out, stderr: io.err };
}

describe('team check unrecorded bare-shell workspaces', () => {
  test('reports an unrecorded workspace whose panes are all bare shells and never closes it', () => {
    const world = makeWorld();
    const trace = installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-halted', label: 'halted' },
          { id: 'ws-watch', label: 'watch' },
          { id: 'ws-bus', label: 'bus' },
          { id: 'ws-stray-1', label: 'owner-scratch' },
          { id: 'ws-stray-2', label: 'split-shells' },
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
          // Recorded stopped seat workspace holding a bare shell -> recorded, so NOT reported as unrecorded
          { pane: 'ws-halted:p1', workspace: 'ws-halted', shell: 110, foreground: [110] },
          // Recorded watch and bus workspaces holding bare shells -> recorded, so NOT reported as unrecorded
          { pane: 'ws-watch:p1', workspace: 'ws-watch', shell: 120, foreground: [120] },
          { pane: 'ws-bus:p1', workspace: 'ws-bus', shell: 130, foreground: [130] },
          // Unrecorded workspace with one bare shell pane -> reported
          { pane: 'ws-stray-1:p1', workspace: 'ws-stray-1', shell: 500, foreground: [500] },
          // Unrecorded workspace with two bare shell panes -> reported
          { pane: 'ws-stray-2:p1', workspace: 'ws-stray-2', shell: 600, foreground: [600] },
          { pane: 'ws-stray-2:p2', workspace: 'ws-stray-2', shell: 601, foreground: [601] },
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

    const plain = runCheckWithHost(world);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain('difference: unrecorded workspace ws-stray-1 (owner-scratch) holds only shells');
    expect(plain.stdout).toContain('  repair: look at the workspace; close it if it is yours');
    expect(plain.stdout).toContain('difference: unrecorded workspace ws-stray-2 (split-shells) holds only shells');
    expect(plain.stdout).not.toContain('ws-halted');
    expect(plain.stdout).not.toContain('ws-watch');
    expect(plain.stdout).not.toContain('ws-bus');
    expect(trace.closedWorkspaces).toEqual([]);

    // Verify fresh terminal-host readings were taken for the unrecorded workspaces
    expect(
      trace.calls.some(
        (c) =>
          c.session === SESSION &&
          c.args[0] === 'pane' &&
          c.args[1] === 'list' &&
          c.args[2] === '--workspace' &&
          c.args[3] === 'ws-stray-1',
      ),
    ).toBe(true);
    expect(
      trace.calls.some(
        (c) =>
          c.session === SESSION &&
          c.args[0] === 'pane' &&
          c.args[1] === 'process-info' &&
          c.args[2] === '--pane' &&
          c.args[3] === 'ws-stray-2:p2',
      ),
    ).toBe(true);

    // JSON output carries the exact difference and repair
    const jsonRun = runCheckWithHost(world, { json: true });
    expect(jsonRun.code).toBe(1);
    const doc = JSON.parse(jsonRun.stdout) as {
      differences: { what: string; repair: string; who: string }[];
    };
    expect(doc.differences).toEqual([
      {
        what: 'unrecorded workspace ws-stray-1 (owner-scratch) holds only shells',
        repair: 'look at the workspace; close it if it is yours',
        who: "the team's lead",
      },
      {
        what: 'unrecorded workspace ws-stray-2 (split-shells) holds only shells',
        repair: 'look at the workspace; close it if it is yours',
        who: "the team's lead",
      },
    ]);

    // `--repair` never closes an unrecorded workspace
    const repaired = runCheckWithHost(world, { repair: true });
    expect(repaired.code).toBe(1);
    expect(repaired.stdout).toContain('difference: unrecorded workspace ws-stray-1 (owner-scratch) holds only shells');
    expect(trace.closedWorkspaces).toEqual([]);
  });

  test('skips unrecorded workspaces that run a foreground process or have unreadable panes/processes', () => {
    const world = makeWorld();
    installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-busy-cli', label: 'busy-cli' },
          { id: 'ws-shell-plus-child', label: 'shell-plus-child' },
          { id: 'ws-mixed-panes', label: 'mixed-panes' },
          { id: 'ws-unreadable-panes', label: 'unreadable-panes', unreadablePanes: true },
          { id: 'ws-empty-panes', label: 'empty-panes', emptyPanes: true },
          { id: 'ws-unreadable-proc', label: 'unreadable-proc' },
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
          // Foreground is a non-shell process
          { pane: 'ws-busy-cli:p1', workspace: 'ws-busy-cli', shell: 500, foreground: [900] },
          // Foreground lists both shell and a child process beside it
          { pane: 'ws-shell-plus-child:p1', workspace: 'ws-shell-plus-child', shell: 510, foreground: [510, 910] },
          // First pane is bare shell, second pane runs a process
          { pane: 'ws-mixed-panes:p1', workspace: 'ws-mixed-panes', shell: 520, foreground: [520] },
          { pane: 'ws-mixed-panes:p2', workspace: 'ws-mixed-panes', shell: 521, foreground: [921] },
          // Process info cannot be read
          {
            pane: 'ws-unreadable-proc:p1',
            workspace: 'ws-unreadable-proc',
            shell: 530,
            foreground: [530],
            unreadableProcess: true,
          },
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

    const res = runCheckWithHost(world);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('no differences');
    expect(res.stdout).not.toContain('unrecorded workspace');
  });

  test('does not report a workspace named by another registered team in the same session', () => {
    const world = makeWorld();
    const otherRoot = join(world.base, 'sibling');
    const otherDir = join(otherRoot, '.agents');
    mkdirSync(otherDir, { recursive: true });
    upsertTeam(world.home, teamIdOf(otherRoot), {
      project: 'sibling',
      session: SESSION,
      root: otherRoot,
      at: NOW.toISOString(),
    });
    updateState(otherDir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      session.seats.helper = {
        stage: 'ready',
        pane: 'ws-sibling:p1',
        workspace: 'ws-sibling',
      };
    });

    installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-sibling', label: 'sibling-helper' },
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
          { pane: 'ws-sibling:p1', workspace: 'ws-sibling', shell: 700, foreground: [700] },
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

    const res = runCheckWithHost(world);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('ws-sibling');
  });

  test('reports per session when --session targets another session', () => {
    const world = makeWorld();
    updateState(world.dir, (state) => {
      const alt = (state.sessions[ALT_SESSION] ??= emptySession());
      alt.seats.lead = {
        stage: 'ready',
        pane: 'alt-lead:p1',
        workspace: 'alt-lead',
        launched: { shell: 300, cli: [400] },
      };
      alt.watch = { pid: 42, heartbeat: NOW.toISOString(), pane: 'alt-watch:p1', workspace: 'alt-watch' };
    });
    deliverBriefs({
      dir: world.dir,
      root: world.root,
      session: ALT_SESSION,
      seats: ['lead'],
      home: world.home,
      at: NOW.toISOString(),
    });

    installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [{ id: 'ws-lead', label: LEAD_TITLE }],
        panes: [
          {
            pane: 'ws-lead:p1',
            workspace: 'ws-lead',
            shell: 100,
            foreground: [200],
            screen: CLAUDE_IDLE,
            displayAgent: LEAD_DISPLAY,
          },
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
      [ALT_SESSION]: {
        running: true,
        workspaces: [
          { id: 'alt-lead', label: LEAD_TITLE },
          { id: 'alt-stray', label: 'alt-leftover' },
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
          { pane: 'alt-stray:p1', workspace: 'alt-stray', shell: 800, foreground: [800] },
        ],
        agents: [
          {
            name: 'lead',
            agent: 'claude',
            pane: 'alt-lead:p1',
            workspace: 'alt-lead',
            status: 'idle',
            cwd: world.root,
            displayAgent: LEAD_DISPLAY,
          },
        ],
      },
    });

    const primary = runCheckWithHost(world);
    expect(primary.code).toBe(0);
    expect(primary.stdout).not.toContain('unrecorded workspace');

    const alt = runCheckWithHost(world, { session: ALT_SESSION });
    expect(alt.code).toBe(1);
    expect(alt.stdout).toContain(`team acme, session "${ALT_SESSION}"`);
    expect(alt.stdout).toContain('difference: unrecorded workspace alt-stray (alt-leftover) holds only shells');
    expect(alt.stdout).toContain('  repair: look at the workspace; close it if it is yours');
  });

  test('treats a stale seat record as recorded until --repair drops it, and then reports its bare-shell workspace without closing it', () => {
    const world = makeWorld();
    updateState(world.dir, (state) => {
      const session = (state.sessions[SESSION] ??= emptySession());
      // A seat removed from the file whose state record still names ws-former
      session.seats.former = {
        stage: 'ready',
        pane: 'ws-former:p1',
        workspace: 'ws-former',
      };
      // A watch record that names only its pane (no workspace field)
      session.watch = { pid: 42, heartbeat: NOW.toISOString(), pane: 'ws-watch-pane-only:p1' };
    });

    const trace = installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-former', label: 'former-seat' },
          { id: 'ws-watch-pane-only', label: 'watch-pane-only' },
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
          { pane: 'ws-former:p1', workspace: 'ws-former', shell: 900, foreground: [900] },
          { pane: 'ws-watch-pane-only:p1', workspace: 'ws-watch-pane-only', shell: 910, foreground: [910] },
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

    // Before --repair: `former` is still in `state.seats`, so it is reported as a stale record,
    // not as an unrecorded workspace; `ws-watch-pane-only` is named by `watch.pane`.
    const before = runCheckWithHost(world);
    expect(before.code).toBe(1);
    expect(before.stdout).toContain('difference: former: left the team file but its record still claims pane ws-former:p1');
    expect(before.stdout).not.toContain('unrecorded workspace');

    // During --repair: `former`'s state record is dropped, so `ws-former` now has no team record
    // naming it and is reported as an unrecorded bare-shell workspace; never closed.
    const repaired = runCheckWithHost(world, { repair: true });
    expect(repaired.code).toBe(1);
    expect(repaired.stdout).toContain('repaired: former: left the team file and its record claimed pane ws-former:p1; its record is dropped');
    expect(repaired.stdout).toContain('difference: unrecorded workspace ws-former (former-seat) holds only shells');
    expect(repaired.stdout).toContain('  repair: look at the workspace; close it if it is yours');
    expect(repaired.stdout).not.toContain('ws-watch-pane-only');
    expect(trace.closedWorkspaces).toEqual([]);
  });

  test('does not report a workspace holding a delegate pane of this team or a sibling team in the matching session', () => {
    const world = makeWorld();
    writeFileSync(
      join(world.dir, 'team.yaml'),
      `${TEAM_YAML}delegates:
  - pane: ${ALT_SESSION}/alt-delegate:p1
    commands:
      - up
`,
    );
    updateState(world.dir, (state) => {
      const alt = (state.sessions[ALT_SESSION] ??= emptySession());
      alt.seats.lead = {
        stage: 'ready',
        pane: 'alt-lead:p1',
        workspace: 'alt-lead',
        launched: { shell: 300, cli: [400] },
      };
      alt.watch = { pid: 42, heartbeat: NOW.toISOString(), pane: 'alt-watch:p1', workspace: 'alt-watch' };
    });
    deliverBriefs({
      dir: world.dir,
      root: world.root,
      session: ALT_SESSION,
      seats: ['lead'],
      home: world.home,
      at: NOW.toISOString(),
    });

    // Sibling team in ALT_SESSION whose delegates section names a bare-shell pane in SESSION.
    const siblingRoot = join(world.base, 'sibling-delegating');
    const siblingDir = join(siblingRoot, '.agents');
    mkdirSync(siblingDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: siblingRoot, stdio: 'ignore' });
    writeFileSync(
      join(siblingDir, 'team.yaml'),
      `format: 1
project: sibling
session: ${ALT_SESSION}
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
  - pane: ${SESSION}/ws-sib-delegate:p1
    commands:
      - up
`,
    );
    upsertTeam(world.home, teamIdOf(siblingRoot), {
      project: 'sibling',
      session: ALT_SESSION,
      root: siblingRoot,
      at: NOW.toISOString(),
    });

    installSyntheticHost({
      [SESSION]: {
        running: true,
        workspaces: [
          { id: 'ws-lead', label: LEAD_TITLE },
          { id: 'ws-sib-delegate', label: 'sibling-delegate' },
          // Same bare pane id `alt-delegate:p1`, but in SESSION rather than ALT_SESSION -> unrecorded here
          { id: 'ws-wrong-session-del', label: 'wrong-session-del' },
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
          { pane: 'ws-sib-delegate:p1', workspace: 'ws-sib-delegate', shell: 710, foreground: [710] },
          { pane: 'alt-delegate:p1', workspace: 'ws-wrong-session-del', shell: 720, foreground: [720] },
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
      [ALT_SESSION]: {
        running: true,
        workspaces: [
          { id: 'alt-lead', label: LEAD_TITLE },
          { id: 'alt-delegate', label: 'own-delegate' },
          { id: 'alt-stray', label: 'alt-leftover' },
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
          { pane: 'alt-delegate:p1', workspace: 'alt-delegate', shell: 810, foreground: [810] },
          { pane: 'alt-stray:p1', workspace: 'alt-stray', shell: 820, foreground: [820] },
        ],
        agents: [
          {
            name: 'lead',
            agent: 'claude',
            pane: 'alt-lead:p1',
            workspace: 'alt-lead',
            status: 'idle',
            cwd: world.root,
            displayAgent: LEAD_DISPLAY,
          },
        ],
      },
    });

    // In SESSION: sibling team's delegate `ws-sib-delegate:p1` is recorded, while `alt-delegate:p1`
    // (declared for ALT_SESSION, not SESSION) is unrecorded in SESSION.
    const primary = runCheckWithHost(world);
    expect(primary.code).toBe(1);
    expect(primary.stdout).not.toContain('ws-sib-delegate');
    expect(primary.stdout).toContain('difference: unrecorded workspace ws-wrong-session-del (wrong-session-del) holds only shells');

    // In ALT_SESSION: this team's own delegate `alt-delegate:p1` is recorded, while `alt-stray` is reported.
    const alt = runCheckWithHost(world, { session: ALT_SESSION });
    expect(alt.code).toBe(1);
    expect(alt.stdout).not.toContain('alt-delegate');
    expect(alt.stdout).toContain('difference: unrecorded workspace alt-stray (alt-leftover) holds only shells');
  });
});

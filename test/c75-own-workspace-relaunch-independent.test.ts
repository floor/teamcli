// Independent verification of C7.5 item 2: own-workspace relaunch and post-ready leftover close
// (src/commands/up.ts, src/commands/add.ts, src/launch/plan.ts, src/launch/execute.ts,
// src/launch/identity.ts).
//
// All terminal host readings, process tables, screens and filesystem roots are synthetic;
// no live terminal host, CLI or process signal is ever invoked.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { GENERAL_BRIEF_SHA256 } from '../src/launch/general-brief.ts';
import { paneHoldsOnlyShell, paneHoldsShell } from '../src/launch/identity.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T02:30:00.000Z');
const SESSION = 'relaunch-scene';
const LEAD = 'lead';
const SEAT = 'alpha';
const HANDLE = 'seat_0123456789ab';
const RECORDED_SESSION = 'ses_recorded_alpha';
const OLD_PANE = 'pane-recorded';
const OLD_WS = 'ws-recorded';
const NEW_PANE = 'pane-replacement';
const NEW_WS = 'ws-replacement';
const SIBLING_PANE = 'pane-sibling';
const RECORDED_PIDS = { shell: 110, cli: [210] };

const CLAUDE_SONNET_IDLE = CLAUDE_IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5');
const CLAUDE_WORKING = readFileSync(
  new URL('./fixtures/claude-code/2.1.289/unsent-typing-while-running-ansi.txt', import.meta.url),
  'utf8',
);
const CLAUDE_UNSENT = claudeBox('draft line in composer');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  });
}

function teamYaml(): string {
  return `format: 1
project: relaunch-check
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
    human: true
  - role: implementer
    name: ${SEAT}
    label: ${SEAT}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
}

function writeApprovedTeam(): void {
  const text = teamYaml();
  const file = join(dir, 'team.yaml');
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function seedRecordedSeat(overrides: Partial<SeatState> = {}): void {
  const held: SeatState = {
    stage: 'ready',
    id: HANDLE,
    pane: OLD_PANE,
    workspace: OLD_WS,
    launched: RECORDED_PIDS,
    agent_session: RECORDED_SESSION,
    model: 'Claude Sonnet',
    version: '5.5',
    launch_line: 'claude --model claude-sonnet-5-5',
    ...overrides,
  };
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = held;
    session.watch = {
      pane: 'inert-watch-pane',
      workspace: 'inert-watch-space',
      heartbeat: NOW.toISOString(),
    };
    const briefs = (session.briefs ??= {});
    briefs[SEAT] = {
      id: 'f585249b-0b8d-5e71-8b15-a8e02fb2daab',
      at: NOW.toISOString(),
      incarnation: 'inc_3e8192954404',
      epoch: 'run_af2e68cbfbd7',
      sha256: GENERAL_BRIEF_SHA256,
      attempt: 0,
      stage: 'ready',
      pane: held.pane ?? OLD_PANE,
      pane_root_pid: held.launched?.shell ?? RECORDED_PIDS.shell,
    };
  });
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-sonnet-5-5',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: held.pane ?? OLD_PANE,
      address: null,
      agent_session: RECORDED_SESSION,
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

function seatStateOf(seat = SEAT): SeatState | undefined {
  return readState(dir).sessions[SESSION]?.seats[seat];
}

function resumeArgFrom(command: string): string | null {
  return /(?:--resume|--session-id)(?:=|\s+)['"]?([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(command)?.[1] ?? null;
}

type SyntheticPane = {
  workspace: string;
  name: string | null;
  agent: string | null;
  status: string;
  screen: string;
  session: string | null;
  process: PaneProcesses | null;
  foregroundNames?: string[] | null;
};

type SyntheticTrace = {
  created: { label: string; pane: string; workspace: string }[];
  closed: string[];
  runs: { pane: string; command: string }[];
  typed: { pane: string; text: string }[];
  enters: string[];
  keys: { pane: string; key: string }[];
  renamed: { pane: string; name: string }[];
  events: string[];
  stateAtClose: { workspace: string; stage?: string; pane?: string; seatWorkspace?: string }[];
};

type WorldConfig = {
  oldPane?: Partial<SyntheticPane> | null;
  extraPanes?: Record<string, Partial<SyntheticPane>>;
  /** Hook invoked immediately before `workspacePanes` / `processInfo` inside `launch` or `close-leftover`. */
  onBeforePaneRun?: (pane: string, command: string, panes: Map<string, SyntheticPane>) => boolean | void;
  /** Override screen placed on `NEW_PANE` when `paneRun` executes there. */
  replacementScreenAfterRun?: string;
  /** Whether `createWorkspace` succeeds (`true` by default). */
  createWorkspaceOk?: boolean;
  /** Whether `renameAgent` succeeds (`true` by default). */
  renameAgentOk?: boolean;
  /** Whether `closeWorkspace` succeeds (`true` by default). */
  closeWorkspaceOk?: boolean;
  /** Optional override for `workspacePanes`. */
  workspacePanesOverride?: (workspace: string, defaultPanes: string[]) => string[] | null;
};

function makeSyntheticWorld(config: WorldConfig = {}): {
  sources: UpSources;
  addSources: AddSources;
  trace: SyntheticTrace;
  panes: Map<string, SyntheticPane>;
} {
  const trace: SyntheticTrace = {
    created: [],
    closed: [],
    runs: [],
    typed: [],
    enters: [],
    keys: [],
    renamed: [],
    events: [],
    stateAtClose: [],
  };
  const panes = new Map<string, SyntheticPane>();
  const workspaces = new Map<string, string>([[OLD_WS, SEAT]]);

  if (config.oldPane !== null) {
    panes.set(OLD_PANE, {
      workspace: OLD_WS,
      name: null,
      agent: 'claude',
      status: 'idle',
      screen: '',
      session: null,
      process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] },
      ...config.oldPane,
    });
  }
  for (const [id, spec] of Object.entries(config.extraPanes ?? {})) {
    const ws = spec.workspace ?? OLD_WS;
    if (!workspaces.has(ws)) workspaces.set(ws, ws);
    panes.set(id, {
      workspace: ws,
      name: null,
      agent: 'claude',
      status: 'idle',
      screen: '',
      session: null,
      process: { shell: 300, foreground: [300] },
      ...spec,
    });
  }

  const agents = (): HerdrAgent[] =>
    [...panes.entries()]
      .filter(([, p]) => p.name !== null)
      .map(([id, p]) => ({
        name: p.name,
        agent: p.agent,
        pane: id,
        workspace: p.workspace,
        status: p.status,
        cwd: root,
        ...(p.session === null ? {} : { session: p.session }),
      }));

  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.events.push(`create:${NEW_WS}`);
      if (config.createWorkspaceOk === false) return null;
      trace.created.push({ label, pane: NEW_PANE, workspace: NEW_WS });
      workspaces.set(NEW_WS, label);
      panes.set(NEW_PANE, {
        workspace: NEW_WS,
        name: null,
        agent: 'claude',
        status: 'idle',
        screen: '',
        session: null,
        process: { shell: 500, foreground: [500] },
      });
      return { pane: NEW_PANE, workspace: NEW_WS };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      trace.events.push(`run:${pane}`);
      if (config.onBeforePaneRun) {
        const verdict = config.onBeforePaneRun(pane, command, panes);
        if (verdict === false) return false;
      }
      const target = panes.get(pane);
      if (!target) return false;
      target.screen =
        pane === NEW_PANE && config.replacementScreenAfterRun !== undefined
          ? config.replacementScreenAfterRun
          : CLAUDE_SONNET_IDLE;
      target.session = resumeArgFrom(command);
      target.status = 'idle';
      target.process = {
        shell: target.process?.shell ?? 500,
        foreground: [900 + trace.runs.length],
      };
      return true;
    },
    typeText(_session, pane, text) {
      trace.typed.push({ pane, text });
      trace.events.push(`type:${pane}`);
      return true;
    },
    pressEnter(_session, pane) {
      trace.enters.push(pane);
      trace.events.push(`enter:${pane}`);
      return true;
    },
    sendKey(_session, pane, key) {
      trace.keys.push({ pane, key });
      trace.events.push(`key:${pane}:${key}`);
      return true;
    },
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      trace.events.push(`rename:${pane}:${name}`);
      if (config.renameAgentOk === false) return false;
      const target = panes.get(pane);
      if (!target) return false;
      target.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      const snap = seatStateOf();
      trace.stateAtClose.push({
        workspace,
        stage: snap?.stage,
        pane: snap?.pane,
        seatWorkspace: snap?.workspace,
      });
      trace.events.push(`close:${workspace}`);
      if (config.closeWorkspaceOk === false) return false;
      trace.closed.push(workspace);
      workspaces.delete(workspace);
      for (const [id, p] of panes) {
        if (p.workspace === workspace) panes.delete(id);
      }
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents,
    workspacePanes: (_session, workspace) => {
      const defaultPanes = [...panes.entries()]
        .filter(([, p]) => p.workspace === workspace)
        .map(([id]) => id);
      return config.workspacePanesOverride
        ? config.workspacePanesOverride(workspace, defaultPanes)
        : defaultPanes;
    },
    paneText: (_session, pane) => panes.get(pane)?.screen ?? null,
    agentStatus: (_session, pane) => panes.get(pane)?.status ?? null,
    foreground: (_session, pane) => {
      const target = panes.get(pane);
      if (!target || target.process === null) return null;
      if (target.foregroundNames !== undefined) return target.foregroundNames;
      if (paneHoldsOnlyShell(target.process)) return ['shell'];
      return target.process.foreground.map(() => 'claude');
    },
    shellBack: (_session, pane) => {
      const target = panes.get(pane);
      if (!target || target.process === null) return null;
      return paneHoldsOnlyShell(target.process);
    },
    processInfo: (_session, pane) => panes.get(pane)?.process ?? null,
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.289',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };

  const sources: UpSources = {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents,
    workspaces: () => [...workspaces.entries()].map(([id, label]) => ({ id, label })),
    home,
    doctor,
    launch,
    now: () => NOW,
    sleep: async () => {},
  };

  const addSources: AddSources = {
    home,
    sessionState: () => 'running',
    agents,
    workspaces: () => [...workspaces.entries()].map(([id, label]) => ({ id, label })),
    doctor,
    launch,
    now: () => NOW,
  };

  return { sources, addSources, trace, panes };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-own-ws-ind-')));
  root = join(base, 'repo');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'synthetic\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'initial');
  writeApprovedTeam();
});

afterEach(() => {
  discardFixtures([base], { roots: [tmpdir()] });
});

describe('1. paneHoldsOnlyShell and restored pane at its shell relaunched in place', () => {
  test('paneHoldsOnlyShell accepts only a non-empty foreground where every pid is the shell pid', () => {
    expect(paneHoldsOnlyShell(null)).toBe(false);
    expect(paneHoldsOnlyShell(undefined)).toBe(false);
    expect(paneHoldsOnlyShell({ shell: 100, foreground: [] })).toBe(false);
    expect(paneHoldsOnlyShell({ shell: 100, foreground: [100] })).toBe(true);
    expect(paneHoldsOnlyShell({ shell: 100, foreground: [100, 100] })).toBe(true);
    // Stricter than paneHoldsShell: a pane listing [shell, cli] holds a program beside the shell.
    expect(paneHoldsShell({ shell: 100, foreground: [100, 200] })).toBe(true);
    expect(paneHoldsOnlyShell({ shell: 100, foreground: [100, 200] })).toBe(false);
    expect(paneHoldsOnlyShell({ shell: 100, foreground: [200] })).toBe(false);
  });

  test('team up relaunches a restored pane at its shell in place without creating or closing any workspace', async () => {
    seedRecordedSeat();
    // Restored shell has a new shell PID (or original shell PID) with only the shell in foreground.
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: { shell: 199, foreground: [199] },
      },
    });

    // Dry-run plans `pane run pane-recorded` with no `workspace create` and no `workspace close`.
    const dryIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run'], dryIo, world.sources)).toBe(0);
    expect(dryIo.out).toContain(`pane run ${OLD_PANE}`);
    expect(dryIo.out).toContain(`--resume ${RECORDED_SESSION}`);
    expect(dryIo.out).not.toContain(`herdr --session ${SESSION} workspace create`);
    expect(dryIo.out).not.toContain(`herdr --session ${SESSION} workspace close`);
    expect(world.trace.runs).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);

    // Live run launches in OLD_PANE, renames OLD_PANE, creates nothing and closes nothing.
    const liveIo = testIo(root, { kind: 'owner' });
    expect(await runUp([], liveIo, world.sources), `${liveIo.out}\n${liveIo.err}`).toBe(0);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.runs).toHaveLength(1);
    expect(world.trace.runs[0]?.pane).toBe(OLD_PANE);
    expect(world.trace.runs[0]?.command).toContain(`--resume ${RECORDED_SESSION}`);
    expect(world.trace.renamed).toEqual([{ pane: OLD_PANE, name: SEAT }]);
    expect(`${liveIo.out}${liveIo.err}`).toContain(
      `its recorded pane ${OLD_PANE} was at its shell; launched in the same pane`,
    );

    const held = seatStateOf();
    expect(held?.stage).toBe('ready');
    expect(held?.pane).toBe(OLD_PANE);
    expect(held?.workspace).toBe(OLD_WS);
    expect(held?.launched).toEqual({ shell: 199, cli: [901] });
    expect(held?.agent_session).toBe(RECORDED_SESSION);
  });

  test('team add also reuses the recorded pane in place when it is back at its shell', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] },
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runAdd([SEAT], io, world.addSources), `${io.out}\n${io.err}`).toBe(0);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.runs).toHaveLength(1);
    expect(world.trace.runs[0]?.pane).toBe(OLD_PANE);
    expect(seatStateOf()?.pane).toBe(OLD_PANE);
    expect(seatStateOf()?.workspace).toBe(OLD_WS);
  });
});

describe('2. a pane holding a live CLI or an unsent line is never typed into', () => {
  test('never types into or runs in a pane holding an unsent line, a working screen, or an unverified live CLI at plan time', async () => {
    seedRecordedSeat();

    // Scene A: pane holds a replaced CLI process with unsent text in its input box.
    const unsentWorld = makeSyntheticWorld({
      oldPane: {
        name: SEAT,
        process: { shell: 310, foreground: [410] },
        screen: CLAUDE_UNSENT,
        session: 'ses_different',
      },
    });
    const ioUnsent = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioUnsent, unsentWorld.sources)).toBe(1);
    expect(ioUnsent.out).toContain(
      `${SEAT}: left out: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${SEAT})\n`,
    );
    expect(unsentWorld.trace.runs).toEqual([]);
    expect(unsentWorld.trace.typed).toEqual([]);
    expect(unsentWorld.trace.enters).toEqual([]);
    expect(unsentWorld.trace.keys).toEqual([]);
    expect(unsentWorld.trace.created).toEqual([]);
    expect(unsentWorld.trace.closed).toEqual([]);

    // Scene B: pane holds a replaced CLI process with a working screen (counted as working skip, never typed into or closed).
    const workingWorld = makeSyntheticWorld({
      oldPane: {
        name: SEAT,
        process: { shell: 310, foreground: [410] },
        screen: CLAUDE_WORKING,
        status: 'working',
        session: 'ses_different',
      },
    });
    const ioWorking = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioWorking, workingWorld.sources)).toBe(0);
    expect(ioWorking.out).toContain(`${SEAT}: ready\n`);
    expect(ioWorking.err).toContain(
      `the process in its pane is working; nothing closed (stop it there, or run team remove ${SEAT})\n`,
    );
    expect(ioWorking.err).toContain('0 seats repaired, 1 skipped (working), 0 refused\n');
    expect(workingWorld.trace.runs).toEqual([]);
    expect(workingWorld.trace.typed).toEqual([]);
    expect(workingWorld.trace.enters).toEqual([]);
    expect(workingWorld.trace.keys).toEqual([]);
    expect(workingWorld.trace.created).toEqual([]);
    expect(workingWorld.trace.closed).toEqual([]);

    // Scene C: pane holds a live CLI on another conversation at an idle prompt.
    const liveCliWorld = makeSyntheticWorld({
      oldPane: {
        name: SEAT,
        process: { shell: 310, foreground: [410] },
        screen: CLAUDE_SONNET_IDLE,
        session: 'ses_foreign_live',
      },
    });
    const ioLiveCli = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioLiveCli, liveCliWorld.sources)).toBe(1);
    expect(ioLiveCli.out).toContain(`${SEAT}: left out:`);
    expect(liveCliWorld.trace.runs).toEqual([]);
    expect(liveCliWorld.trace.typed).toEqual([]);
    expect(liveCliWorld.trace.enters).toEqual([]);
    expect(liveCliWorld.trace.keys).toEqual([]);
    expect(liveCliWorld.trace.created).toEqual([]);
    expect(liveCliWorld.trace.closed).toEqual([]);
  });

  test('execute re-reads the pane before a planned in-place reuse and refuses without typing if a CLI started in it', async () => {
    seedRecordedSeat();
    // Plan-time reads (buildPlan runs twice before executePlan) see shell-only (`gone`),
    // then before execute's `launch` step runs, a live foreign CLI process ([777]) is in foreground.
    let processReads = 0;
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] },
      },
    });
    const baseProcessInfo = world.sources.launch!.processInfo!;
    world.sources.launch!.processInfo = (session, pane) => {
      processReads += 1;
      if (pane === OLD_PANE && processReads >= 2) {
        return { shell: RECORDED_PIDS.shell, foreground: [777] };
      }
      return baseProcessInfo(session, pane);
    };

    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources)).toBe(1);
    expect(io.out).toContain(
      `${SEAT}: left out: the process in its pane is not the one team launched; nothing launched, nothing closed\n`,
    );
    expect(world.trace.runs).toEqual([]);
    expect(world.trace.typed).toEqual([]);
    expect(world.trace.enters).toEqual([]);
    expect(world.trace.keys).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
    expect(seatStateOf()?.launched).toEqual(RECORDED_PIDS);
  });

  test('execute leaves the pane untouched and exits 0 if the recorded CLI process itself reappears before reuse', async () => {
    seedRecordedSeat();
    let processReads = 0;
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] },
      },
    });
    const baseProcessInfo = world.sources.launch!.processInfo!;
    world.sources.launch!.processInfo = (session, pane) => {
      processReads += 1;
      if (pane === OLD_PANE && processReads >= 2) {
        return { shell: RECORDED_PIDS.shell, foreground: RECORDED_PIDS.cli };
      }
      return baseProcessInfo(session, pane);
    };

    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources)).toBe(0);
    expect(io.out).toContain(`${SEAT}: left out: its pane is the seat's again; left as it is\n`);
    expect(world.trace.runs).toEqual([]);
    expect(world.trace.typed).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
  });
});

describe('3. a missing pane is replaced and the old workspace is closed only after the replacement is ready', () => {
  test('creates replacement workspace, launches and reaches ready on replacement pane, and only then closes the old workspace', async () => {
    seedRecordedSeat();
    // Recorded pane has no process (`process: null`), while OLD_WS is still listed by the host.
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: null,
      },
    });

    // Dry-run shows `workspace create`, `pane run`, `agent rename`, and finally `workspace close ws-recorded`.
    const dryIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run'], dryIo, world.sources)).toBe(0);
    const createPos = dryIo.out.indexOf('workspace create');
    const renamePos = dryIo.out.indexOf('agent rename ');
    const closePos = dryIo.out.indexOf(`workspace close ${OLD_WS}`);
    expect(createPos).toBeGreaterThanOrEqual(0);
    expect(renamePos).toBeGreaterThan(createPos);
    expect(closePos).toBeGreaterThan(renamePos);
    expect(world.trace.closed).toEqual([]);

    // The plan saw no process. The close reads the pane again, and only a bare shell is closed.
    const readProcess = world.sources.launch!.processInfo!;
    let oldReads = 0;
    world.sources.launch!.processInfo = (session, pane) => {
      if (pane !== OLD_PANE) return readProcess(session, pane);
      oldReads += 1;
      return oldReads === 1
        ? null
        : { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] };
    };

    // A fresh pane is launched before it is named: a name on a pane with no agent is refused,
    // and the rename step owns naming. The old workspace closes only after the replacement is ready.
    const liveIo = testIo(root, { kind: 'owner' });
    expect(await runUp([], liveIo, world.sources), `${liveIo.out}\n${liveIo.err}`).toBe(0);

    expect(world.trace.events).toEqual([
      `create:${NEW_WS}`,
      `run:${NEW_PANE}`,
      `rename:${NEW_PANE}:${SEAT}`,
      `close:${OLD_WS}`,
    ]);
    expect(world.trace.closed).toEqual([OLD_WS]);
    expect(world.trace.stateAtClose).toEqual([
      {
        workspace: OLD_WS,
        stage: 'ready',
        pane: NEW_PANE,
        seatWorkspace: NEW_WS,
      },
    ]);
    expect(world.trace.runs).toHaveLength(1);
    expect(world.trace.runs[0]?.pane).toBe(NEW_PANE);
    expect(world.trace.runs[0]?.command).toContain(`--resume ${RECORDED_SESSION}`);
    expect(`${liveIo.out}${liveIo.err}`).toContain(`${SEAT}: its recorded workspace ${OLD_WS} was closed\n`);

    const held = seatStateOf();
    expect(held?.stage).toBe('ready');
    expect(held?.pane).toBe(NEW_PANE);
    expect(held?.workspace).toBe(NEW_WS);
    expect(held?.agent_session).toBe(RECORDED_SESSION);
  });
});

describe('4. a failed replacement closes nothing', () => {
  test('closes nothing when workspace creation fails', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      createWorkspaceOk: false,
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources)).toBe(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(world.trace.runs).toEqual([]);
  });

  test('closes nothing when paneRun on the replacement pane fails', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      onBeforePaneRun: () => false,
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources)).toBe(1);
    expect(world.trace.created).toHaveLength(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(`${io.out}${io.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} was left as it is; the seat is not ready on a replacement\n`,
    );
  });

  test('closes nothing when the replacement pane stops short of ready at rename', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      renameAgentOk: false,
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources)).toBe(1);
    expect(world.trace.created).toHaveLength(1);
    expect(world.trace.runs).toHaveLength(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(seatStateOf()?.stage).toBe('launched');
    expect(`${io.out}${io.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} was left as it is; the seat is not ready on a replacement\n`,
    );
  });
});

describe('5. a workspace with any other pane (or a live process / unsent line in the old pane) is never closed', () => {
  test('never closes the recorded workspace when another pane sits beside the missing pane', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      extraPanes: {
        [SIBLING_PANE]: {
          workspace: OLD_WS,
          name: null,
          process: { shell: 333, foreground: [333] },
        },
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources), `${io.out}\n${io.err}`).toBe(0);

    // The seat is ready on its replacement, and the old workspace was left intact because of SIBLING_PANE.
    expect(world.trace.created).toHaveLength(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(seatStateOf()?.stage).toBe('ready');
    expect(seatStateOf()?.pane).toBe(NEW_PANE);
    expect(seatStateOf()?.workspace).toBe(NEW_WS);
    expect(`${io.out}${io.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} holds other panes; left as it is\n`,
    );
  });

  test('never closes the recorded workspace when a second pane or a process or unsent text appears in the old workspace before close-leftover', async () => {
    // Subcase A: a non-shell process appears in OLD_PANE while the replacement is launching.
    seedRecordedSeat();
    const worldWithProc = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      onBeforePaneRun: (_pane, _cmd, panes) => {
        const old = panes.get(OLD_PANE);
        if (old) old.process = { shell: 110, foreground: [110, 888] };
      },
    });
    const ioProc = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioProc, worldWithProc.sources)).toBe(0);
    expect(worldWithProc.trace.closed).toEqual([]);
    expect(`${ioProc.out}${ioProc.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} holds a process in its old pane; left as it is\n`,
    );

    // Subcase B: unsent text appears on OLD_PANE while the replacement is launching.
    seedRecordedSeat();
    const worldWithUnsent = makeSyntheticWorld({
      oldPane: { name: null, process: null },
      onBeforePaneRun: (_pane, _cmd, panes) => {
        const old = panes.get(OLD_PANE);
        if (old) {
          old.process = { shell: 110, foreground: [110] };
          old.screen = CLAUDE_UNSENT;
        }
      },
    });
    const ioUnsent = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioUnsent, worldWithUnsent.sources)).toBe(0);
    expect(worldWithUnsent.trace.closed).toEqual([]);
    expect(`${ioUnsent.out}${ioUnsent.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} holds unsent text; left as it is\n`,
    );
  });
});

describe('6. a shell beside another pid, an unreadable pane, and a pane named for another seat', () => {
  test('a shell plus another pid is never typed into', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: {
        name: null,
        process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell, 900] },
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources), `${io.out}\n${io.err}`).toBe(1);
    expect(world.trace.runs).toEqual([]);
    expect(world.trace.typed).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
    expect(seatStateOf()).toMatchObject({ stage: 'ready', pane: OLD_PANE, launched: RECORDED_PIDS });
    expect(`${io.out}${io.err}`).toContain(
      'the process in its pane is not the one team launched; nothing launched, nothing closed',
    );
  });

  test('an unreadable pane is never closed', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources), `${io.out}\n${io.err}`).toBe(0);
    expect(world.trace.created).toHaveLength(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(seatStateOf()).toMatchObject({ stage: 'ready', pane: NEW_PANE, workspace: NEW_WS });
    expect(`${io.out}${io.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} holds a pane that could not be read; left as it is\n`,
    );
  });

  test('a pane the host names for another seat is not typed into', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: {
        name: 'fixture-other-seat',
        process: { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] },
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources), `${io.out}\n${io.err}`).toBe(1);
    expect(world.trace.runs).toEqual([]);
    expect(world.trace.typed).toEqual([]);
    expect(world.trace.created).toEqual([]);
    expect(world.trace.closed).toEqual([]);
    expect(seatStateOf()).toMatchObject({ stage: 'ready', pane: OLD_PANE, launched: RECORDED_PIDS });
    expect(`${io.out}${io.err}`).toContain(
      'its pane is named for another seat; nothing launched, nothing closed',
    );
  });

  test('a pane the host names for another seat is never closed', async () => {
    seedRecordedSeat();
    const world = makeSyntheticWorld({
      oldPane: { name: null, process: null },
    });
    const readProcess = world.sources.launch!.processInfo!;
    let oldReads = 0;
    world.sources.launch!.processInfo = (session, pane) => {
      if (pane !== OLD_PANE) return readProcess(session, pane);
      oldReads += 1;
      return oldReads === 1
        ? null
        : { shell: RECORDED_PIDS.shell, foreground: [RECORDED_PIDS.shell] };
    };
    const listed = world.sources.launch!.agents!;
    world.sources.launch!.agents = (session) => {
      const agents = listed(session) ?? [];
      if (world.trace.created.length === 0) return agents;
      return [
        ...agents,
        {
          name: 'fixture-other-seat',
          agent: 'claude',
          pane: OLD_PANE,
          workspace: OLD_WS,
          status: 'idle',
          cwd: root,
        },
      ];
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, world.sources), `${io.out}\n${io.err}`).toBe(0);
    expect(world.trace.created).toHaveLength(1);
    expect(world.trace.closed).toEqual([]);
    expect(world.trace.stateAtClose).toEqual([]);
    expect(seatStateOf()).toMatchObject({ stage: 'ready', pane: NEW_PANE, workspace: NEW_WS });
    expect(`${io.out}${io.err}`).toContain(
      `${SEAT}: its recorded workspace ${OLD_WS} holds a pane named for another seat; left as it is\n`,
    );
  });
});

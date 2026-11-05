// Independent verification of power-loss restore adoption (src/launch/restore-proof.ts,
// src/commands/up.ts, src/launch/plan.ts, src/launch/execute.ts).
//
// All terminal host readings, process tables, screens and filesystem roots are synthetic;
// no live terminal host, CLI or process signal is ever invoked.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { GENERAL_BRIEF_SHA256 } from '../src/launch/general-brief.ts';
import { relaunchWithOwnLine, restoreProof, type RestoreProofInput } from '../src/launch/restore-proof.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T01:30:00.000Z');
const SESSION = 'restore-scene';
const SEAT_ALPHA = 'alpha';
const SEAT_BETA = 'beta';
const PANE_ALPHA = 'pane-alpha';
const PANE_BETA = 'pane-beta';
const WS_ALPHA = 'ws-alpha';
const WS_BETA = 'ws-beta';
const SESSION_ALPHA = 'ses_alpha_recorded';
const SESSION_BETA = 'ses_beta_recorded';

const LAUNCHED_ALPHA = { shell: 1100, cli: [1200] };
const RESTORED_ALPHA: PaneProcesses = { shell: 2100, foreground: [2200] };
const LAUNCHED_BETA = { shell: 1300, cli: [1400] };
const RESTORED_BETA: PaneProcesses = { shell: 2300, foreground: [2400] };

const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replaceAll('gpt-5.6-terra', 'gpt-6.1-sol')
  .replaceAll('GPT-5.6-Terra', 'GPT-6.1-Sol');
const CODEX_WORKING = readFileSync(new URL('./fixtures/codex/0.161.0/working.txt', import.meta.url), 'utf8');
const CODEX_UNSENT = readFileSync(new URL('./fixtures/codex/0.161.0/unsent.txt', import.meta.url), 'utf8');

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

function teamYaml(twoSeats = false): string {
  const second = twoSeats
    ? `  - role: implementer
    name: ${SEAT_BETA}
    label: ${SEAT_BETA}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`
    : '';
  return `format: 1
project: restore-check
coordinator: ${SEAT_ALPHA}
operator: ${SEAT_ALPHA}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT_ALPHA}
    label: ${SEAT_ALPHA}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
${second}`;
}

function writeApprovedTeam(twoSeats = false): void {
  const text = teamYaml(twoSeats);
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

function seedSeatRecord(
  seat: string,
  pane: string,
  workspace: string,
  launched: { shell: number; cli: number[] },
  options: {
    stage?: SeatState['stage'];
    stateSession?: string;
    registrySession?: string | null;
    handle?: string;
    role?: string;
  } = {},
): string {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.watch = {
      pane: 'inert-watch-pane',
      workspace: 'inert-watch-space',
      heartbeat: NOW.toISOString(),
    };
    const briefs = (session.briefs ??= {});
    briefs[seat] = {
      id: 'f585249b-0b8d-5e71-8b15-a8e02fb2daab',
      at: NOW.toISOString(),
      incarnation: 'inc_3e8192954404',
      epoch: 'run_af2e68cbfbd7',
      sha256: GENERAL_BRIEF_SHA256,
      attempt: 0,
      stage: 'ready',
      pane,
      pane_root_pid: launched.shell,
    };
    session.seats[seat] = {
      stage: options.stage ?? 'ready',
      pane,
      workspace,
      launched,
      ...(options.stateSession === undefined ? {} : { agent_session: options.stateSession }),
    };
  });
  const agent = registerAgent(home, {
    name: seat,
    signing: { model: 'GPT Sol', version: '6.1', role: options.role ?? 'coordinator' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(root),
      seat,
      session: SESSION,
      pane,
      address: null,
      ...(options.registrySession === null
        ? {}
        : { agent_session: options.registrySession ?? SESSION_ALPHA }),
    },
    seat_handle: options.handle ?? 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return agent.id;
}

type HarnessTrace = {
  created: string[];
  closed: string[];
  typed: string[];
  runs: string[];
  renamed: { pane: string; name: string }[];
  reported: { pane: string; text: string }[];
  workspaceRenamed: { workspace: string; title: string }[];
  registerInboxCalls: string[];
};

type HarnessOptions = {
  agents?: HerdrAgent[] | null | (() => HerdrAgent[] | null);
  foreground?: (pane: string) => string[] | null;
  processInfo?: (pane: string) => PaneProcesses | null;
  paneText?: (pane: string) => string | null;
  workspaces?: { id: string; label: string }[];
  renameOk?: boolean;
  reportDisplayOk?: boolean;
};

function makeHarness(options: HarnessOptions = {}): { sources: UpSources; trace: HarnessTrace } {
  const trace: HarnessTrace = {
    created: [],
    closed: [],
    typed: [],
    runs: [],
    renamed: [],
    reported: [],
    workspaceRenamed: [],
    registerInboxCalls: [],
  };
  const defaultAgents: HerdrAgent[] = [
    {
      name: null,
      agent: 'codex',
      pane: PANE_ALPHA,
      workspace: WS_ALPHA,
      status: 'idle',
      cwd: root,
      session: SESSION_ALPHA,
    },
  ];
  const readAgents = (): HerdrAgent[] | null => {
    if (typeof options.agents === 'function') return options.agents();
    if (options.agents !== undefined) return options.agents;
    return defaultAgents;
  };
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      trace.created.push(label);
      return { pane: `created-${trace.created.length}`, workspace: `ws-created-${trace.created.length}` };
    },
    paneRun(_session, _pane, command) {
      trace.runs.push(command);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameWorkspace(_session, workspace, title) {
      trace.workspaceRenamed.push({ workspace, title });
      return true;
    },
    reportDisplayAgent(_session, pane, text) {
      trace.reported.push({ pane, text });
      return options.reportDisplayOk ?? true;
    },
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      return options.renameOk ?? true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    registerInbox(cli, seat) {
      trace.registerInboxCalls.push(`${seat}:${cli}`);
      return { ok: true, server: 'stub', configPath: '/dev/null' };
    },
    agentPanes: () => {
      const list = readAgents();
      return list ? list.map((item) => item.pane) : [PANE_ALPHA];
    },
    agents: readAgents,
    paneText: (_session, pane) => (options.paneText ? options.paneText(pane) : CODEX_IDLE),
    foreground: (_session, pane) => (options.foreground ? options.foreground(pane) : ['codex']),
    processInfo: (_session, pane) =>
      options.processInfo
        ? options.processInfo(pane)
        : pane === PANE_BETA
          ? RESTORED_BETA
          : RESTORED_ALPHA,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '0.161.0',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: readAgents,
      workspaces: () => options.workspaces ?? [{ id: WS_ALPHA, label: SEAT_ALPHA }],
      home,
      doctor,
      launch,
      now: () => NOW,
    },
    trace,
  };
}

function stateFilePath(): string {
  return join(dir, 'team.state.json');
}

function seatRecordOf(seat = SEAT_ALPHA): SeatState | undefined {
  return readState(dir).sessions[SESSION]?.seats[seat];
}

function assertNoRegisterOrLaunchEffects(trace: HarnessTrace, out: string, err: string): void {
  expect(trace.created).toEqual([]);
  expect(trace.closed).toEqual([]);
  expect(trace.typed).toEqual([]);
  expect(trace.runs).toEqual([]);
  expect(trace.registerInboxCalls).toEqual([]);
  expect(out).not.toContain('team register');
  expect(err).not.toContain('team register');
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-adoption-ind-')));
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
  writeApprovedTeam(false);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('1. direct restoreProof and relaunchWithOwnLine rules', () => {
  function baseProofInput(overrides: Partial<RestoreProofInput> = {}): RestoreProofInput {
    return {
      seat: { name: SEAT_ALPHA, cli: 'codex' },
      recorded: {
        stage: 'ready',
        pane: PANE_ALPHA,
        workspace: WS_ALPHA,
        launched: LAUNCHED_ALPHA,
      },
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: '/tmp/repo',
          session: SESSION_ALPHA,
        },
      ],
      process: RESTORED_ALPHA,
      foreground: ['codex'],
      recordedSession: SESSION_ALPHA,
      screen: CODEX_IDLE,
      ...overrides,
    };
  }

  test('proves by session equality when both sides name the same conversation, even with another pane or working status', () => {
    const proof = restoreProof(
      baseProofInput({
        agents: [
          {
            name: null,
            agent: 'codex',
            pane: PANE_ALPHA,
            workspace: WS_ALPHA,
            status: 'working',
            cwd: '/tmp/repo',
            session: SESSION_ALPHA,
          },
          {
            name: null,
            agent: 'codex',
            pane: 'pane-sibling',
            workspace: WS_ALPHA,
            status: 'idle',
            cwd: '/tmp/repo',
          },
        ],
        screen: CODEX_WORKING,
      }),
    );
    expect(proof).toEqual({
      kind: 'session',
      pane: PANE_ALPHA,
      sentence: 'its conversation is the one the record names',
    });
    expect(relaunchWithOwnLine({ name: SEAT_ALPHA, cli: 'codex' }, baseProofInput().recorded, proof)).toBe(false);
  });

  test('proves by declared CLI alone and idle only when neither side names a session', () => {
    const proof = restoreProof(
      baseProofInput({
        recordedSession: undefined,
        agents: [
          {
            name: null,
            agent: 'codex',
            pane: PANE_ALPHA,
            workspace: WS_ALPHA,
            status: 'idle',
            cwd: '/tmp/repo',
          },
        ],
      }),
    );
    expect(proof).toEqual({
      kind: 'cli',
      pane: PANE_ALPHA,
      sentence: 'its pane runs codex alone in its workspace, at an idle prompt',
    });
    expect(relaunchWithOwnLine({ name: SEAT_ALPHA, cli: 'codex' }, baseProofInput().recorded, proof)).toBe(false);
  });

  test('refuses records that never reached ready or are still waiting, and refuses non-replaced process verdicts', () => {
    expect(
      restoreProof(baseProofInput({ recorded: { stage: 'named', pane: PANE_ALPHA, workspace: WS_ALPHA, launched: LAUNCHED_ALPHA } })),
    ).toEqual({ kind: 'none', why: 'its launch record never reached ready; team never adopts it' });

    expect(
      restoreProof(
        baseProofInput({
          recorded: {
            stage: 'ready',
            pane: PANE_ALPHA,
            workspace: WS_ALPHA,
            launched: LAUNCHED_ALPHA,
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        }),
      ),
    ).toEqual({ kind: 'none', why: 'its launch record never reached ready; team never adopts it' });

    // Same process PIDs -> verdict is 'same', not 'replaced'.
    expect(
      restoreProof(baseProofInput({ process: { shell: LAUNCHED_ALPHA.shell, foreground: LAUNCHED_ALPHA.cli } })),
    ).toEqual({ kind: 'none', why: 'its pane holds no process this proof can re-tie to the launch' });

    // Gone process (shell only, no foreground) -> verdict is 'gone', not 'replaced'.
    expect(
      restoreProof(baseProofInput({ process: { shell: RESTORED_ALPHA.shell, foreground: [] } })),
    ).toEqual({ kind: 'none', why: 'its pane holds no process this proof can re-tie to the launch' });
  });

  test('refuses one-sided sessions, mismatched sessions, wrong CLI, wrong workspace, foreign seat name, and non-idle weak scenes', () => {
    // Recorded session present, live session absent.
    expect(
      restoreProof(
        baseProofInput({
          recordedSession: SESSION_ALPHA,
          agents: [{ name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo' }],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `its pane reports no conversation; the record's launch ran ${SESSION_ALPHA}`,
      specific: true,
    });

    // Recorded session absent, live session present.
    expect(
      restoreProof(
        baseProofInput({
          recordedSession: undefined,
          agents: [
            { name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo', session: 'ses_unexpected' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: "its pane holds a conversation (ses_unexpected) the record's launch never named",
      specific: true,
    });

    // Both sides have sessions, but unequal.
    expect(
      restoreProof(
        baseProofInput({
          recordedSession: SESSION_ALPHA,
          agents: [
            { name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo', session: 'ses_different' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `its pane holds another conversation (ses_different; the record's launch ran ${SESSION_ALPHA})`,
      specific: true,
    });

    // Wrong foreground CLI.
    expect(restoreProof(baseProofInput({ foreground: ['claude'] }))).toEqual({
      kind: 'none',
      why: "its pane runs claude; the seat's launch line runs codex",
      specific: true,
    });

    // Unreadable foreground.
    expect(restoreProof(baseProofInput({ foreground: null }))).toEqual({
      kind: 'none',
      why: "its pane's foreground cannot be read; team cannot tell it is codex",
    });

    // Matching foreground, but host entry agent attribution disagrees.
    expect(
      restoreProof(
        baseProofInput({
          agents: [
            { name: null, agent: 'claude', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo', session: SESSION_ALPHA },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: "its pane's agent says claude; the seat's launch line runs codex",
      specific: true,
    });

    // Pane in another workspace.
    expect(
      restoreProof(
        baseProofInput({
          agents: [
            { name: null, agent: 'codex', pane: PANE_ALPHA, workspace: 'ws-moved', status: 'idle', cwd: '/tmp/repo', session: SESSION_ALPHA },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `its pane is in workspace ws-moved; the record puts it in ${WS_ALPHA}`,
      specific: true,
    });

    // Pane named for another seat.
    expect(
      restoreProof(
        baseProofInput({
          agents: [
            { name: SEAT_BETA, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo', session: SESSION_ALPHA },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `its pane is named ${SEAT_BETA}; team never adopts a pane another seat owns`,
      specific: true,
    });

    // Weak proof: another pane in the same workspace.
    expect(
      restoreProof(
        baseProofInput({
          recordedSession: undefined,
          agents: [
            { name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo' },
            { name: null, agent: 'codex', pane: PANE_BETA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: 'its workspace holds another pane; team cannot tell which one is the seat',
      specific: true,
    });

    // Weak proof: working status or unsent text on screen.
    expect(
      restoreProof(
        baseProofInput({
          recordedSession: undefined,
          agents: [{ name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'working', cwd: '/tmp/repo' }],
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `the process in its pane is working; nothing closed (stop it there, or run team remove ${SEAT_ALPHA})`,
      specific: true,
    });

    expect(
      restoreProof(
        baseProofInput({
          recordedSession: undefined,
          agents: [{ name: null, agent: 'codex', pane: PANE_ALPHA, workspace: WS_ALPHA, status: 'idle', cwd: '/tmp/repo' }],
          screen: CODEX_UNSENT,
        }),
      ),
    ).toEqual({
      kind: 'none',
      why: `the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove ${SEAT_ALPHA})`,
      specific: true,
    });
  });
});

describe('2. names cleared, new pids, same panes and workspaces: strong and weak proofs in runUp', () => {
  test('adopts both a strong session-proven seat and a weak CLI-only seat in one restore pass without calling register', async () => {
    writeApprovedTeam(true);
    const agentAlpha = seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
      handle: 'seat_aaaaaaaaaaaa',
      role: 'coordinator',
    });
    const agentBeta = seedSeatRecord(SEAT_BETA, PANE_BETA, WS_BETA, LAUNCHED_BETA, {
      registrySession: null,
      handle: 'seat_bbbbbbbbbbbb',
      role: 'implementer',
    });
    const stateBeforeDry = readFileSync(stateFilePath(), 'utf8');

    const restoredAgents: HerdrAgent[] = [
      {
        name: null,
        agent: 'codex',
        pane: PANE_ALPHA,
        workspace: WS_ALPHA,
        status: 'idle',
        cwd: root,
        session: SESSION_ALPHA,
      },
      {
        name: null,
        agent: 'codex',
        pane: PANE_BETA,
        workspace: WS_BETA,
        status: 'idle',
        cwd: root,
      },
    ];
    const workspaces = [
      { id: WS_ALPHA, label: SEAT_ALPHA },
      { id: WS_BETA, label: SEAT_BETA },
    ];

    // Dry-run plans the renames and metadata reports, never mutating state or calling register.
    const dryHarness = makeHarness({ agents: restoredAgents, workspaces });
    const dryIo = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run'], dryIo, dryHarness.sources)).toBe(0);
    expect(dryIo.out).toContain(`agent rename ${PANE_ALPHA} ${SEAT_ALPHA}`);
    expect(dryIo.out).toContain(`pane report-metadata ${PANE_ALPHA} --source team --display-agent 'GPT Sol 6.1 default'`);
    expect(dryIo.out).toContain(
      `skip ${SEAT_ALPHA}: restored and re-tied: its conversation is the one the record names; left as it is`,
    );
    expect(dryIo.out).toContain(`agent rename ${PANE_BETA} ${SEAT_BETA}`);
    expect(dryIo.out).toContain(
      `skip ${SEAT_BETA}: restored and re-tied: its pane runs codex alone in its workspace, at an idle prompt; left as it is`,
    );
    expect(dryHarness.trace.renamed).toEqual([]);
    expect(dryHarness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(dryHarness.trace, dryIo.out, dryIo.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(stateBeforeDry);

    // Live run re-ties both seats in place, updates PIDs, preserves panes and workspaces, and writes session only for alpha.
    const liveHarness = makeHarness({ agents: restoredAgents, workspaces });
    const liveIo = testIo(root, { kind: 'owner' });
    expect(await runUp([], liveIo, liveHarness.sources)).toBe(0);
    expect(liveHarness.trace.renamed).toEqual([
      { pane: PANE_ALPHA, name: SEAT_ALPHA },
      { pane: PANE_BETA, name: SEAT_BETA },
    ]);
    expect(liveHarness.trace.reported).toEqual([
      { pane: PANE_ALPHA, text: 'GPT Sol 6.1 default' },
      { pane: PANE_BETA, text: 'GPT Sol 6.1 default' },
    ]);
    assertNoRegisterOrLaunchEffects(liveHarness.trace, liveIo.out, liveIo.err);
    expect(liveIo.err).toContain('restored and re-tied: its conversation is the one the record names');
    expect(liveIo.err).toContain('restored and re-tied: its pane runs codex alone in its workspace, at an idle prompt');
    expect(liveIo.err).toContain('0 seats repaired, 0 skipped (working), 0 refused\n');

    expect(seatRecordOf(SEAT_ALPHA)).toMatchObject({
      stage: 'ready',
      pane: PANE_ALPHA,
      workspace: WS_ALPHA,
      launched: { shell: RESTORED_ALPHA.shell, cli: RESTORED_ALPHA.foreground },
      agent_session: SESSION_ALPHA,
    });
    expect(seatRecordOf(SEAT_BETA)).toMatchObject({
      stage: 'ready',
      pane: PANE_BETA,
      workspace: WS_BETA,
      launched: { shell: RESTORED_BETA.shell, cli: RESTORED_BETA.foreground },
    });
    expect(seatRecordOf(SEAT_BETA)?.agent_session).toBeUndefined();

    // No new agent files were registered in the registry directory.
    const agentFiles = readdirSync(agentsDir(home)).filter((file) => file.endsWith('.yaml')).sort();
    expect(agentFiles).toEqual([`${agentAlpha}.yaml`, `${agentBeta}.yaml`].sort());

    // Follow-up run with names restored and new PIDs recorded is a pure no-op.
    const afterHarness = makeHarness({
      agents: [
        { ...restoredAgents[0]!, name: SEAT_ALPHA },
        { ...restoredAgents[1]!, name: SEAT_BETA },
      ],
      workspaces,
    });
    const afterIo = testIo(root, { kind: 'owner' });
    expect(await runUp([], afterIo, afterHarness.sources)).toBe(0);
    expect(afterHarness.trace.renamed).toEqual([]);
    assertNoRegisterOrLaunchEffects(afterHarness.trace, afterIo.out, afterIo.err);
  });

  test('strong session proof adopts even when another unnamed pane shares the recorded workspace', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      stateSession: SESSION_ALPHA,
      registrySession: SESSION_ALPHA,
    });
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
          session: SESSION_ALPHA,
        },
        {
          name: null,
          agent: 'codex',
          pane: 'pane-extra',
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
        },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(0);
    expect(harness.trace.renamed).toEqual([{ pane: PANE_ALPHA, name: SEAT_ALPHA }]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(seatRecordOf(SEAT_ALPHA)?.launched).toEqual({
      shell: RESTORED_ALPHA.shell,
      cli: RESTORED_ALPHA.foreground,
    });
    expect(seatRecordOf(SEAT_ALPHA)?.agent_session).toBe(SESSION_ALPHA);
  });
});

describe('3. refusals preserve the record unchanged and never call register', () => {
  test('refuses a one-sided session when the record names a conversation and the restored pane reports none', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
        },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const why = `its pane reports no conversation; the record's launch ran ${SESSION_ALPHA}`;
    expect(io.out).toContain(`${SEAT_ALPHA}: left out: ${why}\n`);
    expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_ALPHA}: ${why})\n`);
    expect(harness.trace.renamed).toEqual([]);
    expect(harness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
    expect(seatRecordOf(SEAT_ALPHA)?.launched).toEqual(LAUNCHED_ALPHA);
  });

  test('refuses a one-sided session when the record names no conversation and the restored pane reports one', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: null,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
          session: SESSION_BETA,
        },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const why = `its pane holds a conversation (${SESSION_BETA}) the record's launch never named`;
    expect(io.out).toContain(`${SEAT_ALPHA}: left out: ${why}\n`);
    expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_ALPHA}: ${why})\n`);
    expect(harness.trace.renamed).toEqual([]);
    expect(harness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
    expect(seatRecordOf(SEAT_ALPHA)?.launched).toEqual(LAUNCHED_ALPHA);
    expect(seatRecordOf(SEAT_ALPHA)?.agent_session).toBeUndefined();
  });

  test('refuses a weak CLI-only proof when another pane shares the recorded workspace', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: null,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
        },
        {
          name: null,
          agent: 'codex',
          pane: 'pane-second',
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
        },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const why = 'its workspace holds another pane; team cannot tell which one is the seat';
    expect(io.out).toContain(`${SEAT_ALPHA}: left out: ${why}\n`);
    expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_ALPHA}: ${why})\n`);
    expect(harness.trace.renamed).toEqual([]);
    expect(harness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
  });

  test('refuses the wrong declared CLI on both strong and weak paths without touching the record', async () => {
    // 1. Strong path with matching session id, but foreground runs claude instead of codex.
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
    });
    const beforeStrong = readFileSync(stateFilePath(), 'utf8');
    const strongWrongCli = makeHarness({
      foreground: () => ['claude'],
    });
    const ioStrong = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioStrong, strongWrongCli.sources)).toBe(1);

    const whyForeground = "its pane runs claude; the seat's launch line runs codex";
    expect(ioStrong.out).toContain(`${SEAT_ALPHA}: left out: ${whyForeground}\n`);
    expect(ioStrong.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_ALPHA}: ${whyForeground})\n`);
    expect(strongWrongCli.trace.renamed).toEqual([]);
    expect(strongWrongCli.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(strongWrongCli.trace, ioStrong.out, ioStrong.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeStrong);

    // 2. Weak path with no session id, foreground matches codex, but host entry agent attribution says claude.
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: null,
    });
    const beforeWeak = readFileSync(stateFilePath(), 'utf8');
    const weakWrongAgent = makeHarness({
      agents: [
        {
          name: null,
          agent: 'claude',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
        },
      ],
    });
    const ioWeak = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioWeak, weakWrongAgent.sources)).toBe(1);

    const whyAgent = "its pane's agent says claude; the seat's launch line runs codex";
    expect(ioWeak.out).toContain(`${SEAT_ALPHA}: left out: ${whyAgent}\n`);
    expect(weakWrongAgent.trace.renamed).toEqual([]);
    expect(weakWrongAgent.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(weakWrongAgent.trace, ioWeak.out, ioWeak.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeWeak);
  });

  test('refuses a pane in another workspace without touching the record', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: 'ws-relocated',
          status: 'idle',
          cwd: root,
          session: SESSION_ALPHA,
        },
      ],
      workspaces: [
        { id: WS_ALPHA, label: SEAT_ALPHA },
        { id: 'ws-relocated', label: 'relocated' },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const why = `its pane is in workspace ws-relocated; the record puts it in ${WS_ALPHA}`;
    expect(io.out).toContain(`${SEAT_ALPHA}: left out: ${why}\n`);
    expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_ALPHA}: ${why})\n`);
    expect(harness.trace.renamed).toEqual([]);
    expect(harness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
    expect(seatRecordOf(SEAT_ALPHA)).toEqual({
      stage: 'ready',
      pane: PANE_ALPHA,
      workspace: WS_ALPHA,
      launched: LAUNCHED_ALPHA,
    });
  });

  test('execute re-runs restoreProof against the launch identity and refuses without writing when the pane changes before adopt or rename fails', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');

    // Scene A: plan sees SESSION_ALPHA, but by the time execute's adopt step re-reads agents, the pane holds ses_intruder.
    let agentReads = 0;
    const changingHarness = makeHarness({
      agents: () => {
        agentReads += 1;
        return [
          {
            name: null,
            agent: 'codex',
            pane: PANE_ALPHA,
            workspace: WS_ALPHA,
            status: 'idle',
            cwd: root,
            session: agentReads === 1 ? SESSION_ALPHA : 'ses_intruder',
          },
        ];
      },
    });
    const ioChanged = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioChanged, changingHarness.sources)).toBe(1);
    const whyChanged = `its pane holds another conversation (ses_intruder; the record's launch ran ${SESSION_ALPHA})`;
    expect(ioChanged.out).toContain(`${SEAT_ALPHA}: left out: ${whyChanged}\n`);
    expect(changingHarness.trace.renamed).toEqual([]);
    expect(changingHarness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(changingHarness.trace, ioChanged.out, ioChanged.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);

    // Scene B: proof holds at execute time, but host.renameAgent fails -> nothing written to the state record.
    const failedRenameHarness = makeHarness({ renameOk: false });
    const ioRenameFail = testIo(root, { kind: 'owner' });
    expect(await runUp([], ioRenameFail, failedRenameHarness.sources)).toBe(1);
    const whyRename = 'its pane was not named; left as the host restored it';
    expect(ioRenameFail.out).toContain(`${SEAT_ALPHA}: left out: ${whyRename}\n`);
    expect(failedRenameHarness.trace.renamed).toEqual([{ pane: PANE_ALPHA, name: SEAT_ALPHA }]);
    expect(failedRenameHarness.trace.reported).toEqual([]);
    assertNoRegisterOrLaunchEffects(failedRenameHarness.trace, ioRenameFail.out, ioRenameFail.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
  });

  test('mixed two-seat restore adopts the proven seat and leaves the refused seat untouched in the same pass', async () => {
    writeApprovedTeam(true);
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      registrySession: SESSION_ALPHA,
      handle: 'seat_aaaaaaaaaaaa',
      role: 'coordinator',
    });
    seedSeatRecord(SEAT_BETA, PANE_BETA, WS_BETA, LAUNCHED_BETA, {
      registrySession: SESSION_BETA,
      handle: 'seat_bbbbbbbbbbbb',
      role: 'implementer',
    });

    // Alpha matches its recorded session; Beta reports no session (one-sided refusal).
    const harness = makeHarness({
      agents: [
        {
          name: null,
          agent: 'codex',
          pane: PANE_ALPHA,
          workspace: WS_ALPHA,
          status: 'idle',
          cwd: root,
          session: SESSION_ALPHA,
        },
        {
          name: null,
          agent: 'codex',
          pane: PANE_BETA,
          workspace: WS_BETA,
          status: 'idle',
          cwd: root,
        },
      ],
      workspaces: [
        { id: WS_ALPHA, label: SEAT_ALPHA },
        { id: WS_BETA, label: SEAT_BETA },
      ],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const whyBeta = `its pane reports no conversation; the record's launch ran ${SESSION_BETA}`;
    expect(io.out).toContain(`${SEAT_ALPHA}: ready\n`);
    expect(io.out).toContain(`${SEAT_BETA}: left out: ${whyBeta}\n`);
    expect(io.err).toContain(`0 seats repaired, 0 skipped (working), 1 refused (${SEAT_BETA}: ${whyBeta})\n`);
    expect(harness.trace.renamed).toEqual([{ pane: PANE_ALPHA, name: SEAT_ALPHA }]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);

    // Alpha was adopted and updated; Beta's record is untouched.
    expect(seatRecordOf(SEAT_ALPHA)).toMatchObject({
      stage: 'ready',
      pane: PANE_ALPHA,
      workspace: WS_ALPHA,
      launched: { shell: RESTORED_ALPHA.shell, cli: RESTORED_ALPHA.foreground },
      agent_session: SESSION_ALPHA,
    });
    expect(seatRecordOf(SEAT_BETA)).toEqual({
      stage: 'ready',
      pane: PANE_BETA,
      workspace: WS_BETA,
      launched: LAUNCHED_BETA,
    });
  });

  test('disagreeing state and registry sessions withhold the binding and refuse the live session without writing', async () => {
    seedSeatRecord(SEAT_ALPHA, PANE_ALPHA, WS_ALPHA, LAUNCHED_ALPHA, {
      stateSession: 'ses_stale_state',
      registrySession: SESSION_ALPHA,
    });
    const beforeBytes = readFileSync(stateFilePath(), 'utf8');
    const harness = makeHarness();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, harness.sources)).toBe(1);

    const why = `its pane holds a conversation (${SESSION_ALPHA}) the record's launch never named`;
    expect(io.out).toContain(`${SEAT_ALPHA}: left out: ${why}\n`);
    expect(harness.trace.renamed).toEqual([]);
    assertNoRegisterOrLaunchEffects(harness.trace, io.out, io.err);
    expect(readFileSync(stateFilePath(), 'utf8')).toBe(beforeBytes);
    expect(seatRecordOf(SEAT_ALPHA)?.agent_session).toBe('ses_stale_state');
  });
});

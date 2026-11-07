// Independent verification of feat/c75-check-restore (e087f3d91, stacked on 19acffafa).
//
// Behaviour covered:
// 1. A provable restored seat (by conversation or by declared CLI alone at an idle prompt) reads
//    with state "restored, not launched by team" and repair "team up".
// 2. Each failed-proof reason (another conversation, one-sided conversation, another CLI, another
//    pane in the workspace or another workspace, another name, working/unsent) is stated on the
//    difference with repair "look at the pane".
// 3. A gone pane with a launch record (when the session is running) reads as a CLI that did not
//    come back, with repair "team up".
// 4. A never-launched seat (or a launch record when nothing is running) keeps today's line
//    ("is in the file and is not running").
// 5. Check (runStatus) and up (runUp) agree on the same synthetic world for both provable
//    restores and failed proofs.
//
// Synthetic fixtures only; no live terminal host, process table, or real credential store.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runStatus } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo, recordRenames } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const SESSION = 'acme';
const LEAD_PANE = 'pane-lead';
const LEAD_SPACE = 'space-lead';
const WORKER_PANE = 'pane-worker';
const WORKER_SPACE = 'space-worker';

const IDLE_SCREEN = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function teamYaml(): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: lead
operator: lead
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

function seedState(workerRecord: Record<string, unknown> | null): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = {
      stage: 'ready',
      pane: LEAD_PANE,
      workspace: LEAD_SPACE,
      launched: { shell: 10, cli: [11] },
      agent_session: 'ses_lead',
    } as never;
    if (workerRecord === null) {
      delete session.seats.worker;
    } else {
      session.seats.worker = workerRecord as never;
    }
  });
}

function seedApproval(): void {
  const text = teamYaml();
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

type WorldOptions = {
  worker?: Partial<HerdrAgent> | null;
  extraAgents?: HerdrAgent[];
  workerForeground?: string[] | null;
  workerProcess?: { shell: number; foreground: number[] } | null;
  workerScreen?: string;
  running?: boolean;
};

function makeLive(options: WorldOptions = {}): Live {
  const leadAgent: HerdrAgent = {
    name: 'lead',
    agent: 'claude',
    pane: LEAD_PANE,
    workspace: LEAD_SPACE,
    status: 'idle',
    cwd: root,
    session: 'ses_lead',
  };
  const workerAgent: HerdrAgent | null =
    options.worker === null
      ? null
      : {
          name: null,
          agent: 'codex',
          pane: WORKER_PANE,
          workspace: WORKER_SPACE,
          status: 'idle',
          cwd: root,
          ...(options.worker ?? {}),
        };
  const agents: HerdrAgent[] = [
    leadAgent,
    ...(workerAgent === null ? [] : [workerAgent]),
    ...(options.extraAgents ?? []),
  ];
  return {
    running: options.running ?? true,
    agents,
    workspaces: [
      { id: LEAD_SPACE, label: 'lead' },
      { id: WORKER_SPACE, label: 'worker' },
    ],
    screens: {
      ...(options.workerScreen !== undefined ? { [WORKER_PANE]: options.workerScreen } : {}),
    },
    processes: {
      [LEAD_PANE]: { shell: 10, foreground: [10, 11] },
      ...(workerAgent === null
        ? {}
        : {
            [WORKER_PANE]:
              options.workerProcess === undefined ? { shell: 20, foreground: [21] } : options.workerProcess,
          }),
    },
    foreground: {
      [LEAD_PANE]: ['claude'],
      ...(workerAgent === null
        ? {}
        : {
            [WORKER_PANE]: options.workerForeground === undefined ? ['codex'] : options.workerForeground,
          }),
    },
  };
}

type StatusDoc = {
  rows: Array<{ name: string; state: string; model: string; pane: string }>;
  differences: Array<{ what: string; repair: string; who: string }>;
};

async function checkStatus(live: Live): Promise<{ code: number; doc: StatusDoc }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runStatus(['--json'], io, {
    live: () => live,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  return { code, doc: JSON.parse(io.out) as StatusDoc };
}

function workerDiff(doc: StatusDoc) {
  return doc.differences.find((d) => d.what.startsWith('worker:') || d.what.startsWith('worker '));
}

function workerRow(doc: StatusDoc) {
  return doc.rows.find((r) => r.name === 'worker');
}

function makeUpSourcesFromLive(live: Live): {
  sources: UpSources;
  renamed: Array<{ pane: string; name: string }>;
  created: string[];
  closed: string[];
  typed: string[];
} {
  const renamed: Array<{ pane: string; name: string }> = [];
  const created: string[] = [];
  const closed: string[] = [];
  const typed: string[] = [];

  const launch: Launch = {
    sessionState: () => (live.running ? 'running' : null),
    startServer: () => true,
    sessionUp: () => live.running,
    createWorkspace(_session, _cwd, label) {
      created.push(label);
      return { pane: `created-${created.length}`, workspace: `ws-created-${created.length}` };
    },
    paneRun: () => true,
    typeText(_session, _pane, text) {
      typed.push(text);
      return true;
    },
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    renameAgent(_session, pane, name) {
      renamed.push({ pane, name });
      return true;
    },
    closeWorkspace(_session, ws) {
      closed.push(ws);
      return true;
    },
    agentPanes: () => live.agents.map((a) => a.pane),
    agents: () => live.agents,
    paneText: (_session, pane) => live.screens[pane] ?? IDLE_SCREEN,
    foreground: (_session, pane) => live.foreground?.[pane] ?? null,
    processInfo: (_session, pane) => live.processes?.[pane] ?? null,
    sleep: async () => {},
    now: () => NOW,
  };

  recordRenames(launch);

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => live.running,
    now: () => NOW,
    home,
  };

  return {
    sources: {
      sessionRunning: () => live.running,
      sessionState: () => (live.running ? 'running' : null),
      agents: () => live.agents,
      workspaces: () => live.workspaces,
      home,
      doctor,
      launch,
      now: () => NOW,
    },
    renamed,
    created,
    closed,
    typed,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-check-restore-ind-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], {
    cwd: root,
    env: gitEnv(),
  });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(dir, 'team.yaml'), teamYaml());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('1. a provable restored seat reads with repair team up', () => {
  test('strong proof (matching conversation on the unnamed recorded pane) reads as restored with repair team up', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_worker_1',
    });

    const { code, doc } = await checkStatus(makeLive({ worker: { session: 'ses_worker_1' } }));
    expect(code).toBe(1);
    expect(workerRow(doc)).toMatchObject({
      name: 'worker',
      state: 'restored, not launched by team',
      model: '-',
      pane: WORKER_PANE,
    });
    expect(workerDiff(doc)).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
  });

  test('strong proof via registry agent_session binding also reads with repair team up', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });
    registerAgent(home, {
      name: 'worker',
      signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' },
      lab: 'openai',
      cli: 'codex',
      launcher: null,
      launch: 'codex -m gpt-6.1-sol',
      reach: {
        team: teamIdOf(root),
        seat: 'worker',
        session: SESSION,
        pane: WORKER_PANE,
        address: null,
        agent_session: 'ses_from_registry',
      },
      seat_handle: 'seat_0123456789ab',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });

    const { code, doc } = await checkStatus(makeLive({ worker: { session: 'ses_from_registry' } }));
    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
  });

  test('weak proof (no conversation on either side, declared CLI alone in workspace at idle prompt) reads with repair team up', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });

    const { code, doc } = await checkStatus(makeLive({ workerScreen: IDLE_SCREEN }));
    expect(code).toBe(1);
    expect(workerRow(doc)).toMatchObject({
      name: 'worker',
      state: 'restored, not launched by team',
      model: '-',
      pane: WORKER_PANE,
    });
    expect(workerDiff(doc)).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's declared CLI — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
  });
});

describe('2. each failed-proof reason is stated with repair "look at the pane"', () => {
  test('another conversation (mismatched session id, missing live session id, or unrecorded live session id)', async () => {
    // Both sides have a conversation, but they differ.
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_expected',
    });
    const mismatch = await checkStatus(makeLive({ worker: { session: 'ses_foreign' } }));
    expect(workerRow(mismatch.doc)?.state).toBe('restored, not launched by team');
    expect(workerDiff(mismatch.doc)).toMatchObject({
      what: "worker: its pane holds another conversation (ses_foreign; the record's launch ran ses_expected)",
      repair: 'look at the pane',
    });

    // Recorded conversation, but pane reports none.
    const missingLive = await checkStatus(makeLive({ worker: {} }));
    expect(workerDiff(missingLive.doc)).toMatchObject({
      what: "worker: its pane reports no conversation; the record's launch ran ses_expected",
      repair: 'look at the pane',
    });

    // No recorded conversation, but pane reports one.
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });
    const unexpectedLive = await checkStatus(makeLive({ worker: { session: 'ses_unrecorded' } }));
    expect(workerDiff(unexpectedLive.doc)).toMatchObject({
      what: "worker: its pane holds a conversation (ses_unrecorded) the record's launch never named",
      repair: 'look at the pane',
    });
  });

  test('another CLI (foreground binary or host agent attribution disagrees with the seat CLI)', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_expected',
    });

    // Foreground runs claude instead of codex.
    const wrongFg = await checkStatus(
      makeLive({
        worker: { session: 'ses_expected' },
        workerForeground: ['claude'],
      }),
    );
    expect(workerRow(wrongFg.doc)?.state).toBe('restored, not launched by team');
    expect(workerDiff(wrongFg.doc)).toMatchObject({
      what: "worker: its pane runs claude; the seat's launch line runs codex",
      repair: 'look at the pane',
    });

    // Foreground says codex, but host entry agent says claude.
    const wrongAgent = await checkStatus(
      makeLive({
        worker: { agent: 'claude', session: 'ses_expected' },
        workerForeground: ['codex'],
      }),
    );
    expect(workerDiff(wrongAgent.doc)).toMatchObject({
      what: "worker: its pane's agent says claude; the seat's launch line runs codex",
      repair: 'look at the pane',
    });
  });

  test('another pane (another pane in the recorded workspace, or the recorded pane moved to another workspace)', async () => {
    // Weak proof with a second pane sharing WORKER_SPACE.
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });
    const siblingPane = await checkStatus(
      makeLive({
        extraAgents: [
          {
            name: null,
            agent: 'codex',
            pane: 'pane-sibling',
            workspace: WORKER_SPACE,
            status: 'idle',
            cwd: root,
          },
        ],
      }),
    );
    expect(workerRow(siblingPane.doc)?.state).toBe('restored, not launched by team');
    expect(workerDiff(siblingPane.doc)).toMatchObject({
      what: 'worker: its workspace holds another pane; team cannot tell which one is the seat',
      repair: 'look at the pane',
    });

    // Recorded pane is listed in a different workspace than recorded.
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_expected',
    });
    const wrongSpace = await checkStatus(
      makeLive({
        worker: { workspace: 'space-moved', session: 'ses_expected' },
      }),
    );
    expect(workerDiff(wrongSpace.doc)).toMatchObject({
      what: `worker: its pane is in workspace space-moved; the record puts it in ${WORKER_SPACE}`,
      repair: 'look at the pane',
    });
  });

  test('another name (the recorded pane carries another seat name)', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_expected',
    });

    const otherName = await checkStatus(
      makeLive({
        worker: { name: 'intruder', session: 'ses_expected' },
      }),
    );
    expect(workerRow(otherName.doc)?.state).toBe('restored, not launched by team');
    expect(workerDiff(otherName.doc)).toMatchObject({
      what: 'worker: its pane is named intruder; team never adopts a pane another seat owns',
      repair: 'look at the pane',
    });
  });
});

describe('3. a gone pane with a launch record reads as a CLI that did not come back', () => {
  test('when the session is running and the recorded pane is absent from the host list, repair is team up', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });

    const { code, doc } = await checkStatus(makeLive({ worker: null }));
    expect(code).toBe(1);
    expect(workerRow(doc)).toMatchObject({
      name: 'worker',
      state: 'missing',
      pane: '-',
    });
    expect(workerDiff(doc)).toEqual({
      what: 'worker was running and its CLI did not come back (the terminal host restored the session without it)',
      repair: 'team up',
      who: "the team's lead",
    });
  });
});

describe('4. a never-launched seat keeps today line', () => {
  test('a seat whose record has no launched identity or no record at all keeps "is in the file and is not running"', async () => {
    // Stage "named" without launched identity.
    seedState({ stage: 'named' });
    const namedRes = await checkStatus(makeLive({ worker: null }));
    expect(workerRow(namedRes.doc)?.state).toBe('missing');
    expect(workerDiff(namedRes.doc)).toMatchObject({
      what: 'worker is in the file and is not running',
      repair: 'team restart worker',
    });

    // No seat record at all.
    seedState(null);
    const emptyRes = await checkStatus(makeLive({ worker: null }));
    expect(workerRow(emptyRes.doc)?.state).toBe('missing');
    expect(workerDiff(emptyRes.doc)).toMatchObject({
      what: 'worker is in the file and is not running',
      repair: 'team restart worker',
    });
  });

  test('when nothing in the session is running, even a launch record keeps "is in the file and is not running"', async () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });

    const downLive: Live = {
      running: false,
      agents: [],
      workspaces: [],
      screens: {},
      processes: {},
      foreground: {},
    };
    const { doc } = await checkStatus(downLive);
    expect(workerDiff(doc)).toMatchObject({
      what: 'worker is in the file and is not running',
      repair: 'team up',
    });
  });
});

describe('5. check and up agree on the same synthetic world', () => {
  test('provable strong conversation restore: check promises team up re-ties it, and up adopts without relaunching', async () => {
    seedApproval();
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
      agent_session: 'ses_shared',
    });
    const liveStrong = makeLive({
      worker: { session: 'ses_shared' },
      workerScreen: IDLE_SCREEN,
    });

    const beforeCheck = await checkStatus(liveStrong);
    expect(workerDiff(beforeCheck.doc)?.what).toBe(
      "worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
    );
    expect(workerDiff(beforeCheck.doc)?.repair).toBe('team up');

    const upRun = makeUpSourcesFromLive(liveStrong);
    const upCode = await runUp([], testIo(root, { kind: 'owner' }), upRun.sources);
    expect(upCode).toBe(0);
    expect(upRun.renamed).toEqual([{ pane: WORKER_PANE, name: 'worker' }]);
    expect(upRun.created.filter((c) => c === 'worker')).toEqual([]);
    expect(upRun.closed).toEqual([]);
    expect(upRun.typed).toEqual([]);
    expect(readState(dir).sessions[SESSION]?.seats.worker?.launched).toEqual({
      shell: 20,
      cli: [21],
    });

    // Once adopted (and named on the host), check sees the seat running with no difference for worker.
    const liveAfterAdopt = makeLive({
      worker: { name: 'worker', session: 'ses_shared' },
      workerScreen: IDLE_SCREEN,
    });
    const afterCheck = await checkStatus(liveAfterAdopt);
    expect(workerRow(afterCheck.doc)?.state).toBe('idle');
    expect(workerDiff(afterCheck.doc)).toBeUndefined();
  });

  test('provable weak CLI restore: check promises team up re-ties it, and up adopts without relaunching', async () => {
    seedApproval();
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [99] },
    });
    const liveWeak = makeLive({ workerScreen: IDLE_SCREEN });
    const weakCheck = await checkStatus(liveWeak);
    expect(workerDiff(weakCheck.doc)?.what).toBe(
      "worker was restored by the terminal host; its pane holds the seat's declared CLI — team up re-ties it",
    );
    expect(workerDiff(weakCheck.doc)?.repair).toBe('team up');

    const weakUp = makeUpSourcesFromLive(liveWeak);
    expect(await runUp([], testIo(root, { kind: 'owner' }), weakUp.sources)).toBe(0);
    expect(weakUp.renamed).toEqual([{ pane: WORKER_PANE, name: 'worker' }]);
    expect(weakUp.created.filter((c) => c === 'worker')).toEqual([]);
    expect(weakUp.closed).toEqual([]);
    expect(weakUp.typed).toEqual([]);
  });

  test('failed proofs: check reports the specific reason with "look at the pane", and up refuses with the exact same reason', async () => {
    const cases: Array<{
      label: string;
      record: Record<string, unknown>;
      live: Live;
      expectedReason: string;
    }> = [
      {
        label: 'another conversation',
        record: {
          stage: 'ready',
          pane: WORKER_PANE,
          workspace: WORKER_SPACE,
          launched: { shell: 20, cli: [99] },
          agent_session: 'ses_kept',
        },
        live: makeLive({ worker: { session: 'ses_wrong' }, workerScreen: IDLE_SCREEN }),
        expectedReason: "its pane holds another conversation (ses_wrong; the record's launch ran ses_kept)",
      },
      {
        label: 'another CLI',
        record: {
          stage: 'ready',
          pane: WORKER_PANE,
          workspace: WORKER_SPACE,
          launched: { shell: 20, cli: [99] },
          agent_session: 'ses_kept',
        },
        live: makeLive({
          worker: { session: 'ses_kept' },
          workerForeground: ['claude'],
          workerScreen: IDLE_SCREEN,
        }),
        expectedReason: "its pane runs claude; the seat's launch line runs codex",
      },
      {
        label: 'another pane in workspace',
        record: {
          stage: 'ready',
          pane: WORKER_PANE,
          workspace: WORKER_SPACE,
          launched: { shell: 20, cli: [99] },
        },
        live: makeLive({
          workerScreen: IDLE_SCREEN,
          extraAgents: [
            {
              name: null,
              agent: 'codex',
              pane: 'pane-extra',
              workspace: WORKER_SPACE,
              status: 'idle',
              cwd: root,
            },
          ],
        }),
        expectedReason: 'its workspace holds another pane; team cannot tell which one is the seat',
      },
      {
        label: 'another name on the pane',
        record: {
          stage: 'ready',
          pane: WORKER_PANE,
          workspace: WORKER_SPACE,
          launched: { shell: 20, cli: [99] },
          agent_session: 'ses_kept',
        },
        live: makeLive({
          worker: { name: 'intruder', session: 'ses_kept' },
          workerScreen: IDLE_SCREEN,
        }),
        expectedReason: 'its pane is named intruder; team never adopts a pane another seat owns',
      },
    ];

    for (const scene of cases) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      seedApproval();
      seedState(scene.record);

      const statusRes = await checkStatus(scene.live);
      expect(workerDiff(statusRes.doc)).toMatchObject({
        what: `worker: ${scene.expectedReason}`,
        repair: 'look at the pane',
      });

      const upRun = makeUpSourcesFromLive(scene.live);
      const upIo = testIo(root, { kind: 'owner' });
      const upCode = await runUp([], upIo, upRun.sources);
      expect(upCode).toBe(1);
      expect(upIo.out).toContain(`worker: left out: ${scene.expectedReason}\n`);
      expect(upRun.renamed).toEqual([]);
      expect(upRun.closed).toEqual([]);
      expect(upRun.typed).toEqual([]);
    }
  });
});

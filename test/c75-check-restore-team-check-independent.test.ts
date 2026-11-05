// Independent verification of feat/c75-check-restore (ea899de75) driving `runTeamCheck`
// and `realCheckSources.live` directly.
//
// Scenes covered:
// 1. A provable restore (strong proof by conversation in state or registry, and weak proof by
//    declared CLI alone in its workspace at an idle prompt) reads with repair `team up` and
//    `who: "the team's lead"` from `team check`'s own live read, including the foreground argv0
//    names read through the terminal host's process page.
// 2. When the terminal host's process page carries no foreground argv0 names (or only pids),
//    the restore proof cannot confirm the declared CLI and falls back to the generic refusal with
//    repair `look at the pane` — proving `realCheckSources.live` must populate `foreground`.
// 3. Each specific failed-proof reason (another conversation, one-sided conversation in either
//    direction, another foreground CLI, dissenting agent attribution, another workspace, another
//    pane in the same workspace, another seat's name on the pane, working status, non-idle status,
//    working screen, unsent screen) is stated on the difference with repair `look at the pane`.
// 4. A gone pane with a launch record (when the session is running) reads as a CLI that did not
//    come back, with repair `team up`.
// 5. With every name cleared across the session (`anyRunning === false`), that "did not come back"
//    repair still names `"the team's lead"` (admitted to the owner or a team lead) rather than
//    counting as an owner-only difference.
// 6. A never-launched seat (or a launch record when the session itself is not running) keeps
//    today's line (`"<seat> is in the file and is not running"`).
//
// Synthetic fixtures only; no live terminal host, process table, or credential store is touched.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realHerdr from '../src/herdr.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const SESSION = 'acme-restore-check';
const LEAD_PANE = 'pane-lead';
const LEAD_SPACE = 'space-lead';
const WORKER_PANE = 'pane-worker';
const WORKER_SPACE = 'space-worker';
const NOW = new Date('2026-11-05T12:00:00Z');

const IDLE_SCREEN = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
const WORKING_SCREEN = readFileSync(new URL('./fixtures/codex/0.161.0/working.txt', import.meta.url), 'utf8');
const UNSENT_SCREEN = readFileSync(new URL('./fixtures/codex/0.161.0/unsent.txt', import.meta.url), 'utf8');

let fakeSessionRunning: boolean | null = true;

mock.module('../src/herdr.ts', () => ({
  ...realHerdr,
  sessionRunning: (name: string) => (name === SESSION ? fakeSessionRunning : realHerdr.sessionRunning(name)),
}));

const { realCheckSources, runTeamCheck } = await import('../src/check/team.ts');
const { registerAgent } = await import('../src/registry/agents.ts');
const { teamIdOf } = await import('../src/registry/teams.ts');
const { emptySession, updateState } = await import('../src/state.ts');
const { gitEnv, testIo } = await import('./helpers.ts');

type RawHostAgent = {
  name: string | null;
  agent: string | null;
  pane_id: string;
  workspace_id: string;
  agent_status: string;
  cwd: string | null;
  agent_session?: string | { agent: string; kind: string; source: string; value: string };
};

type RawHostProcessInfo = {
  process_info?: {
    shell_pid?: number;
    foreground_processes?: Array<{ pid?: number; argv0?: string }>;
  };
} | null;

type HostWorld = {
  running?: boolean;
  leadName?: string | null;
  leadSession?: string;
  worker?: Partial<RawHostAgent> | null;
  extraAgents?: RawHostAgent[];
  workerProcessInfo?: RawHostProcessInfo;
  workerScreen?: string;
};

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let seq = 0;
let processInfoReads: string[];

function teamYaml(): string {
  return `format: 1
project: acme
session: ${SESSION}
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

function seedState(
  workerRecord: Record<string, unknown> | null,
  leadRecord: Record<string, unknown> = {
    stage: 'ready',
    pane: LEAD_PANE,
    workspace: LEAD_SPACE,
    launched: { shell: 10, cli: [11] },
    agent_session: 'ses_lead',
    last_active: NOW.toISOString(),
  },
): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = { last_active: NOW.toISOString(), ...leadRecord } as never;
    if (workerRecord === null) {
      delete session.seats.worker;
    } else {
      session.seats.worker = { last_active: NOW.toISOString(), ...workerRecord } as never;
    }
  });
}

function installHostWorld(world: HostWorld = {}): void {
  fakeSessionRunning = world.running ?? true;
  processInfoReads = [];

  const leadAgent: RawHostAgent = {
    name: world.leadName === undefined ? 'lead' : world.leadName,
    agent: 'claude',
    pane_id: LEAD_PANE,
    workspace_id: LEAD_SPACE,
    agent_status: 'idle',
    cwd: root,
    agent_session: world.leadSession ?? 'ses_lead',
  };

  const workerAgent: RawHostAgent | null =
    world.worker === null
      ? null
      : {
          name: null,
          agent: 'codex',
          pane_id: WORKER_PANE,
          workspace_id: WORKER_SPACE,
          agent_status: 'idle',
          cwd: root,
          ...(world.worker ?? {}),
        };

  const agents: RawHostAgent[] = [
    leadAgent,
    ...(workerAgent === null ? [] : [workerAgent]),
    ...(world.extraAgents ?? []),
  ];

  const defaultWorkerProcessInfo: RawHostProcessInfo =
    workerAgent === null
      ? null
      : {
          process_info: {
            shell_pid: 30,
            foreground_processes: [{ pid: 31, argv0: 'codex' }],
          },
        };

  const workerProc =
    world.workerProcessInfo === undefined ? defaultWorkerProcessInfo : world.workerProcessInfo;

  realHerdr.setHerdrRun((args) => {
    if (args[0] === 'agent' && args[1] === 'list') {
      return { agents };
    }
    if (args[0] === 'workspace' && args[1] === 'list') {
      return {
        workspaces: [
          { workspace_id: LEAD_SPACE, label: 'lead' },
          { workspace_id: WORKER_SPACE, label: 'worker' },
        ],
      };
    }
    if (args[0] === 'pane' && args[1] === 'process-info' && args[2] === '--pane') {
      const pane = args[3] ?? '';
      processInfoReads.push(pane);
      if (pane === LEAD_PANE) {
        return {
          process_info: {
            shell_pid: 10,
            foreground_processes: [{ pid: 11, argv0: 'claude' }],
          },
        };
      }
      if (pane === WORKER_PANE) {
        return workerProc;
      }
      return null;
    }
    return null;
  });

  realHerdr.setPaneExec((args) => {
    const readIdx = args.indexOf('read');
    const pane = readIdx >= 0 ? args[readIdx + 1] : '';
    if (pane === WORKER_PANE) {
      return world.workerScreen ?? IDLE_SCREEN;
    }
    return '';
  });
}

type CheckJsonDoc = {
  project: string;
  session: string;
  differences: Array<{ what: string; repair: string; who: string }>;
  summary: { differences: number; owner_differences: number };
};

function runCheckJson(world: HostWorld = {}): { code: number; doc: CheckJsonDoc } {
  installHostWorld(world);
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml', json: true }, io, {
    ...realCheckSources,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  return { code, doc: JSON.parse(io.out) as CheckJsonDoc };
}

function runCheckText(world: HostWorld = {}): { code: number; out: string } {
  installHostWorld(world);
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    ...realCheckSources,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  return { code, out: io.out };
}

function workerDiff(doc: CheckJsonDoc) {
  return doc.differences.find((d) => d.what.startsWith('worker:') || d.what.startsWith('worker '));
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c75-check-restore-team-check-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
});

beforeEach(() => {
  seq += 1;
  home = join(base, `home-${seq}`);
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), teamYaml());
  updateState(dir, (state) => {
    state.sessions = {};
  });
});

afterEach(() => {
  realHerdr.setHerdrRun(null);
  realHerdr.setPaneExec(null);
  fakeSessionRunning = true;
});

afterAll(() => {
  mock.module('../src/herdr.ts', () => ({ ...realHerdr }));
  discardFixtures([base]);
});

describe('runTeamCheck live read: provable restores read with repair team up, including foreground', () => {
  test('strong proof (recorded agent_session matches live pane session and foreground argv0 matches CLI)', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_worker_1',
    });

    const { code, doc } = runCheckJson({
      worker: { agent_session: 'ses_worker_1' },
    });

    expect(code).toBe(1);
    const diff = workerDiff(doc);
    expect(diff).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
    expect(doc.summary.owner_differences).toBe(0);
    // The live read asks the terminal host once per recorded pane for process-info and derives
    // both the pids and the foreground argv0 names from that single answer.
    expect(processInfoReads.filter((p) => p === WORKER_PANE)).toEqual([WORKER_PANE]);
  });

  test('strong proof via registry continuity binding and structured host agent_session', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
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

    const { code, doc } = runCheckJson({
      worker: {
        agent_session: {
          agent: 'codex',
          kind: 'id',
          source: 'cli',
          value: 'ses_from_registry',
        },
      },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
  });

  test('weak proof (no session id on either side, declared CLI in foreground, alone in workspace, idle prompt)', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const { code, doc } = runCheckJson({
      worker: {},
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker was restored by the terminal host; its pane holds the seat's declared CLI — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });

    const text = runCheckText({ worker: {} });
    expect(text.code).toBe(1);
    expect(text.out).toContain("difference: worker was restored by the terminal host; its pane holds the seat's declared CLI — team up re-ties it");
    expect(text.out).toContain('  repair: team up');
    expect(text.out).toContain("  who: the team's lead");
  });

  test('without foreground argv0 names on the process page, the proof refuses to adopt', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_worker_1',
    });

    const { code, doc } = runCheckJson({
      worker: { agent_session: 'ses_worker_1' },
      workerProcessInfo: {
        process_info: {
          shell_pid: 30,
          foreground_processes: [{ pid: 31 }],
        },
      },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker: its pane runs ; the seat\'s launch line runs codex',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });
});

describe('runTeamCheck live read: each failed-proof reason is stated with repair "look at the pane"', () => {
  test('another conversation on the pane', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_expected',
    });

    const { code, doc } = runCheckJson({
      worker: { agent_session: 'ses_different' },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker: its pane holds another conversation (ses_different; the record's launch ran ses_expected)",
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('one-sided session: recorded session set, live pane reports no conversation', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_expected',
    });

    const { code, doc } = runCheckJson({
      worker: {},
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker: its pane reports no conversation; the record's launch ran ses_expected",
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('one-sided session: live pane reports a conversation the launch record never named', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const { code, doc } = runCheckJson({
      worker: { agent_session: 'ses_unexpected' },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker: its pane holds a conversation (ses_unexpected) the record's launch never named",
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('another foreground CLI in the pane (even when session ids match)', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_kept',
    });

    const { code, doc } = runCheckJson({
      worker: { agent_session: 'ses_kept' },
      workerProcessInfo: {
        process_info: {
          shell_pid: 30,
          foreground_processes: [{ pid: 31, argv0: 'claude' }],
        },
      },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker: its pane runs claude; the seat's launch line runs codex",
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('agent entry attribution disagrees with the declared CLI', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_kept',
    });

    const { code, doc } = runCheckJson({
      worker: { agent: 'claude', agent_session: 'ses_kept' },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: "worker: its pane's agent says claude; the seat's launch line runs codex",
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('pane listed in a different workspace than the launch record', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_kept',
    });

    const { code, doc } = runCheckJson({
      worker: { workspace_id: 'space-other', agent_session: 'ses_kept' },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: `worker: its pane is in workspace space-other; the record puts it in ${WORKER_SPACE}`,
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('pane carries another seat name', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
      agent_session: 'ses_kept',
    });

    const { code, doc } = runCheckJson({
      worker: { name: 'intruder', agent_session: 'ses_kept' },
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker: its pane is named intruder; team never adopts a pane another seat owns',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('weak proof with another pane sharing the recorded workspace', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const { code, doc } = runCheckJson({
      worker: {},
      extraAgents: [
        {
          name: null,
          agent: 'codex',
          pane_id: 'pane-sibling',
          workspace_id: WORKER_SPACE,
          agent_status: 'idle',
          cwd: root,
        },
      ],
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker: its workspace holds another pane; team cannot tell which one is the seat',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('weak proof when the host reports status working or blocked', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const working = runCheckJson({
      worker: { agent_status: 'working' },
    });
    expect(working.code).toBe(1);
    expect(workerDiff(working.doc)).toEqual({
      what: 'worker: the process in its pane is working; nothing closed (stop it there, or run team remove worker)',
      repair: 'look at the pane',
      who: "the team's lead",
    });

    const blocked = runCheckJson({
      worker: { agent_status: 'blocked' },
    });
    expect(blocked.code).toBe(1);
    expect(workerDiff(blocked.doc)).toEqual({
      what: 'worker: its pane reads blocked; team cannot tell it is at an idle prompt',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('weak proof when the screen shows working or unsent text despite idle host status', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const workingScreen = runCheckJson({
      worker: { agent_status: 'idle' },
      workerScreen: WORKING_SCREEN,
    });
    expect(workingScreen.code).toBe(1);
    expect(workerDiff(workingScreen.doc)).toEqual({
      what: 'worker: the process in its pane is working; nothing closed (stop it there, or run team remove worker)',
      repair: 'look at the pane',
      who: "the team's lead",
    });

    const unsentScreen = runCheckJson({
      worker: { agent_status: 'idle' },
      workerScreen: UNSENT_SCREEN,
    });
    expect(unsentScreen.code).toBe(1);
    expect(workerDiff(unsentScreen.doc)).toEqual({
      what: 'worker: the process in its pane holds unsent text; nothing closed (send or clear it there, or run team remove worker)',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });
});

describe('runTeamCheck live read: gone pane with launch record vs never-launched seat', () => {
  test('a gone pane with a launch record reads "did not come back" with repair team up', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const { code, doc } = runCheckJson({
      worker: null,
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker was running and its CLI did not come back (the terminal host restored the session without it)',
      repair: 'team up',
      who: "the team's lead",
    });
    // Even when agent list omits the pane, realCheckSources.live probes paneProcessInfo for the
    // recorded pane to distinguish a gone pane from one left at its shell.
    expect(processInfoReads.filter((p) => p === WORKER_PANE)).toEqual([WORKER_PANE]);
  });

  test('an unlisted pane in agent list that still holds its shell or an untied process is distinguished from a gone pane', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const atShell = runCheckJson({
      worker: null,
      workerProcessInfo: {
        process_info: {
          shell_pid: 30,
          foreground_processes: [{ pid: 30 }],
        },
      },
    });
    expect(atShell.code).toBe(1);
    expect(workerDiff(atShell.doc)).toEqual({
      what: 'worker: its pane runs no CLI (the CLI ended or the session was restored)',
      repair: 'team up',
      who: "the team's lead",
    });

    const replacedUnlisted = runCheckJson({
      worker: null,
      workerProcessInfo: {
        process_info: {
          shell_pid: 30,
          foreground_processes: [{ pid: 31, argv0: 'codex' }],
        },
      },
    });
    expect(replacedUnlisted.code).toBe(1);
    expect(workerDiff(replacedUnlisted.doc)).toEqual({
      what: 'worker: its pane holds a process this record cannot tie to the launch',
      repair: 'look at the pane',
      who: "the team's lead",
    });
  });

  test('with every name cleared in the session, "did not come back" still names the owner or a team lead (never owner-only)', () => {
    // Both seats have launch records; the terminal host restored lead's pane with its name
    // cleared (`name: null`) and did not restore worker's pane at all, so `anyRunning` is false.
    seedState(
      {
        stage: 'ready',
        pane: WORKER_PANE,
        workspace: WORKER_SPACE,
        launched: { shell: 20, cli: [22] },
      },
      {
        stage: 'ready',
        pane: LEAD_PANE,
        workspace: LEAD_SPACE,
        launched: { shell: 90, cli: [91] },
        agent_session: 'ses_lead',
      },
    );

    const { code, doc } = runCheckJson({
      leadName: null,
      leadSession: 'ses_lead',
      worker: null,
    });

    expect(code).toBe(1);
    const lead = doc.differences.find((d) => d.what.startsWith('lead '));
    expect(lead).toEqual({
      what: "lead was restored by the terminal host; its pane holds the seat's conversation — team up re-ties it",
      repair: 'team up',
      who: "the team's lead",
    });
    const worker = workerDiff(doc);
    expect(worker).toEqual({
      what: 'worker was running and its CLI did not come back (the terminal host restored the session without it)',
      repair: 'team up',
      who: "the team's lead",
    });
    expect(doc.summary.owner_differences).toBe(0);

    const text = runCheckText({
      leadName: null,
      leadSession: 'ses_lead',
      worker: null,
    });
    expect(text.code).toBe(1);
    expect(text.out).toContain('difference: worker was running and its CLI did not come back (the terminal host restored the session without it)');
    expect(text.out).toContain('  repair: team up');
    expect(text.out).toContain("  who: the team's lead");
    expect(text.out).not.toContain('for the owner');
  });

  test('a never-launched seat keeps today line and repair', () => {
    seedState({ stage: 'named' });

    const { code, doc } = runCheckJson({
      worker: null,
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker is in the file and is not running',
      repair: 'team restart worker',
      who: "the team's lead",
    });

    seedState(null);
    const noRecord = runCheckJson({
      worker: null,
    });
    expect(noRecord.code).toBe(1);
    expect(workerDiff(noRecord.doc)).toEqual({
      what: 'worker is in the file and is not running',
      repair: 'team restart worker',
      who: "the team's lead",
    });
  });

  test('when the session itself is not running, a launch record keeps today line and names the owner', () => {
    seedState({
      stage: 'ready',
      pane: WORKER_PANE,
      workspace: WORKER_SPACE,
      launched: { shell: 20, cli: [22] },
    });

    const { code, doc } = runCheckJson({
      running: false,
      worker: null,
    });

    expect(code).toBe(1);
    expect(workerDiff(doc)).toEqual({
      what: 'worker is in the file and is not running',
      repair: 'team up',
      who: 'the owner',
    });
    expect(doc.summary.owner_differences).toBeGreaterThan(0);
  });
});

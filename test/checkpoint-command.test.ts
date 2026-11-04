import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheckpoint } from '../src/commands/checkpoint.ts';
import type { Io } from '../src/io.ts';
import { CHECKPOINT_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { gitEnv } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-04-11T10:00:00.000Z');
const EXPECTED_DEADLINE = '2026-04-11T10:30:00.000Z';

const TEAM_YAML = (root: string): string => `format: 1
project: alpha
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const bases: string[] = [];
let base: string;
let root: string;
let home: string;
let agentsDir: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join('/private/tmp', 'team-checkpoint-cmd-')));
  bases.push(base);
  root = join(base, 'alpha');
  home = join(base, 'home');
  agentsDir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  writeFileSync(join(agentsDir, 'team.yaml'), TEAM_YAML(root));
  updateState(agentsDir, (state) => {
    state.sessions.alpha = {
      ...emptySession(),
      seats: {
        lead: {
          stage: 'ready',
          pane: 'pane-lead',
          workspace: 'ws-lead',
          cli: 'claude-code',
        },
        worker: {
          stage: 'ready',
          pane: 'pane-work',
          workspace: 'ws-work',
          cli: 'claude-code',
        },
      },
    };
  });
});

afterEach(() => {
  for (const path of bases.splice(0)) discardFixtures([path]);
});

function makeIo(
  cwd: string,
  caller: NonNullable<Io['caller']>,
  env: Record<string, string | undefined> = {},
): { io: Io; out: () => string; err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      env,
      stdinIsTTY: caller.kind === 'owner',
      caller,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

function seedEntityHeadTeam(): void {
  writeFileSync(
    join(agentsDir, 'team.yaml'),
    TEAM_YAML(root)
      .replace('project: alpha\n', 'project: alpha\nentity: corp\n')
      .replace('  - ~/.config/team/lobby\n', '  - ~/.config/team/lobby\n  - ~/.config/team/lobbies/corp\n'),
  );
  const headRoot = join(base, 'corp');
  const headAgents = join(headRoot, '.agents');
  mkdirSync(headAgents, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: headRoot,
    env: gitEnv(),
  });
  writeFileSync(
    join(headAgents, 'team.yaml'),
    `format: 1
project: corp
entity: corp
coordinator: orchestrator
operator: orchestrator
trust:
  - ~/.config/team/lobby
  - ~/.config/team/lobbies/corp
  - ${headRoot}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
  );
  updateState(headAgents, (state) => {
    state.sessions.corp = {
      ...emptySession(),
      seats: {
        orchestrator: {
          stage: 'ready',
          pane: 'pane-corp-orch',
          workspace: 'ws-corp-orch',
          cli: 'claude-code',
        },
        helper: {
          stage: 'ready',
          pane: 'pane-corp-helper',
          workspace: 'ws-corp-helper',
          cli: 'claude-code',
        },
      },
    };
  });
  upsertTeam(home, teamIdOf(root), {
    project: 'alpha',
    entity: 'corp',
    session: 'alpha',
    root,
    at: NOW.toISOString(),
  });
  upsertTeam(home, teamIdOf(headRoot), {
    project: 'corp',
    entity: 'corp',
    session: 'corp',
    root: headRoot,
    at: NOW.toISOString(),
  });
}

describe('team checkpoint (R2)', () => {
  test('owner records a standing checkpoint ask in state, logs it, and does not create the handover file', async () => {
    const { io, out, err } = makeIo(root, { kind: 'owner' });

    const code = await runCheckpoint(['worker'], io, { home, now: () => NOW });

    expect(code).toBe(0);
    expect(err()).toBe('');

    const state = readState(agentsDir);
    const record = state.checkpoints?.worker;
    expect(record).toBeDefined();
    const expectedPath = join(
      agentsDir,
      'handovers',
      'worker-2026-04-11T10-00-00-000Z.md',
    );
    expect(record).toEqual({
      by: 'owner',
      path: expectedPath,
      session: 'alpha',
      at: NOW.toISOString(),
      deadline: EXPECTED_DEADLINE,
    });
    expect(out()).toBe(
      `team checkpoint: recorded worker -> ${expectedPath} (by ${EXPECTED_DEADLINE})\n`,
    );
    expect(existsSync(expectedPath)).toBe(false);

    const logText = readFileSync(join(agentsDir, 'team.log'), 'utf8');
    expect(logText).toContain(`checkpoint [owner] asked worker -> ${expectedPath}`);
  });

  test('placed leads seat records a checkpoint ask and emits a schema-valid team.checkpoint JSON document', async () => {
    const { io, out, err } = makeIo(root, {
      kind: 'seat',
      session: 'alpha',
      name: 'lead',
      pane: 'pane-lead',
    });

    const code = await runCheckpoint(['worker', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(0);
    expect(err()).toBe('');

    const doc = assertMatchesOutputSchema(out(), CHECKPOINT_OUTPUT_SCHEMA);
    const expectedPath = join(
      agentsDir,
      'handovers',
      'worker-2026-04-11T10-00-00-000Z.md',
    );
    expect(doc).toEqual({
      schema: { name: 'team.checkpoint', version: 1 },
      format: 1,
      dry_run: false,
      status: 'recorded',
      action_summary: `team checkpoint: recorded worker -> ${expectedPath} (by ${EXPECTED_DEADLINE})`,
      seat: 'worker',
      path: expectedPath,
      at: NOW.toISOString(),
      deadline: EXPECTED_DEADLINE,
      by: 'lead',
    });
  });

  test('owner --session and --file target the named session and file, while seat callers are refused on both', async () => {
    const otherRoot = join(base, 'other');
    const otherAgents = join(otherRoot, '.agents');
    mkdirSync(otherAgents, { recursive: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
      cwd: otherRoot,
      env: gitEnv(),
    });
    const otherFile = join(otherAgents, 'team.yaml');
    writeFileSync(otherFile, TEAM_YAML(otherRoot));

    const ownerRun = makeIo(root, { kind: 'owner' });
    const ownerCode = await runCheckpoint(
      ['worker', '--session', 'beta', '--file', otherFile],
      ownerRun.io,
      { home, now: () => NOW },
    );
    expect(ownerCode).toBe(0);
    const otherState = readState(otherAgents);
    expect(otherState.checkpoints?.worker?.session).toBe('beta');
    expect(otherState.checkpoints?.worker?.path).toBe(
      join(otherAgents, 'handovers', 'worker-2026-04-11T10-00-00-000Z.md'),
    );

    const seatFileRun = makeIo(root, {
      kind: 'seat',
      session: 'alpha',
      name: 'lead',
      pane: 'pane-lead',
    });
    const seatFileCode = await runCheckpoint(['worker', '--file', otherFile], seatFileRun.io, {
      home,
      now: () => NOW,
    });
    expect(seatFileCode).toBe(1);
    expect(seatFileRun.err()).toContain('--file');

    const seatSessionRun = makeIo(root, {
      kind: 'seat',
      session: 'alpha',
      name: 'lead',
      pane: 'pane-lead',
    });
    const seatSessionCode = await runCheckpoint(
      ['worker', '--session', 'beta', '--json'],
      seatSessionRun.io,
      { home, now: () => NOW },
    );
    expect(seatSessionCode).toBe(1);
    const errDoc = assertJsonErrorShape(seatSessionRun.out(), { id: 'checkpoint.caller' });
    expect(errDoc.error.rule).toBe('owner-only');
  });

  test('refuses non-lead, unplaced, wrong-pane, default-session, and unverified-standing callers with checkpoint.caller', async () => {
    const workerRun = makeIo(root, {
      kind: 'seat',
      session: 'alpha',
      name: 'worker',
      pane: 'pane-work',
    });
    expect(await runCheckpoint(['worker'], workerRun.io, { home, now: () => NOW })).toBe(1);
    expect(workerRun.err()).toContain('only the owner or `leads`');

    const wrongPaneRun = makeIo(root, {
      kind: 'seat',
      session: 'alpha',
      name: 'lead',
      pane: 'pane-other',
    });
    expect(
      await runCheckpoint(['worker', '--json'], wrongPaneRun.io, { home, now: () => NOW }),
    ).toBe(1);
    assertJsonErrorShape(wrongPaneRun.out(), {
      id: 'checkpoint.caller',
      messageContains: 'pane-lead',
    });

    const defaultRun = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['worker', '--session', 'default'], defaultRun.io, {
        home,
        now: () => NOW,
      }),
    ).toBe(1);
    expect(defaultRun.err()).toContain('session can\'t be "default"');

    const staleStandingRun = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['worker'], staleStandingRun.io, {
        home,
        now: () => NOW,
        standing: () => ({ kind: 'refused', why: 'ledger mismatch' }),
      }),
    ).toBe(1);
    expect(staleStandingRun.err()).toContain('team checkpoint: ledger mismatch');
  });

  test('refuses bad flags, missing or undeclared seat, and invalid team file with checkpoint.invocation (exit 2)', async () => {
    const missingSeat = makeIo(root, { kind: 'owner' });
    expect(await runCheckpoint([], missingSeat.io, { home, now: () => NOW })).toBe(2);
    expect(missingSeat.err()).toContain('a seat name is required');
    expect(missingSeat.err()).toContain('Usage: team checkpoint <seat>');

    const extraArg = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['worker', 'extra'], extraArg.io, { home, now: () => NOW }),
    ).toBe(2);
    expect(extraArg.err()).toContain('unexpected "extra"');

    const badFlag = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['worker', '--unknown'], badFlag.io, { home, now: () => NOW }),
    ).toBe(2);
    expect(badFlag.err()).toContain('--unknown');

    const undeclared = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['ghost', '--json'], undeclared.io, { home, now: () => NOW }),
    ).toBe(2);
    assertJsonErrorShape(undeclared.out(), {
      id: 'checkpoint.invocation',
      messageContains: 'ghost is not a signed declared seat',
    });

    const missingFile = makeIo(root, { kind: 'owner' });
    expect(
      await runCheckpoint(['worker', '--file', join(root, 'missing.yaml')], missingFile.io, {
        home,
        now: () => NOW,
      }),
    ).toBe(2);
    expect(missingFile.err()).toContain('team checkpoint:');
  });

  test('refuses state write failure with checkpoint.io (exit 1)', async () => {
    const stateFile = join(agentsDir, 'team.state.json');
    discardFixtures([stateFile]);
    mkdirSync(stateFile, { recursive: true });

    const { io, out, err } = makeIo(root, { kind: 'owner' });
    const code = await runCheckpoint(['worker', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(1);
    expect(err()).toBe('');
    assertJsonErrorShape(out(), {
      id: 'checkpoint.io',
      messageContains: 'the state cannot be written',
    });
  });

  test('entity main orchestrator, placed in its own team session, may ask for a checkpoint', async () => {
    seedEntityHeadTeam();
    const { io, out, err } = makeIo(root, {
      kind: 'seat',
      session: 'corp',
      name: 'orchestrator',
      pane: 'pane-corp-orch',
    });

    const code = await runCheckpoint(['worker', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(0);
    expect(err()).toBe('');
    const doc = assertMatchesOutputSchema(out(), CHECKPOINT_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      status: 'recorded',
      seat: 'worker',
      by: 'orchestrator',
    });
    expect(readState(agentsDir).checkpoints?.worker?.by).toBe('orchestrator');
  });

  test('a seat of the entity head team that is not its orchestrator is refused', async () => {
    seedEntityHeadTeam();
    const { io, out, err } = makeIo(root, {
      kind: 'seat',
      session: 'corp',
      name: 'helper',
      pane: 'pane-corp-helper',
    });

    const code = await runCheckpoint(['worker', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(1);
    expect(err()).toBe('');
    const errDoc = assertJsonErrorShape(out(), {
      id: 'checkpoint.caller',
      messageContains: 'only the owner or `leads` records a checkpoint ask; this call is helper',
    });
    expect(errDoc.error.rule).toBe('owner-or-leads');
    expect(readState(agentsDir).checkpoints?.worker).toBeUndefined();
  });

  test('entity main orchestrator failing the pane check is refused with owner-or-leads standing', async () => {
    seedEntityHeadTeam();
    const { io, out, err } = makeIo(root, {
      kind: 'seat',
      session: 'corp',
      name: 'orchestrator',
      pane: 'pane-wrong',
    });

    const code = await runCheckpoint(['worker', '--json'], io, { home, now: () => NOW });

    expect(code).toBe(1);
    expect(err()).toBe('');
    const errDoc = assertJsonErrorShape(out(), {
      id: 'checkpoint.caller',
      messageContains: 'only the owner or `leads` records a checkpoint ask; this call is orchestrator',
    });
    expect(errDoc.error.rule).toBe('owner-or-leads');
    expect(readState(agentsDir).checkpoints?.worker).toBeUndefined();
  });
});

// Independent verification for fix/gate-pane-root-registration:
// - Non-owner first record, record short of its identity, replaced process in the same pane,
//   dev-mode fold, and dry runs are all refused as `register.launch-only` with nothing written.
// - A seat re-running `team register` in its own unchanged pane exits 0 with its state record
//   unchanged.
// - The owner walk records a fresh pane root, completes a missing launch identity on a ready
//   record, and adopts a replaced process on a `launched` record (while keeping `register.replaced`
//   on an already-ready record).
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { findAgent, readAgents } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, mintSeatId, readState, STATE_FILE, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';
import { assertJsonErrorShape } from './helpers/output.ts';

const NOW = new Date('2026-11-04T15:00:00Z');
const PANE_LEAD = 'pane-a';
const PANE_WORKER = 'pane-b';
const WORKSPACE = 'ws-1';
const UNPLACED: Caller = { kind: 'unplaced', reason: 'it runs under herdr' };
const DELEGATE: Caller = { kind: 'seat', name: 'lead', pane: 'pane-d', session: 'outer' };

type World = { base: string; home: string; root: string; dir: string; file: string };

const templateRepo = realpathSync(mkdtempSync(join(tmpdir(), 'gate-pane-root-tpl-')));
execFileSync('git', ['init', '-q'], { cwd: templateRepo, stdio: 'ignore' });
const templateGitDir = join(templateRepo, '.git');

afterAll(() => {
  rmSync(templateRepo, { recursive: true, force: true });
});

const scratchDirs: string[] = [];

beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});

afterEach(() => {
  setHerdrRun(null);
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorld(extraYaml = ''): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gate-pane-root-')));
  scratchDirs.push(base);
  const home = join(base, 'home');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  cpSync(templateGitDir, join(root, '.git'), { recursive: true });
  const file = join(dir, 'team.yaml');
  writeFileSync(
    file,
    `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
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
${extraYaml}`,
  );
  return { base, home, root, dir, file };
}

function agentOf(name: string, pane: string): HerdrAgent {
  return {
    name,
    agent: 'claude',
    pane,
    workspace: WORKSPACE,
    status: 'idle',
    cwd: null,
    session: `${name}-session-1`,
  };
}

function makeSources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agentOf('lead', PANE_LEAD), agentOf('worker', PANE_WORKER)],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    renameWorkspace: () => true,
    reportDisplayAgent: () => true,
    renameAgent: () => true,
    refreshAddress: () => ({ address: null }),
    now: () => NOW,
    ...over,
  };
}

/** An IO whose caller walk resolves to seat `name` standing on `pane` in session `acme`. */
function seatWalkIo(w: World, name: string, pane: string): ReturnType<typeof testIo> {
  const io = testIo(w.root);
  io.callerSources = (asked?: string) => {
    const placed = asked === undefined || asked === 'acme';
    return {
      ancestors: () => [
        { pid: 700, name: 'node' },
        { pid: 600, name: 'herdr' },
      ],
      agents: () => (placed ? [agentOf(name, pane)] : []),
      paneRootPid: (p: string) => (placed && p === pane ? 700 : null),
      env: io.env,
      stdinIsTTY: false,
    };
  };
  return io;
}

/** An IO whose caller walk resolves to the owner (process tree outside herdr). */
function ownerWalkIo(w: World): ReturnType<typeof testIo> {
  const io = testIo(w.root);
  io.callerSources = () => ({
    ancestors: () => [{ pid: 800, name: 'zsh' }],
    agents: () => [],
    paneRootPid: () => null,
    env: io.env,
    stdinIsTTY: true,
  });
  return io;
}

function seedSeatRecord(
  w: World,
  seat: 'lead' | 'worker',
  pane: string,
  options: {
    id?: string;
    stage?: 'launched' | 'ready';
    launched?: { shell: number; cli: number[] };
    agentSession?: string;
  } = {},
): string {
  const id = options.id ?? mintSeatId();
  updateState(w.dir, (state) => {
    (state.sessions.acme ??= emptySession()).seats[seat] = {
      id,
      stage: options.stage ?? 'ready',
      pane,
      cli: 'claude-code',
      ...(options.launched !== undefined ? { launched: options.launched } : {}),
      ...(options.agentSession !== undefined ? { agent_session: options.agentSession } : {}),
    };
  });
  return id;
}

function panesDir(w: World): string {
  return join(w.home, '.config', 'team', 'panes');
}

describe('1. non-owner first record is refused as register.launch-only with nothing written', () => {
  test('a team seat, a delegate, and a granted seat attempting a first record are all refused as register.launch-only and write nothing', async () => {
    // (a) A seat of this team (`lead`) trying to register `worker` on a fresh pane (`pane-b`) with no record for `worker`.
    const wSeat = makeWorld();
    seedSeatRecord(wSeat, 'lead', PANE_LEAD, { stage: 'ready', launched: { shell: 400, cli: [401] } });
    const stateBefore = readFileSync(join(wSeat.dir, STATE_FILE), 'utf8');

    const ioPlain = seatWalkIo(wSeat, 'lead', PANE_LEAD);
    const codePlain = await runRegister(
      ['worker'],
      ioPlain,
      makeSources(wSeat, {
        paneText: () => {
          throw new Error('screen must not be read when launch-only refuses');
        },
      }),
    );
    expect(codePlain).toBe(1);
    expect(ioPlain.err).toBe(
      `team register: worker: pane ${PANE_WORKER} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n`,
    );
    expect(readFileSync(join(wSeat.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    expect(readAgents(wSeat.home)).toHaveLength(0);
    expect(existsSync(join(wSeat.dir, LOG_FILE))).toBe(false);
    expect(existsSync(panesDir(wSeat))).toBe(false);

    // Same seat call with --json emits `register.launch-only` and writes nothing.
    const ioJson = seatWalkIo(wSeat, 'lead', PANE_LEAD);
    const codeJson = await runRegister(['worker', '--json'], ioJson, makeSources(wSeat));
    expect(codeJson).toBe(1);
    expect(ioJson.err).toBe('');
    assertJsonErrorShape(ioJson.out, {
      id: 'register.launch-only',
      messageContains: `worker: pane ${PANE_WORKER} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr`,
    });
    expect(readFileSync(join(wSeat.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    expect(readAgents(wSeat.home)).toHaveLength(0);

    // (b) A delegate caller whose delegate gate passed is still refused by `register.launch-only` on a first record.
    const wDelegate = makeWorld(`delegates:\n  - pane: outer/pane-d\n    commands: [up, add, remove]\n`);
    const ioDelegate = testIo(wDelegate.root, DELEGATE);
    const codeDelegate = await runRegister(
      ['lead', '--json'],
      ioDelegate,
      makeSources(wDelegate, {
        delegateGate: () => ({ kind: 'passed', pane: 'outer/pane-d' }),
      }),
    );
    expect(codeDelegate).toBe(1);
    assertJsonErrorShape(ioDelegate.out, {
      id: 'register.launch-only',
      messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
    });
    expect(existsSync(join(wDelegate.dir, STATE_FILE))).toBe(false);
    expect(readAgents(wDelegate.home)).toHaveLength(0);
    expect(existsSync(join(wDelegate.dir, LOG_FILE))).toBe(false);

    // (c) A granted seat caller whose grant gate passed is also refused by `register.launch-only` on a first record.
    const wGrant = makeWorld(`grant:\n  session: acme\n  seat: lead\n  scope:\n    - up\n`);
    const ioGrant = testIo(wGrant.root, { kind: 'seat', name: 'lead', pane: PANE_LEAD, session: 'acme' });
    const codeGrant = await runRegister(
      ['worker', '--json'],
      ioGrant,
      makeSources(wGrant, {
        grantGate: () => ({
          kind: 'passed',
          grant: { session: 'acme', seat: 'lead', scope: ['up'] } as never,
        }),
      }),
    );
    expect(codeGrant).toBe(1);
    assertJsonErrorShape(ioGrant.out, {
      id: 'register.launch-only',
      messageContains: `worker: pane ${PANE_WORKER} is not a process identity this record's launch wrote`,
    });
    expect(existsSync(join(wGrant.dir, STATE_FILE))).toBe(false);
    expect(readAgents(wGrant.home)).toHaveLength(0);
    expect(existsSync(join(wGrant.dir, LOG_FILE))).toBe(false);
  });
});

describe('2. record short of its identity is refused as register.launch-only with nothing written', () => {
  test('a ready or launched record without `launched` (or with empty `cli` pids) is refused when a non-owner runs register', async () => {
    for (const stage of ['ready', 'launched'] as const) {
      const w = makeWorld();
      seedSeatRecord(w, 'lead', PANE_LEAD, { stage });
      const stateBefore = readFileSync(join(w.dir, STATE_FILE), 'utf8');

      const ioPlain = seatWalkIo(w, 'lead', PANE_LEAD);
      expect(await runRegister(['lead'], ioPlain, makeSources(w))).toBe(1);
      expect(ioPlain.err).toBe(
        `team register: lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n`,
      );
      expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
      expect(readState(w.dir).sessions.acme?.seats.lead?.launched).toBeUndefined();
      expect(readAgents(w.home)).toHaveLength(0);
      expect(existsSync(join(w.dir, LOG_FILE))).toBe(false);

      const ioJson = seatWalkIo(w, 'lead', PANE_LEAD);
      expect(await runRegister(['lead', '--json'], ioJson, makeSources(w))).toBe(1);
      assertJsonErrorShape(ioJson.out, {
        id: 'register.launch-only',
        messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
      });
      expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    }

    // Also test a record whose `launched` has an empty `cli` pid array (`{ shell: 400, cli: [] }`).
    const wEmptyCli = makeWorld();
    seedSeatRecord(wEmptyCli, 'lead', PANE_LEAD, {
      stage: 'ready',
      launched: { shell: 400, cli: [] },
    });
    const beforeEmpty = readFileSync(join(wEmptyCli.dir, STATE_FILE), 'utf8');
    const ioEmpty = seatWalkIo(wEmptyCli, 'lead', PANE_LEAD);
    expect(await runRegister(['lead', '--json'], ioEmpty, makeSources(wEmptyCli))).toBe(1);
    assertJsonErrorShape(ioEmpty.out, {
      id: 'register.launch-only',
      messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
    });
    expect(readFileSync(join(wEmptyCli.dir, STATE_FILE), 'utf8')).toBe(beforeEmpty);
    expect(readAgents(wEmptyCli.home)).toHaveLength(0);
  });
});

describe('3. replaced process in the same pane is refused as register.launch-only for non-owner callers', () => {
  test('a seat caller on a pane whose CLI pid or shell pid changed is refused as register.launch-only and the record stands unchanged', async () => {
    for (const stage of ['launched', 'ready'] as const) {
      for (const recordedLaunched of [
        { shell: 400, cli: [999] }, // replaced CLI pid
        { shell: 555, cli: [401] }, // replaced shell pid
      ]) {
        const w = makeWorld();
        seedSeatRecord(w, 'lead', PANE_LEAD, { stage, launched: recordedLaunched });
        const stateBefore = readFileSync(join(w.dir, STATE_FILE), 'utf8');

        const ioPlain = seatWalkIo(w, 'lead', PANE_LEAD);
        expect(await runRegister(['lead'], ioPlain, makeSources(w))).toBe(1);
        expect(ioPlain.err).toBe(
          `team register: lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n`,
        );
        expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
        expect(readState(w.dir).sessions.acme?.seats.lead?.launched).toEqual(recordedLaunched);
        expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe(stage);
        expect(readAgents(w.home)).toHaveLength(0);
        expect(existsSync(join(w.dir, LOG_FILE))).toBe(false);

        const ioJson = seatWalkIo(w, 'lead', PANE_LEAD);
        expect(await runRegister(['lead', '--json'], ioJson, makeSources(w))).toBe(1);
        assertJsonErrorShape(ioJson.out, {
          id: 'register.launch-only',
          messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
        });
        expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
      }
    }
  });
});

describe('4. dev-mode fold folds only the caller/approval gate and still refuses with register.launch-only', () => {
  test('TEAMCLI_DEV_MODE=1 folds the caller gate for an unplaced caller, then refuses first record, missing identity, and replaced process with register.launch-only', async () => {
    // (a) First record under dev mode:
    const wFirst = makeWorld();
    const ioFirst = testIo(wFirst.root, UNPLACED);
    ioFirst.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRegister(['lead'], ioFirst, makeSources(wFirst))).toBe(1);
    expect(ioFirst.err).toContain('team register: warning: only the owner or a seat of this team registers a running seat');
    expect(ioFirst.err).toContain(
      `team register: lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n`,
    );
    expect(existsSync(join(wFirst.dir, STATE_FILE))).toBe(false);
    expect(readAgents(wFirst.home)).toHaveLength(0);

    // Same under --json:
    const ioFirstJson = testIo(wFirst.root, UNPLACED);
    ioFirstJson.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRegister(['lead', '--json'], ioFirstJson, makeSources(wFirst))).toBe(1);
    assertJsonErrorShape(ioFirstJson.out, {
      id: 'register.launch-only',
      messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
    });
    expect(existsSync(join(wFirst.dir, STATE_FILE))).toBe(false);
    expect(readAgents(wFirst.home)).toHaveLength(0);

    // (b) Record short of identity under dev mode:
    const wShort = makeWorld();
    seedSeatRecord(wShort, 'lead', PANE_LEAD, { stage: 'ready' });
    const shortBefore = readFileSync(join(wShort.dir, STATE_FILE), 'utf8');
    const ioShort = testIo(wShort.root, UNPLACED);
    ioShort.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRegister(['lead', '--json'], ioShort, makeSources(wShort))).toBe(1);
    assertJsonErrorShape(ioShort.out, {
      id: 'register.launch-only',
      messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
    });
    expect(readFileSync(join(wShort.dir, STATE_FILE), 'utf8')).toBe(shortBefore);
    expect(readAgents(wShort.home)).toHaveLength(0);

    // (c) Replaced process under dev mode:
    const wReplaced = makeWorld();
    seedSeatRecord(wReplaced, 'lead', PANE_LEAD, { stage: 'launched', launched: { shell: 400, cli: [999] } });
    const replacedBefore = readFileSync(join(wReplaced.dir, STATE_FILE), 'utf8');
    const ioReplaced = testIo(wReplaced.root, UNPLACED);
    ioReplaced.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRegister(['lead', '--json'], ioReplaced, makeSources(wReplaced))).toBe(1);
    assertJsonErrorShape(ioReplaced.out, {
      id: 'register.launch-only',
      messageContains: `lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote`,
    });
    expect(readFileSync(join(wReplaced.dir, STATE_FILE), 'utf8')).toBe(replacedBefore);
    expect(readAgents(wReplaced.home)).toHaveLength(0);
  });
});

describe('5. dry runs are refused as register.launch-only with the owner unblock command and nothing written', () => {
  test('plain and --json dry runs for a seat caller and a dev-mode folded caller refuse with register.launch-only and write nothing', async () => {
    const w = makeWorld();
    seedSeatRecord(w, 'lead', PANE_LEAD, { stage: 'ready', launched: { shell: 400, cli: [401] } });
    const stateBefore = readFileSync(join(w.dir, STATE_FILE), 'utf8');

    // (a) Plain --dry-run by seat `lead` for `worker` (no record yet):
    const ioDry = seatWalkIo(w, 'lead', PANE_LEAD);
    expect(await runRegister(['worker', '--dry-run'], ioDry, makeSources(w))).toBe(1);
    expect(ioDry.err).toBe('');
    expect(ioDry.out).toBe(
      `! register would refuse: worker: pane ${PANE_WORKER} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n` +
        '! to unblock: the owner runs `team register worker` from a terminal outside herdr\n',
    );
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    expect(readAgents(w.home)).toHaveLength(0);
    expect(existsSync(join(w.dir, LOG_FILE))).toBe(false);

    // (b) --dry-run --json by seat `lead` for `worker`:
    const ioDryJson = seatWalkIo(w, 'lead', PANE_LEAD);
    expect(await runRegister(['worker', '--dry-run', '--json'], ioDryJson, makeSources(w))).toBe(1);
    expect(ioDryJson.err).toBe('');
    assertJsonErrorShape(ioDryJson.out, {
      id: 'register.launch-only',
      messageContains: `worker: pane ${PANE_WORKER} is not a process identity this record's launch wrote`,
    });
    expect(readFileSync(join(w.dir, STATE_FILE), 'utf8')).toBe(stateBefore);
    expect(readAgents(w.home)).toHaveLength(0);

    // (c) Dev-mode --dry-run with `--session acme` includes `--session acme` in the owner unblock command:
    const wDevDry = makeWorld();
    const ioDevDry = testIo(wDevDry.root, UNPLACED);
    ioDevDry.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRegister(['lead', '--session', 'acme', '--dry-run'], ioDevDry, makeSources(wDevDry))).toBe(1);
    expect(ioDevDry.err).toBe('');
    expect(ioDevDry.out).toContain(
      `! register would refuse: lead: pane ${PANE_LEAD} is not a process identity this record's launch wrote; only the owner records a pane root, from a terminal outside herdr\n`,
    );
    expect(ioDevDry.out).toContain(
      '! to unblock: the owner runs `team register lead --session acme` from a terminal outside herdr\n',
    );
    expect(existsSync(join(wDevDry.dir, STATE_FILE))).toBe(false);
    expect(readAgents(wDevDry.home)).toHaveLength(0);
    expect(existsSync(join(wDevDry.dir, LOG_FILE))).toBe(false);
  });
});

describe('6. a seat re-running register in its own unchanged pane exits 0 with its state record unchanged', () => {
  test('ready seat on its own unchanged pane exits 0, leaves seat state record unchanged, and refreshes registry record', async () => {
    const w = makeWorld();
    const seatId = seedSeatRecord(w, 'lead', PANE_LEAD, {
      stage: 'ready',
      launched: { shell: 400, cli: [401] },
      agentSession: 'lead-session-1',
    });
    const seatRecordBefore = readState(w.dir).sessions.acme?.seats.lead;

    const io = seatWalkIo(w, 'lead', PANE_LEAD);
    const code = await runRegister(['lead'], io, makeSources(w));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain(`lead: already registered — pane ${PANE_LEAD}`);
    // The seat's state record (`id`, `stage`, `pane`, `cli`, `launched`, `agent_session`) is unchanged.
    expect(readState(w.dir).sessions.acme?.seats.lead).toEqual(seatRecordBefore);
    expect(readState(w.dir).sessions.acme?.seats.lead?.launched).toEqual({
      shell: 400,
      cli: [401],
    });

    const agentRecord = findAgent(w.home, { team: teamIdOf(w.root), seat: 'lead' });
    expect(agentRecord).toBeDefined();
    expect(agentRecord?.seat_handle).toBe(seatId);
    expect(agentRecord?.provenance.registered_by).toBe('lead');
  });

  test('a seat whose launch recorded `stage: launched` with matching `launched` pids can complete registration in its own unchanged pane', async () => {
    const w = makeWorld();
    const seatId = seedSeatRecord(w, 'lead', PANE_LEAD, {
      stage: 'launched',
      launched: { shell: 400, cli: [401] },
    });

    const io = seatWalkIo(w, 'lead', PANE_LEAD);
    const code = await runRegister(['lead'], io, makeSources(w));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain(`lead: registered — pane ${PANE_LEAD}; nothing was launched`);
    expect(readState(w.dir).sessions.acme?.seats.lead).toMatchObject({
      id: seatId,
      stage: 'ready',
      pane: PANE_LEAD,
      cli: 'claude-code',
      launched: { shell: 400, cli: [401] },
    });
  });
});

describe('7. the owner walk records a fresh pane root, completes a missing identity, and adopts a replaced launched record', () => {
  test('owner walk records a fresh pane root on a seat with no prior state record', async () => {
    const w = makeWorld();
    const io = ownerWalkIo(w);

    const code = await runRegister(['worker'], io, makeSources(w));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain(`worker: registered — pane ${PANE_WORKER}; nothing was launched`);
    const workerState = readState(w.dir).sessions.acme?.seats.worker;
    expect(workerState?.stage).toBe('ready');
    expect(workerState?.pane).toBe(PANE_WORKER);
    expect(workerState?.launched).toEqual({ shell: 400, cli: [401] });

    const agentRecord = findAgent(w.home, { team: teamIdOf(w.root), seat: 'worker' });
    expect(agentRecord?.provenance.registered_by).toBe('owner');
  });

  test('owner walk completes a missing `launched` identity on an already-ready record', async () => {
    const w = makeWorld();
    const seatId = seedSeatRecord(w, 'lead', PANE_LEAD, { stage: 'ready' });
    const io = ownerWalkIo(w);

    const code = await runRegister(['lead'], io, makeSources(w));

    expect(code, io.err).toBe(0);
    expect(io.out).toContain(`lead: already registered — pane ${PANE_LEAD}`);
    expect(readState(w.dir).sessions.acme?.seats.lead).toMatchObject({
      id: seatId,
      stage: 'ready',
      pane: PANE_LEAD,
      launched: { shell: 400, cli: [401] },
    });
  });

  test('owner walk adopts a replaced process on a `stage: launched` record, while refusing a replaced process on `stage: ready` with register.replaced', async () => {
    // On `stage: launched`, the owner's walk records the new process identity:
    const wLaunched = makeWorld();
    seedSeatRecord(wLaunched, 'lead', PANE_LEAD, {
      stage: 'launched',
      launched: { shell: 400, cli: [999] },
    });
    const ioLaunched = ownerWalkIo(wLaunched);
    expect(await runRegister(['lead'], ioLaunched, makeSources(wLaunched))).toBe(0);
    expect(readState(wLaunched.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
    expect(readState(wLaunched.dir).sessions.acme?.seats.lead?.launched).toEqual({
      shell: 400,
      cli: [401],
    });

    // On `stage: ready`, the owner's walk hits `register.replaced` (not `register.launch-only`):
    const wReady = makeWorld();
    seedSeatRecord(wReady, 'lead', PANE_LEAD, {
      stage: 'ready',
      launched: { shell: 400, cli: [999] },
    });
    const ioReadyJson = ownerWalkIo(wReady);
    expect(await runRegister(['lead', '--json'], ioReadyJson, makeSources(wReady))).toBe(1);
    assertJsonErrorShape(ioReadyJson.out, {
      id: 'register.replaced',
      messageContains: `lead: pane ${PANE_LEAD} holds a process other than the one its record's launch started; the record was not refreshed`,
    });
    expect(readState(wReady.dir).sessions.acme?.seats.lead?.launched).toEqual({
      shell: 400,
      cli: [999],
    });
  });
});

// Independent coverage for A9 (builder-7): a restart stands aside for the session mutator lock
// before its first effect and refuses with the holder named; a launch — the relaunch itself, or
// `team register`'s live refresh — binds a record left holding an earlier incarnation's
// `seat_handle` to the live state id, so the native route binds again; and an ordinary write,
// which cannot prove the record is this seat's, leaves a stable handle alone and the reader says
// why.
//
// These fixtures are this file's own: the holder in the lock scenes is a real other process
// (`sleep`) whose token this test publishes, never a lock taken in the test's own process. The
// route is asserted where a send decides it — `recordedSeatSession` — never by sending.
//
// Round 2 pins operator-3's two review findings: a ready seat's same-pane refresh must not rebind
// its record to a handle another seat holds, nor lend it the conversation a replaced process
// reports while the launch identity the state records does not hold; and a restart whose registry
// write fails may not present a plain ready — the native route it could not bind is reported.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { findAgent, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T10:00:00Z');
const OWNER = { kind: 'owner' as const };
const LIVE = 'seat_0123456789ab';
const OTHER = 'seat_fedcba987654';
/** This seat's own handle, when the scenes need the state and the record to disagree. */
const OWN = 'seat_0000000000aa';
/** The handle another seat's live record holds, seeded into the state as the review did. */
const FOREIGN = OTHER;
// The bound the fix declares: 15 seconds in 200 ms poll steps. Written out rather than imported,
// so this file runs unchanged at the parent the fix is measured against.
const WAIT_STEPS = 15_000 / 200;
// Codex's own screens, captured from codex 0.161.0 — this repo's fixtures, read here so the
// relaunched pane draws a prompt the readiness reader accepts, and the old pane draws what the
// stop's exit text leaves.
const CODEX_OLD_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8');
const CODEX_EXIT_TYPED = readFileSync(new URL('./fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');
const CODEX_NEW_IDLE = CODEX_OLD_IDLE.replace('gpt-5.6-terra', 'gpt-6.1-sol').replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // The address refresh reads herdr on its own; no pane of this machine's is behind it here, and
  // an unreadable pane is the reading that leaves a record alone.
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
});

type Fixture = { base: string; root: string; home: string; dir: string };

function teamYaml(fixture: Fixture): string {
  return `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ${lobbyDir(fixture.home)}
  - ${fixture.root}
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
}

/** The same team with a Codex worker: its native route resumes by the record's agent session. */
function codexTeamYaml(fixture: Fixture): string {
  return teamYaml(fixture).replace(
    `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
    `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`,
  );
}

function makeFixture(yamlOf: (fixture: Fixture) => string = teamYaml): Fixture {
  const base = realpathSync(mkdtempSync('/private/tmp/team-a9t2-'));
  made.push(base);
  const home = join(base, 'home');
  // The placement gate reads the lobby's own mode: the fixture's lobby is the private one.
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const fixture = { base, root, home, dir: join(root, '.agents') };
  writeFileSync(join(fixture.dir, 'team.yaml'), yamlOf(fixture));
  return fixture;
}

/** A running worker on pane-old, its state naming the live id. */
function readyWorker(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    (state.sessions.acme ??= emptySession()).seats.worker = {
      stage: 'ready',
      pane: 'pane-old',
      workspace: 'ws-old',
      id: LIVE,
    };
  });
}

type Did = { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };

/** A fake herdr/launch world for one restart: the same seams the command reads, nothing real. */
function fakeRestart(
  fixture: Fixture,
  opts: { cli?: 'claude-code' | 'codex'; liveReportsSession?: boolean } = {},
): { sources: RestartSources; did: Did } {
  const did: Did = { typed: [], pasted: [], closed: [], created: 0, runs: [] };
  const codex = (opts.cli ?? 'claude-code') === 'codex';
  const argv0 = codex ? 'codex' : 'claude';
  // A live CLI that has not reported its conversation yet: herdr lists the agent, no session id.
  const liveSession = opts.liveReportsSession === false ? undefined : 'ses_relaunch';
  let workerAlive = true;
  let boxedText = claudeBox('');
  // The one exit text the stop types leaves the old pane back at its shell.
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const agents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        // The relaunched pane reports the conversation it actually started, as herdr does live —
        // unless this scene's CLI has not reported one yet.
        list.push({
          name: slot.name,
          agent: codex ? 'codex' : 'claude-code',
          pane,
          workspace: slot.workspace,
          status: 'idle',
          cwd: fixture.root,
          ...(liveSession === undefined ? {} : { session: liveSession }),
        });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter: () => {
      shelled = true;
      return true;
    },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      did.created += 1;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: codex ? CODEX_NEW_IDLE : CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? (codex ? CODEX_NEW_IDLE : CLAUDE_IDLE),
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (slot && pasted) {
        // Codex's composer takes the first line behind its prompt; Claude draws its own box.
        slot.text = codex
          ? CODEX_NEW_IDLE.replace('› Ask Codex to do anything', `› ${pasted[1] ?? ''}`)
          : claudeBox(pasted[1] ?? '');
      }
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) slot.text = codex ? CODEX_NEW_IDLE : CLAUDE_IDLE;
      return true;
    },
    agentStatus: () => 'idle',
    foreground: () => [argv0],
    // A pane whose shell and CLI process can be read: the launch records the seat's identity and
    // the conversation herdr reports for it, as a live launch does.
    processInfo: () => ({ shell: 300, foreground: [301] }),
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents,
    workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => (codex
      ? (pane === 'pane-old' ? (did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE)
      : boxedText),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [argv0]),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };

  return { sources, did };
}

/** The token file a lock holder publishes: `acquireSeatLock`'s own `<pid> <nonce>` form. */
function lockHeldBy(child: ReturnType<typeof spawn>, fixture: Fixture): string {
  mkdirSync(join(fixture.dir, 'seat-locks', 'acme'), { recursive: true });
  const path = seatLockPath(fixture.dir, 'acme', '.run');
  writeFileSync(path, `${child.pid} a9b2c0ffee\n`);
  return path;
}

describe('A9 independent: a restart waits for the session lock another process holds', () => {
  test('the whole wait is spent, the refusal names that process, and the seat is untouched', async () => {
    const fixture = makeFixture();
    readyWorker(fixture);
    const { sources, did } = fakeRestart(fixture);
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const path = lockHeldBy(child, fixture);
    try {
      let steps = 0;
      sources.upLaunch.sleep = async () => {
        steps += 1;
      };
      const before = readState(fixture.dir);
      const io = testIo(fixture.root, OWNER);

      expect(await runRestart(['worker'], io, sources)).toBe(1);
      // It stood aside first: the refusal is not the first reading's. The count is the bound the
      // product declares, in its own poll steps.
      expect(steps).toBe(WAIT_STEPS);
      expect(io.err).toBe(
        `team restart: another session-mutating run is holding session acme (pid ${child.pid}); try again when it is done\n`,
      );
      // Nothing was typed, closed or launched, and the state — the worker among it — is exactly
      // what it was: never a seat reported missing after a half stop.
      expect(did.typed).toEqual([]);
      expect(did.closed).toEqual([]);
      expect(did.created).toBe(0);
      expect(readState(fixture.dir)).toEqual(before);
      expect(readState(fixture.dir).sessions.acme?.seats.worker?.stage).toBe('ready');
    } finally {
      child.kill();
      try {
        unlinkSync(path);
      } catch {}
    }
  });

  test('a lock released inside the wait is taken, and the restart runs the whole stop and relaunch', async () => {
    const fixture = makeFixture();
    readyWorker(fixture);
    const { sources, did } = fakeRestart(fixture);
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const path = lockHeldBy(child, fixture);
    let steps = 0;
    sources.upLaunch.sleep = async () => {
      steps += 1;
      if (steps === 3) {
        // The other process ends and its lock goes: the wait's next reading must see it.
        child.kill();
        unlinkSync(path);
      }
    };
    try {
      const io = testIo(fixture.root, OWNER);
      expect(await runRestart(['worker'], io, sources)).toBe(0);
      expect(steps).toBe(3);
      expect(did.closed).toEqual(['ws-old']);
      expect(did.created).toBe(1);
      expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');
    } finally {
      child.kill();
      try {
        unlinkSync(path);
      } catch {}
    }
  });
});

/** The record a launch wrote in an earlier incarnation: another stable handle, the same seat. */
function seedRecordHoldingAnotherAgent(fixture: Fixture): { id: string } {
  readyWorker(fixture);
  updateState(fixture.dir, (state) => {
    const seat = state.sessions.acme!.seats.worker!;
    seat.agent_session = 'ses_live';
  });
  const record = registerAgent(fixture.home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: teamIdOf(fixture.root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: 'ses_live',
    },
    seat_handle: OTHER,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return { id: record.id };
}

function bindingOfSeat(fixture: Fixture, seat: string) {
  return recordedSeatSession({
    home: fixture.home,
    root: fixture.root,
    herdrSession: 'acme',
    seat: { name: seat, cli: 'claude-code' },
    state: readState(fixture.dir).sessions.acme?.seats[seat],
  });
}

function bindingOf(fixture: Fixture) {
  return bindingOfSeat(fixture, 'worker');
}

/** A seat's ready state, with the process identity its launch recorded and its conversation. */
function placeReadySeat(
  fixture: Fixture,
  seat: string,
  input: { pane: string; id: string; agentSession: string; launched: { shell: number; cli: number[] } },
): void {
  updateState(fixture.dir, (state) => {
    (state.sessions.acme ??= emptySession()).seats[seat] = {
      stage: 'ready',
      pane: input.pane,
      workspace: 'ws-1',
      id: input.id,
      agent_session: input.agentSession,
      launched: input.launched,
    };
  });
}

/** A seat's live registry record, written the way a launch writes it. */
function seedRecord(
  fixture: Fixture,
  seat: string,
  input: { handle: string; agentSession: string; pane: string; role: 'coordinator' | 'implementer' },
): { id: string } {
  const record = registerAgent(fixture.home, {
    name: seat,
    signing: { model: 'Claude Opus', version: '5.5', role: input.role },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: teamIdOf(fixture.root),
      seat,
      session: 'acme',
      pane: input.pane,
      address: null,
      agent_session: input.agentSession,
    },
    seat_handle: input.handle,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return { id: record.id };
}

/** The register command's own seams: herdr's list, the pane's process, the pane's screen. */
function registerSources(
  fixture: Fixture,
  input: { agents: HerdrAgent[]; process: { shell: number; foreground: number[] } },
): RegisterSources {
  return {
    home: fixture.home,
    sessionState: () => 'running',
    agents: () => input.agents,
    processInfo: () => input.process,
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
  };
}

describe('A9 independent: a launch binds a record left on another incarnation', () => {
  test('the relaunch rewrites the stale handle to the live state id, and the native route binds', async () => {
    const fixture = makeFixture();
    const seeded = seedRecordHoldingAnotherAgent(fixture);
    // The record cannot be proven this seat's: the live state names its own id and the record
    // another incarnation's handle. The route refuses before the restart.
    expect(bindingOf(fixture)).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });
    const { sources } = fakeRestart(fixture);
    const io = testIo(fixture.root, OWNER);

    expect(await runRestart(['worker'], io, sources)).toBe(0);
    // The resume read refused — correctly — and the fresh launch is the write that repairs the
    // record: state and record now agree on the live id.
    expect(io.err).toContain('not resuming its recorded session (the record is another agent for this seat)');
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.id).toBe(LIVE);
    const record = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(record?.id).toBe(seeded.id);
    expect(record?.seat_handle).toBe(LIVE);
    // The routing decision a send makes: the two team-owned records agree, so the seat takes its
    // native leg instead of a drop.
    const binding = bindingOf(fixture);
    expect(binding.kind).toBe('bound');
    if (binding.kind === 'bound') {
      // The live state's own id and the conversation the fresh launch set, both records agreeing
      // on them.
      expect(binding.recorded.seatHandle).toBe(LIVE);
      expect(binding.recorded.agentId).toBe(seeded.id);
      const liveSession = readState(fixture.dir).sessions.acme?.seats.worker?.agent_session;
      expect(typeof liveSession).toBe('string');
      expect(binding.recorded.sessionId).toBe(liveSession as string);
    }
  });

  test('team register\'s live refresh rewrites the stale handle to the live seat id too', async () => {
    const fixture = makeFixture();
    // A pane already holding the worker ready: the refresh branch, not a launch.
    const agent: HerdrAgent = {
      name: 'worker', agent: 'claude', pane: 'fixture-pane-1', workspace: 'ws-1', status: 'idle', cwd: null, session: 'claude-session-1',
    };
    const sources: RegisterSources = {
      home: fixture.home,
      sessionState: () => 'running',
      agents: () => [agent],
      processInfo: () => ({ shell: 400, foreground: [401] }),
      foreground: () => ['claude'],
      paneText: () => CLAUDE_IDLE,
      now: () => NOW,
    };
    const first = testIo(fixture.root, OWNER);
    expect(await runRegister(['worker'], first, sources)).toBe(0);
    const record = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    const seatId = readState(fixture.dir).sessions.acme?.seats.worker?.id;
    expect(record?.seat_handle).toBe(seatId);
    expect(seatId).toMatch(/^seat_[0-9a-f]{12}$/);
    // An earlier incarnation's handle left on the record while the live state names its own id.
    updateAgent(fixture.home, record!.id, { seat_handle: OTHER });
    expect(bindingOf(fixture)).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });

    const second = testIo(fixture.root, OWNER);
    expect(await runRegister(['worker'], second, sources)).toBe(0);
    expect(second.out).toContain('the record was refreshed from the file, nothing relaunched');
    // The refresh stands the record on the id it read from the live state: same record, same
    // state id, the handle rewritten to it.
    const after = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(after?.id).toBe(record?.id);
    expect(after?.seat_handle).toBe(seatId);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.id).toBe(seatId);
    expect(bindingOf(fixture).kind).toBe('bound');
  });
});

describe('A9 independent: an ordinary write leaves a handle it cannot prove', () => {
  test('only the launch and the refresh rebind; a plain write keeps another incarnation\'s handle, and the reader says why', () => {
    const fixture = makeFixture();
    const seeded = seedRecordHoldingAnotherAgent(fixture);
    const loaded = loadTeamFile(fixture.root, { home: fixture.home });
    if (!loaded.ok) throw new Error('fixture team does not validate');
    const seat = loaded.team.seats.find((item) => item.name === 'worker')!;

    // The same live state id and session, written by an ordinary launch write with no launch
    // authority: the stable handle is not its to rewrite.
    const wrote = registerLaunch({ home: fixture.home, team: loaded.team, root: fixture.root, by: 'owner' }, seat, 'pane-old', LIVE, 'ses_live');
    expect('id' in wrote && wrote.id).toBe(seeded.id);
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.seat_handle).toBe(OTHER);
    // Left alone, and said so: the route cannot bind the record and names it another agent's.
    expect(bindingOf(fixture)).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });
  });
});

describe('A9 round 2: a refresh needs proof before it rebinds', () => {
  test('a state id another seat\'s live record holds is not rebound to that seat\'s handle', async () => {
    const fixture = makeFixture();
    placeReadySeat(fixture, 'worker', {
      pane: 'fixture-pane-1', id: OWN, agentSession: 'worker-session', launched: { shell: 400, cli: [401] },
    });
    placeReadySeat(fixture, 'lead', {
      pane: 'pane-lead', id: FOREIGN, agentSession: 'lead-session', launched: { shell: 500, cli: [501] },
    });
    seedRecord(fixture, 'worker', { handle: OWN, agentSession: 'worker-session', pane: 'fixture-pane-1', role: 'implementer' });
    seedRecord(fixture, 'lead', { handle: FOREIGN, agentSession: 'lead-session', pane: 'pane-lead', role: 'coordinator' });
    // The corruption operator-3's first repro seeds: the worker's state names the handle its own
    // record does not hold and the lead's live record does.
    updateState(fixture.dir, (state) => {
      state.sessions.acme!.seats.worker!.id = FOREIGN;
    });
    const io = testIo(fixture.root, OWNER);
    const code = await runRegister(['worker'], io, registerSources(fixture, {
      agents: [
        { name: 'worker', agent: 'claude-code', pane: 'fixture-pane-1', workspace: 'ws-1', status: 'idle', cwd: null, session: 'worker-session' },
        { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: null, session: 'lead-session' },
      ],
      process: { shell: 400, foreground: [401] },
    }));

    // Whatever the refresh decides, it must not hand the worker a handle another seat's live
    // record holds: that is the identity the reader exists to refuse, not to confer. The lead's
    // own binding is untouched, so the two seats never share one handle.
    const workerRecord = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(workerRecord?.seat_handle).not.toBe(FOREIGN);
    const workerBinding = bindingOfSeat(fixture, 'worker');
    if (workerBinding.kind === 'bound') expect(workerBinding.recorded.seatHandle).not.toBe(FOREIGN);
    expect(bindingOfSeat(fixture, 'lead')).toMatchObject({ kind: 'bound', recorded: { seatHandle: FOREIGN } });
    // A refusal writes nothing and names whose handle it is.
    expect(code).toBe(1);
    expect(io.err).toContain("is lead's handle; the record was not refreshed");
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.seat_handle).toBe(OWN);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.id).toBe(FOREIGN);
  });

  test('a replaced process\'s reported conversation is not lent to the seat it stands for', async () => {
    const fixture = makeFixture();
    placeReadySeat(fixture, 'worker', {
      pane: 'fixture-pane-1', id: OWN, agentSession: 'worker-session', launched: { shell: 400, cli: [401] },
    });
    placeReadySeat(fixture, 'lead', {
      pane: 'pane-lead', id: FOREIGN, agentSession: 'lead-session', launched: { shell: 500, cli: [501] },
    });
    seedRecord(fixture, 'worker', { handle: OWN, agentSession: 'worker-session', pane: 'fixture-pane-1', role: 'implementer' });
    seedRecord(fixture, 'lead', { handle: FOREIGN, agentSession: 'lead-session', pane: 'pane-lead', role: 'coordinator' });
    const io = testIo(fixture.root, OWNER);
    const code = await runRegister(['worker'], io, registerSources(fixture, {
      // The pane reports another seat's conversation, and its process is not the one the
      // worker's launch recorded: neither reading is proof of this seat's continuity.
      agents: [
        { name: 'worker', agent: 'claude-code', pane: 'fixture-pane-1', workspace: 'ws-1', status: 'idle', cwd: null, session: 'lead-session' },
        { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: null, session: 'lead-session' },
      ],
      process: { shell: 999, foreground: [998] },
    }));

    const state = readState(fixture.dir).sessions.acme!.seats.worker!;
    const binding = bindingOfSeat(fixture, 'worker');
    // The state still records the identity the launch left (400/401); a refresh that could not
    // prove the pane's process is that launch must not adopt the pane's conversation on top of
    // it — the review's defect is both seats binding one conversation while the state keeps the
    // stale process. A refresh that binds the conversation must stand on the identity it saw.
    if (binding.kind === 'bound' && binding.recorded.sessionId === 'lead-session') {
      expect(state.launched).toEqual({ shell: 999, cli: [998] });
    }
    expect(state.agent_session === 'lead-session' && state.launched?.shell === 400).toBe(false);
    // The lead's own binding is untouched.
    expect(bindingOfSeat(fixture, 'lead')).toMatchObject({ kind: 'bound', recorded: { seatHandle: FOREIGN } });
    // A refusal names the changed process; nothing is written.
    expect(code).toBe(1);
    expect(io.err).toContain("holds a process other than the one its record's launch started; the record was not refreshed");
    expect(state.agent_session).toBe('worker-session');
    expect(state.launched).toEqual({ shell: 400, cli: [401] });
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.seat_handle).toBe(OWN);
  });
});

describe('A9 round 2: a restart reports a route it could not bind', () => {
  test('a failed registry write is not presented as a plain ready', async () => {
    const fixture = makeFixture();
    readyWorker(fixture);
    const { sources } = fakeRestart(fixture);
    // The registry cannot be written: the agents folder is a regular file.
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    writeFileSync(join(fixture.home, '.config', 'team', 'agents'), 'synthetic blocked registry\n');
    const io = testIo(fixture.root, OWNER);

    const code = await runRestart(['worker'], io, sources);

    // The launch reached its prompt and the state stands ready; the native route to it does not
    // bind, and the failure is the run's to report, not the log's alone.
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.stage).toBe('ready');
    expect(bindingOf(fixture)).toEqual({ kind: 'none', why: 'no agent record for this seat' });
    // The restart still says ready — the seat runs — but names the route it could not bind.
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new; pull-only: no agent record for this seat');
  });
});

describe('A9 round 3: a restart names a route the live reading cannot bind', () => {
  test('a Codex seat whose pane has not reported its session yet is not a plain ready', async () => {
    const fixture = makeFixture(codexTeamYaml);
    readyWorker(fixture);
    const { sources } = fakeRestart(fixture, { cli: 'codex', liveReportsSession: false });
    const io = testIo(fixture.root, OWNER);

    const code = await runRestart(['worker'], io, sources);

    const state = readState(fixture.dir).sessions.acme?.seats.worker;
    // The seat record was written and the state stands ready; what the live reading has not
    // reported is the conversation id Codex native delivery resumes by, so the route a send
    // decides on is refused for exactly that reason.
    expect(state?.stage).toBe('ready');
    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state,
    })).toEqual({ kind: 'none', why: 'the record names no agent session' });
    // The restart still says ready — the seat runs — but must name the route it could not bind.
    expect(code).toBe(0);
    expect(io.out).toContain('; pull-only: the record names no agent session');
  });
});

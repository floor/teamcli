// Independent tester scenes for the separate up-refresh source: `team up` refreshes an existing
// live seat's socket address at command entry — before any launch step — and again after the
// launch pass for seats this run started. The refresh is the send walk's proof, not a guess:
// one uniquely placed pane named for the seat, a live CLI whose name matches the record, the
// recorded launch-process identity still in front, a PID-owned live socket, a fresh inbound
// declaration, and a conditional (CAS) registry write of the record the helper read.
//
// The scenes below are written from that contract, never from the source's own tests. Every
// pane, process reading, socket, host, registry and provider here is synthetic: no live
// terminal host, no socket of the machine's own, no provider.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { reportedConversationProblem } from '../src/commands/send.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { findAgent, recordProvenSeatConversation, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T11:00:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const WORKER = 'worker';
const NOID = 'noid';
const WRAPPED = 'wrapped';
const SPARE = 'spare';
const SES = 'ses_a1b2c3d4e5f6';
const MODEL = 'Claude Opus';
const VERSION = '5.5';
const LAUNCH = 'claude --model claude-opus-5-5';
// A provider wrapper's own launcher line, a script this synthetic root does not have: the
// declaration reader finds no inbound word and the record's launch stays as it is.
const WRAPPED_LAUNCH = './scripts/launch-claude-here --model claude-opus-5-5';
// Neutral place ids: the fixtures name no real terminal host's pane or workspace.
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space-one';
const NOID_PANE = 'fixture-pane-noid';
const NOID_SPACE = 'fixture-space-noid';
const WRAPPED_PANE = 'fixture-pane-wrapped';
const WRAPPED_SPACE = 'fixture-space-wrapped';
const OTHER_PANE = 'fixture-pane-other';
const TWO_PANE = 'fixture-pane-two';
// The identity a launch recorded, and the pane reading that agrees with it. The state record
// keeps `cli` pids; the pane reading keeps them as `foreground`.
const RECORDED = { shell: 100, cli: [200] };
const NOID_RECORDED = { shell: 300, cli: [400] };
const WRAPPED_RECORDED = { shell: 500, cli: [600] };
const PANE_PROCESSES: PaneProcesses = { shell: 100, foreground: [200] };
const NOID_PROCESSES: PaneProcesses = { shell: 300, foreground: [400] };
const WRAPPED_PROCESSES: PaneProcesses = { shell: 500, foreground: [600] };
const MADE_PROCESSES: PaneProcesses = { shell: 700, foreground: [800] };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;
let sockets: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: 'ignore', env: gitEnv(),
  });
}

type Extra = { name: string; launch?: string; human?: boolean; stopped?: boolean };

/** A human lead and the seats a scene declares. The lead is never the refresh target. */
function teamText(extras: Extra[], humanLead = true): string {
  const seat = (one: Extra): string => `  - role: implementer
    name: ${one.name}
    label: ${one.name}
    cli: claude-code
    vendor: anthropic
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${one.launch ?? LAUNCH}
${one.human === true ? '    human: true\n' : ''}${one.stopped === true ? '    stopped: true\n' : ''}`;
  return `format: 1
project: acme
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
    model: ${MODEL}
    version: "${VERSION}"
    launch: ${LAUNCH}
${humanLead ? '    human: true\n' : ''}
${extras.map(seat).join('')}`;
}

function stand(extras: Extra[], humanLead = true): void {
  const text = teamText(extras, humanLead);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

const handleOf = (name: string): string => `seat_${name === WORKER ? '0123456789ab' : name === NOID ? '0123456789ac' : '0123456789ad'}`;

/** The record a launch left for the seat, on the pane and workspace the scene names. */
function recordSeat(
  name: string,
  over: { stage: 'ready' | 'launched'; pane: string; workspace: string; launched?: { shell: number; cli: number[] }; launch?: string },
): void {
  const held: SeatState = {
    stage: over.stage,
    id: handleOf(name),
    pane: over.pane,
    workspace: over.workspace,
    ...(over.launched === undefined ? {} : { launched: over.launched }),
    agent_session: SES,
    model: MODEL,
    version: VERSION,
    launch_line: over.launch ?? LAUNCH,
  };
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.seats[name] = held;
    // A live pane watch already carries this route: no watch of this run's own is started beside
    // it, so each scene reads the seat's record and nothing else.
    session.watch = { heartbeat: NOW.toISOString(), pane: 'fixture-watch-pane' };
  });
}

/** The agent record the system keeps for the seat, with the address the scene starts from. */
function registerSeat(
  name: string,
  over: { pane: string; address: string | null; launch?: string; session?: string; lifecycle?: 'running' | 'stopped' },
): void {
  registerAgent(home, {
    name,
    signing: { model: MODEL, version: VERSION, role: name === LEAD ? 'coordinator' : 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: over.launch ?? LAUNCH,
    reach: {
      team: teamIdOf(root), seat: name, session: over.session ?? SESSION, pane: over.pane, address: over.address, agent_session: SES,
    },
    seat_handle: handleOf(name),
    mcp: [],
    skills: [],
    lifecycle: over.lifecycle ?? 'running',
    by: 'team up',
  });
}

/** A socket on disk, stood in for by an empty file: the readers here are `existsSync` on the
 *  path. In the fixture folder, never the machine's own. */
function sock(pid: number): string {
  const path = join(sockets, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

const addressOf = (name: string): string | null => findAgent(home, { team: teamIdOf(root), seat: name })?.reach.address ?? null;

/** Put the fixture back where a second run in the same scene starts: the seat keeps its record,
 *  with no address. A witness write, so a scene can show the same world does write when the
 *  placement is proven and does not when it is not. */
function clearAddress(name: string): void {
  const agent = findAgent(home, { team: teamIdOf(root), seat: name });
  if (!agent) throw new Error(`the fixture lost the ${name} record`);
  updateAgent(home, agent.id, { reach: { address: null } });
}
const seatOf = (name: string): SeatState | undefined => readState(dir).sessions[SESSION]?.seats[name];
const said = (io: { out: string; err: string }): string => `${io.out}${io.err}`;
const teamLog = (): string => {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
};

type Made = { pane: string; workspace: string; label: string };

type WorldOptions = {
  agents?: (session: string, made: Made[]) => HerdrAgent[] | null;
  processInfo?: (session: string, pane: string, made: Made[]) => PaneProcesses | null;
  workspaces?: (session: string) => { id: string; label: string }[] | null;
  workspacePanes?: (session: string, workspace: string, made: Made[]) => string[] | null;
  paneText?: (session: string, pane: string, made: Made[]) => string | null;
  onCreate?: (label: string, pane: string, made: Made[]) => void;
  onProcessInfo?: (pane: string, made: Made[]) => void;
};

type Trace = {
  created: string[];
  runs: { pane: string; command: string }[];
  typed: { pane: string; text: string }[];
  closed: string[];
  renamed: { pane: string; name: string }[];
};

/** The host, session and panes one run reads. `made` grows as the run creates workspaces, so a
 *  scene's agent list and process readings can name the pane a launch just made. */
function makeWorld(opts: WorldOptions = {}): { sources: UpSources; trace: Trace; made: Made[]; reads: string[] } {
  const trace: Trace = { created: [], runs: [], typed: [], closed: [], renamed: [] };
  const made: Made[] = [];
  const reads: string[] = [];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const one = { pane: `fixture-made-pane-${made.length + 1}`, workspace: `fixture-made-space-${made.length + 1}`, label };
      made.push(one);
      trace.created.push(label);
      opts.onCreate?.(label, one.pane, made);
      return { pane: one.pane, workspace: one.workspace };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      return true;
    },
    typeText(_session, pane, text) {
      trace.typed.push({ pane, text });
      return true;
    },
    pressEnter: () => true,
    reportDisplayAgent: () => true,
    renameWorkspace: () => true,
    renameAgent(_session, pane, name) {
      trace.renamed.push({ pane, name });
      return true;
    },
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: (session) => (opts.agents?.(session, made) ?? []).map((one) => one.pane),
    agents: (session) => opts.agents?.(session, made) ?? [],
    workspacePanes(session, workspace) {
      const one = made.find((held) => held.workspace === workspace);
      if (one !== undefined) return [one.pane];
      return opts.workspacePanes?.(session, workspace, made) ?? null;
    },
    paneText: (session, pane) => opts.paneText?.(session, pane, made) ?? CLAUDE_IDLE,
    foreground: () => ['claude'],
    agentStatus: () => 'idle',
    processInfo(session, pane) {
      reads.push(pane);
      opts.onProcessInfo?.(pane, made);
      return opts.processInfo?.(session, pane, made) ?? null;
    },
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
    agents: (session) => opts.agents?.(session, made) ?? [],
    workspaces: (session) => opts.workspaces?.(session) ?? [{ id: SPACE, label: WORKER }],
    home,
    doctor,
    launch,
    sockets,
    now: () => NOW,
    sleep: async () => {},
  };
  return { sources, trace, made, reads };
}

const liveAgent = (name: string, pane: string, workspace: string, cli = 'claude'): HerdrAgent => ({
  name, agent: cli, pane, workspace, status: 'idle', cwd: root,
});

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-refresh-independent-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  sockets = join(base, 'socks');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("up's entry address refresh", () => {
  test('a live seat is refreshed before the run takes its first launch step', async () => {
    stand([{ name: WORKER }, { name: SPARE }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    const live = sock(200);
    // The spare seat is declared with no record: the run's first launch step creates its
    // workspace. Whatever the step does after that, the worker's address must already be the
    // socket its own live pane owns — the entry refresh ran first.
    let atFirstCreate: string | null | undefined;
    const made = makeWorld({
      agents: (_session, worlds) => [
        liveAgent(WORKER, PANE, SPACE),
        ...worlds.map((one) => liveAgent(one.label, one.pane, one.workspace)),
      ],
      processInfo: (_session, pane, worlds) => {
        if (pane === PANE) return PANE_PROCESSES;
        if (worlds.some((one) => one.pane === pane)) return MADE_PROCESSES;
        return null;
      },
      onCreate: () => {
        if (atFirstCreate === undefined) atFirstCreate = addressOf(WORKER);
      },
      workspaces: () => [{ id: SPACE, label: WORKER }],
      workspacePanes: (_session, workspace) => (workspace === SPACE ? [PANE] : null),
    });
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(made.trace.created, `up said:\n${said(io)}`).toContain(SPARE);
    expect(atFirstCreate, `up said:\n${said(io)}`).toBe(live);
    expect(addressOf(WORKER)).toBe(live);
  });

  test('a non-lead wrapper Claude seat is refreshed like any other claude-code seat', async () => {
    stand([{ name: WRAPPED, launch: WRAPPED_LAUNCH }]);
    recordSeat(WRAPPED, { stage: 'ready', pane: WRAPPED_PANE, workspace: WRAPPED_SPACE, launched: WRAPPED_RECORDED, launch: WRAPPED_LAUNCH });
    registerSeat(WRAPPED, { pane: WRAPPED_PANE, address: null, launch: WRAPPED_LAUNCH });
    const live = sock(600);
    const made = makeWorld({
      agents: () => [liveAgent(WRAPPED, WRAPPED_PANE, WRAPPED_SPACE)],
      processInfo: (_session, pane) => (pane === WRAPPED_PANE ? WRAPPED_PROCESSES : null),
      workspaces: () => [{ id: WRAPPED_SPACE, label: WRAPPED }],
      workspacePanes: (_session, workspace) => (workspace === WRAPPED_SPACE ? [WRAPPED_PANE] : null),
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), `up said:\n${said(io)}`).toBe(0);
    // The role is implementer, not lead, and its launch line is a wrapper's: neither is a gate.
    expect(made.trace.runs).toEqual([]);
    expect(addressOf(WRAPPED)).toBe(live);
  });
});

describe('explicit conversation repair on the recorded live pane', () => {
  const next = 'conversation-after-compaction';
  function ready(withSocket = true) {
    stand([{ name: WORKER }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    return withSocket ? sock(200) : join(sockets, '200.sock');
  }
  function world(options: { duplicate?: boolean; replaced?: boolean } = {}) {
    return makeWorld({
      agents: () => [
        { ...liveAgent(WORKER, PANE, SPACE), session: next },
        ...(options.duplicate ? [{ ...liveAgent(WORKER, TWO_PANE, SPACE), session: next }] : []),
      ],
      processInfo: () => options.replaced ? { shell: 100, foreground: [999] } : PANE_PROCESSES,
      workspaces: () => [{ id: SPACE, label: WORKER }],
      workspacePanes: () => [PANE],
    });
  }
  const binding = () => findAgent(home, { team: teamIdOf(root), seat: WORKER })?.reach.agent_session;

  test('team up repairs both bindings and keeps the live CLI in its pane', async () => {
    const socket = ready();
    const made = world();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources), said(io)).toBe(0);
    expect(binding()).toBe(next);
    expect(seatOf(WORKER)?.agent_session).toBe(next);
    expect(addressOf(WORKER)).toBe(socket);
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(reportedConversationProblem(findAgent(home, { team: teamIdOf(root), seat: WORKER })!, PANE,
      { agents: () => [{ name: WORKER, pane: PANE, cli: 'claude', session: next }] })).toBeNull();
    expect(teamLog()).toContain('rebound the live conversation on its recorded pane');
  });

  test('a missing live socket leaves both conversation bindings intact', async () => {
    ready(false);
    await runUp([], testIo(root, { kind: 'owner' }), world().sources);
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('a dry run leaves both old conversation bindings intact', async () => {
    ready();
    const io = testIo(root, { kind: 'owner' });
    await runUp(['--dry-run'], io, world().sources);
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(addressOf(WORKER)).toBeNull();
  });

  test('duplicate names never rebind the conversation', async () => {
    ready();
    await runUp([], testIo(root, { kind: 'owner' }), world({ duplicate: true }).sources);
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('reused pids in a new generation, another conversation and a live socket change neither binding nor anchors', async () => {
    ready();
    updateState(dir, (file) => {
      const held = file.sessions[SESSION]!.seats[WORKER]!;
      held.launched = { ...RECORDED, cli_start: [1_000_000] };
      held.pane_shell = RECORDED.shell;
      held.pane_shell_start = 999_000;
    });
    const before = seatOf(WORKER);
    const made = world();
    // The same pids, born later: a new generation the record does not name.
    made.sources.launch!.processStartOf = (pid) => (pid === 100 ? 5_000_000 : pid === 200 ? 5_001_000 : null);
    await runUp([], testIo(root, { kind: 'owner' }), made.sources, { nonInteractive: true });
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(seatOf(WORKER)?.launched).toEqual(before?.launched);
    expect(seatOf(WORKER)?.pane_shell_start).toBe(999_000);
    expect(made.trace.typed).toEqual([]);
  });

  test('a protected automatic restore leaves a present pane bound as before', async () => {
    ready();
    await runUp([], testIo(root, { kind: 'owner' }), world().sources,
      { nonInteractive: true, restore: true, restoreMissingOnly: true });
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('a replaced process cannot supply a new conversation binding', async () => {
    ready();
    await runUp([], testIo(root, { kind: 'owner' }), world({ replaced: true }).sources, { nonInteractive: true });
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('a successor registry record fences the state write too', () => {
    const socket = ready();
    const old = findAgent(home, { team: teamIdOf(root), seat: WORKER })!;
    const held = seatOf(WORKER)!;
    updateAgent(home, old.id, { reach: { agent_session: 'successor' } });
    expect(recordProvenSeatConversation(home, old, dir, held, next, socket)).toBe(false);
    expect(binding()).toBe('successor');
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('a successor state record fences the registry write too', () => {
    const socket = ready();
    const old = findAgent(home, { team: teamIdOf(root), seat: WORKER })!;
    const held = seatOf(WORKER)!;
    updateState(dir, (file) => { file.sessions[SESSION]!.seats[WORKER]!.agent_session = 'successor'; });
    expect(recordProvenSeatConversation(home, old, dir, held, next, socket)).toBe(false);
    expect(binding()).toBe(SES);
    expect(seatOf(WORKER)?.agent_session).toBe('successor');
  });
});

describe('one-seat rebind while the recorded CLI is working', () => {
  const next = 'conversation-during-working-turn';
  function ready(name = WORKER) {
    stand(name === LEAD ? [] : [{ name: WORKER }, { name: SPARE }], name !== LEAD);
    recordSeat(name, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(name, { pane: PANE, address: null });
    sock(200);
    return makeWorld({
      agents: () => [{ ...liveAgent(name, PANE, SPACE), session: next, status: 'working' }],
      processInfo: () => PANE_PROCESSES,
      paneText: () => 'Working…\nesc to interrupt',
      workspacePanes: () => [PANE],
    });
  }

  test('the calling lead can rebind its own working CLI without starting or closing anything', async () => {
    const made = ready(LEAD);
    const io = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: SESSION });
    expect(await runUp(['--rebind', LEAD], io, made.sources), said(io)).toBe(0);
    expect(seatOf(LEAD)?.agent_session).toBe(next);
    const agent = findAgent(home, { team: teamIdOf(root), seat: LEAD })!;
    expect(agent.reach.agent_session).toBe(next);
    expect(reportedConversationProblem(agent, PANE, { agents: () => [{ name: LEAD, pane: PANE, cli: 'claude', session: next }] })).toBeNull();
    expect(made.trace.created).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.typed).toEqual([]);
  });

  test('one-seat repair does not plan a missing sibling or read launch doctor and load checks', async () => {
    const made = ready();
    made.sources.doctor!.version = () => { throw new Error('launch doctor must not run'); };
    made.sources.machine = () => { throw new Error('launch load guard must not run'); };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(0);
    expect(seatOf(WORKER)?.agent_session).toBe(next);
    expect(seatOf(SPARE)).toBeUndefined();
    expect(findAgent(home, { team: teamIdOf(root), seat: SPARE })).toBeNull();
    expect(made.trace.created).toEqual([]);
    expect(made.trace.closed).toEqual([]);
  });

  test('a working dry run reports the rebind and leaves the old binding intact', async () => {
    const made = ready();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER, '--dry-run'], io, made.sources), said(io)).toBe(0);
    expect(io.out).toContain('would rebind');
    expect(io.out).not.toContain('skip');
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(findAgent(home, { team: teamIdOf(root), seat: WORKER })?.reach.agent_session).toBe(SES);
    expect(made.trace.created).toEqual([]);
  });

  test('a replaced process refuses the one-seat repair', async () => {
    const made = ready();
    made.sources.launch!.processInfo = () => ({ shell: 100, foreground: [999] });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(made.trace.runs).toEqual([]);
  });

  test('an unadmitted worker cannot use the repair path', async () => {
    const made = ready();
    const io = testIo(root, { kind: 'seat', name: WORKER, pane: PANE, session: SESSION });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(made.trace.created).toEqual([]);
  });

  test('the lead in another pane cannot use its recorded seat as the caller', async () => {
    const made = ready(LEAD);
    const io = testIo(root, { kind: 'seat', name: LEAD, pane: OTHER_PANE, session: SESSION });
    expect(await runUp(['--rebind', LEAD], io, made.sources), said(io)).toBe(1);
    expect(seatOf(LEAD)?.agent_session).toBe(SES);
    expect(findAgent(home, { team: teamIdOf(root), seat: LEAD })?.reach.agent_session).toBe(SES);
  });

  test('a reused pane reporting another CLI cannot rebind the seat', async () => {
    const made = ready();
    made.sources.launch!.agents = () => [{ ...liveAgent(WORKER, PANE, SPACE, 'codex'), session: next, status: 'working' }];
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('an unproved socket cannot rebind the seat', async () => {
    const made = ready();
    unlinkSync(join(sockets, '200.sock'));
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  test('a registry change during the proof refuses the state write', async () => {
    const made = ready();
    const concurrent = sock(900);
    made.sources.launch!.processInfo = () => {
      const agent = findAgent(home, { team: teamIdOf(root), seat: WORKER })!;
      updateAgent(home, agent.id, { reach: { address: concurrent } });
      return PANE_PROCESSES;
    };
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
    expect(addressOf(WORKER)).toBe(concurrent);
  });

  test('a state change during the proof refuses the registry write', async () => {
    const made = ready();
    made.sources.launch!.processInfo = () => {
      updateState(dir, (file) => { file.sessions[SESSION]!.seats[WORKER]!.agent_session = 'successor'; });
      return PANE_PROCESSES;
    };
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(seatOf(WORKER)?.agent_session).toBe('successor');
    expect(findAgent(home, { team: teamIdOf(root), seat: WORKER })?.reach.agent_session).toBe(SES);
  });

  test('the JSON repair plan names only the requested seat', async () => {
    const made = ready();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER, '--dry-run', '--json'], io, made.sources), said(io)).toBe(0);
    const result = JSON.parse(io.out);
    expect(result.seats).toEqual([WORKER]);
    expect(result.rebind).toEqual({ seat: WORKER, changed: true, applied: false });
    expect(result.plan).toEqual([]);
  });
});

describe('placement that cannot prove the seat never writes an address', () => {
  function readyWorker(): string {
    stand([{ name: WORKER }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    return sock(200);
  }

  function worldFor(agents: NonNullable<WorldOptions['agents']>): ReturnType<typeof makeWorld> {
    return makeWorld({
      agents,
      processInfo: (_session, pane) => (pane === PANE ? PANE_PROCESSES : null),
      workspacePanes: () => [PANE, TWO_PANE],
    });
  }

  /** The witness: the same fixture, with an unambiguous placement, is written. */
  async function provenWrites(live: string): Promise<void> {
    const made = worldFor(() => [liveAgent(WORKER, PANE, SPACE)]);
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(0);
    expect(addressOf(WORKER)).toBe(live);
    clearAddress(WORKER);
  }

  test('a duplicate herdr name for the seat writes nothing', async () => {
    const live = readyWorker();
    await provenWrites(live);
    const made = worldFor(() => [liveAgent(WORKER, PANE, SPACE), liveAgent(WORKER, TWO_PANE, SPACE)]);
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    // The socket is live and the process identity agrees, but two panes answer for one seat:
    // neither is proven, so the record keeps the address the witness write left cleared.
    expect(addressOf(WORKER)).toBeNull();
  });

  test('a pane the record does not name writes nothing', async () => {
    readyWorker();
    await provenWrites(sock(200));
    const made = worldFor(() => [liveAgent(WORKER, OTHER_PANE, SPACE)]);
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(addressOf(WORKER)).toBeNull();
  });

  test('an unreadable agent list writes nothing', async () => {
    readyWorker();
    await provenWrites(sock(200));
    const made = worldFor(() => null);
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(addressOf(WORKER)).toBeNull();
  });

  test('a live CLI that differs from the record writes nothing', async () => {
    readyWorker();
    await provenWrites(sock(200));
    const made = worldFor(() => [liveAgent(WORKER, PANE, SPACE, 'codex')]);
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(addressOf(WORKER)).toBeNull();
  });
});

describe('the record identity is the write gate', () => {
  test('a seat with no recorded process identity keeps its null address while its sibling is written', async () => {
    stand([{ name: WORKER }, { name: NOID }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    recordSeat(NOID, { stage: 'ready', pane: NOID_PANE, workspace: NOID_SPACE });
    registerSeat(WORKER, { pane: PANE, address: null });
    registerSeat(NOID, { pane: NOID_PANE, address: null });
    const workerLive = sock(200);
    sock(400);
    const made = makeWorld({
      agents: () => [liveAgent(WORKER, PANE, SPACE), liveAgent(NOID, NOID_PANE, NOID_SPACE)],
      processInfo: (_session, pane) => {
        if (pane === PANE) return PANE_PROCESSES;
        if (pane === NOID_PANE) return NOID_PROCESSES;
        return null;
      },
      workspaces: () => [
        { id: SPACE, label: WORKER },
        { id: NOID_SPACE, label: NOID },
      ],
      workspacePanes: (_session, workspace) => {
        if (workspace === SPACE) return [PANE];
        if (workspace === NOID_SPACE) return [NOID_PANE];
        return null;
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(0);
    // The sibling proves the world is refreshable; the record that names no process stays
    // untouched, because nothing this run read can tie it to a live process.
    expect(addressOf(WORKER)).toBe(workerLive);
    expect(addressOf(NOID)).toBeNull();
  });
});

describe('seats the refresh must not touch', () => {
  test('a stopped seat keeps its null address', async () => {
    stand([{ name: WORKER, stopped: true }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    sock(200);
    const made = makeWorld({
      agents: () => [liveAgent(WORKER, PANE, SPACE)],
      processInfo: (_session, pane) => (pane === PANE ? PANE_PROCESSES : null),
      workspacePanes: () => [PANE],
    });
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(addressOf(WORKER)).toBeNull();
  });

  test('a human seat keeps its null address', async () => {
    stand([{ name: WORKER, human: true }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    sock(200);
    const made = makeWorld({
      agents: () => [liveAgent(WORKER, PANE, SPACE)],
      processInfo: (_session, pane) => (pane === PANE ? PANE_PROCESSES : null),
      workspacePanes: () => [PANE],
    });
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(addressOf(WORKER)).toBeNull();
  });

  test('an automatic restore whose recorded pane is still present leaves the record as it is', async () => {
    stand([{ name: WORKER }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    const live = sock(200);
    const world = (): ReturnType<typeof makeWorld> => makeWorld({
      agents: () => [liveAgent(WORKER, PANE, SPACE)],
      processInfo: (_session, pane) => (pane === PANE ? PANE_PROCESSES : null),
      workspaces: () => [{ id: SPACE, label: WORKER }],
      workspacePanes: () => [PANE],
    });
    // The same world, run by the ordinary command, proves and writes the address.
    const plain = world();
    const first = testIo(root, { kind: 'owner' });
    expect(await runUp([], first, plain.sources), `up said:\n${said(first)}`).toBe(0);
    expect(addressOf(WORKER)).toBe(live);
    // An automatic restore may change a seat only while its original pane is proven absent.
    // The pane is present here, so the restore keeps the record — and its address with it.
    const agent = findAgent(home, { team: teamIdOf(root), seat: WORKER });
    if (!agent) throw new Error('the fixture lost the worker record');
    updateAgent(home, agent.id, { reach: { address: null } });
    const restore = world();
    const second = testIo(root, { kind: 'owner' });
    await runUp([], second, restore.sources, { nonInteractive: true, restore: true, restoreMissingOnly: true });
    expect(addressOf(WORKER)).toBeNull();
  });

  test('a dry run writes nothing', async () => {
    stand([{ name: WORKER }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    registerSeat(WORKER, { pane: PANE, address: null });
    sock(200);
    const made = makeWorld({
      agents: () => [liveAgent(WORKER, PANE, SPACE)],
      processInfo: (_session, pane) => (pane === PANE ? PANE_PROCESSES : null),
      workspacePanes: () => [PANE],
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--dry-run'], io, made.sources), `up said:\n${said(io)}`).toBe(0);
    expect(addressOf(WORKER)).toBeNull();
  });
});

describe("the post-launch refresh and its CAS write", () => {
  test('a seat this run launches is written after the launch pass', async () => {
    stand([{ name: WORKER }]);
    // A real launch writes the seat's settings file first and its process opens the socket
    // afterwards, so the socket postdates the declaration. The fixture writes it at workspace
    // creation, after this run's settings install, the same way round.
    let live = '';
    const made = makeWorld({
      agents: (_session, worlds) => worlds.map((one) => liveAgent(one.label, one.pane, one.workspace)),
      processInfo: (_session, pane, worlds) => (worlds.some((one) => one.pane === pane) ? MADE_PROCESSES : null),
      workspaces: () => [],
      onCreate: () => {
        live = sock(800);
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(0);
    expect(made.trace.created).toContain(WORKER);
    expect(seatOf(WORKER)?.stage).toBe('ready');
    expect(addressOf(WORKER)).toBe(live);
  });

  test('a record another writer changed between the read and the write is refused', async () => {
    stand([{ name: WORKER }]);
    // The launched seat's socket is written at workspace creation, after this run's settings
    // install, as a real launch's process opens it after its settings file is written.
    let concurrent = '';
    // The concurrent writer lands between the helper's registry read and its write: the pane
    // reading is the seam in between. A plain update bumps the record's provenance sequence, so
    // the conditional write must refuse and leave the other writer's address in place. Its own
    // socket is written as it lands, so it too postdates the launched settings.
    let raced = false;
    const made = makeWorld({
      agents: (_session, worlds) => worlds.map((one) => liveAgent(one.label, one.pane, one.workspace)),
      processInfo: (_session, pane, worlds) => {
        if (worlds.some((one) => one.pane === pane) && !raced
          && (new Error().stack ?? '').includes('refreshAddresses')) {
          raced = true;
          concurrent = sock(900);
          const agent = findAgent(home, { team: teamIdOf(root), seat: WORKER });
          if (agent) updateAgent(home, agent.id, { reach: { address: concurrent } });
        }
        return worlds.some((one) => one.pane === pane) ? MADE_PROCESSES : null;
      },
      workspaces: () => [],
      onCreate: () => {
        sock(800);
      },
    });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp([], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(0);
    expect(raced).toBe(true);
    expect(addressOf(WORKER)).toBe(concurrent);
    expect(teamLog()).toContain("its address record changed; the socket address was not written");
  });
});

describe('one-seat rebind across a machine restart', () => {
  const BOOT = Date.parse('2026-11-05T10:30:00Z');
  const BEFORE = Date.parse('2026-11-04T09:00:00Z');
  const AFTER = Date.parse('2026-11-05T10:34:00Z');
  const RESTORED: PaneProcesses = { shell: 700, foreground: [800] };
  function restored(opts: { shellStart?: number; session?: string } = {}) {
    stand([{ name: WORKER }]);
    recordSeat(WORKER, { stage: 'ready', pane: PANE, workspace: SPACE, launched: RECORDED });
    updateState(dir, (file) => {
      const held = file.sessions[SESSION]!.seats[WORKER]!;
      held.pane_shell = RECORDED.shell;
      if (opts.shellStart !== undefined) held.pane_shell_start = opts.shellStart;
    });
    registerSeat(WORKER, { pane: PANE, address: join(sockets, '200.sock') });
    const made = makeWorld({
      agents: () => [{ ...liveAgent(WORKER, PANE, SPACE), session: opts.session ?? SES }],
      processInfo: () => RESTORED,
      workspacePanes: () => [PANE],
    });
    made.sources.launch!.processStartOf = (pid) => (pid === 700 ? AFTER : pid === 800 ? AFTER + 1_000 : null);
    return made;
  }

  test('a pane restored with its recorded conversation is tied again, with no process started or closed', async () => {
    const made = restored({ shellStart: BEFORE });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(0);
    expect(io.out).toContain('across a restart');
    const held = seatOf(WORKER)!;
    expect(held.launched).toEqual({ shell: 700, cli: [800], cli_start: [AFTER + 1_000] });
    expect(held.pane_shell).toBe(700);
    expect(held.pane_shell_start).toBe(AFTER);
    expect(held.agent_session).toBe(SES);
    // The restart left no live socket for the old pid: the dead address is cleared, not kept.
    expect(addressOf(WORKER)).toBeNull();
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(made.trace.typed).toEqual([]);
  });

  test('a dry run says it would rebind and writes nothing', async () => {
    const made = restored({ shellStart: BEFORE });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER, '--dry-run'], io, made.sources), said(io)).toBe(0);
    expect(io.out).toContain('would rebind');
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a session restarted within this boot is tied again: its pane is a later start than the record', async () => {
    const made = restored({ shellStart: BOOT + 60_000 });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(0);
    expect(seatOf(WORKER)?.launched).toEqual({ shell: 700, cli: [800], cli_start: [AFTER + 1_000] });
    expect(seatOf(WORKER)?.pane_shell_start).toBe(AFTER);
  });

  test('a record no older than the live shell is refused, and nothing changes', async () => {
    const made = restored({ shellStart: AFTER });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(said(io)).toContain('not a later start than the recorded launch');
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a plain `team up` rebinds a restarted seat by itself, with no process started, closed or typed into', async () => {
    const made = restored({ shellStart: BEFORE });
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    const held = seatOf(WORKER)!;
    // The full anchors the typed proof needs, CLI start included: no later step of the run
    // writes a weaker reading over them.
    expect(held.launched).toEqual({ shell: 700, cli: [800], cli_start: [AFTER + 1_000] });
    expect(held.pane_shell).toBe(700);
    expect(held.pane_shell_start).toBe(AFTER);
    expect(held.agent_session).toBe(SES);
    expect(teamLog()).toContain(`${WORKER}: rebound to the live conversation on its recorded pane after a restart`);
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(made.trace.typed).toEqual([]);
  });

  test('`team up <other seat>` leaves a restarted seat it does not name exactly as it is', async () => {
    const made = restored({ shellStart: BEFORE });
    const io = testIo(root, { kind: 'owner' });
    await runUp([LEAD], io, made.sources, { nonInteractive: true });
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
    expect(seatOf(WORKER)?.pane_shell_start).toBe(BEFORE);
    expect(teamLog()).not.toContain(`${WORKER}: rebound`);
    expect(made.trace.renamed ?? []).toEqual([]);
  });

  test('a caller the ordinary map does not admit rebinds nothing', async () => {
    const made = restored({ shellStart: BEFORE });
    const io = testIo(root, { kind: 'seat', name: WORKER, pane: PANE, session: SESSION });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
    expect(teamLog()).not.toContain(`${WORKER}: rebound`);
  });

  test('a plain `team up` leaves a restarted pane whose conversation is not the recorded one as it is, and says so', async () => {
    const made = restored({ shellStart: BEFORE, session: 'ses_someone_else' });
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
    expect(seatOf(WORKER)?.pane_shell_start).toBe(BEFORE);
    expect(teamLog()).toContain(`${WORKER}: not rebound after a restart`);
    expect(made.trace.typed).toEqual([]);
  });

  test('a second pane reporting the conversation on the fresh read refuses the rebind', async () => {
    const made = restored({ shellStart: BEFORE });
    let reads = 0;
    made.sources.launch!.agents = () => {
      reads += 1;
      const own = { ...liveAgent(WORKER, PANE, SPACE), session: SES };
      return reads <= 2 ? [own] : [own, { ...liveAgent('other', 'w9:p1', 'w9'), session: SES }];
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a bare shell with a socket path still on disk is no rebind', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.processInfo = () => ({ shell: 700, foreground: [700] });
    writeFileSync(join(sockets, '700.sock'), '');
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a competing name on the pane, or the seat named on another pane, at the final read refuses the rebind', async () => {
    for (const late of [
      (own: HerdrAgent) => [{ ...own, name: 'intruder' }],
      (own: HerdrAgent) => [own, { ...liveAgent(WORKER, 'w9:p1', 'w9'), session: 'ses_elsewhere' }],
    ]) {
      const made = restored({ shellStart: BEFORE });
      let reads = 0;
      made.sources.launch!.agents = () => {
        reads += 1;
        const own = { ...liveAgent(WORKER, PANE, SPACE), session: SES };
        return reads <= 2 ? [own] : late(own);
      };
      const io = testIo(root, { kind: 'owner' });
      expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
      expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
    }
  });

  test('an intermediate process that changes between the proof and the final read refuses the rebind', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.processInfo = () => ({ shell: 700, foreground: [800, 802] });
    made.sources.launch!.processStartOf = (pid) => (pid === 700 ? AFTER : pid === 800 || pid === 802 ? AFTER + 1_000 : null);
    let walks = 0;
    made.sources.launch!.processParent = (pid) => {
      if (pid === 800) return { pid, ppid: 700, birth: 10 };
      if (pid === 802) return { pid, ppid: 801, birth: 30 };
      if (pid === 801) { walks += 1; return { pid, ppid: 800, birth: walks === 1 ? 20 : 25 }; }
      return null;
    };
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(said(io)).toContain('process tree changed');
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a conversation two panes report is not proof for either', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.agents = () => [{ ...liveAgent(WORKER, PANE, SPACE), session: SES }, { ...liveAgent('other', 'w9:p1', 'w9'), session: SES }];
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(said(io)).toContain('not reported by this pane alone');
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a record with no shell start is refused', async () => {
    const made = restored();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('a restored pane running another conversation is refused', async () => {
    const made = restored({ shellStart: BEFORE, session: 'ses_someone_else' });
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
    expect(seatOf(WORKER)?.agent_session).toBe(SES);
  });

  // The host restore clears every name (material's DeepSeek seat, 2026-11-16): the recorded pane
  // comes back unnamed, and placement by name alone refused it.
  const unnamed = (session = SES): HerdrAgent => ({ ...liveAgent(WORKER, PANE, SPACE), name: null, session });

  test('a restored pane the host left unnamed is tied again and named back', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.agents = () => [unnamed()];
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(0);
    expect(io.out).toContain('across a restart');
    expect(io.out).toContain('its pane is named back');
    expect(made.trace.renamed).toEqual([{ pane: PANE, name: WORKER }]);
    expect(seatOf(WORKER)?.launched).toEqual({ shell: 700, cli: [800], cli_start: [AFTER + 1_000] });
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(made.trace.typed).toEqual([]);
  });

  test('an unnamed pane is never tied without the restart proof', async () => {
    // The recorded pids still in front, but no name: nothing shows it is this seat's pane.
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.agents = () => [unnamed()];
    made.sources.launch!.processInfo = () => PANE_PROCESSES;
    sock(200);
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--rebind', WORKER], io, made.sources), said(io)).toBe(1);
    expect(made.trace.renamed).toEqual([]);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('an unnamed pane with another conversation, or a second pane named for the seat, is refused', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.agents = () => [unnamed('ses_someone_else')];
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    made.sources.launch!.agents = () => [unnamed(), { ...liveAgent(WORKER, OTHER_PANE, SPACE), session: SES }];
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(made.trace.renamed).toEqual([]);
    expect(seatOf(WORKER)?.launched).toEqual(RECORDED);
  });

  test('an unnamed pane running another CLI is refused', async () => {
    const made = restored({ shellStart: BEFORE });
    made.sources.launch!.agents = () => [{ ...unnamed(), agent: 'codex' }];
    expect(await runUp(['--rebind', WORKER], testIo(root, { kind: 'owner' }), made.sources)).toBe(1);
    expect(made.trace.renamed).toEqual([]);
  });
});

// The teamcli lead after the second restart on 2026-11-16: its record had stopped at `launched`,
// waiting at a question dialog, and the host restored its pane unnamed with the seat's own
// conversation in it. `team up` planned a fresh workspace resuming that conversation beside it.
describe('a waiting record whose pane the host restored with its own conversation', () => {
  const RESTORED_PANE: PaneProcesses = { shell: 700, foreground: [800] };
  function restoredWaiting(screen: string = CLAUDE_IDLE) {
    stand([{ name: WORKER }, { name: SPARE }]);
    recordSeat(WORKER, { stage: 'launched', pane: PANE, workspace: SPACE, launched: RECORDED });
    updateState(dir, (file) => {
      file.sessions[SESSION]!.seats[WORKER]!.waiting = { state: 'waiting-owner', classification: 'question' };
    });
    registerSeat(WORKER, { pane: PANE, address: null });
    // The host names the pane once a rename reaches it, as herdr does.
    const world = makeWorld({
      agents: (_session, worlds) => [
        {
          ...liveAgent(WORKER, PANE, SPACE),
          name: world.trace.renamed.some((one) => one.pane === PANE && one.name === WORKER) ? WORKER : null,
          session: SES,
        },
        ...worlds.map((one) => liveAgent(one.label, one.pane, one.workspace)),
      ],
      processInfo: (_session, pane, worlds) => {
        if (pane === PANE) return RESTORED_PANE;
        if (worlds.some((one) => one.pane === pane)) return MADE_PROCESSES;
        return null;
      },
      workspaces: () => [{ id: SPACE, label: WORKER }],
      workspacePanes: (_session, workspace) => (workspace === SPACE ? [PANE] : null),
      paneText: (_session, pane) => (pane === PANE ? screen : CLAUDE_IDLE),
    });
    return world;
  }

  // Round 1b review, finding 3: the conversation proves the pane is the seat, not that its
  // dialog has gone. A pane still showing the dialog, or one whose screen cannot be read, is
  // re-tied with its wait and stage kept.
  test('a restored pane still at its dialog is re-tied, and its wait is kept', async () => {
    const question = readFileSync(join(import.meta.dir, 'fixtures/claude-code/2.1.289/question-plain.txt'), 'utf8');
    const made = restoredWaiting(question);
    const io = testIo(root, { kind: 'owner' });
    await runUp(['--retie'], io, made.sources, { nonInteractive: true });
    expect(made.trace.created).toEqual([]);
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.typed).toEqual([]);
    expect(made.trace.renamed).toContainEqual({ pane: PANE, name: WORKER });
    const held = seatOf(WORKER)!;
    expect(held.stage).toBe('launched');
    expect(held.waiting).toEqual({ state: 'waiting-owner', classification: 'question' });
    expect(held.launched).toEqual({ shell: 700, cli: [800] });
    expect(said(io)).toContain('its screen is not at the idle prompt');
  });

  test('a restored pane whose screen cannot be read keeps its wait', async () => {
    // An empty reading: nothing on the screen proves the prompt.
    const made = restoredWaiting('');
    const io = testIo(root, { kind: 'owner' });
    await runUp(['--retie'], io, made.sources, { nonInteractive: true });
    expect(made.trace.created).toEqual([]);
    const held = seatOf(WORKER)!;
    expect(held.stage).toBe('launched');
    expect(held.waiting).toEqual({ state: 'waiting-owner', classification: 'question' });
  });

  test('team up adopts the pane where it stands and never launches a second copy', async () => {
    const made = restoredWaiting();
    const io = testIo(root, { kind: 'owner' });
    await runUp([], io, made.sources, { nonInteractive: true });
    expect(made.trace.created, `up said:\n${said(io)}`).not.toContain(WORKER);
    expect(made.trace.runs.filter((one) => one.pane === PANE)).toEqual([]);
    expect(made.trace.closed).not.toContain(SPACE);
    expect(made.trace.renamed).toContainEqual({ pane: PANE, name: WORKER });
    const held = seatOf(WORKER)!;
    expect(held.stage).toBe('ready');
    expect(held.waiting).toBeUndefined();
    expect(held.launched).toEqual({ shell: 700, cli: [800] });
    expect(held.agent_session).toBe(SES);
  });

  test('team up --retie re-ties it and launches the unrecorded seat nowhere', async () => {
    const made = restoredWaiting();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--retie'], io, made.sources, { nonInteractive: true }), `up said:\n${said(io)}`).toBe(0);
    expect(made.trace.created).toEqual([]);
    expect(made.trace.runs).toEqual([]);
    expect(made.trace.closed).toEqual([]);
    expect(said(io)).toContain(`${SPARE}: not launched: --retie only re-ties seats whose panes are running`);
    expect(made.trace.renamed).toContainEqual({ pane: PANE, name: WORKER });
    expect(seatOf(WORKER)?.stage).toBe('ready');
    expect(seatOf(SPARE)).toBeUndefined();
  });

  test('a dry --retie plans no launch', async () => {
    const made = restoredWaiting();
    const io = testIo(root, { kind: 'owner' });
    expect(await runUp(['--retie', '--dry-run'], io, made.sources), `up said:\n${said(io)}`).toBe(0);
    expect(io.out).toContain('not launched: --retie');
    expect(made.trace.created).toEqual([]);
    expect(seatOf(WORKER)?.stage).toBe('launched');
  });

  test('--retie takes no --rebind or --all', async () => {
    const io = testIo(root, { kind: 'owner' });
    stand([{ name: WORKER }]);
    expect(await runUp(['--retie', '--all'], io, makeWorld().sources)).toBe(2);
    expect(said(io)).toContain('--retie re-ties one running team');
  });
});

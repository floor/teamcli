// Independent coverage of context-reset slice 3 on feat/context-reset at 98574dbb6.
// Restart and down consume only a checkpoint the state read door kept for this terminal-host
// session. No checkpoint and no recorded conversation means the launch does not resume. --fresh
// still carries a verified checkpoint. A missing handover file does not stop the launch and says
// the checkpoint may be stale. Down writes that path on the session end. Fakes only: a throwaway
// home and a fake launch. No builder test is imported.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askCheckpoint } from '../src/checkpoint/checkpoint.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { beginSession, readStoreSessions, type SessionRecord } from '../src/sessions/registry.ts';
import { storePath } from '../src/store/store.ts';
import { emptySession, readState, STATE_FILE, updateState, type CheckpointRecord } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-04T12:00:00Z');
const SESSION = 'acme';

const YAML = (root: string): string => `format: 1
project: acme
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

type Fixture = { root: string; home: string; dir: string; team: TeamFile };
type Did = { typed: string[]; runs: string[] };

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) discardFixtures([path]); });

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-reset-s3-')));
  owned.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const text = YAML(root);
  writeFileSync(join(dir, 'team.yaml'), text);
  const parsed = validateTeamFile(text, { home, root });
  if (!parsed.ok) throw new Error(parsed.errors.map((problem) => problem.message).join('; '));
  return { root, home, dir, team: parsed.team };
}

function seedSeat(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead', id: 'seat_lead01234567' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

/** The two records a resume requires: the seat state's copy and the agent registry's, on one id. */
function bindConversation(fixture: Fixture, id = 'ses_keep'): string {
  updateState(fixture.dir, (state) => {
    const seat = state.sessions[SESSION]?.seats.worker;
    if (seat) seat.agent_session = id;
  });
  registerAgent(fixture.home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: {
      team: teamIdOf(fixture.root),
      seat: 'worker',
      session: SESSION,
      pane: 'pane-old',
      address: null,
      agent_session: id,
    },
    seat_handle: 'seat_0123456789ab',
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  return id;
}

function beginConversation(fixture: Fixture): string {
  const seat = fixture.team.seats.find((one) => one.name === 'worker');
  if (seat === undefined) throw new Error('fixture has no worker');
  const made = beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: SESSION,
    seat,
    pane: 'pane-old',
    workspace: 'ws-old',
    now: NOW,
  });
  if (!('id' in made)) throw new Error(made.note);
  return made.id;
}

/** A checkpoint the read door would keep, and the handover file when `written`. */
function askForWorker(fixture: Fixture, written: boolean, session = SESSION): string {
  const record = askCheckpoint(fixture.dir, 'worker', session, 'the owner', NOW);
  if (written) {
    mkdirSync(join(fixture.dir, 'handovers'), { recursive: true });
    writeFileSync(record.path, '# handover\nthe work left\n');
  }
  return record.path;
}

/** A record that looks complete and names a file that exists, but whose path is not one an ask mints. */
function plantUnverified(fixture: Fixture): string {
  const path = join(fixture.dir, 'planted-handover.md');
  writeFileSync(path, '# not an ask\n');
  const record: CheckpointRecord = {
    by: 'the owner',
    path,
    session: SESSION,
    at: NOW.toISOString(),
    deadline: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
  };
  const statePath = join(fixture.dir, STATE_FILE);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { checkpoints?: unknown };
  state.checkpoints = { worker: record };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

function makeHarness(fixture: Fixture): { sources: RestartSources; did: Did } {
  const did: Did = { typed: [], runs: [] };
  let leadAlive = true;
  let workerAlive = true;
  const boxes = new Map<string, string>();
  const shelled = new Set<string>();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    ...(leadAlive ? [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' as const, cwd: fixture.root }] : []),
    ...(workerAlive ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: fixture.root }] : []),
    ...[...newPanes.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle' as const, cwd: fixture.root,
    })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    if (workspace === 'ws-lead') leadAlive = false;
    if (workspace === 'ws-old') workerAlive = false;
    return true;
  };
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) { did.typed.push(text); boxes.set(pane, claudeBox(text)); return true; },
    sendKey: () => true,
    pressEnter(_session, pane) { shelled.add(pane); return true; },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace,
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
      newPanes.set('pane-new', { text: CLAUDE_IDLE, agent: false, name: null, workspace: 'ws-new' });
      return { pane: 'pane-new', workspace: 'ws-new' };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) { const slot = newPanes.get(pane); if (slot) slot.name = name; return true; },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, _pane, text) { did.typed.push(text); return true; },
    pressEnter(_session, pane) { const slot = newPanes.get(pane); if (slot) slot.text = CLAUDE_IDLE; return true; },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
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
  return {
    sources: {
      home: fixture.home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents(),
      workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session, pane) => boxes.get(pane) ?? claudeBox(''),
      status: () => 'idle',
      foreground: (_session, pane) => (shelled.has(pane) ? ['zsh'] : ['claude']),
      now: () => NOW,
      sleep: async () => {},
      launch: downLaunch,
      upLaunch,
      doctor,
    },
    did,
  };
}

function workerSessions(fixture: Fixture): SessionRecord[] {
  const read = readStoreSessions(storePath('acme', fixture.root, fixture.home), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions.filter((one) => one.seat === 'worker');
}

function logOf(fixture: Fixture): string {
  return readFileSync(join(fixture.dir, 'team.log'), 'utf8');
}

describe('context-reset slice 3: restart and down consume a verified checkpoint', () => {
  test('restart uses a checkpoint the read door kept and ignores a path an ask did not mint', async () => {
    const forged = makeFixture();
    seedSeat(forged);
    beginConversation(forged);
    const planted = plantUnverified(forged);
    expect(readState(forged.dir).checkpoints?.worker).toBeUndefined();
    const forgedRun = makeHarness(forged);
    const forgedIo = testIo(forged.root, { kind: 'owner' });
    expect(await runRestart(['worker'], forgedIo, forgedRun.sources), forgedIo.out + forgedIo.err).toBe(0);
    const forgedLog = logOf(forged);
    expect(forgedLog).not.toContain('using the handover already at');
    expect(forgedLog).not.toContain(planted);
    expect(forgedIo.out).not.toContain('may be stale');
    expect(forgedRun.did.runs.join('\n')).not.toContain(planted);
    for (const record of workerSessions(forged)) {
      expect(record.handover).toBeUndefined();
    }

    const other = makeFixture();
    seedSeat(other);
    beginConversation(other);
    const foreign = askForWorker(other, true, 'other-session');
    const otherRun = makeHarness(other);
    const otherIo = testIo(other.root, { kind: 'owner' });
    expect(await runRestart(['worker'], otherIo, otherRun.sources), otherIo.out + otherIo.err).toBe(0);
    expect(logOf(other)).not.toContain(foreign);
    expect(logOf(other)).not.toContain('using the handover already at');
    expect(otherIo.out).not.toContain('may be stale');
    expect(otherRun.did.runs.join('\n')).not.toContain(foreign);
    for (const record of workerSessions(other)) expect(record.handover).toBeUndefined();

    const kept = makeFixture();
    seedSeat(kept);
    beginConversation(kept);
    const path = askForWorker(kept, true);
    const keptRun = makeHarness(kept);
    const keptIo = testIo(kept.root, { kind: 'owner' });
    expect(await runRestart(['worker'], keptIo, keptRun.sources), keptIo.out + keptIo.err).toBe(0);
    expect(logOf(kept)).toContain(`worker: using the handover already at ${path}`);
    expect(keptRun.did.runs.join('\n')).toContain(`Your predecessor wrote a handover for you at ${path}`);
    expect(workerSessions(kept).some((record) => record.handover === path)).toBe(true);
  });

  test('no checkpoint and no recorded conversation means the launch does not resume', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources), io.out + io.err).toBe(0);
    expect(io.out).toContain('without passing the old transcript; no recorded conversation');
    expect(did.runs.join('\n')).not.toContain('--resume');
    expect(logOf(fixture)).not.toContain('using the handover already at');
    expect(io.out).not.toContain('may be stale');
    expect(workerSessions(fixture)).toHaveLength(1);
    expect(workerSessions(fixture)[0]?.handover).toBeUndefined();
  });

  test('--fresh carries the verified checkpoint and does not resume the recorded conversation', async () => {
    const resumed = makeFixture();
    seedSeat(resumed);
    const resumedPrior = beginConversation(resumed);
    bindConversation(resumed);
    const resumedPath = askForWorker(resumed, true);
    const resumedRun = makeHarness(resumed);
    const resumedIo = testIo(resumed.root, { kind: 'owner' });
    expect(await runRestart(['worker'], resumedIo, resumedRun.sources), resumedIo.out + resumedIo.err).toBe(0);
    expect(resumedRun.did.runs.join('\n')).toContain('claude --model claude-opus-5-5 --resume ses_keep');
    expect(resumedRun.did.runs.join('\n')).toContain(`Your predecessor wrote a handover for you at ${resumedPath}`);
    expect(workerSessions(resumed)[0]).toMatchObject({ id: resumedPrior, handover: resumedPath });

    const fixture = makeFixture();
    seedSeat(fixture);
    const prior = beginConversation(fixture);
    bindConversation(fixture);
    const path = askForWorker(fixture, true);
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--fresh'], io, sources), io.out + io.err).toBe(0);
    expect(logOf(fixture)).toContain(`worker: using the handover already at ${path}`);
    expect(io.out).toContain('started fresh by the caller');
    expect(io.out).toContain('without passing the old transcript');
    const launched = did.runs.join('\n');
    expect(launched).toContain(`Your predecessor wrote a handover for you at ${path}`);
    expect(launched).not.toContain('--resume');
    expect(launched).not.toContain('ses_keep');
    const sessions = workerSessions(fixture);
    expect(sessions[0]).toMatchObject({ id: prior, reason: 'restart', handover: path });
    expect(sessions[1]).toMatchObject({ handover: path, previous: prior });
  });

  test('a missing handover file does not stop the launch and says the checkpoint may be stale', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    const prior = beginConversation(fixture);
    const path = askForWorker(fixture, false);
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources), io.out + io.err).toBe(0);
    expect(did.runs.length).toBeGreaterThan(0);
    expect(did.runs.join('\n')).not.toContain('Your predecessor wrote a handover');
    expect(logOf(fixture)).toContain('worker: the handover request was not typed; the launch goes on');
    expect(io.out).toContain(`the checkpoint may be stale: no handover at ${path}`);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new');
    const sessions = workerSessions(fixture);
    expect(sessions[0]).toMatchObject({ id: prior, reason: 'restart', handover: path });
    expect(sessions[1]?.handover).toBeUndefined();
  });

  test('down carries the verified checkpoint path on the end event and not an unverified one', async () => {
    const verified = makeFixture();
    seedSeat(verified);
    const prior = beginConversation(verified);
    const path = askForWorker(verified, false);
    const verifiedIo = testIo(verified.root, { kind: 'owner' });
    expect(await runDown([], verifiedIo, makeHarness(verified).sources), verifiedIo.out + verifiedIo.err).toBe(0);
    expect(workerSessions(verified)).toEqual([
      expect.objectContaining({ id: prior, seat: 'worker', reason: 'owner-stop', handover: path }),
    ]);

    const forged = makeFixture();
    seedSeat(forged);
    const forgedPrior = beginConversation(forged);
    plantUnverified(forged);
    const forgedIo = testIo(forged.root, { kind: 'owner' });
    expect(await runDown([], forgedIo, makeHarness(forged).sources), forgedIo.out + forgedIo.err).toBe(0);
    const ended = workerSessions(forged);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ id: forgedPrior, reason: 'owner-stop' });
    expect(ended[0]?.handover).toBeUndefined();
  });
});

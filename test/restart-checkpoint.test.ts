// The checkpoint in a restart (context reset R2/R4): a standing ask is read inside the restart
// itself, so a hand restart and the watchdog's `team restart <seat>` get one rule. The file the
// old conversation wrote is carried by the chain — the end event names the ask's path whether or
// not the file came, the new session's start names it when one did — and the new conversation is
// told to read it before anything else. A missing file launches anyway and says the checkpoint
// may be stale; an ask left by another terminal-host session is not this restart's. Nothing is
// typed into the old conversation to ask: the ask is the record, and the seat writes the file.
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askCheckpoint } from '../src/checkpoint/checkpoint.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runSessions } from '../src/commands/sessions.ts';
import type { Launch } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { beginSession, readStoreSessions, type SessionRecord } from '../src/sessions/registry.ts';
import { storePath } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { RESTART_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-04T12:00:00Z');

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

type Fixture = { root: string; home: string; dir: string; file: string; team: TeamFile };

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) discardFixtures([path]); });

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join('/private/tmp', 'restart-checkpoint-')));
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
  const file = join(dir, 'team.yaml');
  writeFileSync(file, YAML(root));
  const parsed = validateTeamFile(YAML(root), { home, root });
  if (!parsed.ok) throw new Error('fixture team does not validate');
  return { root, home, dir, file, team: parsed.team };
}

/** The worker's old conversation: a session record the registry holds open, on the pane the
 *  faked terminal host lists for it. */
function beginConversation(fixture: Fixture): string {
  const seat = fixture.team.seats.find((one) => one.name === 'worker')!;
  const made = beginSession({
    home: fixture.home,
    root: fixture.root,
    team: fixture.team,
    session: 'acme',
    seat,
    pane: 'pane-old',
    workspace: 'ws-old',
    now: NOW,
  });
  if (!('id' in made)) throw new Error(made.note);
  return made.id;
}

/** The worker ready on its old pane, as `up` leaves it. */
function seedSeat(fixture: Fixture): void {
  updateState(fixture.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead', id: 'seat_lead01234567' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
  });
}

/** The standing ask for `worker`, and the handover file at its path when `written` — the seat
 *  writes the handover, so the scene writes it as the obedient conversation would. */
function askForWorker(fixture: Fixture, written: boolean, session = 'acme'): string {
  const record = askCheckpoint(fixture.dir, 'worker', session, 'the owner', NOW);
  if (written) {
    mkdirSync(join(fixture.dir, 'handovers'), { recursive: true });
    writeFileSync(record.path, '# handover\n\nwhat is left\n');
  }
  return record.path;
}

/** The live world a restart reads, at its smallest: two idle seats on their panes, a launch that
 *  makes one new pane, and the typed lines and closed panes it leaves behind. */
function makeHarness(fixture: Fixture): { sources: RestartSources; did: { typed: string[]; closed: string[]; runs: string[] } } {
  const did = { typed: [] as string[], closed: [] as string[], runs: [] as string[] };
  let leadAlive = true;
  let workerAlive = true;
  const boxes = new Map<string, string>();
  const shelled = new Set<string>();
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    ...(leadAlive
      ? [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle' as const, cwd: fixture.root }]
      : []),
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: fixture.root }]
      : []),
    ...[...newPanes.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name ?? '', agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle' as const, cwd: fixture.root,
    })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    did.closed.push(workspace);
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
    paneRun(_session, pane, command) { did.runs.push(command); const slot = newPanes.get(pane); if (slot) slot.agent = true; return true; },
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

/** The registry's folded records for the fixture's worker, oldest first. */
function workerSessions(fixture: Fixture): SessionRecord[] {
  const read = readStoreSessions(storePath('acme', fixture.root, fixture.home), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions.filter((one) => one.seat === 'worker');
}

describe('team restart reads the standing checkpoint', () => {
  test('a handover at the ask\'s path is carried by the whole chain and given to the new conversation', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    const prior = beginConversation(fixture);
    const path = askForWorker(fixture, true);
    const { sources, did } = makeHarness(fixture);

    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runRestart(['worker'], io, sources);
    expect(code, `${io.out}${io.err}`).toBe(0);

    // The file is used, never asked for: no line is typed into the old conversation but the exit.
    expect(did.typed).toEqual(['/exit']);
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain(`worker: using the handover already at ${path}`);
    // The new conversation is told to read it before anything else: the sentence rides the rules
    // the launch line carries for this CLI, as its option's own text.
    const sentence = `Your predecessor wrote a handover for you at ${path}; read it before anything else.`;
    expect(did.runs.join('\n')).toContain(sentence);

    // The chain: the old conversation's record ends naming the ask's path, and the new session's
    // start names it too, linked as the old one's next.
    const sessions = workerSessions(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: prior, seat: 'worker', ended: expect.any(String), reason: 'restart', handover: path });
    expect(sessions[1]).toMatchObject({ seat: 'worker', handover: path, previous: prior });
    expect(sessions[0]!.next).toBe(sessions[1]!.id);
    // The summary says the restart, with no stale-checkpoint line: the file was there.
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });

  test('no file at the ask\'s path launches anyway and says the checkpoint may be stale', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    const prior = beginConversation(fixture);
    const path = askForWorker(fixture, false);
    const { sources } = makeHarness(fixture);

    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runRestart(['worker'], io, sources);
    expect(code, `${io.out}${io.err}`).toBe(0);

    // The launch goes on: the seat is ready on a new pane, and the lead is told the checkpoint
    // may be stale, with the path the seat never answered.
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: the handover request was not typed; the launch goes on');
    expect(io.out).toContain(`team restart: restarted worker; pane pane-old -> pane-new; the checkpoint may be stale: no handover at ${path}\n`);

    // The chain holds from both sides anyway: the end names the ask's path — a path on the
    // record, never a claim the file exists — and the new session's start names none.
    const sessions = workerSessions(fixture);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ id: prior, reason: 'restart', handover: path });
    expect(sessions[1]).toMatchObject({ seat: 'worker', previous: prior });
    expect('handover' in sessions[1]! ? sessions[1]!.handover : undefined).toBeUndefined();
    expect(sessions[0]!.next).toBe(sessions[1]!.id);

    // The same run under --json: the published schema carries the ask's path as handover_asked.
    const jsonFixture = makeFixture();
    seedSeat(jsonFixture);
    beginConversation(jsonFixture);
    const asked = askForWorker(jsonFixture, false);
    const json = testIo(jsonFixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--json'], json, makeHarness(jsonFixture).sources)).toBe(0);
    const doc = assertMatchesOutputSchema<{ status: string; action_summary: string; handover_asked?: string }>(
      json.out,
      RESTART_OUTPUT_SCHEMA,
    );
    expect(doc.status).toBe('ready');
    expect(doc.handover_asked).toBe(asked);
    expect(doc.action_summary).toContain('the checkpoint may be stale');
  });

  test('an ask left by another terminal-host session is not this restart\'s', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    beginConversation(fixture);
    askForWorker(fixture, true, 'another-session');
    const { sources, did } = makeHarness(fixture);

    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runRestart(['worker'], io, sources);
    expect(code, `${io.out}${io.err}`).toBe(0);

    // The file is there, at the shape the ask mints, and none of it is this session's: no
    // handover is used, no stale line is said, and the chain carries no path on either side.
    expect(did.typed).toEqual(['/exit']);
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).not.toContain('using the handover already at');
    expect(log).not.toContain('the handover request was not typed');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    for (const record of workerSessions(fixture)) {
      expect('handover' in record ? record.handover : undefined).toBeUndefined();
    }
  });

  test('--fresh opts out of the resume, not of the checkpoint the boundary asked for', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    beginConversation(fixture);
    const path = askForWorker(fixture, true);
    const { sources } = makeHarness(fixture);

    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runRestart(['worker', '--fresh'], io, sources);
    expect(code, `${io.out}${io.err}`).toBe(0);
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain(`worker: using the handover already at ${path}`);
    const sessions = workerSessions(fixture);
    expect(sessions[0]).toMatchObject({ reason: 'restart', handover: path });
    expect(sessions[1]).toMatchObject({ handover: path });
  });

  test('team down carries the standing checkpoint\'s path on the end event and team sessions --json shows it', async () => {
    const fixture = makeFixture();
    seedSeat(fixture);
    const prior = beginConversation(fixture);
    const path = askForWorker(fixture, false);
    const { sources } = makeHarness(fixture);

    const io = testIo(fixture.root, { kind: 'owner' });
    const code = await runDown([], io, sources);
    expect(code, `${io.out}${io.err}`).toBe(0);

    const sessions = workerSessions(fixture);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: prior, seat: 'worker', reason: 'owner-stop', handover: path });

    const listed = testIo(fixture.root, { kind: 'owner' });
    expect(await runSessions(['worker', '--json'], listed, { home: fixture.home, now: () => NOW })).toBe(0);
    const payload = JSON.parse(listed.out) as { sessions: Array<{ id: string; reason: string; handover?: string }> };
    expect(payload.sessions).toEqual([expect.objectContaining({ id: prior, reason: 'owner-stop', handover: path })]);
  });
});

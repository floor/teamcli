// The session registry as the commands write it: `up` opens one record per launched seat,
// `restart` closes the old record as `restart` and links the next, and `down` closes every
// open record as `owner-stop`. The file is append-only past the history log's rotation cap,
// a registry that cannot be read is a note in the run's log, and `team sessions` reads the
// records the commands left, grouping them by model, team and entity.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runSessions } from '../src/commands/sessions.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { SESSIONS_FILE, readStoreSessions } from '../src/sessions/registry.ts';
import { LOG_FILE, readState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');
const OWNER = { kind: 'owner' as const };

const SEAT = (name: string, role: string, model: string): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: ${model}
    version: "5.5"
    launch: claude --model claude-${model === 'Claude Opus' ? 'opus' : 'sonnet'}-5-5
`;

function teamYaml(root: string, home: string): string {
  return `format: 1
project: acme
entity: acme-entity
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${home}/.config/team/lobbies/acme-entity
  - ${root}
workspace:
  mode: shared
seats:
${SEAT('lead', 'coordinator', 'Claude Opus')}${SEAT('worker', 'implementer', 'Claude Sonnet')}`;
}

type Fixture = { base: string; root: string; home: string; file: string; dir: string };

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An approved team the owner drives, with a git root the shared workspace names. */
function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-sessions-commands-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, teamYaml(root, home));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: readFileSync(file, 'utf8') },
    loaded.team.seats,
    home,
    NOW,
  );
  return { base, root, home, file, dir };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

type Slot = { name: string | null; workspace: string; running: boolean; box: string };
type World = {
  launch: Launch;
  down: DownLaunch;
  runs: { pane: string; command: string }[];
  slots: Map<string, Slot>;
  session: { state: 'absent' | 'running' };
  /** `up` reads an empty agent list as it does on a machine whose herdr has none yet; the stop
   *  commands read the agents the launch left. */
  reporting: { on: boolean };
};

/** The one fake herdr the whole chain stands in: a pane appears, its command runs, an agent is
 *  named, and a stop types into it, presses enter and frees it. */
function makeWorld(root: string): World {
  const slots = new Map<string, Slot>();
  const runs: { pane: string; command: string }[] = [];
  const session: { state: 'absent' | 'running' } = { state: 'absent' };
  const reporting = { on: false };
  let n = 0;
  const agents = (): HerdrAgent[] => (reporting.on ? [...slots]
    .filter(([, slot]) => slot.running)
    .map(([pane, slot]) => ({
      name: slot.name ?? pane,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle',
      cwd: root,
    })) : []);
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    for (const [pane, slot] of slots) if (slot.workspace === workspace) slots.delete(pane);
    return true;
  };
  /** The idle screen the seat's own launch line names, so up's model check reads the declared
   *  family and version off the pane instead of the capture's own Opus 5.5. */
  const screenFor = (command: string): string => {
    const named = /claude-(opus|sonnet)-(\d+)-(\d+)/.exec(command);
    if (!named) return CLAUDE_IDLE;
    const family = named[1] === 'opus' ? 'Opus' : 'Sonnet';
    return CLAUDE_IDLE.split('Opus 5.5').join(`${family} ${named[2]}.${named[3]}`);
  };
  const launch: Launch = {
    sessionState: () => session.state,
    startServer() {
      session.state = 'running';
      return true;
    },
    sessionUp: () => session.state === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      slots.set(pane, { name: null, workspace: `w${n}`, running: false, box: claudeBox('') });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      runs.push({ pane, command });
      const slot = slots.get(pane);
      if (slot) {
        slot.running = true;
        slot.box = screenFor(command);
      }
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = slots.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => [...slots.keys()],
    agents,
    paneText: (_session, pane) => {
      const slot = slots.get(pane);
      return slot?.running ? slot.box : '';
    },
    foreground: (_session, pane) => (slots.get(pane)?.running ? ['claude'] : ['zsh']),
    sleep: async () => {},
    now: () => NOW,
  };
  const down: DownLaunch = {
    typeText(_session, pane, text) {
      const slot = slots.get(pane);
      if (slot) slot.box = claudeBox(text);
      return true;
    },
    sendKey(_session, pane) {
      const slot = slots.get(pane);
      if (slot) slot.box = claudeBox('');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = slots.get(pane);
      if (slot) slot.running = false;
      return true;
    },
    agentPanes: () => [...slots.keys()],
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  return { launch, down, runs, slots, session, reporting };
}

function upSources(fixture: Fixture, world: World): UpSources {
  return {
    sessionRunning: () => world.session.state === 'running',
    sessionState: () => world.session.state,
    agents: () => world.launch.agents('acme'),
    home: fixture.home,
    doctor: doctor(fixture.home),
    launch: world.launch,
    now: () => NOW,
  };
}

function restartSources(fixture: Fixture, world: World): RestartSources {
  return {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => world.launch.agents('acme'),
    workspaces: () => [...world.slots.values()].map((slot) => ({ id: slot.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => world.slots.get(pane)?.box ?? claudeBox(''),
    status: () => 'idle',
    foreground: world.launch.foreground,
    now: () => NOW,
    sleep: async () => {},
    launch: world.down,
    upLaunch: world.launch,
    doctor: doctor(fixture.home),
  };
}

function downSources(fixture: Fixture, world: World): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => world.launch.agents('acme'),
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => world.slots.get(pane)?.box ?? claudeBox(''),
    status: () => 'idle',
    foreground: world.launch.foreground,
    now: () => NOW,
    home: fixture.home,
    launch: world.down,
  };
}

function storeOf(fixture: Fixture): string {
  return storePath('acme', fixture.root, fixture.home);
}

function registryPath(fixture: Fixture): string {
  return join(storeOf(fixture), SESSIONS_FILE);
}

function recordsOf(fixture: Fixture) {
  const read = readStoreSessions(storeOf(fixture), fixture.home);
  if (!read.ok) throw new Error(read.reason);
  return read.sessions;
}

describe('the commands write the session registry', () => {
  test('up opens one record per launched seat, holding the id TeamCLI set at launch', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    // A CLI session file naming another id: TeamCLI never reads it, so it never wins.
    const decoy = join(fixture.home, '.claude', 'projects', '-acme');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'decoy.jsonl'), `${JSON.stringify({ sessionId: 'DECOY-CLI-SESSION' })}\n`);

    const io = testIo(fixture.root, OWNER);
    expect(await runUp([], io, upSources(fixture, world)), io.err).toBe(0);

    const records = recordsOf(fixture);
    expect(records.map((record) => record.seat)).toEqual(['lead', 'worker']);
    for (const record of records) {
      expect(record).toMatchObject({
        entity: 'acme-entity',
        project: 'acme',
        team: 'acme',
        cli: 'claude-code',
        lab: 'anthropic',
        account: 'anthropic',
        herdr_session: 'acme',
        resumable: true,
      });
      expect(record.ended).toBeUndefined();
      expect(record.cli_session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(record.cli_session).not.toBe('DECOY-CLI-SESSION');
      // The id the record holds is the one on the launch line the pane ran.
      const ran = world.runs.find((one) => one.pane === record.pane);
      expect(ran?.command).toContain(`--session-id ${record.cli_session}`);
    }
    expect(records[0]?.model).toBe('Claude Opus');
    expect(records[1]?.model).toBe('Claude Sonnet');
    expect(JSON.stringify(records)).not.toContain('DECOY');
    // The seats the launch recorded are the seats the state holds.
    expect(Object.keys(readState(fixture.dir).sessions.acme?.seats ?? {}).sort()).toEqual(['lead', 'worker']);
  });

  test('restart closes as restart and links the next; down closes every open record', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);
    world.reporting.on = true;
    const afterUp = recordsOf(fixture);
    expect(afterUp.map((record) => [record.seat, record.ended])).toEqual([['lead', undefined], ['worker', undefined]]);

    const restarted = testIo(fixture.root, OWNER);
    expect(await runRestart(['worker'], restarted, restartSources(fixture, world)), restarted.err).toBe(0);
    const afterRestart = recordsOf(fixture);
    expect(afterRestart.map((record) => record.seat)).toEqual(['lead', 'worker', 'worker']);
    const [lead, firstWorker, secondWorker] = afterRestart;
    expect(lead?.ended).toBeUndefined();
    expect(firstWorker?.ended).toBeDefined();
    expect(firstWorker).toMatchObject({ seat: 'worker', reason: 'restart', next: secondWorker?.id });
    expect(firstWorker?.previous).toBeUndefined();
    expect(secondWorker).toMatchObject({ seat: 'worker', previous: firstWorker?.id });
    expect(secondWorker?.ended).toBeUndefined();

    const stopped = testIo(fixture.root, OWNER);
    expect(await runDown([], stopped, downSources(fixture, world)), stopped.err).toBe(0);
    const afterDown = recordsOf(fixture);
    expect(afterDown.map((record) => [record.seat, record.reason])).toEqual([
      ['lead', 'owner-stop'],
      ['worker', 'restart'],
      ['worker', 'owner-stop'],
    ]);
    expect(afterDown.every((record) => record.ended !== undefined)).toBe(true);
  });

  test('the registry is append-only across restart and down, byte for byte', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);
    world.reporting.on = true;
    const afterUp = readFileSync(registryPath(fixture), 'utf8');

    expect(await runRestart(['worker'], testIo(fixture.root, OWNER), restartSources(fixture, world))).toBe(0);
    const afterRestart = readFileSync(registryPath(fixture), 'utf8');
    expect(afterRestart.startsWith(afterUp)).toBe(true);
    expect(afterRestart.length).toBeGreaterThan(afterUp.length);

    expect(await runDown([], testIo(fixture.root, OWNER), downSources(fixture, world))).toBe(0);
    const afterDown = readFileSync(registryPath(fixture), 'utf8');
    expect(afterDown.startsWith(afterRestart)).toBe(true);
    expect(afterDown.length).toBeGreaterThan(afterRestart.length);
  });

  test('the registry never rotates, even past the history log\'s cap', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    const store = storeOf(fixture);
    mkdirSync(store, { recursive: true });
    // A line this version does not write, far past the 1,000,000-byte cap that makes the
    // history log rotate. The session registry asks for no rotation, so it stays.
    const filler = `${JSON.stringify({ event: 'ignored', pad: 'x'.repeat(1_000_100) })}\n`;
    writeFileSync(registryPath(fixture), filler);

    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);

    const text = readFileSync(registryPath(fixture), 'utf8');
    expect(text.startsWith(filler)).toBe(true);
    expect(text.length).toBeGreaterThan(filler.length);
    expect(recordsOf(fixture)).toHaveLength(2);
  });

  test('a registry that cannot be read is a note in the run\'s log, not a refusal', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    const store = storeOf(fixture);
    mkdirSync(join(store, SESSIONS_FILE), { recursive: true });

    const io = testIo(fixture.root, OWNER);
    expect(await runUp([], io, upSources(fixture, world)), io.err).toBe(0);
    const log = readFileSync(join(fixture.dir, LOG_FILE), 'utf8');
    expect(log).toContain('the session registry path is a directory');

    // The same condition refuses the listing by name, with its own exit.
    const listed = testIo(fixture.root, OWNER);
    expect(await runSessions([], listed, { home: fixture.home, now: () => NOW })).toBe(1);
    expect(listed.err).toContain('the session registry path is a directory');
  });
});

describe('team sessions over the records the commands wrote', () => {
  test('a record with no cost reads unknown, never zero', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);

    const io = testIo(fixture.root, OWNER);
    expect(await runSessions([], io, { home: fixture.home, now: () => NOW })).toBe(0);
    expect(io.out.startsWith('2 sessions\n')).toBe(true);
    // One COST cell per record, and neither is a zero.
    expect((io.out.match(/unknown/g) ?? []).length).toBe(2);
    expect(io.out).not.toContain('0 USD');

    const json = testIo(fixture.root, OWNER);
    expect(await runSessions(['--json'], json, { home: fixture.home, now: () => NOW })).toBe(0);
    const payload = JSON.parse(json.out) as { sessions: Record<string, unknown>[] };
    for (const record of payload.sessions) {
      expect('cost' in record).toBe(false);
      expect('tokens' in record).toBe(false);
    }
  });

  test('the listing groups by model, team and entity, and names the unknown buckets', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);
    // A second project on the machine, with no model and no entity.
    const other = join(fixture.home, '.config', 'team', 'beta-0123456789ab');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, SESSIONS_FILE), `${JSON.stringify({
      event: 'start',
      ts: NOW.toISOString(),
      id: 'ses_0000000000bb',
      project: 'beta',
      team: 'beta',
      seat: 'one',
      cli: 'codex',
      lab: 'openai',
      account: 'openai',
      herdr_session: 'beta',
    })}\n`);

    const byModel = testIo(fixture.root, OWNER);
    expect(await runSessions(['--by', 'model'], byModel, { home: fixture.home, now: () => NOW })).toBe(0);
    expect(byModel.out).toContain('model: Claude Opus');
    expect(byModel.out).toContain('model: Claude Sonnet');
    expect(byModel.out).toContain('model: unknown model');
    expect(byModel.out.indexOf('model: Claude Opus')).toBeLessThan(byModel.out.indexOf('model: Claude Sonnet'));

    const byTeam = testIo(fixture.root, OWNER);
    expect(await runSessions(['--by', 'team'], byTeam, { home: fixture.home, now: () => NOW })).toBe(0);
    expect(byTeam.out).toContain('team: acme');
    expect(byTeam.out).toContain('team: beta');

    const byEntity = testIo(fixture.root, OWNER);
    expect(await runSessions(['--by', 'entity'], byEntity, { home: fixture.home, now: () => NOW })).toBe(0);
    expect(byEntity.out).toContain('entity: acme-entity');
    expect(byEntity.out).toContain('entity: no entity');

    // A seat filter inside a group: one record, one group.
    const leadOnly = testIo(fixture.root, OWNER);
    expect(await runSessions(['lead', '--by', 'model'], leadOnly, { home: fixture.home, now: () => NOW })).toBe(0);
    expect(leadOnly.out.startsWith('1 session\n')).toBe(true);
    expect(leadOnly.out).toContain('model: Claude Opus');
    expect(leadOnly.out).not.toContain('Claude Sonnet');
    expect(leadOnly.out).not.toContain('unknown model');
  });

  test('a torn last line never hides the records before it', async () => {
    const fixture = makeFixture();
    const world = makeWorld(fixture.root);
    expect(await runUp([], testIo(fixture.root, OWNER), upSources(fixture, world))).toBe(0);
    appendFileSync(registryPath(fixture), '{"event":"start","ts":');

    const json = testIo(fixture.root, OWNER);
    expect(await runSessions(['--json'], json, { home: fixture.home, now: () => NOW })).toBe(0);
    const payload = JSON.parse(json.out) as { sessions: unknown[] };
    expect(payload.sessions).toHaveLength(2);
  });
});

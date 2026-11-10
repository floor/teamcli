// Independent scenes for the inbound-accept default, written by the tester rather than the
// change's author. The claims:
//
//   1. a claude-code seat this build launched (its generated settings file is on the launch
//      line) accepts by default: with no team-file `inbound` word at all, a send walks the
//      socket and the frame is dialed;
//   2. an explicit team-file `hold` or `refuse` keeps the socket out even though the generated
//      settings declare accept: no frame is dialed, and `team route` answers the precise
//      ineligible sentence naming the team file's word;
//   3. a generated settings file carrying no `crossSessionInbound` word (an old file a restart
//      has not regenerated yet) is ineligible, and the route names the file it read;
//   4. the default narrows nothing about admission: a seat of another team is still refused,
//      with no frame dialed and nothing written;
//   5. a plain restart regenerates a hook file with no inbound value so that it declares
//      accept, while an explicit team-file hold or refuse still wins.
//
// Fake hosts and temporary homes: no live pane is typed into and no real socket is dialed.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runRoute } from '../src/commands/route.ts';
import { runSend } from '../src/commands/send.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { PROJECT_RULE_SUMMARY, RULE_SUMMARY } from '../src/send/admit.ts';
import { readHistory } from '../src/send/history.ts';
import { routesPath } from '../src/send/routes.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, shortSocketBase, testIo } from './helpers.ts';
import { NOW, fake, owner, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's generated settings file, and the socket its pane exposes. The
 *  declaration predates the socket: the session was started after the launcher wrote it. */
function generatedDeclaring(made: World, seat: string, word: string | null): string {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: word }));
  const declaredAt = new Date(Date.now() - 60_000);
  utimesSync(path, declaredAt, declaredAt);
  writeFileSync(join(made.sockets, '222.sock'), '');
  return path;
}

/** The old-shape hook file: a settings document with no inbound word at all, as a build
 *  written before the accept default left it. The socket is newer than the file. */
function generatedWithoutWord(made: World, seat: string): string {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{\n  "hooks": {}\n}\n');
  const declaredAt = new Date(Date.now() - 60_000);
  utimesSync(path, declaredAt, declaredAt);
  writeFileSync(join(made.sockets, '222.sock'), '');
  return path;
}

/** The extra seat's team-file block gets an explicit inbound word: the launch line is written
 *  to be unique in the file so the scene edits exactly that block. */
function teamWordOn(made: World, launch: string, word: 'hold' | 'refuse'): void {
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  const line = `    launch: ${launch}\n`;
  if (text.split(line).length !== 2) throw new Error(`${path}: the scene's launch line is not unique`);
  writeFileSync(path, text.replace(line, `${line}    inbound: ${word}\n`));
}

/** The state record a launch leaves for a seat: the pane it stands on. */
function place(made: World, seat: string, pane: string): void {
  updateState(made.dir, (state) => {
    const one = (state.sessions.acme ??= emptySession());
    one.seats[seat] = { stage: 'launched', pane, workspace: 'fixture-ws' };
  });
}

/** The seat's signed agent record: the route answers the address it holds. */
function registerSeat(made: World, seat: string, pane: string): string {
  return registerAgent(made.home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(made.root), seat, session: 'acme', pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  }).id;
}

/** The team registry record and roster the route reads: the seat is one of this team's. */
function roster(made: World, agent: string, seat: string, role: string): void {
  upsertTeam(made.home, teamIdOf(made.root), {
    project: 'acme',
    session: 'acme',
    root: realpathSync(made.root),
    roster: [{ agent, seat, role }],
    at: NOW.toISOString(),
  });
}

function routeLines(made: World): Record<string, unknown>[] {
  return readFileSync(routesPath('acme', made.root, made.home), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastHistory(made: World): Record<string, unknown> {
  const history = readHistory('acme', made.root, made.home);
  if (!history.ok) throw new Error(`the history does not read: ${history.reason}`);
  const entry = history.entries.at(-1);
  if (entry === undefined) throw new Error('the send wrote no history line');
  return entry as unknown as Record<string, unknown>;
}

test('a generated seat with no team-file inbound word is socket-eligible by default: the send dials it', async () => {
  const made = world(null, [{ name: 'silent', role: 'implementer' }]);
  cleanup = made.cleanup;
  // This build's generated file on the launch line is the attestation: no team word is needed.
  generatedDeclaring(made, 'silent', 'accept');
  place(made, 'silent', 'fixture-pane-a');
  const dialed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'silent', pane: 'fixture-pane-a', cli: 'claude' }],
    deliver: async (_socket: string, frame: string) => {
      dialed.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['silent', 'a note'], io, host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(dialed).toHaveLength(1);
  expect(dialed[0]).toContain('a note');
  expect(io.out).toContain('silent: delivered (socket)');
  expect(lastHistory(made)).toMatchObject({ to: 'silent', outcome: 'delivered', via: 'socket' });
});

test('an explicit team-file hold keeps the socket out though the generated file declares accept: never dialed', async () => {
  const made = world(null, [{ name: 'silent', role: 'implementer', launch: 'claude --model fixture-model' }]);
  cleanup = made.cleanup;
  teamWordOn(made, 'claude --model fixture-model', 'hold');
  generatedDeclaring(made, 'silent', 'accept');
  const silentId = registerSeat(made, 'silent', 'fixture-pane-a');
  place(made, 'silent', 'fixture-pane-a');
  roster(made, silentId, 'silent', 'implementer');
  const dialed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'silent', pane: 'fixture-pane-a', cli: 'claude' }],
    deliver: async (_socket: string, frame: string) => {
      dialed.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  const code = await runSend(['silent', 'a note'], io, host);

  // The walk falls past the socket to the drop leg, and no frame ever leaves.
  expect(code).toBe(1);
  expect(dialed).toEqual([]);
  expect(host.frames).toEqual([]);
  expect(io.err).toContain("team send: silent: not delivered: no live route; kept in silent's inbox (id ");
  expect(lastHistory(made)).toMatchObject({ to: 'silent', outcome: 'not delivered', via: 'drop' });

  const routed = owner(made.root);
  expect(await runRoute(['silent'], routed, host)).toBe(0);
  expect(routed.out).toContain("socket not eligible: the receiving seat's team file declares inbound hold; do not dial it");
  expect(routeLines(made)[0]).toMatchObject({ to: 'silent', socket_state: 'ineligible' });
});

test('an explicit team-file refuse keeps the socket out: the route names the team file word and nothing is dialed', async () => {
  const made = world(null, [{ name: 'silent', role: 'implementer', launch: 'claude --model fixture-model' }]);
  cleanup = made.cleanup;
  teamWordOn(made, 'claude --model fixture-model', 'refuse');
  generatedDeclaring(made, 'silent', 'accept');
  const silentId = registerSeat(made, 'silent', 'fixture-pane-a');
  place(made, 'silent', 'fixture-pane-a');
  roster(made, silentId, 'silent', 'implementer');
  const dialed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'silent', pane: 'fixture-pane-a', cli: 'claude' }],
    deliver: async (_socket: string, frame: string) => {
      dialed.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  expect(await runSend(['silent', 'a note'], io, host)).toBe(1);
  expect(dialed).toEqual([]);

  const routed = owner(made.root);
  expect(await runRoute(['silent'], routed, host)).toBe(0);
  expect(routed.out).toContain("socket not eligible: the receiving seat's team file declares inbound refuse; do not dial it");
  expect(routeLines(made)[0]).toMatchObject({ to: 'silent', socket_state: 'ineligible' });
});

test('a generated file with no inbound word is ineligible, and the route names the file it read', async () => {
  const made = world(null, [{ name: 'silent', role: 'implementer' }]);
  cleanup = made.cleanup;
  const settings = generatedWithoutWord(made, 'silent');
  const silentId = registerSeat(made, 'silent', 'fixture-pane-a');
  place(made, 'silent', 'fixture-pane-a');
  roster(made, silentId, 'silent', 'implementer');
  const dialed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'silent', pane: 'fixture-pane-a', cli: 'claude' }],
    deliver: async (_socket: string, frame: string) => {
      dialed.push(frame);
      return { ok: true };
    },
  });
  const io = owner(made.root);

  expect(await runRoute(['silent'], io, host)).toBe(0);
  expect(io.out).toContain(
    `socket not eligible: the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${settings}); owner CLI settings are not read; do not dial it`,
  );
  expect(routeLines(made)[0]).toMatchObject({ to: 'silent', socket_state: 'ineligible' });

  const sent = owner(made.root);
  expect(await runSend(['silent', 'a note'], sent, host)).toBe(1);
  expect(dialed).toEqual([]);
  expect(lastHistory(made)).toMatchObject({ to: 'silent', outcome: 'not delivered', via: 'drop' });
});

test('the accept default narrows nothing about admission: a seat of another team is still refused', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  const acme = teamIdOf(made.root);
  // A second team, of another entity: no rule of this one reaches its seat.
  const other = join(dirname(made.root), 'other');
  mkdirSync(join(other, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'ignore' });
  writeFileSync(join(other, '.agents', 'team.yaml'), `format: 1
project: other
entity: other
coordinator: stranger
operator: stranger
session: other
workspace:
  mode: shared
seats:
  - role: coordinator
    name: stranger
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  const otherId = teamIdOf(other);
  const stranger = registerAgent(made.home, {
    name: 'stranger',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: otherId, seat: 'stranger', session: 'other', pane: 'fixture-pane-b', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, otherId, {
    project: 'other',
    entity: 'other',
    session: 'other',
    root: other,
    lobby: lobbyDir(made.home),
    lifecycle: 'running',
    roster: [{ agent: stranger.id, seat: 'stranger', role: 'coordinator', leads: true }],
  });
  const helper = registerSeat(made, 'helper', 'fixture-pane-a');
  place(made, 'helper', 'fixture-pane-a');
  upsertTeam(made.home, acme, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: made.root,
    lobby: lobbyDir(made.home),
    lifecycle: 'running',
    roster: [{ agent: helper, seat: 'helper', role: 'implementer', leads: false }],
  });
  const dialed: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'helper', pane: 'fixture-pane-a', cli: 'claude' }],
    deliver: async (_socket: string, frame: string) => {
      dialed.push(frame);
      return { ok: true };
    },
  });
  const io = testIo(made.root, { kind: 'seat', name: 'helper', pane: 'fixture-pane-a', session: 'acme' });

  const code = await runSend([`stranger@${otherId}`, 'a note'], io, host);

  expect(code).toBe(1);
  expect(io.err).toBe(
    `team send: refused: helper@${acme} may not send to stranger@${otherId}: no rule admits it (${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY})\n`,
  );
  expect(dialed).toEqual([]);
  expect(host.frames).toEqual([]);
});

// The plain-restart half. A placed lead restarts a claude-code seat without --fresh; the
// existing hook settings file is rewritten by this build. The host is a stub and starts no CLI.
const CLEAN = 'claude --model claude-opus-5-5';

/** The team file, with the worker carrying the given inbound word when one is named. */
function teamText(word?: 'hold' | 'refuse'): string {
  return `format: 1
project: acme
coordinator: lead
operator: ops
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
    launch: ${CLEAN}
  - role: coordinator
    name: ops
    label: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${CLEAN}
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${CLEAN}
${word === undefined ? '' : `    inbound: ${word}\n`}`;
}

type RestartScene = {
  home: string;
  root: string;
  dir: string;
  agent: Agent;
  runs: string[];
  sources: RestartSources;
};

const restartBases: string[] = [];
afterEach(() => {
  for (const base of restartBases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function restartGit(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

function openRestartScene(word?: 'hold' | 'refuse'): RestartScene {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'restart-inbound-')));
  restartBases.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  restartGit(root, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(dir, 'team.yaml'),
    teamText(word).replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`),
  );
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
  });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
  if (lead === undefined) throw new Error('no lead');
  const placed = registerLaunch({ home, team: loaded.team, root, by: 'owner' }, lead, 'pane-lead');
  if ('note' in placed) throw new Error(placed.note);
  const agent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: CLEAN,
    reach: {
      team: teamIdOf(root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: null,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    settings: { effort: { word: 'steady' } },
    by: 'the test',
  });

  const runs: string[] = [];
  let workerAlive = true;
  let shelled = false;
  const drawn = new Map<string, string>();
  const fresh = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = () => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
    { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: root },
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: root }]
      : []),
    ...[...fresh.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name,
      agent: 'claude-code',
      pane,
      workspace: slot.workspace,
      status: 'idle',
      cwd: root,
    })),
  ];
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      drawn.set(pane, claudeBox(text));
      return text.includes('/exit');
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => agents().map((item) => item.pane),
    closeWorkspace(_session, workspace) {
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
    registerInbox: () => ({ ok: true }),
    createWorkspace() {
      const pane = 'pane-new';
      const workspace = 'ws-new';
      fresh.set(pane, { text: CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push(command);
      const slot = fresh.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = fresh.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((item) => item.pane),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => {
      if (workspace === 'ws-old' && workerAlive) return ['pane-old'];
      return [...fresh.entries()].filter(([, slot]) => slot.workspace === workspace).map(([pane]) => pane);
    },
    paneText: (_session, pane) => drawn.get(pane) ?? fresh.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, pane, text) {
      const slot = fresh.get(pane);
      if (slot) slot.text = claudeBox(text);
      return true;
    },
    pressEnter() {
      return true;
    },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['fixture-shell'] : ['claude']),
    shellBack: (_session, pane) => pane === 'pane-old' && shelled,
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
    home,
  };
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agents(),
    workspaces: () => agents().map((item) => ({ id: item.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => drawn.get(pane) ?? claudeBox(''),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['fixture-shell'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    autoOrder: () => null,
  };
  return { home, root, dir, agent, runs, sources };
}

/** The hook settings file, written to an old shape before the restart, with its folders of
 *  the launcher's own mode so the generated file is recognised as this build's. */
function oldHookFile(scene: RestartScene, text: string): string {
  const path = cliHookSettingsPath(scene.dir, 'acme', 'worker');
  if (path === null) throw new Error('the fixture declares no settings path for worker');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text);
  return path;
}

function inboundIn(path: string): unknown {
  const settings = JSON.parse(readFileSync(path, 'utf8')) as { crossSessionInbound?: unknown };
  return settings.crossSessionInbound;
}

test('a plain restart regenerates a hook file with no inbound value so that it declares accept', async () => {
  const scene = openRestartScene();
  const path = oldHookFile(scene, '{\n  "hooks": {}\n}\n');
  expect(inboundIn(path)).toBeUndefined();
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });

  const code = await runRestart(['worker'], io, scene.sources);

  expect(code).toBe(0);
  expect(inboundIn(path)).toBe('accept');
  // The regenerated file is on the launch line the new pane was given.
  expect(scene.runs.length).toBeGreaterThan(0);
  expect(scene.runs.some((command) => command.includes('--settings'))).toBe(true);
});

test('a plain restart keeps an explicit team-file hold in the regenerated hook file', async () => {
  const scene = openRestartScene('hold');
  const path = oldHookFile(scene, '{\n  "hooks": {}\n}\n');
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });

  const code = await runRestart(['worker'], io, scene.sources);

  expect(code).toBe(0);
  expect(inboundIn(path)).toBe('hold');
});

test("a plain restart keeps an explicit team-file refuse over the file's older accept", async () => {
  const scene = openRestartScene('refuse');
  const path = oldHookFile(scene, '{\n  "crossSessionInbound": "accept"\n}\n');
  expect(inboundIn(path)).toBe('accept');
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });

  const code = await runRestart(['worker'], io, scene.sources);

  expect(code).toBe(0);
  expect(inboundIn(path)).toBe('refuse');
});

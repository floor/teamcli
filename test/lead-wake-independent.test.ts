// Independent scenes for the lead-wake address fix, written from the brief
// (briefs-0.5.18/lead-wake-fix-0521-2030Z.md, 20:35Z section) and the source, never from the
// builder's own tests.
//
// A seat's registry record can hold no address while the seat's pane still carries a live
// cross-session socket. The send must use that proven pane socket, record it on the same
// registry identity, and refuse any socket the live placement does not prove. With no live
// route at all the send keeps its inbox copy but says `not delivered: no live route` and exits
// 1 (the 1345 contract). A restart refreshes the record from the relaunched pane.
//
// Fixtures only: a synthetic checkout and home, synthetic panes and a fake dial. No live
// session, pane or CLI.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-11-10T20:00:00Z');

/** Pids no real session holds: the pane's shell, the socket's own process, and a decoy's. */
const SHELL_PID = 9_920_101;
const SOCKET_PID = 9_920_102;
const OTHER_PID = 9_920_103;

type SeatSpec = { name: string; role: string; leads?: boolean; inbound?: 'accept'; launch?: string };

function teamText(project: string, entity: string, seats: readonly SeatSpec[]): string {
  const lead = seats.find((seat) => seat.leads === true)?.name;
  if (lead === undefined) throw new Error('a scene team needs a seat that leads');
  const rows = seats
    .map(
      (seat) => `  - role: ${seat.role}
    name: ${seat.name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: ${seat.launch ?? 'claude --model test'}
${seat.leads === true ? '    leads: true\n' : ''}${seat.inbound === undefined ? '' : `    inbound: ${seat.inbound}\n`}`,
    )
    .join('');
  return `format: 1
project: ${project}
entity: ${entity}
session: ${project}
coordinator: ${lead}
operator: ${lead}
workspace:
  mode: shared
seats:
${rows}`;
}

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function fileOf(root: string, text: string): TeamFile {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`the scene's own file does not validate: ${checked.errors.map((error) => error.message).join('; ')}`);
  return checked.team;
}

/** One seat launched where a real launch leaves it: a running record on its pane, and the state
 *  standing it there. The record holds no address, the lead-wake state. */
function launch(root: string, home: string, team: TeamFile, seat: string, pane: string, launchLine?: string): void {
  const one = team.seats.find((candidate) => candidate.name === seat);
  if (one === undefined) throw new Error(`the scene team ${team.project} has no seat ${seat}`);
  const written = registerLaunch({ home, team, root, by: 'up' }, one, pane);
  if ('note' in written) throw new Error(`the scene's own registration failed: ${written.note}`);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[team.session] ??= emptySession());
    session.seats[seat] = { stage: 'ready', pane, workspace: 'w1', ...(launchLine === undefined ? {} : { launch_line: launchLine }) };
  });
}

// ---------------------------------------------------------------------------------------------
// Send scenes: a lead in `acme` writes to `api`'s lead, resolved through the registry, whose
// record holds no address.
// ---------------------------------------------------------------------------------------------

type SendScene = {
  base: string;
  home: string;
  acmeRoot: string;
  apiRoot: string;
  api: TeamFile;
  sockets: string;
  settings: string;
};

function sendScene(): SendScene {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-wake-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const acmeRoot = join(base, 'acme');
  const apiRoot = join(base, 'api');
  for (const root of [acmeRoot, apiRoot]) mkdirSync(join(root, '.agents'), { recursive: true });
  const acmeText = teamText('acme', 'acme', [
    { name: 'coord', role: 'coordinator', leads: true },
    { name: 'acme-helper', role: 'builder' },
  ]);
  const apiText = teamText('api', 'acme', [
    { name: 'api-lead', role: 'coordinator', leads: true, inbound: 'accept' },
  ]);
  writeFileSync(join(acmeRoot, '.agents', 'team.yaml'), acmeText);
  writeFileSync(join(apiRoot, '.agents', 'team.yaml'), apiText);
  const acme = fileOf(acmeRoot, acmeText);
  const api = fileOf(apiRoot, apiText);
  launch(acmeRoot, home, acme, 'coord', 'acme:coord');
  launch(acmeRoot, home, acme, 'acme-helper', 'acme:helper');
  // The receiving seat's running session declares crossSessionInbound accept in the settings
  // file its launch line names; it is backdated so a socket written after it reads live. The
  // team file's own row stays the plain line a later launch would install, so only the state's
  // recorded launch line can word the declaration.
  const settings = join(base, 'api-lead-settings.json');
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(Date.now() - 120_000);
  utimesSync(settings, past, past);
  launch(apiRoot, home, api, 'api-lead', 'api:api-lead', `claude --model test --settings ${settings}`);
  const sockets = join(base, 'cc-socks');
  mkdirSync(sockets, { recursive: true });
  return { base, home, acmeRoot, apiRoot, api, sockets, settings };
}

/** The socket a pane's own process carries: its name is the pid, as the real folder's is. */
function socketFile(sockets: string, pid: number): string {
  const path = join(sockets, `${pid}.sock`);
  writeFileSync(path, '');
  return path;
}

function apiRecord(scene: SendScene) {
  return findAgent(scene.home, { team: teamIdOf(scene.apiRoot), seat: 'api-lead' });
}

function addressOf(scene: SendScene): string | null {
  return apiRecord(scene)?.reach.address ?? null;
}

type Reading = { code: number; out: string; err: string; frames: string[] };

/** One real send from `acme`'s lead to `api`'s lead, addressed through the registry. The live
 *  read is the scene's own: the seat's unique name in its session, the CLI herdr reports there,
 *  and the pane's processes. */
async function send(scene: SendScene, live: { pane: string; cli?: string | null } | null, processes: { shell: number; foreground: number[] } | null): Promise<Reading> {
  const io = testIo(scene.acmeRoot, { kind: 'seat', name: 'coord', pane: 'acme:coord', session: 'acme' });
  const frames: string[] = [];
  const host: SendHost = {
    // The receiving seat as herdr lists it: one agent by name in its own session. A null reading
    // is a session that could not be read; every other scene answers for `api` only.
    agents: (session) =>
      session !== 'api' || live === null
        ? null
        : [{ name: 'api-lead', pane: live.pane, ...(live.cli === undefined ? {} : { cli: live.cli }) }],
    processInfo: (_session, pane) => (pane === 'api:api-lead' ? processes : null),
    socketsDir: scene.sockets,
    deliver: async (_socketPath: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => null,
      wait: async () => {},
    },
    now: () => NOW,
    home: scene.home,
  };
  const code = await runSend(['api-lead@api', 'the lead line'], io, host);
  return { code, out: io.out, err: io.err, frames };
}

describe('a null address plus a proven pane socket', () => {
  test('is delivered (socket), and the proven address is recorded on the same registry identity', async () => {
    const scene = sendScene();
    const socket = socketFile(scene.sockets, SOCKET_PID);
    const before = apiRecord(scene);
    expect(before).not.toBeNull();
    expect(before?.reach.address).toBeNull();

    const reading = await send(scene, { pane: 'api:api-lead', cli: 'claude' }, { shell: SHELL_PID, foreground: [SOCKET_PID] });

    expect(reading.code).toBe(0);
    expect(reading.out).toContain('delivered (socket)');
    expect(reading.frames).toHaveLength(1);
    expect(reading.frames[0]).toContain('the lead line');
    // The write lands on the record the address was resolved from, never on another identity.
    const after = apiRecord(scene);
    expect(after?.id).toBe(before?.id);
    expect(after?.reach.address).toBe(socket);
  });
});

describe('a socket the live placement does not prove', () => {
  test('is refused when herdr reports no CLI, and the record keeps its null address', async () => {
    const scene = sendScene();
    socketFile(scene.sockets, SOCKET_PID);

    const reading = await send(scene, { pane: 'api:api-lead' }, { shell: SHELL_PID, foreground: [SOCKET_PID] });

    expect(reading.code).toBe(1);
    expect(reading.out + reading.err).toContain('not delivered: no live route');
    expect(reading.frames).toEqual([]);
    expect(addressOf(scene)).toBeNull();
  });

  test("is refused when herdr names a CLI other than the record's, and nothing is written", async () => {
    const scene = sendScene();
    socketFile(scene.sockets, SOCKET_PID);

    const reading = await send(scene, { pane: 'api:api-lead', cli: 'codex' }, { shell: SHELL_PID, foreground: [SOCKET_PID] });

    expect(reading.code).toBe(1);
    expect(reading.out + reading.err).toContain('not delivered: no live route');
    expect(reading.frames).toEqual([]);
    expect(addressOf(scene)).toBeNull();
  });
});

describe('no live route at all', () => {
  test('says not delivered: no live route, exits 1, dials no foreign socket and keeps the inbox copy', async () => {
    const scene = sendScene();
    // A socket exists in the folder, but its pid is not one the proven pane runs: it is some
    // other process's address and must never be dialed for this seat. The pane's own CLI is in
    // front (not its shell), so the seat is alive but has no live route.
    socketFile(scene.sockets, OTHER_PID);

    const reading = await send(scene, { pane: 'api:api-lead', cli: 'claude' }, { shell: SHELL_PID, foreground: [SOCKET_PID] });

    // The 1345 contract: the words and the exit code say the message did not arrive.
    expect(reading.code).toBe(1);
    expect(reading.out + reading.err).toContain('not delivered: no live route');
    expect(reading.frames).toEqual([]);
    expect(addressOf(scene)).toBeNull();
    // Retention does not change: the durable inbox copy is still there for the seat's next turn.
    const kept = readdirSync(join(scene.apiRoot, '.agents', 'send-drops', 'api', 'api-lead')).filter((name) => !name.includes('.'));
    expect(kept.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Restart scene: the relaunched seat's address is refreshed from the pane's own proven socket.
// ---------------------------------------------------------------------------------------------

type RestartScene = {
  home: string;
  root: string;
  sockets: string;
  socket: string | null;
  sources: RestartSources;
};

/** A claude-code worker with no recorded address, relaunched onto a new pane whose processes
 *  carry a socket (or not, for the control). The down path sees an idle box and the fake up path
 *  reaches ready; nothing reads a live session. */
function restartScene(withSocket: boolean): RestartScene {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-wake-restart-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ~/.config/team/lobby
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    inbound: accept
`;
  writeFileSync(join(dir, 'team.yaml'), text);
  const team = fileOf(root, text);
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
  });
  const lead = team.seats.find((seat) => seat.name === 'lead');
  if (lead === undefined) throw new Error('the scene team has no lead');
  const placed = registerLaunch({ home, team, root, by: 'owner' }, lead, 'pane-lead');
  if ('note' in placed) throw new Error(placed.note);
  registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'pane-old', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'the scene',
  });
  const sockets = join(base, 'cc-socks');
  mkdirSync(sockets, { recursive: true });
  const socket = withSocket ? socketFile(sockets, SOCKET_PID) : null;

  let workerAlive = true;
  let freshAlive = false;
  let shelled = false;
  const drawn = new Map<string, string>();
  const agents = (): HerdrAgent[] => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
    ...(workerAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: root }]
      : []),
    ...(freshAlive
      ? [{ name: 'worker', agent: 'claude-code', pane: 'pane-new', workspace: 'ws-new', status: 'idle' as const, cwd: root }]
      : []),
  ];
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      drawn.set(pane, claudeBox(text));
      return true;
    },
    sendKey: () => true,
    pressEnter: () => {
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
    createWorkspace: () => ({ pane: 'pane-new', workspace: 'ws-new' }),
    paneRun: () => {
      freshAlive = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((item) => item.pane),
    agents: () => agents(),
    workspacePanes: () => ['pane-new'],
    paneText: (_session, pane) => (pane === 'pane-new' ? CLAUDE_IDLE : claudeBox('')),
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    shellBack: (_session, pane) => pane === 'pane-old' && shelled,
    // The relaunched pane's own process reading: its foreground pid carries the socket.
    processInfo: (_session, pane) => (pane === 'pane-new' ? { shell: SHELL_PID, foreground: [SOCKET_PID] } : null),
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
    screenText: (_session, pane) => drawn.get(pane) ?? (pane === 'pane-old' ? claudeBox('') : CLAUDE_IDLE),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    autoOrder: () => null,
    // The synthetic folder a launch refresh reads, in place of the real host's temp folder.
    sockets,
  };
  return { home, root, sockets, socket, sources };
}

describe('a restart refreshes the address', () => {
  test('records the relaunched pane\'s own live socket on the restarted seat', async () => {
    const scene = restartScene(true);
    const before = findAgent(scene.home, { team: teamIdOf(scene.root), seat: 'worker' });
    expect(before?.reach.address).toBeNull();

    const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const code = await runRestart(['worker'], io, scene.sources);

    expect(code).toBe(0);
    const after = findAgent(scene.home, { team: teamIdOf(scene.root), seat: 'worker' });
    expect(after?.id).toBe(before?.id);
    expect(after?.reach.address).toBe(scene.socket as string);
  });

  test('leaves the null address alone when the relaunched pane carries no socket (control)', async () => {
    const scene = restartScene(false);

    const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const code = await runRestart(['worker'], io, scene.sources);

    expect(code).toBe(0);
    const after = findAgent(scene.home, { team: teamIdOf(scene.root), seat: 'worker' });
    expect(after?.reach.address).toBeNull();
  });
});

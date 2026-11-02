// `team status`'s REACH column reads the same gate `team send` walks to its socket leg: a row
// may say `socket` only when a real send on the same fixture actually dials the pane's socket.
// These scenes run both readers over one fixture and compare them — the wrapper launch line
// (an assignment, `zsh <script>` execing a fake CLI, its own `--settings`), the team file's
// inbound word or its absence, a held frame, a socket older than the declaration, and the
// plain Claude seat that must read `socket` in both.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runSend } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { NOW, fake, owner, world, type ExtraSeat, type World } from './send-native-fixtures.ts';

// Pids no real session holds: the socket folder walked is the fixture's own temp folder.
const SHELL_PID = 990020;
const SESSION_PID = 990021;
const PANE = 'fixture-pane-7';

let restored: Array<() => void> = [];
afterEach(() => {
  for (const undo of restored.reverse()) undo();
  restored = [];
});

/** The folder `team status` discovers sockets in when the fixture's temp folder is in force. */
function socketsDir(made: World): string {
  return join(dirname(made.root), 'cc-socks');
}

/** The one socket the fixture's pane carries, written where both readers walk. */
function placeSocket(made: World, pid = SESSION_PID): string {
  const dir = socketsDir(made);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(pid)}.sock`);
  writeFileSync(path, '');
  return path;
}

/** A wrapper-shaped launch line: a variable assignment, `zsh <script>` whose body execs a fake
 *  CLI, and the line's own `--settings` file. `fresh` puts the settings file's mtime before the
 *  socket's; not fresh puts it after, a declaration the running session predates. */
function wrapper(word: string, fresh = true): string {
  const base = mkdtempSync(join(tmpdir(), 'team-wrap-'));
  restored.push(() => rmSync(base, { recursive: true, force: true }));
  const fakeCli = join(base, 'fake-cli');
  writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
  const script = join(base, 'launcher.sh');
  writeFileSync(script, `#!/bin/sh\nexec ${fakeCli} --settings '{"crossSessionInbound":"${word}"}' "$@"\n`);
  const settings = join(base, 'wrapper-settings.json');
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: word }));
  const at = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(settings, new Date(at), new Date(at));
  return `WRAPPER_MODEL=fixture-model zsh ${script} --settings ${settings}`;
}

/** The generated per-seat settings file this build's launcher appends, and its mtime. */
function generated(made: World, seat: string, word: string, fresh = true): string {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: word }));
  const at = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(path, new Date(at), new Date(at));
  return path;
}

/** A team that names an entity starts in that entity's lobby: the file trusts it, and the
 *  socket frame's reply target (the owner) is only nameable through the entity. */
function entity(made: World, name = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: name });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${name}\n`);
}

/** A world whose own temp folder is the one `tmpdir()` answers, so status's default socket
 *  walk and the send host's own folder are the same directory. Measured in this Bun: os.tmpdir()
 *  follows a TMPDIR set after the process started. */
function fixture(extraSeats: readonly ExtraSeat[] = [], launches: Parameters<typeof world>[2] = {}): World {
  const made = world(null, extraSeats, launches);
  entity(made);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dirname(made.root);
  restored.push(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    made.cleanup();
  });
  return made;
}

/** The status report over the same fixture: the seat's row, read from the plain table. */
async function statusReach(made: World, seat: string, foreground: readonly number[] = [SESSION_PID]): Promise<{ reach: 'socket' | 'typed'; line: string; out: string }> {
  const text = readFileSync(join(made.dir, 'team.yaml'), 'utf8');
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error('the fixture team file does not validate');
  const names = ['lead', 'helper', 'native', ...(seat === 'lead' ? [] : [seat])];
  const liveAgents: HerdrAgent[] = names.map((name) => ({
    name,
    agent: 'claude',
    pane: name === seat ? PANE : `fixture-pane-${name}`,
    workspace: 'fixture-ws',
    status: 'idle',
    cwd: null,
  }));
  const processes: Record<string, PaneProcesses | null> = { [PANE]: { shell: SHELL_PID, foreground: [...foreground] } };
  const sources: StatusSources = {
    live: () => ({ running: true, agents: liveAgents, workspaces: [], screens: {}, processes }),
    branch: () => 'main',
    standing: () => verifiedOf(checked.team, text, made.root, NOW),
    now: () => NOW,
    home: made.home,
  };
  const io = testIo(made.root, { kind: 'owner' });
  await runStatus(['--file', join(made.dir, 'team.yaml')], io, sources);
  const lines = io.out.split('\n');
  // The reach word is found under its header, not as the last column: the WAKE cell follows it.
  const heads = (lines.find((candidate) => candidate.trimStart().startsWith('SEAT ')) ?? '').trim().split(/\s{2,}/);
  const line = lines.find((candidate) => candidate.trimStart().startsWith(`${seat} `));
  if (line === undefined) throw new Error(`no status row for ${seat} in:\n${io.out}`);
  const trimmed = line.trimEnd();
  const reach = trimmed.trim().split(/\s{2,}/)[heads.indexOf('REACH')];
  if (reach !== 'socket' && reach !== 'typed') throw new Error(`the ${seat} row carries no reach word: ${line}`);
  return { reach, line: trimmed, out: io.out };
}

/** The real send to the same fixture: what its walk actually did with the socket leg. */
async function sendTo(made: World, seat: string, opts: { foreground?: number[]; sockets?: string } = {}) {
  const host = fake(made, {
    agents: () => [{ name: seat, pane: PANE }],
    processInfo: () => ({ shell: SHELL_PID, foreground: opts.foreground ?? [SESSION_PID] }),
    socketsDir: opts.sockets ?? socketsDir(made),
  });
  const io = owner(made.root);
  const code = await runSend([seat, 'a note'], io, host);
  return { code, frames: host.frames, out: io.out, err: io.err };
}

/** A temporary seat and a seat a registry caller addresses: both are named only by the
 *  registry's record, which carries the pane and the cross-session address the send uses. */
function registered(made: World, name: string, address: string): void {
  const id = teamIdOf(made.root);
  const record = registerAgent(made.home, {
    name,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: name, session: 'acme', pane: PANE, address },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'floor',
    session: 'acme',
    root: made.root,
    lobby: resolveLobby(made.home, { entity: 'floor' }),
    roster: [{ agent: record.id, seat: name, role: 'implementer', leads: false }],
    lifecycle: 'running',
  });
}

/** A scene's one claim: the status row and the real send agree, and both say `expected`. */
async function agree(made: World, seat: string, expected: 'socket' | 'typed', opts: { foreground?: number[]; sockets?: string } = {}) {
  const status = await statusReach(made, seat, opts.foreground);
  const sent = await sendTo(made, seat, opts);
  expect(status.reach).toBe(expected);
  expect(sent.frames.length === 1).toBe(status.reach === 'socket');
  return { status, sent };
}

/** The bare agreement, for a scene whose fix direction is the builders' to choose: the two
 *  readers must land on the same word, whichever word the send's own walk ends on. */
async function agreeOnly(made: World, seat: string, opts: { foreground?: number[]; sockets?: string } = {}) {
  const status = await statusReach(made, seat, opts.foreground);
  const sent = await sendTo(made, seat, opts);
  expect(status.reach).toBe(sent.frames.length === 1 ? 'socket' : 'typed');
  return { status, sent };
}

test("a wrapper launch with the team file's inbound accept reads socket, and the send dials it", async () => {
  const line = wrapper('accept');
  const made = fixture([], { lead: line });
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'socket');
  expect(status.reach).toBe('socket');
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('lead: delivered (socket)');
});

test("a wrapper launch with no team-file inbound word reads typed, and the send dials no socket", async () => {
  const line = wrapper('accept');
  const made = fixture([{ name: 'wrapped', role: 'implementer', launch: line }]);
  placeSocket(made);
  const { status, sent } = await agree(made, 'wrapped', 'typed');
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a held frame keeps the reach column typed, and the send leaves the socket alone', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept');
  const declaration = declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch: 'claude' });
  recordHeldSocket(heldSocketPath(made.dir, 'acme', 'lead'), declaration, NOW);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'typed');
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a socket older than the declaration reads typed, and the send dials no socket', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept', false);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'typed');
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('the plain Claude seat with an accepted socket reads socket in both readers', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept');
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'socket');
  expect(status.reach).toBe('socket');
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('lead: delivered (socket)');
});

// The two cases a registry address can tell apart from the pane's own processes: the recorded
// address outranks discovery in the send, and a temporary seat exists only in the registry and
// the state, never in the team file. Each scene only asks that the two readers agree.

test("a recorded address the send prefers over the pane's own fresh socket keeps both readers in step", async () => {
  const recordedPid = 990022;
  const freshPid = 990023;
  const made = fixture();
  generated(made, 'lead', 'accept');
  const recorded = join(made.sockets, `${String(recordedPid)}.sock`);
  writeFileSync(recorded, '');
  const old = new Date(Date.now() - 120_000);
  utimesSync(recorded, old, old);
  placeSocket(made, freshPid);
  registered(made, 'lead', recorded);
  // Status discovers the fresh socket of the pane's first process; the send dials the recorded
  // address of the second, which predates the declaration.
  await agreeOnly(made, 'lead', { foreground: [freshPid, recordedPid] });
});

test('a temporary seat a registry-addressed send can reach agrees with its status row', async () => {
  const made = fixture();
  generated(made, 'temp', 'accept');
  const socket = placeSocket(made);
  registered(made, 'temp', socket);
  updateState(made.dir, (state) => {
    state.sessions.acme ??= emptySession();
    state.sessions.acme.seats.temp = { stage: 'ready', temporary: { like: 'helper', until: 'manual' } };
  });
  await agreeOnly(made, 'temp');
});

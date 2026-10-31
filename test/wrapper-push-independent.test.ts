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
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
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
async function statusReach(made: World, seat: string): Promise<{ reach: 'socket' | 'typed'; line: string; out: string }> {
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
  const processes: Record<string, PaneProcesses | null> = { [PANE]: { shell: SHELL_PID, foreground: [SESSION_PID] } };
  const sources: StatusSources = {
    live: () => ({ running: true, agents: liveAgents, workspaces: [], screens: {}, processes }),
    branch: () => 'main',
    standing: () => verifiedOf(checked.team, text, made.root, NOW),
    now: () => NOW,
    home: made.home,
  };
  const io = testIo(made.root, { kind: 'owner' });
  await runStatus(['--file', join(made.dir, 'team.yaml')], io, sources);
  const line = io.out.split('\n').find((candidate) => candidate.trimStart().startsWith(`${seat} `));
  if (line === undefined) throw new Error(`no status row for ${seat} in:\n${io.out}`);
  const trimmed = line.trimEnd();
  const reach = trimmed.endsWith(' socket') ? 'socket' : trimmed.endsWith(' typed') ? 'typed' : null;
  if (reach === null) throw new Error(`the ${seat} row carries no reach word: ${line}`);
  return { reach, line: trimmed, out: io.out };
}

/** The real send to the same fixture: what its walk actually did with the socket leg. */
async function sendTo(made: World, seat: string) {
  const host = fake(made, {
    agents: () => [{ name: seat, pane: PANE }],
    processInfo: () => ({ shell: SHELL_PID, foreground: [SESSION_PID] }),
    socketsDir: socketsDir(made),
  });
  const io = owner(made.root);
  const code = await runSend([seat, 'a note'], io, host);
  return { code, frames: host.frames, out: io.out, err: io.err };
}

/** A scene's one claim: the status row and the real send agree, and both say `expected`. */
async function agree(made: World, seat: string, expected: 'socket' | 'typed') {
  const status = await statusReach(made, seat);
  const sent = await sendTo(made, seat);
  expect(status.reach).toBe(expected);
  expect(sent.frames.length === 1).toBe(status.reach === 'socket');
  return { status, sent };
}

test("a wrapper launch with the team file's inbound accept reads socket, and the send dials it", async () => {
  const line = wrapper('accept');
  const made = fixture([], { lead: line });
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'socket');
  expect(status.line).toMatch(/ socket$/);
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('lead: delivered (socket)');
});

test("a wrapper launch with no team-file inbound word reads typed, and the send dials no socket", async () => {
  const line = wrapper('accept');
  const made = fixture([{ name: 'wrapped', role: 'implementer', launch: line }]);
  placeSocket(made);
  const { status, sent } = await agree(made, 'wrapped', 'typed');
  expect(status.line).toMatch(/ typed$/);
  expect(sent.frames).toEqual([]);
});

test('a held frame keeps the reach column typed, and the send leaves the socket alone', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept');
  const declaration = declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch: 'claude' });
  recordHeldSocket(heldSocketPath(made.dir, 'acme', 'lead'), declaration, NOW);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'typed');
  expect(status.line).toMatch(/ typed$/);
  expect(sent.frames).toEqual([]);
});

test('a socket older than the declaration reads typed, and the send dials no socket', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept', false);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'typed');
  expect(status.line).toMatch(/ typed$/);
  expect(sent.frames).toEqual([]);
});

test('the plain Claude seat with an accepted socket reads socket in both readers', async () => {
  const made = fixture();
  generated(made, 'lead', 'accept');
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', 'socket');
  expect(status.line).toMatch(/ socket$/);
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('lead: delivered (socket)');
});

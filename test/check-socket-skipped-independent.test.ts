// `team check` names a live Claude seat whose profile promises a push delivery but whose
// socket leg a send would skip, for a reason a team file can fix — one line per seat, with the
// repair that fixes it. These scenes run the check, `team status`'s REACH column and a real
// owner send over one fixture each: the check's finding, or its absence, must agree with the
// row and with what the send's own walk did. The three fixable reasons are a team file that
// does not declare `inbound: accept` over an attesting launch's own settings, a frame the box
// held, and a socket older than the settings that declare it accepts. A seat with no socket is
// a note naming its delivery class, not a difference; a declared order that names neither the
// socket nor the typed wake word chose its routes; a team file's explicit opt-out and a
// non-Claude seat are never flagged. The panes and processes here are scripted; no live session
// is touched.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runSend } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { deliverBriefs, testIo } from './helpers.ts';
import { NOW, fake, owner, world, type ExtraSeat, type World } from './send-native-fixtures.ts';

// Pids no real session holds: the socket folder walked is the fixture's own temp folder.
const SHELL_PID = 990120;
const SESSION_PID = 990121;
const paneOf = (name: string): string => `fixture-pane-${name}`;

let restored: Array<() => void> = [];
afterEach(() => {
  for (const undo of restored.reverse()) undo();
  restored = [];
});

/** The folder both readers walk for a session's sockets when the fixture's temp folder is in
 *  force: `team status` reads `os.tmpdir()` at call time. */
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

/** A wrapper-shaped launch line: an assignment, `zsh <script>` whose body execs a fake CLI,
 *  and the line's own `--settings` file declaring `crossSessionInbound: accept`. The wrapper
 *  names its own settings, so this build's generated file is never consulted: the declaration
 *  is the launch's, and it is not the one this build attests (`generated` is absent). */
function wrapper(word: string): string {
  const base = mkdtempSync(join(tmpdir(), 'team-check-wrap-'));
  restored.push(() => rmSync(base, { recursive: true, force: true }));
  const fakeCli = join(base, 'fake-cli');
  writeFileSync(fakeCli, '#!/bin/sh\nexit 0\n');
  const script = join(base, 'launcher.sh');
  writeFileSync(script, `#!/bin/sh\nexec ${fakeCli} --settings '{"crossSessionInbound":"${word}"}' "$@"\n`);
  const settings = join(base, 'wrapper-settings.json');
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: word }));
  const at = new Date(Date.now() - 60_000);
  utimesSync(settings, at, at);
  return `WRAPPER_MODEL=fixture-model zsh ${script} --settings ${settings}`;
}

/** The generated per-seat settings file this build's launcher appends, and its mtime. `fresh`
 *  puts it before a socket written now; not fresh puts it after, a declaration the running
 *  session predates. */
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

/** Rewrite the file's first `inbound` word: every fixture declares `accept` on its first two
 *  seats, and the opt-out scene needs one that says `hold`. */
function optOut(made: World): void {
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  if (!text.includes('    inbound: accept\n')) throw new Error('the fixture team file carries no inbound word');
  writeFileSync(path, text.replace('    inbound: accept\n', '    inbound: hold\n'));
}

/** The seats the check and status read: ready in the state, each on its own pane, under a
 *  fresh watch and with the general seat brief delivered — so the socket finding is the only
 *  difference a scene's exit can be reading. */
function settle(made: World, names: readonly string[]): void {
  updateState(made.dir, (state) => {
    const one = (state.sessions.acme ??= emptySession());
    one.watch = { pid: 1, heartbeat: NOW.toISOString() };
    // The record a current launch writes: a Codex seat's line carries its profile's pinned feature.
    for (const name of names) one.seats[name] = {
      stage: 'ready',
      pane: paneOf(name),
      workspace: 'fixture-ws',
      watcher: 'hook',
      launch_line: name === 'native'
        ? 'codex -m test -c features.mcp_oauth_refresh_coordination=false'
        : 'claude',
    };
  });
  deliverBriefs({ dir: made.dir, root: made.root, session: 'acme', seats: names, home: made.home, at: NOW.toISOString() });
}

function agentsOf(names: readonly string[]): HerdrAgent[] {
  return names.map((name) => ({
    name,
    agent: name === 'native' ? 'codex' : 'claude',
    pane: paneOf(name),
    workspace: 'fixture-ws',
    status: 'idle',
    cwd: null,
  }));
}

function processesOf(names: readonly string[]): Record<string, PaneProcesses | null> {
  const out: Record<string, PaneProcesses | null> = {};
  for (const name of names) out[paneOf(name)] = { shell: SHELL_PID, foreground: [SESSION_PID] };
  return out;
}

/** A world whose own temp folder is the one `tmpdir()` answers, so the status row's default
 *  socket walk and the fixture's folder are the same directory. Measured in this Bun:
 *  `os.tmpdir()` follows a TMPDIR set after the process started. */
function fixture(extraSeats: readonly ExtraSeat[] = [], order: readonly string[] | null = null): { made: World; names: string[] } {
  const made = world(order, extraSeats);
  entity(made);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dirname(made.root);
  restored.push(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    made.cleanup();
  });
  return { made, names: ['lead', 'helper', 'native', ...extraSeats.map((seat) => seat.name)] };
}

/** The check over the same fixture and the same live snapshot the status row reads. The socket
 *  folders are the fixture's own, so no read touches this machine's. */
function check(made: World, names: readonly string[]): { code: number; out: string } {
  const io = testIo(made.root, { kind: 'owner' });
  const code = runTeamCheck({ file: join(made.dir, 'team.yaml') }, io, {
    live: () => ({ running: true, agents: agentsOf(names), workspaces: [], screens: {}, processes: processesOf(names) }),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, made.home),
    now: () => NOW,
    home: made.home,
    sockets: socketsDir(made),
  });
  return { code, out: `${io.out}${io.err}` };
}

/** The status report over the same fixture: the seat's row, read from the plain table. */
async function statusReach(made: World, seat: string, names: readonly string[]): Promise<{ reach: 'socket' | 'typed'; line: string }> {
  const sources: StatusSources = {
    live: () => ({ running: true, agents: agentsOf(names), workspaces: [], screens: {}, processes: processesOf(names) }),
    branch: () => 'main',
    standing: () => approvalStanding(made.root, made.home),
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
  return { reach, line: trimmed };
}

/** The real send to the same fixture: what its walk actually did with the socket leg. */
async function sendTo(made: World, seat: string) {
  const host = fake(made, {
    agents: () => [{ name: seat, pane: paneOf(seat) }],
    processInfo: () => ({ shell: SHELL_PID, foreground: [SESSION_PID] }),
    socketsDir: socketsDir(made),
  });
  const io = owner(made.root);
  const code = await runSend([seat, 'a note'], io, host);
  return { code, frames: host.frames, out: io.out, err: io.err };
}

/** One scene's agreement: the row and the real send land on the socket only together, and the
 *  check's finding (or its absence) is read from the same walk. */
async function agree(made: World, seat: string, names: readonly string[], expected: 'socket' | 'typed') {
  const status = await statusReach(made, seat, names);
  const sent = await sendTo(made, seat);
  expect(status.reach).toBe(expected);
  expect(sent.frames.length === 1).toBe(expected === 'socket');
  return { status, sent };
}

/** Every seat a registry record and one roster: the send then resolves each by its own record
 *  (its `reach.address` is the socket a plain-name send dials first), and the check's roster
 *  reading has nothing to name. */
function registerRoster(made: World, seats: ReadonlyArray<{ name: string; cli: string; address: string }>): void {
  const id = teamIdOf(made.root);
  const roster = seats.map(({ name, cli, address }) => {
    const record = registerAgent(made.home, {
      name,
      signing: { model: 'Test', version: '1', role: 'implementer' },
      lab: 'test-lab',
      cli,
      launcher: null,
      launch: cli === 'codex' ? 'codex -m test' : 'claude',
      reach: { team: id, seat: name, session: 'acme', pane: paneOf(name), address },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
    return { agent: record.id, seat: name, role: 'implementer', leads: false };
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'floor',
    session: 'acme',
    root: made.root,
    lobby: resolveLobby(made.home, { entity: 'floor' }),
    roster,
    lifecycle: 'running',
  });
}

const SKIP = 'sends go to its drop folder, not its socket:';

test("a wrapper launch's own accept with no team-file word is a difference naming the config repair", async () => {
  const { made, names } = fixture([{ name: 'wrapped', role: 'implementer', launch: wrapper('accept') }]);
  settle(made, names);
  placeSocket(made);
  const { status, sent } = await agree(made, 'wrapped', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain(`difference: wrapped: ${SKIP} the receiving seat's team file does not declare inbound accept`);
  expect(checked.out).toContain('  repair: team config set seats.wrapped.inbound accept');
  expect(checked.code).toBe(1);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a frame the box held is a difference repaired by a restart', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept');
  const declaration = declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch: 'claude' });
  recordHeldSocket(heldSocketPath(made.dir, 'acme', 'lead'), declaration, NOW);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain(`difference: lead: ${SKIP} its last socket frame was held at its box, and its declaration has not been re-confirmed since; restart its CLI host so it accepts`);
  expect(checked.out).toContain('  repair: team restart lead');
  expect(checked.code).toBe(1);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a socket older than the declaration is a difference repaired by a restart', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept', false);
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain(`difference: lead: ${SKIP} the socket predates the settings that declare it accepts`);
  expect(checked.out).toContain('  repair: team restart lead');
  expect(checked.code).toBe(1);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a seat with no socket is a note naming its class, and the exit stays clear', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept');
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain('note: lead: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn, and it reads them at its next turn');
  expect(checked.out).not.toContain(SKIP);
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a declared delivery order that names neither socket nor typed is a choice, not a finding', async () => {
  // The same wrapper seat as the first scene, which the check flags when the build's own order
  // stands: a declared order that leaves the socket out silences that finding, and the send's
  // walk follows the order, so all three readers agree the socket is not taken.
  const { made, names } = fixture([{ name: 'wrapped', role: 'implementer', launch: wrapper('accept') }], ['mcp-inbox', 'drop']);
  settle(made, names);
  placeSocket(made);
  const { status, sent } = await agree(made, 'wrapped', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).not.toContain('wrapped: sends go to its drop folder');
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('an explicit inbound opt-out is not a finding', async () => {
  const { made, names } = fixture();
  settle(made, names);
  optOut(made);
  generated(made, 'lead', 'accept');
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).not.toContain(SKIP);
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a Codex seat is never flagged for a socket skip', async () => {
  const { made, names } = fixture();
  settle(made, names);
  placeSocket(made);
  const { status, sent } = await agree(made, 'native', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).not.toContain(SKIP);
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('the plain Claude seat with an accepted live socket is no finding, and both readers dial', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept');
  placeSocket(made);
  const { status, sent } = await agree(made, 'lead', names, 'socket');
  const checked = check(made, names);
  expect(checked.out).not.toContain(SKIP);
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('socket');
  expect(sent.code).toBe(0);
  expect(sent.out).toContain('lead: delivered (socket)');
});

// The three scenes below pin defects operator-3 found at the head a640bf053: a registered seat
// whose recorded socket is live is read as `push` before its held frame is read, so the hold is
// never named; a seat with no socket at all is named as a fixable missing consent instead of a
// note; and a retained pane whose CLI ended is named a second time by the socket reading. Each
// is red at a640bf053 and expected green once the send's own readings come first.

test('a held frame is a difference even when the registry records the seat a live socket', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept');
  const declaration = declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch: 'claude' });
  recordHeldSocket(heldSocketPath(made.dir, 'acme', 'lead'), declaration, NOW);
  const socket = placeSocket(made);
  registerRoster(made, [
    { name: 'lead', cli: 'claude-code', address: socket },
    { name: 'helper', cli: 'claude-code', address: socket },
    { name: 'native', cli: 'codex', address: socket },
  ]);
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain(`difference: lead: ${SKIP} its last socket frame was held at its box, and its declaration has not been re-confirmed since; restart its CLI host so it accepts`);
  expect(checked.out).toContain('  repair: team restart lead');
  expect(checked.code).toBe(1);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('missing consent with no socket at all is a note, not a difference', async () => {
  const { made, names } = fixture([{ name: 'wrapped', role: 'implementer', launch: wrapper('accept') }]);
  settle(made, names);
  const { status, sent } = await agree(made, 'wrapped', names, 'typed');
  const checked = check(made, names);
  expect(checked.out).toContain('note: wrapped: no cross-session socket is live, so sends go to its drop folder; its delivery class is pull-on-turn, and it reads them at its next turn');
  expect(checked.out).not.toContain('wrapped: sends go to its drop folder');
  expect(checked.code).toBe(0);
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

test('a retained pane whose CLI ended is named once, by its pane reading', async () => {
  const { made, names } = fixture();
  settle(made, names);
  generated(made, 'lead', 'accept');
  const io = testIo(made.root, { kind: 'owner' });
  const code = runTeamCheck({ file: join(made.dir, 'team.yaml') }, io, {
    // The pane keeps its agent listing, and only the shell stands in its foreground: the CLI
    // the seat was launched as has ended, so the pane reading names it and the socket reading
    // must not.
    live: () => ({ running: true, agents: agentsOf(names), workspaces: [], screens: {}, processes: { [paneOf('lead')]: { shell: SHELL_PID, foreground: [SHELL_PID] } } }),
    branch: () => 'main',
    standing: (root) => approvalStanding(root, made.home),
    now: () => NOW,
    home: made.home,
    sockets: socketsDir(made),
  });
  const out = `${io.out}${io.err}`;
  expect(out).toContain('difference: lead: its pane runs no CLI and its process was never recorded');
  // The negatives are the lead seat's alone: the helper has no socket either, and a live seat
  // with no socket is named by its class on every pass — that note is not the second line this
  // scene is about, which is the one a retained pane would draw for the seat it no longer holds.
  expect(out).not.toContain('lead: sends go to its drop folder');
  expect(out).not.toContain('note: lead: no cross-session socket is live');
  expect(code).toBe(1);
  const { status, sent } = await agree(made, 'lead', names, 'typed');
  expect(status.reach).toBe('typed');
  expect(sent.frames).toEqual([]);
});

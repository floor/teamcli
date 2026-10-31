// A wrapper-launched seat: the launch line starts with an environment assignment, runs `zsh
// <script>`, and passes a settings file of its own; the script execs the CLI, so the pane's
// process name changes while its pid stays. Neither the assignment nor the shell in front defeats
// the readings: the CLI is the seat's agent record where the registry holds one and the team file
// otherwise, and the address is the record's when it names a live socket, the pane's own
// processes otherwise. What decides the socket is the declaration the line names and the team
// file's authorization: a launch this build did not write (its own `--settings` file is on the
// line) is not attested, so its accept alone authorizes nothing — the team file's `inbound:
// accept` is what admits the route. `team status` reads the send's own gate and address choice,
// so its reach column can never promise a socket the send would not dial.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, type SessionState } from '../src/state.ts';
import { compare, type Live } from '../src/status/compare.ts';
import { NOW, fake, owner, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

// Neutral fixture ids: the host's pane shape is never written into a test, built or literal.
const PANE = 'fixture-pane-one';
const CLI_PID = 222;

/** The launch line in the shape the wrapper reported: an environment assignment first, the
 *  wrapper script in `zsh`, its own options, and the session's settings file last. The script
 *  execs the CLI (the pid survives the exec) and sets no config folder of its own. Its settings
 *  file declares `crossSessionInbound: accept`, and it is backdated so the socket written after it
 *  is the newer file. */
function wrapperLine(made: World): string {
  const wrapper = join(made.root, '.agents', 'wrapper');
  mkdirSync(wrapper, { recursive: true });
  const script = join(wrapper, 'launch.sh');
  writeFileSync(script, '#!/bin/sh\nexec fake-claude --model test "$@"\n', { mode: 0o700 });
  const settings = join(wrapper, 'settings.json');
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(settings, past, past);
  return `FIXTURE_LAUNCH_FLAG=1 zsh ${script} --resume fixture-conversation --name wrapped --settings ${settings}`;
}

/** The fixture team file with one seat's launch line replaced in place: the line is one YAML
 *  plain scalar. */
function setLaunch(made: World, seat: string, line: string): void {
  const path = join(made.dir, 'team.yaml');
  const text = readFileSync(path, 'utf8');
  const named = text.indexOf(`    name: ${seat}\n`);
  const at = named < 0 ? -1 : text.indexOf('    launch: ', named);
  const end = at < 0 ? -1 : text.indexOf('\n', at);
  if (at < 0 || end < 0) throw new Error(`the fixture names no seat ${seat} with a launch line`);
  writeFileSync(path, `${text.slice(0, at)}    launch: ${line}${text.slice(end)}`);
}

/** The team file with an entity and that entity's own lobby in its trust list: an owner's socket
 *  frame names a reply target, and an entity-less team declares none. */
function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** The socket the fake pane's CLI process exposes. */
function socketOf(made: World): string {
  return join(made.sockets, `${String(CLI_PID)}.sock`);
}

/** The registry chain a send resolves a plain seat name through: this team's record and the
 *  seat's agent record, carrying the address the send reads first. */
function recordSeat(made: World, seat: string, address: string | null): void {
  const id = teamIdOf(made.root);
  const agent = registerAgent(made.home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat, session: 'acme', pane: PANE, address },
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
    roster: [{ agent: agent.id, seat, role: 'implementer', leads: false }],
    lifecycle: 'running',
  });
}

/** What `team status` reads for the seat: the comparison's own reach word, with the route's files
 *  named the way the command names them (its state folder and root, and — for a run that reads
 *  the registry — its home). `state` carries the temporary record a row needs. */
function reachOf(
  made: World,
  seat: string,
  options: { store?: true; state?: SessionState } = {},
): 'socket' | 'typed' | undefined {
  const loaded = readTeamConfig(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('the fixture team file does not load');
  const live: Live = {
    running: true,
    agents: [{ name: seat, agent: 'claude', pane: PANE, workspace: 'fixture-workspace', status: 'idle', cwd: null }],
    workspaces: [],
    screens: {},
    processes: { [PANE]: { shell: 111, foreground: [CLI_PID] } },
  };
  const route = options.store === true
    ? { dir: made.dir, root: made.root, home: made.home }
    : { dir: made.dir, root: made.root };
  const rows = compare(
    loaded.team, 'acme', options.state ?? emptySession(), live, NOW, loaded.team.watch, made.sockets,
    false, undefined, undefined, route,
  ).rows;
  return rows.find((row) => row.name === seat)?.reach;
}

test('a wrapper-launched seat its team file accepts is dialed by socket, and status reads socket', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  // The helper seat already carries the team file's `inbound: accept`; only its launch line changes.
  setLaunch(made, 'helper', wrapperLine(made));
  writeFileSync(socketOf(made), '');
  const io = owner(made.root);
  const host = fake(made, { agents: () => [{ name: 'helper', pane: PANE }] });

  const code = await runSend(['helper', 'a note', '--json'], io, host);

  expect(code).toBe(0);
  const sent = JSON.parse(io.out) as {
    status: string;
    channel?: string;
    delivery?: { leg: string; state: string }[];
  };
  expect(sent.channel).toBe('socket');
  expect(sent.delivery?.some((leg) => leg.leg === 'socket' && leg.state === 'attempted')).toBe(true);
  expect(host.frames.length).toBe(1);
  expect(reachOf(made, 'helper')).toBe('socket');
});

test('a wrapper line with its own settings is unattested: no socket is dialed, and status reads typed', async () => {
  const made = world(null, [{ name: 'wrapped', role: 'architect' }]);
  cleanup = made.cleanup;
  declareEntity(made);
  // The seat writes no `inbound` word in the team file: the only accept is the launch line's own
  // settings file, which this build did not write. A socket stands in its pane either way.
  setLaunch(made, 'wrapped', wrapperLine(made));
  writeFileSync(socketOf(made), '');
  const io = owner(made.root);
  const host = fake(made, { agents: () => [{ name: 'wrapped', pane: PANE }] });

  const code = await runSend(['wrapped', 'a note', '--json'], io, host);

  expect(code).toBe(0);
  const sent = JSON.parse(io.out) as {
    status: string;
    channel?: string;
    delivery?: { leg: string; state: string }[];
  };
  expect(sent.status).toBe('sent (unconfirmed)');
  expect(sent.channel).toBe('drop');
  // The walk never had a socket leg: the route its line declares is not authorized without the
  // team file's word, so nothing was dialed and nothing stood in the pane.
  expect(sent.delivery?.some((leg) => leg.leg === 'socket')).toBe(false);
  expect(host.frames).toEqual([]);
  // The status reader answers the same word: never a socket the send would refuse.
  expect(reachOf(made, 'wrapped')).toBe('typed');
});

test('a recorded socket older than the declaration: the send refuses it and the row reads typed', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  setLaunch(made, 'helper', wrapperLine(made));
  // The pane carries two sockets: the shell's, which the registry recorded and which still
  // stands, and the foreground CLI's, written after the declaration. The walk reads the recorded
  // address first and refuses it as older than the declaration; a discovery-only row would have
  // promised the foreground one.
  writeFileSync(socketOf(made), '');
  const recorded = join(made.sockets, '111.sock');
  writeFileSync(recorded, '');
  const older = new Date(Date.now() - 120_000);
  utimesSync(recorded, older, older);
  recordSeat(made, 'helper', recorded);
  const io = owner(made.root);
  const host = fake(made, { agents: () => [{ name: 'helper', pane: PANE }] });

  const code = await runSend(['helper', 'a note', '--json'], io, host);

  expect(code).toBe(0);
  const sent = JSON.parse(io.out) as { channel?: string };
  expect(sent.channel).toBe('drop');
  expect(host.frames).toEqual([]);
  expect(reachOf(made, 'helper', { store: true })).toBe('typed');
});

test('a recorded socket outside the discovery folders: the send dials it and the row reads socket', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  setLaunch(made, 'helper', wrapperLine(made));
  // The address the registry holds lives in the seat's own folder, not in either folder
  // discovery walks. Its pid is the pane's foreground CLI, and it was written after the
  // declaration: the walk dials it, and the row must read the same address.
  const held = join(made.root, '.agents', 'recorded-sockets');
  mkdirSync(held);
  const recorded = join(held, `${String(CLI_PID)}.sock`);
  writeFileSync(recorded, '');
  recordSeat(made, 'helper', recorded);
  const io = owner(made.root);
  const host = fake(made, { agents: () => [{ name: 'helper', pane: PANE }] });

  const code = await runSend(['helper', 'a note', '--json'], io, host);

  expect(code).toBe(0);
  const sent = JSON.parse(io.out) as { channel?: string };
  expect(sent.channel).toBe('socket');
  expect(host.frames.length).toBe(1);
  expect(reachOf(made, 'helper', { store: true })).toBe('socket');
});

test('a temporary seat: its agent record and generated declaration give the row the same socket the send dials', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  const seat = 'helper-temp';
  // A temporary seat has no file line: the launch this build ran left its generated settings
  // file declaring accept, and the registry holds the seat's record and recorded socket.
  const settings = cliHookSettingsPath(made.dir, 'acme', seat);
  if (settings === null) throw new Error('the fixture declares no generated settings path');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const declared = new Date(Date.now() - 60_000);
  utimesSync(settings, declared, declared);
  writeFileSync(socketOf(made), '');
  recordSeat(made, seat, socketOf(made));
  const state = emptySession();
  state.seats[seat] = {
    stage: 'ready',
    cli: 'claude-code',
    pane: PANE,
    temporary: { like: 'helper', until: '2027-01-01T00:00:00Z' },
  };
  const io = owner(made.root);
  const host = fake(made, { agents: () => [{ name: seat, pane: PANE }] });

  const code = await runSend([seat, 'a note', '--json'], io, host);

  expect(code).toBe(0);
  const sent = JSON.parse(io.out) as { channel?: string };
  expect(sent.channel).toBe('socket');
  expect(host.frames.length).toBe(1);
  expect(reachOf(made, seat, { store: true, state })).toBe('socket');
});

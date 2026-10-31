// A wrapper-launched seat: the launch line starts with an environment assignment, runs `zsh
// <script>`, and passes a settings file of its own; the script execs the CLI, so the pane's
// process name changes while its pid stays. TeamCLI reads the CLI from the team file and the
// address from the pane's own processes, so neither the assignment nor the shell in front defeats
// them. What decides the socket is the declaration the line names and the team file's
// authorization: a launch this build did not write (its own `--settings` file is on the line) is
// not attested, so its accept alone authorizes nothing — the team file's `inbound: accept` is
// what admits the route. `team status` reads the send's own gate, so its reach column can never
// promise a socket the send would not dial.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { emptySession } from '../src/state.ts';
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

/** What `team status` reads for the seat: the comparison's own reach word, with the route's files
 *  named the way the command names them (its state folder and root). */
function reachOf(made: World, seat: string): 'socket' | 'typed' | undefined {
  const loaded = readTeamConfig(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('the fixture team file does not load');
  const live: Live = {
    running: true,
    agents: [{ name: seat, agent: 'claude', pane: PANE, workspace: 'fixture-workspace', status: 'idle', cwd: null }],
    workspaces: [],
    screens: {},
    processes: { [PANE]: { shell: 111, foreground: [CLI_PID] } },
  };
  const rows = compare(
    loaded.team, 'acme', emptySession(), live, NOW, loaded.team.watch, made.sockets,
    false, undefined, undefined, { dir: made.dir, root: made.root },
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

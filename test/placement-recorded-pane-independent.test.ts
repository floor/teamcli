// A caller on the pane a seat's record holds is that seat when the process is the seat's own
// CLI, even when the host has dropped the pane's agent name. The name is put back. A bare
// shell, another CLI, or another pane stays unplaced, and the inbox server follows the same rule.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { placeCaller, type CallerSources } from '../src/caller.ts';
import { setHerdrCapture, setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { runMcpServe, type ServeStreams } from '../src/mcp/serve.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const SESSION = 'crate';
const PANE = 'pane-pebble';
const OTHER = 'pane-other';
const SHELL = 70;
const CLI = 80;
const CONVERSATION = 'conversation-pebble';

const owned: string[] = [];
afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

type Crate = { base: string; root: string; home: string; dir: string };

function crate(conversation?: string): Crate {
  const base = fixtureBase('.recorded-pane-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: crate
coordinator: pebble
operator: pebble
session: crate
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
seats:
  - role: coordinator
    name: pebble
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  const id = teamIdOf(root);
  const agent = registerAgent(home, {
    name: 'Pebble',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    // An unnamed positive pane must prove the same conversation as its registry record.
    reach: { team: id, seat: 'pebble', session: SESSION, pane: PANE, address: null,
      ...(conversation === undefined ? {} : { agent_session: conversation }) },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  upsertTeam(home, id, {
    project: 'crate',
    entity: 'box',
    session: SESSION,
    root,
    lobby,
    roster: [{ agent: agent.id, seat: 'pebble', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.seats.pebble = { stage: 'ready', pane: PANE };
  });
  return { base, root, home, dir };
}

function unnamed(pane: string, conversation?: string): HerdrAgent {
  return { ...(conversation === undefined ? {} : { session: conversation }), name: null, agent: null, pane, workspace: 'ws-crate', status: 'idle', cwd: null };
}

function sources(home: string, pane: string, foreground: readonly string[], processes: { shell: number; foreground: number[] }, conversation?: string): CallerSources {
  const rootPid = pane === PANE ? SHELL : 90;
  return {
    ancestors: () => [
      { pid: CLI, name: 'claude' },
      { pid: rootPid, name: 'zsh' },
      { pid: 50, name: 'herdr' },
      { pid: 1, name: 'launch' },
    ],
    agents: () => [unnamed(pane, conversation)],
    paneRootPid: (asked) => (asked === pane ? rootPid : null),
    env: { HERDR_PANE_ID: pane },
    stdinIsTTY: true,
    home,
    paneProcesses: () => processes,
    foreground: () => [...foreground],
    seatAtPane: () => null,
  };
}

/** The host answers a rename by listing the seat's name on the next read. Nothing is launched. */
function scriptRename(seat: string, pane: string, conversation?: string): void {
  let named = false;
  setHerdrRun((args) => {
    if (args[0] === 'agent' && args[1] === 'list') {
      return {
        agents: [{
          name: named ? seat : '',
          pane_id: pane,
          workspace_id: 'ws-crate',
          agent: 'claude',
          agent_status: 'idle',
          ...(conversation === undefined ? {} : { agent_session: conversation }),
        }],
      };
    }
    return { agents: [] };
  });
  setHerdrCapture((args) => {
    if (args[0] === 'agent' && args[1] === 'rename' && args[2] === pane && args[3] === seat) named = true;
    return JSON.stringify({ result: true });
  });
}

function logText(dir: string): string {
  try {
    return readFileSync(join(dir, LOG_FILE), 'utf8');
  } catch {
    return '';
  }
}

test('the recorded pane with no host name and this seat\'s CLI is placed, and the name is put back', () => {
  const made = crate(CONVERSATION);
  scriptRename('pebble', PANE, CONVERSATION);
  const placed = placeCaller(sources(made.home, PANE, ['claude'], { shell: SHELL, foreground: [CLI] }, CONVERSATION), SESSION);
  expect(placed).toEqual({ kind: 'seat', name: 'pebble', pane: PANE, session: SESSION });
  expect(logText(made.dir)).toContain(`re-applied the herdr name on pane ${PANE}`);
});

test('the same pane running a bare shell stays unplaced', () => {
  const made = crate();
  scriptRename('pebble', PANE);
  const placed = placeCaller(sources(made.home, PANE, ['zsh'], { shell: SHELL, foreground: [] }), SESSION);
  expect(placed.kind).toBe('unplaced');
  expect(logText(made.dir)).not.toContain('re-applied the herdr name');
});

test('the same pane running another CLI stays unplaced', () => {
  const made = crate();
  scriptRename('pebble', PANE);
  const placed = placeCaller(sources(made.home, PANE, ['codex'], { shell: SHELL, foreground: [81] }), SESSION);
  expect(placed.kind).toBe('unplaced');
  expect(logText(made.dir)).not.toContain('re-applied the herdr name');
});

test('another pane stays unplaced', () => {
  const made = crate();
  scriptRename('pebble', OTHER);
  const placed = placeCaller(sources(made.home, OTHER, ['claude'], { shell: 91, foreground: [92] }), SESSION);
  expect(placed.kind).toBe('unplaced');
  expect(logText(made.dir)).not.toContain('re-applied the herdr name');
});

function stoppedClock(): { sleep: () => Promise<void>; now: () => number } {
  let at = 0;
  return {
    sleep: async () => {
      at += 10_000;
    },
    now: () => at,
  };
}

async function* noLines(): AsyncGenerator<string> {}

function streams(): ServeStreams {
  return { lines: noLines(), write: () => {} };
}

async function serve(made: Crate, pane: string, foreground: readonly string[], processes: { shell: number; foreground: number[] }, conversation?: string) {
  const io = testIo(made.root);
  io.env = { HERDR_PANE_ID: pane };
  io.stdinIsTTY = true;
  io.callerSources = () => sources(made.home, pane, foreground, processes, conversation);
  return runMcpServe(
    { seat: 'pebble', session: SESSION, file: join(made.dir, 'team.yaml') },
    io,
    streams(),
    {
      home: made.home,
      build: { version: '0.0.0-test', build: 'test', builtAt: 0, head: null },
      installed: () => ({ version: '0.0.0-test', head: null }),
      restart: () => { throw new Error('the scene must not start a process'); },
    },
    stoppedClock(),
  );
}

test('the inbox server starts on the recorded pane and refuses a bare shell, another CLI, and another pane', async () => {
  const placed = crate(CONVERSATION);
  scriptRename('pebble', PANE, CONVERSATION);
  const started = await serve(placed, PANE, ['claude'], { shell: SHELL, foreground: [CLI] }, CONVERSATION);
  expect(started).toBe(0);
  expect(logText(placed.dir)).toContain(`re-applied the herdr name on pane ${PANE}`);

  const shell = crate();
  scriptRename('pebble', PANE);
  const shellIo = testIo(shell.root);
  shellIo.env = { HERDR_PANE_ID: PANE };
  shellIo.stdinIsTTY = true;
  shellIo.callerSources = () => sources(shell.home, PANE, ['zsh'], { shell: SHELL, foreground: [] });
  const bare = await runMcpServe(
    { seat: 'pebble', session: SESSION, file: join(shell.dir, 'team.yaml') },
    shellIo,
    streams(),
    { home: shell.home, restart: () => { throw new Error('the scene must not start a process'); } },
    stoppedClock(),
  );
  expect(bare).toBe(2);
  expect(shellIo.err).toContain('no herdr name');

  const otherCli = crate();
  scriptRename('pebble', PANE);
  const cliIo = testIo(otherCli.root);
  cliIo.env = { HERDR_PANE_ID: PANE };
  cliIo.stdinIsTTY = true;
  cliIo.callerSources = () => sources(otherCli.home, PANE, ['codex'], { shell: SHELL, foreground: [81] });
  const foreign = await runMcpServe(
    { seat: 'pebble', session: SESSION, file: join(otherCli.dir, 'team.yaml') },
    cliIo,
    streams(),
    { home: otherCli.home, restart: () => { throw new Error('the scene must not start a process'); } },
    stoppedClock(),
  );
  expect(foreign).toBe(2);
  expect(cliIo.err).toContain('no herdr name');

  const elsewhere = crate();
  scriptRename('pebble', OTHER);
  const elsewhereIo = testIo(elsewhere.root);
  elsewhereIo.env = { HERDR_PANE_ID: OTHER };
  elsewhereIo.stdinIsTTY = true;
  elsewhereIo.callerSources = () => sources(elsewhere.home, OTHER, ['claude'], { shell: 91, foreground: [92] });
  const moved = await runMcpServe(
    { seat: 'pebble', session: SESSION, file: join(elsewhere.dir, 'team.yaml') },
    elsewhereIo,
    streams(),
    { home: elsewhere.home, restart: () => { throw new Error('the scene must not start a process'); } },
    stoppedClock(),
  );
  expect(moved).toBe(2);
  expect(elsewhereIo.err).toContain('no herdr name');
});

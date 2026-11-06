// The push class is read from the seat's runtime launch line. The team-file row stays a
// plain launch. A cross-team drop prints one statement that names the full address, and a
// same-team drop keeps the bus-inbox line.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER } from '../src/mcp/channel.ts';
import { writeListener } from '../src/mcp/inbox.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertTeam } from '../src/registry/teams.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { NativePane } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T06:40:00.000Z');
const PANE = 'fixture-pane-one';
const KEEPER_PANE = 'fixture-pane-two';
const FOREGROUND = 4242;
const OAK_ID = 'a1b2c3d4e5f6';
const ELM_ID = 'b2c3d4e5f6a1';
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

type World = {
  home: string;
  root: string;
  elm: string;
  dir: string;
  elmDir: string;
  sockets: string;
  native: NativePane;
  frames: string[];
};

function quietNative(): NativePane {
  return {
    typeText: () => true,
    pressEnter: () => true,
    status: () => 'working',
    wait: async () => {},
    paneText: () => '',
  };
}

function teamFile(root: string, project: string, lobby: string, inbound = false): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${project}
coordinator: keeper
operator: keeper
session: morning
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: keeper
    ${inbound ? 'inbound: accept\n    ' : ''}cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: clerk
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
}

function world(): World {
  const base = fixtureBase('claude-push-runtime-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  const elm = join(base, 'elm');
  const sockets = join(base, 'sockets');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  for (const one of [root, elm]) {
    mkdirSync(join(one, '.agents'), { recursive: true, mode: 0o700 });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'init', '-q', '-b', 'main'], {
      cwd: one,
      env: gitEnv(),
      stdio: 'ignore',
    });
  }
  const lobby = lobbyDir(home);
  teamFile(root, 'oak', lobby);
  teamFile(elm, 'elm', lobby, true);
  const frames: string[] = [];
  return {
    home,
    root: realpathSync(root),
    elm: realpathSync(elm),
    dir: join(realpathSync(root), '.agents'),
    elmDir: join(realpathSync(elm), '.agents'),
    sockets,
    native: quietNative(),
    frames,
  };
}

function registerPair(made: World): void {
  const keeper = registerAgent(made.home, {
    by: 'fixture',
    name: 'keeper of elm',
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: 'elm', seat: 'keeper', session: 'morning', pane: KEEPER_PANE, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
  });
  const clerk = registerAgent(made.home, {
    by: 'fixture',
    name: 'clerk of oak',
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: 'oak', seat: 'clerk', session: 'morning', pane: PANE, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
  });
  upsertTeam(made.home, OAK_ID, {
    project: 'oak',
    session: 'morning',
    root: made.root,
    entity: 'north',
    roster: [{ agent: clerk.id, seat: 'clerk', role: 'implementer' }],
  });
  upsertTeam(made.home, ELM_ID, {
    project: 'elm',
    session: 'morning',
    root: made.elm,
    entity: 'north',
    roster: [{ agent: keeper.id, seat: 'keeper', role: 'coordinator' }],
  });
}

function ran(dir: string, seat: string, launch: string): void {
  updateState(dir, (state) => {
    const session = (state.sessions.morning ??= emptySession());
    session.seats[seat] = {
      stage: 'ready',
      pane: seat === 'clerk' ? PANE : KEEPER_PANE,
      cli: 'claude-code',
      launch_line: launch,
    };
  });
}

function hostOf(made: World): SendHost {
  return {
    agents: () => [
      { name: 'clerk', pane: PANE },
      { name: 'keeper', pane: KEEPER_PANE },
    ],
    processInfo: () => ({ shell: 111, foreground: [FOREGROUND] }),
    socketsDir: made.sockets,
    deliver: async (_path: string, frame: string) => {
      made.frames.push(frame);
      return { ok: true };
    },
    native: made.native,
    now: () => NOW,
    home: made.home,
    channelGraceMs: 30,
    sendId: () => 'fixture-drop-one',
  };
}

function listen(dir: string, root: string, channel: boolean): void {
  const drop = join(dir, 'send-drops', 'morning', 'keeper');
  mkdirSync(drop, { recursive: true, mode: 0o700 });
  const wrote = writeListener(drop, {
    v: 1,
    seat: 'keeper',
    session: 'morning',
    root,
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
    ...(channel ? { channel: true as const } : {}),
  });
  if (!wrote) throw new Error('the listener marker was not written');
}

test('a runtime channel flag pushes even though the team-file row lacks it', async () => {
  const made = world();
  ran(made.dir, 'keeper', `claude ${CHANNEL_FLAG} server:${CHANNEL_SERVER}`);
  listen(made.dir, made.root, true);
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runSend(['keeper', 'hello', '--dry-run'], io, hostOf(made));
  expect(code).toBe(0);
  expect(io.out).toContain('keeper: dry-run: claude-code via its own development channel');
});

test('a runtime settings file that accepts the socket pushes even though the team-file row would install an empty file', async () => {
  const made = world();
  registerPair(made);
  const generated = cliHookSettingsPath(made.elmDir, 'morning', 'keeper');
  if (generated === null) throw new Error('the generated settings path was not named');
  mkdirSync(dirname(generated), { recursive: true, mode: 0o700 });
  writeFileSync(generated, '{}\n');
  const runtime = join(dirname(made.elm), 'runtime-settings.json');
  writeFileSync(runtime, '{"crossSessionInbound":"accept"}\n');
  const past = new Date(NOW.getTime() - 60_000);
  utimesSync(runtime, past, past);
  writeFileSync(join(made.sockets, `${String(FOREGROUND)}.sock`), '');
  ran(made.elmDir, 'keeper', `claude --settings ${runtime}`);
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runSend(['keeper@elm', 'hello'], io, hostOf(made));
  expect(code).toBe(0);
  expect(made.frames).toHaveLength(1);
  expect(made.frames[0]).toContain('hello');
  expect(io.out).toContain('delivered (socket)');
  expect(io.err).not.toContain('queued, no event adapter');
});

test('a cross-team drop names the address in one statement, and a same-team drop keeps the bus-inbox line', async () => {
  const made = world();
  registerPair(made);
  ran(made.elmDir, 'keeper', 'claude');
  ran(made.dir, 'keeper', 'claude');
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runSend(['keeper@elm', 'hello'], io, hostOf(made));
  expect(code).toBe(0);
  expect(made.frames).toHaveLength(0);
  expect(io.err).toBe('');
  expect(io.out).toContain(
    'keeper@elm: queued, not woken (drop, 0 ms); queued; keeper@elm reads it at its next turn, and nothing here gives it one (pull-only)',
  );
  expect(io.out.split('keeper@elm').length - 1).toBe(2);

  const again = testIo(made.root, { kind: 'owner' });
  const same = await runSend(['keeper', 'hello'], again, hostOf(made));
  expect(same).toBe(0);
  expect(again.err).toContain('keeper: queued, no event adapter');
});

// A Claude seat gets the push when a live socket stands, or when its runtime channel flag
// stands, even though the team-file launch line does not carry the flag. The drop line names
// the address once. Written from that spec; runs when builder-4 sends the head.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writeListener } from '../src/mcp/inbox.ts';
import type { NativePane } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-06T06:40:00.000Z');
const PANE = 'fixture-pane-one';
const FOREGROUND = 4242;
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function quietNative(): NativePane & { typed: string[] } {
  const typed: string[] = [];
  return {
    typed,
    typeText: (_session, _pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => true,
    status: () => 'working',
    wait: async () => {},
    paneText: () => '',
  };
}

function world(): { home: string; root: string; dir: string; sockets: string; native: NativePane & { typed: string[] } } {
  const base = fixtureBase('claude-push-flag-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  const lobby = lobbyDir(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: oak
coordinator: clerk
operator: clerk
session: morning
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: keeper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  return { home, root, dir: join(root, '.agents'), sockets, native: quietNative() };
}

function hostOf(made: ReturnType<typeof world>, liveSocket: boolean): SendHost & { native: NativePane & { typed: string[] } } {
  if (liveSocket) writeFileSync(join(made.sockets, `${String(FOREGROUND)}.sock`), '', { mode: 0o600 });
  return {
    agents: () => [
      { name: 'clerk', pane: PANE },
      { name: 'keeper', pane: 'fixture-pane-two' },
    ],
    processInfo: () => ({ shell: 111, foreground: [FOREGROUND] }),
    socketsDir: made.sockets,
    deliver: async () => ({ ok: true }),
    native: made.native,
    now: () => NOW,
    home: made.home,
    channelGraceMs: 30,
    sendId: () => 'fixture-drop-one',
  };
}

function listen(made: ReturnType<typeof world>, channel: boolean): void {
  const drop = join(made.dir, 'send-drops', 'morning', 'keeper');
  mkdirSync(drop, { recursive: true, mode: 0o700 });
  const wrote = writeListener(drop, {
    v: 1,
    seat: 'keeper',
    session: 'morning',
    root: realpathSync(made.root),
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
    ...(channel ? { channel: true as const } : {}),
  });
  if (!wrote) throw new Error('the listener marker was not written');
}

async function dryRun(made: ReturnType<typeof world>, liveSocket: boolean): Promise<string> {
  const io = testIo(made.root, { kind: 'owner' });
  const code = await runSend(['keeper', 'hello', '--dry-run'], io, hostOf(made, liveSocket));
  return `${String(code)}\n${io.out}${io.err}`;
}

test('a runtime channel flag pushes even though the team-file line lacks the flag', async () => {
  const made = world();
  listen(made, true);
  const text = await dryRun(made, false);
  expect(text).toContain('keeper: dry-run: claude-code via its own development channel');
});

test('a live socket pushes even though the team-file line lacks the flag', async () => {
  const made = world();
  const text = await dryRun(made, true);
  expect(text).toContain('keeper: dry-run: claude-code via its own development channel');
});

test('the drop line names the address once', async () => {
  const made = world();
  updateState(made.dir, (state) => {
    const session = emptySession();
    session.seats.clerk = { stage: 'ready', pane: PANE };
    state.sessions.morning = session;
  });
  listen(made, true);
  const io = testIo(made.root, { kind: 'seat', name: 'clerk', pane: PANE, session: 'morning' });
  const code = await runSend(['keeper', 'hello'], io, hostOf(made, false));
  let line = `${io.out}\n${io.err}`;
  try {
    const record = JSON.parse(readFileSync(join(made.dir, 'send-drops', 'morning', 'keeper', 'fixture-drop-one'), 'utf8')) as {
      payload?: { body?: string };
    };
    line = (record.payload?.body ?? '').split('\n')[0] ?? line;
  } catch {
    // The send wrote no record; the line above is the command's own text.
  }
  expect(code).toBe(0);
  expect(line).toContain('clerk@oak');
  expect(line.split('clerk@oak').length - 1).toBe(1);
});

// The send daemon's boundaries: it serves only its own team's session and never reads another
// one; a delivery that ends held — a dialog after the trigger, a composer read-back that does
// not hold the trigger — is never reported delivered; the message history and drop files stay
// 0600 under the project's state folder, never in a lobby and never in the repository; and a
// daemon that dies between the trigger and the Enter leaves the pane holding no body text.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import {
  daemonDropDir,
  startSendDaemon,
  type DaemonHost,
  type SendDaemonHandle,
} from '../src/send/daemon.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { LOG_FILE } from '../src/state.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T17:00:00.000Z');
const RULE = '─'.repeat(30);
const QUESTION_SCREEN = [
  '☐ Scope',
  'Which file should we edit?',
  '❯ 1. src/index.ts',
  '  2. src/cli.ts',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
`;
}

function setupWorld() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-boundaries-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

type Host = DaemonHost & SendHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
};

function makeHost(world: ReturnType<typeof setupWorld>, overrides: Partial<DaemonHost & SendHost> = {}): Host {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };
  const host: Host = {
    typed,
    enters,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: world.sockets,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((item) => item.pane === pane);
        if (last && !enters.includes(pane)) {
          return `${RULE}\n❯ ${last.text}\n${RULE}`;
        }
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: world.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
    ...overrides,
  };
  return host;
}

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

describe('the send daemon\'s boundaries', () => {
  test('a seat that lives only in another session is unreachable and that session is never read', async () => {
    const world = setupWorld();
    const asked: string[] = [];
    const host = makeHost(world, {
      agents: (session) => {
        asked.push(session);
        return session === 'acme'
          ? [{ name: 'lead', pane: 'pane-lead' }, { name: 'native', pane: 'pane-native' }]
          : [{ name: 'helper', pane: 'pane-beta' }];
      },
    });
    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['helper', 'you serve another session'], io, host)).toBe(1);
    expect(io.err).toContain('unreachable: no live agent carries that name in the session');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((session) => session === 'acme')).toBe(true);

    const history = readHistory('acme', world.root, world.home);
    expect(history.ok && history.entries).toEqual([
      { ts: NOW.toISOString(), from: 'owner', to: 'helper', body: 'you serve another session', id: expect.any(String), outcome: 'unreachable' },
    ]);
  });

  test('a dialog that arrives after the trigger holds the message and nothing reports it delivered', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    let typedOnce = false;
    host.native.typeText = (_session, pane, text) => {
      typedOnce = true;
      host.typed.push({ pane, text });
      return true;
    };
    host.native.paneText = () => (typedOnce ? QUESTION_SCREEN : `${RULE}\n❯ \n${RULE}`);

    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['lead', 'blocked by a dialog mid-delivery'], io, host)).toBe(1);
    expect(io.err).toContain('held: the screen reads question');
    expect(host.typed.length).toBe(1);
    expect(host.enters).toEqual([]);

    const history = readHistory('acme', world.root, world.home);
    expect(history.ok && history.entries.map((entry) => entry.outcome)).toEqual(['held']);
    const log = existsSync(join(world.dir, LOG_FILE)) ? readFileSync(join(world.dir, LOG_FILE), 'utf8') : '';
    expect(log).not.toContain('delivered');
  });

  test('a composer read-back that does not hold the trigger is never entered', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    let typedOnce = false;
    host.native.typeText = (_session, pane, text) => {
      typedOnce = true;
      host.typed.push({ pane, text });
      return true;
    };
    host.native.paneText = () => (typedOnce ? `${RULE}\n❯ a draft that is not the trigger\n${RULE}` : `${RULE}\n❯ \n${RULE}`);

    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['lead', 'the composer was clobbered'], io, host)).toBe(1);
    expect(io.err).toContain('held: the composer read-back did not match the trigger');
    expect(host.typed.length).toBe(1);
    expect(host.enters).toEqual([]);

    const history = readHistory('acme', world.root, world.home);
    expect(history.ok && history.entries.map((entry) => entry.outcome)).toEqual(['held']);
  });

  test('a delivered message writes 0600 files under the state folder and none in the lobby or the repository', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['native', 'kept out of the repository'], io, host)).toBe(0);

    const log = historyPath('acme', world.root, world.home);
    expect(lstatSync(log).mode & 0o777).toBe(0o600);
    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    const files = readdirSync(drops);
    expect(files.length).toBe(1);
    for (const file of files) {
      expect(lstatSync(join(drops, file)).mode & 0o777).toBe(0o600);
    }
    const inRepo = readdirSync(world.root, { recursive: true }).map((entry) => String(entry));
    expect(inRepo.some((entry) => entry.includes('send-drops') || entry.endsWith('messages.jsonl'))).toBe(false);
    expect(readdirSync(lobbyDir(world.home))).toEqual([]);
  });

  test('a daemon that dies between the trigger and the Enter leaves no body text in the pane', async () => {
    // The crash is the daemon's own queue worker rejecting; under the runner that rejection
    // would fail this file instead of the daemon, so the scene runs in its own process
    // (test/send-crash-run.ts) and reports what survived it.
    const proc = Bun.spawn(['bun', 'test/send-crash-run.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(exit, err || out).toBe(0);

    const scene = JSON.parse(out) as {
      response: unknown;
      rejections: string[];
      typed: { pane: string; text: string }[];
      triggerFits: boolean;
      triggerHeld: boolean;
      bodyNeverTyped: boolean;
      dropContent: string;
      dropMode: number;
      historyIds: string[];
      logHasDelivered: boolean;
    };
    const id = '11111111-1114-4111-8111-111111111111';
    expect(scene.response).toBeNull();
    expect(scene.rejections.length).toBe(1);
    expect(scene.rejections[0]).toContain('the daemon died between the trigger and the Enter');
    expect(scene.typed.length).toBe(1);
    expect(scene.triggerFits).toBe(true);
    expect(scene.triggerHeld).toBe(true);
    expect(scene.bodyNeverTyped).toBe(true);
    expect(scene.dropContent).toBe('the body that must never reach the composer');
    expect(scene.dropMode).toBe(0o600);
    expect(scene.historyIds).not.toContain(id);
    expect(scene.logHasDelivered).toBe(false);
  });
});

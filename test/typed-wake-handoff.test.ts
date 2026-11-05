// The typed-wake handoff. A send whose receiving profile declares `typed_wake: screen` gives
// the wake to the per-root send daemon instead of typing in the sender's process: the daemon
// validates the line against the measured bound and the receiving profile, stages its own
// durable copy in the queue's store, asks its wake child to run the walk, and answers
// `handed`. The CLI prints the handoff line and exits 0; it never says delivered, because the
// child's walk is the delivery and its outcome is the history's and the trace's.
//
// A daemon that runs no wake child says so (`refused` with `direct: true`) before staging
// anything, and the CLI then runs today's walk itself — exactly once. That marker is the only
// answer a handoff may type on; it is read from the parsed socket answer and nowhere else.
// The scenes below script the pane and the daemon; no real CLI, herdr session or child runs.
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
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import {
  daemonDropDir,
  daemonSocketPath,
  requestDaemon,
  startSendDaemon,
  type DaemonHost,
  type DaemonSendRequest,
  type SendDaemonHandle,
  type WakeHandoff,
} from '../src/send/daemon.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { testIo } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const NOW = new Date('2026-10-14T16:00:00.000Z');
const RULE = '─'.repeat(30);
const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.157.0');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

/** The captured idle frame with `text` drawn in place of the grey suggestion. */
function holding(text: string): string {
  return IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

/** A pane that takes the line once and shows the profile's working screen after one Enter. Its
 *  `wait` costs nothing: these scenes pin the walk's shape, not its settles (typed-wake.test.ts
 *  owns those). */
function wakePane(): { host: TypedWakeHost; typed: string[]; enters: () => number } {
  const typed: string[] = [];
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => {
      const last = typed.at(-1);
      if (last === undefined) return IDLE;
      return enters === 0 ? holding(last) : WORKING;
    },
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return { host, typed, enters: () => enters };
}

type World = { root: string; dir: string; sockets: string; home: string; team: TeamFile };

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
# The inbox is tried and skipped for want of a listener, then the typed leg is handed to the
# daemon; the default's drop step stands behind it in the walk.
delivery_order: [mcp-inbox, typed]
`;
}

function setupWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-typed-wake-handoff-')));
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
  wakeCalls: string[];
  pane: ReturnType<typeof wakePane>;
};

function makeHost(world: World, overrides: Partial<DaemonHost & SendHost> = {}): Host {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const wakeCalls: string[] = [];
  const pane = wakePane();
  const host: Host = {
    typed,
    enters,
    wakeCalls,
    pane,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: world.sockets,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, paneName, text) => {
        typed.push({ pane: paneName, text });
        return true;
      },
      pressEnter: (_session, paneName) => {
        enters.push(paneName);
        return true;
      },
      status: () => 'idle',
      wait: async () => {},
      paneText: () => `${RULE}\n› \n${RULE}`,
    },
    typedWake: (session) => {
      wakeCalls.push(session);
      return pane.host;
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

/** The CLI's evidence folder for one seat: the signed record and its dotted markers. */
function cliDrops(world: World, seat: string): string {
  return join(world.dir, 'send-drops', 'acme', seat);
}

/** One non-dotted record name in a folder, or an empty list when the folder is absent. */
function recordsIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => !name.includes('.'));
}

describe('the typed wake handed to the daemon', () => {
  test('the CLI returns at acceptance and prints the handoff line; the daemon stages the copy and asks its wake child', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const wakes: WakeHandoff[] = [];
    const started = await startSendDaemon({
      root: world.root,
      dir: world.dir,
      team: world.team,
      host,
      wake: (wake) => wakes.push(wake),
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    const code = await runSend(['native', 'hello'], io, host);
    expect(code).toBe(0);
    expect(io.out).toMatch(/^team acme, session "acme"\nnative: handed to the daemon for a typed wake \(typed, \d+ ms; id [0-9a-f-]+\)\n$/);
    const id = /id ([0-9a-f-]+)\)/.exec(io.out)?.[1] ?? '';
    expect(id).not.toBe('');

    // This process typed nothing and ran no walk: the daemon's child owns the screen.
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.wakeCalls).toEqual([]);
    expect(host.pane.typed).toEqual([]);
    expect(host.pane.enters()).toBe(0);

    // The daemon admitted exactly the values the request carried: one line, within the
    // measured bound, for the live seat's own name and profile.
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake.id).toBe(id);
    expect(wake.seat).toBe('native');
    expect(wake.session).toBe('acme');
    expect(wake.cli).toBe('codex');
    expect(wake.line).toContain('hello');
    expect(wake.line).toContain('Read it with: team drops --read.');
    expect(wake.line.includes('\n')).toBe(false);
    expect(wake.line.length).toBeLessThanOrEqual(200);

    // Two durable copies of the same signed record: the CLI's staged episode before the dial,
    // and the daemon's own store copy staged before it answered.
    const staged = join(cliDrops(world, 'native'), id);
    const stored = join(daemonDropDir('acme', world.root, world.home, 'acme', 'native'), id);
    expect(wake.dropPath).toBe(stored);
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(stored)).toBe(true);
    expect(lstatSync(stored).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(stored)).mode & 0o777).toBe(0o700);
    // The CLI's copy is the signed record it staged before the dial; the daemon's copy is the
    // message body it staged before answering. Both are under the same id, one per side.
    expect(readFileSync(staged, 'utf8')).toContain('hello');
    expect(readFileSync(stored, 'utf8')).toContain('hello');

    // No leg took the send, so no history line is written here: the child's typed outcome is
    // the history's one line, and the handoff is never a delivery.
    const history = readHistory('acme', world.root, world.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries).toEqual([]);
  });

  test('a daemon that runs no wake child refuses without staging, and this process runs the walk exactly once', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['native', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nnative: delivered (typed wake)\n');

    // One direct walk, not two: one type, one Enter. One staged record and its marker — the
    // pre-dial stage and the walk's own write are the same record, create-or-match.
    expect(host.wakeCalls).toEqual(['acme']);
    expect(host.pane.typed).toHaveLength(1);
    expect(host.pane.enters()).toBe(1);
    expect(host.typed).toEqual([]);
    const drops = cliDrops(world, 'native');
    expect(recordsIn(drops)).toHaveLength(1);
    expect(readFileSync(join(drops, recordsIn(drops)[0]!), 'utf8')).toContain('hello');

    // The refusal staged nothing in the daemon's store: no child, no copy, no marker.
    expect(recordsIn(daemonDropDir('acme', world.root, world.home, 'acme', 'native'))).toEqual([]);

    // The direct walk's delivery is the one history line, through the typed leg.
    const history = readHistory('acme', world.root, world.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'native', outcome: 'delivered (typed wake)', via: 'typed' });
    }
  });

  test('no daemon at the socket path: the walk runs here as today', async () => {
    const world = setupWorld();
    const host = makeHost(world);

    const io = ownerIo(world.root);
    expect(await runSend(['native', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nnative: delivered (typed wake)\n');
    expect(host.wakeCalls).toEqual(['acme']);
    expect(host.pane.typed).toHaveLength(1);
    expect(host.pane.enters()).toBe(1);
    expect(recordsIn(cliDrops(world, 'native'))).toHaveLength(1);
  });

  test('a --wait send never hands the wake off: the walk this process runs is the wake it waits on', async () => {
    const world = setupWorld();
    const host = makeHost(world, { waitMs: 0 });
    const wakes: WakeHandoff[] = [];
    const started = await startSendDaemon({
      root: world.root,
      dir: world.dir,
      team: world.team,
      host,
      wake: (wake) => wakes.push(wake),
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = ownerIo(world.root);
    expect(await runSend(['native', 'hello', '--wait', '--timeout', '1'], io, host)).toBe(0);
    expect(io.out).toContain('native: delivered (typed wake)');
    expect(wakes).toEqual([]);
    expect(host.wakeCalls).toEqual(['acme']);
    expect(host.pane.typed).toHaveLength(1);
  });

  test('a socket that exists but answers nothing is never typed on here: the staged record is queued', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const socket = daemonSocketPath('acme', world.root, world.home);
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    writeFileSync(socket, 'not a socket\n', { mode: 0o600 });

    const io = ownerIo(world.root);
    expect(await runSend(['native', 'hello'], io, host)).toBe(0);
    // The handoff was attempted, so this process keeps its hands off the pane: a daemon that
    // took the request and died before answering may still have a child.
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.wakeCalls).toEqual([]);
    expect(host.pane.typed).toEqual([]);
    expect(io.out).toContain('native: queued, not woken (drop');
    expect(io.out).toContain('the typed wake failed (the daemon did not answer the typed wake request; nothing was typed here)');
  });
});

describe('the daemon’s typed-wake admission', () => {
  test('hands a valid line over, and refuses a waited, malformed or unbounded one without staging or waking', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const wakes: WakeHandoff[] = [];
    const started = await startSendDaemon({
      root: world.root,
      dir: world.dir,
      team: world.team,
      host,
      wake: (wake) => wakes.push(wake),
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);
    const sock = started.handle.socketPath;

    const answer = (request: DaemonSendRequest) => requestDaemon(sock, request);
    const refused = async (request: DaemonSendRequest, detail: string) => {
      const res = await answer(request);
      expect(res && 'outcome' in res ? res.outcome : null).toBe('refused');
      expect(res && 'detail' in res ? res.detail : '').toContain(detail);
    };

    await refused(
      { v: 1, op: 'send', id: 'waited', from: 'owner', to: 'native', body: 'b', typedWake: { trigger: 'one line' }, wait: true },
      'cannot wait',
    );
    await refused(
      { v: 1, op: 'send', id: 'no-profile', from: 'owner', to: 'lead', body: 'b', typedWake: { trigger: 'one line' } },
      'declares no typed wake',
    );
    await refused(
      { v: 1, op: 'send', id: 'multiline', from: 'owner', to: 'native', body: 'b', typedWake: { trigger: 'one\nline' } },
      'control character',
    );
    await refused(
      { v: 1, op: 'send', id: 'empty', from: 'owner', to: 'native', body: 'b', typedWake: { trigger: '' } },
      'empty',
    );
    await refused(
      { v: 1, op: 'send', id: 'long', from: 'owner', to: 'native', body: 'b', typedWake: { trigger: 'x'.repeat(201) } },
      'past the measured 200',
    );
    expect(wakes).toEqual([]);
    expect(host.pane.typed).toEqual([]);
    expect(recordsIn(daemonDropDir('acme', world.root, world.home, 'acme', 'native'))).toEqual([]);

    const handed = await answer({ v: 1, op: 'send', id: 'good', from: 'owner', to: 'native', body: 'the body', typedWake: { trigger: 'one line' } });
    expect(handed && 'outcome' in handed ? handed.outcome : null).toBe('handed');
    expect(handed && 'drop_path' in handed ? handed.drop_path : '').toBe(
      join(daemonDropDir('acme', world.root, world.home, 'acme', 'native'), 'good'),
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.line).toBe('one line');
    expect(wakes[0]!.id).toBe('good');
    expect(readFileSync(wakes[0]!.dropPath, 'utf8')).toBe('the body');
    expect(recordsIn(daemonDropDir('acme', world.root, world.home, 'acme', 'native'))).toEqual(['good']);
  });

  test('a daemon with no wake child says direct: true and stages nothing', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const res = await requestDaemon(started.handle.socketPath, {
      v: 1, op: 'send', id: 'childless', from: 'owner', to: 'native', body: 'the body', typedWake: { trigger: 'one line' },
    });
    expect(res && 'outcome' in res ? res.outcome : null).toBe('refused');
    expect(res && 'direct' in res ? res.direct : null).toBe(true);
    expect(res && 'detail' in res ? res.detail : '').toContain('runs no typed wake child');
    expect(recordsIn(daemonDropDir('acme', world.root, world.home, 'acme', 'native'))).toEqual([]);
    expect(host.pane.typed).toEqual([]);
  });

  test('a conflicting holder at the id refuses the handoff and is left untouched', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const wakes: WakeHandoff[] = [];
    const started = await startSendDaemon({
      root: world.root,
      dir: world.dir,
      team: world.team,
      host,
      wake: (wake) => wakes.push(wake),
    });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    mkdirSync(drops, { recursive: true, mode: 0o700 });
    const held = join(drops, 'held-id');
    writeFileSync(held, 'an earlier holder\n', { mode: 0o600 });

    const res = await requestDaemon(started.handle.socketPath, {
      v: 1, op: 'send', id: 'held-id', from: 'owner', to: 'native', body: 'a different body', typedWake: { trigger: 'one line' },
    });
    expect(res && 'outcome' in res ? res.outcome : null).toBe('refused');
    expect(res && 'detail' in res ? res.detail : '').toBe('native: the drop file could not be written; nothing was typed');
    expect(wakes).toEqual([]);
    expect(readFileSync(held, 'utf8')).toBe('an earlier holder\n');
  });
});

// Independent acceptance for the send daemon's adoption of the relay package at 96eb1535d.
// It checks the boundary and the order the commit claims: the listener frames through the shared
// host (no second parser, exact answer bytes, the body limit left where this socket had it), the
// durable copy is the relay's create-or-match write and is on disk before anything is typed, and
// admission, queueing, history and the socket path's lifecycle remain the daemon's.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { POLICY_CATALOGUE } from '../src/policy/types.ts';
import { resolvePolicy } from '../src/policy/resolve.ts';
import { readHistory } from '../src/send/history.ts';
import {
  daemonDropDir,
  requestDaemon,
  startSendDaemon,
  type DaemonHost,
  type SendDaemonHandle,
} from '../src/send/daemon.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-10-20T04:00:00.000Z');
const RULE = '─'.repeat(30);
const REFUSAL = (detail: string): string =>
  `${JSON.stringify({ v: 1, ok: false, id: null, seat: '', outcome: 'refused', detail })}\n`;
const INVALID = 'invalid daemon request';

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
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
delivery_order: [mcp-inbox, typed]
`;
}

function setupWorld() {
  base = realpathSync(mkdtempSync(join('/tmp', 'b7-hostadopt-')));
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

type World = ReturnType<typeof setupWorld>;

function makeHost(
  world: World,
  onTyped?: (pane: string, text: string) => void,
): DaemonHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  setStatus: (pane: string, status: string) => void;
} {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };
  return {
    typed,
    enters,
    setStatus: (pane, status) => { statusByPane[pane] = status; },
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: world.sockets,
    deliver: async () => ({ ok: true }),
    native: {
      typeText: (_session, pane, text) => {
        onTyped?.(pane, text);
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
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last && !enters.includes(pane)) return `${RULE}\n❯ ${last.text}\n${RULE}`;
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: world.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  };
}

async function serve(world: World, host: ReturnType<typeof makeHost>): Promise<SendDaemonHandle> {
  const started = await startSendDaemon({ root: world.root, dir: world.dir, team: world.team, host });
  if (started.kind !== 'serving') throw new Error(started.kind);
  handles.push(started.handle);
  return started.handle;
}

/** One raw line, and the exact text the listener answered with. */
function rawLine(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let answer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the listener did not answer'));
    }, 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: string) => { answer += chunk; });
    socket.on('end', () => { clearTimeout(timer); resolve(answer); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function outcomeOf(answer: Awaited<ReturnType<typeof requestDaemon>>): string | null {
  return answer !== null && 'outcome' in answer ? answer.outcome : null;
}

function detailOf(answer: Awaited<ReturnType<typeof requestDaemon>>): string {
  return answer !== null && 'detail' in answer ? answer.detail : '';
}

describe('the listener frames through the shared relay host, not a second parser', () => {
  test('both daemons use the package host and neither opens a server of its own', () => {
    const send = readFileSync(join(import.meta.dir, '..', 'src', 'send', 'daemon.ts'), 'utf8');
    const machine = readFileSync(join(import.meta.dir, '..', 'src', 'daemon', 'host.ts'), 'utf8');
    for (const source of [send, machine]) {
      expect(source).toContain('createHostServer');
      expect(source).not.toMatch(/createServer\s*\(/);
    }
    // The old request parser is gone: the frame text is decoded by the package, and this socket
    // keeps its own unbounded body acceptance.
    expect(send).not.toMatch(/JSON\.parse\(line\)/);
    expect(send).toContain('frameLimit: Number.MAX_SAFE_INTEGER');
  });

  test('ping, malformed and unknown-op answers are the same exact bytes, written verbatim', async () => {
    const world = setupWorld();
    const handle = await serve(world, makeHost(world));
    const ping = `${JSON.stringify({ v: 1, ok: true, pong: true, pid: process.pid })}\n`;
    expect(await rawLine(handle.socketPath, JSON.stringify({ v: 1, op: 'ping' }))).toBe(ping);
    expect(await rawLine(handle.socketPath, 'this is not json')).toBe(REFUSAL(INVALID));
    // Before the shared host an unknown op was simply not answered; the frame's caller waited
    // out its own deadline. It now receives the malformed line's refusal, byte for byte.
    expect(await rawLine(handle.socketPath, JSON.stringify({ v: 1, op: 'nonsense' }))).toBe(REFUSAL(INVALID));
  });

  test('a body past the machine limit still lands, byte for byte, through the same frame', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const handle = await serve(world, host);
    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    const body = `é—世 ${'x'.repeat(70_000)}`;
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(65_536);
    const answer = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'big-body', from: 'owner', to: 'native', body });
    expect(outcomeOf(answer)).toBe('delivered');
    expect(host.typed.length).toBe(1);
    const drop = readFileSync(join(drops, 'big-body'));
    expect(drop.equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(statSync(join(drops, 'big-body')).mode & 0o777).toBe(0o600);
    expect(lstatSync(drops).mode & 0o777).toBe(0o700);
  });
});

describe('the drop is staged before the route, and the write is create-or-match', () => {
  test('at type time the copy is already on disk with the exact body; the trigger names its path', async () => {
    const world = setupWorld();
    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    const seen: Array<{ text: string; bytes: string | null }> = [];
    const host = makeHost(world, (_pane, text) => {
      const path = join(drops, 'ordered');
      seen.push({ text, bytes: existsSync(path) ? readFileSync(path, 'utf8') : null });
    });
    const handle = await serve(world, host);
    const body = 'the body this send carries — unchanged';
    const answer = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'ordered', from: 'owner', to: 'native', body });
    expect(outcomeOf(answer)).toBe('delivered');
    // The route (typing the trigger) observed the durable copy first; the package's stage is not
    // a step that happens after the route.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bytes).toBe(body);
    expect(seen[0]!.text).toContain('ordered');
    expect(readFileSync(join(drops, 'ordered'), 'utf8')).toBe(body);
  });

  test('identical bytes at the name are reused untouched, a different holder refuses and stands', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const handle = await serve(world, host);
    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    mkdirSync(drops, { recursive: true, mode: 0o700 });

    const same = join(drops, 'same-id');
    writeFileSync(same, 'the same body', { mode: 0o600 });
    const before = statSync(same);
    const delivered = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'same-id', from: 'owner', to: 'native', body: 'the same body' });
    const after = statSync(same);
    expect(outcomeOf(delivered)).toBe('delivered');
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(readFileSync(same, 'utf8')).toBe('the same body');
    expect(host.typed.length).toBe(1);

    const held = join(drops, 'held-id');
    writeFileSync(held, 'an earlier holder\n', { mode: 0o600 });
    const refused = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'held-id', from: 'owner', to: 'native', body: 'a different body' });
    expect(outcomeOf(refused)).toBe('refused');
    expect(detailOf(refused)).toBe('native: the drop file could not be written; nothing was typed');
    expect(readFileSync(held, 'utf8')).toBe('an earlier holder\n');
    // The refused send typed nothing: the route never ran.
    expect(host.typed.length).toBe(1);
  });
});

describe('admission, queue, history and the socket path stay the daemon’s', () => {
  test('a seat that is not the orchestrator is refused before any drop or route', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const handle = await serve(world, host);
    const drops = daemonDropDir('acme', world.root, world.home, 'acme', 'native');
    const refused = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'seat-send', from: 'native', to: 'lead', body: 'hello' });
    expect(outcomeOf(refused)).toBe('refused');
    expect(detailOf(refused)).toBe('a seat may not send (native): only the owner, or the orchestrator from its own seat, can send');
    expect(host.typed).toEqual([]);
    expect(existsSync(join(drops, 'seat-send'))).toBe(false);
  });

  test('two sends through the one dispatcher are each queued and delivered, and history keeps both', async () => {
    const world = setupWorld();
    const host = makeHost(world);
    const handle = await serve(world, host);
    const one = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'queued-1', from: 'owner', to: 'native', body: 'first' });
    expect(outcomeOf(one)).toBe('delivered');
    // A busy seat legitimately holds the next send until it is free; the queue is still the
    // daemon's, and a send that arrives when the seat is idle is delivered in turn.
    host.setStatus('pane-native', 'idle');
    const two = await requestDaemon(handle.socketPath, { v: 1, op: 'send', id: 'queued-2', from: 'owner', to: 'native', body: 'second' });
    expect(outcomeOf(two)).toBe('delivered');
    expect(host.typed).toHaveLength(2);
    expect(host.typed[0]!.text).toContain('queued-1');
    expect(host.typed[1]!.text).toContain('queued-2');

    const history = readHistory(world.team.project, world.root, world.home);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const ids = history.entries.map((entry) => entry.id);
    expect(ids).toContain('queued-1');
    expect(ids).toContain('queued-2');
  });

  test('the socket is the daemon’s: 0600 while serving, removed on close, a foreign holder is never touched', async () => {
    const world = setupWorld();
    const handle = await serve(world, makeHost(world));
    expect(lstatSync(handle.socketPath).mode & 0o777).toBe(0o600);
    await handle.close();
    expect(existsSync(handle.socketPath)).toBe(false);

    const second = setupWorld();
    const foreign = join(second.sockets, 'held.sock');
    writeFileSync(foreign, 'not a socket');
    const started = await startSendDaemon({
      root: second.root,
      dir: second.dir,
      team: second.team,
      host: makeHost(second),
      socketPath: foreign,
    });
    expect(started.kind).toBe('bind-failed');
    expect(started.kind === 'bind-failed' ? started.reason : '').toBe('the daemon socket path holds a file');
    expect(readFileSync(foreign, 'utf8')).toBe('not a socket');
  });

  test('the broker is off by default, as this daemon’s policy inheritance says', () => {
    expect(POLICY_CATALOGUE['daemon.broker']!.defaultValue).toBe('off');
    const resolved = resolvePolicy<'on' | 'off'>('daemon.broker', []);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.effective.value).toBe('off');
      expect(resolved.effective.level).toBe('default');
    }
  });
});

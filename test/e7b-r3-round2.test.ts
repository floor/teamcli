// E7b revision 3, code round 1 findings:
//   1. a stamped send never dials the daemon (the carrier is deleted, not guarded);
//   2. a history line for a stamped message stays body-free after a rollback to dark;
//   3. an older requester's (protocol 1) relayed ack or reply is refused on a root not proven dark.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { activate, deactivate, floorState, type FloorActor } from '../src/queue/floor.ts';
import { nativePendingDir, seatMailDirs } from '../src/queue/mail-tree.ts';
import { outboxFolder, relayOutboxes, type OutboxProtocol, type RelaySources } from '../src/send/confined-outbox.ts';
import { appendHistory, readHistory } from '../src/send/history.ts';
import { writePending, type PendingNative } from '../src/send/pending.ts';
import { signRecord, stampedPayload, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { level2Tree } from './e7a-fixture.ts';
import { world as nativeFixtureWorld } from './send-native-fixtures.ts';
import { protocol1Refusal, relayConfinedOutboxes } from '../src/commands/watch.ts';
import { updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const e7a = level2Tree();
const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const SECRET = 'the secret stamped body';
const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');

let bases: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  if (bases.length > 0) discardFixtures(bases, { roots: [dirname(bases[0] as string), shortSocketBase()] });
  bases = [];
});

/** Every file under `dir` whose bytes hold `text`. */
function holding(dir: string, text: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    let names: string[];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path, 'utf8').includes(text)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

type Made = { root: string; dir: string; home: string; socket: string };

/** A team whose `worker` seat takes typed delivery; the daemon socket path is in a short folder. */
function world(): Made {
  const base = fixtureBase('e7b-r3r2-');
  bases.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const socketDir = join(shortSocketBase(), `e7b-r3r2-${basename(base)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(socketDir, { recursive: true });
  bases.push(socketDir);
  messageKeyOf(home);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Fixture
    version: "1"
    launch: claude
  - role: implementer
    name: worker
    cli: muse
    vendor: test
    model: Fixture
    version: "1"
    launch: muse
delivery_order: [mcp-inbox, typed]
`, { mode: 0o600 });
  if (!loadTeamFile(root, { home }).ok) throw new Error('the fixture team did not load');
  return { root, dir, home, socket: join(socketDir, 'daemon.sock') };
}

function hostOf(made: Made): SendHost {
  return {
    agents: () => [{ name: 'worker', pane: 'fixture-pane' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: dirname(made.socket),
    daemonSocket: made.socket,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {}, paneText: () => IDLE },
    typedWake: () => ({ read: () => IDLE, type: () => true, enter: () => true, wait: async () => {} }),
    now: () => new Date(),
    home: made.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  } as unknown as SendHost;
}

/** A stand-in at the daemon's socket path that records every byte it is sent. */
async function listener(path: string): Promise<{ connections: () => number; bytes: () => string }> {
  let connections = 0;
  let bytes = '';
  const server = createServer((socket) => {
    connections += 1;
    socket.on('data', (chunk) => {
      bytes += chunk.toString('utf8');
      socket.end(`${JSON.stringify({ v: 1, ok: false, id: null, outcome: 'refused', detail: 'a stand-in' })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { connections: () => connections, bytes: () => bytes };
}

describe('finding 1: a stamped send never dials the daemon', () => {
  test('on an active root the send stages its stamped record and no byte reaches the daemon socket', async () => {
    const made = world();
    expect(activate(made.root, { home: made.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const peer = await listener(made.socket);
    await runSend(['worker', SECRET], testIo(made.root, { kind: 'owner' }), hostOf(made));
    expect(peer.connections()).toBe(0);
    expect(peer.bytes()).toBe('');
    const stamped = seatMailDirs(made.root, SESSION, 'worker').stamped;
    expect(readdirSync(stamped).some((name) => /^[0-9a-f-]{36}$/.test(name))).toBe(true);
    // The body sits only in the stamped tree.
    expect(holding(made.dir, SECRET).every((path) => path.startsWith(`${join(made.dir, 'send-stamped')}/`))).toBe(true);
  });

  test('on a dark root the send still dials the daemon (the unstamped path is unchanged)', async () => {
    const made = world();
    const peer = await listener(made.socket);
    await runSend(['worker', 'a plain body'], testIo(made.root, { kind: 'owner' }), hostOf(made));
    expect(peer.connections()).toBeGreaterThan(0);
  });
});

describe('finding 2: the era rides with the message into history, not the floor at write time', () => {
  function place(): { root: string; home: string } {
    const base = fixtureBase('e7b-r3r2h-');
    bases.push(base);
    const root = join(base, 'project');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home, { mode: 0o700 });
    messageKeyOf(home);
    mkdirSync(seatMailDirs(root, SESSION, 'lead').legacy, { recursive: true, mode: 0o700 });
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    return { root, home };
  }
  const payload = (root: string, id: string, lvl?: 3): RecordPayload => ({ kind: 'message', id, to: 'lead', to_id: null, root, session: SESSION, at: new Date().toISOString(), body: SECRET, from: 'worker', from_id: null, rule: 'the owner', thread: id, ...(lvl === undefined ? {} : { lvl }) });
  const line = (id: string) => ({ ts: new Date().toISOString(), from: 'worker', to: 'lead', body: SECRET, id, outcome: 'sent' });
  async function noBodyForLevel2(root: string, home: string): Promise<void> {
    const read = readHistory('acme', root, home);
    expect(read.ok && read.entries.every((entry) => entry.body === '')).toBe(true);
    expect(holding(home, SECRET)).toEqual([]);
    if (e7a !== null) {
      const history = await import(`${e7a}/send/history.ts`);
      const old = history.readHistory('acme', root, home);
      expect(old.ok && old.entries.every((entry: { body: string }) => entry.body === '')).toBe(true);
    }
  }

  test('a send that stamped its message, then a rollback, then its final history line: body-free', async () => {
    const at = place();
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e61';
    expect(stampedPayload(payload(at.root, id), at.home).lvl).toBe(3);
    expect(deactivate(at.root, at.home).kind).toBe('dark');
    expect(floorState(at.root, at.home).kind).toBe('dark');
    appendHistory('acme', at.root, at.home, line(id));
    await noBodyForLevel2(at.root, at.home);
  });

  test('another process\'s line for a stamped record standing on disk, after a rollback: body-free', async () => {
    const at = place();
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e62';
    // Stamped by "another process": written with its stamp, never noted in this one.
    expect(writeRecord(seatMailDirs(at.root, SESSION, 'lead').legacy, signRecord(payload(at.root, id, 3), at.home)).ok).toBe(true);
    deactivate(at.root, at.home);
    appendHistory('acme', at.root, at.home, line(id));
    await noBodyForLevel2(at.root, at.home);
  });

  test('a stamped native handoff that finishes after a rollback writes a body-free line', async () => {
    const at = place();
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e63';
    const pending = { v: 1, id, nonce: 'nv-00000000', ts: new Date().toISOString(), from: 'worker', from_id: null, to: 'lead', to_id: null, team: 'acme', session: SESSION, cli: 'claude-code', pane: 'w1:p1', address: 'uds:/nowhere', rule: 'the owner', project: 'acme', root: at.root, fallback: [], body: SECRET } as unknown as PendingNative;
    expect(writePending('acme', at.root, at.home, pending, true).ok).toBe(true);
    expect(existsSync(join(nativePendingDir(at.root), `${id}.json`))).toBe(true);
    deactivate(at.root, at.home);
    appendHistory('acme', at.root, at.home, line(id));
    await noBodyForLevel2(at.root, at.home);
  });

  test('a dark root\'s line for an unstamped message keeps its body', () => {
    const at = place();
    deactivate(at.root, at.home);
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e64';
    appendHistory('acme', at.root, at.home, { ...line(id), body: 'plain' });
    const read = readHistory('acme', at.root, at.home);
    expect(read.ok && read.entries.at(-1)?.body).toBe('plain');
  });
});

// Round 3 (coordinator's rule): a level-3 watch refuses every protocol-1 ack and reply on a root
// not proven dark, with no id resolution; on a proven-dark root protocol 1 works as before.
// Driven through the watch's real relay run (relayConfinedOutboxes, the real handlers behind it).
describe('round 3: protocol-1 ack and reply through the real relay run', () => {
  async function relayed(active: boolean, command: 'ack' | 'reply' = 'ack', rollback = false, archiveOnly = false): Promise<{ result: { code: number; err: string }; dirs: { legacy: string; stamped: string }; id: string; cleanup: () => void }> {
    const made = nativeFixtureWorld(['typed']);
    updateState(made.dir, (state) => {
      state.sessions.acme = { seats: { helper: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} };
    });
    const loaded = loadTeamFile(made.root, { home: made.home });
    if (!loaded.ok) throw new Error('the fixture team did not load');
    if (active) expect(activate(made.root, { home: made.home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const dirs = seatMailDirs(made.root, 'acme', 'helper');
    mkdirSync(dirs.legacy, { recursive: true, mode: 0o700 });
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e91';
    const payload: RecordPayload = { kind: 'message', id, to: 'helper', to_id: null, root: made.root, session: 'acme', at: new Date().toISOString(), body: SECRET, from: 'lead', from_id: null, rule: 'the owner', thread: id };
    expect(writeRecord(dirs.legacy, signRecord(active ? stampedPayload(payload, made.home) : payload, made.home)).ok).toBe(true);
    if (archiveOnly) {
      // As retention leaves a stopped seat's unread mail: the record in archive/<month>/unread/,
      // and nothing else in the seat's stamped folder but that archive.
      const unread = join(dirs.stamped, 'archive', '2026-11', 'unread');
      mkdirSync(unread, { recursive: true, mode: 0o700 });
      renameSync(join(dirs.stamped, id), join(unread, id));
      if (existsSync(join(dirs.stamped, '.exposures'))) renameSync(join(dirs.stamped, '.exposures'), join(unread, '.exposures'));
      expect(readdirSync(dirs.stamped)).toEqual(['archive']);
    }
    if (rollback) expect(deactivate(made.root, made.home).kind).toBe('dark');
    const folder = outboxFolder(made.dir, 'acme', 'helper', 1)!;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const request = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e92';
    writeFileSync(join(folder, `${request}.request.json`), `${JSON.stringify({ v: 1, id: request, command, argv: command === 'ack' ? [id] : [id, 'an answer'], cwd: made.root, seat: 'helper', session: 'acme', pane: 'w1:p1', at: new Date().toISOString() })}\n`, { mode: 0o600 });
    await relayConfinedOutboxes(made.dir, made.root, made.home, 'acme', loaded.team, [{ name: 'helper', pane: 'w1:p1' }], () => new Date());
    const result = JSON.parse(readFileSync(join(folder, `${request}.result.json`), 'utf8')) as { code: number; err: string };
    return { result, dirs, id, cleanup: made.cleanup };
  }

  test('on an active root a protocol-1 ack is refused with the pointer, and nothing is written', async () => {
    const run = await relayed(true);
    try {
      expect(run.result.code).not.toBe(0);
      expect(run.result.err).toContain(protocol1Refusal('ack'));
      expect(readdirSync(run.dirs.stamped).filter((name) => name.startsWith(`${run.id}.`))).toEqual([]);
      expect(existsSync(run.dirs.legacy) ? readdirSync(run.dirs.legacy).filter((name) => name.startsWith(run.id)) : []).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test('round 4: activate, stamp, roll back to dark: a protocol-1 ack is still refused while the seat\'s stamped folder holds mail', async () => {
    const run = await relayed(true, 'ack', true);
    try {
      expect(run.result.code).not.toBe(0);
      expect(run.result.err).toContain(protocol1Refusal('ack'));
      expect(readdirSync(run.dirs.stamped).filter((name) => name.startsWith(`${run.id}.`))).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test('round 5: an archive-only stamped mailbox after a rollback: a protocol-1 reply is refused and writes nothing', async () => {
    const run = await relayed(true, 'reply', true, true);
    try {
      expect(run.result.code).not.toBe(0);
      expect(run.result.err).toContain(protocol1Refusal('reply'));
      const unread = join(run.dirs.stamped, 'archive', '2026-11', 'unread');
      expect(readdirSync(unread).filter((name) => name.startsWith(`${run.id}.`))).toEqual([]);
      expect(readdirSync(run.dirs.stamped)).toEqual(['archive']);
      expect(readdirSync(run.dirs.legacy).filter((name) => name.startsWith(run.id))).toEqual([]);
    } finally {
      run.cleanup();
    }
  });

  test('on a proven-dark root a protocol-1 ack runs the real handler as before', async () => {
    const run = await relayed(false);
    try {
      expect(run.result.err).not.toContain(protocol1Refusal('ack'));
    } finally {
      run.cleanup();
    }
  });

  test('on an active root a protocol-1 reply is refused with the pointer, and nothing is written', async () => {
    const run = await relayed(true, 'reply');
    try {
      expect(run.result.code).not.toBe(0);
      expect(run.result.err).toContain(protocol1Refusal('reply'));
      expect(readdirSync(run.dirs.stamped).filter((name) => name.startsWith(`${run.id}.`))).toEqual([]);
    } finally {
      run.cleanup();
    }
  });
});

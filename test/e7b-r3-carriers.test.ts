// E7b revision 3, stage C: the four other carriers of a stamped body. Each is placed or framed so
// that level-2 code (the real E7a code, commit d8cd0ae3d, read from history as a fixture) never
// lists, reads, recovers or accepts it. Skipped where the history is not at hand.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { level2Tree } from './e7a-fixture.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { nativePendingDir, seatMailDirs } from '../src/queue/mail-tree.ts';
import { listPendingNative, readPending, restoreTaken, takePending, writePending, type PendingNative } from '../src/send/pending.ts';
import { appendHistory, readHistory } from '../src/send/history.ts';
import { requestDaemon } from '../src/send/daemon.ts';
import { levelThreePeer } from '../src/commands/send.ts';
import { outboxFolder, relayOutboxes, relayThroughOutbox, type OutboxProtocol, type RelaySources } from '../src/send/confined-outbox.ts';
import { stampedLeftOut, withoutStamped } from '../src/commands/drops.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { signRecord, stampedPayload, writeRecord } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const e7a = level2Tree();
const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const ID = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e41';
const SECRET = 'the secret stamped body';

type At = { base: string; root: string; home: string };

function place(active = true): At {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'e7b-r3c-')));
  const root = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  mkdirSync(seatMailDirs(root, SESSION, 'lead').legacy, { recursive: true, mode: 0o700 });
  if (active) expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
  return { base, root, home };
}

/** Every file under `dir` whose bytes hold `text`. */
function holding(dir: string, text: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    let names: string[];
    try { names = readdirSync(at); } catch { return; }
    for (const name of names) {
      const path = join(at, name);
      try {
        if (readFileSync(path, 'utf8').includes(text)) out.push(path);
      } catch {
        walk(path);
      }
    }
  };
  walk(dir);
  return out;
}

function pendingOf(at: At): PendingNative {
  return {
    v: 1, id: ID, nonce: 'nv-00000000', ts: new Date().toISOString(), from: 'worker', from_id: null, to: 'lead', to_id: null,
    team: 'acme', session: SESSION, cli: 'claude-code', pane: 'w1:p1', address: 'uds:/nowhere', rule: 'the owner',
    project: 'acme', root: at.root, fallback: [], body: SECRET,
  } as unknown as PendingNative;
}

describe('carrier 1: a stamped native handoff waits under the stamped tree', () => {
  test('written under send-stamped/.native-pending, listed, taken and restored by this build', () => {
    const at = place();
    const written = writePending('acme', at.root, at.home, pendingOf(at), true);
    expect(written.ok).toBe(true);
    expect(existsSync(join(nativePendingDir(at.root), `${ID}.json`))).toBe(true);
    expect(listPendingNative('acme', at.root, at.home).map((record) => record.id)).toEqual([ID]);
    const read = readPending('acme', at.root, at.home, ID);
    expect(read.ok && read.record?.body).toBe(SECRET);
    const taken = takePending('acme', at.root, at.home, ID);
    expect(taken.ok).toBe(true);
    if (taken.ok) restoreTaken(taken.taken, 'acme', at.root, at.home, ID);
    expect(existsSync(join(nativePendingDir(at.root), `${ID}.json`))).toBe(true);
    // The body is nowhere outside the stamped tree.
    expect(holding(at.home, SECRET)).toEqual([]);
  });

  test.skipIf(e7a === null)('E7a lists no stamped handoff and reads none by id', async () => {
    const at = place();
    writePending('acme', at.root, at.home, pendingOf(at), true);
    const pending = await import(`${e7a}/send/pending.ts`);
    expect(pending.listPendingNative('acme', at.root, at.home)).toEqual([]);
    expect(pending.readPending('acme', at.root, at.home, ID)).toEqual({ ok: true, record: null });
  });
});

describe.skipIf(e7a === null)('carrier 2: the daemon request', () => {
  test('an E7a ping names no level, so no stamped send is handed to it; a level-3 ping names its pid', () => {
    expect(levelThreePeer({ v: 1, ok: true, pong: true, pid: 42 })).toBe(null);
    expect(levelThreePeer({ v: 1, ok: true, pong: true, pid: 42, level: 2 })).toBe(null);
    expect(levelThreePeer({ v: 1, ok: true, pong: true, pid: 42, level: 3 })).toBe(42);
    expect(levelThreePeer(null)).toBe(null);
  });

  test('a real E7a daemon given the stamped kind refuses it and stages nothing', async () => {
    const at = place();
    const daemonModule = await import(`${e7a}/send/daemon.ts`);
    const socketPath = join(at.base, 'send.sock');
    const team = { session: SESSION, project: 'acme', orchestrator: 'lead', seats: [{ name: 'lead' }] };
    const started = await daemonModule.startSendDaemon({
      root: at.root, dir: join(at.root, '.agents'), team, host: { ...daemonModule.realDaemonHost, home: at.home },
      socketPath, lockPath: join(at.base, 'send.lock'),
    });
    expect(started.kind).toBe('serving');
    try {
      const ping = await requestDaemon(socketPath, { v: 1, op: 'ping' }, 2_000);
      expect(levelThreePeer(ping)).toBe(null);
      const answer = await requestDaemon(socketPath, { v: 1, op: 'send-stamped', pid: started.handle?.pid ?? 0, id: ID, from: 'worker', to: 'lead', body: SECRET }, 5_000);
      expect(answer).toMatchObject({ ok: false });
      expect(holding(at.home, SECRET)).toEqual([]);
      expect(holding(at.root, SECRET)).toEqual([]);
    } finally {
      await started.handle?.close();
    }
  });
});

describe('carrier 3: history on a root not proven dark carries no body', () => {
  test('the line keeps the id and a digest; E7a reads no body from it', async () => {
    const at = place();
    appendHistory('acme', at.root, at.home, { ts: new Date().toISOString(), from: 'worker', to: 'lead', body: SECRET, id: ID, outcome: 'sent' });
    const read = readHistory('acme', at.root, at.home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.at(-1)).toMatchObject({ id: ID, body: '', stamped: true });
    expect(read.entries.at(-1)?.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(holding(at.home, SECRET)).toEqual([]);
    if (e7a !== null) {
      const history = await import(`${e7a}/send/history.ts`);
      const old = history.readHistory('acme', at.root, at.home);
      expect(old.ok && old.entries.every((entry: { body: string }) => entry.body === '')).toBe(true);
    }
  });

  test('a dark root keeps its exact older line', () => {
    const at = place(false);
    appendHistory('acme', at.root, at.home, { ts: new Date().toISOString(), from: 'worker', to: 'lead', body: 'plain', id: ID, outcome: 'sent' });
    const read = readHistory('acme', at.root, at.home);
    expect(read.ok && read.entries.at(-1)).toEqual({ ts: expect.any(String), from: 'worker', to: 'lead', body: 'plain', id: ID, outcome: 'sent' });
  });
});

describe('carrier 4: the confined relay', () => {
  function relayWorld(): { root: string; dir: string } {
    const at = place();
    const dir = join(at.root, '.agents');
    mkdirSync(join(dir, 'seat-state', SESSION, 'lead'), { recursive: true });
    return { root: at.root, dir };
  }
  function sources(seen: OutboxProtocol[]): RelaySources {
    return {
      recordedPane: () => 'pane-l',
      agents: () => [{ name: 'lead', pane: 'pane-l' }],
      seal: () => true,
      run: async (_command, _argv, _cwd, _caller, _persist, _owner, protocol) => {
        seen.push(protocol);
        return { code: 0, out: `protocol ${String(protocol)}\n`, err: '' };
      },
      now: () => new Date(),
      log: () => {},
    };
  }

  test('this build writes protocol 2 into outbox-v2; the watch serves it as protocol 2', async () => {
    const world = relayWorld();
    const seen: OutboxProtocol[] = [];
    let out = '';
    const code = await relayThroughOutbox({
      command: 'drops', argv: ['--read', '--seat', 'lead'], cwd: world.root, dir: world.dir, seat: 'lead', session: SESSION, pane: 'pane-l',
      stdout: (text) => { out += text; }, stderr: () => {}, waitMs: 5_000,
      sleep: async () => { await relayOutboxes(world.dir, SESSION, ['lead'], sources(seen)); },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([2]);
    expect(out).toBe('protocol 2\n');
    expect(readdirSync(outboxFolder(world.dir, SESSION, 'lead', 2)!).some((name) => name.endsWith('.result.json'))).toBe(true);
    expect(existsSync(outboxFolder(world.dir, SESSION, 'lead', 1)!)).toBe(false);
  });

  test('an older requester\'s protocol-1 request is served as protocol 1; a protocol-2 request in the older folder is refused', async () => {
    const world = relayWorld();
    const folder = outboxFolder(world.dir, SESSION, 'lead', 1)!;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const write = (id: string, v: number) => writeFileSync(join(folder, `${id}.request.json`), `${JSON.stringify({ v, id, command: 'drops', argv: ['--read', '--seat', 'lead'], cwd: world.root, seat: 'lead', session: SESSION, pane: 'pane-l', at: new Date().toISOString() })}\n`, { mode: 0o600 });
    const old = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e51';
    const wrong = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e52';
    write(old, 1);
    write(wrong, 2);
    const seen: OutboxProtocol[] = [];
    await relayOutboxes(world.dir, SESSION, ['lead'], sources(seen));
    expect(seen).toEqual([1]);
    const refused = JSON.parse(readFileSync(join(folder, `${wrong}.result.json`), 'utf8')) as { code: number; err: string };
    expect(refused.code).not.toBe(0);
  });

  test('a protocol-1 read leaves stamped mail out and names how many', () => {
    const at = place();
    const dirs = seatMailDirs(at.root, SESSION, 'lead');
    expect(writeRecord(dirs.legacy, signRecord(stampedPayload({ kind: 'message', id: ID, to: 'lead', to_id: null, root: at.root, session: SESSION, at: new Date().toISOString(), body: SECRET, from: 'worker', from_id: null, rule: 'the owner', thread: ID }, at.home), at.home)).ok).toBe(true);
    const listed = listUnread(dirs.legacy, { to: 'lead', root: at.root, session: SESSION }, at.home);
    expect(listed.map((message) => message.id)).toEqual([ID]);
    expect(withoutStamped(dirs.legacy, listed)).toEqual([]);
    expect(stampedLeftOut(1)).toBe('1 stamped message: run the installed team drops');
  });

  test.skipIf(e7a === null)('an E7a watch never lists or recovers the protocol-2 folder: an interrupted level-3 relay publishes nothing', async () => {
    const world = relayWorld();
    const v2 = outboxFolder(world.dir, SESSION, 'lead', 2)!;
    mkdirSync(v2, { recursive: true, mode: 0o700 });
    const id = '7e0b8d82-7a8e-4da2-9e6f-9b5aac2d3e53';
    writeFileSync(join(v2, `${id}.taking`), `${JSON.stringify({ v: 2, id })}\n`, { mode: 0o600 });
    writeFileSync(join(v2, `${id}.partial.000001`), `${JSON.stringify({ v: 1, ids: [ID], sha256: '0'.repeat(64), length: SECRET.length })}\n${SECRET}`, { mode: 0o600 });
    const before = readdirSync(v2).sort();
    const outbox = await import(`${e7a}/send/confined-outbox.ts`);
    expect(outbox.outboxFolder(world.dir, SESSION, 'lead')).toBe(outboxFolder(world.dir, SESSION, 'lead', 1));
    const seen: unknown[] = [];
    await outbox.relayOutboxes(world.dir, SESSION, ['lead'], { ...sources([]), run: async (...args: unknown[]) => { seen.push(args); return { code: 0, out: '', err: '' }; } });
    expect(seen).toEqual([]);
    expect(readdirSync(v2).sort()).toEqual(before);
    expect(existsSync(outboxFolder(world.dir, SESSION, 'lead', 1)!)).toBe(false);
  });
});

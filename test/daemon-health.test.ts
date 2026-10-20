import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonHealth } from '../src/daemon/health.ts';
import { daemonSocketPath, daemonStatePath, machineConfigDir } from '../src/daemon/paths.ts';
import {
  answerDaemonRequest,
  DAEMON_PROTOCOL_VERSION,
  formatDaemonResponse,
  parseDaemonRequest,
  type DaemonHealthSnapshot,
} from '../src/daemon/protocol.ts';
import { writeDaemonState, type DaemonRootSeatPresenceHealth, type DaemonState } from '../src/daemon/state.ts';

const NOW = (): Date => new Date('2026-10-20T12:00:00.000Z');

const snapshot: DaemonHealthSnapshot = {
  pid: process.pid,
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  since: '2026-10-20T10:00:00.000Z',
  startedBy: 'service-manager',
  version: '0.5.3-daemon-test',
  heartbeatAt: '2026-10-20T11:59:30.000Z',
  stuck: [{ id: 'req-7', op: 'send', since: '2026-10-20T11:58:00.000Z', ageMs: 90_000 }],
  features: { broker: 'absent' },
};

const homes: string[] = [];
const servers: Server[] = [];

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'team-daemon-'));
  homes.push(home);
  return home;
}

function stateOf(home: string): DaemonState {
  return {
    format: 1,
    pid: snapshot.pid,
    uid: snapshot.uid,
    since: snapshot.since,
    startedBy: snapshot.startedBy,
    version: snapshot.version,
    heartbeatAt: snapshot.heartbeatAt,
    socket: daemonSocketPath(home),
    features: snapshot.features,
    stuck: snapshot.stuck,
    roots: [],
  };
}

function serve(
  home: string,
  answer: boolean,
  healthSnapshot: DaemonHealthSnapshot = snapshot,
): Promise<Server> {
  const socketPath = daemonSocketPath(home);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    if (!answer) return;
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const parsed = parseDaemonRequest(buffer.slice(0, nl));
      const response = parsed.ok
        ? answerDaemonRequest(parsed.request, healthSnapshot)
        : { v: DAEMON_PROTOCOL_VERSION, id: parsed.id, ok: false as const, error: parsed.error };
      socket.end(formatDaemonResponse(response));
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('one machine daemon: protocol frames fail closed', () => {
  test('health is the one supported op; a mutating op is auth-unsupported and an unknown op is unsupported', () => {
    expect(parseDaemonRequest(JSON.stringify({ v: 1, id: 'a', op: 'health' }))).toMatchObject({ ok: true });
    const send = parseDaemonRequest(JSON.stringify({ v: 1, id: 'b', op: 'send', scope: { root: '/tmp/x', team: 't', seat: 's', session: 'sx', agent: 'agt_1' } }));
    expect(send.ok).toBe(true);
    if (send.ok) {
      const answer = answerDaemonRequest(send.request, snapshot);
      expect(answer).toMatchObject({ id: 'b', ok: false, error: { code: 'daemon.auth-unsupported' } });
    }
    const unknown = parseDaemonRequest(JSON.stringify({ v: 1, id: 'c', op: 'telepathy' }));
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(answerDaemonRequest(unknown.request, snapshot)).toMatchObject({ ok: false, error: { code: 'daemon.unsupported-op' } });
    }
  });

  test('a bad frame names its error and never reaches a handler', () => {
    expect(parseDaemonRequest('not json')).toMatchObject({ ok: false, error: { code: 'daemon.bad-frame' } });
    expect(parseDaemonRequest(JSON.stringify({ v: 2, id: 'a', op: 'health' }))).toMatchObject({ ok: true });
    expect(parseDaemonRequest(JSON.stringify({ v: 3, id: 'a', op: 'health' }))).toMatchObject({ ok: false, error: { code: 'daemon.bad-frame' } });
    expect(parseDaemonRequest(JSON.stringify({ v: 1, id: '', op: 'health' }))).toMatchObject({ ok: false, error: { code: 'daemon.bad-frame' } });
    expect(parseDaemonRequest(JSON.stringify({ v: 1, id: 'a', op: '' }))).toMatchObject({ ok: false, error: { code: 'daemon.bad-frame' } });
    expect(parseDaemonRequest(JSON.stringify({ v: 1, id: 'a', op: 'health', scope: { root: 7 } }))).toMatchObject({
      ok: false,
      error: { code: 'daemon.bad-frame' },
    });
  });
});

describe('one machine daemon: health reading', () => {
  test('no state and no socket is not running', async () => {
    const home = scratchHome();
    const health = await daemonHealth(home, { now: NOW });
    expect(health.state).toBe('not-running');
    expect(health.running).toBe(false);
    expect(health.pid).toBeNull();
    expect(health.probe).toMatchObject({ state: 'unanswered', reason: 'closed', at: NOW().toISOString() });
  });

  test('a live daemon answers the probe and its state record is 0600 in a 0700 folder', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateOf(home));
    expect(statSync(daemonStatePath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(machineConfigDir(home)).mode & 0o777).toBe(0o700);
    await serve(home, true);
    const health = await daemonHealth(home, { now: NOW });
    expect(health.state).toBe('running');
    expect(health.running).toBe(true);
    expect(health.pid).toBe(process.pid);
    expect(health.startedBy).toBe('service-manager');
    expect(health.heartbeatAt).toBe(snapshot.heartbeatAt);
    expect(health.features).toEqual({ broker: 'absent' });
    expect(health.stuck).toEqual(snapshot.stuck);
    expect(health.probe).toEqual({ state: 'answered', at: NOW().toISOString() });
  });

  test('a stale pid in the state record is not running', async () => {
    const home = scratchHome();
    writeDaemonState(home, { ...stateOf(home), pid: 2_000_000 });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.state).toBe('not-running');
    expect(health.running).toBe(false);
  });

  test('an unreadable state record is unknown, never not running', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateOf(home));
    writeFileSync(daemonStatePath(home), '{"format":1,"pid":', { mode: 0o600 });
    chmodSync(daemonStatePath(home), 0o600);
    const health = await daemonHealth(home, { now: NOW });
    expect(health.state).toBe('unknown');
    expect(health.running).toBeNull();
    expect(health.why).not.toBeNull();
  });

  test('a socket without a state record is unknown', async () => {
    const home = scratchHome();
    await serve(home, true);
    const health = await daemonHealth(home, { now: NOW });
    expect(health.state).toBe('unknown');
    expect(health.running).toBeNull();
  });

  test('a live pid whose daemon never answers is running with an unanswered probe', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateOf(home));
    await serve(home, false);
    const health = await daemonHealth(home, { now: NOW, timeoutMs: 120 });
    expect(health.state).toBe('running');
    expect(health.running).toBe(true);
    expect(health.pid).toBe(process.pid);
    expect(health.probe).toMatchObject({ state: 'unanswered', reason: 'timeout' });
  });
});

// The fresh presence record rides the existing health answer, keyed by the canonical root the
// daemon accepted. The reader merges it only onto that exact root and only from the same daemon
// epoch; everything else stays unknown, so a projection is held rather than trusted.
describe('the reading carries fresh presence by canonical root', () => {
  const ROOT = '/tmp/acme-web';
  const CHECKED = '2026-10-20T12:00:00.000Z';
  const serving = {
    session: 'crew',
    state: 'serving' as const,
    healthy: true,
    checkedAt: CHECKED,
    why: null,
  };

  function stateWithRoots(home: string, roots: string[]): DaemonState {
    return {
      ...stateOf(home),
      roots: roots.map((root) => ({ root, team: 'acme-web', send: 'serving' as const, bus: 'serving' as const, why: null })),
    };
  }

  test('a same-epoch serving answer merges onto the root it names', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    await serve(home, true, {
      ...snapshot,
      roots: [{ root: ROOT, presence: serving }],
    });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots).toEqual([{
      root: ROOT, team: 'acme-web', send: 'serving', bus: 'serving', why: null,
      presence: serving,
    }]);
  });

  test('a seat answer merges only when it carries the binding it was sampled for', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    const withSeats = {
      ...serving,
      seats: [
        {
          seat: 'worker-1', state: 'serving' as const, healthy: true, source: 'runtime' as const,
          binding: 'prs_0123456789ab', appliedEventId: '2026-10-20T11:59:59.000Z-aaaaaaaa', why: null,
        },
        {
          seat: 'crew-op', state: 'pending' as const, healthy: false, source: 'hook' as const,
          binding: null, appliedEventId: null, why: 'the seat records no presence binding',
        },
      ],
    };
    await serve(home, true, { ...snapshot, roots: [{ root: ROOT, presence: withSeats }] });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots[0]?.presence).toEqual(withSeats);
  });

  test('a pending seat may carry a last-known event id for diagnosis, never as proof', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    const diagnostic = {
      ...serving,
      seats: [{
        seat: 'worker-1', state: 'pending' as const, healthy: false, source: 'runtime' as const,
        binding: 'prs_0123456789ab', appliedEventId: '2026-10-20T11:59:59.000Z-aaaaaaaa',
        why: 'the runtime staged an event the canonical projection has not applied',
      }],
    };
    await serve(home, true, { ...snapshot, roots: [{ root: ROOT, presence: diagnostic }] });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots[0]?.presence).toEqual(diagnostic);
  });

  test('a malformed seat list drops the whole record instead of serving part of it', async () => {
    const home = scratchHome();
    const roots = ['/tmp/a', '/tmp/b', '/tmp/c', '/tmp/d', '/tmp/e', '/tmp/f', '/tmp/g', '/tmp/h'];
    writeDaemonState(home, stateWithRoots(home, roots));
    const BINDING = 'prs_0123456789ab';
    const EVENT = '2026-10-20T11:59:59.000Z-aaaaaaaa';
    const good = {
      seat: 'worker-1', state: 'pending' as const, healthy: false,
      source: 'runtime' as const, binding: null, appliedEventId: null, why: 'not sampled',
    };
    const servingSeat = {
      ...good, state: 'serving' as const, healthy: true, binding: BINDING, appliedEventId: EVENT,
    };
    const { source: _omitted, ...withoutSource } = servingSeat;
    await serve(home, true, {
      ...snapshot,
      roots: [
        // A serving seat without a binding names no incarnation to fence.
        { root: '/tmp/a', presence: { ...serving, seats: [{ ...servingSeat, binding: null }] } },
        // A pending seat must say what it is waiting for.
        { root: '/tmp/b', presence: { ...serving, seats: [{ ...good, why: '' }] } },
        // A binding is either the managed shape or absent.
        { root: '/tmp/c', presence: { ...serving, seats: [{ ...good, binding: 'prs_zzzzzzzzzzzz' }] } },
        // A seat may not be repeated, and an empty list is not the promised shape.
        { root: '/tmp/d', presence: { ...serving, seats: [] } },
        { root: '/tmp/e', presence: { ...serving, seats: [{ ...good }, { ...good }] } },
        // A source that could not be classified can hold, never serve.
        { root: '/tmp/f', presence: { ...serving, seats: [{ ...servingSeat, source: 'unknown' }] } },
        // A serving runtime seat must prove the exact event it reconciled.
        { root: '/tmp/g', presence: { ...serving, seats: [{ ...servingSeat, appliedEventId: null }] } },
        // The source class is stated, never inferred from a missing key.
        { root: '/tmp/h', presence: { ...serving, seats: [withoutSource as unknown as DaemonRootSeatPresenceHealth] } },
      ],
    });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots.map((root) => root.root)).toEqual(roots);
    expect(health.roots.every((root) => root.presence === undefined)).toBe(true);
  });

  test('a pending answer keeps its why and is never healthy', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    const pending = {
      session: 'crew', state: 'pending' as const, healthy: false,
      checkedAt: CHECKED, why: 'the presence channel still has a backlog',
    };
    await serve(home, true, { ...snapshot, roots: [{ root: ROOT, presence: pending }] });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots[0]?.presence).toEqual(pending);
  });

  test('an answer from another daemon epoch is not pasted onto the record', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    await serve(home, true, {
      ...snapshot,
      since: '2026-10-20T09:00:00.000Z',
      roots: [{ root: ROOT, presence: serving }],
    });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots[0]?.presence).toBeUndefined();
  });

  test('a self-contradicting or incomplete record is dropped, never repaired', async () => {
    const home = scratchHome();
    const roots = ['/tmp/a', '/tmp/b', '/tmp/c', '/tmp/d'];
    writeDaemonState(home, stateWithRoots(home, roots));
    await serve(home, true, {
      ...snapshot,
      roots: [
        // Serving must be healthy: one without the other is not known.
        { root: '/tmp/a', presence: { ...serving, healthy: false } },
        // Pending must say what it is waiting for.
        { root: '/tmp/b', presence: { ...serving, state: 'pending', healthy: false, why: '' } },
        // The session names the loaded team; an empty one names nothing.
        { root: '/tmp/c', presence: { ...serving, session: '' } },
        // A fresh route the record does not carry is never invented into it.
        { root: '/tmp/elsewhere', presence: serving },
      ],
    });
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots.map((root) => root.root)).toEqual(roots);
    expect(health.roots.every((root) => root.presence === undefined)).toBe(true);
  });

  test('an answer without fresh roots leaves the recorded roots alone', async () => {
    const home = scratchHome();
    writeDaemonState(home, stateWithRoots(home, [ROOT]));
    await serve(home, true);
    const health = await daemonHealth(home, { now: NOW });
    expect(health.roots).toEqual([{
      root: ROOT, team: 'acme-web', send: 'serving', bus: 'serving', why: null,
    }]);
  });
});

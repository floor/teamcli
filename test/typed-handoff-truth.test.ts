import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realHost, runSend } from '../src/commands/send.ts';
import { serveWakeChild } from '../src/daemon/wake/child.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { startSendDaemon, type SendDaemonHandle, type WakeHandoff } from '../src/send/daemon.ts';
import { beginFallbackWalk } from '../src/send/fallback-walk.ts';
import type { FallbackMarker } from '../src/send/fallback-events.ts';
import { readHistory } from '../src/send/history.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { markWake, releaseWake } from '../src/send/wake-marker.ts';
import { dropDir, fake, NOW, owner, world } from './send-native-fixtures.ts';

const handles: SendDaemonHandle[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// Results and time are synthetic. No terminal-host reader/writer or actual wake walk runs.
const noPane: TypedWakeHost = {
  read: () => { throw new Error('unexpected fixture pane read'); },
  type: () => { throw new Error('unexpected fixture typing'); },
  enter: () => { throw new Error('unexpected fixture Enter'); },
  wait: async () => {},
};

async function handed() {
  const made = world(['typed']);
  cleanups.push(made.cleanup);
  const loaded = readTeamConfig(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('fixture configuration did not load');
  const host = fake(made, {
    agents: () => [{ name: 'native', pane: 'fixture-pane', cli: 'codex' }],
    typedWake: () => noPane,
  });
  const wakes: WakeHandoff[] = [];
  const started = await startSendDaemon({ root: made.root, dir: made.dir, team: loaded.team, host, wake: (wake) => wakes.push(wake) });
  if (started.kind !== 'serving') throw new Error(started.kind);
  handles.push(started.handle);
  const io = owner(made.root);
  expect(await runSend(['native', 'fixture message'], io, host)).toBe(0);
  expect(io.out).toContain('handed to the daemon for a typed wake; outcome pending');
  expect(wakes).toHaveLength(1);
  const request = { version: 1 as const, ...wakes[0]! };
  const staged = join(dropDir(made.dir), request.id);
  const marker = () => JSON.parse(readFileSync(`${staged}.fallback.json`, 'utf8')) as FallbackMarker;
  return { made, team: loaded.team, host, io, request, staged, marker };
}

describe('the real host returns at the handoff', () => {
  // A send to a typed seat is not held for the wake child's walk: the daemon's acceptance is the
  // send's ending, and the outcome lands in the history, the trace and the log (2026-11-17).
  test('handedWaitMs is zero', () => {
    expect(realHost.handedWaitMs).toBe(0);
  });
});

describe('typed handoff outcome truth', () => {
  test('acceptance returns immediately with a pending fallback status and attempt', async () => {
    const scene = await handed();
    expect(scene.marker().status).toBe('pending');
    expect(scene.marker().attempts.at(-1)).toMatchObject({ route: 'daemon', outcome: 'pending', reason: 'handed to the daemon for a typed wake; outcome pending' });
    const history = readHistory('acme', scene.made.root, scene.made.home);
    if (!history.ok) throw new Error(history.reason);
    expect(history.entries).toEqual([]);
  });

  for (const delivered of [true, false]) {
    test(`the child settles the same record to ${delivered ? 'delivered' : 'not delivered with its reason'}`, async () => {
      const scene = await handed();
      const { made, request } = scene;
      const before = scene.marker();
      const signedBytes = readFileSync(scene.staged, 'utf8');
      expect(before.status).toBe('pending');
      const reason = delivered ? 'fixture working screen confirmed' : 'fixture screen stayed working; nothing was typed';
      expect(await serveWakeChild(request, {
        agents: scene.host.agents,
        processes: () => null,
        wakeHost: () => noPane,
        walk: async () => ({ delivered, typed: delivered, tries: delivered ? 1 : 0, reason }),
        now: () => NOW,
      })).toEqual({ outcome: delivered ? 'delivered' : 'failed', reason });
      const after = scene.marker();
      expect(after.status).toBe(delivered ? 'delivered' : 'all-failed');
      expect(after.attempts.at(-1)).toMatchObject({ route: 'typed', outcome: delivered ? 'delivered' : 'unreachable', reason });
      expect(after.messageId).toBe(before.messageId);
      expect(after.recordDigest).toBe(before.recordDigest);
      expect(readFileSync(scene.staged, 'utf8')).toBe(signedBytes);
      const history = readHistory('acme', made.root, made.home);
      if (!history.ok) throw new Error(history.reason);
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ id: request.id, outcome: delivered ? 'delivered (typed wake)' : 'unreachable', note: reason });
      // A sender/deferred handoff landing after a fast child's ending cannot erase it.
      const late = beginFallbackWalk({
        caller: { kind: 'owner' }, team: scene.team, root: made.root, home: made.home, now: () => NOW,
        recipient: before.recipient, messageId: request.id, record: signedBytes,
      }).note({ route: 'daemon', outcome: 'pending', liveRoutesRemain: false, at: NOW, ms: 0, reason: 'late fixture handoff' });
      expect(late.ok).toBe(true);
      expect(scene.marker()).toEqual(after);
    });
  }
});

// A real send waits for the wake child's outcome instead of leaving "pending" (2026-11-13: six
// sends sat pending on seats the daemon never typed into, and nobody was told). The child's
// marker beside the stored copy is the outcome: `sent` when the line landed, given back when a
// guard or the walk refused. The child is simulated here by acting on that marker.
describe('a handed send reports the wake outcome', () => {
  async function sendWith(act: (wake: WakeHandoff) => void) {
    const made = world(['typed']);
    cleanups.push(made.cleanup);
    const loaded = readTeamConfig(made.root, { home: made.home });
    if (!loaded.ok) throw new Error('fixture configuration did not load');
    const host = { ...fake(made, { agents: () => [{ name: 'native', pane: 'fixture-pane', cli: 'codex' }], typedWake: () => noPane }), handedWaitMs: 1_000 };
    const started = await startSendDaemon({ root: made.root, dir: made.dir, team: loaded.team, host, wake: act });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);
    const io = owner(made.root);
    const code = await runSend(['native', 'fixture message'], io, host);
    return { code, io };
  }

  test('a wake the child landed is said delivered', async () => {
    const { code, io } = await sendWith((wake) => markWake(`${wake.dropPath}.wake`, { id: wake.id, at: new Date().toISOString(), state: 'sent', evidence: 'typed-wake' }));
    expect(code).toBe(0);
    expect(io.out).toContain('native: delivered (typed wake');
    expect(io.out).not.toContain('pending');
  });

  test('a wake the child gave back is said not delivered, with the message kept', async () => {
    const { code, io } = await sendWith((wake) => releaseWake(`${wake.dropPath}.wake`));
    expect(code).toBe(1);
    expect(io.err).toContain("native: not delivered: the typed wake did not land; kept in native's inbox");
  });

  test('no outcome inside the window is said, never left pending', async () => {
    const { code, io } = await sendWith(() => {});
    expect(code).toBe(0);
    expect(io.out).toContain("native: no typed-wake outcome after 1 s; kept in native's inbox, the daemon is still trying");
  });
});

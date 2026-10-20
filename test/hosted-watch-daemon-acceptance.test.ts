// The machine daemon actually hosting a watch, end to end on its own scratch machine: the
// actual `startMachineDaemon` binds a scratch HOME's daemon socket, hosts one scratch checkout's
// send and bus endpoints, and builds one hosted watch from an injected runner that stays inside
// `loop.wait` for the whole scene. Nothing here touches the global service, the real home, herdr,
// a pane or a credential store.
//
// What this proves, and why each proof is a separate observable:
//
// 1. Liveness is independent of the pass. The runner is still waiting (`waitedMs` recorded, a
//    completion flag false) while the injected clock moves twice and the persisted heartbeat
//    catches up to each new stamp. That is the fixed heartbeat timer firing and writing its
//    record while a pass is in flight, not a race the pass could win.
// 2. Health requests answer while the pass waits. `daemonHealth` is the consumer contract: it
//    reads the state record and sends a real protocol health request over the real socket, and
//    it must answer `running` with `probe.state: 'answered'` inside a bounded time.
// 3. Per-root watch state is persisted and surfaced. `readDaemonState` and the `roots` that
//    `daemonHealth` returns both carry this route's watch record: the route's own id, team and
//    session, closed effects, required, and a pass that has not cycled.
// 4. Close cancels the host. The pending wait resolves false, the runner finishes, the in-memory
//    root records phase `stopped` with the close reason, and close returns inside a short bound.
// 5. Close leaks no endpoint. The machine socket, state record and lock are gone; a probe reads
//    `not-running`; the hosted send and bus socket files are gone; and a second daemon starts
//    from the same scratch HOME and serves the same checkout again.
//
// The virtual clock is the daemon's own injected `now`; the heartbeat timer is the real fixed
// interval at a small test cadence, so the scene takes milliseconds, never a real watch rhythm.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busSocket } from '../src/bus/server.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type StartMachineDaemonResult } from '../src/daemon/host.ts';
import { daemonLockPath, daemonSocketPath } from '../src/daemon/paths.ts';
import { routeId } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { daemonSocketPath as sendSocketPath } from '../src/send/daemon.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { HostedLoop } from '../src/watch/hosted.ts';
import { validateTeamFile } from '../src/file/validate.ts';

const START = Date.parse('2026-10-20T03:00:00Z');
const HEARTBEAT_MS = 20;
const WATCH_WAIT_MS = 600_000;
const VERSION = '0.5.3-hosted-wiring-acceptance';

const CREW = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

let base = '';
let root = '';
let home = '';

beforeEach(() => {
  const made = realpathSync(mkdtempSync(join(tmpdir(), 'team-hosted-wiring-')));
  base = made;
  root = join(made, 'repo');
  home = join(made, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), CREW);
  writeFileSync(join(root, '.agents', 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = { stage: 'ready', last_active: new Date(START - 10 * 60_000).toISOString() };
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon to record its heartbeat');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeSafely(result: StartMachineDaemonResult | null): Promise<void> {
  return result?.kind === 'serving' ? result.daemon.close() : Promise.resolve();
}

describe('the machine daemon hosts a watch on its own liveness', () => {
  test('health and the fixed heartbeat keep serving while a pass waits, and close leaves no endpoint', async () => {
    expect(validateTeamFile(CREW)).toMatchObject({ ok: true });
    const clock = { at: START };
    let started: StartMachineDaemonResult | null = null;
    const runner = { finished: false, waitedMs: 0, waitResult: null as boolean | null };

    try {
      started = await startMachineDaemon({
        home,
        roots: [root],
        startedBy: 'manual',
        version: VERSION,
        now: () => new Date(clock.at),
        heartbeatMs: HEARTBEAT_MS,
        watchHosting: true,
        // The injected runner never reaches a pass: it registers one wait the scene never
        // advances past. Everything the daemon records about this watch is therefore the host's
        // own liveness, not a cycle.
        hostedWatch: () => ({
          run: async (loop: HostedLoop): Promise<number> => {
            runner.waitedMs = WATCH_WAIT_MS;
            runner.waitResult = await loop.wait(WATCH_WAIT_MS);
            runner.finished = true;
            return 0;
          },
        }),
      });
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;
      const daemon = started.daemon;

      // The endpoint and route really exist before anything waits on them.
      expect(daemon.socketPath).toBe(daemonSocketPath(home));
      expect(daemon.routes).toHaveLength(1);
      const watchRouteId = routeId(daemon.routes[0]!);
      expect(daemon.roots[0]?.watch).toMatchObject({
        routeId: watchRouteId,
        root,
        team: 'acme-web',
        session: 'crew',
        phase: 'starting',
        effects: 'blocked',
        required: true,
        cycles: 0,
        failures: 0,
      });

      // The runner is inside its one wait. No tick has released it, so no cycle can be what the
      // heartbeat and health answers below are measuring.
      expect(runner.waitedMs).toBe(WATCH_WAIT_MS);
      expect(runner.waitResult).toBeNull();
      expect(runner.finished).toBe(false);

      // 1. The fixed heartbeat keeps stamping while the pass waits: two separate clock moves are
      // each observed in the persisted record, so the timer fired repeatedly, not once.
      const first = START + 45_000;
      clock.at = first;
      await waitUntil(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(first).toISOString();
      });
      const second = START + 90_000;
      clock.at = second;
      await waitUntil(() => {
        const read = readDaemonState(home);
        return read.kind === 'ok' && read.state.heartbeatAt === new Date(second).toISOString();
      });
      expect(runner.finished).toBe(false);
      expect(runner.waitResult).toBeNull();

      // 2. A health request over the real socket answers while the same pass is still waiting.
      const probeStarted = Date.now();
      const health = await daemonHealth(home);
      const probeElapsed = Date.now() - probeStarted;
      expect(health.probe.state).toBe('answered');
      expect(health.state).toBe('running');
      expect(health.running).toBe(true);
      expect(probeElapsed).toBeLessThan(1000);
      expect(health.heartbeatAt).toBe(new Date(second).toISOString());

      // 3. The per-root watch state the health read surfaces is the persisted one: this route's
      // id, its team and session, closed effects, and a watch that has never cycled.
      const surfaced = health.roots.find((entry) => entry.root === root)?.watch;
      expect(surfaced).toMatchObject({
        routeId: watchRouteId,
        root,
        team: 'acme-web',
        session: 'crew',
        phase: 'starting',
        effects: 'blocked',
        required: true,
        cycles: 0,
        failures: 0,
        lastCycleAt: null,
        lastCycleOutcome: null,
        why: null,
      });
      const persisted = readDaemonState(home);
      expect(persisted.kind).toBe('ok');
      if (persisted.kind === 'ok') {
        expect(persisted.state.roots.find((entry) => entry.root === root)?.watch).toEqual(surfaced!);
      }
      expect(runner.finished).toBe(false);

      // 4. Close cancels the host: the pending wait resolves false and the runner finishes.
      const closingStarted = Date.now();
      await daemon.close();
      expect(Date.now() - closingStarted).toBeLessThan(2000);
      expect(runner.waitResult).toBe(false);
      expect(runner.finished).toBe(true);
      expect(daemon.roots[0]?.watch).toMatchObject({
        phase: 'stopped',
        why: 'the daemon is closing',
        cycles: 0,
        lastCycleAt: null,
      });
    } finally {
      await closeSafely(started);
    }

    // 5. Nothing is left listening, recording or locked, and the same HOME serves again.
    expect(existsSync(daemonSocketPath(home))).toBe(false);
    expect(existsSync(daemonLockPath(home))).toBe(false);
    expect(existsSync(sendSocketPath('acme-web', root, home))).toBe(false);
    expect(existsSync(busSocket(root))).toBe(false);
    expect(readDaemonState(home).kind).toBe('missing');
    const after = await daemonHealth(home);
    expect(after.state).toBe('not-running');
    expect(after.running).toBe(false);
    expect(after.probe.state).toBe('unanswered');

    const again = await startMachineDaemon({
      home,
      roots: [root],
      startedBy: 'manual',
      version: VERSION,
      heartbeatMs: HEARTBEAT_MS,
    });
    expect(again.kind).toBe('serving');
    if (again.kind !== 'serving') return;
    try {
      // Hosting is opt-in: the second daemon was not started to carry a watch, so its root has
      // no watch record, and both hosted endpoints came back up on the same scratch paths.
      expect(again.daemon.roots[0]).toMatchObject({ root, send: 'serving', bus: 'serving' });
      expect(again.daemon.roots[0]?.watch).toBeUndefined();
      expect(again.daemon.socketPath).toBe(daemonSocketPath(home));
    } finally {
      await again.daemon.close();
    }
    expect(existsSync(daemonSocketPath(home))).toBe(false);
    expect(readDaemonState(home).kind).toBe('missing');
  });
});
